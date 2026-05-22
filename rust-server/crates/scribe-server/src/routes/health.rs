//! Liveness + readiness probes.
//!
//! * `GET /api/health`    — liveness. Always 200 once the process is up.
//! * `GET /api/health/db` — readiness for DB-dependent routes. 200 if a
//!   `SELECT 1` round-trips successfully, 503 otherwise.

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
    service: &'static str,
    db: ComponentStatus,
    storage: ComponentStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ComponentStatus {
    Configured,
    Unconfigured,
}

#[derive(Serialize)]
struct DbHealthBody {
    ok: bool,
    error: Option<String>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/health/db", get(db_health))
}

async fn health(State(state): State<AppState>) -> Json<HealthBody> {
    Json(HealthBody {
        ok: true,
        service: "scribe-server",
        db: if state.db().is_some() {
            ComponentStatus::Configured
        } else {
            ComponentStatus::Unconfigured
        },
        storage: if state.storage().is_some() {
            ComponentStatus::Configured
        } else {
            ComponentStatus::Unconfigured
        },
    })
}

async fn db_health(State(state): State<AppState>) -> Response {
    let Some(db) = state.db() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(DbHealthBody { ok: false, error: Some("db not configured".into()) }),
        )
            .into_response();
    };
    match db.ping().await {
        Ok(()) => (StatusCode::OK, Json(DbHealthBody { ok: true, error: None })).into_response(),
        Err(err) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(DbHealthBody { ok: false, error: Some(err.message) }),
        )
            .into_response(),
    }
}
