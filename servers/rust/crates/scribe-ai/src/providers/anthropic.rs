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

#[cfg(test)]
mod tests {
    use super::*;
    use scribe_shared::{AIProvider, ChatMessage, ChatRole};

    fn sample_request(base_url: Option<&str>) -> CompleteRequest {
        CompleteRequest {
            provider: AIProvider::Anthropic,
            model: "claude-sonnet-4-6".into(),
            base_url: base_url.map(String::from),
            api_key: "sk-ant-test".into(),
            messages: vec![
                ChatMessage { role: ChatRole::System, content: "be concise".into() },
                ChatMessage { role: ChatRole::User, content: "hello".into() },
            ],
            temperature: 0.4,
            max_tokens: Some(512),
        }
    }

    #[test]
    fn base_url_defaults_to_anthropic() {
        let req = sample_request(None);
        assert_eq!(base_url(&req), ANTHROPIC_BASE);
    }

    #[test]
    fn base_url_strips_trailing_slash() {
        let req = sample_request(Some("https://proxy.example.com/"));
        assert_eq!(base_url(&req), "https://proxy.example.com");
    }

    #[test]
    fn base_url_treats_empty_string_as_unset() {
        let req = sample_request(Some(""));
        assert_eq!(base_url(&req), ANTHROPIC_BASE);
    }

    #[test]
    fn build_request_lifts_system_to_top_level() {
        // Anthropic's wire format is the main difference from OpenAI:
        // the system prompt is a top-level `system` field, NOT a message.
        // A regression here would route the system prompt as the first
        // user turn — wrong answers + likely a 400 from Anthropic.
        let req = sample_request(None);
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert_eq!(json["system"], "be concise");
        assert_eq!(json["messages"][0]["role"], "user");
        assert_eq!(json["messages"][0]["content"], "hello");
        assert_eq!(json["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn build_request_omits_system_when_no_system_message() {
        let mut req = sample_request(None);
        req.messages = vec![ChatMessage { role: ChatRole::User, content: "hi".into() }];
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert!(json.get("system").is_none(), "system field must be omitted when no system message");
    }

    #[test]
    fn build_request_last_system_message_wins() {
        // Anthropic only allows one `system` field. When multiple system
        // messages exist (rare but possible), the last one wins.
        let mut req = sample_request(None);
        req.messages = vec![
            ChatMessage { role: ChatRole::System, content: "first".into() },
            ChatMessage { role: ChatRole::User, content: "q".into() },
            ChatMessage { role: ChatRole::System, content: "second".into() },
        ];
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert_eq!(json["system"], "second");
    }

    #[test]
    fn build_request_clamps_temperature_to_anthropic_range() {
        // Anthropic's range is [0, 1], NOT [0, 2] like OpenAI. Passing
        // a temperature > 1 unclamped would 400 from the API.
        let mut req = sample_request(None);
        req.temperature = 1.7;
        assert_eq!(build_request(&req).temperature, 1.0);
        req.temperature = -0.2;
        assert_eq!(build_request(&req).temperature, 0.0);
    }

    #[test]
    fn build_request_defaults_max_tokens_to_2048() {
        // Anthropic REQUIRES `max_tokens` on every Messages request —
        // it's not optional. The adapter substitutes 2048 when the
        // caller didn't pin a value.
        let mut req = sample_request(None);
        req.max_tokens = None;
        assert_eq!(build_request(&req).max_tokens, 2048);
    }

    #[test]
    fn build_request_maps_chat_roles_to_anthropic_strings() {
        let mut req = sample_request(None);
        req.messages = vec![
            ChatMessage { role: ChatRole::User, content: "q".into() },
            ChatMessage { role: ChatRole::Assistant, content: "a".into() },
        ];
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert_eq!(json["messages"][0]["role"], "user");
        assert_eq!(json["messages"][1]["role"], "assistant");
    }

    #[test]
    fn build_request_marks_stream_true() {
        // Pinning this so an accidental flip to false doesn't silently
        // break the SSE consumer (which would then time-out on the
        // single non-streamed response).
        let req = sample_request(None);
        assert!(build_request(&req).stream);
    }
}
