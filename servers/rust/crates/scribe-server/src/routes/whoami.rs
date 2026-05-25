//! GET /api/whoami — echoes the authenticated user. Useful for
//! confirming end-to-end auth flow without touching any business data.

use axum::{middleware::from_fn, routing::get, Json, Router};
use scribe_auth::{require_auth, AuthRole, AuthUser, Authenticated};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
struct WhoamiBody {
    id: String,
    email: Option<String>,
    role: AuthRole,
}

pub fn router() -> Router<AppState> {
    // `from_fn(require_auth)` reads the `TokenVerifier` Extension that
    // main.rs attaches at the app root, so we don't have to thread it
    // through here.
    Router::new().route("/api/whoami", get(whoami)).layer(from_fn(require_auth))
}

async fn whoami(Authenticated(user): Authenticated) -> Json<WhoamiBody> {
    let AuthUser { id, email, role, .. } = user;
    Json(WhoamiBody { id: id.to_string(), email, role })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::response_cache::ResponseCache;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use axum::Extension;
    use chrono::Utc;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use scribe_auth::TokenVerifier;
    use serde::Serialize;
    use serde_json::Value;
    use std::sync::Arc;
    use tower::ServiceExt;
    use uuid::Uuid;

    const TEST_HS256_SECRET: &str = "test-only-hs256-secret-do-not-reuse";

    #[derive(Serialize)]
    struct TestClaims {
        sub: Uuid,
        email: String,
        role: String,
        exp: i64,
        iat: i64,
    }

    fn build_app() -> axum::Router {
        let state = AppState::new(
            None,
            None,
            None,
            None,
            ResponseCache::with_flags(None, false, false),
        );
        let verifier = Arc::new(TokenVerifier::new(Some(TEST_HS256_SECRET), None));
        router().with_state(state).layer(Extension(verifier))
    }

    fn mint_token(user_id: Uuid, email: &str, role: &str, ttl_secs: i64) -> String {
        let now = Utc::now().timestamp();
        let claims = TestClaims {
            sub: user_id,
            email: email.into(),
            role: role.into(),
            iat: now,
            exp: now + ttl_secs,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(TEST_HS256_SECRET.as_bytes()),
        )
        .unwrap()
    }

    async fn read_json(body: Body) -> Value {
        let bytes = to_bytes(body, 64 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn rejects_request_without_authorization_header() {
        let response = build_app()
            .oneshot(Request::builder().uri("/api/whoami").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let json = read_json(response.into_body()).await;
        // Pin the error shape: clients dispatch on `code` to decide whether
        // to redirect to /login vs. show a generic error toast.
        assert_eq!(json["code"], "unauthorized");
        assert_eq!(json["message"], "missing bearer token");
    }

    #[tokio::test]
    async fn rejects_non_bearer_scheme() {
        // Basic auth, API-key style, or just a bare value all fail. The
        // middleware only honours `Bearer <token>` (case-insensitive on
        // the scheme word, per RFC 6750).
        for header in ["Basic user:pass", "ApiKey abc123", "abc123"] {
            let response = build_app()
                .oneshot(
                    Request::builder()
                        .uri("/api/whoami")
                        .header("Authorization", header)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "header '{header}' should not be accepted"
            );
        }
    }

    #[tokio::test]
    async fn rejects_empty_bearer() {
        // `Bearer ` with nothing after is technically a parse-able header
        // but the value is empty — we treat it the same as missing.
        let response = build_app()
            .oneshot(
                Request::builder()
                    .uri("/api/whoami")
                    .header("Authorization", "Bearer ")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_garbage_token() {
        // Anything that isn't a valid JWT fails decode and the middleware
        // returns 401, not 500.
        let response = build_app()
            .oneshot(
                Request::builder()
                    .uri("/api/whoami")
                    .header("Authorization", "Bearer not-a-jwt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let json = read_json(response.into_body()).await;
        assert_eq!(json["message"], "invalid or expired token");
    }

    #[tokio::test]
    async fn rejects_token_signed_with_wrong_secret() {
        let user_id = Uuid::new_v4();
        let now = Utc::now().timestamp();
        let claims = TestClaims {
            sub: user_id,
            email: "u@x".into(),
            role: "authenticated".into(),
            iat: now,
            exp: now + 60,
        };
        // Signed with a DIFFERENT secret than the verifier was built with.
        let bad_token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(b"some-other-secret"),
        )
        .unwrap();
        let response = build_app()
            .oneshot(
                Request::builder()
                    .uri("/api/whoami")
                    .header("Authorization", format!("Bearer {bad_token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_expired_token() {
        let user_id = Uuid::new_v4();
        // `ttl_secs = -3600` → expired one hour ago.
        let token = mint_token(user_id, "u@x", "authenticated", -3600);
        let response = build_app()
            .oneshot(
                Request::builder()
                    .uri("/api/whoami")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn accepts_valid_token_and_echoes_user() {
        let user_id = Uuid::new_v4();
        let token = mint_token(user_id, "alice@example.com", "authenticated", 3600);
        let response = build_app()
            .oneshot(
                Request::builder()
                    .uri("/api/whoami")
                    .header("Authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let json = read_json(response.into_body()).await;
        assert_eq!(json["id"], user_id.to_string());
        assert_eq!(json["email"], "alice@example.com");
        assert_eq!(json["role"], "authenticated");
    }

    #[tokio::test]
    async fn accepts_lowercase_bearer_scheme() {
        // RFC 6750: the scheme word is case-insensitive. Browsers and some
        // CLI tools send lowercase; we honour both.
        let user_id = Uuid::new_v4();
        let token = mint_token(user_id, "bob@example.com", "authenticated", 3600);
        let response = build_app()
            .oneshot(
                Request::builder()
                    .uri("/api/whoami")
                    .header("Authorization", format!("bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn maps_role_claim_to_auth_role() {
        // Supabase emits role="authenticated" for signed-in users,
        // role="anon" for the public key, and role="service_role"
        // for the service-role JWT (which should never reach a user
        // request but exists in the mapper). Anything else folds to
        // `Other`. Pin all four cases — serde renames to snake_case.
        for (claim_role, expected) in [
            ("authenticated", "authenticated"),
            ("anon", "anon"),
            ("service_role", "service_role"),
            ("random-string", "other"),
        ] {
            let token = mint_token(Uuid::new_v4(), "u@x", claim_role, 3600);
            let response = build_app()
                .oneshot(
                    Request::builder()
                        .uri("/api/whoami")
                        .header("Authorization", format!("Bearer {token}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "role '{claim_role}'");
            let json = read_json(response.into_body()).await;
            assert_eq!(
                json["role"], expected,
                "claim role '{claim_role}' should map to '{expected}'"
            );
        }
    }
}
