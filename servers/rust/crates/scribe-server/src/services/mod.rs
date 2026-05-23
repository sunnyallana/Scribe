//! Business-logic services. Each submodule owns one resource domain
//! (projects, files, comments, members, invites, versions, …) and is
//! the only place that builds SQL or talks to storage for that domain.
//! Route handlers translate HTTP into service calls and back.

pub mod ai;
pub mod comments;
pub mod compiles;
pub mod exports;
pub mod files;
pub mod invites;
pub mod members;
pub mod membership;
pub mod projects;
pub mod shares;
pub mod templates;
pub mod versions;

pub use comments::CommentService;
pub use files::FileService;
pub use invites::InviteService;
pub use members::MemberService;
pub use projects::ProjectService;
pub use shares::ShareService;
pub use versions::VersionService;
