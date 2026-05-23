//! Health probes.
//!
//! * `GET /api/health`     — legacy combined endpoint. Kept for the
//!   existing uptime monitors; reports configured-status of each
//!   dependency without actually pinging them.
//! * `GET /api/health/db`  — legacy db readiness ping.
//! * `GET /healthz/live`   — kubernetes-style liveness. Always 200 once
//!   the binary is past initialization. Used by orchestrators to decide
//!   whether to restart the pod.
//! * `GET /healthz/ready`  — kubernetes-style readiness. 200 only when
//!   every wired dependency (DB, storage, Redis if configured) is
//!   reachable. Used by orchestrators to decide whether to route
//!   traffic — temporary DB hiccups remove the pod from the load
//!   balancer without restarting it.

use std::time::Duration;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use tokio::time::timeout;
use tracing::warn;

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

#[derive(Serialize)]
struct ReadyBody {
    ok: bool,
    checks: ReadyChecks,
}

#[derive(Serialize)]
struct ReadyChecks {
    db: CheckResult,
    storage: CheckResult,
    redis: CheckResult,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum CheckResult {
    Ok,
    Skipped { reason: &'static str },
    Failed { error: String },
}

impl CheckResult {
    fn is_ok_or_skipped(&self) -> bool {
        !matches!(self, CheckResult::Failed { .. })
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/health/db", get(db_health))
        // k8s-style probes. Different endpoints so orchestrators can
        // distinguish "the process is alive" from "the process can
        // serve traffic right now".
        .route("/healthz/live", get(live))
        .route("/healthz/ready", get(ready))
}

async fn live() -> impl IntoResponse {
    // Always 200 — once main() reaches `axum::serve`, the process is
    // healthy by definition. If we crash, the orchestrator's failure
    // detection (TCP socket close) handles it.
    (StatusCode::OK, "ok\n")
}

/// Deep readiness check: ping every configured dependency in parallel
/// with a tight per-check timeout. Slow dependencies fail the check
/// rather than letting the probe hang.
async fn ready(State(state): State<AppState>) -> Response {
    let per_check = Duration::from_secs(2);

    let db_check = async {
        match state.db() {
            None => CheckResult::Skipped { reason: "DATABASE_URL not set" },
            Some(db) => match timeout(per_check, db.ping()).await {
                Ok(Ok(())) => CheckResult::Ok,
                Ok(Err(err)) => CheckResult::Failed { error: err.message },
                Err(_) => CheckResult::Failed { error: "db ping timed out".into() },
            },
        }
    };

    let storage_check = async {
        match state.storage() {
            None => CheckResult::Skipped { reason: "SUPABASE_URL / SERVICE_ROLE_KEY not set" },
            Some(_) => {
                // We don't have a low-cost storage ping; existence of the
                // client + a valid base URL is good enough. The client
                // would have failed at construction time if either was
                // garbled, so reaching here means we have something usable.
                CheckResult::Ok
            }
        }
    };

    let redis_check = async {
        match state.inner.compile_queue.as_ref() {
            None => CheckResult::Skipped { reason: "REDIS_URL not set" },
            Some(queue) => {
                // The queue's subscriber() will round-trip a CLIENT
                // GETNAME on connect; success = redis reachable.
                match timeout(per_check, queue.subscriber()).await {
                    Ok(Ok(_)) => CheckResult::Ok,
                    Ok(Err(err)) => CheckResult::Failed { error: err.to_string() },
                    Err(_) => CheckResult::Failed { error: "redis ping timed out".into() },
                }
            }
        }
    };

    let (db, storage, redis) = tokio::join!(db_check, storage_check, redis_check);

    let ok = db.is_ok_or_skipped() && storage.is_ok_or_skipped() && redis.is_ok_or_skipped();
    let body = ReadyBody { ok, checks: ReadyChecks { db, storage, redis } };
    let status = if ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
    if !ok {
        warn!("readiness check failed: {}", serde_json::to_string(&body).unwrap_or_default());
    }
    (status, Json(body)).into_response()
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
