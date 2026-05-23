//! Notification inbox service. See migration
//! `20260524000003_notifications.sql` for the table.
//!
//! Other services emit notifications by calling `emit()` — keep this
//! best-effort: a failure to write a notification row should never
//! roll back the primary action (posting a comment, redeeming a
//! share link, …). We log errors and move on.

use chrono::{DateTime, Utc};
use scribe_shared::{
    ApiError, ApiResult, ErrorCode, Notification, NotificationKind, UnreadCountResponse, UserId,
};
use sqlx::{PgPool, Row};
use tracing::warn;
use uuid::Uuid;

#[derive(Clone)]
pub struct NotificationService {
    pool: PgPool,
}

impl NotificationService {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Best-effort emit. Logs but does NOT propagate errors — the
    /// caller's primary action (creating a comment, redeeming a
    /// share link, etc.) shouldn't fail because the notification
    /// table is briefly unreachable.
    pub async fn emit(
        &self,
        recipient: UserId,
        kind: NotificationKind,
        payload: serde_json::Value,
    ) {
        let res = sqlx::query(
            r#"
            insert into public.notifications (user_id, kind, payload)
            values ($1, $2, $3)
            "#,
        )
        .bind(recipient.into_inner())
        .bind(kind.as_str())
        .bind(payload)
        .execute(&self.pool)
        .await;
        if let Err(err) = res {
            warn!(?err, %recipient, kind = %kind.as_str(), "failed to insert notification");
        }
    }

    /// List the caller's notifications, newest first. `unread_only`
    /// gates the partial index for the bell-icon badge fetch.
    pub async fn list(
        &self,
        user: UserId,
        unread_only: bool,
        limit: i64,
    ) -> ApiResult<Vec<Notification>> {
        let limit = limit.clamp(1, 200);
        let rows = if unread_only {
            sqlx::query(
                r#"
                select id, user_id, kind, payload, read_at, created_at
                from public.notifications
                where user_id = $1 and read_at is null
                order by created_at desc
                limit $2
                "#,
            )
            .bind(user.into_inner())
            .bind(limit)
            .fetch_all(&self.pool)
            .await
        } else {
            sqlx::query(
                r#"
                select id, user_id, kind, payload, read_at, created_at
                from public.notifications
                where user_id = $1
                order by created_at desc
                limit $2
                "#,
            )
            .bind(user.into_inner())
            .bind(limit)
            .fetch_all(&self.pool)
            .await
        }
        .map_err(internal)?;
        rows.iter().map(row_to_notification).collect()
    }

    pub async fn unread_count(&self, user: UserId) -> ApiResult<UnreadCountResponse> {
        let count: i64 = sqlx::query_scalar(
            r#"
            select count(*) from public.notifications
            where user_id = $1 and read_at is null
            "#,
        )
        .bind(user.into_inner())
        .fetch_one(&self.pool)
        .await
        .map_err(internal)?;
        Ok(UnreadCountResponse { count })
    }

    pub async fn mark_read(&self, user: UserId, id: Uuid) -> ApiResult<()> {
        let affected = sqlx::query(
            r#"
            update public.notifications
            set read_at = coalesce(read_at, now())
            where id = $1 and user_id = $2
            "#,
        )
        .bind(id)
        .bind(user.into_inner())
        .execute(&self.pool)
        .await
        .map_err(internal)?
        .rows_affected();
        if affected == 0 {
            return Err(ApiError::not_found("Notification not found"));
        }
        Ok(())
    }

    pub async fn mark_all_read(&self, user: UserId) -> ApiResult<()> {
        sqlx::query(
            r#"
            update public.notifications
            set read_at = now()
            where user_id = $1 and read_at is null
            "#,
        )
        .bind(user.into_inner())
        .execute(&self.pool)
        .await
        .map_err(internal)?;
        Ok(())
    }
}

fn row_to_notification(row: &sqlx::postgres::PgRow) -> ApiResult<Notification> {
    let kind_str: String = row.get("kind");
    let kind = NotificationKind::parse(&kind_str)
        .ok_or_else(|| ApiError::internal(format!("unknown notification kind: {kind_str}")))?;
    let read_at: Option<DateTime<Utc>> = row.get("read_at");
    Ok(Notification {
        id: row.get::<Uuid, _>("id"),
        user_id: UserId::new(row.get::<Uuid, _>("user_id")),
        kind,
        payload: row.get::<serde_json::Value, _>("payload"),
        read_at,
        created_at: row.get("created_at"),
    })
}

fn internal(err: sqlx::Error) -> ApiError {
    tracing::error!(?err, "database error in notifications service");
    ApiError::new(ErrorCode::Internal, "Database error")
}
