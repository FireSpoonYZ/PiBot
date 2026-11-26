//! Desktop updates use the connected center's native credentials and the
//! release publisher key in `plugins.updater.pubkey`; the WebView never supplies an artifact URL.

use std::{
  fs,
  path::PathBuf,
  sync::{Arc, Mutex},
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;

use crate::{
  bridge::{self, BridgeError, DesktopBridge},
  ensure_main_webview, host_service,
};

const AUTO_CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const PREPARE_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
const CENTER_CREDENTIALS_FILE: &str = "center-credentials.json";
const CLIENT_UPDATE_CHANGED_EVENT: &str = "desktop-client-update-changed";
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(120);
const HTTP_CLIENT_CACHE_CAPACITY: usize = 4;

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
  #[default]
  Idle,
  Checking,
  Available,
  UpToDate,
  Downloading,
  Downloaded,
  Installing,
  Complete,
  Cancelled,
  Error,
  WaitingTasks,
}

#[derive(Default)]
struct UpdateInner {
  phase: Phase,
  update: Option<Update>,
  bytes: Option<Arc<Vec<u8>>>,
  fence: Option<String>,
  release: Option<Value>,
  downloaded: u64,
  total: Option<u64>,
  message: Option<String>,
  prepared: bool,
  busy: bool,
  operation: u64,
  invalidated: bool,
  last_auto_fence: Option<String>,
  last_auto_at: u64,
  cancel_tx: Option<oneshot::Sender<()>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HttpClientKey {
  origin: String,
  ca_pem: Option<String>,
  timeout: Duration,
}

impl HttpClientKey {
  fn new(origin: impl Into<String>, ca_pem: Option<&str>, timeout: Duration) -> Self {
    let normalized_ca = ca_pem
      .map(str::trim)
      .filter(|pem| !pem.is_empty())
      .map(str::to_string);
    Self {
      origin: origin.into(),
      ca_pem: normalized_ca,
      timeout,
    }
  }
}

struct HttpClientCache<C> {
  entries: Vec<(HttpClientKey, C)>,
  capacity: usize,
}

impl<C> Default for HttpClientCache<C> {
  fn default() -> Self {
    Self::with_capacity(HTTP_CLIENT_CACHE_CAPACITY)
  }
}

impl<C> HttpClientCache<C> {
  fn with_capacity(capacity: usize) -> Self {
    Self {
      entries: Vec::new(),
      capacity: capacity.max(1),
    }
  }

  #[cfg(test)]
  fn len(&self) -> usize {
    self.entries.len()
  }

  #[cfg(test)]
  fn contains_key(&self, key: &HttpClientKey) -> bool {
    self.entries.iter().any(|(existing, _)| existing == key)
  }

  fn get_or_try_insert<E, F>(&mut self, key: HttpClientKey, build: F) -> Result<C, E>
  where
    C: Clone,
    F: FnOnce(&HttpClientKey) -> Result<C, E>,
  {
    if let Some(index) = self.entries.iter().position(|(existing, _)| existing == &key) {
      let entry = self.entries.remove(index);
      let client = entry.1.clone();
      self.entries.push(entry);
      return Ok(client);
    }
    let client = build(&key)?;
    if self.entries.len() >= self.capacity {
      self.entries.remove(0);
    }
    self.entries.push((key, client.clone()));
    Ok(client)
  }
}

#[derive(Debug, Clone)]
struct ProgressThrottle {
  min_interval: Duration,
  last_emit_at: Instant,
  last_percent: u8,
  last_downloaded: u64,
}

impl ProgressThrottle {
  fn new(min_interval: Duration, started_at: Instant) -> Self {
    Self {
      min_interval,
      last_emit_at: started_at,
      last_percent: 0,
      last_downloaded: 0,
    }
  }

  fn percent_of(downloaded: u64, total: u64) -> Option<u8> {
    if total == 0 {
      return None;
    }
    let pct = ((downloaded as u128).saturating_mul(100) / (total as u128)).min(100) as u8;
    Some(pct)
  }

  fn should_emit(&mut self, downloaded: u64, total: u64, now: Instant) -> bool {
    if downloaded <= self.last_downloaded {
      return false;
    }
    let percent = Self::percent_of(downloaded, total);
    let completed = total > 0 && downloaded >= total;
    let percent_advanced = percent.is_some_and(|pct| pct > self.last_percent);
    let interval_elapsed = now.saturating_duration_since(self.last_emit_at) >= self.min_interval;

    if completed || percent_advanced || interval_elapsed {
      self.last_emit_at = now;
      if let Some(pct) = percent {
        self.last_percent = pct;
      }
      self.last_downloaded = downloaded;
      true
    } else {
      false
    }
  }
}

#[derive(Clone, Default)]
pub struct UpdateState {
  inner: Arc<Mutex<UpdateInner>>,
  http_clients: Arc<Mutex<HttpClientCache<reqwest::Client>>>,
}

#[cfg(any(windows, target_os = "linux"))]
impl UpdateState {
  pub(crate) fn blocks_close_to_tray(&self) -> bool {
    matches!(
      self.inner.lock().unwrap_or_else(|e| e.into_inner()).phase,
      Phase::Installing | Phase::Complete
    )
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus<'a> {
  phase: Phase,
  current_version: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  release: Option<Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  downloaded_bytes: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  total_bytes: Option<u64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  message: Option<String>,
}

fn snapshot_locked(inner: &UpdateInner, current_version: &str) -> Value {
  serde_json::to_value(UpdateStatus {
    phase: inner.phase,
    current_version,
    release: inner.release.clone(),
    downloaded_bytes: if matches!(inner.phase, Phase::Downloading | Phase::Downloaded) {
      Some(inner.downloaded)
    } else {
      None
    },
    total_bytes: inner.total,
    message: inner.message.clone(),
  }).unwrap()
}

fn snapshot(state: &UpdateState, current_version: &str) -> Value {
  snapshot_locked(&state.inner.lock().unwrap(), current_version)
}

fn invalid(message: &str) -> BridgeError {
  BridgeError::new("INVALID_ARGUMENT", message, "not-sent")
}

fn busy() -> BridgeError {
  BridgeError::new("BUSY", "another update operation is in progress", "not-sent")
}

fn clear_update_fields(inner: &mut UpdateInner) {
  inner.update = None;
  inner.bytes = None;
  inner.fence = None;
  inner.release = None;
  inner.downloaded = 0;
  inner.total = None;
}

fn begin(inner: &mut UpdateInner, phase: Phase, cancellable: bool) -> Result<(u64, Option<oneshot::Receiver<()>>), BridgeError> {
  if inner.busy {
    return Err(busy());
  }
  inner.operation += 1;
  inner.busy = true;
  inner.invalidated = false;
  inner.phase = phase;
  inner.message = None;
  let receiver = if cancellable {
    let (tx, rx) = oneshot::channel();
    inner.cancel_tx = Some(tx);
    Some(rx)
  } else {
    inner.cancel_tx = None;
    None
  };
  Ok((inner.operation, receiver))
}

fn emit_update_status(app: &AppHandle, payload: &Value) {
  let _ = app.emit_to("main", CLIENT_UPDATE_CHANGED_EVENT, payload);
}

fn finish(
  app: &AppHandle,
  state: &UpdateState,
  current: &str,
  operation: u64,
  phase: Phase,
  message: Option<String>,
) -> Value {
  let (payload, settled) = {
    let mut inner = state.inner.lock().unwrap();
    let settled = inner.operation == operation;
    if settled {
      if inner.invalidated && !(inner.prepared && matches!(phase, Phase::Error)) {
        clear_update_fields(&mut inner);
        inner.phase = Phase::Idle;
        inner.message = Some("center changed or disconnected; update state was reset".to_string());
      } else {
        inner.phase = phase;
        inner.message = message;
      }
      inner.busy = false;
      inner.cancel_tx = None;
    }
    (snapshot_locked(&inner, current), settled)
  };
  if settled {
    emit_update_status(app, &payload);
  }
  payload
}

pub(crate) struct CenterAuth {
  pub(crate) fence: String,
  pub(crate) origin: String,
  pub(crate) device_id: String,
  pub(crate) device_token: String,
  pub(crate) ca_pem: Option<String>,
}

fn transport_generation(value: &Value, device_id: Option<&str>) -> Option<u64> {
  if value.get("phase").and_then(Value::as_str) != Some("connected")
    || value.pointer("/connection/kind").and_then(Value::as_str) != Some("relay")
  {
    return None;
  }
  if let Some(device_id) = device_id {
    if value.pointer("/connection/deviceId").and_then(Value::as_str) != Some(device_id) {
      return None;
    }
  }
  value.get("generation").and_then(Value::as_u64)
}

/// Two broker snapshots bracket credential loading; both the native child
/// generation and the broker's relay generation must remain unchanged.
pub(crate) async fn resolve_center_auth(app: &AppHandle) -> Result<Option<CenterAuth>, BridgeError> {
  let bridge = app.state::<DesktopBridge>();
  let (child1, first) = bridge.request_with_session_generation(app, "status").await?;
  let Some(generation) = transport_generation(&first, None) else { return Ok(None) };
  let (child2, center) = bridge.request_with_session_generation(app, "center_status").await?;
  if child1 != child2 || center.get("state").and_then(Value::as_str) != Some("ready") {
    return Ok(None);
  }

  let root = PathBuf::from(bridge::resolve_client_data_root(app)?);
  let text = fs::read_to_string(root.join(CENTER_CREDENTIALS_FILE))
    .map_err(|_| BridgeError::new("NOT_CONNECTED", "center credentials are unavailable", "not-sent"))?;
  let credentials: Value = serde_json::from_str(&text)
    .map_err(|_| BridgeError::new("BAD_RESPONSE", "center credentials are invalid", "not-sent"))?;
  let parsed = tauri::Url::parse(credentials.get("url").and_then(Value::as_str).unwrap_or(""))
    .map_err(|_| invalid("center credentials contain an invalid URL"))?;
  if parsed.scheme() != "https" || parsed.host_str().is_none()
    || !parsed.username().is_empty() || parsed.password().is_some()
  {
    return Err(invalid("desktop updates require an HTTPS center URL without user information"));
  }
  let origin = parsed.origin().ascii_serialization();
  let active = center.get("centerUrl").and_then(Value::as_str)
    .and_then(|url| tauri::Url::parse(url).ok())
    .map(|url| url.origin().ascii_serialization());
  if active.as_deref() != Some(origin.as_str()) {
    return Ok(None);
  }

  let device_id = credentials.get("deviceId").and_then(Value::as_str).unwrap_or("").trim().to_string();
  let device_token = credentials.get("deviceToken").and_then(Value::as_str).unwrap_or("").trim().to_string();
  if device_id.is_empty() || device_id.len() > 128 || device_id.starts_with('-')
    || device_id.chars().any(|c| c.is_whitespace() || c.is_control())
    || device_token.is_empty() || device_token.len() > 4096
    || device_token.chars().any(|c| c.is_whitespace() || c.is_control())
  {
    return Err(invalid("center credentials contain an invalid device identity"));
  }
  let ca_pem = credentials.get("ca").and_then(Value::as_str)
    .map(str::trim).filter(|pem| !pem.is_empty()).map(str::to_string);
  if ca_pem.as_ref().is_some_and(|pem| pem.len() > 64 * 1024 || !pem.contains("-----BEGIN CERTIFICATE-----")) {
    return Err(invalid("center credentials contain an invalid CA certificate"));
  }
  let (child3, last) = bridge.request_with_session_generation(app, "status").await?;
  if child3 != child1 || transport_generation(&last, Some(&device_id)) != Some(generation) {
    return Ok(None);
  }

  let key = format!("{origin}|{device_id}");
  Ok(Some(CenterAuth {
    fence: format!("{child1}:{generation}:{key}"),
    origin, device_id, device_token, ca_pem,
  }))
}

fn update_target() -> Result<(&'static str, &'static str, &'static str), BridgeError> {
  if cfg!(windows) && cfg!(target_arch = "x86_64") {
    Ok(("windows", "x86_64", "nsis"))
  } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
    Ok(("linux", "x86_64", "deb"))
  } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
    // Tauri's macOS updater installs a signed PiBot.app.tar.gz in place.
    Ok(("macos", "aarch64", "app"))
  } else {
    Err(invalid("desktop updater supports Windows/Linux x86_64 and macOS Apple Silicon only"))
  }
}

struct Installed {
  result: Result<(), String>,
  /// Non-fatal Host restore problem to report next to the result.
  note: Option<String>,
  /// The Host that held the update preparation was stopped; the restarted
  /// process never entered maintenance, so there is nothing to cancel.
  host_cycled: bool,
}

/// Installs the verified package. Windows/Linux installers own the Host
/// lifecycle (NSIS hooks, DEB maintainer scripts); macOS swaps the .app in
/// place, so the Host is stopped around the swap and restored afterwards.
async fn install_package(update: Update, bytes: Arc<Vec<u8>>) -> Installed {
  #[cfg(target_os = "macos")]
  {
    match host_service::with_host_stopped(move || update.install(bytes.as_slice())).await {
      Ok((result, note)) => Installed { result: result.map_err(|err| err.to_string()), note, host_cycled: true },
      // Nothing was replaced: the swap only runs after a confirmed stop.
      Err(err) => Installed {
        result: Err(format!(
          "update not installed: the local Host could not be confirmed stopped ({}: {})",
          err.code, err.message
        )),
        note: None,
        host_cycled: false,
      },
    }
  }
  #[cfg(not(target_os = "macos"))]
  {
    let result = match tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice())).await {
      Ok(Ok(())) => Ok(()),
      Ok(Err(err)) => Err(err.to_string()),
      Err(err) => Err(format!("install worker failed: {err}")),
    };
    Installed { result, note: None, host_cycled: false }
  }
}

fn with_note(message: String, note: Option<String>) -> String {
  match note {
    Some(note) => format!("{message}; {note}"),
    None => message,
  }
}

fn parse_certificates(ca_pem: Option<&str>) -> Result<Vec<reqwest::Certificate>, BridgeError> {
  use rustls::pki_types::{pem::PemObject, CertificateDer};

  let Some(pem) = ca_pem.map(str::trim).filter(|pem| !pem.is_empty()) else {
    return Ok(Vec::new());
  };
  let mut store = rustls::RootCertStore::empty();
  let mut certs = Vec::new();
  for item in CertificateDer::pem_slice_iter(pem.as_bytes()) {
    let der = item.map_err(|_| invalid("center CA certificate could not be parsed"))?;
    let cert = reqwest::Certificate::from_der(der.as_ref())
      .map_err(|_| invalid("center CA certificate could not be parsed"))?;
    store
      .add(der)
      .map_err(|_| invalid("center CA certificate could not be parsed"))?;
    certs.push(cert);
  }
  if certs.is_empty() {
    return Err(invalid("center CA certificate could not be parsed"));
  }
  Ok(certs)
}

fn center_certificates(center: &CenterAuth) -> Result<Vec<reqwest::Certificate>, BridgeError> {
  parse_certificates(center.ca_pem.as_deref())
}

fn configure_client(
  client: reqwest::ClientBuilder,
  origin: String,
  certificates: Vec<reqwest::Certificate>,
  timeout: Duration,
) -> reqwest::ClientBuilder {
  let client = if certificates.is_empty() {
    client
  } else {
    client.tls_certs_merge(certificates)
  };
  client.timeout(timeout).redirect(reqwest::redirect::Policy::custom(move |attempt| {
    let url = attempt.url();
    if attempt.previous().len() < 10 && url.scheme() == "https"
      && url.origin().ascii_serialization() == origin
      && url.username().is_empty() && url.password().is_none()
    {
      attempt.follow()
    } else {
      attempt.error("update redirect is not allowed")
    }
  }))
}

fn build_http_client(key: &HttpClientKey) -> Result<reqwest::Client, String> {
  // reqwest uses rustls-no-provider; retain an existing provider or install ring.
  let _ = rustls::crypto::ring::default_provider().install_default();
  let certificates = parse_certificates(key.ca_pem.as_deref()).map_err(|err| err.message)?;
  configure_client(reqwest::Client::builder(), key.origin.clone(), certificates, key.timeout)
    .build()
    .map_err(|err| err.to_string())
}

fn cached_http_client(
  state: &UpdateState,
  center: &CenterAuth,
  timeout: Duration,
) -> Result<reqwest::Client, String> {
  let key = HttpClientKey::new(center.origin.clone(), center.ca_pem.as_deref(), timeout);
  let mut cache = state.http_clients.lock().unwrap_or_else(|e| e.into_inner());
  cache.get_or_try_insert(key, build_http_client)
}

fn build_updater(app: &AppHandle, center: &CenterAuth) -> Result<tauri_plugin_updater::Updater, BridgeError> {
  let (platform, arch, format) = update_target()?;
  let endpoint = tauri::Url::parse(&format!(
    "{}/api/client-updates/{platform}/{arch}/{format}/{{{{current_version}}}}", center.origin
  )).map_err(|_| invalid("failed to build update endpoint"))?;
  let certificates = center_certificates(center)?;
  let origin = center.origin.clone();
  app.updater_builder()
    .endpoints(vec![endpoint]).map_err(|err| BridgeError::new("UPDATE_ERROR", err.to_string(), "not-sent"))?
    .header("Authorization", format!("Bearer {}", center.device_token))
      .map_err(|err| BridgeError::new("UPDATE_ERROR", err.to_string(), "not-sent"))?
    .header("X-Device-Id", center.device_id.clone())
      .map_err(|err| BridgeError::new("UPDATE_ERROR", err.to_string(), "not-sent"))?
    .timeout(CHECK_TIMEOUT)
    .restart_after_install(false)
    .configure_client(move |client| configure_client(client, origin.clone(), certificates.clone(), CHECK_TIMEOUT))
    .build().map_err(|err| BridgeError::new("UPDATE_ERROR", err.to_string(), "not-sent"))
}

fn validate_release(update: &Update, center: &CenterAuth) -> Result<(u64, String, Value), String> {
  let (platform, arch, format) = update_target().map_err(|err| err.message)?;
  let raw = &update.raw_json;
  let id = raw.get("id").and_then(Value::as_str).filter(|id| {
    !id.trim().is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
  }).ok_or("center returned an invalid release id")?;
  let size = raw.get("size").and_then(Value::as_u64)
    .filter(|size| *size > 0 && *size <= MAX_UPDATE_BYTES)
    .ok_or("center returned an invalid update size")?;
  let sha = raw.get("sha256").and_then(Value::as_str)
    .filter(|sha| sha.len() == 64 && sha.chars().all(|c| c.is_ascii_hexdigit()))
    .ok_or("center returned an invalid update checksum")?;
  let source = raw.get("sourceCommit").and_then(Value::as_str)
    .filter(|source| matches!(source.len(), 40 | 64) && source.chars().all(|c| c.is_ascii_hexdigit()))
    .ok_or("center returned an invalid source commit")?;
  if raw.get("platform").and_then(Value::as_str) != Some(platform)
    || raw.get("arch").and_then(Value::as_str) != Some(arch)
    || raw.get("format").and_then(Value::as_str) != Some(format)
  {
    return Err("center returned an update for another platform".to_string());
  }
  let url = &update.download_url;
  if url.scheme() != "https" || url.origin().ascii_serialization() != center.origin
    || !url.username().is_empty() || url.password().is_some()
  {
    return Err("update artifact is not served by the connected HTTPS center".to_string());
  }
  let mut release = Map::new();
  release.insert("id".into(), json!(id));
  release.insert("version".into(), json!(update.version));
  release.insert("notes".into(), json!(update.body));
  release.insert("size".into(), json!(size));
  release.insert("sha256".into(), json!(sha));
  release.insert("sourceCommit".into(), json!(source));
  Ok((size, sha.to_string(), Value::Object(release)))
}

fn now_ms() -> u64 {
  SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Called only while the updater operation is reserved.
/// Returns `Ok(true)` when `host_cli("cancel-update")` actually ran, or `Ok(false)` when no
/// preparation was active.
async fn release_prepare(state: &UpdateState) -> Result<bool, String> {
  if !state.inner.lock().unwrap().prepared {
    return Ok(false);
  }
  host_service::host_cli(vec!["cancel-update".to_string()], CANCEL_TIMEOUT).await
    .map_err(|err| format!("could not release Host update preparation: {}", err.message))?;
  state.inner.lock().unwrap().prepared = false;
  Ok(true)
}

async fn fence_matches(app: &AppHandle, state: &UpdateState, operation: u64, expected: &str) -> bool {
  let matches = matches!(resolve_center_auth(app).await, Ok(Some(center)) if center.fence == expected);
  let mut inner = state.inner.lock().unwrap();
  if inner.operation != operation || inner.invalidated {
    return false;
  }
  if !matches {
    inner.invalidated = true;
    clear_update_fields(&mut inner);
  }
  matches
}

async fn finish_stale_with_io(app: &AppHandle, state: &UpdateState, current: &str, operation: u64) -> (Value, bool) {
  match release_prepare(state).await {
    Ok(did_release) => (finish(app, state, current, operation, Phase::Idle, None), did_release),
    Err(message) => (finish(app, state, current, operation, Phase::Error, Some(message)), true),
  }
}

async fn finish_stale(app: &AppHandle, state: &UpdateState, current: &str, operation: u64) -> Value {
  finish_stale_with_io(app, state, current, operation).await.0
}

async fn reconcile_with_resolved(
  app: &AppHandle,
  state: &UpdateState,
  operation: u64,
  fence: String,
  resolved_fence: Option<&str>,
) -> bool {
  if resolved_fence == Some(fence.as_str()) {
    return false;
  }
  let current = app.package_info().version.to_string();
  let (cleanup, reset_snapshot) = {
    let mut inner = state.inner.lock().unwrap();
    if inner.operation != operation || inner.fence.as_deref() != Some(fence.as_str()) {
      return false;
    }
    inner.invalidated = true;
    clear_update_fields(&mut inner);
    inner.phase = Phase::Idle;
    inner.message = Some("center changed or disconnected; update state was reset".to_string());
    if let Some(tx) = inner.cancel_tx.take() {
      let _ = tx.send(());
    }
    if inner.busy {
      (false, Some(snapshot_locked(&inner, &current)))
    } else {
      inner.busy = true;
      (true, None)
    }
  };
  if cleanup {
    let (_, did_io) = finish_stale_with_io(app, state, &current, operation).await;
    did_io
  } else {
    if let Some(payload) = reset_snapshot {
      emit_update_status(app, &payload);
    }
    false
  }
}

async fn resolve_and_reconcile_center_auth(
  app: &AppHandle,
  state: &UpdateState,
) -> (Result<Option<CenterAuth>, BridgeError>, bool) {
  let (operation, fence) = {
    let inner = state.inner.lock().unwrap();
    (inner.operation, inner.fence.clone())
  };
  let auth = resolve_center_auth(app).await;
  let did_io = if let Some(fence) = fence {
    let resolved_fence = auth
      .as_ref()
      .ok()
      .and_then(|center| center.as_ref())
      .map(|center| center.fence.as_str());
    reconcile_with_resolved(app, state, operation, fence, resolved_fence).await
  } else {
    false
  };
  (auth, did_io)
}

async fn reconcile_center_state(app: &AppHandle, state: &UpdateState) {
  let (operation, fence) = {
    let inner = state.inner.lock().unwrap();
    (inner.operation, inner.fence.clone())
  };
  let Some(fence) = fence else { return };
  let auth = resolve_center_auth(app).await;
  let resolved_fence = auth
    .as_ref()
    .ok()
    .and_then(|center| center.as_ref())
    .map(|center| center.fence.as_str());
  let _ = reconcile_with_resolved(app, state, operation, fence, resolved_fence).await;
}

#[tauri::command]
pub async fn desktop_update_status(app: AppHandle, webview: Webview, state: State<'_, UpdateState>) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  reconcile_center_state(&app, &state).await;
  Ok(snapshot(&state, &app.package_info().version.to_string()))
}

#[tauri::command]
pub async fn desktop_update_check(
  app: AppHandle, webview: Webview, state: State<'_, UpdateState>, automatic: Option<bool>,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let (auth, reconciled_io) = resolve_and_reconcile_center_auth(&app, &state).await;
  let current = app.package_info().version.to_string();
  let (operation, mut cancel, mut previous, start_snapshot) = {
    let mut inner = state.inner.lock().unwrap();
    let previous = inner.phase;
    let (operation, cancel) = begin(&mut inner, Phase::Checking, true)?;
    let start_snapshot = snapshot_locked(&inner, &current);
    (operation, cancel.unwrap(), previous, start_snapshot)
  };
  emit_update_status(&app, &start_snapshot);
  let auth = if reconciled_io {
    resolve_center_auth(&app).await
  } else {
    auth
  };
  let center = match auth {
    Ok(Some(center)) => center,
    Ok(None) => {
      {
        let mut inner = state.inner.lock().unwrap();
        inner.invalidated = true;
        clear_update_fields(&mut inner);
      }
      return Ok(finish_stale(&app, &state, &current, operation).await);
    }
    Err(err) => {
      {
        let mut inner = state.inner.lock().unwrap();
        clear_update_fields(&mut inner);
      }
      let cleanup = release_prepare(&state).await;
      return Ok(finish(&app, &state, &current, operation, Phase::Error, Some(cleanup.err().unwrap_or(err.message))));
    }
  };
  let (invalidated, replaced) = {
    let mut inner = state.inner.lock().unwrap();
    let replaced = inner.fence.as_ref().is_some_and(|fence| fence != &center.fence);
    if replaced {
      clear_update_fields(&mut inner);
      previous = Phase::Idle;
    }
    if !inner.invalidated {
      inner.fence = Some(center.fence.clone());
    }
    (inner.invalidated, replaced)
  };
  if invalidated {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  let mut cancelled = cancel.try_recv().is_ok();
  if replaced || cancelled {
    let cleanup = release_prepare(&state).await;
    if (replaced || !matches!(cleanup, Ok(false))) && !fence_matches(&app, &state, operation, &center.fence).await {
      return Ok(match cleanup {
        Ok(_) => finish_stale(&app, &state, &current, operation).await,
        Err(message) => finish(&app, &state, &current, operation, Phase::Error, Some(message)),
      });
    }
    if let Err(message) = cleanup {
      return Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message)));
    }
    if !cancelled {
      cancelled = cancel.try_recv().is_ok();
    }
    if cancelled {
      return Ok(finish(&app, &state, &current, operation, Phase::Cancelled, None));
    }
  }
  if automatic.unwrap_or(false) {
    let now = now_ms();
    let throttled = {
      let inner = state.inner.lock().unwrap();
      inner.last_auto_fence.as_deref() == Some(center.fence.as_str())
        && now.saturating_sub(inner.last_auto_at) < AUTO_CHECK_INTERVAL_MS
    };
    if throttled {
      if !fence_matches(&app, &state, operation, &center.fence).await {
        return Ok(finish_stale(&app, &state, &current, operation).await);
      }
      if cancel.try_recv().is_ok() {
        let cleanup = release_prepare(&state).await;
        if !matches!(cleanup, Ok(false)) && !fence_matches(&app, &state, operation, &center.fence).await {
          return Ok(match cleanup {
            Ok(_) => finish_stale(&app, &state, &current, operation).await,
            Err(message) => finish(&app, &state, &current, operation, Phase::Error, Some(message)),
          });
        }
        return Ok(match cleanup {
          Ok(_) => finish(&app, &state, &current, operation, Phase::Cancelled, None),
          Err(message) => finish(&app, &state, &current, operation, Phase::Error, Some(message)),
        });
      }
      return Ok(finish(&app, &state, &current, operation, previous, None));
    }
  }
  {
    let mut inner = state.inner.lock().unwrap();
    if !inner.invalidated {
      clear_update_fields(&mut inner);
      inner.fence = Some(center.fence.clone());
    }
  }
  let cleanup = release_prepare(&state).await;
  if !matches!(cleanup, Ok(false)) && !fence_matches(&app, &state, operation, &center.fence).await {
    return Ok(match cleanup {
      Ok(_) => finish_stale(&app, &state, &current, operation).await,
      Err(message) => finish(&app, &state, &current, operation, Phase::Error, Some(message)),
    });
  }
  if let Err(message) = cleanup {
    return Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message)));
  }
  if automatic.unwrap_or(false) {
    let mut inner = state.inner.lock().unwrap();
    if !inner.invalidated {
      inner.last_auto_fence = Some(center.fence.clone());
      inner.last_auto_at = now_ms();
    }
  }
  let outcome = match build_updater(&app, &center) {
    Ok(updater) => tokio::select! {
      biased;
      _ = &mut cancel => None,
      result = updater.check() => Some(result.map_err(|err| err.to_string())),
    },
    Err(err) => Some(Err(err.message)),
  };
  if !fence_matches(&app, &state, operation, &center.fence).await {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  match outcome {
    None => Ok(finish(&app, &state, &current, operation, Phase::Cancelled, None)),
    Some(Err(message)) => Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message))),
    Some(Ok(None)) => Ok(finish(&app, &state, &current, operation, Phase::UpToDate, None)),
    Some(Ok(Some(update))) => match validate_release(&update, &center) {
      Err(message) => Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message))),
      Ok((size, _, release)) => {
        {
          let mut inner = state.inner.lock().unwrap();
          if !inner.invalidated {
            inner.update = Some(update);
            inner.release = Some(release);
            inner.total = Some(size);
          }
        }
        Ok(finish(&app, &state, &current, operation, Phase::Available, None))
      }
    },
  }
}

async fn download_bounded(
  app: &AppHandle,
  center: &CenterAuth,
  update: &Update,
  state: &UpdateState,
  current: &str,
  operation: u64,
  size: u64,
  sha: &str,
) -> Result<Vec<u8>, String> {
  let client = cached_http_client(state, center, DOWNLOAD_TIMEOUT)?;
  let mut response = client.get(update.download_url.clone()).headers(update.headers.clone())
    .send().await.map_err(|err| err.to_string())?
    .error_for_status().map_err(|err| err.to_string())?;
  if response.content_length().is_some_and(|length| length != size) {
    return Err("update package size does not match the center metadata".to_string());
  }
  let mut bytes = Vec::new();
  let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL, Instant::now());
  while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
    if (bytes.len() as u64).saturating_add(chunk.len() as u64) > size {
      return Err("update package exceeds its declared size".to_string());
    }
    bytes.extend_from_slice(&chunk);
    let downloaded = bytes.len() as u64;
    let should_emit = throttle.should_emit(downloaded, size, Instant::now());
    let progress_snapshot = {
      let mut inner = state.inner.lock().unwrap();
      if inner.operation == operation && !inner.invalidated {
        inner.downloaded = downloaded;
        should_emit.then(|| snapshot_locked(&inner, current))
      } else {
        None
      }
    };
    if let Some(payload) = progress_snapshot {
      emit_update_status(app, &payload);
    }
  }
  if bytes.len() as u64 != size || !format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(sha) {
    return Err("update package size or checksum does not match the center metadata".to_string());
  }
  update.verify(&bytes).map_err(|err| err.to_string())?;
  Ok(bytes)
}

#[tauri::command]
pub async fn desktop_update_download(app: AppHandle, webview: Webview, state: State<'_, UpdateState>) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let (auth, reconciled_io) = resolve_and_reconcile_center_auth(&app, &state).await;
  let current = app.package_info().version.to_string();
  let (operation, mut cancel, update, fence, start_snapshot) = {
    let mut inner = state.inner.lock().unwrap();
    if inner.busy { return Err(busy()); }
    if inner.bytes.is_some() { return Ok(snapshot_locked(&inner, &current)); }
    let update = inner.update.clone().ok_or_else(|| invalid("no update is available to download"))?;
    let fence = inner.fence.clone().ok_or_else(|| invalid("update center is unavailable"))?;
    let (operation, cancel) = begin(&mut inner, Phase::Downloading, true)?;
    inner.downloaded = 0;
    let start_snapshot = snapshot_locked(&inner, &current);
    (operation, cancel.unwrap(), update, fence, start_snapshot)
  };
  emit_update_status(&app, &start_snapshot);
  let auth = if reconciled_io {
    resolve_center_auth(&app).await
  } else {
    auth
  };
  let center = match auth {
    Ok(Some(center)) if center.fence == fence => center,
    _ => {
      {
        let mut inner = state.inner.lock().unwrap();
        if inner.operation == operation {
          inner.invalidated = true;
          clear_update_fields(&mut inner);
        }
      }
      return Ok(finish_stale(&app, &state, &current, operation).await);
    }
  };
  let (size, sha, _) = match validate_release(&update, &center) {
    Ok(metadata) => metadata,
    Err(message) => return Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message))),
  };
  let outcome = tokio::select! {
    biased;
    _ = &mut cancel => None,
    result = download_bounded(&app, &center, &update, &state, &current, operation, size, &sha) => Some(result),
  };
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  match outcome {
    None => Ok(finish(&app, &state, &current, operation, Phase::Cancelled, None)),
    Some(Err(message)) => Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message))),
    Some(Ok(bytes)) => {
      {
        let mut inner = state.inner.lock().unwrap();
        if !inner.invalidated {
          inner.downloaded = bytes.len() as u64;
          inner.bytes = Some(Arc::new(bytes));
        }
      }
      Ok(finish(&app, &state, &current, operation, Phase::Downloaded, None))
    }
  }
}

#[tauri::command]
pub async fn desktop_update_install(
  app: AppHandle, webview: Webview, state: State<'_, UpdateState>, stop_active: Option<bool>,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  reconcile_center_state(&app, &state).await;
  let current = app.package_info().version.to_string();
  let (operation, update, bytes, fence, start_snapshot) = {
    let mut inner = state.inner.lock().unwrap();
    if inner.busy { return Err(busy()); }
    let update = inner.update.clone().ok_or_else(|| invalid("no downloaded update is ready"))?;
    let bytes = inner.bytes.clone().ok_or_else(|| invalid("no downloaded update is ready"))?;
    let fence = inner.fence.clone().ok_or_else(|| invalid("update center is unavailable"))?;
    let (operation, _) = begin(&mut inner, Phase::Installing, false)?;
    let start_snapshot = snapshot_locked(&inner, &current);
    (operation, update, bytes, fence, start_snapshot)
  };
  emit_update_status(&app, &start_snapshot);
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  let previously_prepared = {
    let mut inner = state.inner.lock().unwrap();
    let previous = inner.prepared;
    if !inner.invalidated {
      inner.prepared = true;
    }
    previous
  };
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  let mut args = vec!["prepare-update".to_string()];
  if stop_active.unwrap_or(false) {
    args.push("--stop-active".to_string());
  }
  let prepared = host_service::host_cli(args, PREPARE_TIMEOUT).await;
  if !previously_prepared && matches!(&prepared, Err(err) if err.outcome == "not-sent") {
    state.inner.lock().unwrap().prepared = false;
  }
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  match prepared {
    Ok(value) if value.get("ready").and_then(Value::as_bool) == Some(false)
      && value.get("activeCount").and_then(Value::as_u64).is_some() => {
      let active = value.get("activeCount").and_then(Value::as_u64).unwrap();
      return Ok(finish(&app, &state, &current, operation, Phase::WaitingTasks, Some(format!("{active} host task(s) still active"))));
    }
    Ok(value) if value.get("ready").and_then(Value::as_bool) == Some(true)
      && value.get("activeCount").and_then(Value::as_u64).is_some() => {}
    result => {
      let message = match result {
        Err(err) => err.message,
        _ => "launcher returned an invalid update preparation result".to_string(),
      };
      let cleanup = release_prepare(&state).await;
      if !matches!(cleanup, Ok(false)) && !fence_matches(&app, &state, operation, &fence).await {
        return Ok(match cleanup {
          Ok(_) => finish_stale(&app, &state, &current, operation).await,
          Err(message) => finish(&app, &state, &current, operation, Phase::Error, Some(message)),
        });
      }
      let message = cleanup.err().unwrap_or(message);
      return Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message)));
    }
  }
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  let Installed { result, note, host_cycled } = install_package(update, bytes).await;
  if host_cycled {
    state.inner.lock().unwrap().prepared = false;
  }
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&app, &state, &current, operation).await);
  }
  let cleanup = release_prepare(&state).await;
  if !matches!(cleanup, Ok(false)) && !fence_matches(&app, &state, operation, &fence).await {
    return Ok(match cleanup {
      Ok(_) => finish_stale(&app, &state, &current, operation).await,
      Err(message) => finish(&app, &state, &current, operation, Phase::Error, Some(message)),
    });
  }
  match (result, cleanup) {
    // Keep the install failure (e.g. a blocked swap) visible next to a cleanup failure.
    (Err(failed), Err(message)) => Ok(finish(&app, &state, &current, operation, Phase::Error, Some(with_note(format!("{failed}; {message}"), note)))),
    (Ok(()), Err(message)) => Ok(finish(&app, &state, &current, operation, Phase::Error, Some(with_note(message, note)))),
    (Ok(()), Ok(_)) => {
      {
        let mut inner = state.inner.lock().unwrap();
        if !inner.invalidated {
          clear_update_fields(&mut inner);
          inner.fence = Some(fence.clone());
        }
      }
      Ok(finish(&app, &state, &current, operation, Phase::Complete, Some(with_note(
        "update installed; restart the app to run the new version".to_string(), note,
      ))))
    }
    (Err(message), Ok(_)) => Ok(finish(&app, &state, &current, operation, Phase::Error, Some(with_note(message, note)))),
  }
}

#[tauri::command]
pub async fn desktop_update_cancel(app: AppHandle, webview: Webview, state: State<'_, UpdateState>) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  reconcile_center_state(&app, &state).await;
  let current = app.package_info().version.to_string();
  let (operation, fence, start_snapshot) = {
    let mut inner = state.inner.lock().unwrap();
    if inner.busy {
      if let Some(tx) = inner.cancel_tx.take() {
        let _ = tx.send(());
        return Ok(snapshot_locked(&inner, &current));
      }
      return Err(busy());
    }
    let fence = inner.fence.clone();
    let (operation, _) = begin(&mut inner, Phase::Cancelled, false)?;
    let start_snapshot = snapshot_locked(&inner, &current);
    (operation, fence, start_snapshot)
  };
  emit_update_status(&app, &start_snapshot);
  let cleanup = release_prepare(&state).await;
  if !matches!(cleanup, Ok(false)) {
    if let Some(fence) = &fence {
      if !fence_matches(&app, &state, operation, fence).await {
        return Ok(match cleanup {
          Ok(_) => finish_stale(&app, &state, &current, operation).await,
          Err(message) => finish(&app, &state, &current, operation, Phase::Error, Some(message)),
        });
      }
    }
  }
  match cleanup {
    Err(message) => Ok(finish(&app, &state, &current, operation, Phase::Error, Some(message))),
    Ok(_) => {
      {
        let mut inner = state.inner.lock().unwrap();
        if !inner.invalidated {
          clear_update_fields(&mut inner);
          inner.fence = fence;
        }
      }
      Ok(finish(&app, &state, &current, operation, Phase::Cancelled, None))
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample_center(origin: &str, ca_pem: Option<&str>) -> CenterAuth {
    CenterAuth {
      fence: format!("1:1:{origin}|device-1"),
      origin: origin.to_string(),
      device_id: "device-1".to_string(),
      device_token: "token-1".to_string(),
      ca_pem: ca_pem.map(str::to_string),
    }
  }

  #[test]
  fn check_and_download_timeouts_are_separated() {
    assert_eq!(CHECK_TIMEOUT, Duration::from_secs(15));
    assert_eq!(DOWNLOAD_TIMEOUT, Duration::from_secs(600));
    assert!(CHECK_TIMEOUT < DOWNLOAD_TIMEOUT);
    assert_eq!(AUTO_CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000);
  }

  #[test]
  fn progress_throttle_skips_rapid_small_chunks_and_emits_on_percent_or_interval() {
    let t0 = Instant::now();
    let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL, t0);
    let total = 10_000_000u64;

    // Rapid small chunks (<1% and <120ms) do not emit.
    assert!(!throttle.should_emit(65_536, total, t0 + Duration::from_millis(20)));
    assert!(!throttle.should_emit(90_000, total, t0 + Duration::from_millis(119)));

    // Crossing >=1% triggers immediately even before 120ms.
    assert!(throttle.should_emit(100_000, total, t0 + Duration::from_millis(119)));

    // Subsequent chunk still at 1% and <120ms since last emit is skipped.
    assert!(!throttle.should_emit(150_000, total, t0 + Duration::from_millis(200)));

    // Elapsed >=120ms since last emit (119ms + 120ms = 239ms) triggers even within 1%.
    assert!(throttle.should_emit(151_000, total, t0 + Duration::from_millis(239)));

    // Duplicate byte count never re-emits.
    assert!(!throttle.should_emit(151_000, total, t0 + Duration::from_millis(500)));
  }

  #[test]
  fn progress_throttle_handles_completion_and_zero_total_edge_cases() {
    let t0 = Instant::now();
    let mut throttle = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL, t0);

    assert!(throttle.should_emit(990, 1000, t0 + Duration::from_millis(5)));
    assert!(!throttle.should_emit(995, 1000, t0 + Duration::from_millis(10)));
    // Completion always emits even <120ms after the prior progress event.
    assert!(throttle.should_emit(1000, 1000, t0 + Duration::from_millis(12)));
    assert!(!throttle.should_emit(1000, 1000, t0 + Duration::from_millis(500)));

    // Tiny single-chunk completion emits immediately.
    let mut tiny = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL, t0);
    assert!(tiny.should_emit(16, 16, t0 + Duration::from_millis(1)));

    // Unknown/zero total falls back cleanly to time-based throttling.
    let mut unknown = ProgressThrottle::new(PROGRESS_EMIT_INTERVAL, t0);
    assert!(!unknown.should_emit(0, 0, t0 + Duration::from_millis(200)));
    assert!(!unknown.should_emit(4096, 0, t0 + Duration::from_millis(50)));
    assert!(unknown.should_emit(8192, 0, t0 + Duration::from_millis(120)));
    assert!(!unknown.should_emit(12_288, 0, t0 + Duration::from_millis(200)));
    assert!(unknown.should_emit(16_384, 0, t0 + Duration::from_millis(240)));
  }

  #[test]
  fn http_client_cache_reuses_matching_key_and_evicts_lru_on_origin_ca_or_timeout_change() {
    fn insert_or_get(cache: &mut HttpClientCache<usize>, builds: &mut usize, key: HttpClientKey) -> usize {
      cache
        .get_or_try_insert(key, |_| -> Result<usize, &'static str> {
          *builds += 1;
          Ok(*builds)
        })
        .unwrap()
    }

    let mut cache = HttpClientCache::<usize>::with_capacity(HTTP_CLIENT_CACHE_CAPACITY);
    let mut builds = 0usize;

    let key_a = HttpClientKey::new("https://center-a.example", None, DOWNLOAD_TIMEOUT);
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_a.clone()), 1);
    // Blank/whitespace CA normalizes to None and reuses the same cached client.
    let key_a_blank_ca = HttpClientKey::new("https://center-a.example", Some("   "), DOWNLOAD_TIMEOUT);
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_a_blank_ca), 1);
    assert_eq!(builds, 1);
    assert_eq!(cache.len(), 1);

    // Adding a custom CA creates a distinct client; trimmed CA reuses it.
    let key_b = HttpClientKey::new("https://center-a.example", Some("  CA-PEM-A  "), DOWNLOAD_TIMEOUT);
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_b.clone()), 2);
    let key_b_trimmed = HttpClientKey::new("https://center-a.example", Some("CA-PEM-A"), DOWNLOAD_TIMEOUT);
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_b_trimmed), 2);
    assert_eq!(builds, 2);

    // Different CA PEM and different origin each get distinct entries.
    let key_c = HttpClientKey::new("https://center-a.example", Some("CA-PEM-B"), DOWNLOAD_TIMEOUT);
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_c.clone()), 3);
    let key_d = HttpClientKey::new("https://center-b.example", None, DOWNLOAD_TIMEOUT);
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_d.clone()), 4);
    assert_eq!(cache.len(), 4);

    // Refresh key_a recency so key_b becomes the least-recently-used entry.
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_a.clone()), 1);
    assert_eq!(builds, 4);

    // Different timeout inserts a 5th key and evicts LRU (key_b), keeping capacity bounded at 4.
    let key_e = HttpClientKey::new("https://center-a.example", None, CHECK_TIMEOUT);
    assert_eq!(insert_or_get(&mut cache, &mut builds, key_e.clone()), 5);
    assert_eq!(cache.len(), 4);
    assert!(!cache.contains_key(&key_b));
    assert!(cache.contains_key(&key_a));
    assert!(cache.contains_key(&key_c));
    assert!(cache.contains_key(&key_d));
    assert!(cache.contains_key(&key_e));

    // A failed client build must not insert or evict existing cached entries.
    let bad_key = HttpClientKey::new("https://center-c.example", Some("bad"), DOWNLOAD_TIMEOUT);
    let err = cache.get_or_try_insert(bad_key.clone(), |_| Err("invalid ca"));
    assert!(err.is_err());
    assert_eq!(cache.len(), 4);
    assert!(!cache.contains_key(&bad_key));
    assert!(cache.contains_key(&key_a));
  }

  const TEST_CA_PEM_1: &str = concat!(
    "-----BEGIN CERTIFICATE-----\n",
    "MIIBtjCCAVugAwIBAgITBmyf1XSXNmY/Owua2eiedgPySjAKBggqhkjOPQQDAjA5\n",
    "MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24g\n",
    "Um9vdCBDQSAzMB4XDTE1MDUyNjAwMDAwMFoXDTQwMDUyNjAwMDAwMFowOTELMAkG\n",
    "A1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJvb3Qg\n",
    "Q0EgMzBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABCmXp8ZBf8ANm+gBG1bG8lKl\n",
    "ui2yEujSLtf6ycXYqm0fc4E7O5hrOXwzpcVOho6AF2hiRVd9RFgdszflZwjrZt6j\n",
    "QjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBSr\n",
    "ttvXBp43rDCGB5Fwx5zEGbF4wDAKBggqhkjOPQQDAgNJADBGAiEA4IWSoxe3jfkr\n",
    "BqWTrBqYaGFy+uGh0PsceGCmQ5nFuMQCIQCcAu/xlJyzlvnrxir4tiz+OpAUFteM\n",
    "YyRIHN8wfdVoOw==\n",
    "-----END CERTIFICATE-----\n",
  );

  const TEST_CA_PEM_2: &str = concat!(
    "-----BEGIN CERTIFICATE-----\n",
    "MIIB8jCCAXigAwIBAgITBmyf18G7EEwpQ+Vxe3ssyBrBDjAKBggqhkjOPQQDAzA5\n",
    "MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6b24g\n",
    "Um9vdCBDQSA0MB4XDTE1MDUyNjAwMDAwMFoXDTQwMDUyNjAwMDAwMFowOTELMAkG\n",
    "A1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJvb3Qg\n",
    "Q0EgNDB2MBAGByqGSM49AgEGBSuBBAAiA2IABNKrijdPo1MN/sGKe0uoe0ZLY7Bi\n",
    "9i0b2whxIdIA6GO9mif78DluXeo9pcmBqqNbIJhFXRbb/egQbeOc4OO9X4Ri83Bk\n",
    "M6DLJC9wuoihKqB1+IGuYgbEgds5bimwHvouXKNCMEAwDwYDVR0TAQH/BAUwAwEB\n",
    "/zAOBgNVHQ8BAf8EBAMCAYYwHQYDVR0OBBYEFNPsxzplbszh2naaVvuc84ZtV+WB\n",
    "MAoGCCqGSM49BAMDA2gAMGUCMDqLIfG9fhGt0O9Yli/W651+kI0rz2ZVwyzjKKlw\n",
    "CkcO8DdZEv8tmZQoTipPNU0zWgIxAOp1AE47xDqUEpHJWEadIRNyp4iciuRMStuW\n",
    "1KyLa2tJElMzrdfkviT8tQp21KW8EA==\n",
    "-----END CERTIFICATE-----\n",
  );

  #[test]
  fn parse_certificates_accepts_empty_single_and_bundle_and_rejects_invalid_pem() {
    assert!(parse_certificates(None).unwrap().is_empty());
    assert!(parse_certificates(Some("   \n\t  ")).unwrap().is_empty());

    assert_eq!(parse_certificates(Some(TEST_CA_PEM_1)).unwrap().len(), 1);
    let bundle = format!("{TEST_CA_PEM_1}\n{TEST_CA_PEM_2}");
    assert_eq!(parse_certificates(Some(&bundle)).unwrap().len(), 2);

    let trailing_bad = format!(
      "{TEST_CA_PEM_1}\n-----BEGIN CERTIFICATE-----\n!!!not-base64!!!\n-----END CERTIFICATE-----\n"
    );
    for invalid_pem in [
      "not-a-pem",
      "-----BEGIN CERTIFICATE-----\n!!!not-base64!!!\n-----END CERTIFICATE-----\n",
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      "-----BEGIN CERTIFICATE-----\nMIIBtjCCAVugAwIBAgIT\n",
      "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
      trailing_bad.as_str(),
    ] {
      let err = parse_certificates(Some(invalid_pem)).unwrap_err();
      assert_eq!(err.code, "INVALID_ARGUMENT", "unexpected code for {invalid_pem:?}");
      assert!(err.message.contains("CA certificate"), "unexpected message for {invalid_pem:?}: {}", err.message);
    }
  }

  #[test]
  fn cached_http_client_reuses_reqwest_client_and_rejects_invalid_ca() {
    let state = UpdateState::default();
    let center = sample_center("https://center.example", None);

    assert!(cached_http_client(&state, &center, DOWNLOAD_TIMEOUT).is_ok());
    assert_eq!(state.http_clients.lock().unwrap().len(), 1);

    // Same origin/CA/timeout hits the cache without growing it.
    assert!(cached_http_client(&state, &center, DOWNLOAD_TIMEOUT).is_ok());
    assert_eq!(state.http_clients.lock().unwrap().len(), 1);

    // Distinct timeout adds a new pooled client entry.
    assert!(cached_http_client(&state, &center, CHECK_TIMEOUT).is_ok());
    assert_eq!(state.http_clients.lock().unwrap().len(), 2);

    // Valid custom CA PEM (single and whitespace-padded) builds once and reuses the pooled client.
    let single_ca = sample_center("https://center.example", Some(TEST_CA_PEM_1));
    assert!(cached_http_client(&state, &single_ca, DOWNLOAD_TIMEOUT).is_ok());
    assert_eq!(state.http_clients.lock().unwrap().len(), 3);
    let padded_single_ca = sample_center("https://center.example", Some(&format!("\n  {TEST_CA_PEM_1}  \n")));
    assert!(cached_http_client(&state, &padded_single_ca, DOWNLOAD_TIMEOUT).is_ok());
    assert_eq!(state.http_clients.lock().unwrap().len(), 3);

    // Valid multi-cert PEM bundle also builds and caches cleanly.
    let bundle = format!("{TEST_CA_PEM_1}\n{TEST_CA_PEM_2}");
    let bundle_ca = sample_center("https://center.example", Some(&bundle));
    assert!(cached_http_client(&state, &bundle_ca, DOWNLOAD_TIMEOUT).is_ok());
    assert_eq!(state.http_clients.lock().unwrap().len(), 4);

    // Invalid CA PEM fails cleanly and never inserts into or evicts from the cache.
    for bad in [
      "not-a-pem",
      "-----BEGIN CERTIFICATE-----\n!!!bad!!!\n-----END CERTIFICATE-----\n",
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    ] {
      let invalid_ca = sample_center("https://center.example", Some(bad));
      let err = cached_http_client(&state, &invalid_ca, DOWNLOAD_TIMEOUT).unwrap_err();
      assert!(err.contains("CA certificate"), "unexpected error for {bad:?}: {err}");
      assert_eq!(state.http_clients.lock().unwrap().len(), 4);
    }
  }
}
