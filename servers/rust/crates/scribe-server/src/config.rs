//! Application configuration. Loaded from process environment (and an
//! optional TOML file) with per-environment defaults so `cargo run`
//! works without setting anything.
//!
//! Layered loading (later layers override earlier ones):
//!   1. `FeatureFlags::for_env(env)` — env-shape defaults baked into code.
//!   2. `scribe.config.toml` if present at the path from
//!      `SCRIBE_CONFIG_FILE` (defaults to `./scribe.config.toml`).
//!   3. Process env vars — `SCRIBE_ENV`, plus everything figment picks
//!      up via lowercase matching (DATABASE_URL, PORT, REDIS_URL, …).
//!      Individual feature flags can be overridden with
//!      `SCRIBE_FEATURE_<NAME>=true|false`, e.g.
//!      `SCRIBE_FEATURE_CACHE_ENABLED=false` to debug stale-read bugs.

use std::net::SocketAddr;
use std::path::Path;

use figment::providers::{Env, Format, Serialized, Toml};
use figment::Figment;
use serde::{Deserialize, Serialize};

/// Runtime environment. Switches per-env defaults across `FeatureFlags`
/// and the logging layer (pretty + debug for dev, JSON + info for prod).
/// `Testing` is for CI / integration tests — compile worker off, no
/// caches, no metrics, no rate limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AppEnv {
    #[default]
    Development,
    Production,
    Testing,
}

impl AppEnv {
    pub fn is_prod(self) -> bool { matches!(self, Self::Production) }

    fn from_str_loose(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "production" | "prod" => Some(Self::Production),
            "testing" | "test" => Some(Self::Testing),
            "development" | "dev" => Some(Self::Development),
            _ => None,
        }
    }
}

/// Feature flags. Each one defaults per-env in [`FeatureFlags::for_env`].
/// Add new flags by extending this struct + the per-env defaults and
/// reading the field at the call site — there's no implicit registry.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct FeatureFlags {
    /// Server-side response cache (L1 Moka + L2 Redis) for hot GET
    /// endpoints. Off → every read goes straight to Postgres + Storage.
    /// Defaults: dev=off, prod=on, testing=off.
    pub cache_enabled: bool,
    /// Cache-Control / ETag headers on cacheable responses. When off we
    /// emit `Cache-Control: no-store` so browsers can't hold stale
    /// copies either — essential while debugging save/refresh round-trips.
    pub client_cache_headers: bool,
    /// Yjs WebSocket realtime collab. Off would force solo-mode editing.
    pub yjs_realtime: bool,
    /// Compile worker loop. Off in `testing` so CI runs don't spin
    /// tectonic; off skips the BLPOP loop entirely.
    pub compile_worker: bool,
    /// Per-IP / per-user token-bucket rate limit. Off in dev for fast
    /// iteration; on in prod.
    pub rate_limiting: bool,
    /// Prometheus `/metrics` endpoint.
    pub metrics_endpoint: bool,
    /// `debug!` log level for our crates (regardless of `RUST_LOG`).
    /// `RUST_LOG` still wins if explicitly set.
    pub debug_logging: bool,
}

impl FeatureFlags {
    /// Defaults per environment. Conservative for prod, permissive for
    /// dev, minimal for testing.
    pub fn for_env(env: AppEnv) -> Self {
        match env {
            AppEnv::Development => Self {
                // Caching off by default in dev: it's the first thing
                // you want to rule out when "save isn't reflecting".
                cache_enabled: false,
                client_cache_headers: false,
                yjs_realtime: true,
                compile_worker: true,
                rate_limiting: false,
                metrics_endpoint: true,
                debug_logging: true,
            },
            AppEnv::Production => Self {
                cache_enabled: true,
                client_cache_headers: true,
                yjs_realtime: true,
                compile_worker: true,
                rate_limiting: true,
                metrics_endpoint: true,
                debug_logging: false,
            },
            AppEnv::Testing => Self {
                cache_enabled: false,
                client_cache_headers: false,
                yjs_realtime: true,
                compile_worker: false,
                rate_limiting: false,
                metrics_endpoint: false,
                debug_logging: true,
            },
        }
    }
}

impl Default for FeatureFlags {
    fn default() -> Self {
        Self::for_env(AppEnv::Development)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// Runtime environment — selects the per-env feature-flag defaults
    /// and drives the logging layer's format/level choice.
    #[serde(default)]
    pub env: AppEnv,

    /// Feature toggles. Read in code via `state.config().features.<x>`.
    #[serde(default)]
    pub features: FeatureFlags,

    /// Address to bind the HTTP listener (default 0.0.0.0:3001 to match
    /// the Fastify port).
    pub host: String,
    pub port: u16,

    /// Optional — present so the AppState wiring can stay stable as we
    /// port more pieces over. Loaded by individual modules when needed.
    pub database_url: Option<String>,
    pub supabase_url: Option<String>,
    pub supabase_anon_key: Option<String>,
    pub supabase_service_role_key: Option<String>,
    pub supabase_jwt_secret: Option<String>,
    pub redis_url: Option<String>,
    pub ai_key_encryption_key: Option<String>,

    pub file_size_max_bytes: u64,

    /// Comma-separated origins allowed for CORS. Empty/unset = no CORS
    /// headers (same-origin only — useful when the SPA is served by
    /// this same binary via `scribe_static_dir`).
    pub cors_origin: Option<String>,

    /// Directory to serve as the SPA. Bundled apps/web/dist lives here
    /// in container builds. When set, requests that don't match an API
    /// route fall through to a static file lookup; missing files SPA-
    /// fallback to index.html so client-side routing works.
    pub scribe_static_dir: Option<String>,

    /// Compile engine selector. `"tectonic"` (default) keeps the
    /// single-binary, auto-fetched-CTAN-packages path; `"latexmk"`
    /// switches to the Overleaf-style pipeline (`latexmk` driving
    /// pdflatex/xelatex/lualatex against a local TeX Live / MiKTeX).
    /// Empty / unrecognised falls back to tectonic.
    pub compile_engine: Option<String>,
    /// Fallback engine. When the primary engine returns non-zero,
    /// the worker re-runs the compile with this engine and uses its
    /// outcome. Empty / unset disables the fallback path.
    pub compile_fallback_engine: Option<String>,
    /// Path to the tectonic binary. Defaults to `tectonic` (PATH lookup).
    pub tectonic_bin: Option<String>,
    /// Path to the latexmk binary when `compile_engine="latexmk"`.
    /// Defaults to `latexmk` (PATH lookup).
    pub latexmk_bin: Option<String>,
    /// Underlying LaTeX engine that latexmk should drive:
    /// `"pdflatex"` (default), `"xelatex"`, or `"lualatex"`.
    pub latex_engine: Option<String>,
    /// Path to the pandoc binary used for LaTeX→Markdown / LaTeX→DOCX
    /// exports. Defaults to `pandoc` (PATH lookup). If neither this
    /// nor `pandoc` on PATH resolves, the export routes 503 with a
    /// clear "install pandoc" message.
    pub pandoc_bin: Option<String>,
    /// Hard kill the compile after this many ms. Same name as Node side.
    pub compile_timeout_ms: Option<u64>,
    /// Persistent cache directory for tectonic so package downloads
    /// from CTAN are reused between compiles. When unset, tectonic
    /// uses the OS default. In container deployments, mount a volume
    /// here so cache survives restarts.
    pub tectonic_cache_dir: Option<String>,
    /// Number of compile worker tasks to spawn — each does an
    /// independent BRPOP loop on Redis. Defaults to 2.
    pub compile_worker_concurrency: Option<u32>,
    /// Path to the chktex binary used to lint .tex files after a
    /// compile. When unset, the lint pass is skipped — there's no
    /// fallback to `chktex` on PATH because most deployments don't
    /// have it installed, and a noisy ENOENT log per compile is
    /// worse UX than a silent opt-in.
    pub chktex_bin: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            env: AppEnv::default(),
            features: FeatureFlags::default(),
            host: "0.0.0.0".to_string(),
            port: 3001,
            database_url: None,
            supabase_url: None,
            supabase_anon_key: None,
            supabase_service_role_key: None,
            supabase_jwt_secret: None,
            redis_url: None,
            ai_key_encryption_key: None,
            file_size_max_bytes: 25 * 1024 * 1024,
            cors_origin: None,
            scribe_static_dir: None,
            compile_engine: None,
            compile_fallback_engine: None,
            tectonic_bin: None,
            latexmk_bin: None,
            latex_engine: None,
            pandoc_bin: None,
            compile_timeout_ms: None,
            tectonic_cache_dir: None,
            compile_worker_concurrency: None,
            chktex_bin: None,
        }
    }
}

impl AppConfig {
    #[allow(clippy::result_large_err)] // figment::Error is large but only ever fires once at startup
    pub fn from_env() -> Result<Self, figment::Error> {
        // ── 1. Detect env upfront so we can seed per-env feature
        //       defaults before the TOML/env layers override them.
        let env = std::env::var("SCRIBE_ENV")
            .ok()
            .and_then(|s| AppEnv::from_str_loose(&s))
            .unwrap_or_default();
        let base = AppConfig {
            env,
            features: FeatureFlags::for_env(env),
            ..AppConfig::default()
        };

        // ── 2. Layer in an optional TOML file. Path comes from
        //       SCRIBE_CONFIG_FILE; defaults to `./scribe.config.toml`
        //       in the current working dir. Missing file is fine.
        let toml_path = std::env::var("SCRIBE_CONFIG_FILE")
            .unwrap_or_else(|_| "scribe.config.toml".to_string());

        let mut fig = Figment::from(Serialized::defaults(base));
        if Path::new(&toml_path).is_file() {
            fig = fig.merge(Toml::file(&toml_path));
        }

        // ── 3. Process env vars. Existing infra: figment lowercases env
        //       var names and matches them to struct fields. Adds
        //       `SCRIBE_FEATURE_*` as a dedicated path for the nested
        //       `features.*` struct so users don't have to know the
        //       double-underscore figment dance.
        fig = fig.merge(Env::raw().lowercase(true).only(&[
            "host", "port", "database_url", "supabase_url",
            "supabase_anon_key", "supabase_service_role_key",
            "supabase_jwt_secret", "redis_url", "ai_key_encryption_key",
            "file_size_max_bytes", "cors_origin", "scribe_static_dir",
            "compile_engine", "compile_fallback_engine",
            "tectonic_bin", "latexmk_bin", "latex_engine",
            "pandoc_bin", "compile_timeout_ms", "tectonic_cache_dir",
            "compile_worker_concurrency", "chktex_bin",
        ]));

        // Map SCRIBE_FEATURE_<NAME>=value to features.name.
        // Figment's `Env::raw` doesn't handle nested fields nicely;
        // build the overrides manually.
        let mut features = fig.extract::<AppConfig>().unwrap_or_else(|_| AppConfig {
            env,
            features: FeatureFlags::for_env(env),
            ..AppConfig::default()
        }).features;
        apply_feature_env_overrides(&mut features);

        // Re-merge the now-final feature flags. `Serialized::default`
        // wins over earlier `features` settings because it's the latest
        // layer.
        let mut result: AppConfig = fig.extract()?;
        result.features = features;
        // Ensure env is the one we detected up-front (in case the TOML
        // didn't include it).
        if std::env::var("SCRIBE_ENV").is_ok() {
            result.env = env;
        }
        Ok(result)
    }

    pub fn bind_addr(&self) -> Result<SocketAddr, std::net::AddrParseError> {
        format!("{}:{}", self.host, self.port).parse()
    }

    /// `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` — None when
    /// SUPABASE_URL isn't set.
    pub fn jwks_url(&self) -> Option<String> {
        self.supabase_url
            .as_deref()
            .map(|base| format!("{}/auth/v1/.well-known/jwks.json", base.trim_end_matches('/')))
    }
}

/// Honour `SCRIBE_FEATURE_<NAME>=true|false` overrides without depending
/// on figment's somewhat-finicky nested-key conventions. Anything that
/// doesn't parse as a boolean is ignored (with a warning at startup
/// would be nicer, but tracing isn't initialised this early).
fn apply_feature_env_overrides(features: &mut FeatureFlags) {
    fn read_bool(name: &str) -> Option<bool> {
        let raw = std::env::var(name).ok()?;
        match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        }
    }
    if let Some(v) = read_bool("SCRIBE_FEATURE_CACHE_ENABLED") {
        features.cache_enabled = v;
    }
    if let Some(v) = read_bool("SCRIBE_FEATURE_CLIENT_CACHE_HEADERS") {
        features.client_cache_headers = v;
    }
    if let Some(v) = read_bool("SCRIBE_FEATURE_YJS_REALTIME") {
        features.yjs_realtime = v;
    }
    if let Some(v) = read_bool("SCRIBE_FEATURE_COMPILE_WORKER") {
        features.compile_worker = v;
    }
    if let Some(v) = read_bool("SCRIBE_FEATURE_RATE_LIMITING") {
        features.rate_limiting = v;
    }
    if let Some(v) = read_bool("SCRIBE_FEATURE_METRICS_ENDPOINT") {
        features.metrics_endpoint = v;
    }
    if let Some(v) = read_bool("SCRIBE_FEATURE_DEBUG_LOGGING") {
        features.debug_logging = v;
    }
}
