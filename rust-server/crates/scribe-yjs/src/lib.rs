//! Real-time collaboration server. Wraps `yrs` (Rust Y.js port) +
//! `y-sync` with a WebSocket handler and Postgres persistence of update
//! blobs.
//!
//! Replaces `server/src/yjs/sharedDoc.ts` and the y-protocols glue.
//!
//! ```text
//!   client ──ws──▶ axum upgrade ──▶ serve_socket(ws, doc_id, registry)
//!                                              │
//!                                              ├── persistence.bind_state
//!                                              ├── per-conn select loop
//!                                              └── shared_doc.broadcast
//! ```

pub mod persistence;
pub mod protocol;
pub mod shared_doc;
pub mod socket;

pub use persistence::{PersistenceError, PgPersistence, YjsPersistence};
pub use shared_doc::{ConnId, DocRegistry, SharedDoc};
pub use socket::serve_socket;
