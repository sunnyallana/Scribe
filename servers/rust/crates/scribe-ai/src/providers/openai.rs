//! OpenAI Chat Completions adapter.
//!
//! Also covers Ollama, LM Studio, and the generic `openai-compatible`
//! provider — all four speak the same wire format. The only difference
//! is the base URL (which lives on the config record and is required
//! for non-OpenAI variants).

use async_trait::async_trait;
use futures::stream::{BoxStream, Stream, StreamExt};
use scribe_shared::{AIProvider, ChatRole};
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::adapter::{Adapter, AdapterError, CompleteRequest, CompletionChunk};

const OPENAI_BASE: &str = "https://api.openai.com";

pub struct OpenAIAdapter;

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<RequestMessage<'a>>,
    stream: bool,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Serialize)]
struct RequestMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct StreamFrame {
    #[serde(default)]
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: Option<StreamDelta>,
}

#[derive(Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

fn base_url(req: &CompleteRequest) -> Result<String, AdapterError> {
    if let Some(b) = req.base_url.as_deref() {
        if !b.is_empty() {
            return Ok(b.trim_end_matches('/').to_string());
        }
    }
    if req.provider == AIProvider::Openai {
        return Ok(OPENAI_BASE.to_string());
    }
    Err(AdapterError::MissingBaseUrl { provider: req.provider })
}

fn build_request(req: &CompleteRequest) -> ChatRequest<'_> {
    ChatRequest {
        model: &req.model,
        messages: req
            .messages
            .iter()
            .map(|m| RequestMessage {
                role: match m.role {
                    ChatRole::User => "user",
                    ChatRole::Assistant => "assistant",
                    ChatRole::System => "system",
                },
                content: &m.content,
            })
            .collect(),
        stream: true,
        temperature: req.temperature.clamp(0.0, 2.0),
        max_tokens: req.max_tokens,
    }
}

#[async_trait]
impl Adapter for OpenAIAdapter {
    async fn stream(
        &self,
        req: CompleteRequest,
    ) -> Result<BoxStream<'static, Result<CompletionChunk, AdapterError>>, AdapterError> {
        let url = format!("{}/v1/chat/completions", base_url(&req)?);
        let body = serde_json::to_vec(&build_request(&req))?;
        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", req.api_key))
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(AdapterError::HttpStatus { status: status.as_u16(), message: text });
        }

        // OpenAI streams Server-Sent Events: each frame begins with `data: `
        // and the terminal frame is `data: [DONE]`. We parse incrementally
        // by buffering until a newline.
        let raw = response.bytes_stream();
        let stream = sse_lines(raw).filter_map(|line_result| async move {
            let line = match line_result {
                Ok(l) => l,
                Err(err) => return Some(Err(err)),
            };
            let payload = line.strip_prefix("data: ")?;
            if payload.trim() == "[DONE]" {
                return None;
            }
            let frame: StreamFrame = match serde_json::from_str(payload) {
                Ok(f) => f,
                Err(_) => return None, // skip malformed lines rather than killing the stream
            };
            let text = frame
                .choices
                .into_iter()
                .next()?
                .delta
                .and_then(|d| d.content)
                .unwrap_or_default();
            if text.is_empty() {
                return None;
            }
            Some(Ok(CompletionChunk { text }))
        });
        Ok(Box::pin(stream))
    }

    async fn ping(&self, req: CompleteRequest) -> Result<Option<String>, AdapterError> {
        // OpenAI's `/v1/models` doesn't require streaming. We just hit it
        // and look for the configured model in the response.
        let url = format!("{}/v1/models", base_url(&req)?);
        let response = reqwest::Client::new()
            .get(&url)
            .header("Authorization", format!("Bearer {}", req.api_key))
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(AdapterError::HttpStatus { status: status.as_u16(), message: text });
        }
        #[derive(Deserialize)]
        struct ModelsResp {
            data: Vec<ModelEntry>,
        }
        #[derive(Deserialize)]
        struct ModelEntry {
            id: String,
        }
        let parsed: ModelsResp = response.json().await?;
        Ok(parsed.data.into_iter().map(|m| m.id).find(|id| id == &req.model).or(Some(req.model)))
    }
}

/// Convert a stream of raw byte chunks into a stream of `\n`-terminated
/// lines (UTF-8). Tolerates server flushes mid-line.
fn sse_lines<S, E>(stream: S) -> impl Stream<Item = Result<String, AdapterError>>
where
    S: Stream<Item = Result<bytes::Bytes, E>>,
    E: Into<AdapterError>,
{
    async_stream::stream! {
        let mut buf = String::new();
        let mut stream = std::pin::pin!(stream);
        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(b) => b,
                Err(err) => {
                    yield Err(err.into());
                    return;
                }
            };
            match std::str::from_utf8(&chunk) {
                Ok(s) => buf.push_str(s),
                Err(err) => {
                    warn!(?err, "non-utf8 chunk from provider");
                    continue;
                }
            }
            while let Some(idx) = buf.find('\n') {
                let line: String = buf.drain(..=idx).collect();
                let trimmed = line.trim_end_matches('\n').trim_end_matches('\r').to_string();
                if !trimmed.is_empty() {
                    yield Ok(trimmed);
                }
            }
        }
        let leftover = buf.trim();
        if !leftover.is_empty() {
            yield Ok(leftover.to_string());
        }
    }
}
