//! Axum middleware: read `Authorization: Bearer <token>`, verify, and
//! attach the resulting [`AuthUser`] to request extensions. Handlers
//! then pull it out via the [`Authenticated`] extractor.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{FromRequestParts, Request},
    http::{header::AUTHORIZATION, request::Parts, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Extension, Json,
};
use scribe_shared::{ApiErrorBody, ErrorCode};
use serde_json::json;
use tracing::debug;

use crate::user::AuthUser;
use crate::verifier::TokenVerifier;

/// Middleware that REQUIRES a valid token. Use `route_layer(...)` on the
/// routes that need it; routes without it (like /api/health) remain open.
pub async fn require_auth(
    Extension(verifier): Extension<Arc<TokenVerifier>>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let token = match extract_bearer(&req) {
        Some(t) => t,
        None => return unauthorized("missing bearer token"),
    };
    match verifier.verify(&token).await {
        Ok(user) => {
            req.extensions_mut().insert(user);
            next.run(req).await
        }
        Err(err) => {
            debug!(?err, "token verification failed");
            unauthorized("invalid or expired token")
        }
    }
}

/// Extractor for handlers that need the authenticated user. Returns 401
/// if the middleware didn't attach one (which would indicate a routing
/// bug — middleware must run before handlers that use this).
pub struct Authenticated(pub AuthUser);

#[axum::async_trait]
impl<S> FromRequestParts<S> for Authenticated
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthUser>()
            .cloned()
            .map(Self)
            .ok_or_else(|| unauthorized("not authenticated"))
    }
}

fn extract_bearer<B>(req: &Request<B>) -> Option<String> {
    let header = req.headers().get(AUTHORIZATION)?;
    let value = header.to_str().ok()?;
    let stripped = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer "))?;
    let token = stripped.trim();
    if token.is_empty() { None } else { Some(token.to_string()) }
}

fn unauthorized(message: &str) -> Response {
    let body = json!(ApiErrorBody { code: ErrorCode::Unauthorized, message: message.to_string() });
    (StatusCode::UNAUTHORIZED, Json(body)).into_response()
}
