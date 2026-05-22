//! The compile worker loop.
//!
//! Long-running task that:
//!   1. BLPOPs the next job from Redis,
//!   2. Materializes project files to a temp dir,
//!   3. Runs tectonic + parses the log,
//!   4. Uploads PDF/log/synctex artifacts to storage,
//!   5. Updates the `compile_jobs` row with final state,
//!   6. Publishes status/log/completed frames to Redis pub/sub.
//!
//! Multiple instances can run safely against the same Redis (Redis
//! BLPOP is atomic — only one worker pops each job). For concurrency
//! within one process, run several copies of `run_worker` as separate
//! tokio tasks.

use std::path::Path;
use std::sync::Arc;

use bytes::Bytes;
use chrono::Utc;
use scribe_shared::{
    CompileJobId, CompileJobPayload, CompileJobStatus, CompileLogEntry, CompileLogStreamMessage,
    ProjectId,
};
use scribe_storage::{compile_artifact_key, Storage, SupabaseStorage, COMPILE_ARTIFACTS_BUCKET};
use sqlx::{PgPool, Row};
use tokio::fs;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::log_parser;
use crate::queue::CompileQueue;
use crate::tectonic::{run_tectonic, CompileOutcome, TectonicConfig};

/// Long-running options for the worker loop.
pub struct WorkerConfig {
    pub tectonic: TectonicConfig,
    /// Working-directory root. Per-job scratch dirs are created underneath.
    /// Defaults to the OS temp dir.
    pub workdir_root: std::path::PathBuf,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        Self {
            tectonic: TectonicConfig::default(),
            workdir_root: std::env::temp_dir(),
        }
    }
}

#[derive(Clone)]
pub struct Worker {
    pub queue: CompileQueue,
    pub db: PgPool,
    pub storage: Arc<SupabaseStorage>,
    pub config: Arc<WorkerConfig>,
}

impl Worker {
    /// Spawn a tokio task that runs the worker loop until `shutdown`
    /// is notified. Returns the JoinHandle so the caller can await
    /// graceful exit on app shutdown.
    pub fn spawn(self, shutdown: Arc<Notify>) -> JoinHandle<()> {
        tokio::spawn(async move {
            info!("compile worker started");
            loop {
                tokio::select! {
                    _ = shutdown.notified() => {
                        info!("compile worker shutting down");
                        break;
                    }
                    job = self.queue.dequeue(5.0) => match job {
                        Ok(Some(payload)) => {
                            if let Err(err) = self.run_job(payload).await {
                                error!(?err, "compile job crashed");
                            }
                        }
                        Ok(None) => {} // timeout; loop back to check shutdown
                        Err(err) => {
                            warn!(?err, "redis dequeue error; backing off");
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        }
                    }
                }
            }
        })
    }

    async fn run_job(&self, payload: CompileJobPayload) -> anyhow::Result<()> {
        let job_id = payload.compile_job_id;
        info!(%job_id, project = %payload.project_id, "compile job started");

        // Transition queued → running.
        self.update_status(job_id, CompileJobStatus::Running, true).await?;
        self.publish(job_id, &CompileLogStreamMessage::Status {
            status: CompileJobStatus::Running,
        }).await;

        let workdir = match self.create_workdir(job_id).await {
            Ok(p) => p,
            Err(err) => {
                self.finish_error(job_id, format!("workdir: {err}"), 0).await?;
                return Ok(());
            }
        };

        let outcome = self.materialize_and_run(&payload, &workdir).await;

        // Best-effort cleanup. We don't fail the job on cleanup errors.
        let _ = fs::remove_dir_all(&workdir).await;

        match outcome {
            Ok((compile, entries, artifacts)) => {
                let status = if compile.success {
                    CompileJobStatus::Success
                } else {
                    CompileJobStatus::Error
                };
                let error_message = if !compile.success {
                    Some(
                        entries
                            .iter()
                            .find(|e| matches!(e.level, scribe_shared::CompileLogLevel::Error))
                            .map(|e| e.message.clone())
                            .unwrap_or_else(|| {
                                format!("tectonic exited with code {}", compile.exit_code)
                            }),
                    )
                } else {
                    None
                };
                self.finish_success(
                    job_id,
                    status,
                    compile.exit_code,
                    artifacts,
                    entries,
                    compile.duration.as_millis() as i32,
                    error_message,
                )
                .await?;
            }
            Err(err) => {
                self.finish_error(job_id, err.to_string(), 0).await?;
            }
        }
        Ok(())
    }

    async fn create_workdir(&self, job_id: CompileJobId) -> std::io::Result<std::path::PathBuf> {
        let dir = self
            .config
            .workdir_root
            .join(format!("scribe-compile-{}", job_id));
        fs::create_dir_all(&dir).await?;
        Ok(dir)
    }

    /// Download all project files into `workdir`, run tectonic, upload
    /// artifacts. Returns the compile outcome + parsed entries +
    /// uploaded artifact keys. Errors at any step bubble up; the caller
    /// transitions the job to `error` with the message.
    async fn materialize_and_run(
        &self,
        payload: &CompileJobPayload,
        workdir: &Path,
    ) -> anyhow::Result<(CompileOutcome, Vec<CompileLogEntry>, Artifacts)> {
        // ---- materialize files ----
        let files = self.list_project_files(payload.project_id).await?;
        for (path, storage_key) in &files {
            let bytes = self
                .storage
                .download(scribe_storage::PROJECT_FILES_BUCKET, storage_key)
                .await
                .map_err(|err| anyhow::anyhow!("download {path}: {err}"))?;
            let dest = workdir.join(path);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::write(&dest, &bytes).await?;
        }

        // ---- run tectonic ----
        let outcome = run_tectonic(&self.config.tectonic, workdir, &payload.main_file).await;
        let combined = format!("{}\n{}", outcome.stdout, outcome.stderr);
        let entries = log_parser::parse(&combined);

        // Stream entries to subscribers as we go (mirrors the Node worker).
        for entry in &entries {
            self.publish(
                payload.compile_job_id,
                &CompileLogStreamMessage::Log { entry: entry.clone() },
            )
            .await;
        }

        // ---- upload artifacts ----
        let base_name = payload
            .main_file
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(&payload.main_file);
        let artifacts = self
            .upload_artifacts(payload.project_id, payload.compile_job_id, workdir, base_name, &combined)
            .await;

        Ok((outcome, entries, artifacts))
    }

    async fn list_project_files(
        &self,
        project: ProjectId,
    ) -> anyhow::Result<Vec<(String, String)>> {
        let rows = sqlx::query(
            "select path, storage_key from public.project_files where project_id = $1",
        )
        .bind(project.into_inner())
        .fetch_all(&self.db)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push((row.get("path"), row.get("storage_key")));
        }
        Ok(out)
    }

    async fn upload_artifacts(
        &self,
        project: ProjectId,
        job_id: CompileJobId,
        workdir: &Path,
        base_name: &str,
        combined_log: &str,
    ) -> Artifacts {
        let mut artifacts = Artifacts::default();

        if let Ok(pdf) = fs::read(workdir.join(format!("{base_name}.pdf"))).await {
            let key = compile_artifact_key(project, &job_id.to_string(), "output.pdf");
            if self
                .storage
                .upload(COMPILE_ARTIFACTS_BUCKET, &key, Bytes::from(pdf), "application/pdf")
                .await
                .is_ok()
            {
                artifacts.pdf_key = Some(key);
            }
        }

        // Prefer tectonic's `.log` artifact; fall back to captured stdout+stderr.
        let log_bytes = fs::read(workdir.join(format!("{base_name}.log")))
            .await
            .ok()
            .unwrap_or_else(|| combined_log.as_bytes().to_vec());
        if !log_bytes.is_empty() {
            let key = compile_artifact_key(project, &job_id.to_string(), "compile.log");
            if self
                .storage
                .upload(
                    COMPILE_ARTIFACTS_BUCKET,
                    &key,
                    Bytes::from(log_bytes),
                    "text/plain; charset=utf-8",
                )
                .await
                .is_ok()
            {
                artifacts.log_key = Some(key);
            }
        }

        if let Ok(synctex) = fs::read(workdir.join(format!("{base_name}.synctex.gz"))).await {
            let key = compile_artifact_key(project, &job_id.to_string(), "main.synctex.gz");
            if self
                .storage
                .upload(
                    COMPILE_ARTIFACTS_BUCKET,
                    &key,
                    Bytes::from(synctex),
                    "application/gzip",
                )
                .await
                .is_ok()
            {
                artifacts.synctex_key = Some(key);
            }
        }

        artifacts
    }

    async fn update_status(
        &self,
        job_id: CompileJobId,
        status: CompileJobStatus,
        also_started_at: bool,
    ) -> anyhow::Result<()> {
        sqlx::query(
            r#"
            update public.compile_jobs
            set status = $2,
                started_at = case when $3::boolean and started_at is null then now() else started_at end
            where id = $1
            "#,
        )
        .bind(job_id.into_inner())
        .bind(status.as_str())
        .bind(also_started_at)
        .execute(&self.db)
        .await?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn finish_success(
        &self,
        job_id: CompileJobId,
        status: CompileJobStatus,
        exit_code: i32,
        artifacts: Artifacts,
        entries: Vec<CompileLogEntry>,
        duration_ms: i32,
        error_message: Option<String>,
    ) -> anyhow::Result<()> {
        let entries_json = serde_json::to_value(&entries)?;
        sqlx::query(
            r#"
            update public.compile_jobs
            set status = $2, exit_code = $3,
                pdf_key = $4, log_key = $5, synctex_key = $6,
                error_message = $7, entries = $8,
                duration_ms = $9, completed_at = $10
            where id = $1
            "#,
        )
        .bind(job_id.into_inner())
        .bind(status.as_str())
        .bind(exit_code)
        .bind(&artifacts.pdf_key)
        .bind(&artifacts.log_key)
        .bind(&artifacts.synctex_key)
        .bind(&error_message)
        .bind(entries_json)
        .bind(duration_ms)
        .bind(Utc::now())
        .execute(&self.db)
        .await?;

        self.publish(
            job_id,
            &CompileLogStreamMessage::Completed {
                status,
                pdf_key: artifacts.pdf_key,
                log_key: artifacts.log_key,
                synctex_key: artifacts.synctex_key,
                duration_ms: Some(duration_ms),
                error_message,
            },
        )
        .await;
        info!(%job_id, ?status, duration_ms, "compile job done");
        Ok(())
    }

    async fn finish_error(
        &self,
        job_id: CompileJobId,
        message: String,
        duration_ms: i32,
    ) -> anyhow::Result<()> {
        sqlx::query(
            r#"
            update public.compile_jobs
            set status = 'error', error_message = $2, duration_ms = $3, completed_at = $4
            where id = $1
            "#,
        )
        .bind(job_id.into_inner())
        .bind(&message)
        .bind(duration_ms)
        .bind(Utc::now())
        .execute(&self.db)
        .await?;
        self.publish(
            job_id,
            &CompileLogStreamMessage::Completed {
                status: CompileJobStatus::Error,
                pdf_key: None,
                log_key: None,
                synctex_key: None,
                duration_ms: Some(duration_ms),
                error_message: Some(message),
            },
        )
        .await;
        Ok(())
    }

    async fn publish(&self, job_id: CompileJobId, msg: &CompileLogStreamMessage) {
        if let Err(err) = self.queue.publish_log(job_id, msg).await {
            warn!(?err, %job_id, "publish_log failed");
        }
    }
}

#[derive(Default)]
struct Artifacts {
    pdf_key: Option<String>,
    log_key: Option<String>,
    synctex_key: Option<String>,
}

// Tiny safety net so a misuse like `Uuid::nil()` for a job ID is at
// least visible. Not exposed; just a debug assertion in dev.
#[allow(dead_code)]
fn _assert_job_id_visible(id: CompileJobId) {
    debug_assert_ne!(id.into_inner(), Uuid::nil());
}
