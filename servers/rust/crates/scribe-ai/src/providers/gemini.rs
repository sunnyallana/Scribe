//! Google Generative Language API (Gemini) adapter.
//!
//! Wire format is closer to a JSON RPC than SSE — the v1beta endpoint
//! returns a stream of newline-separated JSON arrays when you append
//! `?alt=sse&stream=true`. We use `streamGenerateContent?alt=sse` which
//! emits one valid `data: {...}` frame per chunk just like OpenAI.

use async_trait::async_trait;
use futures::stream::{BoxStream, StreamExt};
use scribe_shared::ChatRole;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::adapter::{Adapter, AdapterError, CompleteRequest, CompletionChunk};

const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com";

pub struct GeminiAdapter;

#[derive(Serialize)]
struct GenerateRequest<'a> {
    contents: Vec<Content<'a>>,
    #[serde(rename = "systemInstruction", skip_serializing_if = "Option::is_none")]
    system_instruction: Option<Content<'a>>,
    #[serde(rename = "generationConfig")]
    generation_config: GenerationConfig,
}

#[derive(Serialize)]
struct Content<'a> {
    role: &'a str,
    parts: Vec<Part<'a>>,
}

#[derive(Serialize)]
struct Part<'a> {
    text: &'a str,
}

#[derive(Serialize)]
struct GenerationConfig {
    temperature: f32,
    #[serde(rename = "maxOutputTokens", skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct StreamFrame {
    #[serde(default)]
    candidates: Vec<Candidate>,
}

#[derive(Deserialize)]
struct Candidate {
    #[serde(default)]
    content: Option<CandidateContent>,
}

#[derive(Deserialize)]
struct CandidateContent {
    #[serde(default)]
    parts: Vec<CandidatePart>,
}

#[derive(Deserialize)]
struct CandidatePart {
    #[serde(default)]
    text: Option<String>,
}

fn base_url(req: &CompleteRequest) -> String {
    req.base_url
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(|b| b.trim_end_matches('/').to_string())
        .unwrap_or_else(|| GEMINI_BASE.to_string())
}

fn build_request<'a>(req: &'a CompleteRequest) -> GenerateRequest<'a> {
    let mut contents: Vec<Content<'a>> = Vec::new();
    let mut system: Option<&'a str> = None;
    for m in &req.messages {
        match m.role {
            ChatRole::System => system = Some(m.content.as_str()),
            ChatRole::User => contents.push(Content {
                role: "user",
                parts: vec![Part { text: &m.content }],
            }),
            ChatRole::Assistant => contents.push(Content {
                role: "model",
                parts: vec![Part { text: &m.content }],
            }),
        }
    }
    GenerateRequest {
        contents,
        system_instruction: system.map(|text| Content {
            role: "system",
            parts: vec![Part { text }],
        }),
        generation_config: GenerationConfig {
            temperature: req.temperature.clamp(0.0, 1.0),
            max_output_tokens: req.max_tokens,
        },
    }
}

#[async_trait]
impl Adapter for GeminiAdapter {
    async fn stream(
        &self,
        req: CompleteRequest,
    ) -> Result<BoxStream<'static, Result<CompletionChunk, AdapterError>>, AdapterError> {
        // `streamGenerateContent` with `alt=sse` gives a clean
        // `data: {...}\n` stream — much easier to parse than the default
        // chunked JSON array.
        let url = format!(
            "{}/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
            base_url(&req),
            req.model,
            req.api_key,
        );
        let body = serde_json::to_vec(&build_request(&req))?;
        let response = reqwest::Client::new()
            .post(&url)
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
        let stream = gemini_sse(raw).filter_map(|result| async move {
            let line = match result {
                Ok(l) => l,
                Err(err) => return Some(Err(err)),
            };
            let payload = line.strip_prefix("data: ")?;
            let frame: StreamFrame = match serde_json::from_str(payload) {
                Ok(f) => f,
                Err(_) => return None,
            };
            let text: String = frame
                .candidates
                .into_iter()
                .next()?
                .content?
                .parts
                .into_iter()
                .filter_map(|p| p.text)
                .collect();
            if text.is_empty() { None } else { Some(Ok(CompletionChunk { text })) }
        });
        Ok(Box::pin(stream))
    }

    async fn ping(&self, req: CompleteRequest) -> Result<Option<String>, AdapterError> {
        // GET /v1beta/models/{model}?key=… returns a JSON record with the model name.
        let url = format!(
            "{}/v1beta/models/{}?key={}",
            base_url(&req),
            req.model,
            req.api_key,
        );
        let response = reqwest::Client::new().get(&url).send().await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(AdapterError::HttpStatus { status: status.as_u16(), message: text });
        }
        Ok(Some(req.model))
    }
}

fn gemini_sse<S, E>(stream: S) -> impl futures::Stream<Item = Result<String, AdapterError>>
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
                Err(err) => { warn!(?err, "non-utf8 chunk from gemini"); continue }
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
            provider: AIProvider::Gemini,
            model: "gemini-1.5-pro".into(),
            base_url: base_url.map(String::from),
            api_key: "ga-test".into(),
            messages: vec![
                ChatMessage { role: ChatRole::System, content: "be terse".into() },
                ChatMessage { role: ChatRole::User, content: "hi".into() },
            ],
            temperature: 0.6,
            max_tokens: Some(256),
        }
    }

    #[test]
    fn base_url_defaults_to_gemini() {
        let req = sample_request(None);
        assert_eq!(base_url(&req), GEMINI_BASE);
    }

    #[test]
    fn base_url_strips_trailing_slash_and_honours_override() {
        let req = sample_request(Some("https://generativelanguage.example.test/"));
        assert_eq!(base_url(&req), "https://generativelanguage.example.test");
    }

    #[test]
    fn build_request_lifts_system_to_system_instruction_field() {
        // Gemini's wire format: system prompts go in a top-level
        // `systemInstruction` object with a "system" role and a parts
        // array. Pin this so a refactor that drops the `Content` struct
        // doesn't quietly change the shape.
        let req = sample_request(None);
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert_eq!(json["systemInstruction"]["role"], "system");
        assert_eq!(json["systemInstruction"]["parts"][0]["text"], "be terse");
    }

    #[test]
    fn build_request_omits_system_instruction_when_no_system_message() {
        let mut req = sample_request(None);
        req.messages = vec![ChatMessage { role: ChatRole::User, content: "hi".into() }];
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert!(json.get("systemInstruction").is_none());
    }

    #[test]
    fn build_request_maps_assistant_role_to_model() {
        // Gemini uses "model" for what OpenAI / Anthropic call
        // "assistant". A regression here would 400 with "invalid role".
        let mut req = sample_request(None);
        req.messages = vec![
            ChatMessage { role: ChatRole::User, content: "q".into() },
            ChatMessage { role: ChatRole::Assistant, content: "a".into() },
        ];
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert_eq!(json["contents"][0]["role"], "user");
        assert_eq!(json["contents"][1]["role"], "model");
    }

    #[test]
    fn build_request_wraps_text_in_parts_array() {
        // Each Content has `parts: [{ text: "..." }]`. The text doesn't
        // live as a string directly — that'd be a different (older)
        // shape Google has since deprecated.
        let req = sample_request(None);
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert_eq!(json["contents"][0]["parts"][0]["text"], "hi");
    }

    #[test]
    fn build_request_clamps_temperature_to_gemini_range() {
        // Gemini's documented range is [0, 1] for most v1beta models.
        let mut req = sample_request(None);
        req.temperature = 1.7;
        assert_eq!(build_request(&req).generation_config.temperature, 1.0);
        req.temperature = -0.5;
        assert_eq!(build_request(&req).generation_config.temperature, 0.0);
    }

    #[test]
    fn build_request_emits_max_output_tokens_under_camelcase_key() {
        // `#[serde(rename = "maxOutputTokens")]` is what Google's API
        // expects; the snake_case Rust field would be silently ignored.
        let req = sample_request(None);
        let json = serde_json::to_value(build_request(&req)).unwrap();
        assert_eq!(json["generationConfig"]["maxOutputTokens"], 256);
    }
}
