//! Project share links. See `supabase/migrations/20260524000002_project_share_links.sql`
//! for the underlying table. v1 keeps role narrow to viewer/commenter —
//! editor-via-link bypasses owner approval, which we want gated to
//! explicit per-email invites for now.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{ProjectId, ShareLinkId, UserId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareRole {
    Viewer,
    Commenter,
}

impl ShareRole {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "viewer" => Some(Self::Viewer),
            "commenter" => Some(Self::Commenter),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Commenter => "commenter",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLink {
    pub id: ShareLinkId,
    pub project_id: ProjectId,
    pub token: String,
    pub role: ShareRole,
    pub created_by: UserId,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareLinkInput {
    pub role: ShareRole,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreview {
    pub project_id: ProjectId,
    pub project_name: String,
    pub role: ShareRole,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemShareResponse {
    pub project_id: ProjectId,
    pub role: ShareRole,
}
