//! POST /api/projects/:project_id/lint — run chktex against a single
//! file's *unsaved* contents and return the warnings.
//!
//! The compile route runs chktex against the whole project as part of
//! a compile. This endpoint is the live, per-keystroke equivalent: it
//! takes the editor's current buffer (which may differ from what's in
//! storage) and lints only that file, in milliseconds. The client
//! debounces and fires this on save / typing-pause.
//!
//! Membership check uses `assert_member` because lint is read-only
//! informational — any member, even a viewer, can see what chktex
//! thinks of the file they're reading.

use std::env;

use axum::{
    extract::{Path, State},
    middleware::from_fn,
    routing::post,
    Json, Router,
};
use scribe_auth::{require_auth, Authenticated};
use scribe_compile::{run_chktex, ChktexConfig};
use scribe_shared::{ApiError, ApiResult, CompileLogEntry, ErrorCode, ProjectId};
use serde::Deserialize;
use tokio::fs;
use uuid::Uuid;

use crate::services::membership::assert_member;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LintInput {
    /// Path of the file inside the project (so chktex error messages
    /// reference the user-visible name, not a temp dir).
    file_path: String,
    /// The current editor buffer for that file. Capped at 4 MiB —
    /// anything larger is almost certainly not a hand-written .tex.
    content: String,
}

const MAX_LINT_BYTES: usize = 4 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/projects/:project_id/lint",
        post(lint).route_layer(from_fn(require_auth)),
    )
}

async fn lint(
    State(state): State<AppState>,
    Authenticated(user): Authenticated,
    Path(project_id): Path<Uuid>,
    Json(input): Json<LintInput>,
) -> ApiResult<Json<Vec<CompileLogEntry>>> {
    if input.content.len() > MAX_LINT_BYTES {
        return Err(ApiError::new(
            ErrorCode::PayloadTooLarge,
            "file too large for live-lint (cap is 4 MiB)",
        ));
    }

    // Lint isn't a write operation; viewers can see it too.
    let pool = state
        .db()
        .ok_or_else(|| ApiError::new(ErrorCode::ServiceUnavailable, "database not configured"))?
        .pool()
        .clone();
    assert_member(&pool, user.id, ProjectId::new(project_id)).await?;

    // Server-wide CHKTEX_BIN — same env var the compile worker reads.
    // We re-resolve at request time so a runtime config change can
    // take effect without restarting the API.
    let bin = env::var("CHKTEX_BIN").unwrap_or_default();
    let config = ChktexConfig {
        binary: if bin.is_empty() { None } else { Some(bin) },
        // Critical: live-lint only ships the single file the user
        // is editing, so chktex MUST NOT chase `\input{...}` chains
        // — it would otherwise emit warning 27 ("Could not execute
        // LaTeX command") for every cross-file include.
        follow_inputs: false,
    };
    if !config.enabled() {
        // No linter configured — return an empty list rather than a
        // 503. The SPA shows the absence of lint warnings the same
        // way regardless of why they're absent.
        return Ok(Json(Vec::new()));
    }

    // Each lint request gets its own scratch dir so concurrent
    // editors don't trample each other's files. tmpdir auto-cleans
    // on drop via the explicit `fs::remove_dir_all` at the end.
    let tmp_root = env::temp_dir().join(format!("scribe-lint-{}", Uuid::new_v4()));
    fs::create_dir_all(&tmp_root).await.map_err(|err| {
        tracing::error!(?err, "lint: failed to create scratch dir");
        ApiError::new(ErrorCode::Internal, "lint scratch dir create failed")
    })?;

    // Honour the file's nested path so chktex's reported `file` field
    // matches what the user sees in the editor. Sanitise to keep us
    // inside the scratch dir even if a path tries to escape via `..`.
    let safe_rel = sanitise_rel_path(&input.file_path);
    let target = tmp_root.join(&safe_rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).await.ok();
    }
    fs::write(&target, input.content.as_bytes()).await.ok();

    let entries = run_chktex(&config, &tmp_root, &safe_rel).await;

    // Best-effort cleanup. A leaked dir is harmless — temp gets nuked
    // by the OS — so we don't propagate the error.
    let _ = fs::remove_dir_all(&tmp_root).await;

    // Rewrite the entry's `file` back to the user-visible path; chktex
    // reports the path it was invoked with (`safe_rel`), which we
    // want to match `input.file_path` so the client can route the
    // results to the right open tab.
    let normalized: Vec<CompileLogEntry> = entries
        .into_iter()
        .map(|mut e| {
            if e.file.as_deref() == Some(safe_rel.as_str()) {
                e.file = Some(input.file_path.clone());
            }
            e
        })
        .collect();
    Ok(Json(normalized))
}

/// Sanitize a possibly-malicious path so we stay inside the scratch
/// dir. Drop any `..` segments, absolute prefixes, drive letters,
/// trailing slashes. Empty / dangerous paths fall back to a safe
/// default so the lint still runs.
fn sanitise_rel_path(path: &str) -> String {
    let mut out = std::path::PathBuf::new();
    for part in path.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." { continue; }
        // Drop Windows drive letters like `C:`.
        if part.len() == 2 && part.ends_with(':') { continue; }
        out.push(part);
    }
    let s = out.to_string_lossy().to_string();
    if s.is_empty() { "main.tex".to_string() } else { s }
}
