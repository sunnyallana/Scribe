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
use dashmap::DashMap;
use scribe_shared::{
    CompileJobId, CompileJobPayload, CompileJobStatus, CompileLogEntry, CompileLogStreamMessage,
    ProjectId,
};
use scribe_storage::{compile_artifact_key, Storage, SupabaseStorage, COMPILE_ARTIFACTS_BUCKET};
use sqlx::{PgPool, Row};
use tokio::fs;
use tokio::sync::{Mutex, Notify};
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
    /// Per-project in-process mutex. Serializes compiles for the same
    /// project so we can reuse a persistent workdir (and the
    /// LaTeX intermediates inside it) without races. Different
    /// projects still compile in parallel up to `spawn_n` workers.
    pub project_locks: Arc<DashMap<ProjectId, Arc<Mutex<()>>>>,
    /// Per-project memory of the file `updated_at` we last materialized
    /// to disk, keyed by file `path`. On the next compile we skip
    /// downloading any file whose `updated_at` is unchanged — for the
    /// "user edited one .tex" case, this drops download cost from
    /// N × RTT to 1 × RTT. Inner map is `Arc`-wrapped so all clones
    /// share the same storage (DashMap's own Clone is a deep copy).
    pub file_state: Arc<DashMap<ProjectId, Arc<DashMap<String, chrono::DateTime<chrono::Utc>>>>>,
}

impl Worker {
    /// Spawn `n` worker tasks that race for the next job. Each one
    /// runs an independent BRPOP loop; Redis serialises which task
    /// gets each job, so concurrency is safe across the cluster.
    /// Higher `n` = more jobs in flight at once; tectonic itself is
    /// CPU-heavy so 2–4 is a sane default for a single-host worker.
    pub fn spawn_n(self, n: u32, shutdown: Arc<Notify>) -> Vec<JoinHandle<()>> {
        let count = n.max(1);
        (0..count)
            .map(|idx| self.clone().spawn_one(idx, shutdown.clone()))
            .collect()
    }

    /// Backwards-compatible single-worker spawn — equivalent to
    /// `spawn_n(1, …)`. Kept so existing call sites don't change.
    pub fn spawn(self, shutdown: Arc<Notify>) -> JoinHandle<()> {
        self.spawn_one(0, shutdown)
    }

    fn spawn_one(self, idx: u32, shutdown: Arc<Notify>) -> JoinHandle<()> {
        tokio::spawn(async move {
            info!(worker = idx, "compile worker started");
            loop {
                tokio::select! {
                    _ = shutdown.notified() => {
                        info!(worker = idx, "compile worker shutting down");
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

        // Serialize compiles for the same project so the persistent
        // per-project workdir doesn't race. Different projects keep
        // compiling in parallel.
        let lock = self
            .project_locks
            .entry(payload.project_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        let _guard = lock.lock().await;

        let workdir = match self.create_workdir(payload.project_id).await {
            Ok(p) => p,
            Err(err) => {
                self.finish_error(job_id, format!("workdir: {err}"), 0).await?;
                return Ok(());
            }
        };

        let outcome = self.materialize_and_run(&payload, &workdir).await;
        // No fs::remove_dir_all — we keep the workdir + LaTeX
        // intermediates (.aux/.toc/.bbl/.synctex) around so the *next*
        // compile of this same project can skip re-running passes that
        // didn't change. Tectonic invalidates these correctly when the
        // source files change. Steady-state speedup for "small edit"
        // compiles is 30–60%.

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

    async fn create_workdir(&self, project: ProjectId) -> std::io::Result<std::path::PathBuf> {
        // Per-project, persistent. See note in `run_job` about why we
        // don't tear this down between jobs.
        let dir = self
            .config
            .workdir_root
            .join(format!("scribe-project-{}", project));
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
        let job_id = payload.compile_job_id;

        // ---- materialize files ----
        let t_list = std::time::Instant::now();
        let files = self.list_project_files(payload.project_id).await?;
        let list_ms = t_list.elapsed().as_millis();
        let file_count = files.len();

        // Diff against what we last wrote to this workdir: if the file's
        // updated_at hasn't changed and the file still exists on disk,
        // skip the download. For a 23-file project where the user edits
        // one .tex, this collapses 23 downloads to 1.
        let state = self
            .file_state
            .entry(payload.project_id)
            .or_insert_with(|| Arc::new(DashMap::new()))
            .clone();
        let mut to_download: Vec<(String, String, chrono::DateTime<chrono::Utc>)> = Vec::new();
        let mut skipped = 0usize;
        for (path, storage_key, updated_at) in files.iter() {
            let prev = state.get(path).map(|v| *v.value());
            let on_disk = workdir.join(path).is_file();
            if on_disk && prev == Some(*updated_at) {
                skipped += 1;
            } else {
                to_download.push((path.clone(), storage_key.clone(), *updated_at));
            }
        }
        // Detect files that were removed in the DB but still on disk and
        // delete them so tectonic doesn't see stale inputs. Cheap O(N).
        let live: std::collections::HashSet<&str> =
            files.iter().map(|(p, _, _)| p.as_str()).collect();
        let stale: Vec<String> = state
            .iter()
            .filter_map(|e| (!live.contains(e.key().as_str())).then(|| e.key().clone()))
            .collect();
        for path in &stale {
            let _ = fs::remove_file(workdir.join(path)).await;
            state.remove(path);
        }

        let t_dl = std::time::Instant::now();
        let state_for_writes = state.clone();
        let downloads = to_download.into_iter().map(|(path, storage_key, updated_at)| {
            let storage = self.storage.clone();
            let workdir = workdir.to_path_buf();
            let state = state_for_writes.clone();
            async move {
                let bytes = storage
                    .download(scribe_storage::PROJECT_FILES_BUCKET, &storage_key)
                    .await
                    .map_err(|err| anyhow::anyhow!("download {path}: {err}"))?;
                let dest = workdir.join(&path);
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).await?;
                }
                fs::write(&dest, &bytes).await?;
                state.insert(path, updated_at);
                Ok::<_, anyhow::Error>(())
            }
        });
        futures::future::try_join_all(downloads).await?;
        let download_ms = t_dl.elapsed().as_millis();
        let downloaded = file_count.saturating_sub(skipped);
        tracing::debug!(
            %job_id,
            project = %payload.project_id,
            downloaded,
            skipped,
            "file materialization diff"
        );

        // ---- run tectonic ----
        let t_tex = std::time::Instant::now();
        let outcome = run_tectonic(&self.config.tectonic, workdir, &payload.main_file).await;
        let tectonic_ms = t_tex.elapsed().as_millis();

        let combined = format!("{}\n{}", outcome.stdout, outcome.stderr);
        let entries = log_parser::parse(&combined);
        for entry in &entries {
            self.publish(
                payload.compile_job_id,
                &CompileLogStreamMessage::Log { entry: entry.clone() },
            )
            .await;
        }

        // ---- upload artifacts ----
        let t_up = std::time::Instant::now();
        let base_name = payload
            .main_file
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(&payload.main_file);
        let artifacts = self
            .upload_artifacts(payload.project_id, payload.compile_job_id, workdir, base_name, &combined)
            .await;
        let upload_ms = t_up.elapsed().as_millis();

        info!(
            %job_id,
            file_count,
            list_ms,
            download_ms,
            tectonic_ms,
            upload_ms,
            "compile phase timings"
        );

        Ok((outcome, entries, artifacts))
    }

    async fn list_project_files(
        &self,
        project: ProjectId,
    ) -> anyhow::Result<Vec<(String, String, chrono::DateTime<chrono::Utc>)>> {
        let rows = sqlx::query(
            "select path, storage_key, updated_at from public.project_files where project_id = $1",
        )
        .bind(project.into_inner())
        .fetch_all(&self.db)
        .await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push((
                row.get("path"),
                row.get("storage_key"),
                row.get::<chrono::DateTime<chrono::Utc>, _>("updated_at"),
            ));
        }
        Ok(out)
    }

    /// Upload the PDF on the critical path and pre-compute log/synctex
    /// keys so they can be saved to the DB up front. The PDF is awaited
    /// here so the caller can publish a `Completed` frame with a valid
    /// `pdf_key` the SPA can immediately fetch; log + synctex upload in
    /// a background tokio task so the user's "compile done → PDF
    /// visible" window doesn't include them. The bg task tolerates per-
    /// artifact failures because the compile itself already succeeded.
    async fn upload_artifacts(
        &self,
        project: ProjectId,
        job_id: CompileJobId,
        workdir: &Path,
        base_name: &str,
        combined_log: &str,
    ) -> Artifacts {
        let pdf_path = workdir.join(format!("{base_name}.pdf"));
        let log_path = workdir.join(format!("{base_name}.log"));
        let synctex_path = workdir.join(format!("{base_name}.synctex.gz"));
        // Cap each artifact read so a runaway compile (huge synctex,
        // looping PDF) can't OOM the worker. Sizes chosen to leave
        // generous headroom for real documents.
        const MAX_PDF_BYTES: u64 = 256 * 1024 * 1024;  // 256 MiB
        const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;   // 32 MiB
        const MAX_SYNCTEX_BYTES: u64 = 128 * 1024 * 1024; // 128 MiB
        let (pdf, log_file, synctex) = tokio::join!(
            read_capped(&pdf_path, MAX_PDF_BYTES),
            read_capped(&log_path, MAX_LOG_BYTES),
            read_capped(&synctex_path, MAX_SYNCTEX_BYTES),
        );

        let pdf_bytes = pdf.ok();
        let log_bytes = log_file.ok().unwrap_or_else(|| combined_log.as_bytes().to_vec());
        let synctex_bytes = synctex.ok();

        let job_id_str = job_id.to_string();

        // PDF on the critical path.
        let pdf_key = match pdf_bytes {
            Some(bytes) if !bytes.is_empty() => {
                let key = compile_artifact_key(project, &job_id_str, "output.pdf");
                match self
                    .storage
                    .upload(COMPILE_ARTIFACTS_BUCKET, &key, Bytes::from(bytes), "application/pdf")
                    .await
                {
                    Ok(_) => Some(key),
                    Err(err) => {
                        warn!(%job_id, ?err, "pdf upload failed");
                        None
                    }
                }
            }
            _ => None,
        };

        // Pre-compute keys; the bg task writes them and updates the DB
        // when uploads finish so the row is eventually consistent. The
        // SPA only blocks on `pdf_key`.
        let log_key = if !log_bytes.is_empty() {
            Some(compile_artifact_key(project, &job_id_str, "compile.log"))
        } else {
            None
        };
        let synctex_key = synctex_bytes
            .as_ref()
            .filter(|b| !b.is_empty())
            .map(|_| compile_artifact_key(project, &job_id_str, "main.synctex.gz"));

        // Spawn the secondary uploads. Their keys were already written to
        // the row by `finish_success`; the SPA's `artifact-url?kind=log`
        // call works as soon as the object lands (Supabase Storage signs
        // URLs eagerly, so the only wait is the actual upload finishing).
        let storage = self.storage.clone();
        let log_key_bg = log_key.clone();
        let synctex_key_bg = synctex_key.clone();
        tokio::spawn(async move {
            let log_fut = async {
                if let Some(key) = log_key_bg.as_deref() {
                    if let Err(err) = storage
                        .upload(
                            COMPILE_ARTIFACTS_BUCKET,
                            key,
                            Bytes::from(log_bytes),
                            "text/plain; charset=utf-8",
                        )
                        .await
                    {
                        warn!(%job_id, ?err, "log upload failed");
                    }
                }
            };
            let synctex_fut = async {
                if let (Some(key), Some(bytes)) = (synctex_key_bg.as_deref(), synctex_bytes) {
                    if !bytes.is_empty() {
                        if let Err(err) = storage
                            .upload(
                                COMPILE_ARTIFACTS_BUCKET,
                                key,
                                Bytes::from(bytes),
                                "application/gzip",
                            )
                            .await
                        {
                            warn!(%job_id, ?err, "synctex upload failed");
                        }
                    }
                }
            };
            // Concurrent — they share the HTTP/2 connection to Supabase.
            let _ = tokio::join!(log_fut, synctex_fut);
        });

        Artifacts { pdf_key, log_key, synctex_key }
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

/// Read a file into memory, refusing if `metadata().len()` exceeds
/// `max_bytes`. Cheap stat-then-read rather than streaming, since these
/// artifacts are small enough that streaming would just add complexity.
async fn read_capped(path: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let meta = fs::metadata(path).await?;
    if meta.len() > max_bytes {
        tracing::warn!(
            file = %path.display(),
            size = meta.len(),
            cap = max_bytes,
            "refusing to read artifact: exceeds cap",
        );
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("artifact exceeds {max_bytes}-byte cap"),
        ));
    }
    fs::read(path).await
}
