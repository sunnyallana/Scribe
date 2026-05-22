//! /api/projects/:projectId/versions — list / snapshot / get / restore.

use axum::{
    extract::{Path, State},
    middleware::from_fn,
    routing::{get, post},
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{
    ApiError, ApiResult, CreateVersionInput, ErrorCode, ProjectId, ProjectVersion, VersionId,
    VersionPayload,
};
use serde_json::json;
use uuid::Uuid;

use crate::services::VersionService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/:project_id/versions",
            get(list).post(snapshot),
        )
        .route(
            "/api/projects/:project_id/versions/:version_id",
            get(get_payload),
        )
        .route(
            "/api/projects/:project_id/versions/:version_id/restore",
            post(restore),
        )
        .layer(from_fn(require_auth))
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<Vec<ProjectVersion>>> {
    let svc = service(&state)?;
    Ok(Json(svc.list(user.id, ProjectId::new(project_id)).await?))
}

async fn snapshot(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    body: Option<Json<CreateVersionInput>>,
) -> ApiResult<Json<ProjectVersion>> {
    let svc = service(&state)?;
    let input = body.map(|b| b.0).unwrap_or_default();
    Ok(Json(svc.snapshot(user.id, ProjectId::new(project_id), input).await?))
}

async fn get_payload(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path((project_id, version_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<VersionPayload>> {
    let svc = service(&state)?;
    let payload = svc
        .get_payload(user.id, ProjectId::new(project_id), VersionId::new(version_id))
        .await?;
    Ok(Json(payload))
}

async fn restore(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path((project_id, version_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<serde_json::Value>> {
    let svc = service(&state)?;
    svc.restore(user.id, ProjectId::new(project_id), VersionId::new(version_id))
        .await?;
    Ok(Json(json!({ "ok": true })))
}

fn service(state: &AppState) -> ApiResult<VersionService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    let storage = state
        .inner
        .storage
        .clone()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "storage not configured"))?;
    Ok(VersionService::new(pool, storage))
}
