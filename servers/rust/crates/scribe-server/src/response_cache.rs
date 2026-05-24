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
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use dashmap::DashMap;
use moka::future::Cache as MokaCache;
use redis::{AsyncCommands, Client};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;
use tokio::time::timeout;
use tracing::{debug, info_span, warn, Instrument};

/// Default TTL on cached entries. Short enough that stale data isn't a
/// pain (60s for a project list = barely noticeable) and long enough
/// that hot callers hit the cache.
const DEFAULT_TTL: Duration = Duration::from_secs(60);

/// Redis key prefix so cache entries are easy to inspect/flush.
const KEY_PREFIX: &str = "scribe:cache:v1";

/// Max time we'll wait to acquire a Redis connection on any single call.
/// Tight enough that a Redis outage doesn't stall the API: an unreachable
/// Redis fails in ~250 ms instead of the default ~30 s OS connect-timeout.
const REDIS_OP_TIMEOUT: Duration = Duration::from_millis(250);

/// After we observe a Redis failure, skip Redis entirely for this long.
/// Stops the API from paying the per-request timeout cost every time
/// while Redis is down. We reset on any successful op.
const REDIS_BACKOFF_AFTER_FAIL: Duration = Duration::from_secs(5);

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
    #[allow(clippy::type_complexity)] // the broadcast payload is intentionally Option<(body, etag)>
    in_flight: Arc<DashMap<String, broadcast::Sender<Option<(Vec<u8>, String)>>>>,
    /// Circuit-breaker state: monotonic-millis timestamp of when Redis
    /// became reachable again. While `now() < this`, Redis ops are
    /// short-circuited to fall through directly to the origin.
    /// 0 means "no current backoff". `AtomicI64` keeps it cheap to
    /// read/write across hot paths without a Mutex.
    redis_skip_until_ms: Arc<AtomicI64>,
    /// Master kill-switch. `false` means `cached_json` short-circuits
    /// straight to `compute()` (no L1/L2 read, no L1/L2 write) and
    /// `invalidate*` are no-ops. Driven by
    /// `AppConfig.features.cache_enabled`; the SPA-visible behavior
    /// change is that every read sees fresh data and writes don't
    /// even need to invalidate.
    enabled: bool,
    /// When false, `cached_response` emits `Cache-Control: no-store`
    /// instead of `private, no-cache, must-revalidate`. The latter
    /// still lets browsers store + revalidate-via-ETag; `no-store`
    /// forbids any persistence at all. Off by default in dev so a
    /// debugging session never gets fooled by the browser's HTTP cache.
    client_cache_headers: bool,
}

impl ResponseCache {
    /// Wire up the cache to an existing Redis. `None` disables L2
    /// caching but keeps L1 enabled (calls fall through to compute on
    /// L1 miss).
    /// Full constructor used by main.rs to honour the feature flags.
    /// `enabled=false` short-circuits all cache logic; `client_cache_headers=false`
    /// flips the outgoing Cache-Control to `no-store`.
    pub fn with_flags(
        client: Option<Arc<Client>>,
        enabled: bool,
        client_cache_headers: bool,
    ) -> Self {
        Self {
            inner: if enabled { client } else { None },
            l1: build_l1(),
            in_flight: Arc::new(DashMap::new()),
            redis_skip_until_ms: Arc::new(AtomicI64::new(0)),
            enabled,
            client_cache_headers,
        }
    }

    /// True if the circuit breaker says Redis is currently unreachable.
    /// Cheap atomic load — no syscall, no allocation.
    fn redis_in_backoff(&self) -> bool {
        let until = self.redis_skip_until_ms.load(Ordering::Relaxed);
        until > 0 && now_ms() < until
    }

    /// Mark Redis unreachable. Called after any failed Redis op so the
    /// next ~5s of requests skip it instead of paying the timeout.
    fn note_redis_failure(&self) {
        self.redis_skip_until_ms.store(
            now_ms().saturating_add(REDIS_BACKOFF_AFTER_FAIL.as_millis() as i64),
            Ordering::Relaxed,
        );
    }

    /// Clear the circuit-breaker after a successful op.
    fn note_redis_success(&self) {
        if self.redis_skip_until_ms.load(Ordering::Relaxed) != 0 {
            self.redis_skip_until_ms.store(0, Ordering::Relaxed);
        }
    }

    /// Acquire a Redis connection with a hard timeout. Surfaces both
    /// "Redis is unreachable / down" and "Redis is just slow" as a
    /// single timeout-error path the callers can match on cheaply.
    async fn connect(&self) -> Option<redis::aio::MultiplexedConnection> {
        let client = self.inner.as_ref()?;
        if self.redis_in_backoff() {
            return None;
        }
        match timeout(REDIS_OP_TIMEOUT, client.get_multiplexed_async_connection()).await {
            Ok(Ok(conn)) => {
                self.note_redis_success();
                Some(conn)
            }
            Ok(Err(err)) => {
                debug!(?err, "redis connect failed; entering backoff");
                self.note_redis_failure();
                None
            }
            Err(_) => {
                debug!(timeout_ms = REDIS_OP_TIMEOUT.as_millis() as u64, "redis connect timed out; entering backoff");
                self.note_redis_failure();
                None
            }
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

            // ---- Kill-switch: when disabled, every request goes
            //      straight to the origin. L1/L2 are skipped and the
            //      response carries `Cache-Control: no-store` so the
            //      browser doesn't keep a copy either. Use this in dev
            //      to rule the cache out as the cause of stale reads.
            if !self.enabled {
                tracing::Span::current().record("cache.outcome", "disabled");
                return self.uncached(request_headers, compute).await;
            }

            // ---- L1: in-process LRU hit. Skips Redis entirely.
            if let Some(entry) = self.l1.get(&full_key).await {
                tracing::Span::current().record("cache.outcome", "l1_hit");
                debug!(%full_key, "L1 hit");
                return cached_response(
                    &entry.body,
                    &entry.etag,
                    request_headers,
                    self.client_cache_headers,
                );
            }

            // ---- L2: Redis hit. `connect()` short-circuits when Redis
            //      is in backoff so a dead Redis costs us ~0 ms here
            //      instead of the per-call connect timeout.
            if self.inner.is_some() {
                match self.read_cached(&full_key).await {
                    Ok(Some((body, etag))) => {
                        let entry = CachedEntry { body: Bytes::from(body), etag };
                        self.l1.insert(full_key.clone(), entry.clone()).await;
                        tracing::Span::current().record("cache.outcome", "l2_hit");
                        debug!(%full_key, "L2 hit");
                        return cached_response(
                            &entry.body,
                            &entry.etag,
                            request_headers,
                            self.client_cache_headers,
                        );
                    }
                    Ok(None) => debug!(%full_key, "L1/L2 miss"),
                    Err(err) => debug!(?err, "cache read failed; falling through"),
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
                    return cached_response(
                        &body,
                        &etag,
                        request_headers,
                        self.client_cache_headers,
                    );
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

        if self.inner.is_some() {
            let ttl = ttl.unwrap_or(DEFAULT_TTL);
            if let Err(err) = self.write_cached(&full_key, &body, &etag, ttl).await {
                debug!(?err, %full_key, "cache write failed (non-fatal)");
            }
        }

        // Hand the payload to the guard so followers (if any) get it.
        guard.payload = Some((body.clone(), etag.clone()));
        cached_response(&body, &etag, request_headers, self.client_cache_headers)
    }

    /// Disabled-cache fast path: runs `compute()`, serializes the result
    /// as JSON, and returns it with `Cache-Control: no-store`. Skipping
    /// L1/L2 + single-flight makes the code dead-simple; the only cost
    /// versus a normal cached miss is the lack of stampede protection
    /// (which doesn't matter for a single-tenant dev box).
    async fn uncached<T, F, Fut>(
        &self,
        request_headers: &HeaderMap,
        compute: F,
    ) -> Response
    where
        T: Serialize,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, Response>>,
    {
        let value = match compute().await {
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
        // `client_cache_headers=false` flips the outgoing Cache-Control
        // to `no-store`; that path is what users want while debugging.
        let etag = strong_etag(&body);
        cached_response(&body, &etag, request_headers, self.client_cache_headers)
    }

    /// Forcibly drop a cached key (both L1 and L2). Called from write
    /// handlers (POST/PATCH/DELETE) so the next read sees fresh data.
    #[tracing::instrument(name = "response_cache.invalidate", skip(self))]
    pub async fn invalidate(&self, key: &str) {
        if !self.enabled {
            return; // No cache to invalidate.
        }
        let full = format!("{KEY_PREFIX}:{key}");
        self.l1.invalidate(&full).await;
        let Some(mut conn) = self.connect().await else { return };
        let result: redis::RedisResult<()> = timeout(REDIS_OP_TIMEOUT, conn.del(&full))
            .await
            .unwrap_or_else(|_| Err(redis::RedisError::from((redis::ErrorKind::IoError, "del timed out"))));
        match result {
            Ok(_) => debug!(%full, "cache invalidated"),
            Err(err) => {
                debug!(?err, %full, "cache invalidate failed");
                self.note_redis_failure();
            }
        }
    }

    /// Drop every cache entry whose key matches `prefix` (Redis pattern).
    /// Use sparingly — `KEYS` is O(N) in Redis. We bound it to a single
    /// `SCAN` iteration with `MATCH` so it's cheap on our cache size.
    pub async fn invalidate_prefix(&self, prefix: &str) {
        if !self.enabled {
            return; // No cache to invalidate.
        }
        // ── L1 first ────────────────────────────────────────────────
        // Without this, a write would only wipe the Redis copy and the
        // next GET would hit the still-warm Moka L1, serving the
        // pre-write body. That manifests in the SPA as "I saved but
        // refresh shows the old content."
        //
        // Moka's `invalidate_entries_if` is *queued* — the eviction
        // happens during the next maintenance pass and a read in the
        // meantime still gets the stale value. To guarantee a fresh
        // read on the very next request we walk the live entries,
        // collect the matching keys, and call the per-key `invalidate`
        // (which awaits removal). L1 is small (≤5k entries) so the
        // O(N) scan is cheap; this only runs on writes anyway.
        let pattern_prefix = format!("{KEY_PREFIX}:{prefix}");
        let matching: Vec<String> = self
            .l1
            .iter()
            .filter_map(|(k, _)| if k.starts_with(&pattern_prefix) { Some((*k).clone()) } else { None })
            .collect();
        for k in &matching {
            self.l1.invalidate(k).await;
        }
        debug!(%pattern_prefix, evicted = matching.len(), "L1 prefix invalidated");

        // ── L2 (Redis) ──────────────────────────────────────────────
        let Some(mut conn) = self.connect().await else { return };
        let pattern = format!("{KEY_PREFIX}:{prefix}*");
        let mut scan_cmd = redis::cmd("SCAN");
        scan_cmd.arg(0).arg("MATCH").arg(&pattern).arg("COUNT").arg(100);
        let scan_fut = scan_cmd.query_async(&mut conn);
        let scan_result: redis::RedisResult<(i64, Vec<String>)> =
            match timeout(REDIS_OP_TIMEOUT, scan_fut).await {
                Ok(r) => r,
                Err(_) => {
                    debug!(%pattern, "cache prefix scan timed out");
                    self.note_redis_failure();
                    return;
                }
            };
        match scan_result {
            Ok((_, keys)) if !keys.is_empty() => {
                let del_fut = conn.del(keys);
                let del_result: redis::RedisResult<()> =
                    timeout(REDIS_OP_TIMEOUT, del_fut).await.unwrap_or_else(|_| {
                        Err(redis::RedisError::from((redis::ErrorKind::IoError, "del timed out")))
                    });
                if let Err(err) = del_result {
                    debug!(?err, %pattern, "cache prefix invalidate failed");
                    self.note_redis_failure();
                }
            }
            Ok(_) => {}
            Err(err) => {
                debug!(?err, %pattern, "cache prefix scan failed");
                self.note_redis_failure();
            }
        }
    }

    async fn read_cached(
        &self,
        key: &str,
    ) -> Result<Option<(Vec<u8>, String)>, redis::RedisError> {
        // HGETALL returns the empty map when the key is absent, which
        // we treat as a miss without surfacing an error. (HMGET via
        // tuple destructuring would error on nil-typed fields here.)
        let Some(mut conn) = self.connect().await else {
            return Err(redis::RedisError::from((redis::ErrorKind::IoError, "redis unavailable")));
        };
        let map: std::collections::HashMap<String, redis::Value> =
            timeout(REDIS_OP_TIMEOUT, conn.hgetall(key))
                .await
                .map_err(|_| redis::RedisError::from((redis::ErrorKind::IoError, "hgetall timed out")))??;
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
        key: &str,
        body: &[u8],
        etag: &str,
        ttl: Duration,
    ) -> Result<(), redis::RedisError> {
        let Some(mut conn) = self.connect().await else {
            return Err(redis::RedisError::from((redis::ErrorKind::IoError, "redis unavailable")));
        };
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
        let query_fut = pipe.query_async(&mut conn);
        let res: redis::RedisResult<()> =
            timeout(REDIS_OP_TIMEOUT, query_fut).await.unwrap_or_else(|_| {
                Err(redis::RedisError::from((redis::ErrorKind::IoError, "write timed out")))
            });
        if let Err(err) = res {
            self.note_redis_failure();
            return Err(err);
        }
        Ok(())
    }
}

/// Monotonic millis since Unix epoch. Cheap on all major platforms;
/// avoids the SystemTime non-monotonic gotcha by using the same source
/// `tokio::time::timeout` uses internally.
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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
/// client sent a matching `If-None-Match` AND we're emitting cache
/// headers, we respond `304 Not Modified`. With `client_cache_headers
/// = false` we never 304 — the browser shouldn't be caching anyway.
fn cached_response(
    body: &[u8],
    etag: &str,
    request_headers: &HeaderMap,
    client_cache_headers: bool,
) -> Response {
    if client_cache_headers && client_etag_matches(request_headers, etag) {
        return (StatusCode::NOT_MODIFIED, etag_headers(etag, true)).into_response();
    }
    (StatusCode::OK, etag_headers(etag, client_cache_headers), body.to_vec()).into_response()
}

/// `"\"<hex>\""` — a strong ETag (no `W/` prefix). 16 hex chars of
/// SHA-256 is more than enough to make collisions essentially impossible
/// at this cache size.
fn strong_etag(body: &[u8]) -> String {
    let digest = Sha256::digest(body);
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("\"{hex}\"")
}

fn etag_headers(etag: &str, client_cache_headers: bool) -> HeaderMap {
    let mut h = HeaderMap::new();
    if client_cache_headers {
        if let Ok(v) = HeaderValue::from_str(etag) {
            h.insert(axum::http::header::ETAG, v);
        }
        // `no-cache` does NOT mean "don't cache" — it means "always
        // revalidate with the origin before reusing the cached body". The
        // browser still saves bandwidth on a 304 round-trip when the ETag
        // matches; the server *always* gets the chance to invalidate.
        // `private` keeps the entry per-user so shared caches can't leak
        // between accounts.
        h.insert(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache, must-revalidate"),
        );
    } else {
        // Disabled: `no-store` forbids any persistence. Pair with
        // `Pragma: no-cache` for HTTP/1.0 proxies (still alive in some
        // corporate networks). No ETag = no conditional GET path, so
        // every response is the live body.
        h.insert(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate, max-age=0"),
        );
        h.insert(
            axum::http::header::PRAGMA,
            HeaderValue::from_static("no-cache"),
        );
    }
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
