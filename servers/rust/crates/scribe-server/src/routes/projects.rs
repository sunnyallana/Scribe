//! /api/projects — list/create/get/update/delete.
//!
//! `GET /api/projects` is the hottest read on the dashboard, so it
//! goes through the [`ResponseCache`]: hits Redis (~1 ms local) instead
//! of Supabase (~200 ms remote). Writes invalidate by cache key.

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    middleware::from_fn,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated, AuthUser};
use scribe_shared::{
    ApiError, ApiResult, CreateProjectInput, ErrorCode, Project, ProjectId, UpdateProjectInput,
    UserId,
};
use serde::Deserialize;
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
        .route("/api/projects/:project_id/duplicate", post(duplicate))
        .layer(from_fn(require_auth))
}

/// Cache-key prefix for a user's projects list. Invalidated when the
/// user creates/updates/deletes any project they own.
fn list_cache_key(user: UserId) -> String {
    format!("projects:list:{user}")
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    headers: HeaderMap,
) -> Response {
    let cache = state.response_cache().clone();
    let key = list_cache_key(user.id);
    let service = match projects_service(&state) {
        Ok(s) => s,
        Err(err) => return err.into_response(),
    };
    cache
        .cached_json::<Vec<Project>, _, _>(&key, &headers, None, move || async move {
            service
                .list_for_user(user.id)
                .await
                .map_err(IntoResponse::into_response)
        })
        .await
}

async fn create(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Json(input): Json<CreateProjectInput>,
) -> ApiResult<Json<Project>> {
    let service = projects_service(&state)?;
    let project = service.create(user.id, input).await?;
    state.response_cache().invalidate(&list_cache_key(user.id)).await;
    Ok(Json(project))
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
    let updated = service.update(user.id, ProjectId::new(project_id), input).await?;
    state.response_cache().invalidate(&list_cache_key(user.id)).await;
    Ok(Json(updated))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DuplicateInput {
    name: Option<String>,
}

async fn duplicate(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    body: Option<Json<DuplicateInput>>,
) -> ApiResult<Json<Project>> {
    let service = projects_service(&state)?;
    let name = body.and_then(|Json(b)| b.name);
    let copied = service.duplicate(user.id, ProjectId::new(project_id), name).await?;
    state.response_cache().invalidate(&list_cache_key(user.id)).await;
    Ok(Json(copied))
}

async fn remove(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    let service = projects_service(&state)?;
    service.remove(user.id, ProjectId::new(project_id)).await?;
    state.response_cache().invalidate(&list_cache_key(user.id)).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn projects_service(state: &AppState) -> ApiResult<ProjectService> {
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
    Ok(ProjectService::new(pool, storage))
}

// The `AuthUser` import is used by the route signature transitively
// through `Authenticated`. Keeping it explicit makes the boundary clear.
#[allow(dead_code)]
fn _ensure_auth_user_in_scope(_: AuthUser) {}
