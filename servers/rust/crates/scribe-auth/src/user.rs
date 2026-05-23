//! Authenticated user — what we attach to a request after JWT verification.
//!
//! Mirrors the shape the Node server's `request.user` exposed: a stable
//! `id` (Supabase auth.users.id), the `role` claim, and the raw `email`
//! when present. Anything else from the claims stays on the `Claims`
//! struct (kept around for diagnostics) but isn't routinely consumed.

use scribe_shared::UserId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthRole {
    Anon,
    Authenticated,
    ServiceRole,
    Other,
}

impl AuthRole {
    pub fn from_claim(s: &str) -> Self {
        match s {
            "anon" => Self::Anon,
            "authenticated" => Self::Authenticated,
            "service_role" => Self::ServiceRole,
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub id: UserId,
    pub email: Option<String>,
    pub role: AuthRole,
    /// Original token, retained so downstream code can forward it (e.g.
    /// to Storage requests that need to assert the caller's identity).
    pub token: String,
}

impl AuthUser {
    pub fn is_service_role(&self) -> bool {
        matches!(self.role, AuthRole::ServiceRole)
    }
}

/// Subset of Supabase JWT claims we care about. Anything unrecognised is
/// dropped — Supabase has historically added new optional claims without
/// notice, so we stay forgiving.
#[derive(Debug, Clone, Deserialize)]
pub struct Claims {
    /// Subject — Supabase user UUID (or "anon" for the anonymous key,
    /// which we accept as a missing `sub`).
    #[serde(default)]
    pub sub: Option<Uuid>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    pub exp: i64,
    #[serde(default)]
    pub iat: Option<i64>,
}
