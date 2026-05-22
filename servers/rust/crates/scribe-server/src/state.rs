//! Shared application state passed to every Axum handler. Held in an
//! `Arc` internally so cloning the state is cheap.

use std::sync::Arc;

use scribe_ai::CryptoBox;
use scribe_compile::CompileQueue;
use scribe_storage::SupabaseStorage;

use crate::config::AppConfig;
use crate::db::Db;

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<AppStateInner>,
}

pub struct AppStateInner {
    pub config: AppConfig,
    /// Postgres handle. `None` when DATABASE_URL is unset — useful in dev
    /// and for liveness probes that don't need the DB.
    pub db: Option<Db>,
    /// Storage client. `None` when SUPABASE_URL or service-role key are
    /// unset; routes that need it should 503 in that case.
    pub storage: Option<Arc<SupabaseStorage>>,
    /// Redis-backed compile queue. `None` when REDIS_URL is unset.
    pub compile_queue: Option<Arc<CompileQueue>>,
    /// AES-256-GCM box for wrapping user API keys. `None` when
    /// AI_KEY_ENCRYPTION_KEY isn't set; /api/ai routes 503 in that case.
    pub ai_crypto: Option<Arc<CryptoBox>>,
}

impl AppState {
    pub fn new(
        config: AppConfig,
        db: Option<Db>,
        storage: Option<Arc<SupabaseStorage>>,
        compile_queue: Option<Arc<CompileQueue>>,
        ai_crypto: Option<Arc<CryptoBox>>,
    ) -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                config,
                db,
                storage,
                compile_queue,
                ai_crypto,
            }),
        }
    }

    #[inline]
    pub fn config(&self) -> &AppConfig {
        &self.inner.config
    }

    #[inline]
    pub fn db(&self) -> Option<&Db> {
        self.inner.db.as_ref()
    }

    #[inline]
    pub fn storage(&self) -> Option<&SupabaseStorage> {
        self.inner.storage.as_deref()
    }
}
