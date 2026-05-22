//! Scribe Rust server entrypoint.
//!
//! Brings up an Axum app that mirrors the Fastify server in `../server/`.
//! For now only `/api/health` is implemented — every other route lives as
//! a stub module under `routes/` and will be filled in incrementally.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::Context;
use axum::Router;
use scribe_ai::CryptoBox;
use scribe_auth::TokenVerifier;
use scribe_compile::{CompileQueue, Worker, WorkerConfig};
use scribe_storage::SupabaseStorage;
use scribe_yjs::{DocRegistry, PgPersistence};
use tokio::sync::Notify;
use tracing::{info, warn};

mod config;
mod db;
mod routes;
mod services;
mod state;

use config::AppConfig;
use db::Db;
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    init_tracing();
    // .env is optional in production (env vars come from the runtime); we
    // load it best-effort for local development.
    let _ = dotenvy::dotenv();

    let config = AppConfig::from_env().context("loading app config")?;
    let bind: SocketAddr = config.bind_addr().context("resolving bind address")?;

    let db = match config.database_url.as_deref() {
        Some(url) if !url.is_empty() => match Db::connect(url).await {
            Ok(db) => Some(db),
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

    let state = AppState::new(
        config.clone(),
        db,
        storage,
        compile_queue.clone(),
        ai_crypto,
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
        if let Some(bin) = config.tectonic_bin.as_deref().filter(|s| !s.is_empty()) {
            worker_cfg.tectonic.binary = bin.to_string();
        }
        if let Some(ms) = config.compile_timeout_ms {
            worker_cfg.tectonic.timeout = std::time::Duration::from_millis(ms);
        }
        info!("compile worker using tectonic: {}", worker_cfg.tectonic.binary);
        let worker = Worker {
            queue: (*queue).clone(),
            db: db.pool().clone(),
            storage,
            config: Arc::new(worker_cfg),
        };
        worker.spawn(worker_shutdown.clone());
        info!("compile worker enabled");
    } else {
        warn!("compile worker disabled (need DB + storage + REDIS_URL)");
    }

    let static_dir = config.scribe_static_dir.clone();
    let cors_origin = config.cors_origin.clone();

    let mut app = build_router(static_dir.as_deref(), cors_origin.as_deref())
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
    axum::serve(listener, app.into_make_service())
        .await
        .context("axum serve")?;
    Ok(())
}

fn build_router(static_dir: Option<&str>, cors_origin: Option<&str>) -> Router<AppState> {
    use axum::http::{header, HeaderValue, Method};
    use tower_http::cors::CorsLayer;
    use tower_http::services::{ServeDir, ServeFile};
    use tower_http::trace::TraceLayer;

    let api = Router::new()
        .merge(routes::health::router())
        .merge(routes::whoami::router())
        .merge(routes::projects::router())
        .merge(routes::files::router())
        .merge(routes::comments::router())
        .merge(routes::members::router())
        .merge(routes::invites::router())
        .merge(routes::versions::router())
        .merge(routes::yjs::router())
        .merge(routes::compiles::router())
        .merge(routes::ai::router());

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

    with_cors.layer(TraceLayer::new_for_http())
}

fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,scribe_server=debug"));
    fmt().with_env_filter(filter).with_target(false).compact().init();
}
