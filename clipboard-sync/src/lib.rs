//! Plaintext clipboard eligibility and XChaCha20-Poly1305 group encryption for
//! PiBot native clipboard sync.
//!
//! This crate handles:
//! - Bounded UTF-8 plaintext eligibility checks (64 KiB byte bound, non-empty,
//!   no NUL, explicit sensitivity flag, and blocking embedded or standalone
//!   pairing/group codes).
//! - HKDF-SHA256 key derivation separating the 256-bit AEAD key and 32-byte
//!   lowercase hex routing ID from a 32-byte OS-random group secret.
//! - XChaCha20-Poly1305 sealing/unsealing with 24-byte OS-random nonces,
//!   unambiguous versioned AAD binding `sender_id` and `sent_at`, pre-decode
//!   length checks, and ±30s timestamp window enforcement.
//!
//! Secret material is zeroized on drop and redacted from `Debug`. Clipboard
//! plaintext is never logged or persisted.

#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroize;

/// Maximum UTF-8 byte length permitted for synced plaintext clipboard items (64 KiB).
pub const MAX_TEXT_BYTES: usize = 65_536;

/// Maximum allowed clock skew / age in seconds on receive (both past and future).
pub const MAX_AGE_SECONDS: u64 = 30;

/// Prefix for canonical shared clipboard-group codes (`"pibot-clipboard-v1:"` + 43 base64url chars).
pub const GROUP_CODE_PREFIX: &str = "pibot-clipboard-v1:";

/// Prefix for PiBot pairing codes blocked from automatic clipboard transmission.
pub const PAIRING_CODE_PREFIX: &str = "pibot1.";

/// Nonce byte length for XChaCha20-Poly1305.
pub const NONCE_BYTES: usize = 24;

/// Canonical unpadded base64url character length of a 24-byte nonce.
pub const NONCE_B64_LEN: usize = 32;

/// Minimum sealed ciphertext byte length (1-byte plaintext + 16-byte Poly1305 tag).
pub const MIN_SEALED_BYTES: usize = 17;

/// Maximum sealed ciphertext byte length (`MAX_TEXT_BYTES` + 16-byte Poly1305 tag).
pub const MAX_SEALED_BYTES: usize = MAX_TEXT_BYTES + 16;

/// Canonical unpadded base64url character length for [`MIN_SEALED_BYTES`].
pub const MIN_SEALED_B64_LEN: usize = 23;

/// Canonical unpadded base64url character length for [`MAX_SEALED_BYTES`].
pub const MAX_SEALED_B64_LEN: usize = 87_403;

/// Lowercase hex character length of a 32-byte routing ID.
pub const ROUTING_ID_HEX_LEN: usize = 64;

/// Maximum full WebSocket frame byte size on the clipboard link (96 KiB).
pub const MAX_WS_FRAME_BYTES: usize = 96 * 1024;

/// Maximum safe JSON integer (`2^53 - 1`) for `sentAt` UTC epoch seconds.
pub const MAX_SAFE_JSON_INT: u64 = (1u64 << 53) - 1;

const SECRET_BYTES: usize = 32;
const SECRET_B64_LEN: usize = 43;
const AEAD_KEY_BYTES: usize = 32;
const ROUTING_ID_BYTES: usize = 32;

const HKDF_SALT: &[u8] = b"pibot-clipboard-v1";
const HKDF_INFO_AEAD_KEY: &[u8] = b"pibot-clipboard-v1:aead-key:xchacha20poly1305";
const HKDF_INFO_ROUTING_ID: &[u8] = b"pibot-clipboard-v1:routing-id";
const AAD_DOMAIN: &[u8] = b"pibot-clipboard-v1:aad:v1";

/// Checks whether `text` is eligible for plaintext clipboard synchronization
/// without performing any normalization.
///
/// Returns `false` if:
/// - `text` is empty or exceeds [`MAX_TEXT_BYTES`] UTF-8 bytes
/// - `text` contains a NUL byte (`'\0'`)
/// - `text` contains any occurrence of `"pibot1."` or `"pibot-clipboard-v1:"`
pub fn eligible_text(text: &str) -> bool {
    if text.is_empty() || text.len() > MAX_TEXT_BYTES {
        return false;
    }
    if text.as_bytes().contains(&0) {
        return false;
    }
    if text.contains(PAIRING_CODE_PREFIX) || text.contains(GROUP_CODE_PREFIX) {
        return false;
    }
    true
}

/// Wire payload carrying an authenticated, encrypted clipboard item.
///
/// Serializes with camelCase field names (`nonce`, `sealed`, `sentAt`) matching
/// the native clipboard WSS protocol. Contains only ciphertext metadata, never
/// plaintext or key material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedClip {
    /// 24-byte random nonce encoded as 32-char canonical unpadded base64url.
    pub nonce: String,
    /// XChaCha20-Poly1305 ciphertext (17..=65552 bytes) encoded as 23..=87403-char
    /// canonical unpadded base64url.
    pub sealed: String,
    /// Sender UTC epoch seconds as a positive safe JSON integer (`1..=2^53 - 1`).
    pub sent_at: u64,
}

/// Cryptographic or validation failure during group key handling, sealing, or
/// unsealing.
///
/// Never stores or formats clipboard plaintext, group secrets, or codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// OS cryptographically secure random number generation failed.
    RandomFailed,
    /// HKDF key derivation failed.
    KeyDerivationFailed,
    /// Shared group code did not match canonical `"pibot-clipboard-v1:"` + 43 base64url chars.
    InvalidCode,
    /// Sender device ID was empty or exceeded AAD framing limits.
    InvalidSenderId,
    /// Plaintext failed [`eligible_text`] validation.
    IneligibleText,
    /// `sent_at` was zero or exceeded [`MAX_SAFE_JSON_INT`].
    InvalidTimestamp,
    /// `sent_at` was older than [`MAX_AGE_SECONDS`] or more than [`MAX_AGE_SECONDS`] in the future.
    InvalidAge,
    /// `nonce` failed pre-decode length, canonical base64url, or 24-byte checks.
    InvalidNonce,
    /// `sealed` failed pre-decode length, canonical base64url, or 17..=65552-byte checks.
    InvalidCiphertext,
    /// AEAD encryption failed.
    EncryptionFailed,
    /// AEAD authentication failed (wrong key, wrong sender ID, tampered timestamp/nonce/ciphertext).
    AuthenticationFailed,
    /// Decrypted bytes were not valid UTF-8 or failed plaintext eligibility checks.
    InvalidPlaintext,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let msg = match self {
            Self::RandomFailed => "OS random number generation failed",
            Self::KeyDerivationFailed => "HKDF-SHA256 key derivation failed",
            Self::InvalidCode => "invalid canonical clipboard group code",
            Self::InvalidSenderId => "invalid sender device identifier",
            Self::IneligibleText => "clipboard text is not eligible for synchronization",
            Self::InvalidTimestamp => "timestamp must be a positive safe JSON integer",
            Self::InvalidAge => "clipboard item timestamp is outside the allowed age window",
            Self::InvalidNonce => "invalid clipboard nonce encoding or length",
            Self::InvalidCiphertext => "invalid sealed clipboard encoding or length",
            Self::EncryptionFailed => "AEAD encryption failed",
            Self::AuthenticationFailed => "AEAD authentication failed",
            Self::InvalidPlaintext => {
                "decrypted clipboard payload is not valid eligible UTF-8 text"
            }
        };
        f.write_str(msg)
    }
}

impl Error for CryptoError {}

/// Clipboard-sync group key holding the 32-byte invite secret, derived 256-bit
/// XChaCha20-Poly1305 key, and derived 64-char lowercase hex routing ID.
///
/// Key material is zeroized on drop and redacted from [`fmt::Debug`].
pub struct GroupKey {
    secret: [u8; SECRET_BYTES],
    aead_key: [u8; AEAD_KEY_BYTES],
    routing_id: String,
}

impl Drop for GroupKey {
    fn drop(&mut self) {
        self.secret.zeroize();
        self.aead_key.zeroize();
    }
}

impl fmt::Debug for GroupKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("GroupKey([REDACTED])")
    }
}

impl GroupKey {
    /// Generates a new clipboard group key from 32 bytes of OS CSPRNG entropy.
    pub fn generate() -> Result<Self, CryptoError> {
        let mut secret = [0u8; SECRET_BYTES];
        getrandom::getrandom(&mut secret).map_err(|_| CryptoError::RandomFailed)?;
        Self::from_secret(secret)
    }

    /// Parses a canonical shared clipboard-group code (`"pibot-clipboard-v1:"`
    /// followed by exactly 43 unpadded base64url characters).
    pub fn from_code(code: &str) -> Result<Self, CryptoError> {
        let Some(encoded) = code.strip_prefix(GROUP_CODE_PREFIX) else {
            return Err(CryptoError::InvalidCode);
        };
        if encoded.len() != SECRET_B64_LEN {
            return Err(CryptoError::InvalidCode);
        }
        let mut decoded = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| CryptoError::InvalidCode)?;
        if decoded.len() != SECRET_BYTES {
            decoded.zeroize();
            return Err(CryptoError::InvalidCode);
        }
        let mut secret = [0u8; SECRET_BYTES];
        secret.copy_from_slice(&decoded);
        decoded.zeroize();
        Self::from_secret(secret)
    }

    /// Exports the canonical shareable code (`"pibot-clipboard-v1:"` + 43
    /// unpadded base64url characters).
    pub fn to_code(&self) -> String {
        let mut code = String::with_capacity(GROUP_CODE_PREFIX.len() + SECRET_B64_LEN);
        code.push_str(GROUP_CODE_PREFIX);
        URL_SAFE_NO_PAD.encode_string(self.secret, &mut code);
        code
    }

    /// Returns the derived 64-character lowercase hexadecimal Center routing ID.
    pub fn routing_id(&self) -> &str {
        &self.routing_id
    }

    /// Encrypts eligible plaintext with a fresh 24-byte OS-random nonce,
    /// authenticating `sender_id` and `sent_at` in AAD.
    pub fn encrypt(
        &self,
        sender_id: &str,
        text: &str,
        sent_at: u64,
    ) -> Result<SealedClip, CryptoError> {
        if !is_valid_timestamp(sent_at) {
            return Err(CryptoError::InvalidTimestamp);
        }
        if !eligible_text(text) {
            return Err(CryptoError::IneligibleText);
        }
        let aad = build_aad(sender_id, sent_at)?;

        let mut nonce_bytes = [0u8; NONCE_BYTES];
        getrandom::getrandom(&mut nonce_bytes).map_err(|_| CryptoError::RandomFailed)?;

        let cipher = XChaCha20Poly1305::new_from_slice(&self.aead_key)
            .map_err(|_| CryptoError::KeyDerivationFailed)?;
        let nonce = XNonce::from(nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: text.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::EncryptionFailed)?;

        Ok(SealedClip {
            nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
            sealed: URL_SAFE_NO_PAD.encode(ciphertext),
            sent_at,
        })
    }

    /// Verifies timestamp bounds, age window, and encoded field lengths before
    /// decoding and authenticating `clip` with `sender_id` and `clip.sent_at`
    /// as AAD.
    ///
    /// Never returns plaintext if timestamp/age, decoding, authentication,
    /// UTF-8, or eligibility checks fail.
    pub fn decrypt(
        &self,
        sender_id: &str,
        clip: &SealedClip,
        now: u64,
    ) -> Result<String, CryptoError> {
        if !is_valid_timestamp(clip.sent_at) {
            return Err(CryptoError::InvalidTimestamp);
        }
        if now.abs_diff(clip.sent_at) > MAX_AGE_SECONDS {
            return Err(CryptoError::InvalidAge);
        }
        if clip.nonce.len() != NONCE_B64_LEN {
            return Err(CryptoError::InvalidNonce);
        }
        if !(MIN_SEALED_B64_LEN..=MAX_SEALED_B64_LEN).contains(&clip.sealed.len()) {
            return Err(CryptoError::InvalidCiphertext);
        }
        let aad = build_aad(sender_id, clip.sent_at)?;

        let nonce_vec = URL_SAFE_NO_PAD
            .decode(&clip.nonce)
            .map_err(|_| CryptoError::InvalidNonce)?;
        let nonce_bytes: [u8; NONCE_BYTES] = nonce_vec
            .try_into()
            .map_err(|_| CryptoError::InvalidNonce)?;

        let ciphertext = URL_SAFE_NO_PAD
            .decode(&clip.sealed)
            .map_err(|_| CryptoError::InvalidCiphertext)?;
        if !(MIN_SEALED_BYTES..=MAX_SEALED_BYTES).contains(&ciphertext.len()) {
            return Err(CryptoError::InvalidCiphertext);
        }

        let cipher = XChaCha20Poly1305::new_from_slice(&self.aead_key)
            .map_err(|_| CryptoError::KeyDerivationFailed)?;
        let nonce = XNonce::from(nonce_bytes);
        let plaintext = cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::AuthenticationFailed)?;

        let mut text = match String::from_utf8(plaintext) {
            Ok(s) => s,
            Err(err) => {
                let mut bytes = err.into_bytes();
                bytes.zeroize();
                return Err(CryptoError::InvalidPlaintext);
            }
        };
        if !eligible_text(&text) {
            text.zeroize();
            return Err(CryptoError::InvalidPlaintext);
        }
        Ok(text)
    }

    fn from_secret(mut secret: [u8; SECRET_BYTES]) -> Result<Self, CryptoError> {
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), &secret);

        let mut aead_key = [0u8; AEAD_KEY_BYTES];
        if hk.expand(HKDF_INFO_AEAD_KEY, &mut aead_key).is_err() {
            secret.zeroize();
            aead_key.zeroize();
            return Err(CryptoError::KeyDerivationFailed);
        }

        let mut routing_bytes = [0u8; ROUTING_ID_BYTES];
        if hk.expand(HKDF_INFO_ROUTING_ID, &mut routing_bytes).is_err() {
            secret.zeroize();
            aead_key.zeroize();
            routing_bytes.zeroize();
            return Err(CryptoError::KeyDerivationFailed);
        }

        let routing_id = encode_lower_hex(&routing_bytes);
        routing_bytes.zeroize();

        Ok(Self {
            secret,
            aead_key,
            routing_id,
        })
    }
}

fn is_valid_timestamp(ts: u64) -> bool {
    (1..=MAX_SAFE_JSON_INT).contains(&ts)
}

fn build_aad(sender_id: &str, sent_at: u64) -> Result<Vec<u8>, CryptoError> {
    if sender_id.is_empty() {
        return Err(CryptoError::InvalidSenderId);
    }
    let sender_len = u32::try_from(sender_id.len()).map_err(|_| CryptoError::InvalidSenderId)?;
    let mut aad = Vec::with_capacity(AAD_DOMAIN.len() + 8 + 4 + sender_id.len());
    aad.extend_from_slice(AAD_DOMAIN);
    aad.extend_from_slice(&sent_at.to_be_bytes());
    aad.extend_from_slice(&sender_len.to_be_bytes());
    aad.extend_from_slice(sender_id.as_bytes());
    Ok(aad)
}

fn encode_lower_hex(bytes: &[u8; ROUTING_ID_BYTES]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(ROUTING_ID_HEX_LEN);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eligible_text_enforces_utf8_byte_bounds_and_nul_without_normalization() {
        assert!(!eligible_text(""));
        assert!(!eligible_text("abc\0def"));

        // Unnormalized nonempty whitespace, CRLF, and NFD Unicode stay eligible.
        assert!(eligible_text("   "));
        assert!(eligible_text("  hello\r\nworld  "));
        assert!(eligible_text("e\u{0301}"));

        // Exact 64 KiB ASCII bound.
        assert!(eligible_text(&"a".repeat(MAX_TEXT_BYTES)));
        assert!(!eligible_text(&"a".repeat(MAX_TEXT_BYTES + 1)));

        // Multi-byte Unicode byte bound: 16,384 x 4-byte emoji == 65,536 bytes.
        let emoji_exact = "🦀".repeat(MAX_TEXT_BYTES / 4);
        assert_eq!(emoji_exact.len(), MAX_TEXT_BYTES);
        assert!(eligible_text(&emoji_exact));
        assert!(!eligible_text(&"🦀".repeat(MAX_TEXT_BYTES / 4 + 1)));

        // 3-byte CJK: 21,845 chars (65,535 bytes) + 'a' == 65,536 bytes.
        let mut cjk_exact = "中".repeat(MAX_TEXT_BYTES / 3);
        cjk_exact.push('a');
        assert_eq!(cjk_exact.len(), MAX_TEXT_BYTES);
        assert!(eligible_text(&cjk_exact));
        assert!(!eligible_text(&"中".repeat(MAX_TEXT_BYTES / 3 + 1)));
    }

    #[test]
    fn eligible_text_blocks_any_pairing_or_group_code_occurrence() {
        assert!(eligible_text("123456"));

        for blocked in [
            "pibot1.token",
            "share pibot1.embedded-pairing-token here",
            "pibot-clipboard-v1:",
            "  pibot-clipboard-v1:abc123  ",
            "invite code: pibot-clipboard-v1:embedded-secret",
        ] {
            assert!(!eligible_text(blocked), "should block: {blocked}");
        }

        let key = GroupKey::generate().expect("generate key");
        let code = key.to_code();
        assert!(!eligible_text(&code));
        assert!(!eligible_text(&format!("paste {code} on other device")));
    }

    #[test]
    fn group_code_routing_id_serde_and_material_interop() {
        let key1 = GroupKey::generate().expect("generate key1");
        let code = key1.to_code();
        assert!(code.starts_with(GROUP_CODE_PREFIX));
        assert_eq!(code.len(), GROUP_CODE_PREFIX.len() + SECRET_B64_LEN);
        assert!(!code.contains('='));

        let rid = key1.routing_id();
        assert_eq!(rid.len(), ROUTING_ID_HEX_LEN);
        assert!(rid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));

        // Debug must not expose secret code or routing ID.
        let debug_str = format!("{key1:?}");
        assert!(!debug_str.contains(&code));
        assert!(!debug_str.contains(rid));

        // Round-trip through canonical code yields identical derived material.
        let key2 = GroupKey::from_code(&code).expect("parse canonical code");
        assert_eq!(key2.to_code(), code);
        assert_eq!(key2.routing_id(), rid);

        // Encrypt with key1, serialize via serde camelCase, decrypt with key2.
        let ts = 1_700_000_000;
        let sample = "  hello\r\n🦀e\u{0301}  ";
        let clip = key1.encrypt("dev-1", sample, ts).expect("encrypt");
        assert_eq!(clip.nonce.len(), NONCE_B64_LEN);
        assert!((MIN_SEALED_B64_LEN..=MAX_SEALED_B64_LEN).contains(&clip.sealed.len()));
        assert_eq!(clip.sent_at, ts);

        let json = serde_json::to_string(&clip).expect("serialize SealedClip");
        assert!(json.contains("\"sentAt\":1700000000"));
        assert!(!json.contains("sent_at"));
        let decoded: SealedClip = serde_json::from_str(&json).expect("deserialize SealedClip");
        assert_eq!(decoded, clip);

        let plaintext = key2.decrypt("dev-1", &decoded, ts).expect("decrypt");
        assert_eq!(plaintext.as_bytes(), sample.as_bytes());

        // Distinct nonces on repeated encryption of identical text.
        let clip_b = key1.encrypt("dev-1", sample, ts).expect("encrypt second");
        assert_ne!(clip.nonce, clip_b.nonce);
        assert_ne!(clip.sealed, clip_b.sealed);

        // Invalid and non-canonical codes are rejected.
        let canonical_zeros = format!("{GROUP_CODE_PREFIX}{}", "A".repeat(43));
        assert!(GroupKey::from_code(&canonical_zeros).is_ok());
        let bad_codes = [
            String::new(),
            "pibot-clipboard-v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".to_string(),
            format!(" {code} "),
            format!("{GROUP_CODE_PREFIX}{}", "A".repeat(42)),
            format!("{GROUP_CODE_PREFIX}{}=", "A".repeat(43)),
            format!("{GROUP_CODE_PREFIX}{}+", "A".repeat(42)),
            format!("{GROUP_CODE_PREFIX}{}/", "A".repeat(42)),
            format!("{GROUP_CODE_PREFIX}{}B", "A".repeat(42)),
        ];
        for bad_code in &bad_codes {
            assert_eq!(
                GroupKey::from_code(bad_code).unwrap_err(),
                CryptoError::InvalidCode
            );
        }
    }

    #[test]
    fn decrypt_rejects_tamper_wrong_sender_wrong_key_and_invalid_lengths() {
        let key1 = GroupKey::generate().expect("generate key1");
        let key2 = GroupKey::generate().expect("generate key2");
        let ts = 1_700_000_100;
        let clip = key1
            .encrypt("device-alpha", "secret clip", ts)
            .expect("encrypt");

        // Wrong key.
        assert_eq!(
            key2.decrypt("device-alpha", &clip, ts),
            Err(CryptoError::AuthenticationFailed)
        );

        // Wrong sender ID (AAD mismatch).
        assert_eq!(
            key1.decrypt("device-beta", &clip, ts),
            Err(CryptoError::AuthenticationFailed)
        );

        // Tampered sentAt within age window (AAD mismatch).
        let mut bad_ts = clip.clone();
        bad_ts.sent_at = ts + 1;
        assert_eq!(
            key1.decrypt("device-alpha", &bad_ts, ts + 1),
            Err(CryptoError::AuthenticationFailed)
        );

        // Tampered ciphertext.
        let mut bad_sealed = clip.clone();
        let mut sb = bad_sealed.sealed.into_bytes();
        sb[0] = if sb[0] == b'A' { b'B' } else { b'A' };
        bad_sealed.sealed = String::from_utf8(sb).expect("ascii");
        assert_eq!(
            key1.decrypt("device-alpha", &bad_sealed, ts),
            Err(CryptoError::AuthenticationFailed)
        );

        // Tampered nonce.
        let mut bad_nonce = clip.clone();
        let mut nb = bad_nonce.nonce.into_bytes();
        nb[0] = if nb[0] == b'A' { b'B' } else { b'A' };
        bad_nonce.nonce = String::from_utf8(nb).expect("ascii");
        assert_eq!(
            key1.decrypt("device-alpha", &bad_nonce, ts),
            Err(CryptoError::AuthenticationFailed)
        );

        // Pre-decode length rejections.
        let mut short_nonce = clip.clone();
        short_nonce.nonce = "A".repeat(NONCE_B64_LEN - 1);
        assert_eq!(
            key1.decrypt("device-alpha", &short_nonce, ts),
            Err(CryptoError::InvalidNonce)
        );

        let mut short_sealed = clip.clone();
        short_sealed.sealed = "A".repeat(MIN_SEALED_B64_LEN - 1);
        assert_eq!(
            key1.decrypt("device-alpha", &short_sealed, ts),
            Err(CryptoError::InvalidCiphertext)
        );

        let mut huge_sealed = clip.clone();
        huge_sealed.sealed = "A".repeat(MAX_SEALED_B64_LEN + 1);
        assert_eq!(
            key1.decrypt("device-alpha", &huge_sealed, ts),
            Err(CryptoError::InvalidCiphertext)
        );

        // Empty sender ID and ineligible plaintext rejected.
        assert_eq!(
            key1.encrypt("", "hello", ts),
            Err(CryptoError::InvalidSenderId)
        );
        assert_eq!(
            key1.decrypt("", &clip, ts),
            Err(CryptoError::InvalidSenderId)
        );
        assert_eq!(
            key1.encrypt("device-alpha", "", ts),
            Err(CryptoError::IneligibleText)
        );
        assert_eq!(
            key1.encrypt("device-alpha", "has pibot1.secret inside", ts),
            Err(CryptoError::IneligibleText)
        );
    }

    #[test]
    fn decrypt_enforces_timestamp_bounds_and_30s_age_window() {
        let key = GroupKey::generate().expect("generate key");
        let ts = 1_700_000_500;
        let clip = key.encrypt("dev-1", "timed clip", ts).expect("encrypt");

        // Exact boundaries (+/- 30s) succeed.
        assert_eq!(
            key.decrypt("dev-1", &clip, ts),
            Ok("timed clip".to_string())
        );
        assert_eq!(
            key.decrypt("dev-1", &clip, ts + MAX_AGE_SECONDS),
            Ok("timed clip".to_string())
        );
        assert_eq!(
            key.decrypt("dev-1", &clip, ts - MAX_AGE_SECONDS),
            Ok("timed clip".to_string())
        );

        // Stale >30s and future >30s fail before authentication.
        assert_eq!(
            key.decrypt("dev-1", &clip, ts + MAX_AGE_SECONDS + 1),
            Err(CryptoError::InvalidAge)
        );
        assert_eq!(
            key.decrypt("dev-1", &clip, ts - MAX_AGE_SECONDS - 1),
            Err(CryptoError::InvalidAge)
        );

        let other_key = GroupKey::generate().expect("other key");
        assert_eq!(
            other_key.decrypt("wrong-sender", &clip, ts + MAX_AGE_SECONDS + 1),
            Err(CryptoError::InvalidAge)
        );

        // Zero and > MAX_SAFE_JSON_INT timestamps rejected.
        assert_eq!(
            key.encrypt("dev-1", "hello", 0),
            Err(CryptoError::InvalidTimestamp)
        );
        assert_eq!(
            key.encrypt("dev-1", "hello", MAX_SAFE_JSON_INT + 1),
            Err(CryptoError::InvalidTimestamp)
        );
        let mut zero_ts = clip.clone();
        zero_ts.sent_at = 0;
        assert_eq!(
            key.decrypt("dev-1", &zero_ts, 1),
            Err(CryptoError::InvalidTimestamp)
        );
        let mut unsafe_ts = clip;
        unsafe_ts.sent_at = MAX_SAFE_JSON_INT + 1;
        assert_eq!(
            key.decrypt("dev-1", &unsafe_ts, MAX_SAFE_JSON_INT),
            Err(CryptoError::InvalidTimestamp)
        );
    }
}
