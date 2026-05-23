//! `POST /api/projects/:project_id/export?format=md|docx` — server-side
//! LaTeX → Markdown / DOCX conversion via pandoc.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    middleware::from_fn,
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_shared::{ApiError, ApiResult, ErrorCode, ProjectId};
use serde::Deserialize;
use uuid::Uuid;

use crate::services::exports::{ExportFormat, ExportService};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/projects/:project_id/export", post(export))
        .layer(from_fn(require_auth))
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    format: String,
}

async fn export(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    Query(query): Query<ExportQuery>,
) -> ApiResult<Response> {
    let format = ExportFormat::from_query(&query.format).ok_or_else(|| {
        ApiError::new(
            ErrorCode::BadRequest,
            format!("Unsupported export format: {}", query.format),
        )
    })?;
    let svc = service(&state)?;
    let result = svc
        .export(user.id, ProjectId::new(project_id), format)
        .await?;

    // Use a Content-Disposition with both the plain `filename=` and
    // RFC-5987 `filename*=` so browsers + curl both pick the
    // intended save-name. The bytes go through axum's Body wrapper
    // so axum sets Content-Length on its own.
    let disposition = format!(
        "attachment; filename=\"{name}\"; filename*=UTF-8''{name}",
        name = result.filename
    );
    let body = Body::from(result.bytes);
    let mut response = (StatusCode::OK, body).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(result.content_type),
    );
    if let Ok(val) = HeaderValue::from_str(&disposition) {
        headers.insert(header::CONTENT_DISPOSITION, val);
    }
    Ok(response)
}

fn service(state: &AppState) -> ApiResult<ExportService> {
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
    let pandoc_bin = std::env::var("PANDOC_BIN").ok();
    Ok(ExportService::new(pool, storage, pandoc_bin))
}
