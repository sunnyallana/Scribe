//! Notification inbox types. See migration
//! `20260524000003_notifications.sql` for the table.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::UserId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    Mention,
    CommentReply,
    InviteAccepted,
    ShareRedeemed,
}

impl NotificationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Mention => "mention",
            Self::CommentReply => "comment_reply",
            Self::InviteAccepted => "invite_accepted",
            Self::ShareRedeemed => "share_redeemed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "mention" => Some(Self::Mention),
            "comment_reply" => Some(Self::CommentReply),
            "invite_accepted" => Some(Self::InviteAccepted),
            "share_redeemed" => Some(Self::ShareRedeemed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: Uuid,
    pub user_id: UserId,
    pub kind: NotificationKind,
    /// Free-form jsonb payload. Schema varies by kind; the frontend
    /// validates as it renders. Keeping it loose on the server keeps
    /// us forward-compatible when new fields land.
    pub payload: serde_json::Value,
    pub read_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCountResponse {
    pub count: i64,
}
