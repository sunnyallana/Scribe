//! Object-key formatting. Mirrors the Node service's `storageKey` and
//! `compileArtifactKey` exactly — the keyspace is shared between the two
//! servers during cutover, so they must agree byte-for-byte.

use scribe_shared::{FileId, ProjectId};

pub const PROJECT_FILES_BUCKET: &str = "project-files";
pub const COMPILE_ARTIFACTS_BUCKET: &str = "compile-artifacts";
pub const VERSION_SNAPSHOTS_BUCKET: &str = "version-snapshots";

#[inline]
pub fn project_file_key(project: ProjectId, file: FileId) -> String {
    format!("{}/{}", project, file)
}

#[inline]
pub fn compile_artifact_key(project: ProjectId, job_id: &str, filename: &str) -> String {
    format!("{}/{}/{}", project, job_id, filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn project_file_key_is_project_slash_file() {
        let p = ProjectId::new(Uuid::from_u128(0x1111_2222_3333_4444_5555_6666_7777_8888));
        let f = FileId::new(Uuid::from_u128(0xaaaa_bbbb_cccc_dddd_eeee_ffff_0000_1111));
        assert_eq!(
            project_file_key(p, f),
            "11112222-3333-4444-5555-666677778888/aaaabbbb-cccc-dddd-eeee-ffff00001111"
        );
    }

    #[test]
    fn compile_artifact_key_is_project_job_filename() {
        let p = ProjectId::new(Uuid::nil());
        assert_eq!(
            compile_artifact_key(p, "job-1", "main.pdf"),
            "00000000-0000-0000-0000-000000000000/job-1/main.pdf"
        );
    }
}
