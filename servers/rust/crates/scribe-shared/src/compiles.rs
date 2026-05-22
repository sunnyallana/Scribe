//! Compile job types. Mirrors `packages/shared/src/schema/compiles.ts`.
//!
//! A `CompileJob` is one tectonic invocation. The producer (HTTP route)
//! inserts a row with `status = 'queued'` and pushes a job payload onto
//! Redis; the worker picks it up, transitions through `running`, then
//! finishes with one of `success` / `error` / `cancelled`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ids::{ProjectId, UserId};
use crate::projects::CompilerEngine;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CompileJobId(pub Uuid);

impl CompileJobId {
    pub fn new(value: Uuid) -> Self {
        Self(value)
    }
    pub fn into_inner(self) -> Uuid {
        self.0
    }
}

impl std::fmt::Display for CompileJobId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompileJobStatus {
    Queued,
    Running,
    Success,
    Error,
    Cancelled,
}

impl CompileJobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Success => "success",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "queued" => Self::Queued,
            "running" => Self::Running,
            "success" => Self::Success,
            "error" => Self::Error,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Success | Self::Error | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompileLogLevel {
    Error,
    Warning,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileLogEntry {
    pub level: CompileLogLevel,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub line: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub raw: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileJob {
    pub id: CompileJobId,
    pub project_id: ProjectId,
    pub triggered_by: Option<UserId>,
    pub status: CompileJobStatus,
    pub engine: CompilerEngine,
    pub main_file: String,
    pub exit_code: Option<i32>,
    pub pdf_key: Option<String>,
    pub log_key: Option<String>,
    pub synctex_key: Option<String>,
    pub error_message: Option<String>,
    pub entries: Option<Vec<CompileLogEntry>>,
    pub duration_ms: Option<i32>,
    pub enqueued_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCompileJobInput {
    /// Override the project's default `main_file`. Optional.
    pub main_file: Option<String>,
}

/// Messages streamed over WebSocket `/api/compiles/:jobId/stream`. Same
/// wire schema as the Node server: tagged union with `type` discriminator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CompileLogStreamMessage {
    Status {
        status: CompileJobStatus,
    },
    Log {
        entry: CompileLogEntry,
    },
    Completed {
        status: CompileJobStatus,
        #[serde(rename = "pdfKey")]
        pdf_key: Option<String>,
        #[serde(rename = "logKey")]
        log_key: Option<String>,
        #[serde(rename = "synctexKey")]
        synctex_key: Option<String>,
        #[serde(rename = "durationMs")]
        duration_ms: Option<i32>,
        #[serde(rename = "errorMessage")]
        error_message: Option<String>,
    },
}

/// Payload pushed onto Redis when a job is enqueued. Mirrors the Node
/// `CompileJobPayload` shape but uses snake_case JSON keys since both
/// producer and consumer in this stack are Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompileJobPayload {
    pub compile_job_id: CompileJobId,
    pub project_id: ProjectId,
    pub main_file: String,
    pub engine: CompilerEngine,
    pub triggered_by: Option<UserId>,
}
