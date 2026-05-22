//! Comment CRUD. Mirrors `server/src/services/commentService.ts`.
//!
//! All operations check membership; updates/deletes additionally allow
//! either the author OR the project owner, matching the RLS policies.

use chrono::{DateTime, Utc};
use scribe_shared::{
    ApiError, ApiResult, Comment, CommentId, CreateCommentInput, ErrorCode, FileId, ProjectId,
    UpdateCommentInput, UserId,
};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::membership::assert_member;

#[derive(Clone)]
pub struct CommentService {
    pool: PgPool,
}

impl CommentService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn list(&self, user: UserId, project: ProjectId) -> ApiResult<Vec<Comment>> {
        assert_member(&self.pool, user, project).await?;
        let rows = sqlx::query(
            r#"
            select c.id, c.project_id, c.file_id, c.parent_id, c.author_id,
                   u.display_name as author_display_name,
                   c.anchor_line, c.anchor_column, c.body,
                   c.resolved_at, c.resolved_by, c.created_at, c.updated_at
            from public.comments c
            left join public.users u on u.id = c.author_id
            where c.project_id = $1
            order by c.created_at asc
            "#,
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        Ok(rows.into_iter().map(row_to_comment).collect())
    }

    pub async fn create(
        &self,
        user: UserId,
        project: ProjectId,
        input: CreateCommentInput,
    ) -> ApiResult<Comment> {
        assert_member(&self.pool, user, project).await?;
        let row = sqlx::query(
            r#"
            with inserted as (
                insert into public.comments
                    (project_id, file_id, parent_id, author_id, anchor_line, anchor_column, body)
                values ($1, $2, $3, $4, $5, $6, $7)
                returning *
            )
            select i.id, i.project_id, i.file_id, i.parent_id, i.author_id,
                   u.display_name as author_display_name,
                   i.anchor_line, i.anchor_column, i.body,
                   i.resolved_at, i.resolved_by, i.created_at, i.updated_at
            from inserted i
            left join public.users u on u.id = i.author_id
            "#,
        )
        .bind(project.into_inner())
        .bind(input.file_id.map(FileId::into_inner))
        .bind(input.parent_id.map(CommentId::into_inner))
        .bind(user.into_inner())
        .bind(input.anchor_line)
        .bind(input.anchor_column)
        .bind(&input.body)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        Ok(row_to_comment(row))
    }

    pub async fn update(
        &self,
        user: UserId,
        project: ProjectId,
        comment_id: CommentId,
        input: UpdateCommentInput,
    ) -> ApiResult<Comment> {
        assert_author_or_owner(&self.pool, user, project, comment_id).await?;
        let row = sqlx::query(
            r#"
            with updated as (
                update public.comments
                set body = coalesce($1, body),
                    resolved_at = case
                        when $2::boolean then
                            case when $3::boolean then now() else null end
                        else resolved_at
                    end,
                    resolved_by = case
                        when $2::boolean then
                            case when $3::boolean then $4 else null end
                        else resolved_by
                    end
                where project_id = $5 and id = $6
                returning *
            )
            select u.id, u.project_id, u.file_id, u.parent_id, u.author_id,
                   au.display_name as author_display_name,
                   u.anchor_line, u.anchor_column, u.body,
                   u.resolved_at, u.resolved_by, u.created_at, u.updated_at
            from updated u
            left join public.users au on au.id = u.author_id
            "#,
        )
        .bind(input.body.as_deref())
        .bind(input.resolved.is_some())
        .bind(input.resolved.unwrap_or(false))
        .bind(user.into_inner())
        .bind(project.into_inner())
        .bind(comment_id.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(row_to_comment).ok_or_else(|| ApiError::not_found("Comment not found"))
    }

    pub async fn remove(
        &self,
        user: UserId,
        project: ProjectId,
        comment_id: CommentId,
    ) -> ApiResult<()> {
        assert_author_or_owner(&self.pool, user, project, comment_id).await?;
        let affected = sqlx::query(
            "delete from public.comments where project_id = $1 and id = $2",
        )
        .bind(project.into_inner())
        .bind(comment_id.into_inner())
        .execute(&self.pool)
        .await
        .map_err(internal)?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::not_found("Comment not found"));
        }
        Ok(())
    }
}

async fn assert_author_or_owner(
    pool: &PgPool,
    user: UserId,
    project: ProjectId,
    comment_id: CommentId,
) -> ApiResult<()> {
    let allowed = sqlx::query_scalar::<_, bool>(
        r#"
        select exists (
            select 1
            from public.comments c
            join public.projects p on p.id = c.project_id
            where c.id = $1 and c.project_id = $2
              and (c.author_id = $3 or p.owner_id = $3)
        )
        "#,
    )
    .bind(comment_id.into_inner())
    .bind(project.into_inner())
    .bind(user.into_inner())
    .fetch_one(pool)
    .await
    .map_err(internal)?;
    if allowed { Ok(()) } else { Err(ApiError::forbidden("not your comment")) }
}

fn row_to_comment(row: sqlx::postgres::PgRow) -> Comment {
    Comment {
        id: CommentId::new(row.get::<Uuid, _>("id")),
        project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
        file_id: row.get::<Option<Uuid>, _>("file_id").map(FileId::new),
        parent_id: row.get::<Option<Uuid>, _>("parent_id").map(CommentId::new),
        author_id: UserId::new(row.get::<Uuid, _>("author_id")),
        author_display_name: row.get("author_display_name"),
        anchor_line: row.get("anchor_line"),
        anchor_column: row.get("anchor_column"),
        body: row.get("body"),
        resolved_at: row.get::<Option<DateTime<Utc>>, _>("resolved_at"),
        resolved_by: row.get::<Option<Uuid>, _>("resolved_by").map(UserId::new),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("db: {err}"))
}
