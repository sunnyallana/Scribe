//! AI provider adapters + AES-256-GCM key envelope.
//!
//! Six providers are supported via three concrete adapters:
//!
//! | provider              | adapter      | wire format           |
//! |-----------------------|--------------|-----------------------|
//! | `openai`              | `openai`     | OpenAI Chat Completions|
//! | `ollama`              | `openai`     | (same; local base URL)|
//! | `lmstudio`            | `openai`     | (same; local base URL)|
//! | `openai-compatible`   | `openai`     | (same; custom base)   |
//! | `anthropic`           | `anthropic`  | Anthropic Messages    |
//! | `gemini`              | `gemini`     | Google v1beta SSE     |
//!
//! See `adapter::adapter_for(provider)` for the dispatch.

pub mod adapter;
pub mod encryption;
pub mod prompts;
pub mod providers;

pub use adapter::{adapter_for, Adapter, AdapterError, CompleteRequest, CompletionChunk};
pub use encryption::{CryptoBox, CryptoError};
pub use prompts::system_prompt;
