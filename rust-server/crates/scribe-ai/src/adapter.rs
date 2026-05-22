//! AI provider adapter trait + dispatcher.
//!
//! Each adapter takes a list of chat messages and produces a stream of
//! token chunks. The HTTP handler tees those chunks into SSE frames.
//!
//! Three concrete implementations cover all six providers the Node
//! server supports:
//!
//!   * [`openai`]    — `openai`, `ollama`, `lmstudio`, `openai-compatible`
//!                      (they all speak the OpenAI Chat Completions API)
//!   * [`anthropic`] — `anthropic` (Claude Messages API)
//!   * [`gemini`]    — `gemini` (Google AI Studio API)

use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::BoxStream;
use scribe_shared::{AIProvider, ChatMessage};
use thiserror::Error;

pub use crate::providers::{anthropic, gemini, openai};

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("provider {provider:?} requires a base URL but none was set")]
    MissingBaseUrl { provider: AIProvider },
    #[error("provider returned {status}: {message}")]
    HttpStatus { status: u16, message: String },
    #[error("network: {0}")]
    Network(#[from] reqwest::Error),
    #[error("encode: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("stream: {0}")]
    Stream(String),
}

#[derive(Debug, Clone)]
pub struct CompleteRequest {
    pub provider: AIProvider,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key: String,
    pub messages: Vec<ChatMessage>,
    /// Sampling temperature. 0–2 in OpenAI; clamped per-provider.
    pub temperature: f32,
    /// Max output tokens. None ⇒ adapter default.
    pub max_tokens: Option<u32>,
}

impl CompleteRequest {
    pub fn system_then_user(
        provider: AIProvider,
        model: String,
        base_url: Option<String>,
        api_key: String,
        system: &str,
        user: &str,
    ) -> Self {
        let messages = vec![
            ChatMessage { role: scribe_shared::ChatRole::System, content: system.to_string() },
            ChatMessage { role: scribe_shared::ChatRole::User, content: user.to_string() },
        ];
        Self {
            provider,
            model,
            base_url,
            api_key,
            messages,
            temperature: 0.4,
            max_tokens: None,
        }
    }
}

/// One token-stream chunk. We don't try to expose finish reason / token
/// counts to clients — the SSE consumer just concatenates `text`.
#[derive(Debug, Clone)]
pub struct CompletionChunk {
    pub text: String,
}

#[async_trait]
pub trait Adapter: Send + Sync {
    async fn stream(
        &self,
        req: CompleteRequest,
    ) -> Result<BoxStream<'static, Result<CompletionChunk, AdapterError>>, AdapterError>;

    /// Quick connectivity check. Returns the model the provider echoed back
    /// (if available) so the UI can show the user it's wired up correctly.
    async fn ping(&self, req: CompleteRequest) -> Result<Option<String>, AdapterError>;
}

/// Dispatch on `provider` to the right adapter.
pub fn adapter_for(provider: AIProvider) -> Box<dyn Adapter> {
    match provider {
        AIProvider::Openai
        | AIProvider::Ollama
        | AIProvider::Lmstudio
        | AIProvider::OpenaiCompatible => Box::new(openai::OpenAIAdapter),
        AIProvider::Anthropic => Box::new(anthropic::AnthropicAdapter),
        AIProvider::Gemini => Box::new(gemini::GeminiAdapter),
    }
}

/// Helper to convert the abstract chunk stream to raw SSE-formatted
/// `Bytes` frames. The route handler maps these into `axum::response::sse`.
pub fn chunks_to_sse_lines(
    stream: BoxStream<'static, Result<CompletionChunk, AdapterError>>,
) -> BoxStream<'static, Result<Bytes, AdapterError>> {
    use futures::StreamExt;
    Box::pin(stream.map(|chunk| chunk.map(|c| Bytes::from(c.text))))
}
