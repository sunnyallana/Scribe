//! OpenTelemetry tracing bridge.
//!
//! When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, every `tracing` span gets
//! mirrored to a remote collector (Jaeger, Honeycomb, OpenObserve, etc.)
//! via OTLP/gRPC. When the env var is **unset**, this module is a
//! no-op — we keep the existing stdout/JSON tracer in place and add
//! zero per-request overhead.
//!
//! W3C trace-context propagation: spans inherit `traceparent` headers
//! coming in, and emit them on outbound calls (so downstream services
//! see the same trace ID).
//!
//! Design notes:
//! * Telemetry is *opt-in* so we don't spam stderr on local dev with
//!   "OTLP exporter could not connect" warnings.
//! * Failures during init log and continue — observability shouldn't
//!   take the server down.

use opentelemetry::global;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::TracerProvider;
use opentelemetry_sdk::Resource;
use tracing::{info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

const SERVICE_NAME: &str = "scribe-server";

/// Build the tracing subscriber. Drop-in replacement for
/// `init_tracing` — install once at startup. The returned guard must
/// be kept alive for the lifetime of the process so spans flush on
/// shutdown.
pub fn init() -> TelemetryGuard {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,scribe_server=info"));

    let endpoint = std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok();
    let provider = match endpoint.as_deref().filter(|e| !e.is_empty()) {
        Some(endpoint) => match build_otlp_provider(endpoint) {
            Ok(provider) => {
                info!(%endpoint, "OpenTelemetry export enabled");
                Some(provider)
            }
            Err(err) => {
                warn!(?err, "OpenTelemetry init failed; continuing without remote export");
                None
            }
        },
        None => None,
    };

    // `LOG_FORMAT=json` for production sinks (Loki/Datadog/CloudWatch),
    // compact text for local dev. Defaults to compact so existing `cargo
    // run` workflows keep their colored output.
    let json_logs = std::env::var("LOG_FORMAT")
        .map(|s| s.eq_ignore_ascii_case("json"))
        .unwrap_or(false);

    // Box the fmt layer so the compact + json branches share the same
    // type-erased shape and the registry composition compiles.
    // `with_current_span` lives on the `Json` formatter, not the
    // pre-`.json()` builder — apply it AFTER the format switch.
    let fmt_layer: Box<dyn tracing_subscriber::Layer<_> + Send + Sync> = if json_logs {
        Box::new(
            tracing_subscriber::fmt::layer()
                .with_target(true)
                .with_thread_ids(false)
                .with_thread_names(false)
                .with_file(false)
                .with_line_number(false)
                .json()
                .with_current_span(true)
                .with_span_list(false)
                .flatten_event(true),
        )
    } else {
        Box::new(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .compact(),
        )
    };

    if let Some(provider) = provider.as_ref() {
        global::set_text_map_propagator(TraceContextPropagator::new());
        let tracer = provider.tracer(SERVICE_NAME);
        let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .with(otel_layer)
            .init();
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(fmt_layer)
            .init();
    }

    TelemetryGuard { provider }
}

fn build_otlp_provider(endpoint: &str) -> Result<TracerProvider, opentelemetry::trace::TraceError> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint)
        .build()?;

    let resource = Resource::new(vec![
        KeyValue::new("service.name", SERVICE_NAME),
        KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
    ]);

    Ok(TracerProvider::builder()
        .with_resource(resource)
        .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
        .build())
}

/// Drop guard: flushes outstanding spans + shuts the provider down
/// when the process is exiting. Keep this alive until graceful
/// shutdown completes.
pub struct TelemetryGuard {
    provider: Option<TracerProvider>,
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take() {
            if let Err(err) = provider.shutdown() {
                warn!(?err, "OTel shutdown error");
            }
        }
        global::shutdown_tracer_provider();
    }
}
