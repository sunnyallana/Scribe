//! Project version snapshots. Mirrors
//! `server/src/services/versionService.ts`.
//!
//! Two storage buckets are involved:
//!   * `project-files` — read from when building a snapshot; written to
//!     when restoring an old version.
//!   * `version-snapshots` — where the JSON payload (all `.tex`/`.bib`
//!     contents) lives keyed by `{project_id}/{version_id}.json`.

use std::sync::Arc;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use scribe_shared::{
    ApiError, ApiResult, CreateVersionInput, ErrorCode, ProjectId, ProjectVersion, UserId,
    VersionFile, VersionId, VersionPayload,
};
use scribe_storage::{
    Storage, SupabaseStorage, PROJECT_FILES_BUCKET, VERSION_SNAPSHOTS_BUCKET,
};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::membership::{assert_member, assert_owner};

#[derive(Clone)]
pub struct VersionService {
    pool: PgPool,
    storage: Arc<SupabaseStorage>,
}

impl VersionService {
    pub fn new(pool: PgPool, storage: Arc<SupabaseStorage>) -> Self {
        Self { pool, storage }
    }

    pub async fn list(
        &self,
        user: UserId,
        project: ProjectId,
    ) -> ApiResult<Vec<ProjectVersion>> {
        assert_member(&self.pool, user, project).await?;
        let rows = sqlx::query(
            r#"
            select v.id, v.project_id, v.created_by, v.label,
                   v.file_count, v.total_bytes, v.created_at,
                   u.display_name as author_display_name
            from public.project_versions v
            left join public.users u on u.id = v.created_by
            where v.project_id = $1
            order by v.created_at desc
            limit 100
            "#,
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        Ok(rows.into_iter().map(row_to_version).collect())
    }

    pub async fn snapshot(
        &self,
        user: UserId,
        project: ProjectId,
        input: CreateVersionInput,
    ) -> ApiResult<ProjectVersion> {
        assert_member(&self.pool, user, project).await?;

        // Fetch all text-ish files (mirrors Node: tex + bib only).
        let file_rows = sqlx::query(
            r#"
            select path, storage_key
            from public.project_files
            where project_id = $1 and type in ('tex', 'bib')
            "#,
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;

        let mut files: Vec<VersionFile> = Vec::with_capacity(file_rows.len());
        let mut total_bytes: i64 = 0;
        for row in file_rows {
            let path: String = row.get("path");
            let storage_key: String = row.get("storage_key");
            let bytes = self.storage.download(PROJECT_FILES_BUCKET, &storage_key).await?;
            let content = String::from_utf8(bytes.to_vec())
                .map_err(|err| ApiError::internal(format!("utf-8: {err}")))?;
            total_bytes += content.len() as i64;
            files.push(VersionFile { path, content });
        }

        let version_id = VersionId::new(Uuid::new_v4());
        let storage_key = format!("{}/{}.json", project, version_id);
        let payload = VersionPayload { version: 1, files };
        let body = serde_json::to_vec(&payload)
            .map_err(|err| ApiError::internal(format!("json encode: {err}")))?;
        let file_count = payload.files.len() as i32;

        self.storage
            .upload(
                VERSION_SNAPSHOTS_BUCKET,
                &storage_key,
                Bytes::from(body),
                "application/json",
            )
            .await?;

        let insert = sqlx::query(
            r#"
            insert into public.project_versions
                (id, project_id, created_by, label, storage_key, file_count, total_bytes)
            values ($1, $2, $3, $4, $5, $6, $7)
            returning id, project_id, created_by, label, file_count, total_bytes, created_at,
                      (select display_name from public.users where id = $3) as author_display_name
            "#,
        )
        .bind(version_id.into_inner())
        .bind(project.into_inner())
        .bind(user.into_inner())
        .bind(input.label.as_deref())
        .bind(&storage_key)
        .bind(file_count)
        .bind(total_bytes)
        .fetch_one(&self.pool)
        .await;

        match insert {
            Ok(row) => Ok(row_to_version(row)),
            Err(err) => {
                let _ = self
                    .storage
                    .remove(VERSION_SNAPSHOTS_BUCKET, &[storage_key])
                    .await;
                Err(internal(err))
            }
        }
    }

    pub async fn get_payload(
        &self,
        user: UserId,
        project: ProjectId,
        version: VersionId,
    ) -> ApiResult<VersionPayload> {
        assert_member(&self.pool, user, project).await?;
        let storage_key: Option<String> = sqlx::query_scalar(
            "select storage_key from public.project_versions where id = $1 and project_id = $2",
        )
        .bind(version.into_inner())
        .bind(project.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let storage_key = storage_key.ok_or_else(|| ApiError::not_found("Version not found"))?;
        let bytes = self.storage.download(VERSION_SNAPSHOTS_BUCKET, &storage_key).await?;
        let payload: VersionPayload = serde_json::from_slice(&bytes)
            .map_err(|err| ApiError::internal(format!("Version payload malformed: {err}")))?;
        Ok(payload)
    }

    /// Restore a snapshot: for each path that still exists in the
    /// project, overwrite its storage object with the historical
    /// content. Files that have since been deleted are skipped (matches
    /// the Node implementation — we don't recreate deleted files).
    pub async fn restore(
        &self,
        user: UserId,
        project: ProjectId,
        version: VersionId,
    ) -> ApiResult<()> {
        // Owner-only — restore overwrites text content for the entire project.
        assert_owner(&self.pool, user, project).await?;
        let payload = self.get_payload(user, project, version).await?;

        let current = sqlx::query(
            "select id, path, storage_key from public.project_files where project_id = $1",
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;

        use std::collections::HashMap;
        let mut by_path: HashMap<String, (Uuid, String)> = HashMap::with_capacity(current.len());
        for row in current {
            let id: Uuid = row.get("id");
            let path: String = row.get("path");
            let key: String = row.get("storage_key");
            by_path.insert(path, (id, key));
        }

        for file in payload.files {
            let Some((file_id, key)) = by_path.get(&file.path).cloned() else { continue };
            self.storage
                .upload_text(PROJECT_FILES_BUCKET, &key, &file.content)
                .await?;
            sqlx::query(
                r#"
                update public.project_files
                set size_bytes = $2, updated_at = now()
                where id = $1
                "#,
            )
            .bind(file_id)
            .bind(file.content.len() as i64)
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        }

        Ok(())
    }
}

fn row_to_version(row: sqlx::postgres::PgRow) -> ProjectVersion {
    ProjectVersion {
        id: VersionId::new(row.get::<Uuid, _>("id")),
        project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
        created_by: row.get::<Option<Uuid>, _>("created_by").map(UserId::new),
        author_display_name: row.get("author_display_name"),
        label: row.get("label"),
        file_count: row.get::<i32, _>("file_count"),
        total_bytes: row.get::<i64, _>("total_bytes"),
        created_at: row.get::<DateTime<Utc>, _>("created_at"),
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("db: {err}"))
}
