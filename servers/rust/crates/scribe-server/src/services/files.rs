//! File CRUD + storage. Mirrors `server/src/services/fileService.ts`.
//!
//! All paths take a `UserId` so membership can be enforced inline — we
//! either join through `project_members` or filter on `projects.owner_id`,
//! never trusting a raw `project_id` argument.

use std::sync::Arc;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use scribe_shared::{
    infer_file_type, ApiError, ApiResult, CreateFileInput, ErrorCode, FileId, FileType,
    ProjectFile, ProjectId, RenameFileInput, UserId,
};
use scribe_storage::{project_file_key, Storage, SupabaseStorage, PROJECT_FILES_BUCKET};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::membership::assert_member;

#[derive(Clone)]
pub struct FileService {
    pool: PgPool,
    storage: Arc<SupabaseStorage>,
}

impl FileService {
    pub fn new(pool: PgPool, storage: Arc<SupabaseStorage>) -> Self {
        Self { pool, storage }
    }

    pub async fn list(&self, user: UserId, project: ProjectId) -> ApiResult<Vec<ProjectFile>> {
        assert_member(&self.pool, user, project).await?;
        let rows = sqlx::query(
            r#"
            select id, project_id, path, type, storage_key, size_bytes,
                   created_by, created_at, updated_at
            from public.project_files
            where project_id = $1
            order by path
            "#,
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        Ok(rows.into_iter().map(row_to_file).collect())
    }

    pub async fn create(
        &self,
        user: UserId,
        project: ProjectId,
        input: CreateFileInput,
    ) -> ApiResult<ProjectFile> {
        assert_member(&self.pool, user, project).await?;

        let id = FileId::new(Uuid::new_v4());
        let key = project_file_key(project, id);
        let file_type = input.file_type.unwrap_or_else(|| infer_file_type(&input.path));
        let content = input.content.unwrap_or_default();
        let bytes = Bytes::from(content.into_bytes());

        // Upload first so we don't end up with a row pointing at no
        // object. If the DB insert fails afterwards we clean up.
        self.storage
            .upload(
                PROJECT_FILES_BUCKET,
                &key,
                bytes.clone(),
                "text/plain; charset=utf-8",
            )
            .await?;

        let insert = sqlx::query(
            r#"
            insert into public.project_files (id, project_id, path, type, storage_key, size_bytes, created_by)
            values ($1, $2, $3, $4, $5, $6, $7)
            returning id, project_id, path, type, storage_key, size_bytes,
                      created_by, created_at, updated_at
            "#,
        )
        .bind(id.into_inner())
        .bind(project.into_inner())
        .bind(&input.path)
        .bind(file_type_as_str(file_type))
        .bind(&key)
        .bind(bytes.len() as i64)
        .bind(user.into_inner())
        .fetch_one(&self.pool)
        .await;

        match insert {
            Ok(row) => Ok(row_to_file(row)),
            Err(err) => {
                // Best-effort rollback of the orphan object.
                let _ = self.storage.remove(PROJECT_FILES_BUCKET, &[key]).await;
                Err(map_insert_err(err))
            }
        }
    }

    pub async fn rename(
        &self,
        user: UserId,
        project: ProjectId,
        file: FileId,
        input: RenameFileInput,
    ) -> ApiResult<ProjectFile> {
        assert_member(&self.pool, user, project).await?;
        let row = sqlx::query(
            r#"
            update public.project_files
            set path = $1
            where project_id = $2 and id = $3
            returning id, project_id, path, type, storage_key, size_bytes,
                      created_by, created_at, updated_at
            "#,
        )
        .bind(&input.new_path)
        .bind(project.into_inner())
        .bind(file.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(map_insert_err)?;
        row.map(row_to_file).ok_or_else(|| ApiError::not_found("File not found"))
    }

    pub async fn remove(
        &self,
        user: UserId,
        project: ProjectId,
        file: FileId,
    ) -> ApiResult<()> {
        assert_member(&self.pool, user, project).await?;
        let key: Option<String> = sqlx::query_scalar(
            r#"
            delete from public.project_files
            where project_id = $1 and id = $2
            returning storage_key
            "#,
        )
        .bind(project.into_inner())
        .bind(file.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let key = key.ok_or_else(|| ApiError::not_found("File not found"))?;
        let _ = self.storage.remove(PROJECT_FILES_BUCKET, &[key]).await;
        Ok(())
    }

    pub async fn read_content(
        &self,
        user: UserId,
        project: ProjectId,
        file: FileId,
    ) -> ApiResult<String> {
        assert_member(&self.pool, user, project).await?;
        let key = self.fetch_storage_key(project, file).await?;
        let bytes = self.storage.download(PROJECT_FILES_BUCKET, &key).await?;
        // Files in this bucket are almost always text (.tex/.bib/etc).
        // Binary files (images, PDFs) can occasionally land here via
        // the multipart upload path; rather than 500ing on invalid
        // UTF-8, decode lossily — matches the Node server's
        // `await blob.text()` behavior.
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn write_content(
        &self,
        user: UserId,
        project: ProjectId,
        file: FileId,
        content: String,
    ) -> ApiResult<ProjectFile> {
        assert_member(&self.pool, user, project).await?;
        let key = self.fetch_storage_key(project, file).await?;
        let bytes = Bytes::from(content.into_bytes());
        self.storage
            .upload(
                PROJECT_FILES_BUCKET,
                &key,
                bytes.clone(),
                "text/plain; charset=utf-8",
            )
            .await?;
        let row = sqlx::query(
            r#"
            update public.project_files
            set size_bytes = $3, updated_at = now()
            where project_id = $1 and id = $2
            returning id, project_id, path, type, storage_key, size_bytes,
                      created_by, created_at, updated_at
            "#,
        )
        .bind(project.into_inner())
        .bind(file.into_inner())
        .bind(bytes.len() as i64)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(row_to_file).ok_or_else(|| ApiError::not_found("File not found"))
    }

    pub async fn signed_download_url(
        &self,
        user: UserId,
        project: ProjectId,
        file: FileId,
    ) -> ApiResult<String> {
        assert_member(&self.pool, user, project).await?;
        let key = self.fetch_storage_key(project, file).await?;
        self.storage.signed_url(PROJECT_FILES_BUCKET, &key, 60).await
    }

    async fn fetch_storage_key(
        &self,
        project: ProjectId,
        file: FileId,
    ) -> ApiResult<String> {
        let key: Option<String> = sqlx::query_scalar(
            "select storage_key from public.project_files where project_id = $1 and id = $2",
        )
        .bind(project.into_inner())
        .bind(file.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        key.ok_or_else(|| ApiError::not_found("File not found"))
    }
}

fn file_type_as_str(t: FileType) -> &'static str {
    match t {
        FileType::Tex => "tex",
        FileType::Bib => "bib",
        FileType::Image => "image",
        FileType::Other => "other",
    }
}

fn parse_file_type(s: &str) -> FileType {
    match s {
        "tex" => FileType::Tex,
        "bib" => FileType::Bib,
        "image" => FileType::Image,
        _ => FileType::Other,
    }
}

fn row_to_file(row: sqlx::postgres::PgRow) -> ProjectFile {
    ProjectFile {
        id: FileId::new(row.get::<Uuid, _>("id")),
        project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
        path: row.get("path"),
        file_type: parse_file_type(row.get::<&str, _>("type")),
        size_bytes: row.get::<i64, _>("size_bytes"),
        created_by: row.get::<Option<Uuid>, _>("created_by").map(UserId::new),
        created_at: row.get::<DateTime<Utc>, _>("created_at"),
        updated_at: row.get::<DateTime<Utc>, _>("updated_at"),
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("db: {err}"))
}

/// Map Postgres unique-violation (23505) to a 409 so the client can
/// distinguish "duplicate path" from a generic failure.
fn map_insert_err(err: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(ref db_err) = err {
        if db_err.code().as_deref() == Some("23505") {
            return ApiError::new(ErrorCode::Conflict, "A file already exists at that path");
        }
    }
    internal(err)
}
