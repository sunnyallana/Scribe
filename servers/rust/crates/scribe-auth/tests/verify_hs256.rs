//! End-to-end-ish test: mint an HS256 token with a known secret, verify
//! it round-trips through `TokenVerifier` into a populated `AuthUser`.

use chrono::Utc;
use jsonwebtoken::{encode, EncodingKey, Header};
use scribe_auth::{AuthRole, TokenVerifier};
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize)]
struct TestClaims {
    sub: Uuid,
    email: String,
    role: String,
    exp: i64,
    iat: i64,
}

#[tokio::test]
async fn verifies_hs256_token_with_static_secret() {
    let secret = "super-secret-hs256-only-for-tests";
    let user_id = Uuid::new_v4();
    let now = Utc::now().timestamp();
    let claims = TestClaims {
        sub: user_id,
        email: "alice@example.com".into(),
        role: "authenticated".into(),
        iat: now,
        exp: now + 3600,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .expect("encode HS256");

    let verifier = TokenVerifier::new(Some(secret), None);
    let user = verifier.verify(&token).await.expect("verify ok");

    assert_eq!(user.id.into_inner(), user_id);
    assert_eq!(user.email.as_deref(), Some("alice@example.com"));
    assert_eq!(user.role, AuthRole::Authenticated);
}

#[tokio::test]
async fn rejects_token_signed_with_wrong_secret() {
    let claims = TestClaims {
        sub: Uuid::new_v4(),
        email: "alice@example.com".into(),
        role: "authenticated".into(),
        iat: Utc::now().timestamp(),
        exp: Utc::now().timestamp() + 3600,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(b"a-different-secret"),
    )
    .expect("encode HS256");

    let verifier = TokenVerifier::new(Some("the-real-secret"), None);
    let result = verifier.verify(&token).await;
    assert!(result.is_err(), "expected verification to fail");
}

#[tokio::test]
async fn rejects_expired_token() {
    let claims = TestClaims {
        sub: Uuid::new_v4(),
        email: "alice@example.com".into(),
        role: "authenticated".into(),
        iat: Utc::now().timestamp() - 7200,
        exp: Utc::now().timestamp() - 3600,
    };
    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(b"shared"),
    )
    .expect("encode HS256");

    let verifier = TokenVerifier::new(Some("shared"), None);
    let result = verifier.verify(&token).await;
    assert!(result.is_err(), "expected expiry to be enforced");
}
