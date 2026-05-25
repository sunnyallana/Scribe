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

#[cfg(test)]
mod tests {
    use super::*;
    use scribe_shared::{AIProvider, ChatMessage, ChatRole};

    fn sample_request(provider: AIProvider, base_url: Option<&str>) -> CompleteRequest {
        CompleteRequest {
            provider,
            model: "gpt-4o-mini".into(),
            base_url: base_url.map(String::from),
            api_key: "sk-test".into(),
            messages: vec![
                ChatMessage { role: ChatRole::System, content: "you are helpful".into() },
                ChatMessage { role: ChatRole::User, content: "say hi".into() },
            ],
            temperature: 0.5,
            max_tokens: Some(128),
        }
    }

    #[test]
    fn base_url_defaults_to_openai_for_openai_provider() {
        let req = sample_request(AIProvider::Openai, None);
        assert_eq!(base_url(&req).unwrap(), OPENAI_BASE);
    }

    #[test]
    fn base_url_uses_override_when_provided() {
        let req = sample_request(AIProvider::Openai, Some("http://localhost:11434/"));
        // Trailing slash must be stripped so the `/v1/chat/completions`
        // append doesn't double-slash and 404 on strict routers.
        assert_eq!(base_url(&req).unwrap(), "http://localhost:11434");
    }

    #[test]
    fn base_url_ignores_empty_override() {
        // Empty string is treated as "not configured" — important for
        // env-var-driven configs where the variable exists but is "".
        let req = sample_request(AIProvider::Openai, Some(""));
        assert_eq!(base_url(&req).unwrap(), OPENAI_BASE);
    }

    #[test]
    fn base_url_requires_override_for_local_providers() {
        // Ollama / LM Studio / openai-compatible have no canonical base
        // — the user MUST supply one. Returning an error here surfaces
        // the misconfig as a 400 to the client rather than a confusing
        // DNS failure to openai.com.
        for provider in [AIProvider::Ollama, AIProvider::Lmstudio, AIProvider::OpenaiCompatible] {
            let req = sample_request(provider, None);
            assert!(
                matches!(base_url(&req), Err(AdapterError::MissingBaseUrl { provider: p }) if p == provider),
                "provider {:?} should require base_url",
                provider
            );
        }
    }

    #[test]
    fn build_request_emits_canonical_openai_body() {
        // Pin the wire format. OpenAI's Chat Completions API expects:
        //   { model, messages: [{role, content}], stream, temperature, max_tokens }
        // System messages stay in the `messages` array (unlike Anthropic).
        let req = sample_request(AIProvider::Openai, None);
        let body = build_request(&req);
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["model"], "gpt-4o-mini");
        assert_eq!(json["stream"], true);
        assert_eq!(json["temperature"], 0.5);
        assert_eq!(json["max_tokens"], 128);
        assert_eq!(json["messages"][0]["role"], "system");
        assert_eq!(json["messages"][0]["content"], "you are helpful");
        assert_eq!(json["messages"][1]["role"], "user");
        assert_eq!(json["messages"][1]["content"], "say hi");
    }

    #[test]
    fn build_request_clamps_temperature_to_openai_range() {
        // OpenAI rejects temperatures outside [0, 2]. The adapter clamps
        // so an over-eager caller (or a coercion bug elsewhere) doesn't
        // get a 400 from the upstream.
        let mut req = sample_request(AIProvider::Openai, None);
        req.temperature = 5.0;
        assert_eq!(build_request(&req).temperature, 2.0);
        req.temperature = -1.0;
        assert_eq!(build_request(&req).temperature, 0.0);
    }

    #[test]
    fn build_request_omits_max_tokens_when_none() {
        // The field is `skip_serializing_if = "Option::is_none"` so that
        // OpenAI uses its own default rather than the adapter forcing
        // an arbitrary cap.
        let mut req = sample_request(AIProvider::Openai, None);
        req.max_tokens = None;
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert!(json.get("max_tokens").is_none(), "max_tokens must be omitted when None");
    }

    #[test]
    fn build_request_maps_assistant_role() {
        let mut req = sample_request(AIProvider::Openai, None);
        req.messages = vec![
            ChatMessage { role: ChatRole::User, content: "q".into() },
            ChatMessage { role: ChatRole::Assistant, content: "a".into() },
            ChatMessage { role: ChatRole::User, content: "q2".into() },
        ];
        let json = serde_json::to_value(build_request(&req)).unwrap();
        let roles: Vec<&str> =
            json["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
    }
}
