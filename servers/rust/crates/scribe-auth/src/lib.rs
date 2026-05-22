//! JWT verification + Axum auth middleware.
//!
//! Mirrors `server/src/plugins/verifyToken.ts`. Supabase issues two
//! kinds of tokens:
//!
//! * **HS256** — anon and service-role keys, both signed with the static
//!   `SUPABASE_JWT_SECRET`.
//! * **ES256 / RS256** — user-session tokens, signed with rotating
//!   asymmetric keys whose public halves are published at
//!   `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`.
//!
//! [`TokenVerifier`] picks the verifier strategy by inspecting the JWT
//! header. JWKS keys are cached in-memory for one hour and refreshed on
//! a cache miss (rotation).

mod jwks;
mod middleware;
mod user;
mod verifier;

pub use jwks::{JwksCache, JwksError};
pub use middleware::{require_auth, Authenticated};
pub use user::{AuthRole, AuthUser, Claims};
pub use verifier::{TokenVerifier, VerifyError};
