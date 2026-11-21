use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use http::header::{HeaderName, HeaderValue, ORIGIN};
use http::Uri;
use rustls::{ClientConfig, RootCertStore};
use rustls_pemfile::Item;
use rustls_pki_types::ServerName;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use url::{Host, Url};

use crate::protocol::{CLIPBOARD_UPGRADE_HEADER, CLIPBOARD_UPGRADE_VERSION};
use crate::LinkStartError;

const MAX_ORIGIN_LEN: usize = 2048;
const MAX_DEVICE_ID_LEN: usize = 200;
const MIN_DEVICE_TOKEN_LEN: usize = 32;
const MAX_DEVICE_TOKEN_LEN: usize = 512;
const MAX_CA_PEM_BYTES: usize = 256 * 1024;
const ROUTING_ID_HEX_LEN: usize = 64;

pub(crate) enum ConnectTarget {
    Domain(String, u16),
    SocketAddr(SocketAddr),
}

pub(crate) struct ValidatedEndpoint {
    pub(crate) use_tls: bool,
    pub(crate) connect_target: ConnectTarget,
    pub(crate) server_name: Option<ServerName<'static>>,
    pub(crate) ws_url: String,
}

impl ValidatedEndpoint {
    pub(crate) fn build_upgrade_request(&self) -> Result<http::Request<()>, ()> {
        let mut req = self.ws_url.as_str().into_client_request().map_err(|_| ())?;
        if req.uri().path_and_query().map(|pq| pq.as_str()) != Some("/v1/link") {
            return Err(());
        }
        req.headers_mut().remove(ORIGIN);
        req.headers_mut().insert(
            HeaderName::from_static(CLIPBOARD_UPGRADE_HEADER),
            HeaderValue::from_static(CLIPBOARD_UPGRADE_VERSION),
        );
        Ok(req)
    }
}

pub(crate) fn validate_device_id(id: &str) -> bool {
    (1..=MAX_DEVICE_ID_LEN).contains(&id.len())
        && id.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

pub(crate) fn validate_device_token(token: &str) -> bool {
    (MIN_DEVICE_TOKEN_LEN..=MAX_DEVICE_TOKEN_LEN).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) fn validate_routing_id(routing_id: &str) -> bool {
    routing_id.len() == ROUTING_ID_HEX_LEN
        && routing_id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn parse_raw_authority_host(raw_authority: &str) -> Result<&str, LinkStartError> {
    if raw_authority.is_empty() || raw_authority.ends_with(':') {
        return Err(LinkStartError::InvalidOrigin);
    }
    if raw_authority.starts_with('[') {
        let Some(close_idx) = raw_authority.find(']') else {
            return Err(LinkStartError::InvalidOrigin);
        };
        let host = &raw_authority[..=close_idx];
        let rest = &raw_authority[close_idx + 1..];
        if !rest.is_empty() {
            let Some(port_str) = rest.strip_prefix(':') else {
                return Err(LinkStartError::InvalidOrigin);
            };
            validate_port_digits(port_str)?;
        }
        return Ok(host);
    }

    match raw_authority.split_once(':') {
        Some((host, port_str)) => {
            if host.is_empty() {
                return Err(LinkStartError::InvalidOrigin);
            }
            validate_port_digits(port_str)?;
            Ok(host)
        }
        None => Ok(raw_authority),
    }
}

fn validate_port_digits(port_str: &str) -> Result<(), LinkStartError> {
    if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return Err(LinkStartError::InvalidOrigin);
    }
    let port: u16 = port_str.parse().map_err(|_| LinkStartError::InvalidOrigin)?;
    if port == 0 {
        return Err(LinkStartError::InvalidOrigin);
    }
    Ok(())
}

/// Validates a bare Center origin (`https://host[:port]` or literal loopback
/// `http://127.0.0.1[:port]` / `http://[::1][:port]`, with at most one trailing
/// slash) and constructs the canonical `/v1/link` WebSocket endpoint.
pub(crate) fn parse_center_origin(raw: &str) -> Result<ValidatedEndpoint, LinkStartError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_ORIGIN_LEN {
        return Err(LinkStartError::InvalidOrigin);
    }
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err(LinkStartError::InvalidOrigin);
    }

    let without_trailing = trimmed.strip_suffix('/').unwrap_or(trimmed);
    let Some((_, raw_authority)) = without_trailing.split_once("://") else {
        return Err(LinkStartError::InvalidOrigin);
    };
    if raw_authority.is_empty()
        || raw_authority.contains(|c| matches!(c, '/' | '?' | '#' | '@' | '\\'))
    {
        return Err(LinkStartError::InvalidOrigin);
    }
    let raw_host = parse_raw_authority_host(raw_authority)?;

    let parsed = Url::parse(without_trailing).map_err(|_| LinkStartError::InvalidOrigin)?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/"
        || parsed.port() == Some(0)
    {
        return Err(LinkStartError::InvalidOrigin);
    }

    let (use_tls, connect_target, server_name, canonical_host, explicit_port) =
        match parsed.scheme() {
            "https" => {
                let effective_port = parsed
                    .port_or_known_default()
                    .ok_or(LinkStartError::InvalidOrigin)?;
                let explicit_port = parsed.port();
                match parsed.host() {
                    Some(Host::Domain(domain)) => {
                        if domain.is_empty() {
                            return Err(LinkStartError::InvalidOrigin);
                        }
                        let sni = ServerName::try_from(domain.to_owned())
                            .map_err(|_| LinkStartError::InvalidOrigin)?;
                        (
                            true,
                            ConnectTarget::Domain(domain.to_owned(), effective_port),
                            Some(sni),
                            domain.to_owned(),
                            explicit_port,
                        )
                    }
                    Some(Host::Ipv4(v4)) => (
                        true,
                        ConnectTarget::SocketAddr(SocketAddr::from((v4, effective_port))),
                        Some(ServerName::from(IpAddr::V4(v4))),
                        v4.to_string(),
                        explicit_port,
                    ),
                    Some(Host::Ipv6(v6)) => (
                        true,
                        ConnectTarget::SocketAddr(SocketAddr::from((v6, effective_port))),
                        Some(ServerName::from(IpAddr::V6(v6))),
                        format!("[{v6}]"),
                        explicit_port,
                    ),
                    None => return Err(LinkStartError::InvalidOrigin),
                }
            }
            "http" => {
                let effective_port = parsed
                    .port_or_known_default()
                    .ok_or(LinkStartError::InvalidOrigin)?;
                let explicit_port = parsed.port();
                match (raw_host, parsed.host()) {
                    ("127.0.0.1", Some(Host::Ipv4(v4))) if v4 == Ipv4Addr::LOCALHOST => (
                        false,
                        ConnectTarget::SocketAddr(SocketAddr::from((v4, effective_port))),
                        None,
                        "127.0.0.1".to_owned(),
                        explicit_port,
                    ),
                    ("[::1]", Some(Host::Ipv6(v6))) if v6 == Ipv6Addr::LOCALHOST => (
                        false,
                        ConnectTarget::SocketAddr(SocketAddr::from((v6, effective_port))),
                        None,
                        "[::1]".to_owned(),
                        explicit_port,
                    ),
                    _ => return Err(LinkStartError::InvalidOrigin),
                }
            }
            _ => return Err(LinkStartError::InvalidOrigin),
        };

    let ws_scheme = if use_tls { "wss" } else { "ws" };
    let authority = match explicit_port {
        Some(port) => format!("{canonical_host}:{port}"),
        None => canonical_host,
    };
    let ws_url = format!("{ws_scheme}://{authority}/v1/link");

    let uri = Uri::try_from(ws_url.as_str()).map_err(|_| LinkStartError::InvalidOrigin)?;
    if uri.path_and_query().map(|pq| pq.as_str()) != Some("/v1/link") {
        return Err(LinkStartError::InvalidOrigin);
    }

    Ok(ValidatedEndpoint {
        use_tls,
        connect_target,
        server_name,
        ws_url,
    })
}

/// Builds a rustls `ClientConfig` using the explicit `ring` provider without
/// mutating any process-global default provider.
///
/// Trust roots are either the bundled public WebPKI roots (`ca_pem == None`)
/// or exclusively the caller-supplied private CA PEM (`ca_pem == Some(_)`).
pub(crate) fn build_tls_config(ca_pem: Option<&str>) -> Result<Arc<ClientConfig>, LinkStartError> {
    let mut roots = RootCertStore::empty();
    match ca_pem {
        Some(pem) => {
            if pem.trim().is_empty() || pem.len() > MAX_CA_PEM_BYTES {
                return Err(LinkStartError::InvalidCaPem);
            }
            let mut reader: &[u8] = pem.as_bytes();
            let mut added = 0usize;
            while let Some(item) =
                rustls_pemfile::read_one(&mut reader).map_err(|_| LinkStartError::InvalidCaPem)?
            {
                match item {
                    Item::X509Certificate(cert) => {
                        roots.add(cert).map_err(|_| LinkStartError::InvalidCaPem)?;
                        added += 1;
                    }
                    _ => return Err(LinkStartError::InvalidCaPem),
                }
            }
            if added == 0 {
                return Err(LinkStartError::InvalidCaPem);
            }
        }
        None => {
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        }
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| LinkStartError::TlsConfig)?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_https_and_literal_loopback_http_origins() {
        let cases = [
            ("https://center.example", "wss://center.example/v1/link", true),
            (" https://center.example/ ", "wss://center.example/v1/link", true),
            ("https://center.example:443", "wss://center.example/v1/link", true),
            ("https://center.example:8443/", "wss://center.example:8443/v1/link", true),
            ("https://192.168.1.10:8443", "wss://192.168.1.10:8443/v1/link", true),
            ("https://[::1]:8443", "wss://[::1]:8443/v1/link", true),
            ("http://127.0.0.1:8790", "ws://127.0.0.1:8790/v1/link", false),
            ("http://127.0.0.1:8790/", "ws://127.0.0.1:8790/v1/link", false),
            ("http://127.0.0.1", "ws://127.0.0.1/v1/link", false),
            ("http://[::1]:8790", "ws://[::1]:8790/v1/link", false),
            ("http://[::1]:8790/", "ws://[::1]:8790/v1/link", false),
        ];

        for (raw, expected_ws, expected_tls) in cases {
            let endpoint = parse_center_origin(raw).expect("valid origin");
            assert_eq!(endpoint.ws_url, expected_ws, "origin={raw}");
            assert_eq!(endpoint.use_tls, expected_tls, "origin={raw}");
            assert_eq!(endpoint.server_name.is_some(), expected_tls, "origin={raw}");
        }
    }

    #[test]
    fn rejects_non_origin_and_non_literal_loopback_http() {
        let rejected = [
            "",
            "   ",
            "center.example",
            "ftp://center.example",
            "ws://127.0.0.1:8790/v1/link",
            "wss://center.example/v1/link",
            "http://center.example",
            "http://localhost:8790",
            "http://localhost",
            "http://127.0.0.2:8790",
            "http://0x7f000001:8790",
            "http://127.1:8790",
            "http://0.0.0.0:8790",
            "http://[::ffff:127.0.0.1]:8790",
            "https://center.example/v1/link",
            "https://center.example/subpath",
            "https://center.example//",
            "https://center.example/?a=1",
            "https://center.example?a=1",
            "https://center.example/#frag",
            "https://center.example#frag",
            "https://user@center.example",
            "https://user:pass@center.example",
            "https://center.example:0",
            "https://center.example:",
            "https://center.example\\path",
            "http://127.0.0.1:0",
        ];

        for raw in rejected {
            assert_eq!(
                parse_center_origin(raw).err(),
                Some(LinkStartError::InvalidOrigin),
                "must reject {raw:?}"
            );
        }
    }

    #[test]
    fn upgrade_request_sets_clipboard_header_and_omits_origin() {
        let endpoint = parse_center_origin("https://center.example:8443/").expect("valid");
        let req = endpoint.build_upgrade_request().expect("request");
        assert_eq!(req.uri().path_and_query().map(|pq| pq.as_str()), Some("/v1/link"));
        assert!(req.headers().get(ORIGIN).is_none());
        assert_eq!(
            req.headers()
                .get(CLIPBOARD_UPGRADE_HEADER)
                .and_then(|v| v.to_str().ok()),
            Some("1")
        );
    }

    #[test]
    fn validates_credentials_routing_id_and_ca_pem() {
        assert!(validate_device_id("dev-1"));
        assert!(!validate_device_id(""));
        assert!(!validate_device_id("dev 1"));
        assert!(!validate_device_id(&"a".repeat(201)));

        assert!(validate_device_token(&"A".repeat(32)));
        assert!(!validate_device_token(&"A".repeat(31)));
        assert!(!validate_device_token(&"A".repeat(513)));
        assert!(!validate_device_token(&format!("{}!", "A".repeat(32))));

        assert!(validate_routing_id(&"a0".repeat(32)));
        assert!(!validate_routing_id(&"A0".repeat(32)));
        assert!(!validate_routing_id(&"a0".repeat(31)));
        assert!(!validate_routing_id(&"g0".repeat(32)));

        assert!(build_tls_config(None).is_ok());
        assert_eq!(build_tls_config(Some("")).err(), Some(LinkStartError::InvalidCaPem));
        assert_eq!(
            build_tls_config(Some("not a certificate")).err(),
            Some(LinkStartError::InvalidCaPem)
        );
        assert_eq!(
            build_tls_config(Some(
                "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
            ))
            .err(),
            Some(LinkStartError::InvalidCaPem)
        );
    }
}
