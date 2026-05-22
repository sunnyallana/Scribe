//! Project version snapshots. Mirrors
//! `packages/shared/src/schema/versions.ts`.
//!
//! Snapshots store a `VersionPayload` (JSON blob of all .tex/.bib file
//! contents) in the `version-snapshots` storage bucket; this struct is
//! just metadata.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::{ProjectId, UserId};

/// Newtype for `project_versions.id`. Distinct from `CommentId`/`FileId`
/// to keep the type signatures honest, even though it's "just a UUID".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct VersionId(pub Uuid);

impl VersionId {
    pub fn new(value: Uuid) -> Self {
        Self(value)
    }
    pub fn into_inner(self) -> Uuid {
        self.0
    }
}

impl std::fmt::Display for VersionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVersion {
    pub id: VersionId,
    pub project_id: ProjectId,
    pub created_by: Option<UserId>,
    pub author_display_name: Option<String>,
    pub label: Option<String>,
    pub file_count: i32,
    pub total_bytes: i64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVersionInput {
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionPayload {
    pub version: u32,
    pub files: Vec<VersionFile>,
}
