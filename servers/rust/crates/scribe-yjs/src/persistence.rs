//! Postgres persistence of Yjs binary updates.
//!
//! Schema: `public.yjs_updates(id bigserial, doc_id text, update_data text,
//! clock int, created_at timestamptz)` — `update_data` is base64-encoded
//! so the same rows are readable by the legacy Fastify server. Both
//! stacks can write into this table during cutover.

use async_trait::async_trait;
use base64::Engine;
use sqlx::PgPool;
use thiserror::Error;
use tracing::warn;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

const COMPACTION_THRESHOLD: usize = 100;

#[derive(Debug, Error)]
pub enum PersistenceError {
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
    #[error("decode update: {0}")]
    Decode(String),
    #[error("encode state: {0}")]
    Encode(String),
}

#[async_trait]
pub trait YjsPersistence: Send + Sync + 'static {
    /// Apply every stored update for `doc_id` to `doc`. After this call
    /// returns, the in-memory doc state matches what's in the database.
    async fn bind_state(&self, doc_id: &str, doc: &Doc) -> Result<(), PersistenceError>;

    /// Append one update. Each client edit produces one row; the
    /// compaction job (or `compact`) collapses them periodically.
    async fn store_update(&self, doc_id: &str, update: &[u8]) -> Result<(), PersistenceError>;

    /// Snapshot the doc into a single update row, then delete all
    /// older rows. Runs when `bind_state` notices too many.
    async fn compact(&self, doc_id: &str, doc: &Doc) -> Result<(), PersistenceError>;
}

/// Postgres-backed persistence using the existing `yjs_updates` schema.
#[derive(Clone)]
pub struct PgPersistence {
    pool: PgPool,
}

impl PgPersistence {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl YjsPersistence for PgPersistence {
    async fn bind_state(&self, doc_id: &str, doc: &Doc) -> Result<(), PersistenceError> {
        let rows = sqlx::query_as::<_, (i64, String)>(
            "select id, update_data from public.yjs_updates where doc_id = $1 order by id asc",
        )
        .bind(doc_id)
        .fetch_all(&self.pool)
        .await?;

        // The yrs transaction guard isn't Send; pulling it into a
        // sync helper ensures it's fully dropped before this async fn
        // can yield (otherwise the auto-Send bound on YjsPersistence
        // futures fails to compile).
        let count = apply_rows_sync(doc, doc_id, &rows);

        if count > COMPACTION_THRESHOLD {
            self.compact(doc_id, doc).await?;
        }
        Ok(())
    }

    async fn store_update(&self, doc_id: &str, update: &[u8]) -> Result<(), PersistenceError> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(update);
        sqlx::query("insert into public.yjs_updates (doc_id, update_data) values ($1, $2)")
            .bind(doc_id)
            .bind(b64)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn compact(&self, doc_id: &str, doc: &Doc) -> Result<(), PersistenceError> {
        // Encode state synchronously (same Send-future reason as above).
        let snapshot = encode_state_sync(doc);
        let b64 = base64::engine::general_purpose::STANDARD.encode(&snapshot);

        // Insert the snapshot, then delete everything older. PostgREST
        // doesn't expose transactions but sqlx does — wrap it.
        let mut tx = self.pool.begin().await?;
        let snapshot_id: i64 = sqlx::query_scalar(
            "insert into public.yjs_updates (doc_id, update_data, clock) values ($1, $2, 0) returning id",
        )
        .bind(doc_id)
        .bind(b64)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("delete from public.yjs_updates where doc_id = $1 and id < $2")
            .bind(doc_id)
            .bind(snapshot_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
}

/// Apply all stored rows to `doc` in a single synchronous transaction,
/// then return the row count so the caller can decide whether to
/// trigger compaction. Pulled out so `bind_state` can build a `Send`
/// future (yrs's `TransactionMut` is `!Send`).
fn apply_rows_sync(doc: &Doc, doc_id: &str, rows: &[(i64, String)]) -> usize {
    let mut txn = doc.transact_mut();
    for (_, b64) in rows {
        let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(b) => b,
            Err(err) => {
                warn!(?err, doc_id, "skipping corrupt yjs_updates row");
                continue;
            }
        };
        let update = match Update::decode_v1(&bytes) {
            Ok(u) => u,
            Err(err) => {
                warn!(?err, doc_id, "skipping malformed yjs update");
                continue;
            }
        };
        txn.apply_update(update);
    }
    rows.len()
}

/// Encode the full state-as-update synchronously so the caller's async
/// future stays `Send`.
fn encode_state_sync(doc: &Doc) -> Vec<u8> {
    doc.transact()
        .encode_state_as_update_v1(&StateVector::default())
}
