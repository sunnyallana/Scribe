//! Supabase Storage client over the REST API.
//!
//! Supabase Storage is S3-compatible under the hood but exposes a
//! REST surface with bearer auth, so we don't need an S3 signer. This
//! mirrors what `@supabase/supabase-js`'s `storage.from(bucket).*` calls
//! do, just spelled out with `reqwest`. Endpoints used:
//!
//! | op           | method | path                                              |
//! |--------------|--------|---------------------------------------------------|
//! | upload       | POST   | `/storage/v1/object/{bucket}/{key}`               |
//! | download     | GET    | `/storage/v1/object/{bucket}/{key}`               |
//! | sign         | POST   | `/storage/v1/object/sign/{bucket}/{key}`          |
//! | remove (bulk)| DELETE | `/storage/v1/object/{bucket}` (body: prefixes[])  |

use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use scribe_shared::{ApiError, ApiResult, ErrorCode};
use serde::{Deserialize, Serialize};
use tracing::debug;

/// Abstraction over an object store. `SupabaseStorage` is the only
/// implementation today; a direct-S3 or filesystem backend can slot in
/// behind the same trait later for self-hosted deployments.
#[async_trait]
pub trait Storage: Send + Sync {
    /// Upload `body` at `key` with the given content type, overwriting
    /// any existing object at that key.
    async fn upload(&self, bucket: &str, key: &str, body: Bytes, content_type: &str)
        -> ApiResult<()>;

    /// Convenience: upload a UTF-8 string as `text/plain; charset=utf-8`.
    async fn upload_text(&self, bucket: &str, key: &str, content: &str) -> ApiResult<()> {
        self.upload(
            bucket,
            key,
            Bytes::from(content.as_bytes().to_vec()),
            "text/plain; charset=utf-8",
        )
        .await
    }

    /// Download the object at `key`. Returns the full body as `Bytes`.
    async fn download(&self, bucket: &str, key: &str) -> ApiResult<Bytes>;

    /// Mint a short-lived signed URL for `key`. The client can fetch the
    /// object directly without going through this server.
    async fn signed_url(&self, bucket: &str, key: &str, expires_in_secs: u32) -> ApiResult<String>;

    /// Bulk-delete. `keys` are absolute object keys (not prefixes).
    async fn remove(&self, bucket: &str, keys: &[String]) -> ApiResult<()>;
}

/// Live Supabase Storage backend.
#[derive(Clone)]
pub struct SupabaseStorage {
    http: Client,
    base_url: String,
    /// Cached `Authorization: Bearer …` header value (service-role JWT).
    auth: HeaderValue,
    /// Cached `apikey` header value. Legacy JWT service keys work with
    /// the Bearer header alone, but the newer `sb_secret_…` API keys
    /// aren't JWTs — the gateway rejects them with "Invalid Compact
    /// JWS" unless the key also rides in `apikey` (supabase-js always
    /// sends both).
    apikey: HeaderValue,
}

impl SupabaseStorage {
    pub fn new(supabase_url: &str, service_role_key: &str) -> ApiResult<Self> {
        let mut auth = HeaderValue::from_str(&format!("Bearer {service_role_key}"))
            .map_err(|err| ApiError::internal(format!("invalid service role key: {err}")))?;
        auth.set_sensitive(true);
        let mut apikey = HeaderValue::from_str(service_role_key)
            .map_err(|err| ApiError::internal(format!("invalid service role key: {err}")))?;
        apikey.set_sensitive(true);

        // Keep the connection pool warm so concurrent download/upload
        // bursts (e.g. 23 project files × HTTPS RTT) multiplex over a
        // single HTTP/2 connection instead of reopening one per call.
        // Without these defaults reqwest tears down idle connections
        // aggressively, which the worker pays for as ~250 ms reconnect
        // cost per request on a cold pool.
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(300))
            .pool_max_idle_per_host(32)
            .tcp_keepalive(Duration::from_secs(60))
            .http2_keep_alive_interval(Duration::from_secs(30))
            .http2_keep_alive_timeout(Duration::from_secs(10))
            .http2_keep_alive_while_idle(true)
            .build()
            .map_err(|err| ApiError::internal(format!("storage http build: {err}")))?;

        Ok(Self {
            http,
            base_url: supabase_url.trim_end_matches('/').to_string(),
            auth,
            apikey,
        })
    }

    fn object_url(&self, bucket: &str, key: &str) -> String {
        format!("{}/storage/v1/object/{}/{}", self.base_url, bucket, key)
    }

    fn sign_url(&self, bucket: &str, key: &str) -> String {
        format!("{}/storage/v1/object/sign/{}/{}", self.base_url, bucket, key)
    }

    fn bulk_url(&self, bucket: &str) -> String {
        format!("{}/storage/v1/object/{}", self.base_url, bucket)
    }

    fn base_headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, self.auth.clone());
        h.insert(HeaderName::from_static("apikey"), self.apikey.clone());
        h
    }
}

#[async_trait]
impl Storage for SupabaseStorage {
    async fn upload(
        &self,
        bucket: &str,
        key: &str,
        body: Bytes,
        content_type: &str,
    ) -> ApiResult<()> {
        debug!(bucket, key, bytes = body.len(), "storage upload");
        let mut headers = self.base_headers();
        headers.insert(CONTENT_TYPE, header(content_type)?);
        headers.insert("x-upsert", HeaderValue::from_static("true"));

        let response = self
            .http
            .post(self.object_url(bucket, key))
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(net_err)?;
        check_status(response, "upload").await.map(|_| ())
    }

    async fn download(&self, bucket: &str, key: &str) -> ApiResult<Bytes> {
        debug!(bucket, key, "storage download");
        let response = self
            .http
            .get(self.object_url(bucket, key))
            .headers(self.base_headers())
            .send()
            .await
            .map_err(net_err)?;
        let response = check_status(response, "download").await?;
        response.bytes().await.map_err(net_err)
    }

    async fn signed_url(&self, bucket: &str, key: &str, expires_in_secs: u32) -> ApiResult<String> {
        #[derive(Serialize)]
        struct Body {
            #[serde(rename = "expiresIn")]
            expires_in: u32,
        }
        #[derive(Deserialize)]
        struct Resp {
            #[serde(rename = "signedURL")]
            signed_url: String,
        }
        debug!(bucket, key, expires_in_secs, "storage sign");
        let response = self
            .http
            .post(self.sign_url(bucket, key))
            .headers(self.base_headers())
            .json(&Body { expires_in: expires_in_secs })
            .send()
            .await
            .map_err(net_err)?;
        let response = check_status(response, "sign").await?;
        let parsed: Resp = response.json().await.map_err(net_err)?;
        // Supabase returns a path like "/object/sign/..." — prefix with
        // the storage base so callers get a directly fetchable URL.
        Ok(format!("{}/storage/v1{}", self.base_url, parsed.signed_url))
    }

    async fn remove(&self, bucket: &str, keys: &[String]) -> ApiResult<()> {
        if keys.is_empty() {
            return Ok(());
        }
        #[derive(Serialize)]
        struct Body<'a> {
            prefixes: &'a [String],
        }
        debug!(bucket, count = keys.len(), "storage remove");
        let response = self
            .http
            .delete(self.bulk_url(bucket))
            .headers(self.base_headers())
            .json(&Body { prefixes: keys })
            .send()
            .await
            .map_err(net_err)?;
        check_status(response, "remove").await.map(|_| ())
    }
}

fn header(value: &str) -> ApiResult<HeaderValue> {
    HeaderValue::from_str(value)
        .map_err(|err| ApiError::internal(format!("invalid header value: {err}")))
}

fn net_err(err: reqwest::Error) -> ApiError {
    if err.is_timeout() {
        ApiError::new(ErrorCode::ServiceUnavailable, format!("storage timeout: {err}"))
    } else {
        ApiError::new(ErrorCode::ServiceUnavailable, format!("storage net: {err}"))
    }
}

async fn check_status(
    response: reqwest::Response,
    op: &str,
) -> ApiResult<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let message = parse_error_message(&body).unwrap_or_else(|| body.clone());
    // Supabase Storage returns 400 with `{"error":"Object not found"}`
    // (and `{"statusCode":"404"}`) for missing objects, instead of a
    // plain HTTP 404. Treat that as NotFound so callers (e.g. the
    // compile artifact-url route) surface a 404 to the SPA rather than
    // a 500 when the synctex object hasn't been uploaded yet.
    let looks_not_found = status == StatusCode::BAD_REQUEST
        && (message.to_ascii_lowercase().contains("not found")
            || body.contains("\"statusCode\":\"404\"")
            || body.contains("\"statusCode\":404"));
    let code = if looks_not_found {
        ErrorCode::NotFound
    } else {
        match status {
            StatusCode::NOT_FOUND => ErrorCode::NotFound,
            StatusCode::UNAUTHORIZED => ErrorCode::Unauthorized,
            StatusCode::FORBIDDEN => ErrorCode::Forbidden,
            StatusCode::CONFLICT => ErrorCode::Conflict,
            StatusCode::PAYLOAD_TOO_LARGE => ErrorCode::PayloadTooLarge,
            s if s.is_server_error() => ErrorCode::ServiceUnavailable,
            _ => ErrorCode::Internal,
        }
    };
    Err(ApiError::new(code, format!("storage {op} ({status}): {message}")))
}

fn parse_error_message(body: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct ErrBody {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        error: Option<String>,
    }
    let parsed: ErrBody = serde_json::from_str(body).ok()?;
    parsed.message.or(parsed.error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_with_valid_inputs() {
        let s = SupabaseStorage::new("https://example.supabase.co/", "sk_test_123").unwrap();
        assert_eq!(s.object_url("b", "k"), "https://example.supabase.co/storage/v1/object/b/k");
        assert_eq!(s.sign_url("b", "k"), "https://example.supabase.co/storage/v1/object/sign/b/k");
        assert_eq!(s.bulk_url("b"), "https://example.supabase.co/storage/v1/object/b");
    }

    #[test]
    fn trims_trailing_slash_from_base() {
        let s = SupabaseStorage::new("https://example.supabase.co///", "k").unwrap();
        assert_eq!(s.object_url("b", "k"), "https://example.supabase.co///storage/v1/object/b/k".replace("///", "/"));
    }

    #[test]
    fn parses_supabase_error_body() {
        assert_eq!(
            parse_error_message(r#"{"statusCode":"404","error":"Not found","message":"Bucket not found"}"#),
            Some("Bucket not found".into()),
        );
        assert_eq!(
            parse_error_message(r#"{"error":"unauthorized"}"#),
            Some("unauthorized".into()),
        );
        assert_eq!(parse_error_message("plain text body"), None);
    }
}
