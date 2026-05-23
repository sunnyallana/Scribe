//! /api/projects/:projectId/comments — list/create/update/delete.

use axum::{
    extract::{Path, State},
    middleware::from_fn,
    routing::get,
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{
    ApiError, ApiResult, Comment, CommentId, CreateCommentInput, ErrorCode, ProjectId,
    UpdateCommentInput,
};
use serde_json::json;
use uuid::Uuid;

use crate::services::CommentService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/:project_id/comments",
            get(list).post(create),
        )
        .route(
            "/api/projects/:project_id/comments/:comment_id",
            axum::routing::patch(update).delete(remove),
        )
        .layer(from_fn(require_auth))
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<Vec<Comment>>> {
    let svc = service(&state)?;
    Ok(Json(svc.list(user.id, ProjectId::new(project_id)).await?))
}

async fn create(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateCommentInput>,
) -> ApiResult<Json<Comment>> {
    let svc = service(&state)?;
    Ok(Json(svc.create(user.id, ProjectId::new(project_id), input).await?))
}

async fn update(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path((project_id, comment_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateCommentInput>,
) -> ApiResult<Json<Comment>> {
    let svc = service(&state)?;
    let updated = svc
        .update(user.id, ProjectId::new(project_id), CommentId::new(comment_id), input)
        .await?;
    Ok(Json(updated))
}

async fn remove(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path((project_id, comment_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<serde_json::Value>> {
    let svc = service(&state)?;
    svc.remove(user.id, ProjectId::new(project_id), CommentId::new(comment_id))
        .await?;
    Ok(Json(json!({ "ok": true })))
}

fn service(state: &AppState) -> ApiResult<CommentService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    Ok(CommentService::new(pool))
}
