//! Comment CRUD. Mirrors `server/src/services/commentService.ts`.
//!
//! All operations check membership; updates/deletes additionally allow
//! either the author OR the project owner, matching the RLS policies.

use chrono::{DateTime, Utc};
use scribe_shared::{
    ApiError, ApiResult, Comment, CommentId, CreateCommentInput, ErrorCode, FileId,
    NotificationKind, ProjectId, UpdateCommentInput, UserId,
};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use super::membership::assert_member;
use super::notifications::NotificationService;

/// Pull the mentioned user IDs out of a comment body. The web app
/// serialises a mention as `@[Display Name](uuid)`; see
/// apps/web/src/components/ReviewPanel/mentions.ts for the producer.
/// We mirror the format here by hand to avoid pulling in a regex
/// crate just for one parse. Duplicates are de-duped.
fn extract_mentioned_user_ids(body: &str) -> Vec<Uuid> {
    let bytes = body.as_bytes();
    let mut out: Vec<Uuid> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'@' { i += 1; continue; }
        if i + 1 >= bytes.len() || bytes[i + 1] != b'[' { i += 1; continue; }
        // Scan for the closing `](`
        let close_bracket = body[i + 2..].find("](").map(|n| i + 2 + n);
        let Some(cb) = close_bracket else { i += 1; continue; };
        // UUID is 36 chars then `)`.
        let uuid_start = cb + 2;
        if uuid_start + 36 + 1 > body.len() { i += 1; continue; }
        let uuid_end = uuid_start + 36;
        if bytes[uuid_end] != b')' { i += 1; continue; }
        let uuid_str = &body[uuid_start..uuid_end];
        if let Ok(u) = Uuid::parse_str(uuid_str) {
            if !out.contains(&u) { out.push(u); }
        }
        i = uuid_end + 1;
    }
    out
}

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
                   c.anchor_line, c.anchor_column,
                   c.anchor_end_line, c.anchor_end_column, c.anchor_snippet,
                   c.body,
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
                    (project_id, file_id, parent_id, author_id,
                     anchor_line, anchor_column,
                     anchor_end_line, anchor_end_column, anchor_snippet,
                     body)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                returning id, project_id, file_id, parent_id, author_id,
                          anchor_line, anchor_column,
                          anchor_end_line, anchor_end_column, anchor_snippet,
                          body,
                          resolved_at, resolved_by, created_at, updated_at
            )
            select i.id, i.project_id, i.file_id, i.parent_id, i.author_id,
                   u.display_name as author_display_name,
                   i.anchor_line, i.anchor_column,
                   i.anchor_end_line, i.anchor_end_column, i.anchor_snippet,
                   i.body,
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
        .bind(input.anchor_end_line)
        .bind(input.anchor_end_column)
        .bind(input.anchor_snippet.as_deref())
        .bind(&input.body)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        let comment = row_to_comment(row);
        // Notification fan-out runs *after* the comment is durable.
        // Best-effort — emit failures don't affect the comment row.
        self.fan_out_notifications(user, project, &comment, &input.body).await;
        Ok(comment)
    }

    /// Emits notifications for mentions inside a new comment + a
    /// `comment_reply` notice when the comment threads under another.
    /// Self-pings (mentioning yourself or replying to your own
    /// comment) are filtered out so we don't badge the actor.
    async fn fan_out_notifications(
        &self,
        actor: UserId,
        project: ProjectId,
        comment: &Comment,
        body: &str,
    ) {
        let notifs = NotificationService::new(self.pool.clone());

        // Look up project + actor names once for payload context.
        let ctx = sqlx::query(
            r#"
            select p.name as project_name, u.display_name as actor_name
            from public.projects p
            cross join public.users u
            where p.id = $1 and u.id = $2
            "#,
        )
        .bind(project.into_inner())
        .bind(actor.into_inner())
        .fetch_optional(&self.pool)
        .await;
        let (project_name, actor_name) = match ctx {
            Ok(Some(row)) => (
                row.try_get::<String, _>("project_name").ok(),
                row.try_get::<Option<String>, _>("actor_name").ok().flatten(),
            ),
            _ => (None, None),
        };

        let snippet: String = body.chars().take(140).collect();
        let make_payload = |kind: NotificationKind| -> serde_json::Value {
            let mut obj = serde_json::Map::new();
            obj.insert("projectId".into(), serde_json::Value::String(project.into_inner().to_string()));
            if let Some(name) = project_name.as_deref() {
                obj.insert("projectName".into(), serde_json::Value::String(name.to_string()));
            }
            if let Some(name) = actor_name.as_deref() {
                obj.insert("actorName".into(), serde_json::Value::String(name.to_string()));
            }
            obj.insert("actorId".into(), serde_json::Value::String(actor.into_inner().to_string()));
            obj.insert("commentId".into(), serde_json::Value::String(comment.id.into_inner().to_string()));
            obj.insert("snippet".into(), serde_json::Value::String(snippet.clone()));
            let _ = kind; // kind is encoded in the column, not the payload
            serde_json::Value::Object(obj)
        };

        // Mention fan-out. Only members of the project should
        // receive mentions — a stale @[X](uuid) for someone who's
        // since been removed shouldn't spam. We filter via a SQL
        // membership probe so the check is single-round-trip even
        // when there are several mentions.
        let mentioned = extract_mentioned_user_ids(body);
        for u in mentioned {
            if u == actor.into_inner() { continue; }
            let is_member: Result<bool, _> = sqlx::query_scalar(
                r#"
                select exists (
                    select 1 from public.project_members
                    where project_id = $1 and user_id = $2
                      and invite_accepted_at is not null
                ) or exists (
                    select 1 from public.projects where id = $1 and owner_id = $2
                )
                "#,
            )
            .bind(project.into_inner())
            .bind(u)
            .fetch_one(&self.pool)
            .await;
            if !is_member.unwrap_or(false) { continue; }
            notifs
                .emit(UserId::new(u), NotificationKind::Mention, make_payload(NotificationKind::Mention))
                .await;
        }

        // Reply notification. Only emitted when there's a parent
        // and the parent's author is someone other than `actor`.
        if let Some(parent_id) = comment.parent_id {
            let parent_author = sqlx::query_scalar::<_, Option<Uuid>>(
                r#"
                select author_id from public.comments where id = $1
                "#,
            )
            .bind(parent_id.into_inner())
            .fetch_optional(&self.pool)
            .await
            .ok()
            .flatten()
            .flatten();
            if let Some(author_id) = parent_author {
                if author_id != actor.into_inner() {
                    notifs
                        .emit(
                            UserId::new(author_id),
                            NotificationKind::CommentReply,
                            make_payload(NotificationKind::CommentReply),
                        )
                        .await;
                }
            }
        }
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
                returning id, project_id, file_id, parent_id, author_id,
                          anchor_line, anchor_column,
                          anchor_end_line, anchor_end_column, anchor_snippet,
                          body,
                          resolved_at, resolved_by, created_at, updated_at
            )
            select u.id, u.project_id, u.file_id, u.parent_id, u.author_id,
                   au.display_name as author_display_name,
                   u.anchor_line, u.anchor_column,
                   u.anchor_end_line, u.anchor_end_column, u.anchor_snippet,
                   u.body,
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

/// Mutating ops (edit body, resolve, delete) — author or project
/// owner only. Editors deliberately don't get to touch other
/// reviewers' comments: rewriting someone else's words is an
/// integrity hazard, and deleting them would let an editor silently
/// suppress critical feedback the owner might want to see. Owner is
/// the only "moderation" lane and matches industry norms (Overleaf,
/// Google Docs).
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
        anchor_end_line: row.get("anchor_end_line"),
        anchor_end_column: row.get("anchor_end_column"),
        anchor_snippet: row.get("anchor_snippet"),
        body: row.get("body"),
        resolved_at: row.get::<Option<DateTime<Utc>>, _>("resolved_at"),
        resolved_by: row.get::<Option<Uuid>, _>("resolved_by").map(UserId::new),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    tracing::error!(?err, "database error in comments service");
    ApiError::new(ErrorCode::Internal, "Database error")
}
