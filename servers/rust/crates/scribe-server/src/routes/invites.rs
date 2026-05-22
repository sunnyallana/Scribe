//! /api/invites/:token — public (details) + auth-required (accept).

use axum::{
    extract::{Path, State},
    middleware::from_fn,
    routing::{get, post},
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{
    AcceptInviteResponse, ApiError, ApiResult, ErrorCode, InviteDetails,
};

use crate::services::InviteService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/invites/:token", get(details))
        .route(
            "/api/invites/:token/accept",
            post(accept).route_layer(from_fn(require_auth)),
        )
}

async fn details(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Json<InviteDetails>> {
    let svc = service(&state)?;
    Ok(Json(svc.details(&token).await?))
}

async fn accept(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(token): Path<String>,
) -> ApiResult<Json<AcceptInviteResponse>> {
    let svc = service(&state)?;
    let email = user.email.as_deref().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Forbidden,
            "Your account is missing an email; can't accept invites.",
        )
    })?;
    let response = svc.accept(&token, user.id.into_inner(), email).await?;
    Ok(Json(response))
}

fn service(state: &AppState) -> ApiResult<InviteService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    Ok(InviteService::new(pool))
}
