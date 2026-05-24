//! Local LaTeX compile pipeline.
//!
//! Mirrors the server-side `scribe-compile` runner but without
//! Redis/Postgres: spawns `tectonic` / `latexmk` / `pdflatex` in a
//! working directory, streams every stdout / stderr line to the
//! webview as `compile:log` events, and emits `compile:completed`
//! with the exit code + duration on terminal transitions.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;
use uuid::Uuid;

use crate::db::Db;

/// Concrete LaTeX engine. Mirrors `EngineKind` from the server-side
/// `scribe-compile` crate plus single-shot pdflatex/xelatex/lualatex.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Tectonic,
    Latexmk,
    Pdflatex,
    Xelatex,
    Lualatex,
}

impl Engine {
    fn binary(self) -> &'static str {
        match self {
            Engine::Tectonic => "tectonic",
            Engine::Latexmk => "latexmk",
            Engine::Pdflatex => "pdflatex",
            Engine::Xelatex => "xelatex",
            Engine::Lualatex => "lualatex",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompileRequest {
    /// Absolute path of the working directory containing the project files.
    pub workdir: String,
    /// Name of the main .tex file, relative to workdir.
    pub main_file: String,
    /// None = autodetect (tectonic → latexmk → pdflatex).
    pub engine: Option<Engine>,
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

fn default_timeout_secs() -> u64 {
    120
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileJobInfo {
    pub job_id: String,
    pub engine: Engine,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileLogPayload {
    pub job_id: String,
    pub line: String,
    pub stream: LogStream,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileStatusPayload {
    pub job_id: String,
    pub status: CompileStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileCompletedPayload {
    pub job_id: String,
    pub status: CompileStatus,
    pub exit_code: i32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompileStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

#[derive(Debug, thiserror::Error)]
pub enum CompileError {
    #[error("engine `{0}` not found in PATH; install tectonic or a TeX distribution")]
    EngineNotFound(String),
    #[error("workdir `{0}` is not a directory")]
    BadWorkdir(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unknown job id: {0}")]
    UnknownJob(String),
}

impl serde::Serialize for CompileError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

type JobSlot = Arc<Mutex<Option<Child>>>;

#[derive(Default)]
pub struct CompileRegistry {
    jobs: DashMap<String, JobSlot>,
}

impl CompileRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

fn resolve_engine(
    app: &AppHandle,
    requested: Option<Engine>,
) -> Result<(Engine, PathBuf), CompileError> {
    if let Some(e) = requested {
        let path = locate_binary(app, e)
            .ok_or_else(|| CompileError::EngineNotFound(e.binary().to_string()))?;
        return Ok((e, path));
    }
    // Auto-pick preference: latexmk → pdflatex → tectonic.
    //   * `latexmk` first because it orchestrates pdflatex through
    //     the multi-pass loop that resolves `\cite{}` and `\ref{}`;
    //     this is the "core" engine when MiKTeX or TeX Live is on
    //     the machine (which the installer arranges via its NSIS
    //     post-install hook).
    //   * `pdflatex` as a fallback if MiKTeX exists without latexmk.
    //   * `tectonic` as the final fallback — works without a TeX
    //     distribution at all, but tends to be slower on first run
    //     because it fetches CTAN packages over the network.
    for candidate in [Engine::Latexmk, Engine::Pdflatex, Engine::Tectonic] {
        if let Some(path) = locate_binary(app, candidate) {
            return Ok((candidate, path));
        }
    }
    Err(CompileError::EngineNotFound(
        "tectonic/latexmk/pdflatex".into(),
    ))
}

/// Find a LaTeX-engine binary on disk. Order:
///   1. The Tauri bundle's `resource_dir` — what the production
///      installer drops alongside the app exe. Matters most: a
///      fresh-machine install through the NSIS / MSI bundle ships
///      with tectonic next to the binary, so we don't depend on the
///      user running `setup.ps1` separately.
///   2. `which::which(name)` — anything on PATH wins next.
///   3. Engine-specific environment overrides (TECTONIC_BIN etc.) —
///      mirrors what the server uses so users who set these already
///      get them honoured in the desktop shell too.
///   4. Well-known install locations under the user profile (the
///      `setup.ps1` script drops tectonic into `~/scribe-tools/
///      tectonic-<ver>/` without touching PATH — for dev installs).
fn locate_binary(app: &AppHandle, engine: Engine) -> Option<PathBuf> {
    let name = engine.binary();
    if matches!(engine, Engine::Tectonic) {
        if let Some(p) = locate_in_resource_dir(app) {
            return Some(p);
        }
    }
    // Special case: MiKTeX's `latexmk.exe` is a thin wrapper that
    // shells out to a Perl interpreter. Without Perl on PATH the
    // binary exists but every invocation fails with "MiKTeX could
    // not find the script engine 'perl'". Treat it as unavailable so
    // the picker falls through to pdflatex / tectonic instead of
    // returning a binary that's guaranteed to fail at compile time.
    if matches!(engine, Engine::Latexmk) && which::which("perl").is_err() {
        tracing::info!("latexmk found but no perl on PATH — skipping (MiKTeX's latexmk needs Perl)");
        return None;
    }
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    let env_var = match engine {
        Engine::Tectonic => Some("TECTONIC_BIN"),
        Engine::Latexmk => Some("LATEXMK_BIN"),
        _ => None,
    };
    if let Some(var) = env_var {
        if let Ok(path) = std::env::var(var) {
            let p = PathBuf::from(path);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if matches!(engine, Engine::Tectonic) {
        if let Some(p) = locate_tectonic_in_scribe_tools() {
            return Some(p);
        }
    }
    None
}

fn locate_in_resource_dir(app: &AppHandle) -> Option<PathBuf> {
    let exe_name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
    let resource = app.path().resource_dir().ok()?;
    // Tauri's bundle preserves the `resources/<file>` sub-path from
    // the manifest, so the on-disk layout after install is
    // `<resource_dir>/resources/tectonic.exe`.
    let nested = resource.join("resources").join(exe_name);
    if nested.is_file() {
        return Some(nested);
    }
    // Some platforms flatten resources next to the binary — try that too.
    let flat = resource.join(exe_name);
    if flat.is_file() {
        return Some(flat);
    }
    None
}

fn locate_tectonic_in_scribe_tools() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()?;
    let tools = Path::new(&home).join("scribe-tools");
    if !tools.is_dir() {
        return None;
    }
    let exe_name = if cfg!(windows) { "tectonic.exe" } else { "tectonic" };
    let entries = std::fs::read_dir(&tools).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(name) = dir.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !name.starts_with("tectonic-") {
            continue;
        }
        let bin = dir.join(exe_name);
        if bin.is_file() {
            return Some(bin);
        }
    }
    None
}

fn build_command(engine: Engine, binary: &Path, workdir: &Path, main_file: &str) -> Command {
    let mut cmd = Command::new(binary);
    cmd.current_dir(workdir);
    match engine {
        Engine::Tectonic => {
            cmd.arg("--synctex")
                .arg("--keep-logs")
                .arg("--outdir")
                .arg(workdir.as_os_str())
                .arg(main_file);
        }
        Engine::Latexmk => {
            cmd.arg("-pdf")
                .arg("-synctex=1")
                .arg("-interaction=nonstopmode")
                .arg("-halt-on-error")
                .arg(main_file);
        }
        Engine::Pdflatex | Engine::Xelatex | Engine::Lualatex => {
            cmd.arg("-synctex=1")
                .arg("-interaction=nonstopmode")
                .arg("-halt-on-error")
                .arg(main_file);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd
}

#[tauri::command]
pub async fn start_compile(
    app: AppHandle,
    registry: State<'_, Arc<CompileRegistry>>,
    req: CompileRequest,
) -> Result<CompileJobInfo, CompileError> {
    let workdir = PathBuf::from(&req.workdir);
    if !workdir.is_dir() {
        return Err(CompileError::BadWorkdir(req.workdir.clone()));
    }
    let (engine, binary) = resolve_engine(&app, req.engine)?;
    let job_id = Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now();
    tracing::info!(?engine, binary=%binary.display(), workdir=%workdir.display(), main=%req.main_file, "starting compile");

    let mut cmd = build_command(engine, &binary, &workdir, &req.main_file);
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let child_slot: JobSlot = Arc::new(Mutex::new(Some(child)));
    registry.jobs.insert(job_id.clone(), child_slot.clone());

    let _ = app.emit(
        "compile:status",
        CompileStatusPayload {
            job_id: job_id.clone(),
            status: CompileStatus::Running,
        },
    );

    let job_id_for_task = job_id.clone();
    let app_for_task = app.clone();
    let registry_clone = registry.inner().clone();
    let timeout_duration = Duration::from_secs(req.timeout_secs);
    let started_instant = Instant::now();

    tokio::spawn(async move {
        let stdout_task = {
            let app = app_for_task.clone();
            let job_id = job_id_for_task.clone();
            tokio::spawn(async move {
                if let Some(stdout) = stdout {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        let _ = app.emit(
                            "compile:log",
                            CompileLogPayload {
                                job_id: job_id.clone(),
                                line,
                                stream: LogStream::Stdout,
                            },
                        );
                    }
                }
            })
        };
        let stderr_task = {
            let app = app_for_task.clone();
            let job_id = job_id_for_task.clone();
            tokio::spawn(async move {
                if let Some(stderr) = stderr {
                    let mut reader = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        let _ = app.emit(
                            "compile:log",
                            CompileLogPayload {
                                job_id: job_id.clone(),
                                line,
                                stream: LogStream::Stderr,
                            },
                        );
                    }
                }
            })
        };

        let wait_result = timeout(timeout_duration, async {
            let mut slot = child_slot.lock().await;
            match slot.as_mut() {
                Some(child) => child.wait().await,
                None => Err(std::io::Error::other("cancelled before wait")),
            }
        })
        .await;

        // Detach the streams; if cancel happened mid-stream the
        // readers terminate naturally on EOF.
        let _ = stdout_task.await;
        let _ = stderr_task.await;

        let duration_ms = u64::try_from(started_instant.elapsed().as_millis()).unwrap_or(u64::MAX);
        let (status, exit_code) = match wait_result {
            Ok(Ok(exit_status)) => {
                if exit_status.success() {
                    (CompileStatus::Completed, exit_status.code().unwrap_or(0))
                } else {
                    (CompileStatus::Failed, exit_status.code().unwrap_or(-1))
                }
            }
            Ok(Err(_)) => (CompileStatus::Cancelled, -1),
            Err(_) => (CompileStatus::TimedOut, -1),
        };

        registry_clone.jobs.remove(&job_id_for_task);
        let _ = app_for_task.emit(
            "compile:completed",
            CompileCompletedPayload {
                job_id: job_id_for_task,
                status,
                exit_code,
                duration_ms,
            },
        );
    });

    Ok(CompileJobInfo {
        job_id,
        engine,
        started_at,
    })
}

#[tauri::command]
pub async fn cancel_compile(
    registry: State<'_, Arc<CompileRegistry>>,
    job_id: String,
) -> Result<(), CompileError> {
    let (_, slot) = registry
        .jobs
        .remove(&job_id)
        .ok_or_else(|| CompileError::UnknownJob(job_id.clone()))?;
    let mut guard = slot.lock().await;
    if let Some(mut child) = guard.take() {
        let _ = child.kill().await;
    }
    Ok(())
}

// ---- Workdir materialisation ----------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum WorkdirError {
    #[error("path: {0}")]
    Path(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] sqlx::Error),
    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("not found: file {0} (project {1})")]
    Missing(String, String),
    #[error("read failed: {0}")]
    ReadFailed(String),
}

impl serde::Serialize for WorkdirError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkdirInfo {
    /// Absolute path of the staging directory.
    pub workdir: String,
    /// Files actually written, useful for the UI's "synced N files" line.
    pub files_written: u32,
}

/// Materialise the project's `project_files` rows into a real
/// directory on disk so the local LaTeX engine can read them. The
/// JS-side compile flow calls this right before `start_compile`.
///
/// `overrides` lets the editor swap a file's content for the current
/// in-memory Y.Doc text without round-tripping through the server +
/// SQLite mirror — typical use is `{ "main.tex": currentBuffer }`
/// when the user hits Compile mid-edit.
#[tauri::command]
pub async fn compile_prepare_workdir(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    project_id: String,
    #[allow(non_snake_case)]
    overrides: Option<HashMap<String, String>>,
    #[allow(non_snake_case)]
    binary_overrides: Option<HashMap<String, String>>,
) -> Result<WorkdirInfo, WorkdirError> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| WorkdirError::Path(format!("app_local_data_dir: {e}")))?;
    let workdir = data_dir.join("workdirs").join(&project_id);

    // Clean → recreate. Compiles are isolated; we don't keep stale
    // artefacts from previous runs (they'd shadow current `.bib` /
    // image edits and produce confusing errors).
    if workdir.exists() {
        std::fs::remove_dir_all(&workdir)?;
    }
    std::fs::create_dir_all(&workdir)?;

    // Pull every non-folder row. Image / binary content isn't stored
    // in SQLite (the `content` column is TEXT-only); a follow-up pass
    // will need to fetch those from Supabase Storage and stash them
    // in the workdir too, but for the MVP we ship text files only.
    let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT path, content, type FROM project_files WHERE project_id = ?1 ORDER BY path",
    )
    .bind(&project_id)
    .fetch_all(db.pool())
    .await?;

    let overrides = overrides.unwrap_or_default();
    let mut written = 0u32;
    for (path, content, _kind) in &rows {
        let body = overrides
            .get(path.as_str())
            .cloned()
            .or_else(|| content.clone());
        let Some(body) = body else { continue };
        let abs = workdir.join(path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&abs, body)?;
        written += 1;
    }
    // Apply any overrides that don't correspond to an existing row —
    // happens when the editor has a brand-new file open that hasn't
    // synced to SQLite yet.
    let known: std::collections::HashSet<&str> = rows.iter().map(|(p, _, _)| p.as_str()).collect();
    for (path, body) in &overrides {
        if known.contains(path.as_str()) {
            continue;
        }
        let abs = workdir.join(path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&abs, body)?;
        written += 1;
    }

    // Binary overrides — base64-encoded bytes that the JS fetched
    // from Supabase Storage (images, PDFs referenced via
    // `\includegraphics`). Decoded once per compile; no SQLite row
    // is needed because binary content isn't mirrored locally yet.
    for (path, b64) in &binary_overrides.unwrap_or_default() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| WorkdirError::ReadFailed(format!("base64 decode {path}: {e}")))?;
        let abs = workdir.join(path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&abs, &bytes)?;
        written += 1;
    }

    Ok(WorkdirInfo {
        workdir: workdir.to_string_lossy().into_owned(),
        files_written: written,
    })
}

/// Returns the PDF emitted by the most recent compile as a
/// base64-encoded string. The web layer wraps it in a `data:` URL
/// and hands it to the existing pdf.js preview. Avoids registering
/// the Tauri asset-protocol for now — we trade one extra megabyte of
/// base64 overhead for not having to widen the security surface.
#[tauri::command]
pub async fn compile_read_pdf_base64(
    workdir: String,
    main_file: String,
) -> Result<String, WorkdirError> {
    let main_path = Path::new(&main_file);
    let stem = main_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| WorkdirError::Path(format!("invalid main_file: {main_file}")))?;
    let pdf_path = Path::new(&workdir).join(format!("{stem}.pdf"));
    if !pdf_path.exists() {
        return Err(WorkdirError::Missing(
            pdf_path.to_string_lossy().into_owned(),
            workdir,
        ));
    }
    let bytes = std::fs::read(&pdf_path)
        .map_err(|e| WorkdirError::ReadFailed(format!("read pdf: {e}")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Restore the last-compiled PDF for a project, if one exists on
/// disk from a prior session. Returns `None` when the workdir or PDF
/// is missing so the SPA can silently show the empty state instead
/// of treating a fresh project mount as an error.
#[tauri::command]
pub async fn compile_load_existing_pdf(
    app: AppHandle,
    project_id: String,
    main_file: Option<String>,
) -> Result<Option<String>, WorkdirError> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| WorkdirError::Path(format!("app_local_data_dir: {e}")))?;
    let workdir = data_dir.join("workdirs").join(&project_id);
    if !workdir.is_dir() {
        return Ok(None);
    }
    // Default to `main.tex` so a project with no explicit `mainFile`
    // metadata still recovers a PDF named after the conventional file.
    let main = main_file.unwrap_or_else(|| "main.tex".to_string());
    let stem = Path::new(&main)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| WorkdirError::Path(format!("invalid main_file: {main}")))?;
    let pdf_path = workdir.join(format!("{stem}.pdf"));
    if !pdf_path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&pdf_path)
        .map_err(|e| WorkdirError::ReadFailed(format!("read pdf: {e}")))?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(&bytes),
    ))
}

/// Read the .synctex.gz emitted by the local LaTeX engine and return
/// it as base64 so the web side's existing client-side parser (which
/// already knows how to gunzip + parse the server-fetched version)
/// can take over without modification. `None` when the file is
/// missing (common right after a compile failure).
#[tauri::command]
pub async fn compile_load_synctex(
    workdir: String,
    main_file: String,
) -> Result<Option<String>, WorkdirError> {
    let stem = Path::new(&main_file)
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| WorkdirError::Path(format!("invalid main_file: {main_file}")))?;
    let synctex_path = Path::new(&workdir).join(format!("{stem}.synctex.gz"));
    if !synctex_path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&synctex_path)
        .map_err(|e| WorkdirError::ReadFailed(format!("read synctex: {e}")))?;
    Ok(Some(
        base64::engine::general_purpose::STANDARD.encode(&bytes),
    ))
}
