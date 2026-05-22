//! GET /api/whoami — echoes the authenticated user. Useful for
//! confirming end-to-end auth flow without touching any business data.

use axum::{middleware::from_fn, routing::get, Json, Router};
use scribe_auth::{require_auth, AuthRole, AuthUser, Authenticated};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
struct WhoamiBody {
    id: String,
    email: Option<String>,
    role: AuthRole,
}

pub fn router() -> Router<AppState> {
    // `from_fn(require_auth)` reads the `TokenVerifier` Extension that
    // main.rs attaches at the app root, so we don't have to thread it
    // through here.
    Router::new().route("/api/whoami", get(whoami)).layer(from_fn(require_auth))
}

async fn whoami(Authenticated(user): Authenticated) -> Json<WhoamiBody> {
    let AuthUser { id, email, role, .. } = user;
    Json(WhoamiBody { id: id.to_string(), email, role })
}
