use clipboard_sync::SealedClip;
use serde::{Deserialize, Serialize};

use crate::config::{validate_device_id, validate_device_token, validate_routing_id};

pub(crate) const CLIPBOARD_UPGRADE_HEADER: &str = "x-pibot-clipboard-v1";
pub(crate) const CLIPBOARD_UPGRADE_VERSION: &str = "1";
pub(crate) const PROTOCOL_VERSION: u64 = 1;
pub(crate) const CLIPBOARD_ROLE: &str = "clipboard";

pub(crate) const MAX_WS_FRAME_BYTES: usize = 96 * 1024;
pub(crate) const MAX_WS_WRITE_BUFFER_BYTES: usize = 256 * 1024;

pub(crate) const NONCE_BYTES: usize = 24;
pub(crate) const NONCE_ENCODED_LEN: usize = 32;
pub(crate) const SEALED_MIN_BYTES: usize = 17;
pub(crate) const SEALED_MAX_BYTES: usize = clipboard_sync::MAX_TEXT_BYTES + 16;
pub(crate) const SEALED_MIN_ENCODED_LEN: usize = 23;
pub(crate) const SEALED_MAX_ENCODED_LEN: usize = 87_403;
pub(crate) const MAX_SAFE_JSON_INT: u64 = (1u64 << 53) - 1;

pub(crate) const CLOSE_PROTOCOL_ERROR: u16 = 1002;
pub(crate) const CLOSE_UNSUPPORTED_DATA: u16 = 1003;
pub(crate) const CLOSE_POLICY_VIOLATION: u16 = 1008;
pub(crate) const CLOSE_BAD_FRAME: u16 = 4400;
pub(crate) const CLOSE_UNAUTHORIZED: u16 = 4401;
pub(crate) const CLOSE_REVOKED: u16 = 4403;

const _: () = assert!(SEALED_MAX_BYTES == 65_552);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HelloFrame<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    protocol_version: u64,
    role: &'static str,
    device_id: &'a str,
    token: &'a str,
    clipboard_group: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyFrame {
    #[serde(rename = "type")]
    kind: String,
    protocol_version: u64,
    role: String,
    device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardPutFrame<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    nonce: &'a str,
    sealed: &'a str,
    sent_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClipboardEventFrame {
    #[serde(rename = "type")]
    kind: String,
    from_device_id: String,
    nonce: String,
    sealed: String,
    sent_at: u64,
}

pub(crate) struct ParsedClipboardEvent {
    pub(crate) from_device_id: String,
    pub(crate) clip: SealedClip,
}

fn b64url_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

/// Validates canonical unpadded base64url and returns its decoded byte length.
pub(crate) fn base64url_nopad_decoded_len(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let rem = bytes.len() % 4;
    if rem == 1 {
        return None;
    }
    for &b in bytes {
        b64url_value(b)?;
    }
    if rem == 2 {
        let last = b64url_value(*bytes.last()?)?;
        if (last & 0x0f) != 0 {
            return None;
        }
    } else if rem == 3 {
        let last = b64url_value(*bytes.last()?)?;
        if (last & 0x03) != 0 {
            return None;
        }
    }
    let full_groups = bytes.len() / 4;
    let extra = match rem {
        0 => 0,
        2 => 1,
        3 => 2,
        _ => unreachable!(),
    };
    Some(full_groups * 3 + extra)
}

pub(crate) fn is_valid_nonce(nonce: &str) -> bool {
    nonce.len() == NONCE_ENCODED_LEN && base64url_nopad_decoded_len(nonce) == Some(NONCE_BYTES)
}

pub(crate) fn is_valid_sealed(sealed: &str) -> bool {
    (SEALED_MIN_ENCODED_LEN..=SEALED_MAX_ENCODED_LEN).contains(&sealed.len())
        && matches!(
            base64url_nopad_decoded_len(sealed),
            Some(decoded) if (SEALED_MIN_BYTES..=SEALED_MAX_BYTES).contains(&decoded)
        )
}

pub(crate) fn is_valid_sent_at(sent_at: u64) -> bool {
    sent_at >= 1 && sent_at <= MAX_SAFE_JSON_INT
}

pub(crate) fn is_fresh_sent_at(sent_at: u64, now_unix: u64) -> bool {
    is_valid_sent_at(sent_at)
        && is_valid_sent_at(now_unix)
        && now_unix.abs_diff(sent_at) <= clipboard_sync::MAX_AGE_SECONDS
}

pub(crate) fn encode_hello(
    device_id: &str,
    token: &str,
    clipboard_group: &str,
) -> Result<String, ()> {
    if !validate_device_id(device_id)
        || !validate_device_token(token)
        || !validate_routing_id(clipboard_group)
    {
        return Err(());
    }
    let frame = HelloFrame {
        kind: "hello",
        protocol_version: PROTOCOL_VERSION,
        role: CLIPBOARD_ROLE,
        device_id,
        token,
        clipboard_group,
    };
    let encoded = serde_json::to_string(&frame).map_err(|_| ())?;
    if encoded.len() > MAX_WS_FRAME_BYTES {
        return Err(());
    }
    Ok(encoded)
}

pub(crate) fn encode_clipboard_put(clip: &SealedClip) -> Result<String, ()> {
    if !is_valid_nonce(&clip.nonce)
        || !is_valid_sealed(&clip.sealed)
        || !is_valid_sent_at(clip.sent_at)
    {
        return Err(());
    }
    let frame = ClipboardPutFrame {
        kind: "clipboard-put",
        nonce: &clip.nonce,
        sealed: &clip.sealed,
        sent_at: clip.sent_at,
    };
    let encoded = serde_json::to_string(&frame).map_err(|_| ())?;
    if encoded.len() > MAX_WS_FRAME_BYTES {
        return Err(());
    }
    Ok(encoded)
}

pub(crate) fn parse_ready(raw: &str, expected_device_id: &str) -> Result<(), ()> {
    if raw.len() > MAX_WS_FRAME_BYTES {
        return Err(());
    }
    let frame: ReadyFrame = serde_json::from_str(raw).map_err(|_| ())?;
    if frame.kind != "ready"
        || frame.protocol_version != PROTOCOL_VERSION
        || frame.role != CLIPBOARD_ROLE
        || frame.device_id != expected_device_id
    {
        return Err(());
    }
    Ok(())
}

pub(crate) fn parse_clipboard_event(raw: &str) -> Result<ParsedClipboardEvent, ()> {
    if raw.len() > MAX_WS_FRAME_BYTES {
        return Err(());
    }
    let frame: ClipboardEventFrame = serde_json::from_str(raw).map_err(|_| ())?;
    if frame.kind != "clipboard-event"
        || !validate_device_id(&frame.from_device_id)
        || !is_valid_nonce(&frame.nonce)
        || !is_valid_sealed(&frame.sealed)
        || !is_valid_sent_at(frame.sent_at)
    {
        return Err(());
    }
    Ok(ParsedClipboardEvent {
        from_device_id: frame.from_device_id,
        clip: SealedClip {
            nonce: frame.nonce,
            sealed: frame.sealed,
            sent_at: frame.sent_at,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn valid_nonce() -> String {
        "A".repeat(NONCE_ENCODED_LEN)
    }

    fn valid_min_sealed() -> String {
        // 17 bytes -> 23 base64url chars; last char 'A' has 0 trailing bits
        "A".repeat(SEALED_MIN_ENCODED_LEN)
    }

    fn valid_max_sealed() -> String {
        // 65552 bytes -> 87403 base64url chars; last char 'A' has 0 trailing bits
        "A".repeat(SEALED_MAX_ENCODED_LEN)
    }

    #[test]
    fn encodes_exact_hello_and_clipboard_put_fields() {
        let token = "T".repeat(32);
        let group = "a0".repeat(32);
        let hello_raw = encode_hello("dev-1", &token, &group).expect("hello");
        let hello_json: Value = serde_json::from_str(&hello_raw).expect("json");
        assert_eq!(
            hello_json,
            json!({
                "type": "hello",
                "protocolVersion": 1,
                "role": "clipboard",
                "deviceId": "dev-1",
                "token": token,
                "clipboardGroup": group,
            })
        );

        let clip = SealedClip {
            nonce: valid_nonce(),
            sealed: valid_min_sealed(),
            sent_at: 1_700_000_000,
        };
        let put_raw = encode_clipboard_put(&clip).expect("put");
        let put_json: Value = serde_json::from_str(&put_raw).expect("json");
        assert_eq!(
            put_json,
            json!({
                "type": "clipboard-put",
                "nonce": clip.nonce,
                "sealed": clip.sealed,
                "sentAt": 1_700_000_000u64,
            })
        );
    }

    #[test]
    fn validates_ready_strictly() {
        assert!(parse_ready(
            r#"{"type":"ready","protocolVersion":1,"role":"clipboard","deviceId":"dev-1"}"#,
            "dev-1"
        )
        .is_ok());

        let invalid_cases = [
            r#"{"type":"ready","protocolVersion":1,"deviceId":"dev-1"}"#,
            r#"{"type":"ready","protocolVersion":1,"role":"host","deviceId":"dev-1"}"#,
            r#"{"type":"ready","protocolVersion":2,"role":"clipboard","deviceId":"dev-1"}"#,
            r#"{"type":"ready","protocolVersion":1,"role":"clipboard","deviceId":"dev-2"}"#,
            r#"{"type":"ready","protocolVersion":1,"role":"clipboard","deviceId":"dev-1","extra":true}"#,
            r#"{"type":"other","protocolVersion":1,"role":"clipboard","deviceId":"dev-1"}"#,
        ];
        for raw in invalid_cases {
            assert!(parse_ready(raw, "dev-1").is_err(), "must reject {raw}");
        }
    }

    #[test]
    fn validates_clipboard_event_fields_and_bounds() {
        let ok_min = json!({
            "type": "clipboard-event",
            "fromDeviceId": "dev-2",
            "nonce": valid_nonce(),
            "sealed": valid_min_sealed(),
            "sentAt": 1_700_000_000u64,
        })
        .to_string();
        assert!(parse_clipboard_event(&ok_min).is_ok());

        let ok_max = json!({
            "type": "clipboard-event",
            "fromDeviceId": "dev-2",
            "nonce": valid_nonce(),
            "sealed": valid_max_sealed(),
            "sentAt": MAX_SAFE_JSON_INT,
        })
        .to_string();
        assert!(ok_max.len() <= MAX_WS_FRAME_BYTES);
        assert!(parse_clipboard_event(&ok_max).is_ok());

        let bad_cases = [
            // Extra field
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": valid_nonce(),
                "sealed": valid_min_sealed(),
                "sentAt": 1_700_000_000u64,
                "extra": 1,
            })
            .to_string(),
            // Wrong type
            json!({
                "type": "clipboard-put",
                "fromDeviceId": "dev-2",
                "nonce": valid_nonce(),
                "sealed": valid_min_sealed(),
                "sentAt": 1_700_000_000u64,
            })
            .to_string(),
            // Nonce wrong length
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": "A".repeat(31),
                "sealed": valid_min_sealed(),
                "sentAt": 1_700_000_000u64,
            })
            .to_string(),
            // Nonce with padding / non-url alphabet
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": format!("{}+", "A".repeat(31)),
                "sealed": valid_min_sealed(),
                "sentAt": 1_700_000_000u64,
            })
            .to_string(),
            // Sealed too short (22 chars = 16 bytes)
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": valid_nonce(),
                "sealed": "A".repeat(22),
                "sentAt": 1_700_000_000u64,
            })
            .to_string(),
            // Sealed too long (87404 chars = 65553 bytes)
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": valid_nonce(),
                "sealed": "A".repeat(87_404),
                "sentAt": 1_700_000_000u64,
            })
            .to_string(),
            // Non-canonical trailing bits on 23-char base64url (rem 3: last 2 bits must be 0; 'B' = 1)
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": valid_nonce(),
                "sealed": format!("{}B", "A".repeat(22)),
                "sentAt": 1_700_000_000u64,
            })
            .to_string(),
            // sentAt zero
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": valid_nonce(),
                "sealed": valid_min_sealed(),
                "sentAt": 0u64,
            })
            .to_string(),
            // sentAt above MAX_SAFE_JSON_INT
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "dev-2",
                "nonce": valid_nonce(),
                "sealed": valid_min_sealed(),
                "sentAt": MAX_SAFE_JSON_INT + 1,
            })
            .to_string(),
            // sentAt float
            format!(
                r#"{{"type":"clipboard-event","fromDeviceId":"dev-2","nonce":"{}","sealed":"{}","sentAt":1700000000.0}}"#,
                valid_nonce(),
                valid_min_sealed()
            ),
            // Invalid fromDeviceId
            json!({
                "type": "clipboard-event",
                "fromDeviceId": "bad id",
                "nonce": valid_nonce(),
                "sealed": valid_min_sealed(),
                "sentAt": 1_700_000_000u64,
            })
            .to_string(),
        ];

        for raw in bad_cases {
            assert!(parse_clipboard_event(&raw).is_err(), "must reject malformed event");
        }
    }

    #[test]
    fn enforces_sent_at_freshness_window() {
        let now = 1_700_000_100u64;
        assert!(is_fresh_sent_at(now, now));
        assert!(is_fresh_sent_at(now - 30, now));
        assert!(is_fresh_sent_at(now + 30, now));
        assert!(!is_fresh_sent_at(now - 31, now));
        assert!(!is_fresh_sent_at(now + 31, now));
        assert!(!is_fresh_sent_at(0, now));
        assert!(!is_fresh_sent_at(MAX_SAFE_JSON_INT + 1, now));
    }
}
