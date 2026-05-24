//! Project + project-file domain types. Mirrors `packages/shared/src/schema/projects.ts`
//! and `files.ts` — JSON field names match exactly so the existing web
//! client doesn't need any changes.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::files::FileType;
use crate::ids::{FileId, ProjectId, UserId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CompilerEngine {
    #[default]
    Tectonic,
    Pdflatex,
    Xelatex,
    Lualatex,
}

impl CompilerEngine {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Tectonic => "tectonic",
            Self::Pdflatex => "pdflatex",
            Self::Xelatex => "xelatex",
            Self::Lualatex => "lualatex",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "tectonic" => Self::Tectonic,
            "pdflatex" => Self::Pdflatex,
            "xelatex" => Self::Xelatex,
            "lualatex" => Self::Lualatex,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProjectTemplate {
    #[default]
    Blank,
    Article,
    Report,
    Beamer,
    Cv,
    Letter,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub description: Option<String>,
    pub owner_id: UserId,
    pub template: String,
    pub compiler: CompilerEngine,
    pub main_file: String,
    pub is_public: bool,
    pub archived_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectInput {
    #[serde(deserialize_with = "trim_required_string")]
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub template: ProjectTemplate,
    #[serde(default)]
    pub compiler: CompilerEngine,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectInput {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub description: Option<Option<String>>,
    pub compiler: Option<CompilerEngine>,
    pub main_file: Option<String>,
    pub is_public: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub id: FileId,
    pub project_id: ProjectId,
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: FileType,
    pub size_bytes: i64,
    pub created_by: Option<UserId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateFileInput {
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: Option<FileType>,
    pub content: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileInput {
    pub new_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileContentInput {
    pub content: String,
}

/// Deserialize that distinguishes "field absent" from "field present and null".
/// Used by `UpdateProjectInput.description` so PATCH can clear the field.
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

fn trim_required_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err(serde::de::Error::custom("must not be empty"));
    }
    if trimmed.len() > 200 {
        return Err(serde::de::Error::custom("must be at most 200 characters"));
    }
    Ok(trimmed.to_string())
}
