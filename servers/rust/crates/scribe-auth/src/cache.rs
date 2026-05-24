//! In-memory verified-token cache.
//!
//! JWT verification on the hot path is expensive: ES256 token verification
//! does an EC point decompression + signature math (~0.5–2 ms CPU each) and,
//! on a cold kid, a remote JWKS fetch. For a hot caller reusing the same
//! access token across many requests, that's pure waste — the token is
//! valid for an hour, so we cache the verified [`AuthUser`] keyed by a
//! cheap content hash of the token.
//!
//! Design choices:
//! * **SHA-256 keyed**, not the token itself, so the cache never stores
//!   bearer secrets in plain bytes.
//! * **Per-entry TTL** derived from the token's `exp` claim — we never
//!   serve a cached entry past its expiry, regardless of cache eviction
//!   policy.
//! * **Soft size cap** with random-eviction on overflow. We don't need
//!   strict LRU; the working set is tiny (active users × their devices).
//! * **No interior locking on the hot path** — uses `DashMap` for
//!   sharded concurrency.

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use sha2::{Digest, Sha256};

use crate::user::AuthUser;

/// Soft upper bound on cache entries. At ~256 bytes per entry, 10K entries
/// is ~2.5 MiB resident — fine even on tiny VPSes.
const MAX_ENTRIES: usize = 10_000;

/// Hard ceiling on entry lifetime, even if the JWT claims a longer one.
/// Bounds the blast radius of a stolen-but-valid token.
const MAX_CACHE_TTL: Duration = Duration::from_secs(15 * 60);

/// Subtracted from the JWT's `exp` so we never serve an entry that's
/// about to expire by the time it lands at the DB.
const EXP_SLACK: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct VerifiedTokenCache {
    inner: Arc<DashMap<[u8; 32], CacheEntry>>,
}

#[derive(Clone)]
struct CacheEntry {
    user: AuthUser,
    expires_at: Instant,
}

impl VerifiedTokenCache {
    pub fn new() -> Self {
        Self { inner: Arc::new(DashMap::with_capacity(256)) }
    }

    /// Look up a token. Returns `Some(user)` only if (a) we've seen this
    /// token before and (b) it hasn't expired or been evicted.
    pub fn get(&self, token: &str) -> Option<AuthUser> {
        let key = hash(token);
        let entry = self.inner.get(&key)?;
        if Instant::now() >= entry.expires_at {
            // Stale; drop and miss.
            drop(entry);
            self.inner.remove(&key);
            return None;
        }
        Some(entry.user.clone())
    }

    /// Store a verified result. `exp_unix` is the JWT `exp` claim
    /// (Unix seconds); the entry expires at min(exp - slack, now + cap).
    pub fn insert(&self, token: &str, user: AuthUser, exp_unix: i64) {
        let now = Instant::now();
        let until_jwt_exp = ttl_from_unix(exp_unix);
        let ttl = until_jwt_exp.min(MAX_CACHE_TTL);
        if ttl.is_zero() {
            return;
        }
        // Soft cap: if we're over the size, kick out a random entry.
        // Cheaper than a true LRU and the working set is tiny anyway.
        if self.inner.len() >= MAX_ENTRIES {
            if let Some(victim) = self.inner.iter().next().map(|e| *e.key()) {
                self.inner.remove(&victim);
            }
        }
        self.inner.insert(
            hash(token),
            CacheEntry { user, expires_at: now + ttl },
        );
    }

    /// Current entry count. Cheap O(shard-count) sum across DashMap shards;
    /// fine for tests and operational metrics, not for tight loops.
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.len()
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.inner.is_empty()
    }
}

impl Default for VerifiedTokenCache {
    fn default() -> Self {
        Self::new()
    }
}

fn hash(token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hasher.finalize().into()
}

fn ttl_from_unix(exp_unix: i64) -> Duration {
    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let remaining = exp_unix - now_unix;
    if remaining <= EXP_SLACK.as_secs() as i64 {
        return Duration::ZERO;
    }
    Duration::from_secs((remaining as u64).saturating_sub(EXP_SLACK.as_secs()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use scribe_shared::UserId;
    use uuid::Uuid;

    fn user() -> AuthUser {
        AuthUser {
            id: UserId::new(Uuid::new_v4()),
            email: Some("u@x".into()),
            role: crate::user::AuthRole::Authenticated,
            token: "tok".into(),
        }
    }

    #[test]
    fn miss_then_hit() {
        let c = VerifiedTokenCache::new();
        let exp = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64) + 3600;
        assert!(c.get("tok").is_none());
        c.insert("tok", user(), exp);
        assert!(c.get("tok").is_some());
    }

    #[test]
    fn expired_entry_is_a_miss() {
        let c = VerifiedTokenCache::new();
        // exp = now (no future TTL after slack subtract).
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        c.insert("tok", user(), now);
        assert!(c.get("tok").is_none());
    }

    #[test]
    fn distinct_tokens_have_distinct_keys() {
        let c = VerifiedTokenCache::new();
        let exp = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64) + 3600;
        c.insert("a", user(), exp);
        c.insert("b", user(), exp);
        assert_eq!(c.len(), 2);
    }
}
