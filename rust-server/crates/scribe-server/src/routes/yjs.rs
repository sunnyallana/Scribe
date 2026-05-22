//! WebSocket route for Yjs sync.
//!
//! Mirrors `server/src/routes/yjs.ts`:
//!   * URL: `GET /api/yjs/:project_id/:file_id/socket?token=<jwt>`
//!   * Token-on-querystring auth (the browser WebSocket API can't set
//!     arbitrary headers; the existing web client passes it this way).
//!   * Enforces project membership before upgrading.
//!
//! The actual sync protocol lives in `scribe-yjs::socket::serve_socket`.

use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use scribe_auth::TokenVerifier;
use scribe_shared::{ApiError, ErrorCode, ProjectId};
use scribe_yjs::DocRegistry;
use serde::Deserialize;
use tracing::warn;
use uuid::Uuid;

use crate::services::membership::assert_member;
use crate::state::AppState;

#[derive(Deserialize)]
struct SocketQuery {
    token: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/yjs/:project_id/:file_id/socket", get(upgrade))
}

async fn upgrade(
    State(state): State<AppState>,
    axum::extract::Extension(verifier): axum::extract::Extension<Arc<TokenVerifier>>,
    registry: Option<axum::extract::Extension<Arc<DocRegistry>>>,
    Path((project_id, file_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<SocketQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // When DATABASE_URL isn't set we don't install the yjs registry as
    // a layer (no persistence available). Surface a clean 503 instead
    // of a generic 500.
    let Some(axum::extract::Extension(registry)) = registry else {
        return api_error(ApiError::new(
            ErrorCode::ServiceUnavailable,
            "yjs sync requires a configured database",
        ));
    };
    // We auth + membership-check *before* upgrade so unauthorized
    // clients see a normal 401/403 instead of a closed-socket dance.
    let token = match query.token {
        Some(t) if !t.is_empty() => t,
        _ => return api_error(ApiError::unauthorized("missing token query parameter")),
    };
    let user = match verifier.verify(&token).await {
        Ok(u) => u,
        Err(err) => {
            warn!(?err, "yjs token verify failed");
            return api_error(ApiError::unauthorized("invalid or expired token"));
        }
    };
    let Some(db) = state.db() else {
        return api_error(ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"));
    };
    if let Err(err) = assert_member(db.pool(), user.id, ProjectId::new(project_id)).await {
        return api_error(err);
    }

    let doc_id = format!("{}/{}", project_id, file_id);
    ws.on_upgrade(move |socket| async move {
        scribe_yjs::serve_socket(socket, doc_id, registry).await
    })
}

fn api_error(err: ApiError) -> Response {
    err.into_response()
}
