//! Sync engine: glue between the local SQLite mirror and the remote
//! Scribe server.
//!
//! The orchestration lives in TypeScript (`apps/web/src/lib/sync.ts`)
//! so it can reuse the existing `api.*` HTTP client and Yjs WebSocket
//! provider. This module exposes the SQLite primitives the
//! orchestrator needs:
//!
//!   * inventory: "what's dirty?", "how many Yjs updates are pending?"
//!   * conflict detection: "did the server's `updated_at` advance past
//!     our `last_synced_at` while we had local edits?"
//!   * resolution: keep-local / keep-remote / save-as-copy, each as a
//!     single SQLite mutation
//!
//! Metadata strategy is last-write-wins for non-collision cases (Q11);
//! hard conflicts are surfaced as `SyncConflict` rows for the SPA to
//! prompt the user.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

use crate::db::{Db, DbError, LocalFile};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPendingSummary {
    pub dirty_files: i64,
    pub pending_yjs_updates: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileSummary {
    pub id: String,
    pub project_id: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub updated_at: String,
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub file_id: String,
    pub path: String,
    pub local_updated_at: String,
    pub remote_updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncApplyResult {
    pub applied: u32,
    pub conflicts: Vec<SyncConflict>,
}

#[tauri::command]
pub async fn sync_pending_summary(
    db: State<'_, Arc<Db>>,
    project_id: String,
    doc_id_prefix: Option<String>,
) -> Result<SyncPendingSummary, DbError> {
    let dirty_files: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM project_files WHERE project_id = ?1 AND dirty = 1",
    )
    .bind(&project_id)
    .fetch_one(db.pool())
    .await?;
    // doc_id is `<project_id>/<file_id>`; we filter with `LIKE
    // 'project_id/%'` so the count is project-scoped without forcing
    // the caller to enumerate files first.
    let yjs_prefix = format!("{}/%", doc_id_prefix.unwrap_or(project_id));
    let pending_yjs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM yjs_updates WHERE pushed = 0 AND doc_id LIKE ?1",
    )
    .bind(&yjs_prefix)
    .fetch_one(db.pool())
    .await?;
    Ok(SyncPendingSummary {
        dirty_files,
        pending_yjs_updates: pending_yjs,
    })
}

#[tauri::command]
pub async fn sync_list_dirty_files(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> Result<Vec<LocalFile>, DbError> {
    let rows = sqlx::query_as::<_, LocalFile>(
        "SELECT id, project_id, parent_id, path, type, size, created_at, updated_at, dirty, last_synced_at \
         FROM project_files WHERE project_id = ?1 AND dirty = 1 ORDER BY updated_at",
    )
    .bind(&project_id)
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

/// Apply a server-side file inventory to the local mirror.
///
/// For each row in `remote_files`:
///   * If we don't have it locally → insert as clean (last_synced_at =
///     remote.updated_at, dirty = 0).
///   * If we have it and our row isn't dirty → overwrite metadata
///     fields, mark clean.
///   * If we have it AND our row is dirty AND the server's updated_at
///     is later than our last_synced_at → record a conflict and skip.
///
/// Local rows missing from `remote_files` are left alone; the caller
/// decides whether to delete them (you can't tell if the server lost
/// them or our list is stale).
#[tauri::command]
pub async fn sync_apply_remote_files(
    db: State<'_, Arc<Db>>,
    project_id: String,
    remote_files: Vec<RemoteFileSummary>,
) -> Result<SyncApplyResult, DbError> {
    let mut applied = 0u32;
    let mut conflicts = Vec::new();
    let mut tx = db.pool().begin().await?;
    for remote in remote_files {
        if remote.project_id != project_id {
            continue;
        }
        let existing = sqlx::query(
            "SELECT dirty, last_synced_at, updated_at FROM project_files WHERE id = ?1",
        )
        .bind(&remote.id)
        .fetch_optional(&mut *tx)
        .await?;

        let conflict = match &existing {
            None => false,
            Some(row) => {
                let dirty: i64 = row.try_get("dirty")?;
                let last_synced: Option<String> = row.try_get("last_synced_at")?;
                dirty != 0
                    && last_synced.as_deref().is_none_or(|s| s < remote.updated_at.as_str())
            }
        };
        if conflict {
            let row = existing.as_ref().expect("conflict branch implies existence");
            let local_updated: String = row.try_get("updated_at")?;
            conflicts.push(SyncConflict {
                file_id: remote.id.clone(),
                path: remote.path.clone(),
                local_updated_at: local_updated,
                remote_updated_at: remote.updated_at.clone(),
            });
            continue;
        }
        sqlx::query(
            "INSERT INTO project_files (id, project_id, path, type, size, updated_at, dirty, last_synced_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?6) \
             ON CONFLICT(id) DO UPDATE SET \
                path = excluded.path, \
                type = excluded.type, \
                size = excluded.size, \
                updated_at = excluded.updated_at, \
                last_synced_at = excluded.last_synced_at, \
                dirty = 0",
        )
        .bind(&remote.id)
        .bind(&remote.project_id)
        .bind(&remote.path)
        .bind(&remote.kind)
        .bind(remote.size)
        .bind(&remote.updated_at)
        .execute(&mut *tx)
        .await?;
        applied += 1;
    }
    tx.commit().await?;
    Ok(SyncApplyResult { applied, conflicts })
}

/// Overwrite the local content + metadata with the server's version.
/// Used by the "Keep remote" resolution.
#[tauri::command]
pub async fn sync_apply_remote_content(
    db: State<'_, Arc<Db>>,
    file_id: String,
    content: String,
    remote_updated_at: String,
) -> Result<(), DbError> {
    let size = i64::try_from(content.len()).unwrap_or(i64::MAX);
    sqlx::query(
        "UPDATE project_files SET content = ?1, size = ?2, updated_at = ?3, \
            last_synced_at = ?3, dirty = 0 WHERE id = ?4",
    )
    .bind(&content)
    .bind(size)
    .bind(&remote_updated_at)
    .bind(&file_id)
    .execute(db.pool())
    .await?;
    Ok(())
}

/// Mark a file clean after the SPA successfully pushed it to the
/// server. `server_updated_at` is the timestamp the server returned
/// from the write — we record it as `last_synced_at` so the next pull
/// won't see a phantom conflict.
#[tauri::command]
pub async fn sync_mark_file_clean(
    db: State<'_, Arc<Db>>,
    file_id: String,
    server_updated_at: String,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE project_files SET dirty = 0, last_synced_at = ?1, updated_at = ?1 WHERE id = ?2",
    )
    .bind(&server_updated_at)
    .bind(&file_id)
    .execute(db.pool())
    .await?;
    Ok(())
}

/// Split a conflict into a new "copy" row so both versions survive.
/// The caller is expected to push the copy to the server as a brand-
/// new file (assign a fresh id beforehand).
#[tauri::command]
pub async fn sync_resolve_make_copy(
    db: State<'_, Arc<Db>>,
    source_file_id: String,
    new_file_id: String,
    new_path: String,
) -> Result<(), DbError> {
    let mut tx = db.pool().begin().await?;
    let row =
        sqlx::query("SELECT project_id, type, content FROM project_files WHERE id = ?1")
            .bind(&source_file_id)
            .fetch_one(&mut *tx)
            .await?;
    let project_id: String = row.try_get("project_id")?;
    let kind: String = row.try_get("type")?;
    let content: Option<String> = row.try_get("content")?;
    let size = content
        .as_ref()
        .map(|c| i64::try_from(c.len()).unwrap_or(i64::MAX));
    sqlx::query(
        "INSERT INTO project_files (id, project_id, path, type, content, size, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
    )
    .bind(&new_file_id)
    .bind(&project_id)
    .bind(&new_path)
    .bind(&kind)
    .bind(&content)
    .bind(size)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
