//! JWKS fetch + in-memory cache for ES256/RS256 verification.
//!
//! Supabase's user-session JWTs are signed with rotating asymmetric keys
//! and the project's public keys are published at
//! `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`. We pull them once on
//! first use, cache them for [`JWKS_TTL`], and refresh on cache miss
//! (a kid we haven't seen, e.g. after rotation).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use jsonwebtoken::DecodingKey;
use parking_lot::RwLock;
use serde::Deserialize;
use thiserror::Error;
use tracing::warn;

const JWKS_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Error)]
pub enum JwksError {
    #[error("jwks fetch: {0}")]
    Fetch(#[from] reqwest::Error),
    #[error("jwks parse: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("decoding key: {0}")]
    DecodingKey(#[from] jsonwebtoken::errors::Error),
    #[error("unsupported jwk type: kty={kty:?} alg={alg:?}")]
    UnsupportedKey { kty: Option<String>, alg: Option<String> },
    #[error("no matching kid in jwks: {kid}")]
    UnknownKid { kid: String },
}

#[derive(Debug, Deserialize)]
struct JwksDocument {
    keys: Vec<JwkEntry>,
}

#[derive(Debug, Deserialize)]
struct JwkEntry {
    kid: String,
    #[serde(default)]
    kty: Option<String>,
    #[serde(default)]
    alg: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default)]
    crv: Option<String>,
    #[serde(default)]
    x: Option<String>,
    #[serde(default)]
    y: Option<String>,
}

#[derive(Clone)]
pub struct JwksCache {
    inner: Arc<RwLock<Inner>>,
    jwks_url: String,
    http: reqwest::Client,
}

struct Inner {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Option<Instant>,
}

impl JwksCache {
    pub fn new(jwks_url: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(RwLock::new(Inner { keys: HashMap::new(), fetched_at: None })),
            jwks_url: jwks_url.into(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client builds"),
        }
    }

    /// Look up a decoding key by `kid`. Refreshes from the JWKS endpoint
    /// when the cache is empty, expired, or doesn't contain the kid.
    pub async fn get(&self, kid: &str) -> Result<DecodingKey, JwksError> {
        if let Some(key) = self.read_cached(kid) {
            return Ok(key);
        }
        self.refresh().await?;
        self.read_cached(kid).ok_or_else(|| JwksError::UnknownKid { kid: kid.to_string() })
    }

    fn read_cached(&self, kid: &str) -> Option<DecodingKey> {
        let guard = self.inner.read();
        let stale = guard.fetched_at.is_none_or(|t| t.elapsed() > JWKS_TTL);
        if stale {
            return None;
        }
        guard.keys.get(kid).cloned()
    }

    async fn refresh(&self) -> Result<(), JwksError> {
        let body = self.http.get(&self.jwks_url).send().await?.error_for_status()?.text().await?;
        let doc: JwksDocument = serde_json::from_str(&body)?;
        let mut next = HashMap::with_capacity(doc.keys.len());
        for jwk in doc.keys {
            match jwk_to_decoding_key(&jwk) {
                Ok(key) => {
                    next.insert(jwk.kid, key);
                }
                Err(err) => {
                    warn!("skip jwk: {err}");
                }
            }
        }
        let mut guard = self.inner.write();
        guard.keys = next;
        guard.fetched_at = Some(Instant::now());
        Ok(())
    }
}

fn jwk_to_decoding_key(jwk: &JwkEntry) -> Result<DecodingKey, JwksError> {
    match jwk.kty.as_deref() {
        Some("RSA") => {
            let n = jwk.n.as_deref().ok_or_else(|| JwksError::UnsupportedKey {
                kty: jwk.kty.clone(),
                alg: jwk.alg.clone(),
            })?;
            let e = jwk.e.as_deref().ok_or_else(|| JwksError::UnsupportedKey {
                kty: jwk.kty.clone(),
                alg: jwk.alg.clone(),
            })?;
            Ok(DecodingKey::from_rsa_components(n, e)?)
        }
        Some("EC") => {
            let x = jwk.x.as_deref().ok_or_else(|| JwksError::UnsupportedKey {
                kty: jwk.kty.clone(),
                alg: jwk.alg.clone(),
            })?;
            let y = jwk.y.as_deref().ok_or_else(|| JwksError::UnsupportedKey {
                kty: jwk.kty.clone(),
                alg: jwk.alg.clone(),
            })?;
            Ok(DecodingKey::from_ec_components(x, y)?)
        }
        _ => Err(JwksError::UnsupportedKey { kty: jwk.kty.clone(), alg: jwk.alg.clone() }),
    }
}
