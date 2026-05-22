//! Unified error envelope. Mirrors the TS server's `{ code, message }`
//! response shape so the existing web client doesn't need any changes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ValidationFailed,
    NotFound,
    Unauthorized,
    Forbidden,
    Conflict,
    RateLimited,
    Internal,
    BadRequest,
    PayloadTooLarge,
    ServiceUnavailable,
}

impl ErrorCode {
    pub fn http_status(self) -> u16 {
        match self {
            ErrorCode::ValidationFailed | ErrorCode::BadRequest => 400,
            ErrorCode::Unauthorized => 401,
            ErrorCode::Forbidden => 403,
            ErrorCode::NotFound => 404,
            ErrorCode::Conflict => 409,
            ErrorCode::PayloadTooLarge => 413,
            ErrorCode::RateLimited => 429,
            ErrorCode::Internal => 500,
            ErrorCode::ServiceUnavailable => 503,
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Forbidden, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unauthorized, message)
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ValidationFailed, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

/// Body returned to clients on error. Stable JSON shape — matches the
/// existing TS server.
#[derive(Debug, Serialize, Deserialize)]
pub struct ApiErrorBody {
    pub code: ErrorCode,
    pub message: String,
}

impl From<&ApiError> for ApiErrorBody {
    fn from(err: &ApiError) -> Self {
        Self { code: err.code, message: err.message.clone() }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(feature = "axum")]
mod axum_impl {
    use super::{ApiError, ApiErrorBody};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::Json;

    impl IntoResponse for ApiError {
        fn into_response(self) -> Response {
            let status = StatusCode::from_u16(self.code.http_status())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            let body = ApiErrorBody { code: self.code, message: self.message };
            (status, Json(body)).into_response()
        }
    }
}
