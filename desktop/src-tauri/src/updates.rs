//! Desktop updates use the connected center's native credentials and a
//! compile-time publisher key; the WebView never supplies an artifact URL.

use std::{
  fs,
  path::PathBuf,
  sync::{Arc, Mutex},
  time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;

use crate::{
  bridge::{self, BridgeError, DesktopBridge},
  ensure_main_webview, host_service,
};

const AUTO_CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
const UPDATER_TIMEOUT: Duration = Duration::from_secs(600);
const PREPARE_TIMEOUT: Duration = Duration::from_secs(60);
const CANCEL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
const CENTER_CREDENTIALS_FILE: &str = "center-credentials.json";

pub(crate) fn configured_pubkey() -> Option<&'static str> {
  option_env!("E_LAUNCHER_UPDATER_PUBLIC_KEY")
    .map(str::trim)
    .filter(|key| !key.is_empty())
}

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

#[derive(Clone, Default)]
pub struct UpdateState {
  inner: Arc<Mutex<UpdateInner>>,
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

fn finish(state: &UpdateState, current: &str, operation: u64, phase: Phase, message: Option<String>) -> Value {
  let mut inner = state.inner.lock().unwrap();
  if inner.operation == operation {
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
  snapshot_locked(&inner, current)
}

struct CenterAuth {
  fence: String,
  origin: String,
  device_id: String,
  device_token: String,
  ca_pem: Option<String>,
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
async fn resolve_center_auth(app: &AppHandle) -> Result<Option<CenterAuth>, BridgeError> {
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
  if !cfg!(target_arch = "x86_64") {
    return Err(invalid("desktop updater supports x86_64 only"));
  }
  if cfg!(windows) {
    Ok(("windows", "x86_64", "nsis"))
  } else if cfg!(target_os = "linux") {
    Ok(("linux", "x86_64", "deb"))
  } else {
    Err(invalid("desktop updater supports Windows and Linux only"))
  }
}

fn center_certificate(center: &CenterAuth) -> Result<Option<reqwest::Certificate>, BridgeError> {
  center.ca_pem.as_ref()
    .map(|pem| reqwest::Certificate::from_pem(pem.as_bytes()))
    .transpose().map_err(|_| invalid("center CA certificate could not be parsed"))
}

fn configure_client(
  client: reqwest::ClientBuilder, origin: String, certificate: Option<reqwest::Certificate>,
) -> reqwest::ClientBuilder {
  let client = match certificate {
    Some(certificate) => client.tls_certs_merge([certificate]),
    None => client,
  };
  client.timeout(UPDATER_TIMEOUT).redirect(reqwest::redirect::Policy::custom(move |attempt| {
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

fn build_updater(app: &AppHandle, center: &CenterAuth) -> Result<tauri_plugin_updater::Updater, BridgeError> {
  let (platform, arch, format) = update_target()?;
  let endpoint = tauri::Url::parse(&format!(
    "{}/api/client-updates/{platform}/{arch}/{format}/{{{{current_version}}}}", center.origin
  )).map_err(|_| invalid("failed to build update endpoint"))?;
  let certificate = center_certificate(center)?;
  let origin = center.origin.clone();
  app.updater_builder()
    .endpoints(vec![endpoint]).map_err(|err| BridgeError::new("UPDATE_ERROR", err.to_string(), "not-sent"))?
    .header("Authorization", format!("Bearer {}", center.device_token))
      .map_err(|err| BridgeError::new("UPDATE_ERROR", err.to_string(), "not-sent"))?
    .header("X-Device-Id", center.device_id.clone())
      .map_err(|err| BridgeError::new("UPDATE_ERROR", err.to_string(), "not-sent"))?
    .timeout(UPDATER_TIMEOUT)
    .restart_after_install(false)
    .configure_client(move |client| configure_client(client, origin.clone(), certificate.clone()))
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
async fn release_prepare(state: &UpdateState) -> Result<(), String> {
  if !state.inner.lock().unwrap().prepared {
    return Ok(());
  }
  host_service::host_cli(vec!["cancel-update".to_string()], CANCEL_TIMEOUT).await
    .map_err(|err| format!("could not release Host update preparation: {}", err.message))?;
  state.inner.lock().unwrap().prepared = false;
  Ok(())
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

async fn finish_stale(state: &UpdateState, current: &str, operation: u64) -> Value {
  match release_prepare(state).await {
    Ok(()) => finish(state, current, operation, Phase::Idle, None),
    Err(message) => finish(state, current, operation, Phase::Error, Some(message)),
  }
}

async fn reconcile_center_state(app: &AppHandle, state: &UpdateState) {
  let (operation, fence) = {
    let inner = state.inner.lock().unwrap();
    (inner.operation, inner.fence.clone())
  };
  let Some(fence) = fence else { return };
  let valid = matches!(resolve_center_auth(app).await, Ok(Some(center)) if center.fence == fence);
  if valid {
    return;
  }
  let cleanup = {
    let mut inner = state.inner.lock().unwrap();
    if inner.operation != operation || inner.fence.as_deref() != Some(fence.as_str()) {
      return;
    }
    inner.invalidated = true;
    clear_update_fields(&mut inner);
    inner.phase = Phase::Idle;
    inner.message = Some("center changed or disconnected; update state was reset".to_string());
    if let Some(tx) = inner.cancel_tx.take() {
      let _ = tx.send(());
    }
    if inner.busy {
      false
    } else {
      inner.busy = true;
      true
    }
  };
  if cleanup {
    let current = app.package_info().version.to_string();
    let _ = finish_stale(state, &current, operation).await;
  }
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
  if configured_pubkey().is_none() {
    return Err(BridgeError::new("UPDATER_UNAVAILABLE", "desktop updater has no E_LAUNCHER_UPDATER_PUBLIC_KEY", "not-sent"));
  }
  reconcile_center_state(&app, &state).await;
  let current = app.package_info().version.to_string();
  let (operation, mut cancel, mut previous) = {
    let mut inner = state.inner.lock().unwrap();
    let previous = inner.phase;
    let (operation, cancel) = begin(&mut inner, Phase::Checking, true)?;
    (operation, cancel.unwrap(), previous)
  };
  let center = match resolve_center_auth(&app).await {
    Ok(Some(center)) => center,
    Ok(None) => {
      {
        let mut inner = state.inner.lock().unwrap();
        inner.invalidated = true;
        clear_update_fields(&mut inner);
      }
      return Ok(finish_stale(&state, &current, operation).await);
    }
    Err(err) => {
      {
        let mut inner = state.inner.lock().unwrap();
        clear_update_fields(&mut inner);
      }
      let cleanup = release_prepare(&state).await;
      return Ok(finish(&state, &current, operation, Phase::Error, Some(cleanup.err().unwrap_or(err.message))));
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
    return Ok(finish_stale(&state, &current, operation).await);
  }
  let mut cancelled = cancel.try_recv().is_ok();
  if replaced || cancelled {
    let cleanup = release_prepare(&state).await;
    if !fence_matches(&app, &state, operation, &center.fence).await {
      return Ok(match cleanup {
        Ok(()) => finish_stale(&state, &current, operation).await,
        Err(message) => finish(&state, &current, operation, Phase::Error, Some(message)),
      });
    }
    if let Err(message) = cleanup {
      return Ok(finish(&state, &current, operation, Phase::Error, Some(message)));
    }
    if !cancelled {
      cancelled = cancel.try_recv().is_ok();
    }
    if cancelled {
      return Ok(finish(&state, &current, operation, Phase::Cancelled, None));
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
        return Ok(finish_stale(&state, &current, operation).await);
      }
      if cancel.try_recv().is_ok() {
        let cleanup = release_prepare(&state).await;
        if !fence_matches(&app, &state, operation, &center.fence).await {
          return Ok(match cleanup {
            Ok(()) => finish_stale(&state, &current, operation).await,
            Err(message) => finish(&state, &current, operation, Phase::Error, Some(message)),
          });
        }
        return Ok(match cleanup {
          Ok(()) => finish(&state, &current, operation, Phase::Cancelled, None),
          Err(message) => finish(&state, &current, operation, Phase::Error, Some(message)),
        });
      }
      return Ok(finish(&state, &current, operation, previous, None));
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
  if !fence_matches(&app, &state, operation, &center.fence).await {
    return Ok(match cleanup {
      Ok(()) => finish_stale(&state, &current, operation).await,
      Err(message) => finish(&state, &current, operation, Phase::Error, Some(message)),
    });
  }
  if let Err(message) = cleanup {
    return Ok(finish(&state, &current, operation, Phase::Error, Some(message)));
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
    return Ok(finish_stale(&state, &current, operation).await);
  }
  match outcome {
    None => Ok(finish(&state, &current, operation, Phase::Cancelled, None)),
    Some(Err(message)) => Ok(finish(&state, &current, operation, Phase::Error, Some(message))),
    Some(Ok(None)) => Ok(finish(&state, &current, operation, Phase::UpToDate, None)),
    Some(Ok(Some(update))) => match validate_release(&update, &center) {
      Err(message) => Ok(finish(&state, &current, operation, Phase::Error, Some(message))),
      Ok((size, _, release)) => {
        {
          let mut inner = state.inner.lock().unwrap();
          if !inner.invalidated {
            inner.update = Some(update);
            inner.release = Some(release);
            inner.total = Some(size);
          }
        }
        Ok(finish(&state, &current, operation, Phase::Available, None))
      }
    },
  }
}

async fn download_bounded(
  center: &CenterAuth, update: &Update, state: &UpdateState, operation: u64, size: u64, sha: &str,
) -> Result<Vec<u8>, String> {
  let certificate = center_certificate(center).map_err(|err| err.message)?;
  let client = configure_client(reqwest::Client::builder(), center.origin.clone(), certificate)
    .build().map_err(|err| err.to_string())?;
  let mut response = client.get(update.download_url.clone()).headers(update.headers.clone())
    .send().await.map_err(|err| err.to_string())?
    .error_for_status().map_err(|err| err.to_string())?;
  if response.content_length().is_some_and(|length| length != size) {
    return Err("update package size does not match the center metadata".to_string());
  }
  let mut bytes = Vec::new();
  while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
    if (bytes.len() as u64).saturating_add(chunk.len() as u64) > size {
      return Err("update package exceeds its declared size".to_string());
    }
    bytes.extend_from_slice(&chunk);
    let mut inner = state.inner.lock().unwrap();
    if inner.operation == operation && !inner.invalidated {
      inner.downloaded = bytes.len() as u64;
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
  reconcile_center_state(&app, &state).await;
  let current = app.package_info().version.to_string();
  let (operation, mut cancel, update, fence) = {
    let mut inner = state.inner.lock().unwrap();
    if inner.busy { return Err(busy()); }
    if inner.bytes.is_some() { return Ok(snapshot_locked(&inner, &current)); }
    let update = inner.update.clone().ok_or_else(|| invalid("no update is available to download"))?;
    let fence = inner.fence.clone().ok_or_else(|| invalid("update center is unavailable"))?;
    let (operation, cancel) = begin(&mut inner, Phase::Downloading, true)?;
    inner.downloaded = 0;
    (operation, cancel.unwrap(), update, fence)
  };
  let center = match resolve_center_auth(&app).await {
    Ok(Some(center)) if center.fence == fence => center,
    _ => {
      state.inner.lock().unwrap().invalidated = true;
      return Ok(finish_stale(&state, &current, operation).await);
    }
  };
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&state, &current, operation).await);
  }
  let (size, sha, _) = match validate_release(&update, &center) {
    Ok(metadata) => metadata,
    Err(message) => return Ok(finish(&state, &current, operation, Phase::Error, Some(message))),
  };
  let outcome = tokio::select! {
    biased;
    _ = &mut cancel => None,
    result = download_bounded(&center, &update, &state, operation, size, &sha) => Some(result),
  };
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&state, &current, operation).await);
  }
  match outcome {
    None => Ok(finish(&state, &current, operation, Phase::Cancelled, None)),
    Some(Err(message)) => Ok(finish(&state, &current, operation, Phase::Error, Some(message))),
    Some(Ok(bytes)) => {
      {
        let mut inner = state.inner.lock().unwrap();
        if !inner.invalidated {
          inner.downloaded = bytes.len() as u64;
          inner.bytes = Some(Arc::new(bytes));
        }
      }
      Ok(finish(&state, &current, operation, Phase::Downloaded, None))
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
  let (operation, update, bytes, fence) = {
    let mut inner = state.inner.lock().unwrap();
    if inner.busy { return Err(busy()); }
    let update = inner.update.clone().ok_or_else(|| invalid("no downloaded update is ready"))?;
    let bytes = inner.bytes.clone().ok_or_else(|| invalid("no downloaded update is ready"))?;
    let fence = inner.fence.clone().ok_or_else(|| invalid("update center is unavailable"))?;
    let (operation, _) = begin(&mut inner, Phase::Installing, false)?;
    (operation, update, bytes, fence)
  };
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&state, &current, operation).await);
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
    return Ok(finish_stale(&state, &current, operation).await);
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
    return Ok(finish_stale(&state, &current, operation).await);
  }
  match prepared {
    Ok(value) if value.get("ready").and_then(Value::as_bool) == Some(false)
      && value.get("activeCount").and_then(Value::as_u64).is_some() => {
      let active = value.get("activeCount").and_then(Value::as_u64).unwrap();
      return Ok(finish(&state, &current, operation, Phase::WaitingTasks, Some(format!("{active} host task(s) still active"))));
    }
    Ok(value) if value.get("ready").and_then(Value::as_bool) == Some(true)
      && value.get("activeCount").and_then(Value::as_u64).is_some() => {}
    result => {
      let message = match result {
        Err(err) => err.message,
        _ => "launcher returned an invalid update preparation result".to_string(),
      };
      let cleanup = release_prepare(&state).await;
      if !fence_matches(&app, &state, operation, &fence).await {
        return Ok(match cleanup {
          Ok(()) => finish_stale(&state, &current, operation).await,
          Err(message) => finish(&state, &current, operation, Phase::Error, Some(message)),
        });
      }
      let message = cleanup.err().unwrap_or(message);
      return Ok(finish(&state, &current, operation, Phase::Error, Some(message)));
    }
  }
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&state, &current, operation).await);
  }
  let result = tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice())).await;
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(finish_stale(&state, &current, operation).await);
  }
  let cleanup = release_prepare(&state).await;
  if !fence_matches(&app, &state, operation, &fence).await {
    return Ok(match cleanup {
      Ok(()) => finish_stale(&state, &current, operation).await,
      Err(message) => finish(&state, &current, operation, Phase::Error, Some(message)),
    });
  }
  match (result, cleanup) {
    (_, Err(message)) => Ok(finish(&state, &current, operation, Phase::Error, Some(message))),
    (Ok(Ok(())), Ok(())) => {
      {
        let mut inner = state.inner.lock().unwrap();
        if !inner.invalidated {
          clear_update_fields(&mut inner);
          inner.fence = Some(fence.clone());
        }
      }
      Ok(finish(&state, &current, operation, Phase::Complete, Some(
        "update installed; restart the app to run the new version".to_string(),
      )))
    }
    (Ok(Err(err)), Ok(())) => Ok(finish(&state, &current, operation, Phase::Error, Some(err.to_string()))),
    (Err(err), Ok(())) => Ok(finish(&state, &current, operation, Phase::Error, Some(format!("install worker failed: {err}")))),
  }
}

#[tauri::command]
pub async fn desktop_update_cancel(app: AppHandle, webview: Webview, state: State<'_, UpdateState>) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  reconcile_center_state(&app, &state).await;
  let current = app.package_info().version.to_string();
  let (operation, fence) = {
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
    (operation, fence)
  };
  let cleanup = release_prepare(&state).await;
  if let Some(fence) = &fence {
    if !fence_matches(&app, &state, operation, fence).await {
      return Ok(match cleanup {
        Ok(()) => finish_stale(&state, &current, operation).await,
        Err(message) => finish(&state, &current, operation, Phase::Error, Some(message)),
      });
    }
  }
  match cleanup {
    Err(message) => Ok(finish(&state, &current, operation, Phase::Error, Some(message))),
    Ok(()) => {
      {
        let mut inner = state.inner.lock().unwrap();
        if !inner.invalidated {
          clear_update_fields(&mut inner);
          inner.fence = fence;
        }
      }
      Ok(finish(&state, &current, operation, Phase::Cancelled, None))
    }
  }
}
