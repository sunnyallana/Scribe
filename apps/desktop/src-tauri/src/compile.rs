//! Local LaTeX compile pipeline.
//!
//! Mirrors the server-side `scribe-compile` runner but without
//! Redis/Postgres: spawns `tectonic` / `latexmk` / `pdflatex` in a
//! working directory, streams every stdout / stderr line to the
//! webview as `compile:log` events, and emits `compile:completed`
//! with the exit code + duration on terminal transitions.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;
use uuid::Uuid;

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

fn pick_engine(requested: Option<Engine>) -> Result<Engine, CompileError> {
    if let Some(e) = requested {
        return which::which(e.binary())
            .map(|_| e)
            .map_err(|_| CompileError::EngineNotFound(e.binary().to_string()));
    }
    // Auto-pick: tectonic > latexmk > pdflatex. Matches the server's
    // default-engine preference order from `scribe-compile::engine`.
    for candidate in [Engine::Tectonic, Engine::Latexmk, Engine::Pdflatex] {
        if which::which(candidate.binary()).is_ok() {
            return Ok(candidate);
        }
    }
    Err(CompileError::EngineNotFound(
        "tectonic/latexmk/pdflatex".into(),
    ))
}

fn build_command(engine: Engine, workdir: &Path, main_file: &str) -> Command {
    let mut cmd = Command::new(engine.binary());
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
    let engine = pick_engine(req.engine)?;
    let job_id = Uuid::new_v4().to_string();
    let started_at = chrono::Utc::now();

    let mut cmd = build_command(engine, &workdir, &req.main_file);
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
