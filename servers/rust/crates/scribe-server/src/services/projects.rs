//! Project CRUD. Mirrors `server/src/services/projectService.ts`.
//!
//! Authorization model (since RLS isn't in play with our sqlx
//! connection): every read joins through `project_members` (or the
//! owner column) for the caller. Service helpers accept a `UserId` and
//! enforce membership inline — the route layer is just a translator.

use std::sync::Arc;

use chrono::{DateTime, Utc};
use scribe_shared::{
    ApiError, ApiResult, CompilerEngine, CreateFileInput, CreateProjectInput, ErrorCode, FileType,
    Project, ProjectId, ProjectTemplate, UpdateProjectInput, UserId,
};
use scribe_storage::SupabaseStorage;
use sqlx::{PgPool, Row};
use tracing::warn;
use uuid::Uuid;

use crate::services::files::FileService;
use crate::services::templates::files_for_template;

/// Service handle. Cheap to clone (Arc-shaped state internally).
#[derive(Clone)]
pub struct ProjectService {
    pool: PgPool,
    files: FileService,
}

impl ProjectService {
    pub fn new(pool: PgPool, storage: Arc<SupabaseStorage>) -> Self {
        Self { pool: pool.clone(), files: FileService::new(pool, storage) }
    }

    pub async fn list_for_user(&self, user: UserId) -> ApiResult<Vec<Project>> {
        let rows = sqlx::query(
            r#"
            select p.id, p.name, p.description, p.owner_id, p.template, p.compiler,
                   p.main_file, p.is_public, p.archived_at, p.created_at, p.updated_at
            from public.projects p
            where p.archived_at is null
              and (
                p.owner_id = $1
                or exists (
                    select 1 from public.project_members m
                    where m.project_id = p.id and m.user_id = $1
                      and m.invite_accepted_at is not null
                )
              )
            order by p.updated_at desc
            "#,
        )
        .bind(user.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        Ok(rows.into_iter().map(row_to_project).collect())
    }

    pub async fn get_for_user(&self, user: UserId, id: ProjectId) -> ApiResult<Project> {
        let row = sqlx::query(
            r#"
            select p.id, p.name, p.description, p.owner_id, p.template, p.compiler,
                   p.main_file, p.is_public, p.archived_at, p.created_at, p.updated_at
            from public.projects p
            where p.id = $1
              and (
                p.owner_id = $2
                or p.is_public
                or exists (
                    select 1 from public.project_members m
                    where m.project_id = p.id and m.user_id = $2
                      and m.invite_accepted_at is not null
                )
              )
            "#,
        )
        .bind(id.into_inner())
        .bind(user.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(row_to_project).ok_or_else(|| ApiError::not_found("Project not found"))
    }

    pub async fn create(
        &self,
        user: UserId,
        input: CreateProjectInput,
    ) -> ApiResult<Project> {
        let row = sqlx::query(
            r#"
            insert into public.projects (name, description, owner_id, template, compiler)
            values ($1, $2, $3, $4, $5)
            returning id, name, description, owner_id, template, compiler,
                      main_file, is_public, archived_at, created_at, updated_at
            "#,
        )
        .bind(&input.name)
        .bind(input.description.as_deref())
        .bind(user.into_inner())
        .bind(template_as_str(input.template))
        .bind(input.compiler.as_str())
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        let project = row_to_project(row);

        // Seed templated files. If any fail, undo the project insert so
        // we don't leave a half-initialized row around.
        for tf in files_for_template(input.template) {
            let seed_input = CreateFileInput {
                path: tf.path.to_string(),
                file_type: Some(FileType::Tex),
                content: Some(tf.content.to_string()),
            };
            if let Err(err) = self
                .files
                .create(user, project.id, seed_input)
                .await
            {
                let _ = self.delete_raw(project.id).await;
                warn!(
                    project = %project.id, ?err,
                    "template seed failed; project rolled back"
                );
                return Err(err);
            }
        }

        Ok(project)
    }

    pub async fn update(
        &self,
        user: UserId,
        id: ProjectId,
        input: UpdateProjectInput,
    ) -> ApiResult<Project> {
        // Owner-only updates. (Editor role can rename main_file too —
        // we leave that for a later membership-aware check.)
        let row = sqlx::query(
            r#"
            update public.projects set
                name = coalesce($3, name),
                description = case when $4::boolean then $5 else description end,
                compiler = coalesce($6, compiler),
                main_file = coalesce($7, main_file),
                is_public = coalesce($8, is_public)
            where id = $1 and owner_id = $2
            returning id, name, description, owner_id, template, compiler,
                      main_file, is_public, archived_at, created_at, updated_at
            "#,
        )
        .bind(id.into_inner())
        .bind(user.into_inner())
        .bind(input.name.as_deref())
        .bind(input.description.is_some())
        .bind(input.description.as_ref().and_then(|d| d.as_deref()))
        .bind(input.compiler.map(|c| c.as_str()))
        .bind(input.main_file.as_deref())
        .bind(input.is_public)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(row_to_project).ok_or_else(|| ApiError::not_found("Project not found"))
    }

    /// Deep-copy a project: new project row owned by the caller, all of
    /// the source's files copied (storage objects + DB rows). The caller
    /// must be able to read the source (owner, public, or accepted
    /// member). The new project's name defaults to "Source name (copy)"
    /// unless `new_name` is provided.
    pub async fn duplicate(
        &self,
        user: UserId,
        source_id: ProjectId,
        new_name: Option<String>,
    ) -> ApiResult<Project> {
        let source = self.get_for_user(user, source_id).await?;
        let name = new_name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("{} (copy)", source.name));

        // Insert the new project row. Carry over template, compiler,
        // main_file, description; the caller is the new owner.
        let row = sqlx::query(
            r#"
            insert into public.projects
                (name, description, owner_id, template, compiler, main_file)
            values ($1, $2, $3, $4, $5, $6)
            returning id, name, description, owner_id, template, compiler,
                      main_file, is_public, archived_at, created_at, updated_at
            "#,
        )
        .bind(&name)
        .bind(source.description.as_deref())
        .bind(user.into_inner())
        .bind(&source.template)
        .bind(source.compiler.as_str())
        .bind(&source.main_file)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        let new_project = row_to_project(row);

        // Copy every file. Simple read+write per file — no native Supabase
        // server-side copy primitive on the trait yet, but duplicate is
        // rare and concurrent file ops cap N × RTT to max(RTT) via the
        // HTTP/2 pool.
        let source_files = self.files.list(user, source_id).await?;
        let copy_futures = source_files.into_iter().map(|f| {
            let files = self.files.clone();
            let new_project_id = new_project.id;
            async move {
                let content = files.read_content(user, source_id, f.id).await?;
                let input = CreateFileInput {
                    path: f.path,
                    file_type: Some(f.file_type),
                    content: Some(content),
                };
                files.create(user, new_project_id, input).await?;
                Ok::<_, ApiError>(())
            }
        });
        if let Err(err) = futures::future::try_join_all(copy_futures).await {
            // Roll back the new project so we don't leave a half-copied
            // shell. Best-effort cleanup of storage happens via the file
            // service's create/delete pairing.
            let _ = self.delete_raw(new_project.id).await;
            return Err(err);
        }

        Ok(new_project)
    }

    pub async fn remove(&self, user: UserId, id: ProjectId) -> ApiResult<()> {
        let affected = sqlx::query(
            "delete from public.projects where id = $1 and owner_id = $2",
        )
        .bind(id.into_inner())
        .bind(user.into_inner())
        .execute(&self.pool)
        .await
        .map_err(internal)?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::not_found("Project not found"));
        }
        Ok(())
    }

    /// Internal: unconditional delete, used to roll back a failed create.
    async fn delete_raw(&self, id: ProjectId) -> ApiResult<()> {
        sqlx::query("delete from public.projects where id = $1")
            .bind(id.into_inner())
            .execute(&self.pool)
            .await
            .map_err(internal)?;
        Ok(())
    }
}

fn template_as_str(t: ProjectTemplate) -> &'static str {
    match t {
        ProjectTemplate::Blank => "blank",
        ProjectTemplate::Article => "article",
        ProjectTemplate::Report => "report",
        ProjectTemplate::Beamer => "beamer",
        ProjectTemplate::Cv => "cv",
        ProjectTemplate::Letter => "letter",
    }
}

fn row_to_project(row: sqlx::postgres::PgRow) -> Project {
    let compiler: String = row.get("compiler");
    Project {
        id: ProjectId::new(row.get::<Uuid, _>("id")),
        name: row.get("name"),
        description: row.get("description"),
        owner_id: UserId::new(row.get::<Uuid, _>("owner_id")),
        template: row.get("template"),
        compiler: CompilerEngine::parse(&compiler).unwrap_or_default(),
        main_file: row.get("main_file"),
        is_public: row.get("is_public"),
        archived_at: row.get::<Option<DateTime<Utc>>, _>("archived_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    tracing::error!(?err, "database error in projects service");
    ApiError::new(ErrorCode::Internal, "Database error")
}
