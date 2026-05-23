//! AI configuration + completion dispatch.
//!
//! Mirrors `server/src/services/aiService.ts`. Config lives in
//! `users.ai_config` (JSONB) so reads/writes are a single row lookup.
//! The completion endpoint:
//!
//!   1. Loads the user's saved config (provider/model/baseUrl/key).
//!   2. Decrypts the API key.
//!   3. Builds the chat messages (system prompt + selection + history).
//!   4. Dispatches to the right [`scribe_ai::Adapter`] and returns its
//!      token stream straight back to the route handler.

use chrono::Utc;
use futures::stream::BoxStream;
use scribe_ai::{adapter_for, system_prompt, AdapterError, CompleteRequest, CompletionChunk, CryptoBox};
use scribe_shared::{
    mask_api_key, AICompleteInput, AIConfigPublic, AIConfigStored, AIPingResult, AIProvider,
    ApiError, ApiResult, ChatMessage, ChatRole, ErrorCode, UpdateAIConfigInput, UserId,
};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Instant;
use tracing::warn;

#[derive(Clone)]
pub struct AIService {
    pool: PgPool,
    crypto: Arc<CryptoBox>,
}

impl AIService {
    pub fn new(pool: PgPool, crypto: Arc<CryptoBox>) -> Self {
        Self { pool, crypto }
    }

    /// Public-facing config for the current user. `None` if they haven't
    /// configured a provider yet.
    pub async fn get_config(&self, user: UserId) -> ApiResult<Option<AIConfigPublic>> {
        let stored = self.load_stored(user).await?;
        Ok(stored.map(|s| s.to_public()))
    }

    pub async fn update_config(
        &self,
        user: UserId,
        input: UpdateAIConfigInput,
    ) -> ApiResult<AIConfigPublic> {
        if input.provider.needs_base_url()
            && input.base_url.as_deref().map(str::is_empty).unwrap_or(true)
        {
            return Err(ApiError::validation(format!(
                "{} requires a baseUrl",
                input.provider.as_str()
            )));
        }

        let mut stored = self.load_stored(user).await?.unwrap_or_else(|| AIConfigStored {
            provider: input.provider,
            model: input.model.clone(),
            base_url: None,
            api_key_encrypted: None,
            api_key_preview: None,
            updated_at: None,
        });
        stored.provider = input.provider;
        stored.model = input.model;
        stored.base_url = input.base_url;
        if let Some(plain) = input.api_key.as_deref() {
            let encrypted = self
                .crypto
                .encrypt(plain)
                .map_err(|err| ApiError::internal(format!("encrypt: {err}")))?;
            stored.api_key_encrypted = Some(encrypted);
            stored.api_key_preview = Some(mask_api_key(plain));
        }
        stored.updated_at = Some(Utc::now().to_rfc3339());

        let payload = serde_json::to_value(&stored).map_err(internal_serde)?;
        sqlx::query("update public.users set ai_config = $2 where id = $1")
            .bind(user.into_inner())
            .bind(payload)
            .execute(&self.pool)
            .await
            .map_err(internal_db)?;
        Ok(stored.to_public())
    }

    /// Verify the user's saved config by talking to the provider. Doesn't
    /// throw — failures land in the `error` field of the returned struct.
    pub async fn ping(&self, user: UserId) -> ApiResult<AIPingResult> {
        let Some(stored) = self.load_stored(user).await? else {
            return Ok(AIPingResult {
                ok: false,
                model: None,
                latency_ms: 0,
                error: Some("AI not configured".into()),
            });
        };
        let Some(api_key) = self.decrypt_key(&stored)? else {
            return Ok(AIPingResult {
                ok: false,
                model: None,
                latency_ms: 0,
                error: Some("API key not set".into()),
            });
        };
        let req = CompleteRequest {
            provider: stored.provider,
            model: stored.model.clone(),
            base_url: stored.base_url.clone(),
            api_key,
            messages: Vec::new(),
            temperature: 0.0,
            max_tokens: Some(1),
        };
        let start = Instant::now();
        let adapter = adapter_for(stored.provider);
        let result = adapter.ping(req).await;
        let latency_ms = start.elapsed().as_millis() as u64;
        match result {
            Ok(model) => Ok(AIPingResult { ok: true, model, latency_ms, error: None }),
            Err(err) => Ok(AIPingResult {
                ok: false,
                model: Some(stored.model),
                latency_ms,
                error: Some(err.to_string()),
            }),
        }
    }

    /// Build a token stream for the requested completion. The route
    /// handler converts this into SSE frames.
    pub async fn complete_stream(
        &self,
        user: UserId,
        input: AICompleteInput,
    ) -> ApiResult<BoxStream<'static, Result<CompletionChunk, AdapterError>>> {
        let stored = self
            .load_stored(user)
            .await?
            .ok_or_else(|| ApiError::new(ErrorCode::Forbidden, "AI not configured"))?;
        let api_key = self
            .decrypt_key(&stored)?
            .ok_or_else(|| ApiError::new(ErrorCode::Forbidden, "API key not set"))?;

        let system = system_prompt(input.feature);
        let mut messages: Vec<ChatMessage> = Vec::new();
        messages.push(ChatMessage { role: ChatRole::System, content: system.to_string() });
        for h in input.history.unwrap_or_default() {
            messages.push(h);
        }
        if !input.selection.is_empty() {
            messages.push(ChatMessage { role: ChatRole::User, content: input.selection });
        }

        let req = CompleteRequest {
            provider: stored.provider,
            model: stored.model,
            base_url: stored.base_url,
            api_key,
            messages,
            temperature: 0.4,
            max_tokens: Some(2048),
        };
        let adapter = adapter_for(stored.provider);
        adapter
            .stream(req)
            .await
            .map_err(|err| ApiError::new(ErrorCode::ServiceUnavailable, format!("ai stream: {err}")))
    }

    async fn load_stored(&self, user: UserId) -> ApiResult<Option<AIConfigStored>> {
        let row: Option<serde_json::Value> = sqlx::query_scalar(
            "select ai_config from public.users where id = $1",
        )
        .bind(user.into_inner())
        .fetch_optional(&self.pool)
        .await
        .map_err(internal_db)?
        .flatten();
        match row {
            None => Ok(None),
            Some(v) => match serde_json::from_value::<AIConfigStored>(v) {
                Ok(parsed) => Ok(Some(parsed)),
                Err(err) => {
                    warn!(?err, "ai_config row failed to parse; treating as unset");
                    Ok(None)
                }
            },
        }
    }

    fn decrypt_key(&self, stored: &AIConfigStored) -> ApiResult<Option<String>> {
        let Some(encrypted) = stored.api_key_encrypted.as_deref() else {
            return Ok(None);
        };
        if encrypted.is_empty() {
            return Ok(None);
        }
        match self.crypto.decrypt(encrypted) {
            Ok(plain) => Ok(Some(plain)),
            Err(err) => Err(ApiError::new(
                ErrorCode::Internal,
                format!("api key decrypt failed: {err}"),
            )),
        }
    }
}

// Helper: ai_config column reads come back as Option<JsonValue> where the
// outer Option is "row missing", and the JsonValue may itself be Json
// null. Flatten the two.
trait FlattenJson {
    fn flatten(self) -> Option<serde_json::Value>;
}
impl FlattenJson for Option<serde_json::Value> {
    fn flatten(self) -> Option<serde_json::Value> {
        match self {
            None => None,
            Some(v) if v.is_null() => None,
            Some(v) => Some(v),
        }
    }
}

fn internal_db(err: sqlx::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("db: {err}"))
}
fn internal_serde(err: serde_json::Error) -> ApiError {
    ApiError::new(ErrorCode::Internal, format!("json: {err}"))
}

/// Provider used by the route layer so the AppState doesn't need to
/// hold every adapter — just the crypto box + db pool. (Apparently
/// unused here, but exported for symmetry with the other services.)
#[allow(dead_code)]
pub fn providers() -> &'static [AIProvider] {
    &[
        AIProvider::Openai,
        AIProvider::Anthropic,
        AIProvider::Gemini,
        AIProvider::Ollama,
        AIProvider::Lmstudio,
        AIProvider::OpenaiCompatible,
    ]
}
