//! /api/ai routes — config CRUD, ping, complete (SSE).
//!
//! Mirrors `server/src/routes/ai.ts`. All routes require auth. The
//! `/complete` endpoint streams server-sent events; the others are
//! plain JSON.

use axum::extract::{Json as JsonExtract, State};
use axum::middleware::from_fn;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::StreamExt;
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{
    AICompleteInput, AIConfigPublic, AIPingResult, ApiError, ApiResult, ErrorCode,
    UpdateAIConfigInput,
};
use serde::Serialize;
use std::convert::Infallible;

use crate::services::ai::AIService;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/ai/config", get(get_config).put(update_config))
        .route("/api/ai/ping", post(ping))
        .route("/api/ai/complete", post(complete))
        .layer(from_fn(require_auth))
}

#[derive(Serialize)]
struct GetConfigBody {
    config: Option<AIConfigPublic>,
}

async fn get_config(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
) -> ApiResult<Json<GetConfigBody>> {
    let svc = service(&state)?;
    Ok(Json(GetConfigBody { config: svc.get_config(user.id).await? }))
}

async fn update_config(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    JsonExtract(input): JsonExtract<UpdateAIConfigInput>,
) -> ApiResult<Json<AIConfigPublic>> {
    let svc = service(&state)?;
    Ok(Json(svc.update_config(user.id, input).await?))
}

async fn ping(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
) -> ApiResult<Json<AIPingResult>> {
    let svc = service(&state)?;
    Ok(Json(svc.ping(user.id).await?))
}

/// SSE completion stream. Each AI token chunk is emitted as a single
/// SSE message; on EOS or error we emit a `done` event and close.
async fn complete(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    JsonExtract(input): JsonExtract<AICompleteInput>,
) -> axum::response::Response {
    let svc = match service(&state) {
        Ok(s) => s,
        Err(err) => return err.into_response(),
    };
    let stream = match svc.complete_stream(user.id, input).await {
        Ok(s) => s,
        Err(err) => return err.into_response(),
    };

    // Map each adapter chunk → SSE Event. Errors become a final
    // `event: error` frame so the client can surface them in-line.
    let sse_stream = stream.map(|result| -> Result<Event, Infallible> {
        match result {
            Ok(chunk) => Ok(Event::default().data(chunk.text)),
            Err(err) => Ok(Event::default().event("error").data(err.to_string())),
        }
    });

    Sse::new(sse_stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

fn service(state: &AppState) -> ApiResult<AIService> {
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    let crypto = state
        .inner
        .ai_crypto
        .clone()
        .ok_or_else(|| ApiError::new(
            ErrorCode::ServiceUnavailable,
            "AI features disabled: AI_KEY_ENCRYPTION_KEY not configured on server",
        ))?;
    Ok(AIService::new(pool, crypto))
}
