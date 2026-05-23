//! Project share-link service. Owner generates an opaque token that
//! anyone signed-in can redeem to join the project as viewer/commenter
//! without going through the e-mail invite flow. See migration
//! `20260524000002_project_share_links.sql` for the table.
//!
//! Auth model: the redeem flow inserts a `project_members` row keyed by
//! the visitor's user id, so once redeemed they're a first-class member
//! and the rest of the app keeps working unchanged — no shadow-role,
//! no parallel auth path.

use base64::Engine;
use chrono::{DateTime, Utc};
use scribe_shared::{
    ApiError, ApiResult, CreateShareLinkInput, ErrorCode, MemberRole, ProjectId,
    RedeemShareResponse, ShareLink, ShareLinkId, SharePreview, ShareRole, UserId,
};
use sqlx::{PgPool, Row};
use tracing::info;
use uuid::Uuid;

use super::membership::assert_owner;

#[derive(Clone)]
pub struct ShareService {
    pool: PgPool,
}

impl ShareService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Owner creates a new share link. Token is 24 random bytes,
    /// base64url-encoded — same shape as Supabase invite tokens for
    /// rate of collision purposes (~192 bits of entropy).
    pub async fn create(
        &self,
        owner: UserId,
        project: ProjectId,
        input: CreateShareLinkInput,
    ) -> ApiResult<ShareLink> {
        assert_owner(&self.pool, owner, project).await?;
        let token = generate_token();
        let role = input.role;
        let row = sqlx::query(
            r#"
            insert into public.project_share_links
              (project_id, token, role, created_by, expires_at)
            values ($1, $2, $3, $4, $5)
            returning id, project_id, token, role, created_by, created_at,
                      expires_at, revoked_at
            "#,
        )
        .bind(project.into_inner())
        .bind(&token)
        .bind(role.as_str())
        .bind(owner.into_inner())
        .bind(input.expires_at)
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        info!(project_id = %project, created_by = %owner, role = %role.as_str(), "share link created");
        row_to_share(&row)
    }

    /// Owner-only listing. Includes revoked links so the UI can show
    /// "X invalidated yesterday" — keeps a paper trail.
    pub async fn list(&self, owner: UserId, project: ProjectId) -> ApiResult<Vec<ShareLink>> {
        assert_owner(&self.pool, owner, project).await?;
        let rows = sqlx::query(
            r#"
            select id, project_id, token, role, created_by, created_at,
                   expires_at, revoked_at
            from public.project_share_links
            where project_id = $1
            order by created_at desc
            "#,
        )
        .bind(project.into_inner())
        .fetch_all(&self.pool)
        .await
        .map_err(internal)?;
        rows.iter().map(row_to_share).collect()
    }

    /// Owner-only revocation. Idempotent: revoking again is a no-op so
    /// double-click doesn't 4xx.
    pub async fn revoke(
        &self,
        owner: UserId,
        link_id: ShareLinkId,
    ) -> ApiResult<()> {
        // Look up the project so we can check ownership without needing
        // it from the URL — keeps the revoke URL flat: /share-links/:id.
        let row = sqlx::query(
            r#"
            select project_id
            from public.project_share_links
            where id = $1
            "#,
        )
        .bind(link_id.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let row = row.ok_or_else(|| ApiError::not_found("Share link not found"))?;
        let project_id: Uuid = row.get("project_id");
        assert_owner(&self.pool, owner, ProjectId::new(project_id)).await?;
        sqlx::query(
            r#"
            update public.project_share_links
            set revoked_at = coalesce(revoked_at, now())
            where id = $1
            "#,
        )
        .bind(link_id.into_inner())
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }

    /// Anonymous preview — what the /share/:token landing page shows
    /// before the visitor signs in. No PII leaks beyond the project
    /// name + role, which the link-holder will see anyway.
    pub async fn preview(&self, token: &str) -> ApiResult<SharePreview> {
        let row = sqlx::query(
            r#"
            select s.project_id, s.role, s.expires_at, s.revoked_at,
                   p.name as project_name
            from public.project_share_links s
            join public.projects p on p.id = s.project_id
            where s.token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let row = row.ok_or_else(|| ApiError::not_found("Share link not found"))?;
        assert_share_usable(&row)?;
        let role_str: String = row.get("role");
        let role = ShareRole::parse(&role_str)
            .ok_or_else(|| ApiError::internal(format!("unknown share role: {role_str}")))?;
        Ok(SharePreview {
            project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
            project_name: row.get("project_name"),
            role,
            expires_at: row.get("expires_at"),
        })
    }

    /// Redeem the token as the authenticated caller. Upserts a
    /// `project_members` row with the link's role, accepting at `now()`
    /// so the rest of the app treats them as a fully invited member.
    ///
    /// Idempotent: re-redeeming a link the user already used returns
    /// success with no change. If they were a viewer who redeems a
    /// commenter link, we UPGRADE the role — but we never downgrade,
    /// since a member could have been promoted to editor independently
    /// of the share-link path and we shouldn't strip that.
    ///
    /// `user_email` is used to coalesce a pending email invitation for
    /// the same address into the share-redeem row, so we don't end up
    /// with two `project_members` rows for the same person that would
    /// later collide on `(project_id, user_id)` when the email invite
    /// is finally accepted. Pass `None` if the auth token lacks an
    /// email claim — we'll fall back to creating a fresh row.
    pub async fn redeem(
        &self,
        user: UserId,
        user_email: Option<&str>,
        token: &str,
    ) -> ApiResult<RedeemShareResponse> {
        let row = sqlx::query(
            r#"
            select s.id, s.project_id, s.role, s.expires_at, s.revoked_at
            from public.project_share_links s
            where s.token = $1
            "#,
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let row = row.ok_or_else(|| ApiError::not_found("Share link not found"))?;
        assert_share_usable(&row)?;

        let project_id: Uuid = row.get("project_id");
        let role_str: String = row.get("role");
        let share_role = ShareRole::parse(&role_str)
            .ok_or_else(|| ApiError::internal(format!("unknown share role: {role_str}")))?;
        let member_role: MemberRole = match share_role {
            ShareRole::Viewer => MemberRole::Viewer,
            ShareRole::Commenter => MemberRole::Commenter,
        };

        // Existing membership? If their current role is at least as
        // privileged as the share role, leave it alone.
        let existing = sqlx::query_scalar::<_, Option<String>>(
            r#"
            select role from public.project_members
            where project_id = $1 and user_id = $2
            limit 1
            "#,
        )
        .bind(project_id)
        .bind(user.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal)?;
        let existing_role = existing
            .flatten()
            .and_then(|s| MemberRole::parse(&s));

        match existing_role {
            Some(current) if role_rank(current) >= role_rank(member_role) => {
                // Already at-or-above the link's role; nothing to do.
            }
            Some(_) => {
                // Upgrade their role.
                sqlx::query(
                    r#"
                    update public.project_members
                    set role = $1,
                        invite_accepted_at = coalesce(invite_accepted_at, now())
                    where project_id = $2 and user_id = $3
                    "#,
                )
                .bind(member_role_str(member_role))
                .bind(project_id)
                .bind(user.into_inner())
                .execute(&self.pool)
                .await
                .map_err(internal)?;
            }
            None => {
                // First, look for a pending email invite for this user's
                // address — claim it instead of inserting a parallel row.
                // Without this, the email invite's later `accept()` would
                // try to set `user_id` on its own row and trip the unique
                // index on `(project_id, user_id)`.
                let pending: Option<(Uuid, String)> = if let Some(email) = user_email {
                    sqlx::query_as::<_, (Uuid, String)>(
                        r#"
                        select id, role
                        from public.project_members
                        where project_id = $1
                          and user_id is null
                          and invited_email is not null
                          and lower(invited_email) = lower($2)
                          and invite_accepted_at is null
                        limit 1
                        "#,
                    )
                    .bind(project_id)
                    .bind(email)
                    .fetch_optional(&self.pool)
                    .await
                    .map_err(internal)?
                } else {
                    None
                };

                if let Some((invite_id, invite_role_str)) = pending {
                    // Pick the higher of (invite role, share-link role) so
                    // the merge never silently downgrades an editor-level
                    // email invite into a viewer share-link role.
                    let invite_role = MemberRole::parse(&invite_role_str).unwrap_or(member_role);
                    let chosen = if role_rank(invite_role) >= role_rank(member_role) {
                        invite_role
                    } else {
                        member_role
                    };
                    sqlx::query(
                        r#"
                        update public.project_members
                        set user_id = $1,
                            role = $2,
                            invite_accepted_at = now()
                        where id = $3
                        "#,
                    )
                    .bind(user.into_inner())
                    .bind(member_role_str(chosen))
                    .bind(invite_id)
                    .execute(&self.pool)
                    .await
                    .map_err(internal)?;
                } else {
                    sqlx::query(
                        r#"
                        insert into public.project_members
                          (project_id, user_id, role, invite_accepted_at)
                        values ($1, $2, $3, now())
                        on conflict do nothing
                        "#,
                    )
                    .bind(project_id)
                    .bind(user.into_inner())
                    .bind(member_role_str(member_role))
                    .execute(&self.pool)
                    .await
                    .map_err(internal)?;
                }
            }
        }

        info!(project_id = %project_id, %user, role = %share_role.as_str(), "share link redeemed");
        // Best-effort: notify the project owner that someone joined
        // via share link. Owner gets visibility into who's accessing
        // their project without checking the members panel manually.
        self.notify_share_redeemed(user, ProjectId::new(project_id), share_role).await;
        Ok(RedeemShareResponse {
            project_id: ProjectId::new(project_id),
            role: share_role,
        })
    }

    async fn notify_share_redeemed(&self, actor: UserId, project: ProjectId, role: ShareRole) {
        let notifs = super::notifications::NotificationService::new(self.pool.clone());
        // Owner + actor display lookups in one round-trip.
        let row = sqlx::query(
            r#"
            select p.owner_id, p.name as project_name, u.display_name as actor_name
            from public.projects p
            left join public.users u on u.id = $2
            where p.id = $1
            "#,
        )
        .bind(project.into_inner())
        .bind(actor.into_inner())
        .fetch_optional(&self.pool)
        .await;
        let Ok(Some(row)) = row else { return; };
        let owner_id: Uuid = match row.try_get("owner_id") { Ok(v) => v, Err(_) => return };
        if owner_id == actor.into_inner() { return; }
        let project_name: Option<String> = row.try_get("project_name").ok();
        let actor_name: Option<String> = row.try_get::<Option<String>, _>("actor_name").ok().flatten();
        let mut payload = serde_json::Map::new();
        payload.insert("projectId".into(), serde_json::Value::String(project.into_inner().to_string()));
        if let Some(n) = project_name { payload.insert("projectName".into(), serde_json::Value::String(n)); }
        if let Some(n) = actor_name { payload.insert("actorName".into(), serde_json::Value::String(n)); }
        payload.insert("actorId".into(), serde_json::Value::String(actor.into_inner().to_string()));
        payload.insert("role".into(), serde_json::Value::String(role.as_str().to_string()));
        notifs
            .emit(
                UserId::new(owner_id),
                scribe_shared::NotificationKind::ShareRedeemed,
                serde_json::Value::Object(payload),
            )
            .await;
    }
}

fn role_rank(role: MemberRole) -> u8 {
    match role {
        MemberRole::Owner => 4,
        MemberRole::Editor => 3,
        MemberRole::Commenter => 2,
        MemberRole::Viewer => 1,
    }
}

fn member_role_str(role: MemberRole) -> &'static str {
    match role {
        MemberRole::Owner => "owner",
        MemberRole::Editor => "editor",
        MemberRole::Commenter => "commenter",
        MemberRole::Viewer => "viewer",
    }
}

fn assert_share_usable(row: &sqlx::postgres::PgRow) -> ApiResult<()> {
    let revoked_at: Option<DateTime<Utc>> = row.get("revoked_at");
    if revoked_at.is_some() {
        return Err(ApiError::new(ErrorCode::Conflict, "Share link has been revoked"));
    }
    let expires_at: Option<DateTime<Utc>> = row.get("expires_at");
    if let Some(exp) = expires_at {
        if exp < Utc::now() {
            return Err(ApiError::new(ErrorCode::Conflict, "Share link has expired"));
        }
    }
    Ok(())
}

fn row_to_share(row: &sqlx::postgres::PgRow) -> ApiResult<ShareLink> {
    let role_str: String = row.get("role");
    let role = ShareRole::parse(&role_str)
        .ok_or_else(|| ApiError::internal(format!("unknown share role: {role_str}")))?;
    Ok(ShareLink {
        id: ShareLinkId::new(row.get::<Uuid, _>("id")),
        project_id: ProjectId::new(row.get::<Uuid, _>("project_id")),
        token: row.get("token"),
        role,
        created_by: UserId::new(row.get::<Uuid, _>("created_by")),
        created_at: row.get("created_at"),
        expires_at: row.get("expires_at"),
        revoked_at: row.get("revoked_at"),
    })
}

fn generate_token() -> String {
    // Two random v4 UUIDs = 256 bits of CSPRNG entropy from
    // `getrandom`, which `uuid` pulls in transitively. We strip the
    // version/variant bits' structure by base64-encoding the raw
    // bytes — collision probability stays negligible.
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(a.as_bytes());
    bytes[16..].copy_from_slice(b.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn internal(err: sqlx::Error) -> ApiError {
    tracing::error!(?err, "database error in shares service");
    ApiError::new(ErrorCode::Internal, "Database error")
}
