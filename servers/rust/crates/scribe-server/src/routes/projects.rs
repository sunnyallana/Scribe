//! /api/projects — list/create/get/update/delete.

use axum::{
    extract::{Path, State},
    middleware::from_fn,
    routing::get,
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{ApiResult, CreateProjectInput, Project, ProjectId, UpdateProjectInput};
use uuid::Uuid;

use crate::services::ProjectService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects", get(list).post(create))
        .route(
            "/api/projects/:project_id",
            get(get_one).patch(update).delete(remove),
        )
        .layer(from_fn(require_auth))
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
) -> ApiResult<Json<Vec<Project>>> {
    let service = projects_service(&state)?;
    Ok(Json(service.list_for_user(user.id).await?))
}

async fn create(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Json(input): Json<CreateProjectInput>,
) -> ApiResult<Json<Project>> {
    let service = projects_service(&state)?;
    Ok(Json(service.create(user.id, input).await?))
}

async fn get_one(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<Project>> {
    let service = projects_service(&state)?;
    Ok(Json(service.get_for_user(user.id, ProjectId::new(project_id)).await?))
}

async fn update(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    Json(input): Json<UpdateProjectInput>,
) -> ApiResult<Json<Project>> {
    let service = projects_service(&state)?;
    Ok(Json(service.update(user.id, ProjectId::new(project_id), input).await?))
}

async fn remove(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    let service = projects_service(&state)?;
    service.remove(user.id, ProjectId::new(project_id)).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn projects_service(state: &AppState) -> ApiResult<ProjectService> {
    let pool = state
        .db()
        .ok_or_else(|| scribe_shared::ApiError::new(
            scribe_shared::ErrorCode::ServiceUnavailable,
            "database not configured",
        ))?
        .pool()
        .clone();
    let storage = state
        .inner
        .storage
        .clone()
        .ok_or_else(|| scribe_shared::ApiError::new(
            scribe_shared::ErrorCode::ServiceUnavailable,
            "storage not configured",
        ))?;
    Ok(ProjectService::new(pool, storage))
}
