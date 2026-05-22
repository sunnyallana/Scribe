//! /api/projects/:projectId/members — list/invite/update-role/delete.

use axum::{
    extract::{Path, State},
    middleware::from_fn,
    routing::get,
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{
    ApiError, ApiResult, ErrorCode, InviteMemberInput, MemberId, ProjectId, ProjectMember,
    UpdateMemberRoleInput,
};
use serde_json::json;
use uuid::Uuid;

use crate::services::MemberService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/:project_id/members",
            get(list).post(invite),
        )
        .route(
            "/api/projects/:project_id/members/:member_id",
            axum::routing::patch(update_role).delete(remove),
        )
        .layer(from_fn(require_auth))
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<Vec<ProjectMember>>> {
    let svc = service(&state)?;
    Ok(Json(svc.list(user.id, ProjectId::new(project_id)).await?))
}

async fn invite(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    Json(input): Json<InviteMemberInput>,
) -> ApiResult<Json<ProjectMember>> {
    let svc = service(&state)?;
    Ok(Json(svc.invite(user.id, ProjectId::new(project_id), input).await?))
}

async fn update_role(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path((project_id, member_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateMemberRoleInput>,
) -> ApiResult<Json<ProjectMember>> {
    let svc = service(&state)?;
    let updated = svc
        .update_role(user.id, ProjectId::new(project_id), MemberId::new(member_id), input)
        .await?;
    Ok(Json(updated))
}

async fn remove(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path((project_id, member_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<serde_json::Value>> {
    let svc = service(&state)?;
    svc.remove(user.id, ProjectId::new(project_id), MemberId::new(member_id))
        .await?;
    Ok(Json(json!({ "ok": true })))
}

fn service(state: &AppState) -> ApiResult<MemberService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    Ok(MemberService::new(pool))
}
