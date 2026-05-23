//! Shared types and error definitions for the Scribe Rust server.
//!
//! Mirrors the responsibilities of `packages/shared` on the TypeScript side:
//! domain IDs, request/response shapes, and a common error envelope.

pub mod ai;
pub mod comments;
pub mod compiles;
pub mod ids;
pub mod error;
pub mod files;
pub mod members;
pub mod notifications;
pub mod projects;
pub mod shares;
pub mod versions;

pub use ai::{
    mask_api_key, AICompleteInput, AIConfigPublic, AIConfigStored, AIFeature, AIPingResult,
    AIProvider, ChatMessage, ChatRole, UpdateAIConfigInput,
};
pub use comments::{Comment, CreateCommentInput, UpdateCommentInput};
pub use compiles::{
    CompileJob, CompileJobId, CompileJobPayload, CompileJobStatus, CompileLogEntry,
    CompileLogLevel, CompileLogStreamMessage, CreateCompileJobInput,
};
pub use error::{ApiError, ApiErrorBody, ApiResult, ErrorCode};
pub use files::{infer_file_type, FileType};
pub use ids::{CommentId, FileId, MemberId, ProjectId, ShareLinkId, UserId};
pub use members::{
    AcceptInviteResponse, InviteDetails, InviteMemberInput, InviteRole, MemberRole, ProjectMember,
    UpdateMemberRoleInput,
};
pub use projects::{
    CompilerEngine, CreateFileInput, CreateProjectInput, FileContentInput, Project, ProjectFile,
    ProjectTemplate, RenameFileInput, UpdateProjectInput,
};
pub use notifications::{Notification, NotificationKind, UnreadCountResponse};
pub use shares::{
    CreateShareLinkInput, RedeemShareResponse, ShareLink, SharePreview, ShareRole,
};
pub use versions::{CreateVersionInput, ProjectVersion, VersionFile, VersionId, VersionPayload};
