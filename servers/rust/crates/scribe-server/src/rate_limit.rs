//! Token-bucket rate limiting.
//!
//! Two buckets layered on top of each other:
//!
//! 1. **Per-IP** (the outer net). Stops one machine from saturating
//!    the server before authentication ever runs. Sized to be generous
//!    for normal interactive use (a single browser tab opening the
//!    dashboard easily fires 5–10 requests/sec).
//! 2. **Per-authenticated-user** (the inner net). Caps individual
//!    authenticated callers separately so a compromised credential
//!    can't burn the per-IP allowance and lock out other users behind
//!    the same NAT.
//!
//! Both use the same struct-of-mutex token-bucket pattern — small,
//! lock-free reads via DashMap, tight critical sections under a
//! `parking_lot::Mutex`. No third-party rate-limit crate; the algorithm
//! is two dozen lines and avoids version-skew with axum's body type.
//!
//! Health probes and `/metrics` are deliberately exempt — orchestrators
//! poll them aggressively and rate-limited probes look like outages.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use axum::{
    extract::{ConnectInfo, Request},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use dashmap::DashMap;
use scribe_auth::AuthUser;

/// One token-bucket entry. Refill + try-acquire all happen under the
/// inner mutex; held just long enough to bump the counters.
struct Bucket {
    state: parking_lot::Mutex<TokenState>,
}

struct TokenState {
    tokens: f64,
    last_refill: Instant,
}

impl Bucket {
    fn new(initial: f64) -> Self {
        Self {
            state: parking_lot::Mutex::new(TokenState {
                tokens: initial,
                last_refill: Instant::now(),
            }),
        }
    }

    /// Try to take one token. Returns true if a token was available
    /// (refilling at `refill_per_sec`, capped at `capacity`).
    fn try_acquire(&self, capacity: f64, refill_per_sec: f64) -> bool {
        let mut state = self.state.lock();
        let now = Instant::now();
        let elapsed = now.duration_since(state.last_refill).as_secs_f64();
        state.tokens = (state.tokens + elapsed * refill_per_sec).min(capacity);
        state.last_refill = now;
        if state.tokens >= 1.0 {
            state.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Per-IP rate limit. Generous so normal browser bursts (dashboard
/// open, multiple parallel fetches on first paint) don't trip it.
///
/// 100-token burst, 50 req/s sustained refill.
pub async fn per_ip(req: Request<axum::body::Body>, next: Next) -> Response {
    static BUCKETS: std::sync::OnceLock<DashMap<IpAddr, Arc<Bucket>>> = std::sync::OnceLock::new();
    const CAPACITY: f64 = 100.0;
    const REFILL_PER_SEC: f64 = 50.0;

    let Some(ip) = extract_ip(&req) else {
        // Couldn't determine origin (no socket info, weird middleware
        // ordering). Skip the limit rather than block legit traffic.
        return next.run(req).await;
    };
    let buckets = BUCKETS.get_or_init(DashMap::new);
    let bucket = buckets
        .entry(ip)
        .or_insert_with(|| Arc::new(Bucket::new(CAPACITY)))
        .clone();

    if !bucket.try_acquire(CAPACITY, REFILL_PER_SEC) {
        metrics::counter!("rate_limit_rejected_total", "scope" => "ip").increment(1);
        return rate_limited("too many requests from this IP");
    }
    next.run(req).await
}

/// Per-authenticated-user rate limit. Runs AFTER auth so we have an
/// `AuthUser` extension to key on. Counts authenticated users separately
/// so two users behind the same corporate NAT can't lock each other
/// out via the per-IP bucket.
///
/// Tighter than the IP bucket: 30-token burst, 10 req/s sustained. A
/// normal interactive session uses ~1–3 req/s; this is 3–10× headroom.
pub async fn per_user(req: Request<axum::body::Body>, next: Next) -> Response {
    static BUCKETS: std::sync::OnceLock<DashMap<uuid::Uuid, Arc<Bucket>>> =
        std::sync::OnceLock::new();
    const CAPACITY: f64 = 30.0;
    const REFILL_PER_SEC: f64 = 10.0;

    let user_id = req.extensions().get::<AuthUser>().map(|u| u.id.into_inner());
    let Some(user_id) = user_id else {
        // Unauthenticated — the IP layer covered this, pass through.
        return next.run(req).await;
    };

    let buckets = BUCKETS.get_or_init(DashMap::new);
    let bucket = buckets
        .entry(user_id)
        .or_insert_with(|| Arc::new(Bucket::new(CAPACITY)))
        .clone();

    if !bucket.try_acquire(CAPACITY, REFILL_PER_SEC) {
        metrics::counter!("rate_limit_rejected_total", "scope" => "user").increment(1);
        return rate_limited("per-user rate limit");
    }
    next.run(req).await
}

/// Pull a client IP off the request. Prefers X-Forwarded-For so we get
/// the real client even when running behind nginx/Cloudflare; falls
/// back to the socket address (axum's ConnectInfo) only when no proxy
/// header is present. Trusts the proxy header — production deployments
/// behind an untrusted edge must validate or strip this header upstream.
fn extract_ip(req: &Request<axum::body::Body>) -> Option<IpAddr> {
    if let Some(value) = req.headers().get("x-forwarded-for") {
        if let Ok(raw) = value.to_str() {
            // X-Forwarded-For: client, proxy1, proxy2 — take the first.
            if let Some(first) = raw.split(',').next() {
                if let Ok(ip) = first.trim().parse::<IpAddr>() {
                    return Some(ip);
                }
            }
        }
    }
    if let Some(value) = req.headers().get("x-real-ip") {
        if let Ok(s) = value.to_str() {
            if let Ok(ip) = s.parse::<IpAddr>() {
                return Some(ip);
            }
        }
    }
    // Fall back to the TCP peer address from axum's ConnectInfo
    // extension. Direct-connection clients (no proxy in front) take
    // this path; proxied clients hit the X-Forwarded-For path above.
    req.extensions().get::<ConnectInfo<SocketAddr>>().map(|ci| ci.0.ip())
}

fn rate_limited(reason: &str) -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [("retry-after", "1")],
        axum::Json(serde_json::json!({
            "code": "rate_limited",
            "message": reason,
        })),
    )
        .into_response()
}
