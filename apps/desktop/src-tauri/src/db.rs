//! Offline SQLite mirror.
//!
//! All Rust modules and SPA commands route through a single
//! `SqlitePool` rooted at `<app_local_data_dir>/scribe.db`. The schema
//! mirrors the server (`project_files`, `yjs_updates`) plus desktop-
//! only `dirty` / `last_synced_at` columns the sync engine reads.

use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::{ConnectOptions, FromRow, SqlitePool};
use tauri::{Manager, State};

const INIT_SQL: &str = include_str!("../migrations/001_init.sql");

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] sqlx::Error),
    #[error("path: {0}")]
    Path(String),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
}

impl serde::Serialize for DbError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

impl Db {
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

pub async fn init(app: &tauri::AppHandle) -> Result<Arc<Db>, DbError> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| DbError::Path(format!("app_local_data_dir: {e}")))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| DbError::Path(format!("create data dir: {e}")))?;
    let db_path = data_dir.join("scribe.db");
    let pool = open_pool(&db_path).await?;
    migrate(&pool).await?;
    Ok(Arc::new(Db { pool }))
}

async fn open_pool(db_path: &Path) -> Result<SqlitePool, DbError> {
    // `sqlite:` URLs require forward slashes on every platform.
    let url = format!("sqlite://{}", db_path.to_string_lossy().replace('\\', "/"));
    let opts = SqliteConnectOptions::from_str(&url)
        .map_err(DbError::Sqlite)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5))
        .disable_statement_logging();
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

async fn migrate(pool: &SqlitePool) -> Result<(), DbError> {
    let mut conn = pool.acquire().await?;
    sqlx::raw_sql(INIT_SQL).execute(&mut *conn).await?;
    Ok(())
}

// ---- Project / file shapes ------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LocalProject {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub main_file: Option<String>,
    pub last_opened_at: Option<String>,
    pub server_synced_at: Option<String>,
    pub local_only: i64,
    pub dirty: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
    pub id: String,
    pub project_id: String,
    pub path: String,
    #[serde(rename = "type")]
    #[sqlx(rename = "type")]
    pub kind: String,
    pub size: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub dirty: i64,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProjectInput {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub main_file: Option<String>,
    pub local_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertFileInput {
    pub id: String,
    pub project_id: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
}

// ---- Project commands -----------------------------------------------------

#[tauri::command]
pub async fn db_list_projects(db: State<'_, Arc<Db>>) -> Result<Vec<LocalProject>, DbError> {
    let rows: Vec<LocalProject> = sqlx::query_as::<_, LocalProject>(
        "SELECT id, name, description, main_file, last_opened_at, server_synced_at, local_only, dirty \
         FROM projects ORDER BY COALESCE(last_opened_at, '') DESC",
    )
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn db_get_project(
    db: State<'_, Arc<Db>>,
    id: String,
) -> Result<Option<LocalProject>, DbError> {
    let row = sqlx::query_as::<_, LocalProject>(
        "SELECT id, name, description, main_file, last_opened_at, server_synced_at, local_only, dirty \
         FROM projects WHERE id = ?1",
    )
    .bind(&id)
    .fetch_optional(db.pool())
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn db_upsert_project(
    db: State<'_, Arc<Db>>,
    input: UpsertProjectInput,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO projects (id, name, description, main_file, local_only, dirty) \
         VALUES (?1, ?2, ?3, ?4, ?5, 1) \
         ON CONFLICT(id) DO UPDATE SET \
            name = excluded.name, \
            description = excluded.description, \
            main_file = excluded.main_file, \
            local_only = excluded.local_only, \
            dirty = 1",
    )
    .bind(&input.id)
    .bind(&input.name)
    .bind(&input.description)
    .bind(&input.main_file)
    .bind(i64::from(input.local_only))
    .execute(db.pool())
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn db_touch_project(db: State<'_, Arc<Db>>, id: String) -> Result<(), DbError> {
    sqlx::query("UPDATE projects SET last_opened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
        .bind(&id)
        .execute(db.pool())
        .await?;
    Ok(())
}

// ---- File commands --------------------------------------------------------

#[tauri::command]
pub async fn db_list_files(
    db: State<'_, Arc<Db>>,
    project_id: String,
) -> Result<Vec<LocalFile>, DbError> {
    let rows = sqlx::query_as::<_, LocalFile>(
        "SELECT id, project_id, path, type, size, created_at, updated_at, dirty, last_synced_at \
         FROM project_files WHERE project_id = ?1 ORDER BY path",
    )
    .bind(&project_id)
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn db_read_file(
    db: State<'_, Arc<Db>>,
    file_id: String,
) -> Result<Option<String>, DbError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT content FROM project_files WHERE id = ?1")
            .bind(&file_id)
            .fetch_optional(db.pool())
            .await?;
    Ok(row.and_then(|(c,)| c))
}

#[tauri::command]
pub async fn db_upsert_file(
    db: State<'_, Arc<Db>>,
    input: UpsertFileInput,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO project_files (id, project_id, path, type, dirty) \
         VALUES (?1, ?2, ?3, ?4, 1) \
         ON CONFLICT(id) DO UPDATE SET \
            path = excluded.path, \
            type = excluded.type, \
            dirty = 1, \
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(&input.id)
    .bind(&input.project_id)
    .bind(&input.path)
    .bind(&input.kind)
    .execute(db.pool())
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn db_write_file_content(
    db: State<'_, Arc<Db>>,
    file_id: String,
    content: String,
) -> Result<(), DbError> {
    let size = i64::try_from(content.len()).unwrap_or(i64::MAX);
    sqlx::query(
        "UPDATE project_files SET content = ?1, size = ?2, dirty = 1, \
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') \
         WHERE id = ?3",
    )
    .bind(&content)
    .bind(size)
    .bind(&file_id)
    .execute(db.pool())
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn db_remove_file(db: State<'_, Arc<Db>>, file_id: String) -> Result<(), DbError> {
    sqlx::query("DELETE FROM project_files WHERE id = ?1")
        .bind(&file_id)
        .execute(db.pool())
        .await?;
    Ok(())
}

// ---- Yjs update commands --------------------------------------------------

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct YjsUpdateRow {
    pub id: i64,
    pub doc_id: String,
    pub update_base64: String,
    pub pushed: i64,
}

#[tauri::command]
pub async fn db_append_yjs_update(
    db: State<'_, Arc<Db>>,
    doc_id: String,
    update_base64: String,
) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as(
        "INSERT INTO yjs_updates (doc_id, update_base64, pushed) VALUES (?1, ?2, 0) RETURNING id",
    )
    .bind(&doc_id)
    .bind(&update_base64)
    .fetch_one(db.pool())
    .await?;
    Ok(row.0)
}

#[tauri::command]
pub async fn db_load_yjs_updates(
    db: State<'_, Arc<Db>>,
    doc_id: String,
) -> Result<Vec<YjsUpdateRow>, DbError> {
    let rows = sqlx::query_as::<_, YjsUpdateRow>(
        "SELECT id, doc_id, update_base64, pushed FROM yjs_updates WHERE doc_id = ?1 ORDER BY id",
    )
    .bind(&doc_id)
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn db_pending_yjs_updates(
    db: State<'_, Arc<Db>>,
    doc_id: String,
) -> Result<Vec<YjsUpdateRow>, DbError> {
    let rows = sqlx::query_as::<_, YjsUpdateRow>(
        "SELECT id, doc_id, update_base64, pushed FROM yjs_updates WHERE doc_id = ?1 AND pushed = 0 ORDER BY id",
    )
    .bind(&doc_id)
    .fetch_all(db.pool())
    .await?;
    Ok(rows)
}

#[tauri::command]
pub async fn db_mark_yjs_pushed(
    db: State<'_, Arc<Db>>,
    ids: Vec<i64>,
) -> Result<(), DbError> {
    if ids.is_empty() {
        return Ok(());
    }
    // SQLite doesn't bind IN-lists, so we build the placeholders inline.
    // `ids` came from server-side rows so the count is bounded.
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("UPDATE yjs_updates SET pushed = 1 WHERE id IN ({placeholders})");
    let mut q = sqlx::query(&sql);
    for id in &ids {
        q = q.bind(id);
    }
    q.execute(db.pool()).await?;
    Ok(())
}

// ---- Sync state key/value -------------------------------------------------

#[tauri::command]
pub async fn db_get_sync_state(
    db: State<'_, Arc<Db>>,
    key: String,
) -> Result<Option<String>, DbError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM sync_state WHERE key = ?1")
        .bind(&key)
        .fetch_optional(db.pool())
        .await?;
    Ok(row.map(|(v,)| v))
}

#[tauri::command]
pub async fn db_set_sync_state(
    db: State<'_, Arc<Db>>,
    key: String,
    value: String,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, \
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(&key)
    .bind(&value)
    .execute(db.pool())
    .await?;
    Ok(())
}

