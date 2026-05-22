//! Concrete AI provider adapters. Each exposes a struct that
//! implements [`crate::adapter::Adapter`].

pub mod anthropic;
pub mod gemini;
pub mod openai;
