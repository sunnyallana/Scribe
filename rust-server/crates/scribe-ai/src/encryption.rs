//! AES-256-GCM key-encryption-key envelope.
//!
//! Mirrors `server/src/services/encryption.ts` byte-for-byte so existing
//! ciphertexts (stored in `users.ai_config.api_key_encrypted`) decrypt
//! correctly during cutover. Wire format:
//!
//!   base64( <12-byte IV> | <16-byte GCM tag> | <ciphertext> )
//!
//! The master KEK comes from the `AI_KEY_ENCRYPTION_KEY` env var as a
//! base64-encoded 32-byte string.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("AI_KEY_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.")]
    Missing,
    #[error("AI_KEY_ENCRYPTION_KEY must decode to 32 bytes (got {0})")]
    BadKeyLength(usize),
    #[error("base64 decode: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("ciphertext too short")]
    TooShort,
    #[error("aes-gcm: {0}")]
    Aead(String),
}

/// Symmetric encryption box backed by AES-256-GCM. Cheap to clone (Key
/// is Copy under the hood). Construct once at server startup, then
/// share the instance.
#[derive(Clone)]
pub struct CryptoBox {
    cipher: Aes256Gcm,
}

impl CryptoBox {
    /// Build from a base64-encoded 32-byte key. Returns `Missing` if
    /// the env value is absent or empty.
    pub fn from_env_value(value: Option<&str>) -> Result<Self, CryptoError> {
        let raw = value.ok_or(CryptoError::Missing)?;
        if raw.is_empty() {
            return Err(CryptoError::Missing);
        }
        let key_bytes = base64::engine::general_purpose::STANDARD.decode(raw)?;
        if key_bytes.len() != 32 {
            return Err(CryptoError::BadKeyLength(key_bytes.len()));
        }
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        Ok(Self { cipher: Aes256Gcm::new(key) })
    }

    /// Encrypt `plaintext`. Output is base64 of `nonce || tag || ct`.
    pub fn encrypt(&self, plaintext: &str) -> Result<String, CryptoError> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let mut combined = nonce.to_vec(); // [iv][tag+ct]
        let ct_with_tag = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|err| CryptoError::Aead(err.to_string()))?;

        // aes-gcm appends the 16-byte tag *to the end* of ct_with_tag.
        // The legacy TS format puts the tag right after the IV, so we
        // split + swap to match: <iv><tag><ct>.
        if ct_with_tag.len() < 16 {
            return Err(CryptoError::TooShort);
        }
        let (ct_only, tag) = ct_with_tag.split_at(ct_with_tag.len() - 16);
        combined.extend_from_slice(tag);
        combined.extend_from_slice(ct_only);
        Ok(base64::engine::general_purpose::STANDARD.encode(combined))
    }

    /// Decrypt a value produced by [`encrypt`] or by the legacy Node
    /// implementation. Errors on a missing/short payload or tag failure.
    pub fn decrypt(&self, ciphertext: &str) -> Result<String, CryptoError> {
        let buf = base64::engine::general_purpose::STANDARD.decode(ciphertext)?;
        if buf.len() < 12 + 16 + 1 {
            return Err(CryptoError::TooShort);
        }
        let iv = &buf[..12];
        let tag = &buf[12..28];
        let ct = &buf[28..];
        // The `aes-gcm` API expects ct+tag concatenated. Rebuild that order.
        let mut ct_then_tag = Vec::with_capacity(ct.len() + tag.len());
        ct_then_tag.extend_from_slice(ct);
        ct_then_tag.extend_from_slice(tag);
        let nonce = Nonce::from_slice(iv);
        let plaintext = self
            .cipher
            .decrypt(nonce, ct_then_tag.as_slice())
            .map_err(|err| CryptoError::Aead(err.to_string()))?;
        String::from_utf8(plaintext).map_err(|err| CryptoError::Aead(err.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_for_tests() -> CryptoBox {
        // Deterministic 32 zero bytes — adequate for round-trip tests.
        let key_b64 = base64::engine::general_purpose::STANDARD.encode([0u8; 32]);
        CryptoBox::from_env_value(Some(&key_b64)).expect("build crypto box")
    }

    #[test]
    fn round_trips_a_secret() {
        let cb = box_for_tests();
        let secret = "sk-test-1234567890";
        let ct = cb.encrypt(secret).unwrap();
        assert_ne!(ct, secret);
        let pt = cb.decrypt(&ct).unwrap();
        assert_eq!(pt, secret);
    }

    #[test]
    fn rejects_short_ciphertext() {
        let cb = box_for_tests();
        let result = cb.decrypt("AAAA");
        assert!(matches!(result, Err(CryptoError::TooShort)));
    }

    #[test]
    fn rejects_tampered_payload() {
        let cb = box_for_tests();
        let ct = cb.encrypt("hello").unwrap();
        // Flip one byte of the ciphertext; tag check should reject.
        let mut bytes = base64::engine::general_purpose::STANDARD.decode(&ct).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        let tampered = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert!(cb.decrypt(&tampered).is_err());
    }

    #[test]
    fn missing_key_fails_at_construction() {
        assert!(matches!(
            CryptoBox::from_env_value(None),
            Err(CryptoError::Missing),
        ));
        assert!(matches!(
            CryptoBox::from_env_value(Some("")),
            Err(CryptoError::Missing),
        ));
    }

    #[test]
    fn bad_key_length_is_diagnosable() {
        let short = base64::engine::general_purpose::STANDARD.encode([0u8; 16]);
        assert!(matches!(
            CryptoBox::from_env_value(Some(&short)),
            Err(CryptoError::BadKeyLength(16)),
        ));
    }
}
