//! The pairing code a center hands out: `pibot1.` + base64url(JSON `{u, c, a?}`).
//!
//! `u` is the center origin, `c` a one-time secret and `a` an optional PEM bundle of the
//! center's private CA. The webview only ever passes the opaque string; it is decoded
//! here so the secret and the certificate never travel through frontend state.
//! The wire format is defined by the center (`center-server/pairing.js`).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;

pub const PREFIX: &str = "pibot1.";
/// A code carrying a CA bundle is a few KiB; anything past this is not a pairing code.
const MAX_CODE_CHARS: usize = 96 * 1024;
const MAX_CA_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum PairingCodeError {
  /// Not text this client can read as a pairing code at all.
  NotACode,
  /// A `pibotN.` code from a center newer than this client.
  UnsupportedVersion,
  /// Right shape, unusable content (bad encoding, missing or invalid fields).
  Malformed,
}

/// Holds a one-time secret, so there is deliberately no `Debug`.
pub struct PairingCode {
  pub url: String,
  pub secret: String,
  pub ca: Option<String>,
}

#[derive(Deserialize)]
struct Payload {
  u: String,
  c: String,
  #[serde(default)]
  a: Option<String>,
}

/// `pibot2.…` and friends: a recognisable code from a version this client does not know.
fn is_other_version(compact: &str) -> bool {
  compact
    .strip_prefix("pibot")
    .and_then(|rest| rest.split_once('.'))
    .is_some_and(|(version, _)| !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_secret(secret: &str) -> bool {
  (32..=64).contains(&secret.len()) && secret.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Parses pasted text. Whitespace anywhere is ignored: terminals and chat apps like to wrap
/// long strings, and a code never contains any.
pub fn parse(raw: &str) -> Result<PairingCode, PairingCodeError> {
  let compact: String = raw.split_whitespace().collect();
  if compact.len() > MAX_CODE_CHARS {
    return Err(PairingCodeError::Malformed);
  }
  let Some(body) = compact.strip_prefix(PREFIX) else {
    return Err(if is_other_version(&compact) { PairingCodeError::UnsupportedVersion } else { PairingCodeError::NotACode });
  };
  let bytes = URL_SAFE_NO_PAD.decode(body).map_err(|_| PairingCodeError::Malformed)?;
  let payload: Payload = serde_json::from_slice(&bytes).map_err(|_| PairingCodeError::Malformed)?;
  if !valid_secret(&payload.c) {
    return Err(PairingCodeError::Malformed);
  }
  let ca = payload.a.map(|pem| pem.trim().to_string()).filter(|pem| !pem.is_empty());
  if let Some(pem) = &ca {
    if pem.len() > MAX_CA_BYTES || !pem.contains("-----BEGIN CERTIFICATE-----") {
      return Err(PairingCodeError::Malformed);
    }
  }
  Ok(PairingCode { url: payload.u, secret: payload.c, ca })
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  const SECRET: &str = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Q";
  const PEM: &str = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

  fn encode(value: serde_json::Value) -> String {
    format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(value.to_string()))
  }

  #[test]
  fn reads_a_code_with_and_without_a_ca() {
    let plain = parse(&encode(json!({ "u": "https://center.example", "c": SECRET }))).ok().unwrap();
    assert_eq!((plain.url.as_str(), plain.secret.as_str(), plain.ca), ("https://center.example", SECRET, None));

    let with_ca = parse(&encode(json!({ "u": "https://192.168.1.10:8443", "c": SECRET, "a": format!("{PEM}\n") }))).ok().unwrap();
    assert_eq!(with_ca.url, "https://192.168.1.10:8443");
    assert_eq!(with_ca.ca.as_deref(), Some(PEM));
  }

  #[test]
  fn ignores_surrounding_and_wrapped_whitespace() {
    let code = encode(json!({ "u": "https://center.example", "c": SECRET }));
    let wrapped = format!("  \n{}\r\n{}\n  ", &code[..20], &code[20..]);
    assert_eq!(parse(&wrapped).ok().unwrap().secret, SECRET);
  }

  #[test]
  fn tells_apart_the_ways_a_paste_can_be_wrong() {
    let reason = |text: &str| parse(text).err().unwrap();
    assert_eq!(reason(""), PairingCodeError::NotACode);
    assert_eq!(reason("https://center.example"), PairingCodeError::NotACode);
    assert_eq!(reason("hunter2"), PairingCodeError::NotACode);
    assert_eq!(reason("pibot.abc"), PairingCodeError::NotACode);
    assert_eq!(reason("pibotx.abc"), PairingCodeError::NotACode);
    assert_eq!(reason("pibot2.abc"), PairingCodeError::UnsupportedVersion);
    assert_eq!(reason("pibot10.abc"), PairingCodeError::UnsupportedVersion);
    assert_eq!(reason("pibot1."), PairingCodeError::Malformed);
    assert_eq!(reason("pibot1.!!!not-base64!!!"), PairingCodeError::Malformed);
    assert_eq!(reason(&format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode("not json"))), PairingCodeError::Malformed);
  }

  #[test]
  fn rejects_codes_with_unusable_fields() {
    let bad = |value: serde_json::Value| parse(&encode(value)).err().unwrap();
    assert_eq!(bad(json!({ "c": SECRET })), PairingCodeError::Malformed);
    assert_eq!(bad(json!({ "u": "https://c" })), PairingCodeError::Malformed);
    assert_eq!(bad(json!({ "u": 5, "c": SECRET })), PairingCodeError::Malformed);
    assert_eq!(bad(json!({ "u": "https://c", "c": "short" })), PairingCodeError::Malformed);
    assert_eq!(bad(json!({ "u": "https://c", "c": "x".repeat(65) })), PairingCodeError::Malformed);
    assert_eq!(bad(json!({ "u": "https://c", "c": format!("{}!", &SECRET[1..]) })), PairingCodeError::Malformed);
    assert_eq!(bad(json!({ "u": "https://c", "c": SECRET, "a": "not a certificate" })), PairingCodeError::Malformed);
    assert_eq!(bad(json!({ "u": "https://c", "c": SECRET, "a": format!("{PEM}{}", "A".repeat(MAX_CA_BYTES)) })), PairingCodeError::Malformed);
  }

  #[test]
  fn an_empty_ca_means_no_ca_and_unknown_fields_are_tolerated() {
    let parsed = parse(&encode(json!({ "u": "https://c", "c": SECRET, "a": "  ", "future": [1, 2] }))).ok().unwrap();
    assert_eq!(parsed.ca, None);
  }

  #[test]
  fn refuses_absurdly_long_input_before_decoding() {
    assert_eq!(parse(&format!("{PREFIX}{}", "A".repeat(MAX_CODE_CHARS + 1))).err().unwrap(), PairingCodeError::Malformed);
  }

  /// The exact string the center produced in the browser run, so the two sides cannot drift apart.
  #[test]
  fn reads_a_code_minted_by_the_center() {
    let code = "pibot1.eyJ1IjoiaHR0cHM6Ly9sb2NhbGhvc3Q6MTg0NDMiLCJjIjoiQkQ0d2luSTBTdHJsaWx5NWlnTnVwMndLakJWOUt4UWEifQ";
    let parsed = parse(code).ok().unwrap();
    assert_eq!(parsed.url, "https://localhost:18443");
    assert_eq!(parsed.secret.len(), 32);
    assert_eq!(parsed.ca, None);
  }
}
