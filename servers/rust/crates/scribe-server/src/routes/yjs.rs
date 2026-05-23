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
use scribe_shared::{ApiError, ErrorCode, MemberRole, ProjectId};
use scribe_yjs::DocRegistry;
use serde::Deserialize;
use tracing::warn;
use uuid::Uuid;

use crate::services::membership::require_role;
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
    // Resolve the caller's role on this project. NotFound bubbles up if
    // they aren't a member (which is what we want — same response shape
    // as `assert_member` previously gave us). Owners + editors get a
    // writable socket; viewers / commenters get read-only.
    let role = match require_role(db.pool(), user.id, ProjectId::new(project_id)).await {
        Ok(r) => r,
        Err(err) => return api_error(err),
    };
    let read_only = matches!(role, MemberRole::Viewer | MemberRole::Commenter);

    let doc_id = format!("{}/{}", project_id, file_id);
    // Cap per-frame size. Yjs sync messages are normally a few KB; even
    // the initial snap of a large doc rarely exceeds a few hundred KB.
    // 4 MiB leaves generous headroom while making it harder for a
    // malicious client to exhaust server memory by sending huge frames.
    ws.max_message_size(4 * 1024 * 1024)
        .max_frame_size(1024 * 1024)
        .on_upgrade(move |socket| async move {
            scribe_yjs::serve_socket_with_mode(socket, doc_id, registry, read_only).await
        })
}

fn api_error(err: ApiError) -> Response {
    err.into_response()
}
