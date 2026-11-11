//! Owner login + device registration against the center (contract §1).

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::util::{AppError, AppResult};

/// Validates and normalizes a center origin: `https://host[:port]` (or loopback `http://`) without a trailing slash.
pub fn normalize_center_url(value: &str) -> AppResult<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let rest = if let Some(r) = trimmed.strip_prefix("https://") {
        r
    } else if let Some(r) = trimmed.strip_prefix("http://") {
        let host = r.split(&['/', ':'][..]).next().unwrap_or("");
        if !matches!(host, "localhost" | "127.0.0.1") && !r.starts_with("[::1]") {
            return Err(AppError::new("INVALID_ARGUMENT", "--center-url must be an https:// URL"));
        }
        r
    } else {
        return Err(AppError::new("INVALID_ARGUMENT", "--center-url must be an https:// URL"));
    };
    if rest.is_empty() || rest.contains(char::is_whitespace) || rest.contains('?') || rest.contains('#') {
        return Err(AppError::new("INVALID_ARGUMENT", "--center-url is not a valid https origin"));
    }
    Ok(trimmed.to_string())
}

/// Merges `Set-Cookie` header values into a simple name→value jar. Deleted
/// cookies (empty value or `Max-Age=0`) are removed. Later headers win.
pub fn merge_set_cookies(jar: &mut Vec<(String, String)>, headers: &[&str]) {
    for header in headers {
        let mut parts = header.split(';');
        let Some(pair) = parts.next() else { continue };
        let Some((name, value)) = pair.split_once('=') else { continue };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let value = value.trim();
        let expired = parts.any(|attr| {
            let attr = attr.trim();
            match (attr.get(..8), attr.get(8..)) {
                (Some(prefix), Some(rest)) => {
                    prefix.eq_ignore_ascii_case("max-age=") && (rest.trim().starts_with('0') || rest.trim().starts_with('-'))
                }
                _ => false,
            }
        });
        jar.retain(|(n, _)| n != name);
        if !value.is_empty() && !expired {
            jar.push((name.to_string(), value.to_string()));
        }
    }
}

pub fn cookie_header(jar: &[(String, String)]) -> Option<String> {
    if jar.is_empty() {
        return None;
    }
    Some(jar.iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; "))
}

enum HttpFail {
    Status(u16, String),
    Transport(String),
}

/// Extracts `error.code`/`error.message` (or top-level `code`/`message`) from a center error body.
pub fn center_error_detail(body: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(body) else { return (None, None) };
    let source = value.get("error").filter(|e| e.is_object()).unwrap_or(&value);
    let code = source.get("code").and_then(Value::as_str).map(str::to_string);
    let message = source.get("message").and_then(Value::as_str).map(str::to_string);
    (code, message)
}

/// rustls rejects an untrusted, expired or mismatched server certificate as "invalid peer certificate: …".
/// The center did answer, so this is a missing trust anchor (typically a pairing code minted before the
/// owner saved the private CA), not a network problem, and the user needs to be told which.
fn is_certificate_failure(message: &str) -> bool {
    message.contains("invalid peer certificate")
}

fn map_fail(fail: HttpFail, step: &str, auth_failed_on_401: bool) -> AppError {
    match fail {
        HttpFail::Transport(message) if is_certificate_failure(&message) => {
            AppError::new("CENTER_CERT_UNTRUSTED", format!("{step}: {message}"))
        }
        HttpFail::Transport(message) => AppError::new("CENTER_UNREACHABLE", format!("{step}: {message}")),
        HttpFail::Status(401, _) if auth_failed_on_401 => {
            AppError::new("OWNER_AUTH_FAILED", format!("{step}: owner password rejected"))
        }
        HttpFail::Status(status, body) => {
            let (code, message) = center_error_detail(&body);
            let mut text = format!("{step}: HTTP {status}");
            if let Some(code) = &code {
                text.push_str(&format!(" {code}"));
            }
            if let Some(message) = message.filter(|m| !m.is_empty()) {
                text.push_str(&format!(" ({message})"));
            }
            AppError::new("CENTER_ERROR", text)
        }
    }
}

fn tls_config(ca_file: &Path) -> AppResult<Arc<rustls::ClientConfig>> {
    let bytes = fs::read(ca_file).map_err(|e| {
        AppError::new("INVALID_ARGUMENT", format!("cannot read --center-ca-file {}: {e}", ca_file.display()))
    })?;
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut added = 0usize;
    for cert in rustls_pemfile::certs(&mut &bytes[..]) {
        let cert = cert.map_err(|e| AppError::new("INVALID_ARGUMENT", format!("invalid PEM in CA file: {e}")))?;
        roots
            .add(cert)
            .map_err(|e| AppError::new("INVALID_ARGUMENT", format!("invalid certificate in CA file: {e}")))?;
        added += 1;
    }
    if added == 0 {
        return Err(AppError::new("INVALID_ARGUMENT", "--center-ca-file contains no PEM certificates"));
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| AppError::new("INTERNAL_ERROR", format!("TLS setup failed: {e}")))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

pub struct CenterClient {
    agent: ureq::Agent,
    base: String,
    cookies: Vec<(String, String)>,
}

impl CenterClient {
    pub fn new(center_url: &str, ca_file: Option<&Path>) -> AppResult<Self> {
        let mut builder = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .redirects(0)
            .user_agent(concat!("pibot-host/", env!("CARGO_PKG_VERSION")))
            .try_proxy_from_env(true);
        if let Some(ca) = ca_file {
            builder = builder.tls_config(tls_config(ca)?);
        }
        Ok(CenterClient { agent: builder.build(), base: normalize_center_url(center_url)?, cookies: Vec::new() })
    }

    fn absorb_cookies(&mut self, response: &ureq::Response) {
        let headers = response.all("set-cookie");
        merge_set_cookies(&mut self.cookies, &headers);
    }

    fn send(&mut self, method: &str, path: &str, csrf: Option<&str>, body: Option<Value>) -> Result<Value, HttpFail> {
        let url = format!("{}{}", self.base, path);
        let mut request = self.agent.request(method, &url).set("accept", "application/json");
        if let Some(cookie) = cookie_header(&self.cookies) {
            request = request.set("cookie", &cookie);
        }
        if let Some(token) = csrf {
            request = request.set("x-csrf-token", token);
        }
        let result = match body {
            Some(body) => request.set("content-type", "application/json").send_string(&body.to_string()),
            None => request.call(),
        };
        match result {
            Ok(response) => {
                self.absorb_cookies(&response);
                let text = response.into_string().map_err(|e| HttpFail::Transport(e.to_string()))?;
                if text.trim().is_empty() {
                    return Ok(Value::Null);
                }
                serde_json::from_str(&text)
                    .map_err(|_| HttpFail::Status(200, r#"{"error":{"message":"response is not JSON"}}"#.into()))
            }
            Err(ureq::Error::Status(status, response)) => {
                self.absorb_cookies(&response);
                let text = response.into_string().unwrap_or_default();
                Err(HttpFail::Status(status, text))
            }
            Err(ureq::Error::Transport(transport)) => Err(HttpFail::Transport(transport.to_string())),
        }
    }

    fn csrf_token(&mut self) -> AppResult<(bool, String)> {
        let session = self.send("GET", "/api/session", None, None).map_err(|f| map_fail(f, "GET /api/session", false))?;
        let token = session
            .get("csrfToken")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| AppError::new("CENTER_ERROR", "GET /api/session: response has no csrfToken"))?
            .to_string();
        let authenticated = session.get("authenticated").and_then(Value::as_bool).unwrap_or(false);
        Ok((authenticated, token))
    }

    /// Owner login (§1 steps 1–3) followed by POST /api/devices. device_id is
    /// the local Host store identity the center must register; replace_existing
    /// rotates the token while keeping Bot records. A registered ID without
    /// replace maps to ALREADY_CONFIGURED (center 409).
    pub fn register_device(
        &mut self,
        password: &str,
        display_name: &str,
        platform: &str,
        device_id: &str,
        device_token: &str,
        replace_existing: bool,
    ) -> AppResult<Registered> {
        let (_, csrf) = self.csrf_token()?;
        self.send("POST", "/api/session", Some(&csrf), Some(json!({ "password": password })))
            .map_err(|f| map_fail(f, "POST /api/session", true))?;
        let (authenticated, csrf) = self.csrf_token()?;
        if !authenticated {
            return Err(AppError::new("OWNER_AUTH_FAILED", "center did not establish an owner session"));
        }
        let body = json!({
            "displayName": display_name,
            "platform": platform,
            "deviceId": device_id,
            "deviceToken": device_token,
            "replaceExisting": replace_existing,
        });
        let response = self
            .send("POST", "/api/devices", Some(&csrf), Some(body))
            .map_err(|f| match f {
                HttpFail::Status(409, body) => {
                    let (_, message) = center_error_detail(&body);
                    let detail = message.map(|m| format!(" ({m})")).unwrap_or_default();
                    AppError::new(
                        "ALREADY_CONFIGURED",
                        format!("POST /api/devices: deviceId is already registered{detail}; use --force to replace"),
                    )
                }
                other => map_fail(other, "POST /api/devices", true),
            })?;
        parse_registered(&response, display_name, "POST /api/devices")
    }

    /// Redeems a one-time pairing code (`POST /api/pairing/redeem`). No owner session
    /// is involved: the secret is the credential, and the device brings its own
    /// identity and token, so repeating the call after a lost response is idempotent
    /// on the center. A known device ID is re-bound there, keeping its Bots.
    pub fn redeem_device(
        &mut self,
        secret: &str,
        display_name: &str,
        platform: &str,
        device_id: &str,
        device_token: &str,
    ) -> AppResult<Registered> {
        let body = json!({
            "code": secret,
            "deviceId": device_id,
            "deviceToken": device_token,
            "displayName": display_name,
            "platform": platform,
        });
        let response = self
            .send("POST", REDEEM_PATH, None, Some(body))
            .map_err(map_redeem_fail)?;
        parse_registered(&response, display_name, REDEEM_PATH_STEP)
    }
}

const REDEEM_PATH: &str = "/api/pairing/redeem";
const REDEEM_PATH_STEP: &str = "POST /api/pairing/redeem";

fn parse_registered(response: &Value, display_name: &str, step: &str) -> AppResult<Registered> {
    let device_id = response.get("deviceId").and_then(Value::as_str).unwrap_or("").to_string();
    let device_token = response.get("deviceToken").and_then(Value::as_str).unwrap_or("").to_string();
    if device_id.is_empty() || device_token.len() < 43 {
        return Err(AppError::new("CENTER_ERROR", format!("{step}: response is missing deviceId or deviceToken")));
    }
    let display_name = response.get("displayName").and_then(Value::as_str).unwrap_or(display_name).to_string();
    Ok(Registered { device_id, device_token, display_name })
}

/// Pairing-code failures keep their center codes so the UI can say exactly what is
/// wrong; a center that predates pairing codes answers 404/405 and gets its own code.
fn map_redeem_fail(fail: HttpFail) -> AppError {
    let HttpFail::Status(status, body) = fail else {
        return map_fail(fail, REDEEM_PATH_STEP, false);
    };
    let (code, _) = center_error_detail(&body);
    match (status, code.as_deref()) {
        (_, Some("PAIRING_CODE_INVALID")) => AppError::new("PAIRING_CODE_INVALID", "the pairing code is not valid"),
        (_, Some("PAIRING_CODE_USED")) => AppError::new("PAIRING_CODE_USED", "the pairing code has already been used"),
        (_, Some("PAIRING_CODE_EXPIRED")) => AppError::new("PAIRING_CODE_EXPIRED", "the pairing code has expired"),
        (_, Some("PAIRING_CODE_DEVICE_MISMATCH")) => AppError::new(
            "PAIRING_CODE_DEVICE_MISMATCH",
            "the pairing code was issued for a different device",
        ),
        (_, Some("DEVICE_ALREADY_REGISTERED")) => AppError::new(
            "DEVICE_ALREADY_REGISTERED",
            "this device is already registered on the center; ask the owner to re-pair it from the device card",
        ),
        (429, _) => AppError::new("RATE_LIMITED", "too many pairing attempts; wait a minute and retry"),
        (404 | 405, _) => AppError::new(
            "CENTER_UNSUPPORTED",
            "this center does not support pairing codes; upgrade the center or pair with the owner password",
        ),
        _ => map_fail(HttpFail::Status(status, body), REDEEM_PATH_STEP, false),
    }
}

pub struct Registered {
    pub device_id: String,
    pub device_token: String,
    pub display_name: String,
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "linux"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_extraction_keeps_latest() {
        let mut jar = Vec::new();
        merge_set_cookies(&mut jar, &["session=abc; Path=/; HttpOnly; Secure; SameSite=Strict"]);
        assert_eq!(cookie_header(&jar).as_deref(), Some("session=abc"));
        merge_set_cookies(&mut jar, &["other=1; Path=/", "session=def; Path=/; Max-Age=2592000"]);
        assert_eq!(cookie_header(&jar).as_deref(), Some("other=1; session=def"));
        merge_set_cookies(&mut jar, &["other=; Max-Age=0"]);
        assert_eq!(cookie_header(&jar).as_deref(), Some("session=def"));
        merge_set_cookies(&mut jar, &["session=x; max-age=0", "garbage"]);
        assert_eq!(cookie_header(&jar), None);
    }

    #[test]
    fn cookie_value_with_equals() {
        let mut jar = Vec::new();
        merge_set_cookies(&mut jar, &["session=a=b==; Path=/"]);
        assert_eq!(cookie_header(&jar).as_deref(), Some("session=a=b=="));
    }

    #[test]
    fn center_url_normalization() {
        assert_eq!(normalize_center_url(" https://c.example:3000/ ").unwrap(), "https://c.example:3000");
        assert_eq!(normalize_center_url("http://c").unwrap_err().code, "INVALID_ARGUMENT");
        assert_eq!(normalize_center_url("https://").unwrap_err().code, "INVALID_ARGUMENT");
    }

    /// The exact transport error ureq/rustls produced against a private-CA center when no CA was given.
    const UNKNOWN_ISSUER: &str = "https://10.10.10.10:8443/api/pairing/redeem: Connection Failed: tls connection init failed: invalid peer certificate: UnknownIssuer";

    #[test]
    fn error_mapping() {
        let body = r#"{"error":{"code":"INVALID_ARGUMENT","message":"bad"}}"#;
        let e = map_fail(HttpFail::Status(400, body.into()), "POST /api/devices", true);
        assert_eq!(e.code, "CENTER_ERROR");
        assert!(e.message.contains("INVALID_ARGUMENT"));
        assert_eq!(map_fail(HttpFail::Status(401, String::new()), "login", true).code, "OWNER_AUTH_FAILED");
        assert_eq!(map_fail(HttpFail::Status(401, String::new()), "session", false).code, "CENTER_ERROR");
        assert_eq!(map_fail(HttpFail::Transport("refused".into()), "x", true).code, "CENTER_UNREACHABLE");
        let untrusted = map_fail(HttpFail::Transport(UNKNOWN_ISSUER.into()), "POST /api/pairing/redeem", false);
        assert_eq!(untrusted.code, "CENTER_CERT_UNTRUSTED");
        assert!(untrusted.message.contains("UnknownIssuer"));
        let wrong_name = "https://c/x: Connection Failed: tls connection init failed: invalid peer certificate: NotValidForName";
        assert_eq!(map_fail(HttpFail::Transport(wrong_name.into()), "x", false).code, "CENTER_CERT_UNTRUSTED");
    }

    #[test]
    fn redeem_error_mapping_keeps_pairing_codes() {
        let status = |code: u16, body: &str| map_redeem_fail(HttpFail::Status(code, body.into())).code;
        let coded = |name: &str| format!(r#"{{"error":{{"code":"{name}","message":"x"}}}}"#);
        assert_eq!(status(401, &coded("PAIRING_CODE_INVALID")), "PAIRING_CODE_INVALID");
        assert_eq!(status(409, &coded("PAIRING_CODE_USED")), "PAIRING_CODE_USED");
        assert_eq!(status(410, &coded("PAIRING_CODE_EXPIRED")), "PAIRING_CODE_EXPIRED");
        assert_eq!(status(429, &coded("RATE_LIMITED")), "RATE_LIMITED");
        // A generic code cannot take over a registered identity; a targeted code is for one device only.
        assert_eq!(status(409, &coded("DEVICE_ALREADY_REGISTERED")), "DEVICE_ALREADY_REGISTERED");
        assert_eq!(status(409, &coded("PAIRING_CODE_DEVICE_MISMATCH")), "PAIRING_CODE_DEVICE_MISMATCH");
        // A center without pairing codes has no such route: SPA fallback / method not allowed.
        assert_eq!(status(404, &coded("NOT_FOUND")), "CENTER_UNSUPPORTED");
        assert_eq!(status(405, ""), "CENTER_UNSUPPORTED");
        // A plain 401 must never read as "owner password rejected": redeem has no owner password.
        assert_eq!(status(401, ""), "CENTER_ERROR");
        assert_eq!(status(500, &coded("INTERNAL_ERROR")), "CENTER_ERROR");
        assert_eq!(map_redeem_fail(HttpFail::Transport("refused".into())).code, "CENTER_UNREACHABLE");
        // A code without the private CA reaches the center but cannot trust it: say so, not "unreachable".
        assert_eq!(map_redeem_fail(HttpFail::Transport(UNKNOWN_ISSUER.into())).code, "CENTER_CERT_UNTRUSTED");
    }

    /// Serves one canned response on a loopback port and hands back the raw request it saw.
    fn serve_once(status_line: &'static str, body: String) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..end]).to_ascii_lowercase();
                    let length = head
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .map(|value| value.trim().parse::<usize>().unwrap())
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&raw).into_owned()
        });
        (url, handle)
    }

    #[test]
    fn redeem_sends_the_device_identity_without_any_session() {
        let token = "t".repeat(43);
        let reply = format!(r#"{{"deviceId":"mac-1","deviceToken":"{token}","displayName":"Center Name","platform":"macos"}}"#);
        let (url, request) = serve_once("201 Created", reply);
        let mut client = CenterClient::new(&url, None).unwrap();
        let registered = client.redeem_device("secret-secret-secret-secret-secret-1", "My Mac", "macos", "mac-1", &token).unwrap();
        assert_eq!(registered.device_id, "mac-1");
        assert_eq!(registered.device_token, token);
        // The center's name wins: it keeps an owner rename when the device re-pairs.
        assert_eq!(registered.display_name, "Center Name");

        let raw = request.join().unwrap();
        let (head, body) = raw.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("POST /api/pairing/redeem HTTP/1.1"), "{head}");
        let lowered = head.to_ascii_lowercase();
        assert!(!lowered.contains("cookie:") && !lowered.contains("x-csrf-token"), "{head}");
        let sent: Value = serde_json::from_str(body).unwrap();
        assert_eq!(
            sent,
            json!({
                "code": "secret-secret-secret-secret-secret-1",
                "deviceId": "mac-1",
                "deviceToken": token,
                "displayName": "My Mac",
                "platform": "macos",
            })
        );
    }

    #[test]
    fn redeem_surfaces_center_refusals_and_bad_replies() {
        let token = "t".repeat(43);
        for (status_line, body, expected) in [
            ("410 Gone", r#"{"error":{"code":"PAIRING_CODE_EXPIRED","message":"x"}}"#, "PAIRING_CODE_EXPIRED"),
            ("409 Conflict", r#"{"error":{"code":"PAIRING_CODE_USED","message":"x"}}"#, "PAIRING_CODE_USED"),
            ("404 Not Found", r#"{"error":{"code":"NOT_FOUND","message":"Not found"}}"#, "CENTER_UNSUPPORTED"),
            ("201 Created", r#"{"deviceId":"mac-1"}"#, "CENTER_ERROR"),
        ] {
            let (url, request) = serve_once(status_line, body.to_string());
            let mut client = CenterClient::new(&url, None).unwrap();
            // `.err()` rather than `unwrap_err()`: Registered carries a token and deliberately has no Debug.
            let error = client.redeem_device("s", "My Mac", "macos", "mac-1", &token).err().expect("redeem must fail");
            assert_eq!(error.code, expected, "{status_line}: {}", error.message);
            request.join().unwrap();
        }
    }
}
