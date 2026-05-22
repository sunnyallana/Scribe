//! Object-storage abstraction. Today this targets Supabase Storage over
//! its REST API; tomorrow a direct-S3 or local-filesystem backend can
//! slot in behind the same [`Storage`] trait without touching call sites.
//!
//! Bucket and key conventions match the existing Fastify server so the
//! Rust and Node stacks share storage during cutover.

mod keys;
mod supabase;

pub use keys::{
    compile_artifact_key, project_file_key, COMPILE_ARTIFACTS_BUCKET, PROJECT_FILES_BUCKET,
    VERSION_SNAPSHOTS_BUCKET,
};
pub use supabase::{Storage, SupabaseStorage};
