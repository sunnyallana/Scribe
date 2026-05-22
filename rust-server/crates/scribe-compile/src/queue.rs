//! Redis-backed job queue + log pub/sub.
//!
//! The Node server used BullMQ; we use raw Redis lists for the queue
//! (`LPUSH` to enqueue, `BLPOP` in the worker) and Redis pub/sub for
//! streaming log lines to connected WebSocket clients. Both stacks
//! can't share a queue during cutover (BullMQ stores in multiple keys
//! with a specific binary format), so this Rust port uses a distinct
//! list name: `scribe:compile:queue`.

use redis::{AsyncCommands, Client};
use scribe_shared::{CompileJobId, CompileJobPayload, CompileLogStreamMessage};
use thiserror::Error;
use tracing::debug;

pub const QUEUE_KEY: &str = "scribe:compile:queue";

#[derive(Debug, Error)]
pub enum QueueError {
    #[error("redis: {0}")]
    Redis(#[from] redis::RedisError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct CompileQueue {
    /// We open a fresh `MultiplexedConnection` per operation. They're
    /// cheap and the redis crate internally pools them.
    client: Client,
}

impl CompileQueue {
    pub async fn connect(redis_url: &str) -> Result<Self, QueueError> {
        let client = Client::open(redis_url)?;
        // Probe once so a bad URL fails fast at startup.
        let _conn = client.get_multiplexed_async_connection().await?;
        Ok(Self { client })
    }

    /// Enqueue one job. The worker BRPOPs the right end of the list,
    /// so we LPUSH to the left for FIFO semantics.
    pub async fn enqueue(&self, payload: &CompileJobPayload) -> Result<(), QueueError> {
        let body = serde_json::to_string(payload)?;
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        conn.lpush::<_, _, ()>(QUEUE_KEY, body).await?;
        debug!(job = %payload.compile_job_id, "compile job enqueued");
        Ok(())
    }

    /// Block waiting for the next job. Returns `None` only if the timeout
    /// elapses with no job — used so the worker can periodically check
    /// for shutdown signals. `timeout_secs == 0` blocks indefinitely.
    ///
    /// `BRPOP` accepts a float timeout only on Redis ≥6.0; older
    /// versions (e.g. Redis-on-Windows 5.0) reject floats with
    /// `timeout is not an integer or out of range`. We pass an integer
    /// regardless so we work against either.
    pub async fn dequeue(
        &self,
        timeout_secs: f64,
    ) -> Result<Option<CompileJobPayload>, QueueError> {
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        let timeout = timeout_secs.max(0.0).round() as u64;
        let popped: Option<(String, String)> = redis::cmd("BRPOP")
            .arg(QUEUE_KEY)
            .arg(timeout)
            .query_async(&mut conn)
            .await?;
        let Some((_key, body)) = popped else {
            return Ok(None);
        };
        let payload: CompileJobPayload = serde_json::from_str(&body)?;
        Ok(Some(payload))
    }

    /// Publish a log/status frame on the per-job channel.
    pub async fn publish_log(
        &self,
        job_id: CompileJobId,
        message: &CompileLogStreamMessage,
    ) -> Result<(), QueueError> {
        let body = serde_json::to_string(message)?;
        let channel = log_channel(job_id);
        let mut conn = self.client.get_multiplexed_async_connection().await?;
        conn.publish::<_, _, ()>(channel, body).await?;
        Ok(())
    }

    /// Subscriber connection for one WebSocket session. Caller drives
    /// the inner stream and drops the conn on disconnect.
    pub async fn subscriber(&self) -> Result<redis::aio::PubSub, QueueError> {
        let conn = self.client.get_async_pubsub().await?;
        Ok(conn)
    }
}

/// Conventional channel name. Matches the legacy Fastify shape
/// (`compile:{jobId}`) so a Rust producer can talk to a Node tail
/// during cutover if we ever wanted that.
pub fn log_channel(job_id: CompileJobId) -> String {
    format!("compile:{}", job_id)
}
