-- Offline mirror of the server schema. The server treats files as
-- flat — directories are implicit in `path` — and tags rows with a
-- file-kind enum (`tex` / `bib` / `image` / `other`). Desktop mirrors
-- those columns plus:
--   * `content` — text body cached locally (binary files store
--     base64; size is bytes of the original)
--   * `dirty` — local writes not yet pushed to the server
--   * `last_synced_at` — last push/pull timestamp; combined with
--     `dirty` it tells the sync engine whether a server-side change
--     collides with a local-side edit

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    main_file TEXT,
    last_opened_at TEXT,
    server_synced_at TEXT,
    local_only INTEGER NOT NULL DEFAULT 0,
    dirty INTEGER NOT NULL DEFAULT 0,
    pending_metadata_patch TEXT
);

CREATE TABLE IF NOT EXISTS project_files (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('tex', 'bib', 'image', 'other')),
    size INTEGER,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    dirty INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT,
    UNIQUE(project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_project_files_project ON project_files(project_id);
CREATE INDEX IF NOT EXISTS idx_project_files_dirty ON project_files(project_id, dirty);

CREATE TABLE IF NOT EXISTS yjs_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    update_base64 TEXT NOT NULL,
    pushed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_yjs_updates_doc ON yjs_updates(doc_id);
CREATE INDEX IF NOT EXISTS idx_yjs_updates_pending ON yjs_updates(doc_id, pushed);

CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
