//! Shared authorization checks for project resources. Mirrors the
//! `is_project_member` / `project_role` SQL helpers in
//! `supabase/migrations/20260521000006_rls_helpers.sql`.
//!
//! With the Rust server we connect via service-role credentials, so RLS
//! is not enforcing — every service is expected to call these helpers
//! before doing anything project-scoped.

use scribe_shared::{ApiError, ApiResult, ErrorCode, MemberRole, ProjectId, UserId};
use sqlx::PgPool;
use tracing::debug;

/// Returns Ok if the caller is an owner of OR an accepted member of the
/// project. NotFound (rather than Forbidden) on miss so we don't leak
/// whether the project exists at all.
pub async fn assert_member(pool: &PgPool, user: UserId, project: ProjectId) -> ApiResult<()> {
    let ok = sqlx::query_scalar::<_, bool>(
        r#"
        select exists (
            select 1 from public.projects p
            where p.id = $1
              and (
                p.owner_id = $2
                or exists (
                    select 1 from public.project_members m
                    where m.project_id = p.id and m.user_id = $2
                      and m.invite_accepted_at is not null
                )
              )
        )
        "#,
    )
    .bind(project.into_inner())
    .bind(user.into_inner())
    .fetch_one(pool)
    .await
    .map_err(internal)?;
    if ok { Ok(()) } else { Err(ApiError::not_found("Project not found")) }
}

/// Returns the caller's effective role on the project, or NotFound if
/// they have no relationship to it. Owners come from `projects.owner_id`;
/// non-owners come from `project_members` (accepted only).
pub async fn require_role(
    pool: &PgPool,
    user: UserId,
    project: ProjectId,
) -> ApiResult<MemberRole> {
    let row = sqlx::query_scalar::<_, Option<String>>(
        r#"
        select case
            when p.owner_id = $2 then 'owner'
            else (
                select m.role from public.project_members m
                where m.project_id = p.id and m.user_id = $2
                  and m.invite_accepted_at is not null
                limit 1
            )
        end
        from public.projects p
        where p.id = $1
        "#,
    )
    .bind(project.into_inner())
    .bind(user.into_inner())
    .fetch_optional(pool)
    .await
    .map_err(internal)?;

    let role_str = row
        .flatten()
        .ok_or_else(|| ApiError::not_found("Project not found"))?;
    MemberRole::parse(&role_str).ok_or_else(|| ApiError::internal(format!("unknown role: {role_str}")))
}

/// Guard: caller must be the project owner. Forbidden for any other role.
pub async fn assert_owner(pool: &PgPool, user: UserId, project: ProjectId) -> ApiResult<()> {
    match require_role(pool, user, project).await? {
        MemberRole::Owner => Ok(()),
        _ => Err(ApiError::forbidden("owner-only operation")),
    }
}

/// Guard: caller must be able to make content changes — owner or editor.
/// Viewers (and the legacy `commenter` role) are read-only and get a 403
/// here. Use this on any mutating file or compile route so a viewer who
/// got invited by mistake can't smuggle edits through the API.
#[tracing::instrument(skip(pool), fields(%user, %project))]
pub async fn assert_can_write(pool: &PgPool, user: UserId, project: ProjectId) -> ApiResult<()> {
    let role = require_role(pool, user, project).await?;
    let allow = matches!(role, MemberRole::Owner | MemberRole::Editor);
    debug!(?role, allow, "assert_can_write decision");
    if allow {
        Ok(())
    } else {
        Err(ApiError::forbidden("read-only access for this project"))
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("db: {err}"))
}
