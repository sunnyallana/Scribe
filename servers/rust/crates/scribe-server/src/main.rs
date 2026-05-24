//! Scribe Rust server entrypoint.
//!
//! Brings up an Axum app that mirrors the Fastify server in `../server/`.
//! For now only `/api/health` is implemented — every other route lives as
//! a stub module under `routes/` and will be filled in incrementally.

/// Process-wide allocator. mimalloc is consistently 15–25% faster than
/// the system allocator on this server's hot path (lots of small JSON
/// allocations), so we install it before any other code runs.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use scribe_ai::CryptoBox;
use scribe_auth::TokenVerifier;
use scribe_compile::{CompileQueue, EngineKind, LatexEngine, Worker, WorkerConfig};
use scribe_storage::SupabaseStorage;
use scribe_yjs::{DocRegistry, PgPersistence};
use tokio::sync::Notify;
use tracing::{info, warn};

mod config;
mod db;
mod metrics;
mod rate_limit;
mod response_cache;
mod routes;
mod services;
mod state;
mod telemetry;
mod voice;

use config::AppConfig;
use db::Db;
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // .env is optional in production (env vars come from the runtime); we
    // load it best-effort for local development. Must run before
    // `AppConfig::from_env` so the file's vars are visible.
    let _ = dotenvy::dotenv();

    // Load config FIRST so the telemetry layer can pick up env-aware
    // defaults (debug vs info, json vs compact). Before this we don't
    // emit any spans worth keeping.
    let config = AppConfig::from_env().context("loading app config")?;
    let bind: SocketAddr = config.bind_addr().context("resolving bind address")?;

    let _telemetry = telemetry::init(config.env, config.features.debug_logging);
    // Metrics recorder is global — set it before anyone fires a
    // `metrics::counter!()` macro.
    let metrics_handle = metrics::install_recorder();
    info!(
        env = ?config.env,
        cache_enabled = config.features.cache_enabled,
        client_cache_headers = config.features.client_cache_headers,
        yjs_realtime = config.features.yjs_realtime,
        compile_worker = config.features.compile_worker,
        rate_limiting = config.features.rate_limiting,
        "feature flags resolved"
    );

    let db = match config.database_url.as_deref() {
        Some(url) if !url.is_empty() => match Db::connect(url).await {
            Ok(db) => {
                // Background pool-occupancy exporter for Prometheus.
                // Cheap (gauge writes only); 5s is a reasonable scrape-aligned
                // cadence — slower than scrape_interval would lose sub-tick spikes.
                db.spawn_metrics_exporter(std::time::Duration::from_secs(5));
                Some(db)
            }
            Err(err) => {
                warn!("DB connect failed: {err}. Starting without DB; only /api/health will work.");
                None
            }
        },
        _ => {
            warn!("DATABASE_URL not set. Starting without DB; only /api/health will work.");
            None
        }
    };

    let storage = match (
        config.supabase_url.as_deref(),
        config.supabase_service_role_key.as_deref(),
    ) {
        (Some(url), Some(key)) if !url.is_empty() && !key.is_empty() => {
            match SupabaseStorage::new(url, key) {
                Ok(s) => Some(Arc::new(s)),
                Err(err) => {
                    warn!("Storage client init failed: {err}. File routes will 503.");
                    None
                }
            }
        }
        _ => {
            warn!("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. File routes will 503.");
            None
        }
    };

    let compile_queue = match config.redis_url.as_deref() {
        Some(url) if !url.is_empty() => match CompileQueue::connect(url).await {
            Ok(q) => Some(Arc::new(q)),
            Err(err) => {
                warn!("Compile queue init failed: {err}. /compile endpoints will 503.");
                None
            }
        },
        _ => {
            warn!("REDIS_URL not set. Compile queue disabled.");
            None
        }
    };

    let ai_crypto = match CryptoBox::from_env_value(config.ai_key_encryption_key.as_deref()) {
        Ok(cb) => Some(Arc::new(cb)),
        Err(err) => {
            warn!("AI encryption key not configured ({err}); /api/ai routes will 503");
            None
        }
    };

    // Response cache wiring: gated by the `cache_enabled` feature flag
    // AND the presence of a usable REDIS_URL. When the flag is off
    // (default in dev) we hand out a fully-disabled cache regardless
    // of Redis — short-circuits every cached_json call to the origin
    // and emits `Cache-Control: no-store` so browsers don't cache
    // either. Tied at the wiring layer so handlers never branch on it.
    let response_cache = if !config.features.cache_enabled {
        info!("response cache disabled by feature flag");
        response_cache::ResponseCache::with_flags(None, false, config.features.client_cache_headers)
    } else {
        match config.redis_url.as_deref().filter(|u| !u.is_empty()) {
            Some(url) => match redis::Client::open(url) {
                Ok(client) => {
                    info!("response cache enabled (redis)");
                    response_cache::ResponseCache::with_flags(
                        Some(Arc::new(client)),
                        true,
                        config.features.client_cache_headers,
                    )
                }
                Err(err) => {
                    warn!(?err, "response cache: invalid REDIS_URL; running L1-only");
                    response_cache::ResponseCache::with_flags(
                        None,
                        true,
                        config.features.client_cache_headers,
                    )
                }
            },
            None => {
                warn!("response cache: REDIS_URL not set; running L1-only");
                response_cache::ResponseCache::with_flags(
                    None,
                    true,
                    config.features.client_cache_headers,
                )
            }
        }
    };

    let state = AppState::new(
        db,
        storage,
        compile_queue.clone(),
        ai_crypto,
        response_cache,
    );

    let verifier = Arc::new(TokenVerifier::new(
        config.supabase_jwt_secret.as_deref(),
        config.jwks_url().as_deref(),
    ));

    // Yjs registry: built lazily once we know we have a DB to back it.
    // If the DB isn't configured, the WS route 503s rather than panicking.
    let yjs_registry = state
        .db()
        .map(|db| DocRegistry::new(Arc::new(PgPersistence::new(db.pool().clone()))));

    // Compile worker: spawn in-process when DB + storage + queue are all
    // available. Single-binary deployment means there's no separate
    // worker process to coordinate — clients just have the one server.
    let worker_shutdown = Arc::new(Notify::new());
    if let (Some(db), Some(storage), Some(queue)) = (
        state.db().cloned(),
        state.inner.storage.clone(),
        compile_queue.clone(),
    ) {
        let mut worker_cfg = WorkerConfig::default();
        // Honour the engine selector. Unrecognised values silently
        // fall back to the default (Tectonic) — the option is logged
        // below so misconfig is visible at startup.
        if let Some(name) = config.compile_engine.as_deref().filter(|s| !s.is_empty()) {
            if let Some(kind) = EngineKind::from_str(name) {
                worker_cfg.engine.kind = kind;
            } else {
                warn!(
                    requested = name,
                    "unknown compile_engine; falling back to tectonic"
                );
            }
        }
        // Tectonic-specific knobs (no-op when running latexmk).
        if let Some(bin) = config.tectonic_bin.as_deref().filter(|s| !s.is_empty()) {
            worker_cfg.engine.tectonic.binary = bin.to_string();
        }
        if let Some(ms) = config.compile_timeout_ms {
            let timeout = std::time::Duration::from_millis(ms);
            worker_cfg.engine.tectonic.timeout = timeout;
            worker_cfg.engine.latexmk.timeout = timeout;
        }
        if let Some(dir) = config.tectonic_cache_dir.as_deref().filter(|s| !s.is_empty()) {
            worker_cfg.engine.tectonic.cache_dir = Some(std::path::PathBuf::from(dir));
        }
        // latexmk-specific knobs.
        if let Some(bin) = config.latexmk_bin.as_deref().filter(|s| !s.is_empty()) {
            worker_cfg.engine.latexmk.binary = bin.to_string();
        }
        if let Some(eng) = config.latex_engine.as_deref().filter(|s| !s.is_empty()) {
            if let Some(parsed) = LatexEngine::from_str(eng) {
                worker_cfg.engine.latexmk.engine = parsed;
            } else {
                warn!(requested = eng, "unknown latex_engine; using pdflatex");
            }
        }
        // chktex binary (optional). When unset, the lint pass is
        // skipped and no warnings ever appear — exactly the v1 spec.
        if let Some(bin) = config.chktex_bin.as_deref().filter(|s| !s.is_empty()) {
            worker_cfg.chktex.binary = Some(bin.to_string());
            info!(binary = %bin, "chktex linter enabled");
        }
        // Fallback engine. Only honour it when it differs from the
        // primary — running the same engine twice tells us nothing
        // and just doubles compile latency on a real failure.
        if let Some(name) = config.compile_fallback_engine.as_deref().filter(|s| !s.is_empty()) {
            if let Some(fb_kind) = EngineKind::from_str(name) {
                if fb_kind != worker_cfg.engine.kind {
                    worker_cfg.fallback_engine = Some(fb_kind);
                    info!(primary = %worker_cfg.engine.kind.name(), fallback = %fb_kind.name(), "compile fallback enabled");
                } else {
                    warn!(engine = %fb_kind.name(), "fallback engine matches primary; ignoring");
                }
            } else {
                warn!(requested = name, "unknown compile_fallback_engine; ignoring");
            }
        }
        match worker_cfg.engine.kind {
            EngineKind::Tectonic => info!(
                engine = "tectonic",
                binary = %worker_cfg.engine.tectonic.binary,
                cache_dir = ?worker_cfg.engine.tectonic.cache_dir,
                "compile worker ready"
            ),
            EngineKind::Latexmk => info!(
                engine = "latexmk",
                binary = %worker_cfg.engine.latexmk.binary,
                latex = ?worker_cfg.engine.latexmk.engine,
                "compile worker ready (Overleaf-style pipeline)"
            ),
        }
        let worker = Worker {
            queue: (*queue).clone(),
            db: db.pool().clone(),
            storage,
            config: Arc::new(worker_cfg),
            project_locks: Arc::new(dashmap::DashMap::new()),
            file_state: Arc::new(dashmap::DashMap::new()),  // inner Arc<DashMap<..>> created lazily on first compile per project
        };
        let concurrency = config.compile_worker_concurrency.unwrap_or(2);
        worker.spawn_n(concurrency, worker_shutdown.clone());
        info!("compile workers enabled (concurrency={concurrency})");
    } else {
        warn!("compile worker disabled (need DB + storage + REDIS_URL)");
    }

    let static_dir = config.scribe_static_dir.clone();
    let cors_origin = config.cors_origin.clone();

    let mut app = build_router(static_dir.as_deref(), cors_origin.as_deref(), metrics_handle)
        .with_state(state)
        .layer(axum::Extension(verifier));
    if let Some(reg) = yjs_registry {
        app = app.layer(axum::Extension(reg));
    }
    if let Some(queue) = compile_queue {
        app = app.layer(axum::Extension(queue));
    }

    info!(%bind, "scribe-server listening");
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("binding {bind}"))?;

    // Graceful shutdown: on Ctrl-C (and on Unix, SIGTERM), drain
    // in-flight requests for up to ~10s, signal the compile worker,
    // then exit cleanly so connections aren't aborted mid-write.
    let shutdown = {
        let worker_shutdown = worker_shutdown.clone();
        async move {
            wait_for_shutdown_signal().await;
            info!("shutdown signal received; draining");
            worker_shutdown.notify_waiters();
        }
    };

    // `into_make_service_with_connect_info` wires the peer SocketAddr
    // into request extensions so the per-IP rate limiter can read it
    // without depending on a proxy header.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await
    .context("axum serve")?;
    info!("scribe-server stopped cleanly");
    Ok(())
}

/// Block until the process gets Ctrl-C (Windows) or SIGINT/SIGTERM (Unix).
async fn wait_for_shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut s) = signal(SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}

fn build_router(
    static_dir: Option<&str>,
    cors_origin: Option<&str>,
    metrics_handle: metrics_exporter_prometheus::PrometheusHandle,
) -> Router<AppState> {
    use std::time::Duration;

    use axum::http::{header, HeaderValue, Method};
    use axum::middleware::from_fn;
    use tower_http::compression::CompressionLayer;
    use tower_http::cors::CorsLayer;
    use tower_http::limit::RequestBodyLimitLayer;
    use tower_http::services::{ServeDir, ServeFile};
    use tower_http::timeout::TimeoutLayer;
    use tower_http::trace::TraceLayer;

    // Routes that orchestrators / scrapers poll heavily. They bypass
    // both rate-limit buckets so a busy probe never causes restarts.
    let infra = Router::new()
        .merge(routes::health::router())
        .merge(metrics::router(metrics_handle));

    // Everything user-facing. Per-user token bucket runs after auth has
    // populated the `AuthUser` extension (unauthenticated calls just
    // skip it and rely on the outer IP bucket).
    let api = Router::new()
        .merge(routes::whoami::router())
        .merge(routes::projects::router())
        .merge(routes::files::router())
        .merge(routes::comments::router())
        .merge(routes::members::router())
        .merge(routes::invites::router())
        .merge(routes::lint::router())
        .merge(routes::shares::router())
        .merge(routes::notifications::router())
        .merge(routes::versions::router())
        .merge(routes::yjs::router())
        .merge(routes::compiles::router())
        .merge(routes::ai::router())
        .merge(routes::exports::router())
        .merge(routes::voice::router())
        .layer(from_fn(rate_limit::per_user));

    let api = infra.merge(api).layer(from_fn(rate_limit::per_ip))
        // Record per-route RED metrics on every request. Layered after
        // the route table so it sees the `MatchedPath` extension and
        // can bucket by route template (low cardinality).
        .layer(from_fn(metrics::track_http));

    // Static SPA. Matches anything not handled by an /api/* route above.
    // 404s within the static dir fall back to index.html so client-side
    // routing (react-router) works.
    let with_spa = if let Some(dir) = static_dir.filter(|d| !d.is_empty()) {
        let index_path = format!("{}/index.html", dir.trim_end_matches('/'));
        let serve_dir = ServeDir::new(dir).fallback(ServeFile::new(index_path));
        api.fallback_service(serve_dir)
    } else {
        api
    };

    let with_cors = match cors_origin.filter(|s| !s.is_empty()) {
        Some(origins) => {
            // Comma-separated list — common pattern when there's a dev
            // origin (localhost:5173) and a prod origin (app.example.com).
            let parsed: Vec<HeaderValue> = origins
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .filter_map(|s| HeaderValue::from_str(s).ok())
                .collect();
            let layer = if parsed.is_empty() {
                CorsLayer::new()
            } else {
                CorsLayer::new()
                    .allow_origin(parsed)
                    .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
                    .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
                    .allow_credentials(true)
            };
            with_spa.layer(layer)
        }
        None => with_spa,
    };

    // Production-grade plumbing in a deliberate order (outer → inner):
    //   * Trace        — observability span around every request.
    //   * Timeout      — 30s ceiling on any HTTP handler. WebSocket and
    //                    SSE routes are exempt because tower's timeout
    //                    fires per-request rather than per-frame.
    //   * Compression  — gzip large JSON payloads on the wire. Cheap
    //                    CPU vs the network savings, especially over
    //                    high-latency links.
    //   * BodyLimit    — reject pathological large bodies before they
    //                    eat memory; multipart uploads have their own
    //                    cap inside the files route.
    with_cors
        // br > gzip on ratio (~20% smaller on JSON); both are negotiated
        // via Accept-Encoding so old clients still get gzip.
        .layer(CompressionLayer::new().br(true).gzip(true))
        .layer(RequestBodyLimitLayer::new(64 * 1024 * 1024))
        // `with_status_code` returns 504 on timeout rather than the
        // deprecated overload which returns a generic error.
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(TraceLayer::new_for_http())
}

