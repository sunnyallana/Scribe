//! Project member CRUD + invite issuance. Mirrors
//! `server/src/services/memberService.ts`.
//!
//! The Node version also sends an invite email; in this Rust port the
//! caller is responsible for surfacing the `invite_token` to the user
//! (e.g. by copying it to clipboard, or wiring a separate email service
//! later). We log a structured `invite_issued` event so observers can
//! pipe it into their own mailer.

use base64::Engine;
use chrono::{DateTime, Utc};
use scribe_shared::{
    ApiError, ApiResult, ErrorCode, InviteMemberInput, MemberId, MemberRole, ProjectId,
    ProjectMember, UpdateMemberRoleInput, UserId,
};
use sqlx::{PgPool, Row};
use tracing::info;
use uuid::Uuid;

use super::membership::{assert_member, assert_owner};

#[derive(Clone)]
pub struct MemberService {
    pool: PgPool,
}

impl MemberService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn list(
        &self,
        user: UserId,
        project: ProjectId,
    ) -> ApiResult<Vec<ProjectMember>> {
        assert_member(&self.pool, user, project).await?;
        let rows = sqlx::query(
            r#"
            select m.id, m.project_id, m.user_id, m.invited_email,
                   u.display_name, u.avatar_url, u.email as user_email,
                   m.role, m.invited_at, m.invite_accepted_at,
                   m.invite_expires_at
            from public.project_members m
            left join public.users u on u.id = m.user_id
            where m.project_id = $1
            order by m.invited_at asc
            "#,
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        Ok(rows.into_iter().map(row_to_member).collect())
    }

    /// Create a pending invite. If the email already maps to an existing
    /// user we link the row to their `user_id` so the accept step is a
    /// no-op for them. Returns the row including the freshly minted
    /// `invite_token` — the caller is expected to surface it (e.g. via a
    /// "copy invite link" UI affordance).
    pub async fn invite(
        &self,
        user: UserId,
        project: ProjectId,
        input: InviteMemberInput,
    ) -> ApiResult<ProjectMember> {
        // Inviting requires owner role. Editors/etc can read but not change membership.
        assert_owner(&self.pool, user, project).await?;

        let token = generate_invite_token();

        // Look up the existing user by case-insensitive email so we can
        // pre-link the row.
        let existing_user_id: Option<Uuid> = sqlx::query_scalar(
            "select id from public.users where lower(email) = lower($1) limit 1",
        )
        .bind(&input.email)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;

        let row_result = sqlx::query(
            r#"
            insert into public.project_members
                (project_id, user_id, invited_email, role, invite_token, invited_by)
            values ($1, $2, $3, $4, $5, $6)
            returning id, project_id, user_id, invited_email,
                      (select display_name from public.users where id = $2) as display_name,
                      (select avatar_url   from public.users where id = $2) as avatar_url,
                      (select email        from public.users where id = $2) as user_email,
                      role, invited_at, invite_accepted_at, invite_expires_at
            "#,
        )
        .bind(project.into_inner())
        .bind(existing_user_id)
        .bind(&input.email)
        .bind(input.role.as_str())
        .bind(&token)
        .bind(user.into_inner())
        .fetch_one(&self.pool)
        .await;

        let row = row_result.map_err(map_invite_err)?;
        let member = row_to_member(row);
        info!(
            project = %project, inviter = %user, member = %member.id,
            "invite_issued",
        );
        Ok(member)
    }

    pub async fn update_role(
        &self,
        user: UserId,
        project: ProjectId,
        member_id: MemberId,
        input: UpdateMemberRoleInput,
    ) -> ApiResult<ProjectMember> {
        assert_owner(&self.pool, user, project).await?;
        let row = sqlx::query(
            r#"
            update public.project_members m
            set role = $1
            where m.id = $2 and m.project_id = $3 and m.role <> 'owner'
            returning m.id, m.project_id, m.user_id, m.invited_email,
                      (select display_name from public.users where id = m.user_id) as display_name,
                      (select avatar_url   from public.users where id = m.user_id) as avatar_url,
                      (select email        from public.users where id = m.user_id) as user_email,
                      m.role, m.invited_at, m.invite_accepted_at, m.invite_expires_at
            "#,
        )
        .bind(input.role.as_str())
        .bind(member_id.into_inner())
        .bind(project.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        row.map(row_to_member).ok_or_else(|| ApiError::not_found("Member not found"))
    }

    pub async fn remove(
        &self,
        user: UserId,
        project: ProjectId,
        member_id: MemberId,
    ) -> ApiResult<()> {
        assert_owner(&self.pool, user, project).await?;
        let affected = sqlx::query(
            "delete from public.project_members where id = $1 and project_id = $2 and role <> 'owner'",
        )
        .bind(member_id.into_inner())
        .bind(project.into_inner())
        .execute(&self.pool)
        .await
        .map_err(internal)?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::not_found("Member not found"));
        }
        Ok(())
    }
}

fn generate_invite_token() -> String {
    let mut bytes = [0u8; 32];
    use std::time::{SystemTime, UNIX_EPOCH};
    // Mix UUID v4 with timestamp salt; collision-resistant enough for invite tokens.
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    bytes[..16].copy_from_slice(a.as_bytes());
    bytes[16..32].copy_from_slice(b.as_bytes());
    // Stir in current ns for an extra dose of unpredictability.
    if let Ok(d) = SystemTime::now().duration_since(UNIX_EPOCH) {
        let ns = d.subsec_nanos().to_le_bytes();
        for (i, n) in ns.iter().enumerate() {
            bytes[i] ^= *n;
        }
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn row_to_member(row: sqlx::postgres::PgRow) -> ProjectMember {
    let role_str: String = row.get("role");
    let invited_email: Option<String> = row.get("invited_email");
    let user_email: Option<String> = row.get("user_email");
    let email = user_email.or(invited_email);
    let accepted_at: Option<DateTime<Utc>> = row.get("invite_accepted_at");
    ProjectMember {
        id: MemberId::new(row.get::<Uuid, _>("id")),
        project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
        user_id: row.get::<Option<Uuid>, _>("user_id").map(UserId::new),
        email,
        display_name: row.get("display_name"),
        avatar_url: row.get("avatar_url"),
        role: MemberRole::parse(&role_str).unwrap_or(MemberRole::Viewer),
        invited_at: row.get::<DateTime<Utc>, _>("invited_at"),
        accepted_at,
        expires_at: row.get::<DateTime<Utc>, _>("invite_expires_at"),
        pending: accepted_at.is_none(),
    }
}

fn internal(err: sqlx::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("db: {err}"))
}

/// Map the `(project_id, user_id)` and `(project_id, lower(invited_email))`
/// unique violations into a 409 so clients can tell duplicate-invite from
/// other failures.
fn map_invite_err(err: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(ref db_err) = err {
        if db_err.code().as_deref() == Some("23505") {
            return ApiError::new(
                ErrorCode::Conflict,
                "That user is already invited or a member",
            );
        }
    }
    internal(err)
}
