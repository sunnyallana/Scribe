//! Notification inbox routes. All auth-required.

use axum::{
    extract::{Path, Query, State},
    middleware::from_fn,
    routing::{get, post},
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{ApiError, ApiResult, ErrorCode, Notification, UnreadCountResponse};
use serde::Deserialize;
use uuid::Uuid;

use crate::services::NotificationService;
use crate::state::AppState;

#[derive(Deserialize)]
struct ListQuery {
    /// Only return unread rows. Used by the bell-icon dropdown to
    /// pre-filter; the "View all" page sends `unread=false`.
    #[serde(default)]
    unread: bool,
    #[serde(default = "default_limit")]
    limit: i64,
}

fn default_limit() -> i64 { 50 }

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/notifications", get(list).route_layer(from_fn(require_auth)))
        .route(
            "/api/notifications/unread-count",
            get(unread_count).route_layer(from_fn(require_auth)),
        )
        .route(
            "/api/notifications/read-all",
            post(read_all).route_layer(from_fn(require_auth)),
        )
        .route(
            "/api/notifications/:id/read",
            post(read_one).route_layer(from_fn(require_auth)),
        )
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Notification>>> {
    let svc = service(&state)?;
    Ok(Json(svc.list(user.id, q.unread, q.limit).await?))
}

async fn unread_count(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
) -> ApiResult<Json<UnreadCountResponse>> {
    let svc = service(&state)?;
    Ok(Json(svc.unread_count(user.id).await?))
}

async fn read_one(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<serde_json::Value>> {
    let svc = service(&state)?;
    svc.mark_read(user.id, id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn read_all(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
) -> ApiResult<Json<serde_json::Value>> {
    let svc = service(&state)?;
    svc.mark_all_read(user.id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn service(state: &AppState) -> ApiResult<NotificationService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    Ok(NotificationService::new(pool))
}
