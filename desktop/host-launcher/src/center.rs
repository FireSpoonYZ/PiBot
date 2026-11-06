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

fn map_fail(fail: HttpFail, step: &str, auth_failed_on_401: bool) -> AppError {
    match fail {
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
            .user_agent(concat!("e-launcher-host/", env!("CARGO_PKG_VERSION")))
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
        let device_id = response.get("deviceId").and_then(Value::as_str).unwrap_or("").to_string();
        let device_token = response.get("deviceToken").and_then(Value::as_str).unwrap_or("").to_string();
        if device_id.is_empty() || device_token.len() < 43 {
            return Err(AppError::new("CENTER_ERROR", "POST /api/devices: response is missing deviceId or deviceToken"));
        }
        let display_name =
            response.get("displayName").and_then(Value::as_str).unwrap_or(display_name).to_string();
        Ok(Registered { device_id, device_token, display_name })
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

    #[test]
    fn error_mapping() {
        let body = r#"{"error":{"code":"INVALID_ARGUMENT","message":"bad"}}"#;
        let e = map_fail(HttpFail::Status(400, body.into()), "POST /api/devices", true);
        assert_eq!(e.code, "CENTER_ERROR");
        assert!(e.message.contains("INVALID_ARGUMENT"));
        assert_eq!(map_fail(HttpFail::Status(401, String::new()), "login", true).code, "OWNER_AUTH_FAILED");
        assert_eq!(map_fail(HttpFail::Status(401, String::new()), "session", false).code, "CENTER_ERROR");
        assert_eq!(map_fail(HttpFail::Transport("refused".into()), "x", true).code, "CENTER_UNREACHABLE");
    }
}
