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
    /// Spawn a background task that snapshots pool occupancy into
    /// Prometheus gauges every `interval`. The gauges expose
    /// `sqlx_pool_connections{state="size|idle|busy"}` so Grafana can
    /// alert on pool exhaustion (busy >= max for sustained periods)
    /// long before users see latency spikes from the acquire_timeout.
    pub fn spawn_metrics_exporter(&self, interval: Duration) -> tokio::task::JoinHandle<()> {
        let pool = self.pool.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            // First tick fires immediately; skip so we have at least one
            // real sample (sqlx reports 0 until connections are created).
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let size = pool.size() as f64;
                let idle = pool.num_idle() as f64;
                let busy = (size - idle).max(0.0);
                metrics::gauge!("sqlx_pool_connections", "state" => "size").set(size);
                metrics::gauge!("sqlx_pool_connections", "state" => "idle").set(idle);
                metrics::gauge!("sqlx_pool_connections", "state" => "busy").set(busy);
            }
        })
    }
}

impl Db {
    /// Connect using the given DATABASE_URL. Tuned for the workload we
    /// expect: many short-lived requests, plus a few long-lived Yjs
    /// sessions that hold connections only briefly to flush updates.
    pub async fn connect(database_url: &str) -> ApiResult<Self> {
        // Statement cache is fine on the SESSION pooler (port 5432) — each
        // frontend session keeps its own backend connection, so prepared-
        // statement names don't collide. If you connect through Supabase's
        // TRANSACTION pooler on 6543, prepared statements collide across
        // sessions; either switch to 5432 or chain `.statement_cache_capacity(0)`
        // onto the options below at the cost of ~one extra round-trip per query.
        let options = PgConnectOptions::from_str(database_url)
            .map_err(|err| ApiError::new(ErrorCode::Internal, format!("db url: {err}")))?;

        let pool = PgPoolOptions::new()
            // Cap matches Supabase's per-IP session-pooler limit on the
            // free/starter tier; bump on paid tiers.
            .max_connections(15)
            // Warm a small portion of the pool at startup so the first
            // few concurrent requests skip TLS+auth handshakes; the
            // rest are created lazily on demand. Initializing all 15
            // at once trips the pooler's per-source rate limit.
            .min_connections(4)
            .acquire_timeout(Duration::from_secs(10))
            .idle_timeout(Some(Duration::from_secs(600)))
            .max_lifetime(Some(Duration::from_secs(30 * 60)))
            // `test_before_acquire(true)` would do a `SELECT 1` ping
            // before every checkout — brutal on a hosted pooler with
            // ~200ms RTT. We rely on sqlx's automatic re-acquire on
            // broken-pipe instead.
            .test_before_acquire(false)
            .connect_with(options)
            .await
            .map_err(|err| ApiError::new(ErrorCode::Internal, format!("db connect: {err}")))?;
        info!(max = pool.options().get_max_connections(), "postgres pool ready");
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
