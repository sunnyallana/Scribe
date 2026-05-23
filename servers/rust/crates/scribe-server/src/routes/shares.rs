//! /api/projects/:id/share-links — owner-only CRUD for share tokens.
//! /api/share/:token — anonymous preview + auth-required redeem.

use axum::{
    extract::{Path, State},
    middleware::from_fn,
    routing::{delete, get, post},
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{
    ApiError, ApiResult, CreateShareLinkInput, ErrorCode, ProjectId, RedeemShareResponse,
    ShareLink, ShareLinkId, SharePreview,
};
use uuid::Uuid;

use crate::services::ShareService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        // Owner-managed lifecycle (auth required, gated by service-level
        // ownership check).
        .route(
            "/api/projects/:project_id/share-links",
            get(list).route_layer(from_fn(require_auth)),
        )
        .route(
            "/api/projects/:project_id/share-links",
            post(create).route_layer(from_fn(require_auth)),
        )
        .route(
            "/api/share-links/:link_id",
            delete(revoke).route_layer(from_fn(require_auth)),
        )
        // Public preview — the landing page hits this before sign-in
        // so the user knows what they're joining.
        .route("/api/share/:token", get(preview))
        // Redeem requires a logged-in account (we add them to
        // project_members under that account).
        .route(
            "/api/share/:token/redeem",
            post(redeem).route_layer(from_fn(require_auth)),
        )
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<Vec<ShareLink>>> {
    let svc = service(&state)?;
    let links = svc.list(user.id, ProjectId::new(project_id)).await?;
    Ok(Json(links))
}

async fn create(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateShareLinkInput>,
) -> ApiResult<Json<ShareLink>> {
    let svc = service(&state)?;
    let link = svc.create(user.id, ProjectId::new(project_id), input).await?;
    Ok(Json(link))
}

async fn revoke(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(link_id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    let svc = service(&state)?;
    svc.revoke(user.id, ShareLinkId::new(link_id)).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn preview(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> ApiResult<Json<SharePreview>> {
    let svc = service(&state)?;
    let preview = svc.preview(&token).await?;
    Ok(Json(preview))
}

async fn redeem(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(token): Path<String>,
) -> ApiResult<Json<RedeemShareResponse>> {
    let svc = service(&state)?;
    let resp = svc.redeem(user.id, user.email.as_deref(), &token).await?;
    Ok(Json(resp))
}

fn service(state: &AppState) -> ApiResult<ShareService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    Ok(ShareService::new(pool))
}
