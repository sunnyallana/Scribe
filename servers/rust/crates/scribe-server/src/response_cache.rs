//! Redis-backed response cache for hot GET endpoints.
//!
//! Two-layer scheme:
//!   1. **Server-side**: serialized JSON response body + a strong ETag
//!      stored in Redis keyed by `(endpoint, user, [params])`. On a hit
//!      we serve from Redis (~1 ms local) instead of round-tripping
//!      Supabase (~200 ms remote).
//!   2. **Client-side**: the response carries an `ETag` header. The
//!      client may echo it back as `If-None-Match`; we then return
//!      `304 Not Modified` with no body. Saves bandwidth + parsing.
//!
//! Writes invalidate by deleting the cached key. Stale-for-TTL is OK
//! for endpoints that are rarely written (projects list, files list)
//! and not OK for endpoints that change every keystroke (Yjs sync,
//! compile status) — those bypass the cache entirely.

use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::Bytes;
use dashmap::DashMap;
use moka::future::Cache as MokaCache;
use redis::{AsyncCommands, Client};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tracing::{debug, info_span, warn, Instrument};

/// Default TTL on cached entries. Short enough that stale data isn't a
/// pain (60s for a project list = barely noticeable) and long enough
/// that hot callers hit the cache.
const DEFAULT_TTL: Duration = Duration::from_secs(60);

/// Redis key prefix so cache entries are easy to inspect/flush.
const KEY_PREFIX: &str = "scribe:cache:v1";

/// Cached body + ETag pair. `Bytes` is cheap-clone (Arc internally) so
/// the L1 and L2 layers can share the same buffer with zero copying.
#[derive(Clone)]
struct CachedEntry {
    body: Bytes,
    etag: String,
}

#[derive(Clone)]
pub struct ResponseCache {
    inner: Option<Arc<Client>>,
    /// L1: in-process LRU. Hits skip the Redis round-trip entirely
    /// (~1ms → ~10µs). TinyLFU eviction + per-entry TTL.
    l1: MokaCache<String, CachedEntry>,
    /// Single-flight coordination: keyed by cache key, holds a
    /// broadcast sender so any concurrent miss on the same key can
    /// wait for the in-flight computation instead of stampeding the
    /// origin. Empty when no flights are running.
    in_flight: Arc<DashMap<String, broadcast::Sender<Option<(Vec<u8>, String)>>>>,
}

impl ResponseCache {
    /// Wire up the cache to an existing Redis. `None` disables L2
    /// caching but keeps L1 enabled (calls fall through to compute on
    /// L1 miss).
    pub fn new(client: Option<Arc<Client>>) -> Self {
        Self {
            inner: client,
            l1: build_l1(),
            in_flight: Arc::new(DashMap::new()),
        }
    }

    pub fn disabled() -> Self {
        Self {
            inner: None,
            l1: build_l1(),
            in_flight: Arc::new(DashMap::new()),
        }
    }

    /// Run `compute()` with an HTTP-level cache. Behaviour by layer:
    ///
    /// * `If-None-Match` matches the stored ETag → `304 Not Modified`, no body.
    /// * Stored entry exists → 200 with cached body + ETag header.
    /// * Otherwise → run `compute()`, store result, return 200 + ETag.
    ///
    /// `key` is the cache key (caller composes it from endpoint + user).
    /// Cache errors are logged and treated as misses — never block the
    /// real response.
    pub async fn cached_json<T, F, Fut>(
        &self,
        key: &str,
        request_headers: &HeaderMap,
        ttl: Option<Duration>,
        compute: F,
    ) -> Response
    where
        T: Serialize,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, Response>>,
    {
        // A single span per request wrapping the whole cache lookup.
        // The `outcome` field is set as we go so flame graphs / Honeycomb
        // queries can group spans by L1-hit / L2-hit / miss / follower.
        // Empty initial value reserved so Rust's tracing fields stay
        // typed; we set it via `Span::current().record(...)` below.
        let span = info_span!(
            "response_cache.cached_json",
            cache.key = %key,
            cache.outcome = tracing::field::Empty,
        );
        async {
            let full_key = format!("{KEY_PREFIX}:{key}");

            // ---- L1: in-process LRU hit. Skips Redis entirely.
            if let Some(entry) = self.l1.get(&full_key).await {
                tracing::Span::current().record("cache.outcome", "l1_hit");
                debug!(%full_key, "L1 hit");
                return cached_response(&entry.body, &entry.etag, request_headers);
            }

            // ---- L2: Redis hit.
            if let Some(client) = self.inner.as_ref() {
                match self.read_cached(client, &full_key).await {
                    Ok(Some((body, etag))) => {
                        let entry = CachedEntry { body: Bytes::from(body), etag };
                        self.l1.insert(full_key.clone(), entry.clone()).await;
                        tracing::Span::current().record("cache.outcome", "l2_hit");
                        debug!(%full_key, "L2 hit");
                        return cached_response(&entry.body, &entry.etag, request_headers);
                    }
                    Ok(None) => debug!(%full_key, "L1/L2 miss"),
                    Err(err) => warn!(?err, "cache read failed; falling through"),
                }
            }
            // Outcome is finalized below (leader / follower / fallback).
            self.cached_json_miss(&full_key, request_headers, ttl, compute).await
        }
        .instrument(span)
        .await
    }

    /// The miss path. Extracted so the hit fast-paths in `cached_json`
    /// stay small + obviously branchless, and so the long-lived span
    /// covers only the slow region.
    async fn cached_json_miss<T, F, Fut>(
        &self,
        full_key: &str,
        request_headers: &HeaderMap,
        ttl: Option<Duration>,
        compute: F,
    ) -> Response
    where
        T: Serialize,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, Response>>,
    {
        let full_key = full_key.to_string();

        // ---- Single-flight: on a miss, the FIRST caller wins the
        //      compute slot; everyone else waits for the broadcast.
        //      Prevents thundering-herd against the DB when a hot key
        //      expires under concurrent load.
        type FlightPayload = Option<(Vec<u8>, String)>;
        let (leader, mut rx) = match self.in_flight.entry(full_key.clone()) {
            dashmap::mapref::entry::Entry::Vacant(slot) => {
                let (tx, _) = broadcast::channel::<FlightPayload>(1);
                slot.insert(tx.clone());
                (true, tx.subscribe())
            }
            dashmap::mapref::entry::Entry::Occupied(slot) => {
                let tx = slot.get().clone();
                (false, tx.subscribe())
            }
        };

        if !leader {
            // Follower: wait for the leader's result. If the leader
            // crashes (broadcast closed without sending) we fall back
            // to running compute ourselves to avoid a hang.
            match rx.recv().await {
                Ok(Some((body, etag))) => {
                    tracing::Span::current().record("cache.outcome", "follower_hit");
                    return cached_response(&body, &etag, request_headers);
                }
                Ok(None) | Err(_) => {
                    tracing::Span::current().record("cache.outcome", "follower_fallback");
                    debug!(%full_key, "single-flight follower fell back to compute");
                }
            }
        } else {
            tracing::Span::current().record("cache.outcome", "leader_miss");
        }

        // ---- Leader (or fallback): compute, serialize, store, broadcast.
        let result = compute().await;

        // No matter what happens below, we must remove the in-flight
        // entry + signal any followers so they don't hang. RAII guard.
        struct DrainGuard<'a> {
            cache: &'a ResponseCache,
            key: &'a str,
            payload: Option<(Vec<u8>, String)>,
        }
        impl Drop for DrainGuard<'_> {
            fn drop(&mut self) {
                if let Some((_, tx)) = self.cache.in_flight.remove(self.key) {
                    let _ = tx.send(self.payload.take());
                }
            }
        }
        let mut guard = DrainGuard { cache: self, key: &full_key, payload: None };

        let value = match result {
            Ok(v) => v,
            Err(resp) => return resp,
        };
        let body = match serde_json::to_vec(&value) {
            Ok(b) => b,
            Err(err) => {
                warn!(?err, "json serialize failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, "serialize").into_response();
            }
        };
        let etag = strong_etag(&body);

        // Populate L1 unconditionally (cheap; helps even when L2 fails).
        let body_bytes = Bytes::from(body.clone());
        self.l1
            .insert(
                full_key.clone(),
                CachedEntry { body: body_bytes.clone(), etag: etag.clone() },
            )
            .await;

        if let Some(client) = self.inner.as_ref() {
            let ttl = ttl.unwrap_or(DEFAULT_TTL);
            if let Err(err) = self.write_cached(client, &full_key, &body, &etag, ttl).await {
                warn!(?err, %full_key, "cache write failed (non-fatal)");
            }
        }

        // Hand the payload to the guard so followers (if any) get it.
        guard.payload = Some((body.clone(), etag.clone()));
        cached_response(&body, &etag, request_headers)
    }

    /// Forcibly drop a cached key (both L1 and L2). Called from write
    /// handlers (POST/PATCH/DELETE) so the next read sees fresh data.
    #[tracing::instrument(name = "response_cache.invalidate", skip(self))]
    pub async fn invalidate(&self, key: &str) {
        let full = format!("{KEY_PREFIX}:{key}");
        self.l1.invalidate(&full).await;
        let Some(client) = self.inner.as_ref() else { return };
        if let Ok(mut conn) = client.get_multiplexed_async_connection().await {
            let result: redis::RedisResult<()> = conn.del(&full).await;
            match result {
                Ok(_) => debug!(%full, "cache invalidated"),
                Err(err) => warn!(?err, %full, "cache invalidate failed"),
            }
        }
    }

    /// Drop every cache entry whose key matches `prefix` (Redis pattern).
    /// Use sparingly — `KEYS` is O(N) in Redis. We bound it to a single
    /// `SCAN` iteration with `MATCH` so it's cheap on our cache size.
    pub async fn invalidate_prefix(&self, prefix: &str) {
        let Some(client) = self.inner.as_ref() else { return };
        let pattern = format!("{KEY_PREFIX}:{prefix}*");
        let Ok(mut conn) = client.get_multiplexed_async_connection().await else { return };
        let scan_result: redis::RedisResult<(i64, Vec<String>)> = redis::cmd("SCAN")
            .arg(0)
            .arg("MATCH")
            .arg(&pattern)
            .arg("COUNT")
            .arg(100)
            .query_async(&mut conn)
            .await;
        match scan_result {
            Ok((_, keys)) if !keys.is_empty() => {
                let result: redis::RedisResult<()> = conn.del(keys).await;
                if let Err(err) = result {
                    warn!(?err, %pattern, "cache prefix invalidate failed");
                }
            }
            _ => {}
        }
    }

    async fn read_cached(
        &self,
        client: &Client,
        key: &str,
    ) -> Result<Option<(Vec<u8>, String)>, redis::RedisError> {
        // HGETALL returns the empty map when the key is absent, which
        // we treat as a miss without surfacing an error. (HMGET via
        // tuple destructuring would error on nil-typed fields here.)
        let mut conn = client.get_multiplexed_async_connection().await?;
        let map: std::collections::HashMap<String, redis::Value> = conn.hgetall(key).await?;
        if map.is_empty() {
            return Ok(None);
        }
        let body = match map.get("body") {
            Some(redis::Value::BulkString(b)) if !b.is_empty() => b.clone(),
            _ => return Ok(None),
        };
        let etag = match map.get("etag") {
            Some(redis::Value::BulkString(b)) => match std::str::from_utf8(b) {
                Ok(s) if !s.is_empty() => s.to_string(),
                _ => return Ok(None),
            },
            _ => return Ok(None),
        };
        Ok(Some((body, etag)))
    }

    async fn write_cached(
        &self,
        client: &Client,
        key: &str,
        body: &[u8],
        etag: &str,
        ttl: Duration,
    ) -> Result<(), redis::RedisError> {
        let mut conn = client.get_multiplexed_async_connection().await?;
        // Single round-trip: HSET both fields, then EXPIRE. The pipeline
        // is atomic from Redis's POV so a reader never sees half-written.
        let mut pipe = redis::pipe();
        pipe.atomic()
            .hset(key, "body", body)
            .ignore()
            .hset(key, "etag", etag)
            .ignore()
            .expire(key, ttl.as_secs() as i64)
            .ignore();
        let _: () = pipe.query_async(&mut conn).await?;
        Ok(())
    }
}

/// Build the L1 in-process cache. Numbers are sized for a per-process
/// working set of ~5K hot keys × ~10KB each ≈ 50MB ceiling. Real
/// deployments rarely hit that; the moka eviction policy keeps the
/// hottest entries.
fn build_l1() -> MokaCache<String, CachedEntry> {
    MokaCache::builder()
        .max_capacity(5_000)
        .time_to_live(Duration::from_secs(60))
        // Refresh idle TTL on access so hot entries stay hot.
        .time_to_idle(Duration::from_secs(30))
        .build()
}

/// Assemble an HTTP response from a cached `(body, etag)` pair. If the
/// client sent a matching `If-None-Match` we respond `304 Not Modified`.
fn cached_response(body: &[u8], etag: &str, request_headers: &HeaderMap) -> Response {
    if client_etag_matches(request_headers, etag) {
        return (StatusCode::NOT_MODIFIED, etag_headers(etag)).into_response();
    }
    (StatusCode::OK, etag_headers(etag), body.to_vec()).into_response()
}

/// `"\"<hex>\""` — a strong ETag (no `W/` prefix). 16 hex chars of
/// SHA-256 is more than enough to make collisions essentially impossible
/// at this cache size.
fn strong_etag(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("\"{hex}\"")
}

fn etag_headers(etag: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(etag) {
        h.insert(axum::http::header::ETAG, v);
    }
    // Hint to clients/proxies that this response is per-user. Without
    // this, a shared cache could leak between users.
    h.insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=60"),
    );
    h.insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h
}

fn client_etag_matches(request_headers: &HeaderMap, server_etag: &str) -> bool {
    let Some(values) = request_headers.get(axum::http::header::IF_NONE_MATCH) else {
        return false;
    };
    let Ok(raw) = values.to_str() else { return false };
    // `If-None-Match` can be a comma-separated list of ETags or `*`.
    raw.split(',')
        .map(|s| s.trim())
        .any(|e| e == "*" || e == server_etag)
}

/// Returned-by-axum extractor convenience. Handlers that don't want to
/// touch the cache directly can still construct an HTTP 200 with the
/// right ETag for any serializable value.
pub fn json_with_etag<T: Serialize>(value: &T) -> Response {
    match serde_json::to_vec(value) {
        Ok(body) => {
            let etag = strong_etag(&body);
            (StatusCode::OK, etag_headers(&etag), body).into_response()
        }
        Err(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error":"serialize"})))
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_is_deterministic() {
        let a = strong_etag(b"hello");
        let b = strong_etag(b"hello");
        assert_eq!(a, b);
        assert!(a.starts_with('"') && a.ends_with('"'));
    }

    #[test]
    fn etag_differs_for_different_bodies() {
        assert_ne!(strong_etag(b"a"), strong_etag(b"b"));
    }

    #[test]
    fn if_none_match_star_always_matches() {
        let mut h = HeaderMap::new();
        h.insert("if-none-match", HeaderValue::from_static("*"));
        assert!(client_etag_matches(&h, "\"abc123\""));
    }

    #[test]
    fn if_none_match_handles_list() {
        let mut h = HeaderMap::new();
        h.insert("if-none-match", HeaderValue::from_static("\"x\", \"abc123\", \"y\""));
        assert!(client_etag_matches(&h, "\"abc123\""));
    }

    #[test]
    fn no_if_none_match_means_no_match() {
        let h = HeaderMap::new();
        assert!(!client_etag_matches(&h, "\"abc\""));
    }
}
