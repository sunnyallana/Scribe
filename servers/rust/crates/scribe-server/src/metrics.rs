//! Prometheus-format metrics + per-route HTTP histograms.
//!
//! Two pieces:
//!
//! * **`/metrics`** — an unauthenticated endpoint that scrapers
//!   (Prometheus, OpenObserve, Grafana Agent…) hit. Emits all
//!   recorded counters/gauges/histograms in the standard format.
//! * **Middleware** — wraps every `/api/*` request, records latency
//!   into `http_requests_duration_seconds` (with method + matched
//!   path + status), increments `http_requests_total`, and tracks
//!   `http_requests_in_flight` as a gauge.
//!
//! Cardinality is bounded by using **matched path templates**
//! (`/api/projects/:id`) rather than the actual rendered URI — so a
//! pageful of projects produces one histogram bucket key, not N.

use std::time::Instant;

use axum::body::Body;
use axum::extract::{MatchedPath, Request};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use tracing::warn;

use crate::state::AppState;

/// Initialise the global metrics recorder. Must be called exactly once
/// at process startup, before any `counter!()` / `histogram!()` macros
/// fire. Returns the handle for serving via `/metrics`.
pub fn install_recorder() -> PrometheusHandle {
    PrometheusBuilder::new()
        // RED-style buckets: tight at the low end where most requests
        // live, sparse out to the tail so we can still see slow paths.
        .set_buckets_for_metric(
            Matcher::Full("http_requests_duration_seconds".to_string()),
            &[
                0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0,
                10.0,
            ],
        )
        .expect("metrics buckets")
        .install_recorder()
        .expect("install prometheus recorder")
}

/// Axum middleware that records request rate, error rate, and latency.
pub async fn track_http(req: Request<Body>, next: Next) -> Response {
    let method = req.method().clone();
    let matched = req
        .extensions()
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| req.uri().path().to_string());

    metrics::gauge!("http_requests_in_flight").increment(1.0);
    let start = Instant::now();
    let response = next.run(req).await;
    let elapsed = start.elapsed().as_secs_f64();
    metrics::gauge!("http_requests_in_flight").decrement(1.0);

    let status = response.status().as_u16().to_string();
    let labels = [
        ("method", method_label(&method)),
        ("path", matched),
        ("status", status),
    ];
    metrics::counter!("http_requests_total", &labels).increment(1);
    metrics::histogram!("http_requests_duration_seconds", &labels).record(elapsed);
    response
}

fn method_label(method: &Method) -> String {
    // Drop weird custom verbs into a single bucket so cardinality stays bounded.
    match *method {
        Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        | Method::HEAD | Method::OPTIONS => method.as_str().to_string(),
        _ => "OTHER".to_string(),
    }
}

/// Build the `/metrics` route. Bolted onto the main router so scrapers
/// hit `GET /metrics` and get the standard text-format dump.
pub fn router(handle: PrometheusHandle) -> Router<AppState> {
    Router::new().route(
        "/metrics",
        get(move || {
            let handle = handle.clone();
            async move {
                let body = handle.render();
                if body.is_empty() {
                    warn!("metrics handle returned empty body");
                }
                ([("content-type", "text/plain; version=0.0.4")], body).into_response()
            }
        }),
    )
}
