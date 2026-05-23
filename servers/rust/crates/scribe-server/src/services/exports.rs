//! LaTeX → Markdown / DOCX exports backed by the `pandoc` CLI.
//!
//! Per-request flow:
//!   1. Auth + membership check.
//!   2. Materialize the project's .tex / .bib / image files into a
//!      temp workdir (parallel downloads).
//!   3. Invoke pandoc with format-specific args.
//!   4. Read the produced file into memory and return.
//!   5. Drop the temp dir.
//!
//! Pandoc handles the parts the old regex converter couldn't: cross-
//! references, citations + bibliography, tables, custom commands,
//! macros, math, embedded images, and arbitrary preamble. The output
//! is dramatically higher-fidelity than client-side regex.
//!
//! Per-request memory is bounded by `MAX_OUTPUT_BYTES`; per-input by
//! the worker's existing file-size caps. Pandoc itself is wrapped in
//! a `tokio::time::timeout`.
//!
//! When `PANDOC_BIN` (or `pandoc` on PATH) isn't resolvable, the route
//! 503s with a message telling the operator how to install it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use scribe_shared::{ApiError, ApiResult, ErrorCode, ProjectId, UserId};
use scribe_storage::{Storage, SupabaseStorage, PROJECT_FILES_BUCKET};
use sqlx::{PgPool, Row};
use tempfile::TempDir;
use tokio::process::Command;
use tokio::{fs, time::timeout};

use super::membership::assert_member;

/// Output formats we currently support. Each maps to a pandoc `--to`
/// value plus a file extension + content type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Markdown,
    Docx,
}

impl ExportFormat {
    pub fn from_query(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "md" | "markdown" => Some(Self::Markdown),
            "docx" | "doc" | "word" => Some(Self::Docx),
            _ => None,
        }
    }

    pub fn pandoc_to(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Docx => "docx",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Docx => "docx",
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            // GitHub Flavoured Markdown is closer to `text/markdown` than
            // `text/plain`; the IETF type below is widely supported by
            // browsers as a downloadable.
            Self::Markdown => "text/markdown; charset=utf-8",
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }
    }
}

/// Hard cap on the bytes we'll read from pandoc's output file. A
/// runaway export shouldn't be able to OOM the API process.
const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024; // 64 MiB

/// Pandoc has its own timeout for `--bibliography` resolution and
/// network fetches (for citation-style files). Hard-stop the child
/// process if it goes long.
const PANDOC_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone)]
pub struct ExportService {
    pool: PgPool,
    storage: Arc<SupabaseStorage>,
    pandoc_bin: String,
}

#[derive(Debug)]
pub struct ExportResult {
    pub bytes: Bytes,
    pub filename: String,
    pub content_type: &'static str,
}

impl ExportService {
    pub fn new(pool: PgPool, storage: Arc<SupabaseStorage>, pandoc_bin: Option<String>) -> Self {
        Self {
            pool,
            storage,
            pandoc_bin: pandoc_bin
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "pandoc".to_string()),
        }
    }

    /// Run the export end-to-end. Returns the produced bytes plus the
    /// content-type the caller should set on the HTTP response.
    pub async fn export(
        &self,
        user: UserId,
        project: ProjectId,
        format: ExportFormat,
    ) -> ApiResult<ExportResult> {
        assert_member(&self.pool, user, project).await?;

        // ---- 1. Look up the project's main file ----
        let main_file: Option<String> = sqlx::query_scalar(
            "select main_file from public.projects where id = $1",
        )
        .bind(project.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let main_file = main_file
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "Project has no main file set"))?;

        // ---- 2. Fetch the project's file list ----
        let file_rows = sqlx::query(
            r#"
            select path, storage_key
            from public.project_files
            where project_id = $1
            "#,
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        if file_rows.is_empty() {
            return Err(ApiError::new(
                ErrorCode::NotFound,
                "Project has no files to export",
            ));
        }

        // ---- 3. Materialize to temp dir ----
        let tmp = TempDir::new()
            .map_err(|err| ApiError::internal(format!("temp dir: {err}")))?;
        let workdir = tmp.path().to_path_buf();
        materialize_files(&self.storage, &workdir, &file_rows).await?;

        // ---- 4. Resolve the main-file path on disk ----
        let main_path = workdir.join(&main_file);
        if !main_path.is_file() {
            return Err(ApiError::new(
                ErrorCode::NotFound,
                format!("Main file '{main_file}' is missing from the project"),
            ));
        }

        // ---- 5. Find a .bib file (if any) and any reference doc for DOCX ----
        let bib_path = find_first_with_ext(&file_rows, "bib");

        // ---- 6. Invoke pandoc ----
        let out_path = workdir.join(format!("export.{ext}", ext = format.extension()));
        let mut cmd = Command::new(&self.pandoc_bin);
        cmd.current_dir(&workdir)
            .arg(&main_file) // pass relative so pandoc resolves \input{} cleanly
            .arg("--from").arg("latex")
            .arg("--to").arg(format.pandoc_to())
            .arg("--standalone")
            .arg("--wrap=preserve")
            .arg("-o").arg(out_path.file_name().unwrap_or_default());
        if let Some(bib) = bib_path.as_deref() {
            cmd.arg("--citeproc").arg("--bibliography").arg(bib);
        }
        if matches!(format, ExportFormat::Markdown) {
            // GFM is a good Markdown lingua franca for paste-into-CMS.
            cmd.arg("--to").arg("gfm");
        }
        cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());

        let result = timeout(PANDOC_TIMEOUT, cmd.output()).await;
        let output = match result {
            Ok(Ok(out)) => out,
            Ok(Err(err)) => {
                tracing::warn!(?err, "pandoc spawn failed");
                // Most common cause: binary not on PATH. Surface a
                // clean 503 with an actionable message.
                return Err(ApiError::new(
                    ErrorCode::ServiceUnavailable,
                    "pandoc is not installed on the server. Install it (e.g. `winget install pandoc` or `apt install pandoc`) and restart the API.",
                ));
            }
            Err(_) => {
                tracing::warn!("pandoc timed out");
                return Err(ApiError::new(
                    ErrorCode::ServiceUnavailable,
                    "Export timed out. The document may be too large or contain references that pandoc can't resolve.",
                ));
            }
        };

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::warn!(stderr = %stderr, "pandoc exited non-zero");
            // Trim stderr so the message stays reasonable in toast UI.
            let mut snippet = stderr.lines().take(8).collect::<Vec<_>>().join("\n");
            if snippet.is_empty() {
                snippet = format!("pandoc exited with status {}", output.status);
            }
            return Err(ApiError::new(
                ErrorCode::BadRequest,
                format!("pandoc failed:\n{snippet}"),
            ));
        }

        // ---- 7. Read the output back ----
        let meta = fs::metadata(&out_path)
            .await
            .map_err(|err| ApiError::internal(format!("output stat: {err}")))?;
        if meta.len() > MAX_OUTPUT_BYTES {
            return Err(ApiError::new(
                ErrorCode::PayloadTooLarge,
                format!(
                    "Exported file is {} bytes; cap is {}",
                    meta.len(),
                    MAX_OUTPUT_BYTES
                ),
            ));
        }
        let bytes = fs::read(&out_path)
            .await
            .map_err(|err| ApiError::internal(format!("read output: {err}")))?;

        Ok(ExportResult {
            bytes: Bytes::from(bytes),
            filename: format!(
                "{stem}.{ext}",
                stem = sanitise_stem(&main_file),
                ext = format.extension()
            ),
            content_type: format.content_type(),
        })
    }
}

/// Pull every file in `rows` from Supabase Storage to `workdir`, in
/// parallel, creating parent dirs as needed. Stops on the first
/// failure.
async fn materialize_files(
    storage: &SupabaseStorage,
    workdir: &Path,
    rows: &[sqlx::postgres::PgRow],
) -> ApiResult<()> {
    let downloads = rows.iter().map(|row| {
        let path: String = row.get("path");
        let storage_key: String = row.get("storage_key");
        let workdir = workdir.to_path_buf();
        async move {
            let bytes = storage.download(PROJECT_FILES_BUCKET, &storage_key).await?;
            let dest = workdir.join(&path);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .await
                    .map_err(|err| ApiError::internal(format!("mkdir {path}: {err}")))?;
            }
            fs::write(&dest, &bytes)
                .await
                .map_err(|err| ApiError::internal(format!("write {path}: {err}")))?;
            Ok::<(), ApiError>(())
        }
    });
    futures::future::try_join_all(downloads).await?;
    Ok(())
}

fn find_first_with_ext(rows: &[sqlx::postgres::PgRow], ext: &str) -> Option<String> {
    let suffix = format!(".{ext}");
    rows.iter().find_map(|row| {
        let path: String = row.get("path");
        if path.to_ascii_lowercase().ends_with(&suffix) {
            Some(path)
        } else {
            None
        }
    })
}

fn sanitise_stem(main_file: &str) -> String {
    let stem = Path::new(main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("export");
    stem.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

fn internal(err: sqlx::Error) -> ApiError {
    tracing::error!(?err, "database error in exports service");
    ApiError::new(ErrorCode::Internal, "Database error")
}

// Re-export the path type for tests / external users.
#[allow(dead_code)]
pub type Workdir = PathBuf;
