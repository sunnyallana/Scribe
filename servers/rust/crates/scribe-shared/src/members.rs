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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_role_parse_round_trip() {
        // Every variant must round-trip through `as_str()` → `parse()`.
        for role in [
            MemberRole::Owner,
            MemberRole::Editor,
            MemberRole::Commenter,
            MemberRole::Viewer,
        ] {
            assert_eq!(MemberRole::parse(role.as_str()), Some(role));
        }
    }

    #[test]
    fn member_role_parse_rejects_unknown() {
        assert_eq!(MemberRole::parse(""), None);
        assert_eq!(MemberRole::parse("OWNER"), None); // case-sensitive
        assert_eq!(MemberRole::parse("admin"), None);
        assert_eq!(MemberRole::parse(" editor "), None); // no trim
    }

    #[test]
    fn member_role_serde_lowercase() {
        // The `#[serde(rename_all = "lowercase")]` contract is what the
        // client expects; pin it down so a future refactor that drops
        // the attribute breaks here.
        let json = serde_json::to_string(&MemberRole::Owner).unwrap();
        assert_eq!(json, "\"owner\"");
        let parsed: MemberRole = serde_json::from_str("\"viewer\"").unwrap();
        assert_eq!(parsed, MemberRole::Viewer);
    }

    #[test]
    fn invite_role_default_is_editor() {
        // The SPA's invite form defaults to "editor" if the user doesn't
        // pick — this is what makes that default safe on the server too.
        assert_eq!(InviteRole::default(), InviteRole::Editor);
    }

    #[test]
    fn invite_role_as_str_matches_serde() {
        for role in [InviteRole::Editor, InviteRole::Commenter, InviteRole::Viewer] {
            let json = serde_json::to_string(&role).unwrap();
            // JSON value is quoted — `as_str` is the unquoted form.
            assert_eq!(json, format!("\"{}\"", role.as_str()));
        }
    }

    #[test]
    fn invite_role_serde_owner_rejected() {
        // Owners can't be granted via invite (only the project creator
        // is an owner). Verify the deserializer rejects "owner".
        let result: Result<InviteRole, _> = serde_json::from_str("\"owner\"");
        assert!(result.is_err(), "InviteRole must not accept 'owner'");
    }
}
