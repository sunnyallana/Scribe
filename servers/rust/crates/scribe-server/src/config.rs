//! Application configuration. Loaded from process environment with
//! sensible defaults so `cargo run` works without setting anything.
//!
//! Mirrors `server/src/env.ts` on the TypeScript side — env var names are
//! kept identical so a `.env` file works for both stacks during cutover.

use std::net::SocketAddr;

use figment::providers::{Env, Serialized};
use figment::Figment;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
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

    /// Path to the tectonic binary. Defaults to `tectonic` (PATH lookup).
    pub tectonic_bin: Option<String>,
    /// Hard kill the compile after this many ms. Same name as Node side.
    pub compile_timeout_ms: Option<u64>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
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
            tectonic_bin: None,
            compile_timeout_ms: None,
        }
    }
}

impl AppConfig {
    pub fn from_env() -> Result<Self, figment::Error> {
        Figment::from(Serialized::defaults(AppConfig::default()))
            .merge(Env::raw().lowercase(true))
            .extract()
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
