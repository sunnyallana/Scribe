//! HTTP + WebSocket endpoints for compile jobs.
//!
//! HTTP (auth via Authorization header):
//!   * `POST   /api/projects/:projectId/compile`             enqueue a job
//!   * `GET    /api/projects/:projectId/compiles`            list recent
//!   * `GET    /api/compiles/:jobId`                         job details
//!   * `GET    /api/compiles/:jobId/artifact-url?kind=pdf`   signed URL
//!
//! WebSocket (auth via `?token=`):
//!   * `GET    /api/compiles/:jobId/stream`                  live log feed

use std::sync::Arc;

use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::middleware::from_fn;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use scribe_auth::{require_auth, Authenticated, TokenVerifier};
use scribe_compile::CompileQueue;
use scribe_shared::{
    ApiError, ApiResult, CompileJob, CompileJobId, CompileLogStreamMessage, CreateCompileJobInput,
    ErrorCode, ProjectId,
};
use scribe_storage::{compile_artifact_key, Storage, COMPILE_ARTIFACTS_BUCKET};
use serde::{Deserialize, Serialize};
use tracing::warn;
use uuid::Uuid;

use crate::services::compiles::CompileService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    // HTTP routes go through standard auth middleware.
    let http = Router::new()
        .route("/api/projects/:project_id/compile", post(enqueue))
        .route("/api/projects/:project_id/compiles", get(list))
        .route("/api/compiles/:job_id", get(get_one))
        .route("/api/compiles/:job_id/artifact-url", get(artifact_url))
        .layer(from_fn(require_auth));

    // The WS route does its own token-in-querystring auth before upgrade.
    let ws = Router::new().route("/api/compiles/:job_id/stream", get(stream));

    http.merge(ws)
}

// -- HTTP handlers ---------------------------------------------------

async fn enqueue(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    Json(input): Json<CreateCompileJobInput>,
) -> ApiResult<Json<CompileJob>> {
    let svc = service(&state)?;
    Ok(Json(svc.enqueue(user.id, ProjectId::new(project_id), input).await?))
}

async fn list(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
) -> ApiResult<Json<Vec<CompileJob>>> {
    let svc = service(&state)?;
    Ok(Json(svc.list(user.id, ProjectId::new(project_id), 10).await?))
}

async fn get_one(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(job_id): Path<Uuid>,
) -> ApiResult<Json<CompileJob>> {
    let svc = service(&state)?;
    Ok(Json(svc.get(user.id, CompileJobId::new(job_id)).await?))
}

#[derive(Deserialize)]
struct ArtifactQuery {
    /// `pdf` | `log` | `synctex` — defaults to `pdf`.
    kind: Option<String>,
}

#[derive(Serialize)]
struct UrlBody {
    url: String,
}

async fn artifact_url(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(job_id): Path<Uuid>,
    Query(query): Query<ArtifactQuery>,
) -> ApiResult<Json<UrlBody>> {
    let svc = service(&state)?;
    let job = svc.get(user.id, CompileJobId::new(job_id)).await?;
    let kind = query.kind.as_deref().unwrap_or("pdf");
    let key = match kind {
        "pdf" => job
            .pdf_key
            .ok_or_else(|| ApiError::not_found("No pdf artifact for this job"))?,
        "log" => job
            .log_key
            .ok_or_else(|| ApiError::not_found("No log artifact for this job"))?,
        "synctex" => job
            .synctex_key
            .ok_or_else(|| ApiError::not_found("No synctex artifact for this job"))?,
        // .bbl uses a convention-based key — the worker uploads to
        // `{project}/{job}/main.bbl` whenever a bbl exists. The
        // job row doesn't carry a `bbl_key` column (avoiding a
        // schema migration); if the object isn't in storage the
        // sign call returns 404 and the SPA handles it gracefully.
        "bbl" => compile_artifact_key(job.project_id, &job_id.to_string(), "main.bbl"),
        other => return Err(ApiError::validation(format!("unknown kind: {other}"))),
    };
    let storage = state
        .inner
        .storage
        .as_ref()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "storage not configured"))?;
    let url = storage.signed_url(COMPILE_ARTIFACTS_BUCKET, &key, 300).await?;
    Ok(Json(UrlBody { url }))
}

// -- WebSocket handler ------------------------------------------------

#[derive(Deserialize)]
struct StreamQuery {
    token: Option<String>,
}

async fn stream(
    State(state): State<AppState>,
    axum::extract::Extension(verifier): axum::extract::Extension<Arc<TokenVerifier>>,
    queue: Option<axum::extract::Extension<Arc<CompileQueue>>>,
    Path(job_id): Path<Uuid>,
    Query(query): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let token = match query.token {
        Some(t) if !t.is_empty() => t,
        _ => return ApiError::unauthorized("missing token query parameter").into_response(),
    };
    let user = match verifier.verify(&token).await {
        Ok(u) => u,
        Err(err) => {
            warn!(?err, "compile stream token verify failed");
            return ApiError::unauthorized("invalid or expired token").into_response();
        }
    };
    let Some(axum::extract::Extension(queue)) = queue else {
        return ApiError::new(ErrorCode::ServiceUnavailable, "compile queue not configured")
            .into_response();
    };
    let svc = match service(&state) {
        Ok(s) => s,
        Err(err) => return err.into_response(),
    };

    let job_id = CompileJobId::new(job_id);

    // Replay historical state first so the client sees a complete log.
    let replay = match svc.replay_messages(user.id, job_id).await {
        Ok(m) => m,
        Err(err) => return err.into_response(),
    };
    let already_complete = replay.iter().any(|m| matches!(m, CompileLogStreamMessage::Completed { .. }));

    // Compile-stream is server → client only; clients never send frames
    // bigger than a ping. Tiny caps reject any attempt to flood the
    // socket from the client side.
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| async move {
            if let Err(err) = drive_stream(socket, queue, job_id, replay, already_complete).await {
                warn!(?err, %job_id, "compile stream exited");
            }
        })
}

async fn drive_stream(
    socket: WebSocket,
    queue: Arc<CompileQueue>,
    job_id: CompileJobId,
    replay: Vec<CompileLogStreamMessage>,
    already_complete: bool,
) -> anyhow::Result<()> {
    let (mut sink, mut stream) = socket.split();

    // Send everything we know about the job so far.
    for msg in &replay {
        let json = serde_json::to_string(msg)?;
        sink.send(WsMessage::Text(json)).await?;
    }
    if already_complete {
        // Nothing more will arrive — close cleanly.
        let _ = sink.send(WsMessage::Close(None)).await;
        return Ok(());
    }

    // Subscribe to the per-job pub/sub channel for live updates.
    let mut pubsub = queue.subscriber().await?;
    let channel = scribe_compile::log_channel(job_id);
    pubsub.subscribe(&channel).await?;
    let mut on_message = pubsub.on_message();

    loop {
        tokio::select! {
            // Live frames from the worker.
            msg = on_message.next() => {
                let Some(msg) = msg else { break };
                let payload: String = msg.get_payload().unwrap_or_default();
                if sink.send(WsMessage::Text(payload.clone())).await.is_err() {
                    break;
                }
                // If the worker just told us the job is done, close.
                if let Ok(parsed) = serde_json::from_str::<CompileLogStreamMessage>(&payload) {
                    if matches!(parsed, CompileLogStreamMessage::Completed { .. }) {
                        let _ = sink.send(WsMessage::Close(None)).await;
                        break;
                    }
                }
            }
            // Client close.
            inbound = stream.next() => {
                match inbound {
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

fn service(state: &AppState) -> ApiResult<CompileService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    let queue = state
        .inner
        .compile_queue
        .clone()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "compile queue not configured"))?;
    Ok(CompileService::new(pool, queue))
}
