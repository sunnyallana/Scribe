//! Invite acceptance flow. Mirrors `server/src/services/inviteService.ts`.
//!
//! The token endpoint is intentionally readable without auth (so the
//! invitee can preview project name + role before signing in); accept
//! requires auth and is gated by an email match.

use chrono::{DateTime, Utc};
use scribe_shared::{
    AcceptInviteResponse, ApiError, ApiResult, ErrorCode, InviteDetails, MemberRole, ProjectId,
};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone)]
pub struct InviteService {
    pool: PgPool,
}

impl InviteService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn details(&self, token: &str) -> ApiResult<InviteDetails> {
        let row = sqlx::query(
            r#"
            select m.id, m.project_id, m.invited_email, m.role,
                   m.invite_expires_at, m.invite_accepted_at, m.user_id,
                   p.name as project_name,
                   inv.display_name as inviter_display_name
            from public.project_members m
            join public.projects p on p.id = m.project_id
            left join public.users inv on inv.id = m.invited_by
            where m.invite_token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;

        let row = row.ok_or_else(|| ApiError::not_found("Invitation not found"))?;
        let expires_at: DateTime<Utc> = row.get("invite_expires_at");
        if expires_at < Utc::now() {
            return Err(ApiError::new(ErrorCode::Conflict, "Invitation has expired"));
        }
        let invited_email: Option<String> = row.get("invited_email");
        let invited_email = invited_email
            .ok_or_else(|| ApiError::internal("Invitation is missing an email"))?;
        let role_str: String = row.get("role");
        let accepted_at: Option<DateTime<Utc>> = row.get("invite_accepted_at");
        Ok(InviteDetails {
            token: token.to_string(),
            project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
            project_name: row.get("project_name"),
            inviter_display_name: row.get("inviter_display_name"),
            invited_email,
            role: MemberRole::parse(&role_str).unwrap_or(MemberRole::Viewer),
            expires_at,
            already_accepted: accepted_at.is_some(),
        })
    }

    /// Accept on behalf of the authenticated caller. `accepting_email`
    /// must case-insensitively match the invite — otherwise we forbid,
    /// so an invite to alice@x can't be claimed by bob@x.
    pub async fn accept(
        &self,
        token: &str,
        accepting_user: Uuid,
        accepting_email: &str,
    ) -> ApiResult<AcceptInviteResponse> {
        let row = sqlx::query(
            r#"
            select id, project_id, invited_email, invite_expires_at,
                   invite_accepted_at, user_id
            from public.project_members
            where invite_token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;

        let row = row.ok_or_else(|| ApiError::not_found("Invitation not found"))?;
        let invite_id: Uuid = row.get("id");
        let project_id: Uuid = row.get("project_id");
        let invited_email: Option<String> = row.get("invited_email");
        let expires_at: DateTime<Utc> = row.get("invite_expires_at");
        let accepted_at: Option<DateTime<Utc>> = row.get("invite_accepted_at");
        let user_id: Option<Uuid> = row.get("user_id");

        if expires_at < Utc::now() {
            return Err(ApiError::new(ErrorCode::Conflict, "Invitation has expired"));
        }
        if let Some(email) = invited_email.as_deref() {
            if !email.eq_ignore_ascii_case(accepting_email) {
                return Err(ApiError::forbidden(
                    "This invitation is for a different email address",
                ));
            }
        }
        if accepted_at.is_some() && user_id != Some(accepting_user) {
            return Err(ApiError::new(
                ErrorCode::Conflict,
                "This invitation has already been accepted",
            ));
        }

        sqlx::query(
            r#"
            update public.project_members
            set user_id = $1, invite_accepted_at = now()
            where id = $2
            "#,
        )
        .bind(accepting_user)
        .bind(invite_id)
        .execute(&self.pool)
        .await
        .map_err(internal)?;

        Ok(AcceptInviteResponse { project_id: ProjectId::new(project_id) })
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    tracing::error!(?err, "database error in invites service");
    ApiError::new(ErrorCode::Internal, "Database error")
}
