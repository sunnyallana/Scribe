//! Comments + replies. Mirrors `packages/shared/src/schema/comments.ts`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ids::{CommentId, FileId, ProjectId, UserId};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: CommentId,
    pub project_id: ProjectId,
    pub file_id: Option<FileId>,
    pub parent_id: Option<CommentId>,
    pub author_id: UserId,
    pub author_display_name: Option<String>,
    /// Start of the anchored block (1-based line, 0-based column).
    pub anchor_line: Option<i32>,
    pub anchor_column: Option<i32>,
    /// End of the anchored block. Equal to (anchor_line, anchor_column)
    /// for point-anchored comments.
    pub anchor_end_line: Option<i32>,
    pub anchor_end_column: Option<i32>,
    /// Literal text that was selected when the comment was made.
    /// Used as a resilient anchor when line numbers drift.
    pub anchor_snippet: Option<String>,
    pub body: String,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by: Option<UserId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCommentInput {
    pub file_id: Option<FileId>,
    pub parent_id: Option<CommentId>,
    pub anchor_line: Option<i32>,
    pub anchor_column: Option<i32>,
    pub anchor_end_line: Option<i32>,
    pub anchor_end_column: Option<i32>,
    pub anchor_snippet: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCommentInput {
    pub body: Option<String>,
    pub resolved: Option<bool>,
}
