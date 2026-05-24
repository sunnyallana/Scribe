//! Project membership + invite types. Mirrors
//! `packages/shared/src/schema/members.ts`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{MemberId, ProjectId, UserId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberRole {
    Owner,
    Editor,
    Commenter,
    Viewer,
}

impl MemberRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Editor => "editor",
            Self::Commenter => "commenter",
            Self::Viewer => "viewer",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "owner" => Self::Owner,
            "editor" => Self::Editor,
            "commenter" => Self::Commenter,
            "viewer" => Self::Viewer,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum InviteRole {
    #[default]
    Editor,
    Commenter,
    Viewer,
}

impl InviteRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Commenter => "commenter",
            Self::Viewer => "viewer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMember {
    pub id: MemberId,
    pub project_id: ProjectId,
    pub user_id: Option<UserId>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub role: MemberRole,
    pub invited_at: DateTime<Utc>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub expires_at: DateTime<Utc>,
    pub pending: bool,
    /// Present only for pending invites the caller is allowed to see —
    /// non-null lets the UI render a "copy invite link" affordance.
    /// Cleared once the invite is accepted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteMemberInput {
    pub email: String,
    #[serde(default)]
    pub role: InviteRole,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemberRoleInput {
    pub role: InviteRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InviteDetails {
    pub token: String,
    pub project_id: ProjectId,
    pub project_name: String,
    pub inviter_display_name: Option<String>,
    pub invited_email: String,
    pub role: MemberRole,
    pub expires_at: DateTime<Utc>,
    pub already_accepted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptInviteResponse {
    pub project_id: ProjectId,
}
