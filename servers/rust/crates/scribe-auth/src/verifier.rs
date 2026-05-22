//! Token verifier. Picks HS256 (static secret) vs ES256/RS256 (JWKS)
//! based on the JWT header `alg`, exactly like the Node verifier in
//! `server/src/plugins/verifyToken.ts`.

use std::sync::Arc;

use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use thiserror::Error;
use tracing::debug;

use crate::jwks::{JwksCache, JwksError};
use crate::user::{AuthRole, AuthUser, Claims};
use scribe_shared::UserId;

#[derive(Debug, Error)]
pub enum VerifyError {
    #[error("missing 'kid' in JWT header (required for asymmetric alg)")]
    MissingKid,
    #[error("unsupported JWT algorithm: {0:?}")]
    UnsupportedAlg(Algorithm),
    #[error("jwks: {0}")]
    Jwks(#[from] JwksError),
    #[error("decode: {0}")]
    Decode(#[from] jsonwebtoken::errors::Error),
    #[error("claims missing sub")]
    MissingSub,
}

/// The verifier holds whichever secrets/JWKS endpoints are configured.
/// It's cheap to clone (Arc internally) and safe to share across tasks.
#[derive(Clone)]
pub struct TokenVerifier {
    inner: Arc<Inner>,
}

struct Inner {
    hs_secret: Option<DecodingKey>,
    jwks: Option<JwksCache>,
}

impl TokenVerifier {
    /// Build a verifier from raw config. Pass `None` for any source you
    /// don't have — if a token arrives signed by the missing source, the
    /// verify will fail with a clear error.
    pub fn new(hs_secret: Option<&str>, jwks_url: Option<&str>) -> Self {
        let hs_secret = hs_secret.map(|s| DecodingKey::from_secret(s.as_bytes()));
        let jwks = jwks_url.map(JwksCache::new);
        Self { inner: Arc::new(Inner { hs_secret, jwks }) }
    }

    pub async fn verify(&self, token: &str) -> Result<AuthUser, VerifyError> {
        let header = decode_header(token)?;
        let alg = header.alg;
        debug!(?alg, "verifying token");

        let claims = match alg {
            Algorithm::HS256 => self.verify_hs256(token)?,
            Algorithm::ES256 | Algorithm::RS256 | Algorithm::RS384 | Algorithm::RS512 => {
                let kid = header.kid.ok_or(VerifyError::MissingKid)?;
                self.verify_with_jwks(token, &kid, alg).await?
            }
            other => return Err(VerifyError::UnsupportedAlg(other)),
        };

        let sub = claims.sub.ok_or(VerifyError::MissingSub)?;
        let role = claims.role.as_deref().map(AuthRole::from_claim).unwrap_or(AuthRole::Other);
        Ok(AuthUser {
            id: UserId::new(sub),
            email: claims.email.clone(),
            role,
            token: token.to_string(),
        })
    }

    fn verify_hs256(&self, token: &str) -> Result<Claims, VerifyError> {
        let key = self
            .inner
            .hs_secret
            .as_ref()
            .ok_or_else(|| VerifyError::Decode(jsonwebtoken::errors::ErrorKind::InvalidToken.into()))?;
        let mut validation = Validation::new(Algorithm::HS256);
        validation.validate_aud = false;
        let data = decode::<Claims>(token, key, &validation)?;
        Ok(data.claims)
    }

    async fn verify_with_jwks(
        &self,
        token: &str,
        kid: &str,
        alg: Algorithm,
    ) -> Result<Claims, VerifyError> {
        let jwks = self
            .inner
            .jwks
            .as_ref()
            .ok_or_else(|| VerifyError::Decode(jsonwebtoken::errors::ErrorKind::InvalidToken.into()))?;
        let key = jwks.get(kid).await?;
        let mut validation = Validation::new(alg);
        validation.validate_aud = false;
        let data = decode::<Claims>(token, &key, &validation)?;
        Ok(data.claims)
    }
}
