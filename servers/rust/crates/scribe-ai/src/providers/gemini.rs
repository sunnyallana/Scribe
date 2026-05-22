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
