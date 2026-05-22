//! Tectonic compile worker.
//!
//! Pulls jobs off Redis (replacing BullMQ), materializes project files
//! to a scratch directory, runs tectonic, and uploads PDF + SyncTeX +
//! log artifacts back to storage.
//!
//! Replaces `server/src/workers/compile.ts`. Producer side (the HTTP
//! endpoint that inserts a `compile_jobs` row + enqueues) lives in
//! `scribe-server` and uses [`queue::CompileQueue`].

pub mod log_parser;
pub mod queue;
pub mod tectonic;
pub mod worker;

pub use queue::{log_channel, CompileQueue, QueueError};
pub use tectonic::{run_tectonic, CompileOutcome, TectonicConfig};
pub use worker::{Worker, WorkerConfig};
