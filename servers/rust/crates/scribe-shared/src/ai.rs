//! AI provider configuration + completion types. Mirrors
//! `packages/shared/src/schema/ai.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AIProvider {
    Openai,
    Anthropic,
    Gemini,
    Ollama,
    Lmstudio,
    #[serde(rename = "openai-compatible")]
    OpenaiCompatible,
}

impl AIProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Ollama => "ollama",
            Self::Lmstudio => "lmstudio",
            Self::OpenaiCompatible => "openai-compatible",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "openai" => Self::Openai,
            "anthropic" => Self::Anthropic,
            "gemini" => Self::Gemini,
            "ollama" => Self::Ollama,
            "lmstudio" => Self::Lmstudio,
            "openai-compatible" => Self::OpenaiCompatible,
            _ => return None,
        })
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            Self::Openai => "gpt-4o",
            Self::Anthropic => "claude-sonnet-4-6",
            Self::Gemini => "gemini-1.5-pro",
            Self::Ollama => "llama3",
            Self::Lmstudio => "llama3",
            Self::OpenaiCompatible => "gpt-4o",
        }
    }

    pub fn needs_base_url(&self) -> bool {
        matches!(self, Self::Ollama | Self::Lmstudio | Self::OpenaiCompatible)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AIFeature {
    ImproveWriting,
    FixError,
    ExpandSection,
    Summarize,
    Translate,
    GenerateEquation,
    /// Handwriting / image to LaTeX OCR. Requires a vision-capable model
    /// and an attached `image` on the request.
    RecognizeEquation,
    ExplainCommand,
    CompleteSentence,
    Caption,
    Grammar,
    BibSuggest,
    Chat,
}

/// Public-facing AI config. The encrypted API key is never serialized to
/// the client; instead a masked `api_key_preview` like `sk-***1234` ships.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIConfigPublic {
    pub provider: AIProvider,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key_preview: Option<String>,
    pub updated_at: Option<String>,
}

/// What's stored in the `users.ai_config` JSONB column. Strictly
/// internal to the server — never exposed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIConfigStored {
    pub provider: AIProvider,
    pub model: String,
    pub base_url: Option<String>,
    /// AES-GCM ciphertext (base64). Empty string means "no key on file".
    #[serde(default)]
    pub api_key_encrypted: Option<String>,
    /// Last-4 of the cleartext key for the masked preview. Kept here so
    /// we don't have to decrypt just to render the preview.
    #[serde(default)]
    pub api_key_preview: Option<String>,
    pub updated_at: Option<String>,
}

impl AIConfigStored {
    pub fn to_public(&self) -> AIConfigPublic {
        AIConfigPublic {
            provider: self.provider,
            model: self.model.clone(),
            base_url: self.base_url.clone(),
            api_key_preview: self.api_key_preview.clone(),
            updated_at: self.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAIConfigInput {
    pub provider: AIProvider,
    pub model: String,
    /// Plain-text key. If omitted, the existing key is kept as-is.
    pub api_key: Option<String>,
    /// Required for ollama / lmstudio / openai-compatible.
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AICompleteInput {
    pub feature: AIFeature,
    #[serde(default)]
    pub selection: String,
    #[serde(default)]
    pub options: Option<HashMap<String, String>>,
    #[serde(default)]
    pub history: Option<Vec<ChatMessage>>,
    /// Optional image for vision features (e.g. handwriting OCR). Only
    /// honoured by vision-capable models; ignored by the text path.
    #[serde(default)]
    pub image: Option<ImageInput>,
}

/// A single inline image attached to an AI request. `data` is the raw
/// base64 of the image bytes (no `data:` URL prefix); `media_type` is the
/// MIME type such as `image/png`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub media_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    /// Synthesised by the server as a leading message; clients don't send this.
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIPingResult {
    pub ok: bool,
    pub model: Option<String>,
    pub latency_ms: u64,
    pub error: Option<String>,
}

pub fn mask_api_key(key: &str) -> String {
    if key.len() <= 8 {
        return "****".to_string();
    }
    let head: String = key.chars().take(3).collect();
    let tail: String = key.chars().rev().take(4).collect::<String>().chars().rev().collect();
    format!("{head}***{tail}")
}
