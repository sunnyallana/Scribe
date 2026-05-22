//! Postgres connection pool.
//!
//! In the Node server, request-scoped Supabase JS clients hit PostgREST,
//! which then attaches the user JWT to each query so Postgres RLS policies
//! see `auth.uid()`. We replace that with direct sqlx access — meaning
//! RLS becomes defense-in-depth (it still protects against direct DB
//! access from outside the app) but **authorization is enforced in this
//! server's query layer**. Every query that depends on the caller's
//! identity must take a `UserId` and include a membership check.

use std::str::FromStr;
use std::time::Duration;

use scribe_shared::{ApiError, ApiResult, ErrorCode};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use tracing::info;

/// Thin handle around a connection pool. Cloneable — clones share the
/// underlying pool.
#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

impl Db {
    /// Connect using the given DATABASE_URL. Tuned for the workload we
    /// expect: many short-lived requests, plus a few long-lived Yjs
    /// sessions that hold connections only briefly to flush updates.
    pub async fn connect(database_url: &str) -> ApiResult<Self> {
        // PgBouncer transaction mode (Supabase's port-6543 pooler) reuses
        // backend connections across multiple frontend sessions, so sqlx's
        // per-connection prepared-statement cache collides with itself.
        // Disabling the cache makes every query unprepared and is the
        // recommended fix for transaction-pooled deployments. The cost is
        // ~one extra round trip per query, which is dominated by network
        // latency anyway.
        let options = PgConnectOptions::from_str(database_url)
            .map_err(|err| ApiError::new(ErrorCode::Internal, format!("db url: {err}")))?
            .statement_cache_capacity(0);

        let pool = PgPoolOptions::new()
            .max_connections(20)
            .min_connections(2)
            .acquire_timeout(Duration::from_secs(5))
            .idle_timeout(Some(Duration::from_secs(300)))
            .test_before_acquire(true)
            .connect_with(options)
            .await
            .map_err(|err| ApiError::new(ErrorCode::Internal, format!("db connect: {err}")))?;
        info!("postgres pool ready ({} max conns, statement cache disabled for pgbouncer)", 20);
        Ok(Self { pool })
    }

    #[inline]
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Liveness probe. Fast — does a single `SELECT 1`.
    pub async fn ping(&self) -> ApiResult<()> {
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map(|_| ())
            .map_err(|err| ApiError::new(ErrorCode::ServiceUnavailable, format!("db ping: {err}")))
    }
}
