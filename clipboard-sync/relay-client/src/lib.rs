#![forbid(unsafe_code)]

mod config;
mod protocol;
mod replay;
mod session;

use std::fmt;
use std::sync::Arc;

use clipboard_sync::GroupKey;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use crate::config::{
    build_tls_config, parse_center_origin, validate_device_id, validate_device_token,
    validate_routing_id,
};
use crate::session::{run_link, LinkShared};

/// Configuration for a native clipboard sync relay link.
///
/// Deliberately does not implement `Debug` because it holds `device_token`.
pub struct LinkConfig {
    pub origin: String,
    pub device_id: String,
    pub device_token: String,
    pub ca_pem: Option<String>,
}

/// Lifecycle state of a clipboard sync relay link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkStatus {
    Connecting,
    Online,
    Offline,
    Unauthorized,
    Unsupported,
    CertificateError,
    GroupFull,
    Replaced,
}

impl LinkStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Unauthorized => "unauthorized",
            Self::Unsupported => "unsupported",
            Self::CertificateError => "certificateError",
            Self::GroupFull => "groupFull",
            Self::Replaced => "replaced",
        }
    }
}

/// Consistent point-in-time view of link status and active session generation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LinkSnapshot {
    pub status: LinkStatus,
    pub generation: u64,
}

/// Decrypted clipboard text received from an authenticated peer.
///
/// Deliberately does not implement `Debug` because it holds clipboard plaintext.
pub struct IncomingClip {
    pub generation: u64,
    pub text: String,
}

/// Static validation or startup error returned by [`start`].
///
/// Never embeds request data, response bodies, URLs, keys, tokens, or plaintext.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkStartError {
    InvalidOrigin,
    InvalidDeviceId,
    InvalidDeviceToken,
    InvalidGroupKey,
    InvalidCaPem,
    TlsConfig,
    NoTokioRuntime,
}

impl fmt::Display for LinkStartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidOrigin => "invalid center origin",
            Self::InvalidDeviceId => "invalid device id",
            Self::InvalidDeviceToken => "invalid device token",
            Self::InvalidGroupKey => "invalid clipboard group key",
            Self::InvalidCaPem => "invalid private CA PEM",
            Self::TlsConfig => "failed to initialize TLS configuration",
            Self::NoTokioRuntime => "active Tokio runtime context is required",
        };
        f.write_str(message)
    }
}

impl std::error::Error for LinkStartError {}

/// Handle to a running native clipboard sync relay connection.
///
/// Dropping `Link` cancels the background task and discards any queued outbound text.
/// Deliberately does not implement `Debug`.
pub struct Link {
    shared: Arc<LinkShared>,
    task: JoinHandle<()>,
}

impl Link {
    /// Returns the current connection status and active session generation.
    pub fn snapshot(&self) -> LinkSnapshot {
        self.shared.snapshot()
    }

    /// Non-blocking capacity-one publish for the active online generation.
    ///
    /// Replaces the previous pending copy. Returns `false` only if the link is no
    /// longer online for this generation or the text is ineligible.
    pub fn publish(&self, generation: u64, text: &str) -> bool {
        self.shared.publish(generation, text)
    }

    /// Closes this link and discards pending copies, even when another caller holds the handle.
    pub fn stop(&self) {
        self.shared.cancel();
        self.task.abort();
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Starts a background native clipboard sync relay link on the active Tokio runtime.
///
/// Native `on_clip` callbacks must post only bounded work and recheck generation
/// before performing any deferred OS clipboard write.
pub fn start(
    config: LinkConfig,
    key: GroupKey,
    on_clip: impl Fn(IncomingClip) + Send + Sync + 'static,
) -> Result<Link, LinkStartError> {
    let handle = Handle::try_current().map_err(|_| LinkStartError::NoTokioRuntime)?;

    let endpoint = parse_center_origin(&config.origin)?;
    if !validate_device_id(&config.device_id) {
        return Err(LinkStartError::InvalidDeviceId);
    }
    if !validate_device_token(&config.device_token) {
        return Err(LinkStartError::InvalidDeviceToken);
    }
    if !validate_routing_id(key.routing_id()) {
        return Err(LinkStartError::InvalidGroupKey);
    }

    let tls_config = if endpoint.use_tls {
        Some(build_tls_config(config.ca_pem.as_deref())?)
    } else {
        if config.ca_pem.is_some() {
            let _ = build_tls_config(config.ca_pem.as_deref())?;
        }
        None
    };

    let (shared, cancel_rx) = LinkShared::new();
    let shared_worker = Arc::clone(&shared);
    let device_id = config.device_id;
    let device_token = config.device_token;

    let task = handle.spawn(async move {
        run_link(
            endpoint,
            tls_config,
            device_id,
            device_token,
            key,
            shared_worker,
            cancel_rx,
            on_clip,
        )
        .await;
    });

    Ok(Link { shared, task })
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::Message;

    fn assert_send_sync<T: Send + Sync>() {}

    fn test_token() -> String {
        "T".repeat(40)
    }

    fn key_pair() -> (GroupKey, GroupKey) {
        let client = GroupKey::generate().ok().expect("generate group key");
        let server = GroupKey::from_code(&client.to_code())
            .ok()
            .expect("reconstruct group key");
        (client, server)
    }

    fn now_unix() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("unix time")
            .as_secs()
    }

    async fn wait_for_snapshot(
        link: &Link,
        predicate: impl Fn(LinkSnapshot) -> bool,
    ) -> LinkSnapshot {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let snap = link.snapshot();
            if predicate(snap) {
                return snap;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for expected snapshot; last={snap:?}"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    #[test]
    fn link_is_send_and_sync_and_status_strings_match() {
        assert_send_sync::<Link>();
        assert_eq!(LinkStatus::Connecting.as_str(), "connecting");
        assert_eq!(LinkStatus::Online.as_str(), "online");
        assert_eq!(LinkStatus::Offline.as_str(), "offline");
        assert_eq!(LinkStatus::Unauthorized.as_str(), "unauthorized");
        assert_eq!(LinkStatus::Unsupported.as_str(), "unsupported");
        assert_eq!(LinkStatus::CertificateError.as_str(), "certificateError");
    }

    #[test]
    fn start_requires_active_tokio_runtime() {
        let (key, _) = key_pair();
        let cfg = LinkConfig {
            origin: "https://center.example".to_owned(),
            device_id: "dev-1".to_owned(),
            device_token: test_token(),
            ca_pem: None,
        };
        assert_eq!(
            start(cfg, key, |_| {}).err(),
            Some(LinkStartError::NoTokioRuntime)
        );
    }

    #[tokio::test]
    async fn synthetic_ws_happy_path_generation_and_replay_across_reconnect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let (client_key, server_key) = key_pair();
        let expected_group = server_key.routing_id().to_owned();
        let token = test_token();
        let expected_token = token.clone();

        let (put_tx, mut put_rx) = tokio::sync::mpsc::channel::<Value>(4);

        let server_task = tokio::spawn(async move {
            let now = now_unix();
            let clip_one = server_key
                .encrypt("peer-b", "first-clip", now)
                .ok()
                .expect("encrypt first");
            let event_one = json!({
                "type": "clipboard-event",
                "fromDeviceId": "peer-b",
                "nonce": clip_one.nonce,
                "sealed": clip_one.sealed,
                "sentAt": clip_one.sent_at,
            })
            .to_string();

            // Session 1: verify upgrade headers, hello, receive clipboard-put, send event_one, then close.
            let (tcp1, _) = listener.accept().await.expect("accept 1");
            let mut ws1 = accept_hdr_async(
                tcp1,
                |req: &Request, response: Response| -> Result<Response, ErrorResponse> {
                    assert_eq!(
                        req.uri().path_and_query().map(|pq| pq.as_str()),
                        Some("/v1/link")
                    );
                    assert!(req.headers().get(http::header::ORIGIN).is_none());
                    assert_eq!(
                        req.headers()
                            .get("x-pibot-clipboard-v1")
                            .and_then(|v| v.to_str().ok()),
                        Some("1")
                    );
                    Ok(response)
                },
            )
            .await
            .expect("upgrade 1");

            let hello_msg = ws1.next().await.expect("hello frame").expect("ws ok");
            let Message::Text(hello_text) = hello_msg else {
                panic!("expected text hello");
            };
            let hello_val: Value = serde_json::from_str(hello_text.as_ref()).expect("hello json");
            assert_eq!(
                hello_val,
                json!({
                    "type": "hello",
                    "protocolVersion": 1,
                    "role": "clipboard",
                    "deviceId": "dev-a",
                    "token": expected_token,
                    "clipboardGroup": expected_group,
                })
            );

            ws1.send(Message::text(
                json!({
                    "type": "ready",
                    "protocolVersion": 1,
                    "role": "clipboard",
                    "deviceId": "dev-a",
                })
                .to_string(),
            ))
            .await
            .expect("send ready 1");

            // Receive outbound clipboard-put from client.
            let put_msg = ws1.next().await.expect("put frame").expect("ws ok");
            let Message::Text(put_text) = put_msg else {
                panic!("expected text put");
            };
            let put_val: Value = serde_json::from_str(put_text.as_ref()).expect("put json");
            let _ = put_tx.send(put_val).await;

            // Send stale clip (>30s old) first — must be rejected, followed by valid event_one.
            let stale_clip = server_key
                .encrypt("peer-b", "stale-clip", now.saturating_sub(45))
                .ok()
                .expect("encrypt stale");
            ws1.send(Message::text(
                json!({
                    "type": "clipboard-event",
                    "fromDeviceId": "peer-b",
                    "nonce": stale_clip.nonce,
                    "sealed": stale_clip.sealed,
                    "sentAt": stale_clip.sent_at,
                })
                .to_string(),
            ))
            .await
            .expect("send stale");

            ws1.send(Message::text(event_one.clone()))
                .await
                .expect("send event 1");

            // Give client a moment to process event_one, then close cleanly to trigger reconnect.
            tokio::time::sleep(Duration::from_millis(80)).await;
            let _ = ws1.close(None).await;
            drop(ws1);

            // Session 2: accept reconnect, send ready, replay event_one (must be suppressed!),
            // then send fresh event_two (must be delivered with generation 2).
            let (tcp2, _) = listener.accept().await.expect("accept 2");
            let mut ws2 = accept_hdr_async(
                tcp2,
                |_req: &Request, response: Response| -> Result<Response, ErrorResponse> {
                    Ok(response)
                },
            )
            .await
            .expect("upgrade 2");
            let _ = ws2.next().await;
            ws2.send(Message::text(
                json!({
                    "type": "ready",
                    "protocolVersion": 1,
                    "role": "clipboard",
                    "deviceId": "dev-a",
                })
                .to_string(),
            ))
            .await
            .expect("send ready 2");

            ws2.send(Message::text(event_one)).await.expect("replay 1");

            let clip_two = server_key
                .encrypt("peer-b", "second-clip", now_unix())
                .ok()
                .expect("encrypt second");
            ws2.send(Message::text(
                json!({
                    "type": "clipboard-event",
                    "fromDeviceId": "peer-b",
                    "nonce": clip_two.nonce,
                    "sealed": clip_two.sealed,
                    "sentAt": clip_two.sent_at,
                })
                .to_string(),
            ))
            .await
            .expect("send event 2");

            tokio::time::sleep(Duration::from_millis(150)).await;
        });

        let received = Arc::new(Mutex::new(Vec::<(u64, String)>::new()));
        let received_cb = Arc::clone(&received);

        let link = start(
            LinkConfig {
                origin: format!("http://127.0.0.1:{}", addr.port()),
                device_id: "dev-a".to_owned(),
                device_token: token,
                ca_pem: None,
            },
            client_key,
            move |clip| {
                received_cb
                    .lock()
                    .unwrap()
                    .push((clip.generation, clip.text));
            },
        )
        .expect("start link");

        let snap1 = wait_for_snapshot(&link, |s| {
            s.status == LinkStatus::Online && s.generation == 1
        })
        .await;
        assert_eq!(snap1.generation, 1);

        // Wrong generation and ineligible empty text must return false.
        assert!(!link.publish(0, "wrong-gen"));
        assert!(!link.publish(1, ""));
        assert!(link.publish(1, "outbound-hello"));

        let put_val = tokio::time::timeout(Duration::from_secs(3), put_rx.recv())
            .await
            .expect("put timeout")
            .expect("put value");
        assert_eq!(
            put_val.get("type").and_then(Value::as_str),
            Some("clipboard-put")
        );

        // Wait for reconnect to generation 2.
        let snap2 = wait_for_snapshot(&link, |s| {
            s.status == LinkStatus::Online && s.generation == 2
        })
        .await;
        assert_eq!(snap2.generation, 2);
        // Superseded generation 1 publish must be rejected.
        assert!(!link.publish(1, "stale-gen-publish"));

        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            if received.lock().unwrap().len() >= 2 {
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "expected 2 clips");
            tokio::time::sleep(Duration::from_millis(15)).await;
        }

        let clips = received.lock().unwrap().clone();
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0], (1, "first-clip".to_owned()));
        assert_eq!(clips[1], (2, "second-clip".to_owned()));

        drop(link);
        let _ = server_task.await;
    }

    #[tokio::test]
    async fn paced_burst_sends_the_newest_pending_copy() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (client_key, server_key) = key_pair();
        let (first_put_tx, first_put_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            assert!(ws.next().await.unwrap().unwrap().is_text());
            ws.send(Message::text(json!({
                "type": "ready",
                "protocolVersion": 1,
                "role": "clipboard",
                "deviceId": "dev-a",
            }).to_string())).await.unwrap();

            let mut first_put_tx = Some(first_put_tx);
            for expected in ["first copy", "copy 31"] {
                let frame = ws.next().await.unwrap().unwrap().into_text().unwrap();
                let val: Value = serde_json::from_str(&frame).unwrap();
                assert_eq!(val["type"], "clipboard-put");
                let clip = clipboard_sync::SealedClip {
                    nonce: val["nonce"].as_str().unwrap().to_owned(),
                    sealed: val["sealed"].as_str().unwrap().to_owned(),
                    sent_at: val["sentAt"].as_u64().unwrap(),
                };
                assert_eq!(server_key.decrypt("dev-a", &clip, now_unix()).unwrap(), expected);
                if let Some(first_put_tx) = first_put_tx.take() {
                    first_put_tx.send(()).unwrap();
                }
            }
            tokio::time::Instant::now()
        });

        let link = start(
            LinkConfig {
                origin: format!("http://127.0.0.1:{}", addr.port()),
                device_id: "dev-a".to_owned(),
                device_token: test_token(),
                ca_pem: None,
            },
            client_key,
            |_| {},
        ).unwrap();
        let snap = wait_for_snapshot(&link, |s| s.status == LinkStatus::Online).await;
        let first_at = tokio::time::Instant::now();
        assert!(link.publish(snap.generation, "first copy"));
        tokio::time::timeout(Duration::from_secs(3), first_put_rx).await.unwrap().unwrap();
        for i in 0..32 {
            assert!(link.publish(snap.generation, &format!("copy {i}")));
        }
        let second_at = tokio::time::timeout(Duration::from_secs(3), server).await.unwrap().unwrap();
        assert!(second_at - first_at >= Duration::from_millis(600));
    }

    #[tokio::test]
    async fn legacy_center_close_4400_is_terminal_unsupported_without_retry_spam() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let accepts = Arc::new(AtomicUsize::new(0));
        let accepts_srv = Arc::clone(&accepts);

        let server_task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    break;
                };
                accepts_srv.fetch_add(1, Ordering::SeqCst);
                if let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await {
                    let _ = ws.next().await;
                    let _ = ws
                        .close(Some(CloseFrame {
                            code: CloseCode::from(4400u16),
                            reason: "".into(),
                        }))
                        .await;
                }
            }
        });

        let (key, _) = key_pair();
        let link = start(
            LinkConfig {
                origin: format!("http://127.0.0.1:{}", addr.port()),
                device_id: "dev-legacy".to_owned(),
                device_token: test_token(),
                ca_pem: None,
            },
            key,
            |_| {},
        )
        .expect("start");

        let snap = wait_for_snapshot(&link, |s| s.status == LinkStatus::Unsupported).await;
        assert_eq!(snap.generation, 0);

        tokio::time::sleep(Duration::from_millis(450)).await;
        assert_eq!(accepts.load(Ordering::SeqCst), 1);

        drop(link);
        server_task.abort();
    }

    #[tokio::test]
    async fn unauthorized_close_4401_is_terminal() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let accepts = Arc::new(AtomicUsize::new(0));
        let accepts_srv = Arc::clone(&accepts);

        let server_task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    break;
                };
                accepts_srv.fetch_add(1, Ordering::SeqCst);
                if let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await {
                    let _ = ws.next().await;
                    let _ = ws
                        .close(Some(CloseFrame {
                            code: CloseCode::from(4401u16),
                            reason: "".into(),
                        }))
                        .await;
                }
            }
        });

        let (key, _) = key_pair();
        let link = start(
            LinkConfig {
                origin: format!("http://127.0.0.1:{}", addr.port()),
                device_id: "dev-unauth".to_owned(),
                device_token: test_token(),
                ca_pem: None,
            },
            key,
            |_| {},
        )
        .expect("start");

        let snap = wait_for_snapshot(&link, |s| s.status == LinkStatus::Unauthorized).await;
        assert_eq!(snap.generation, 0);

        tokio::time::sleep(Duration::from_millis(450)).await;
        assert_eq!(accepts.load(Ordering::SeqCst), 1);

        drop(link);
        server_task.abort();
    }

    #[tokio::test]
    async fn http_404_is_terminal_unsupported_and_redirects_are_not_followed() {
        // Test 1: HTTP 404 -> terminal Unsupported
        let listener_404 = TcpListener::bind("127.0.0.1:0").await.expect("bind 404");
        let addr_404 = listener_404.local_addr().expect("addr 404");
        let srv_404 = tokio::spawn(async move {
            if let Ok((mut tcp, _)) = listener_404.accept().await {
                let mut buf = [0u8; 1024];
                let _ = tcp.read(&mut buf).await;
                let _ = tcp
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        });

        let (key_404, _) = key_pair();
        let link_404 = start(
            LinkConfig {
                origin: format!("http://127.0.0.1:{}", addr_404.port()),
                device_id: "dev-404".to_owned(),
                device_token: test_token(),
                ca_pem: None,
            },
            key_404,
            |_| {},
        )
        .expect("start 404");
        let snap = wait_for_snapshot(&link_404, |s| s.status == LinkStatus::Unsupported).await;
        assert_eq!(snap.generation, 0);
        drop(link_404);
        let _ = srv_404.await;

        // Test 2: HTTP 302 -> never contacts redirect target and never becomes Online
        let target_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind target");
        let target_addr = target_listener.local_addr().expect("addr target");
        let target_hits = Arc::new(AtomicUsize::new(0));
        let target_hits_srv = Arc::clone(&target_hits);
        let target_srv = tokio::spawn(async move {
            if target_listener.accept().await.is_ok() {
                target_hits_srv.fetch_add(1, Ordering::SeqCst);
            }
        });

        let redir_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind redir");
        let redir_addr = redir_listener.local_addr().expect("addr redir");
        let redir_srv = tokio::spawn(async move {
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/v1/link\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                target_addr.port()
            );
            while let Ok((mut tcp, _)) = redir_listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = tcp.read(&mut buf).await;
                let _ = tcp.write_all(response.as_bytes()).await;
            }
        });

        let (key_redir, _) = key_pair();
        let link_redir = start(
            LinkConfig {
                origin: format!("http://127.0.0.1:{}", redir_addr.port()),
                device_id: "dev-redir".to_owned(),
                device_token: test_token(),
                ca_pem: None,
            },
            key_redir,
            |_| {},
        )
        .expect("start redir");

        let snap = wait_for_snapshot(&link_redir, |s| s.status == LinkStatus::Offline).await;
        assert_eq!(snap.generation, 0);
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(target_hits.load(Ordering::SeqCst), 0);

        drop(link_redir);
        redir_srv.abort();
        target_srv.abort();
    }
}
