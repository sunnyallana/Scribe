//! Anthropic Messages API adapter.
//!
//! Differences from OpenAI:
//!   * Endpoint is `/v1/messages`.
//!   * System prompt goes in a top-level `system` field (not a message).
//!   * Auth header is `x-api-key`, plus `anthropic-version: 2023-06-01`.
//!   * Streaming format is SSE with multiple event types; we care about
//!     `content_block_delta` carrying a `text_delta`.

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use scribe_shared::ChatRole;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::adapter::{Adapter, AdapterError, CompleteRequest, CompletionChunk};

const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicAdapter;

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<&'a str>,
    messages: Vec<RequestMessage<'a>>,
    stream: bool,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Serialize)]
struct RequestMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum StreamEvent {
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { delta: Delta },
    #[serde(rename = "message_delta")]
    MessageDelta {},
    #[serde(rename = "message_stop")]
    MessageStop {},
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Delta {
    #[serde(rename = "text_delta")]
    TextDelta { text: String },
    #[serde(other)]
    Other,
}

fn base_url(req: &CompleteRequest) -> String {
    req.base_url
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(|b| b.trim_end_matches('/').to_string())
        .unwrap_or_else(|| ANTHROPIC_BASE.to_string())
}

fn build_request<'a>(req: &'a CompleteRequest) -> MessagesRequest<'a> {
    let mut system: Option<&'a str> = None;
    let mut messages: Vec<RequestMessage<'a>> = Vec::with_capacity(req.messages.len());
    for m in &req.messages {
        match m.role {
            ChatRole::System => {
                // Anthropic only allows one `system` field; the last
                // system message wins. (Multiple consecutive system
                // messages are rare in our prompts.)
                system = Some(m.content.as_str());
            }
            ChatRole::User => messages.push(RequestMessage { role: "user", content: &m.content }),
            ChatRole::Assistant => {
                messages.push(RequestMessage { role: "assistant", content: &m.content })
            }
        }
    }
    MessagesRequest {
        model: &req.model,
        system,
        messages,
        stream: true,
        temperature: req.temperature.clamp(0.0, 1.0),
        max_tokens: req.max_tokens.unwrap_or(2048),
    }
}

#[async_trait]
impl Adapter for AnthropicAdapter {
    async fn stream(
        &self,
        req: CompleteRequest,
    ) -> Result<BoxStream<'static, Result<CompletionChunk, AdapterError>>, AdapterError> {
        let url = format!("{}/v1/messages", base_url(&req));
        let body = serde_json::to_vec(&build_request(&req))?;
        let response = reqwest::Client::new()
            .post(&url)
            .header("x-api-key", &req.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(AdapterError::HttpStatus { status: status.as_u16(), message: text });
        }

        let raw = response.bytes_stream();
        let stream = anthropic_sse(raw).filter_map(|result| async move {
            let line = match result {
                Ok(l) => l,
                Err(err) => return Some(Err(err)),
            };
            let payload = line.strip_prefix("data: ")?;
            if payload.trim() == "[DONE]" {
                return None;
            }
            let event: StreamEvent = match serde_json::from_str(payload) {
                Ok(e) => e,
                Err(_) => return None,
            };
            match event {
                StreamEvent::ContentBlockDelta { delta: Delta::TextDelta { text } } => {
                    if text.is_empty() { None } else { Some(Ok(CompletionChunk { text })) }
                }
                _ => None,
            }
        });
        Ok(Box::pin(stream))
    }

    async fn ping(&self, req: CompleteRequest) -> Result<Option<String>, AdapterError> {
        // Anthropic has no `models` listing; emit a tiny non-streaming
        // request and verify it returns 200.
        let url = format!("{}/v1/messages", base_url(&req));
        let payload = serde_json::json!({
            "model": req.model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        });
        let response = reqwest::Client::new()
            .post(&url)
            .header("x-api-key", &req.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(AdapterError::HttpStatus { status: status.as_u16(), message: text });
        }
        Ok(Some(req.model))
    }
}

fn anthropic_sse<S, E>(stream: S) -> impl futures::Stream<Item = Result<String, AdapterError>>
where
    S: futures::Stream<Item = Result<bytes::Bytes, E>>,
    E: Into<AdapterError>,
{
    async_stream::stream! {
        let mut buf = String::new();
        let mut stream = std::pin::pin!(stream);
        while let Some(chunk_result) = stream.next().await {
            let chunk = match chunk_result {
                Ok(b) => b,
                Err(err) => { yield Err(err.into()); return }
            };
            match std::str::from_utf8(&chunk) {
                Ok(s) => buf.push_str(s),
                Err(err) => { warn!(?err, "non-utf8 chunk from anthropic"); continue }
            }
            while let Some(idx) = buf.find('\n') {
                let line: String = buf.drain(..=idx).collect();
                let trimmed = line.trim_end_matches('\n').trim_end_matches('\r').to_string();
                if !trimmed.is_empty() {
                    yield Ok(trimmed);
                }
            }
        }
    }
}
