//! Compile-job CRUD + enqueueing. Mirrors
//! `server/src/services/compileService.ts`.
//!
//! The actual compile work happens in the `scribe-compile` worker;
//! this service is the producer + reader.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use scribe_compile::CompileQueue;
use scribe_shared::{
    ApiError, ApiResult, CompileJob, CompileJobId, CompileJobPayload, CompileJobStatus,
    CompileLogEntry, CompileLogStreamMessage, CompilerEngine, CreateCompileJobInput, ErrorCode,
    ProjectId, UserId,
};
use sqlx::{PgPool, Row};
use tracing::warn;
use uuid::Uuid;

use crate::services::membership::assert_member;

#[derive(Clone)]
pub struct CompileService {
    pool: PgPool,
    queue: Arc<CompileQueue>,
}

impl CompileService {
    pub fn new(pool: PgPool, queue: Arc<CompileQueue>) -> Self {
        Self { pool, queue }
    }

    pub async fn enqueue(
        &self,
        user: UserId,
        project: ProjectId,
        input: CreateCompileJobInput,
    ) -> ApiResult<CompileJob> {
        assert_member(&self.pool, user, project).await?;

        // Look up the project's compiler + default main_file.
        let proj_row = sqlx::query(
            "select compiler, main_file from public.projects where id = $1",
        )
        .bind(project.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let proj_row = proj_row.ok_or_else(|| ApiError::not_found("Project not found"))?;
        let engine_str: String = proj_row.get("compiler");
        let engine = CompilerEngine::parse(&engine_str).unwrap_or_default();
        let default_main: String = proj_row.get("main_file");
        let main_file = input.main_file.unwrap_or(default_main);

        // Insert the row first so we have a job ID to put on the queue.
        let row = sqlx::query(
            r#"
            insert into public.compile_jobs
                (project_id, triggered_by, status, engine, main_file)
            values ($1, $2, 'queued', $3, $4)
            returning id, project_id, triggered_by, status, engine, main_file,
                      exit_code, pdf_key, log_key, synctex_key, error_message,
                      entries, duration_ms, enqueued_at, started_at, completed_at
            "#,
        )
        .bind(project.into_inner())
        .bind(user.into_inner())
        .bind(engine.as_str())
        .bind(&main_file)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        let job = row_to_job(row);

        // Push onto Redis; if that fails, mark the row errored so the
        // client doesn't see a "queued" job that'll never run.
        let payload = CompileJobPayload {
            compile_job_id: job.id,
            project_id: job.project_id,
            main_file: job.main_file.clone(),
            engine: job.engine,
            triggered_by: job.triggered_by,
        };
        if let Err(err) = self.queue.enqueue(&payload).await {
            warn!(?err, job = %job.id, "failed to enqueue; marking job errored");
            let _ = sqlx::query(
                r#"
                update public.compile_jobs
                set status = 'error', error_message = $2, completed_at = now()
                where id = $1
                "#,
            )
            .bind(job.id.into_inner())
            .bind(format!("enqueue failed: {err}"))
            .execute(&self.pool)
            .await;
            return Err(ApiError::new(
                ErrorCode::ServiceUnavailable,
                "compile queue unavailable",
            ));
        }
        Ok(job)
    }

    pub async fn list(
        &self,
        user: UserId,
        project: ProjectId,
        limit: i64,
    ) -> ApiResult<Vec<CompileJob>> {
        assert_member(&self.pool, user, project).await?;
        let rows = sqlx::query(
            r#"
            select id, project_id, triggered_by, status, engine, main_file,
                   exit_code, pdf_key, log_key, synctex_key, error_message,
                   entries, duration_ms, enqueued_at, started_at, completed_at
            from public.compile_jobs
            where project_id = $1
            order by enqueued_at desc
            limit $2
            "#,
        )
        .bind(project.into_inner())
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        Ok(rows.into_iter().map(row_to_job).collect())
    }

    pub async fn get(&self, user: UserId, job_id: CompileJobId) -> ApiResult<CompileJob> {
        // Get the row first to learn the project_id, then auth-check it.
        // (Saves a join in the common path while still gating access.)
        let row = sqlx::query(
            r#"
            select id, project_id, triggered_by, status, engine, main_file,
                   exit_code, pdf_key, log_key, synctex_key, error_message,
                   entries, duration_ms, enqueued_at, started_at, completed_at
            from public.compile_jobs
            where id = $1
            "#,
        )
        .bind(job_id.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let row = row.ok_or_else(|| ApiError::not_found("Compile job not found"))?;
        let job = row_to_job(row);
        assert_member(&self.pool, user, job.project_id).await?;
        Ok(job)
    }

    /// Build the historical-events list for a finished (or running)
    /// job. Used by the WebSocket replay step before live tailing begins.
    pub async fn replay_messages(
        &self,
        user: UserId,
        job_id: CompileJobId,
    ) -> ApiResult<Vec<CompileLogStreamMessage>> {
        let job = self.get(user, job_id).await?;
        let mut out: Vec<CompileLogStreamMessage> = Vec::new();
        out.push(CompileLogStreamMessage::Status { status: job.status });
        if let Some(entries) = &job.entries {
            for entry in entries {
                out.push(CompileLogStreamMessage::Log { entry: entry.clone() });
            }
        }
        if job.status.is_terminal() {
            out.push(CompileLogStreamMessage::Completed {
                status: job.status,
                pdf_key: job.pdf_key.clone(),
                log_key: job.log_key.clone(),
                synctex_key: job.synctex_key.clone(),
                duration_ms: job.duration_ms,
                error_message: job.error_message.clone(),
            });
        }
        Ok(out)
    }
}

fn row_to_job(row: sqlx::postgres::PgRow) -> CompileJob {
    let status_str: String = row.get("status");
    let engine_str: String = row.get("engine");
    let entries: Option<serde_json::Value> = row.get("entries");
    let entries_parsed: Option<Vec<CompileLogEntry>> = entries
        .and_then(|v| serde_json::from_value(v).ok());
    CompileJob {
        id: CompileJobId::new(row.get::<Uuid, _>("id")),
        project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
        triggered_by: row.get::<Option<Uuid>, _>("triggered_by").map(UserId::new),
        status: CompileJobStatus::parse(&status_str).unwrap_or(CompileJobStatus::Error),
        engine: CompilerEngine::parse(&engine_str).unwrap_or_default(),
        main_file: row.get("main_file"),
        exit_code: row.get("exit_code"),
        pdf_key: row.get("pdf_key"),
        log_key: row.get("log_key"),
        synctex_key: row.get("synctex_key"),
        error_message: row.get("error_message"),
        entries: entries_parsed,
        duration_ms: row.get("duration_ms"),
        enqueued_at: row.get::<DateTime<Utc>, _>("enqueued_at"),
        started_at: row.get::<Option<DateTime<Utc>>, _>("started_at"),
        completed_at: row.get::<Option<DateTime<Utc>>, _>("completed_at"),
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("db: {err}"))
}
