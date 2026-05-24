//! HTTP routes. Each submodule exposes a `router()` returning a
//! `Router<AppState>` to compose into the main app.

pub mod ai;
pub mod comments;
pub mod compiles;
pub mod exports;
pub mod files;
pub mod health;
pub mod invites;
pub mod lint;
pub mod members;
pub mod notifications;
pub mod projects;
pub mod shares;
pub mod versions;
pub mod voice;
pub mod whoami;
pub mod yjs;
