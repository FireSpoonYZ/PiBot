use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clipboard_sync::GroupKey;
use futures_util::{SinkExt, StreamExt};
use http::StatusCode;
use rustls::ClientConfig;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::{watch, Notify};
use tokio::time::{sleep, timeout};
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{client_async_with_config, WebSocketStream};

use crate::config::{ConnectTarget, ValidatedEndpoint};
use crate::protocol::{
    encode_clipboard_put, encode_hello, is_fresh_sent_at, is_valid_sent_at, parse_clipboard_event,
    parse_ready, CLOSE_BAD_FRAME, CLOSE_POLICY_VIOLATION, CLOSE_PROTOCOL_ERROR, CLOSE_REVOKED,
    CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_DATA, MAX_WS_FRAME_BYTES, MAX_WS_WRITE_BUFFER_BYTES,
};
use crate::replay::{ReplayCache, DEFAULT_REPLAY_CAPACITY};
use crate::{IncomingClip, LinkSnapshot, LinkStatus};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const READ_WATCHDOG_TIMEOUT: Duration = Duration::from_secs(45);
const BACKOFF_MIN_MS: u64 = 250;
const BACKOFF_MAX_MS: u64 = 30_000;

pub(crate) struct PendingOutbound {
    pub(crate) generation: u64,
    pub(crate) text: String,
}

struct SharedState {
    status: LinkStatus,
    generation: u64,
    cancelled: bool,
    pending_outbound: Option<PendingOutbound>,
}

pub(crate) struct LinkShared {
    state: Mutex<SharedState>,
    outbound_notify: Notify,
    cancel_tx: watch::Sender<bool>,
}

impl LinkShared {
    pub(crate) fn new() -> (Arc<Self>, watch::Receiver<bool>) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let shared = Arc::new(Self {
            state: Mutex::new(SharedState {
                status: LinkStatus::Connecting,
                generation: 0,
                cancelled: false,
                pending_outbound: None,
            }),
            outbound_notify: Notify::new(),
            cancel_tx,
        });
        (shared, cancel_rx)
    }

    pub(crate) fn snapshot(&self) -> LinkSnapshot {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        LinkSnapshot {
            status: guard.status,
            generation: guard.generation,
        }
    }

    pub(crate) fn publish(&self, generation: u64, text: &str) -> bool {
        if !clipboard_sync::eligible_text(text, false) {
            return false;
        }
        {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if guard.cancelled
                || guard.status != LinkStatus::Online
                || guard.generation != generation
                || guard.pending_outbound.is_some()
            {
                return false;
            }
            guard.pending_outbound = Some(PendingOutbound {
                generation,
                text: text.to_owned(),
            });
        }
        self.outbound_notify.notify_one();
        true
    }

    pub(crate) fn cancel(&self) {
        {
            let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard.cancelled = true;
            guard.pending_outbound = None;
        }
        let _ = self.cancel_tx.send(true);
        self.outbound_notify.notify_waiters();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).cancelled
    }

    fn enter_online(&self) -> Option<u64> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if guard.cancelled {
            return None;
        }
        guard.generation = guard.generation.saturating_add(1);
        guard.status = LinkStatus::Online;
        guard.pending_outbound = None;
        Some(guard.generation)
    }

    fn set_status_and_drain(&self, status: LinkStatus) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.pending_outbound = None;
        if !guard.cancelled {
            guard.status = status;
        }
    }

    fn drain_outbound(&self) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.pending_outbound = None;
    }

    fn take_outbound(&self, expected_generation: u64) -> Option<PendingOutbound> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if guard.cancelled
            || guard.status != LinkStatus::Online
            || guard.generation != expected_generation
        {
            guard.pending_outbound = None;
            return None;
        }
        let cmd = guard.pending_outbound.take()?;
        if cmd.generation != expected_generation {
            return None;
        }
        Some(cmd)
    }
}

enum TransportStream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for TransportStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for TransportStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

enum SessionOutcome {
    Retryable,
    Terminal(LinkStatus),
    Cancelled,
}

enum ConnectError {
    Retryable,
    Terminal(LinkStatus),
}

enum SendResult {
    Continue,
    Reconnect,
    Cancelled,
}

async fn wait_cancelled(cancel_rx: &mut watch::Receiver<bool>) {
    if *cancel_rx.borrow() {
        return;
    }
    loop {
        if cancel_rx.changed().await.is_err() {
            return;
        }
        if *cancel_rx.borrow() {
            return;
        }
    }
}

fn unix_now_seconds() -> Option<u64> {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    if is_valid_sent_at(secs) {
        Some(secs)
    } else {
        None
    }
}

fn next_backoff_delay(base_ms: u64, attempt: u64) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let max_jitter = (base_ms / 5).max(1);
    let jitter = nanos.wrapping_add(attempt.wrapping_mul(37)) % max_jitter;
    Duration::from_millis(base_ms.saturating_add(jitter).min(BACKOFF_MAX_MS))
}

fn is_certificate_error(err: &io::Error) -> bool {
    let Some(inner) = err.get_ref() else {
        return false;
    };
    let Some(tls_err) = inner.downcast_ref::<rustls::Error>() else {
        return false;
    };
    matches!(
        tls_err,
        rustls::Error::InvalidCertificate(_)
            | rustls::Error::NoCertificatesPresented
            | rustls::Error::InvalidCertRevocationList(_)
            | rustls::Error::UnsupportedNameType
            | rustls::Error::AlertReceived(
                rustls::AlertDescription::BadCertificate
                    | rustls::AlertDescription::UnsupportedCertificate
                    | rustls::AlertDescription::CertificateRevoked
                    | rustls::AlertDescription::CertificateExpired
                    | rustls::AlertDescription::CertificateUnknown
                    | rustls::AlertDescription::UnknownCA
                    | rustls::AlertDescription::BadCertificateStatusResponse
                    | rustls::AlertDescription::BadCertificateHashValue
                    | rustls::AlertDescription::CertificateRequired
            )
    )
}

fn classify_http_status(status: StatusCode) -> ConnectError {
    match status.as_u16() {
        401 | 403 => ConnectError::Terminal(LinkStatus::Unauthorized),
        400 | 404 | 405 | 426 | 501 => ConnectError::Terminal(LinkStatus::Unsupported),
        // Redirects (3xx) are never followed; treat as rejected/retryable.
        _ => ConnectError::Retryable,
    }
}

fn classify_handshake_error(err: WsError) -> ConnectError {
    match err {
        WsError::Http(response) => classify_http_status(response.status()),
        _ => ConnectError::Retryable,
    }
}

fn classify_pre_ready_close(code: Option<u16>) -> SessionOutcome {
    match code {
        Some(CLOSE_UNAUTHORIZED | CLOSE_REVOKED) => {
            SessionOutcome::Terminal(LinkStatus::Unauthorized)
        }
        Some(
            CLOSE_BAD_FRAME
            | CLOSE_PROTOCOL_ERROR
            | CLOSE_UNSUPPORTED_DATA
            | CLOSE_POLICY_VIOLATION,
        ) => SessionOutcome::Terminal(LinkStatus::Unsupported),
        _ => SessionOutcome::Retryable,
    }
}

fn classify_online_close(code: Option<u16>) -> SessionOutcome {
    match code {
        Some(CLOSE_UNAUTHORIZED | CLOSE_REVOKED) => {
            SessionOutcome::Terminal(LinkStatus::Unauthorized)
        }
        _ => SessionOutcome::Retryable,
    }
}

async fn connect_websocket(
    endpoint: &ValidatedEndpoint,
    tls_config: Option<&Arc<ClientConfig>>,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<WebSocketStream<TransportStream>, SessionOutcome> {
    let request = endpoint
        .build_upgrade_request()
        .map_err(|()| SessionOutcome::Terminal(LinkStatus::Unsupported))?;
    let ws_config = WebSocketConfig::default()
        .write_buffer_size(64 * 1024)
        .max_write_buffer_size(MAX_WS_WRITE_BUFFER_BYTES)
        .max_message_size(Some(MAX_WS_FRAME_BYTES))
        .max_frame_size(Some(MAX_WS_FRAME_BYTES));

    let connect_fut = async move {
        let tcp = match &endpoint.connect_target {
            ConnectTarget::Domain(host, port) => TcpStream::connect((host.as_str(), *port)).await,
            ConnectTarget::SocketAddr(addr) => TcpStream::connect(*addr).await,
        }
        .map_err(|_| ConnectError::Retryable)?;
        let _ = tcp.set_nodelay(true);

        let transport = if endpoint.use_tls {
            let tls_cfg = tls_config
                .ok_or(ConnectError::Terminal(LinkStatus::CertificateError))?;
            let server_name = endpoint
                .server_name
                .clone()
                .ok_or(ConnectError::Terminal(LinkStatus::CertificateError))?;
            let connector = TlsConnector::from(Arc::clone(tls_cfg));
            let tls_stream = connector.connect(server_name, tcp).await.map_err(|err| {
                if is_certificate_error(&err) {
                    ConnectError::Terminal(LinkStatus::CertificateError)
                } else {
                    ConnectError::Retryable
                }
            })?;
            TransportStream::Tls(Box::new(tls_stream))
        } else {
            TransportStream::Plain(tcp)
        };

        let (ws, _response) = client_async_with_config(request, transport, Some(ws_config))
            .await
            .map_err(classify_handshake_error)?;
        Ok(ws)
    };

    tokio::select! {
        biased;
        _ = wait_cancelled(cancel_rx) => Err(SessionOutcome::Cancelled),
        res = timeout(CONNECT_TIMEOUT, connect_fut) => match res {
            Ok(Ok(ws)) => Ok(ws),
            Ok(Err(ConnectError::Terminal(status))) => Err(SessionOutcome::Terminal(status)),
            Ok(Err(ConnectError::Retryable)) | Err(_) => Err(SessionOutcome::Retryable),
        }
    }
}

async fn send_hello_and_wait_ready(
    ws: &mut WebSocketStream<TransportStream>,
    hello_json: String,
    device_id: &str,
) -> Result<(), SessionOutcome> {
    ws.send(Message::text(hello_json))
        .await
        .map_err(|_| SessionOutcome::Retryable)?;

    loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) => {
                if parse_ready(text.as_ref(), device_id).is_ok() {
                    return Ok(());
                }
                let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                return Err(SessionOutcome::Terminal(LinkStatus::Unsupported));
            }
            Some(Ok(Message::Ping(_))) => {
                if ws.flush().await.is_err() {
                    return Err(SessionOutcome::Retryable);
                }
            }
            Some(Ok(Message::Pong(_))) => {}
            Some(Ok(Message::Close(frame))) => {
                let code = frame.map(|f| u16::from(f.code));
                return Err(classify_pre_ready_close(code));
            }
            Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {
                let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                return Err(SessionOutcome::Terminal(LinkStatus::Unsupported));
            }
            Some(Err(_)) | None => return Err(SessionOutcome::Retryable),
        }
    }
}

async fn perform_hello_handshake(
    ws: &mut WebSocketStream<TransportStream>,
    device_id: &str,
    device_token: &str,
    routing_id: &str,
    cancel_rx: &mut watch::Receiver<bool>,
) -> Result<(), SessionOutcome> {
    let hello_json = encode_hello(device_id, device_token, routing_id)
        .map_err(|()| SessionOutcome::Terminal(LinkStatus::Unsupported))?;

    tokio::select! {
        biased;
        _ = wait_cancelled(cancel_rx) => {
            let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
            Err(SessionOutcome::Cancelled)
        }
        res = timeout(HELLO_TIMEOUT, send_hello_and_wait_ready(ws, hello_json, device_id)) => {
            match res {
                Ok(Ok(())) => Ok(()),
                Ok(Err(outcome)) => Err(outcome),
                Err(_) => {
                    let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                    Err(SessionOutcome::Retryable)
                }
            }
        }
    }
}

async fn send_outbound_clip(
    ws: &mut WebSocketStream<TransportStream>,
    key: &GroupKey,
    device_id: &str,
    cmd: PendingOutbound,
    cancel_rx: &mut watch::Receiver<bool>,
) -> SendResult {
    let Some(now_unix) = unix_now_seconds() else {
        drop(cmd);
        return SendResult::Continue;
    };
    let sealed_res = key.encrypt(device_id, &cmd.text, now_unix);
    drop(cmd);
    let Ok(sealed) = sealed_res else {
        return SendResult::Continue;
    };
    let Ok(put_json) = encode_clipboard_put(&sealed) else {
        return SendResult::Continue;
    };

    tokio::select! {
        biased;
        _ = wait_cancelled(cancel_rx) => {
            let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
            SendResult::Cancelled
        }
        res = timeout(WRITE_TIMEOUT, ws.send(Message::text(put_json))) => match res {
            Ok(Ok(())) => SendResult::Continue,
            Ok(Err(_)) | Err(_) => SendResult::Reconnect,
        }
    }
}

fn handle_incoming_text<F>(
    raw: &str,
    device_id: &str,
    generation: u64,
    key: &GroupKey,
    replay_cache: &mut ReplayCache,
    shared: &LinkShared,
    on_clip: &F,
) where
    F: Fn(IncomingClip) + Send + Sync + 'static,
{
    let Ok(event) = parse_clipboard_event(raw) else {
        return;
    };
    if event.from_device_id == device_id {
        return;
    }
    let Some(now_unix) = unix_now_seconds() else {
        return;
    };
    if !is_fresh_sent_at(event.clip.sent_at, now_unix) {
        return;
    }

    let now_mono = Instant::now();
    if replay_cache.contains(&event.from_device_id, &event.clip.nonce, now_unix, now_mono) {
        return;
    }

    let Ok(plaintext) = key.decrypt(&event.from_device_id, &event.clip, now_unix) else {
        return;
    };
    if !clipboard_sync::eligible_text(&plaintext, false) {
        return;
    }
    if !replay_cache.insert_verified(
        &event.from_device_id,
        &event.clip.nonce,
        event.clip.sent_at,
        now_unix,
        now_mono,
    ) {
        return;
    }
    if shared.is_cancelled() {
        return;
    }
    on_clip(IncomingClip {
        generation,
        text: plaintext,
    });
}

#[allow(clippy::too_many_arguments)]
async fn run_single_attempt<F>(
    endpoint: &ValidatedEndpoint,
    tls_config: Option<&Arc<ClientConfig>>,
    device_id: &str,
    device_token: &str,
    key: &GroupKey,
    replay_cache: &mut ReplayCache,
    shared: &LinkShared,
    cancel_rx: &mut watch::Receiver<bool>,
    on_clip: &F,
    backoff_ms: &mut u64,
) -> SessionOutcome
where
    F: Fn(IncomingClip) + Send + Sync + 'static,
{
    let mut ws = match connect_websocket(endpoint, tls_config, cancel_rx).await {
        Ok(ws) => ws,
        Err(outcome) => return outcome,
    };

    if let Err(outcome) =
        perform_hello_handshake(&mut ws, device_id, device_token, key.routing_id(), cancel_rx)
            .await
    {
        return outcome;
    }

    let Some(generation) = shared.enter_online() else {
        let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
        return SessionOutcome::Cancelled;
    };
    *backoff_ms = BACKOFF_MIN_MS;

    let watchdog = sleep(READ_WATCHDOG_TIMEOUT);
    tokio::pin!(watchdog);

    loop {
        if *cancel_rx.borrow() || shared.is_cancelled() {
            let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
            return SessionOutcome::Cancelled;
        }

        if let Some(cmd) = shared.take_outbound(generation) {
            match send_outbound_clip(&mut ws, key, device_id, cmd, cancel_rx).await {
                SendResult::Continue => continue,
                SendResult::Reconnect => return SessionOutcome::Retryable,
                SendResult::Cancelled => return SessionOutcome::Cancelled,
            }
        }

        tokio::select! {
            _ = wait_cancelled(cancel_rx) => {
                let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                return SessionOutcome::Cancelled;
            }
            _ = shared.outbound_notify.notified() => {}
            _ = &mut watchdog => {
                return SessionOutcome::Retryable;
            }
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        watchdog.as_mut().reset(tokio::time::Instant::now() + READ_WATCHDOG_TIMEOUT);
                        handle_incoming_text(
                            text.as_ref(),
                            device_id,
                            generation,
                            key,
                            replay_cache,
                            shared,
                            on_clip,
                        );
                    }
                    Some(Ok(Message::Ping(_))) => {
                        watchdog.as_mut().reset(tokio::time::Instant::now() + READ_WATCHDOG_TIMEOUT);
                        tokio::select! {
                            biased;
                            _ = wait_cancelled(cancel_rx) => {
                                let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                                return SessionOutcome::Cancelled;
                            }
                            res = timeout(WRITE_TIMEOUT, ws.flush()) => {
                                if !matches!(res, Ok(Ok(()))) {
                                    return SessionOutcome::Retryable;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {
                        watchdog.as_mut().reset(tokio::time::Instant::now() + READ_WATCHDOG_TIMEOUT);
                    }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.map(|f| u16::from(f.code));
                        return classify_online_close(code);
                    }
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {
                        let _ = timeout(CLOSE_TIMEOUT, ws.close(None)).await;
                        return SessionOutcome::Retryable;
                    }
                    Some(Err(_)) | None => {
                        return SessionOutcome::Retryable;
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_link<F>(
    endpoint: ValidatedEndpoint,
    tls_config: Option<Arc<ClientConfig>>,
    device_id: String,
    device_token: String,
    key: GroupKey,
    shared: Arc<LinkShared>,
    mut cancel_rx: watch::Receiver<bool>,
    on_clip: F,
) where
    F: Fn(IncomingClip) + Send + Sync + 'static,
{
    let mut replay_cache =
        ReplayCache::new(DEFAULT_REPLAY_CAPACITY, clipboard_sync::MAX_AGE_SECONDS);
    let mut backoff_ms = BACKOFF_MIN_MS;
    let mut attempt: u64 = 0;

    loop {
        if *cancel_rx.borrow() || shared.is_cancelled() {
            shared.drain_outbound();
            break;
        }

        shared.set_status_and_drain(LinkStatus::Connecting);
        attempt = attempt.wrapping_add(1);

        let outcome = run_single_attempt(
            &endpoint,
            tls_config.as_ref(),
            &device_id,
            &device_token,
            &key,
            &mut replay_cache,
            &shared,
            &mut cancel_rx,
            &on_clip,
            &mut backoff_ms,
        )
        .await;

        match outcome {
            SessionOutcome::Cancelled => {
                shared.drain_outbound();
                break;
            }
            SessionOutcome::Terminal(status) => {
                shared.set_status_and_drain(status);
                break;
            }
            SessionOutcome::Retryable => {
                shared.set_status_and_drain(LinkStatus::Offline);
                let delay = next_backoff_delay(backoff_ms, attempt);
                backoff_ms = backoff_ms.saturating_mul(2).min(BACKOFF_MAX_MS);
                tokio::select! {
                    biased;
                    _ = wait_cancelled(&mut cancel_rx) => {
                        shared.drain_outbound();
                        break;
                    }
                    _ = sleep(delay) => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_state_enforces_generation_capacity_one_and_disconnect_drain() {
        let (shared, _cancel_rx) = LinkShared::new();
        assert_eq!(
            shared.snapshot(),
            LinkSnapshot {
                status: LinkStatus::Connecting,
                generation: 0,
            }
        );

        // Offline / Connecting cannot publish.
        assert!(!shared.publish(0, "hello"));

        let gen1 = shared.enter_online().expect("gen 1");
        assert_eq!(gen1, 1);
        assert_eq!(
            shared.snapshot(),
            LinkSnapshot {
                status: LinkStatus::Online,
                generation: 1,
            }
        );

        // Wrong generation and ineligible text are rejected.
        assert!(!shared.publish(0, "hello"));
        assert!(!shared.publish(2, "hello"));
        assert!(!shared.publish(1, ""));
        assert!(!shared.publish(1, &"x".repeat(clipboard_sync::MAX_TEXT_BYTES + 1)));

        // Capacity-one nonblocking slot: first succeeds, second fails while full.
        assert!(shared.publish(1, "clip-1"));
        assert!(!shared.publish(1, "clip-2"));

        // Disconnect drains queued command and rejects further publishes.
        shared.set_status_and_drain(LinkStatus::Offline);
        assert_eq!(
            shared.snapshot(),
            LinkSnapshot {
                status: LinkStatus::Offline,
                generation: 1,
            }
        );
        assert!(shared.take_outbound(1).is_none());
        assert!(!shared.publish(1, "clip-3"));

        // Reconnect increments generation; old generation remains rejected.
        let gen2 = shared.enter_online().expect("gen 2");
        assert_eq!(gen2, 2);
        assert!(!shared.publish(1, "stale-gen"));
        assert!(shared.publish(2, "fresh-gen"));
        let taken = shared.take_outbound(2).expect("outbound");
        assert_eq!(taken.generation, 2);
        assert_eq!(taken.text, "fresh-gen");

        // Cancel drains pending slot and prevents subsequent online entry or publish.
        assert!(shared.publish(2, "to-be-drained"));
        shared.cancel();
        assert!(shared.take_outbound(2).is_none());
        assert!(!shared.publish(2, "after-cancel"));
        assert!(shared.enter_online().is_none());
    }

    #[test]
    fn close_and_http_classifications_match_terminal_policy() {
        assert!(matches!(
            classify_http_status(StatusCode::UNAUTHORIZED),
            ConnectError::Terminal(LinkStatus::Unauthorized)
        ));
        assert!(matches!(
            classify_http_status(StatusCode::FORBIDDEN),
            ConnectError::Terminal(LinkStatus::Unauthorized)
        ));
        assert!(matches!(
            classify_http_status(StatusCode::NOT_FOUND),
            ConnectError::Terminal(LinkStatus::Unsupported)
        ));
        assert!(matches!(
            classify_http_status(StatusCode::NOT_IMPLEMENTED),
            ConnectError::Terminal(LinkStatus::Unsupported)
        ));
        assert!(matches!(
            classify_http_status(StatusCode::FOUND),
            ConnectError::Retryable
        ));
        assert!(matches!(
            classify_http_status(StatusCode::SERVICE_UNAVAILABLE),
            ConnectError::Retryable
        ));

        assert!(matches!(
            classify_pre_ready_close(Some(CLOSE_BAD_FRAME)),
            SessionOutcome::Terminal(LinkStatus::Unsupported)
        ));
        assert!(matches!(
            classify_pre_ready_close(Some(CLOSE_UNAUTHORIZED)),
            SessionOutcome::Terminal(LinkStatus::Unauthorized)
        ));
        assert!(matches!(
            classify_pre_ready_close(Some(CLOSE_REVOKED)),
            SessionOutcome::Terminal(LinkStatus::Unauthorized)
        ));
        assert!(matches!(
            classify_online_close(Some(CLOSE_REVOKED)),
            SessionOutcome::Terminal(LinkStatus::Unauthorized)
        ));
        assert!(matches!(
            classify_online_close(Some(CLOSE_BAD_FRAME)),
            SessionOutcome::Retryable
        ));
    }
}
