//! Native desktop clipboard sync runtime (Windows/Linux; unsupported stub on macOS).
//!
//! Coordinates broker-generation-fenced Center auth, binding-scoped protected local
//! persistence (DPAPI on Windows, atomic 0600 file on Linux), OS clipboard adapters,
//! native WSS relay client, conflated bounded incoming writes, and an opt-in tray
//! menu while clipboard sync is actively enabled and a tray host is available.

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State, Webview};

use crate::{bridge::BridgeError, ensure_main_webview};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipboardMode {
  Automatic,
  #[allow(dead_code)]
  Manual,
  Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
  Off,
  NotPaired,
  Connecting,
  Online,
  Offline,
  Unauthorized,
  Unsupported,
  CertificateError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSyncStatus {
  pub enabled: bool,
  pub configured: bool,
  pub mode: ClipboardMode,
  pub connection: ConnectionState,
}

/// Reply returned by `desktop_clipboard_sync`.
/// Deliberately omits `Debug` because `code` carries a shared group secret.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSyncReply {
  pub status: ClipboardSyncStatus,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub code: Option<String>,
}

/// Validated native clipboard sync action.
/// Deliberately omits `Debug` because `JoinGroup` carries a shared group secret.
enum ClipboardAction {
  Status,
  SetEnabled(bool),
  NewGroup,
  JoinGroup(String),
  ShowCode,
}

fn invalid_request(message: &'static str) -> BridgeError {
  BridgeError::new("INVALID_ARGUMENT", message, "not-sent")
}

fn parse_request(request: &Value) -> Result<ClipboardAction, BridgeError> {
  let Some(map) = request.as_object() else {
    return Err(invalid_request("clipboard sync request must be a JSON object"));
  };
  let Some(action) = map.get("action").and_then(Value::as_str) else {
    return Err(invalid_request("clipboard sync action is required"));
  };
  match action {
    "status" => {
      if map.len() != 1 {
        return Err(invalid_request("unexpected fields in clipboard status request"));
      }
      Ok(ClipboardAction::Status)
    }
    "setEnabled" => {
      if map.len() != 2 {
        return Err(invalid_request("unexpected fields in clipboard setEnabled request"));
      }
      let Some(enabled) = map.get("enabled").and_then(Value::as_bool) else {
        return Err(invalid_request("enabled must be a boolean"));
      };
      Ok(ClipboardAction::SetEnabled(enabled))
    }
    "newGroup" => {
      if map.len() != 1 {
        return Err(invalid_request("unexpected fields in clipboard newGroup request"));
      }
      Ok(ClipboardAction::NewGroup)
    }
    "joinGroup" => {
      if map.len() != 2 {
        return Err(invalid_request("unexpected fields in clipboard joinGroup request"));
      }
      let Some(code) = map.get("code").and_then(Value::as_str) else {
        return Err(invalid_request("code must be a string"));
      };
      Ok(ClipboardAction::JoinGroup(code.to_string()))
    }
    "showCode" => {
      if map.len() != 1 {
        return Err(invalid_request("unexpected fields in clipboard showCode request"));
      }
      Ok(ClipboardAction::ShowCode)
    }
    _ => Err(invalid_request("unsupported clipboard sync action")),
  }
}

#[tauri::command]
pub async fn desktop_clipboard_sync(
  app: AppHandle,
  webview: Webview,
  runtime: State<'_, ClipboardRuntime>,
  request: Value,
) -> Result<ClipboardSyncReply, BridgeError> {
  ensure_main_webview(&webview)?;
  let action = parse_request(&request)?;
  runtime.handle_action(&app, action).await
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
  use serde_json::Value;
  use tauri::AppHandle;

  use super::{
    ClipboardAction, ClipboardMode, ClipboardSyncReply, ClipboardSyncStatus, ConnectionState,
  };
  use crate::bridge::BridgeError;

  #[derive(Default)]
  pub struct ClipboardRuntime;

  impl ClipboardRuntime {
    pub fn new() -> Self {
      Self
    }

    pub fn before_broker_request(&self, _app: &AppHandle, _op: &str) {}

    pub fn after_broker_request(&self, _app: &AppHandle, _op: &str, _response: Option<&Value>) {}

    pub fn on_center_credentials_changing(&self, _app: &AppHandle) {}

    pub fn shutdown(&self, _app: &AppHandle) {}

    pub(super) async fn handle_action(
      &self,
      _app: &AppHandle,
      action: ClipboardAction,
    ) -> Result<ClipboardSyncReply, BridgeError> {
      let status = ClipboardSyncStatus {
        enabled: false,
        configured: false,
        mode: ClipboardMode::Unsupported,
        connection: ConnectionState::Unsupported,
      };
      match action {
        ClipboardAction::Status | ClipboardAction::SetEnabled(false) => {
          Ok(ClipboardSyncReply { status, code: None })
        }
        ClipboardAction::SetEnabled(true)
        | ClipboardAction::NewGroup
        | ClipboardAction::JoinGroup(_)
        | ClipboardAction::ShowCode => Err(BridgeError::new(
          "UNSUPPORTED",
          "clipboard sync is not supported on this platform",
          "not-sent",
        )),
      }
    }
  }
}

#[cfg(any(windows, target_os = "linux"))]
mod imp {
  use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
      Arc, Mutex,
      atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
  };

  #[cfg(target_os = "linux")]
  use std::sync::OnceLock;

  #[cfg(windows)]
  use base64::{Engine as _, engine::general_purpose::STANDARD};

  use clipboard_sync::{GroupKey, eligible_text};
  use clipboard_sync_relay_client::{IncomingClip, Link, LinkConfig, LinkStartError, LinkStatus};
  use serde::{Deserialize, Serialize};
  use serde_json::Value;
  use sha2::{Digest, Sha256};
  use tauri::{
    AppHandle, Manager,
    menu::{MenuBuilder, MenuEvent},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  };
  use tokio::sync::Notify;

  use super::{
    ClipboardAction, ClipboardMode, ClipboardSyncReply, ClipboardSyncStatus, ConnectionState,
  };
  use crate::{
    bridge::{self, BridgeError},
    updates::{self, CenterAuth},
  };

  #[cfg(target_os = "linux")]
  use crate::clipboard_linux::SystemClipboard;
  #[cfg(windows)]
  use crate::clipboard_windows::SystemClipboard;

  const CENTER_CREDENTIALS_FILE: &str = "center-credentials.json";
  #[cfg(windows)]
  const STATE_FILE_NAME: &str = "clipboard-sync-state.v1.dpapi";
  #[cfg(target_os = "linux")]
  const STATE_FILE_NAME: &str = "clipboard-sync-state.v1.json";

  const STATE_SCHEMA_VERSION: u32 = 1;
  #[cfg(windows)]
  const DPAPI_ENVELOPE_VERSION: u32 = 1;
  #[cfg(windows)]
  const DPAPI_ENTROPY: &[u8] = b"pibot-clipboard-sync-state-v1";

  const MAX_CREDENTIALS_FILE_BYTES: u64 = 128 * 1024;
  const MAX_STATE_FILE_BYTES: u64 = 64 * 1024;
  const WRITE_AUTH_VERIFY_TIMEOUT: Duration = Duration::from_secs(2);
  const MAX_CONSECUTIVE_PUBLISH_DROPS: u32 = 3;

  const TRAY_ID: &str = "pibot-clipboard-tray";
  const TRAY_MENU_OPEN_ID: &str = "clipboard_tray_open";
  const TRAY_MENU_QUIT_ID: &str = "clipboard_tray_quit";

  static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(1);

  #[cfg(target_os = "linux")]
  static LINUX_CLIPBOARD_SUPPORTED: OnceLock<bool> = OnceLock::new();

  fn storage_error(message: &'static str) -> BridgeError {
    BridgeError::new("STORAGE_ERROR", message, "not-sent")
  }

  fn unsupported_status() -> ClipboardSyncStatus {
    ClipboardSyncStatus {
      enabled: false,
      configured: false,
      mode: ClipboardMode::Unsupported,
      connection: ConnectionState::Unsupported,
    }
  }

  fn zeroize_bytes(buf: &mut [u8]) {
    for byte in buf.iter_mut() {
      // SAFETY: `byte` is a valid, aligned, writable pointer to a `u8` in `buf`.
      unsafe {
        std::ptr::write_volatile(byte, 0);
      }
    }
    std::sync::atomic::compiler_fence(Ordering::SeqCst);
  }

  fn encode_lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
      out.push(HEX[(b >> 4) as usize] as char);
      out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
  }

  fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
      return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
      diff |= x ^ y;
    }
    diff == 0
  }

  /// Binding scoping local clipboard sync toggle and group code to the active
  /// Center origin, device ID, device token, and CA PEM fingerprint.
  /// Deliberately omits `Debug` and never stores the raw device token.
  #[derive(Clone, PartialEq, Eq)]
  struct CredentialBinding {
    origin: String,
    device_id: String,
    credential_fingerprint: String,
  }

  impl CredentialBinding {
    fn create(
      origin: &str,
      device_id: &str,
      device_token: &str,
      ca_pem: Option<&str>,
    ) -> Option<Self> {
      let origin = origin.trim();
      let device_id = device_id.trim();
      let device_token = device_token.trim();
      let ca = ca_pem.map(str::trim).unwrap_or("");
      if origin.is_empty() || device_id.is_empty() || device_token.is_empty() {
        return None;
      }
      let mut hasher = Sha256::new();
      hasher.update(origin.as_bytes());
      hasher.update([0u8]);
      hasher.update(device_id.as_bytes());
      hasher.update([0u8]);
      hasher.update(device_token.as_bytes());
      hasher.update([0u8]);
      hasher.update(ca.as_bytes());
      let digest = hasher.finalize();
      Some(Self {
        origin: origin.to_string(),
        device_id: device_id.to_string(),
        credential_fingerprint: encode_lower_hex(&digest),
      })
    }

    fn from_center_auth(auth: &CenterAuth) -> Option<Self> {
      Self::create(
        &auth.origin,
        &auth.device_id,
        &auth.device_token,
        auth.ca_pem.as_deref(),
      )
    }

    fn matches(&self, origin: &str, device_id: &str, fingerprint: &str) -> bool {
      self.origin == origin
        && self.device_id == device_id
        && constant_time_eq(
          self.credential_fingerprint.as_bytes(),
          fingerprint.as_bytes(),
        )
    }
  }

  /// Persisted local state for a single credential binding.
  /// Deliberately omits `Debug` because `group_code` is a secret.
  #[derive(Clone)]
  struct PersistedState {
    enabled: bool,
    group_code: Option<String>,
  }

  impl PersistedState {
    fn empty() -> Self {
      Self {
        enabled: false,
        group_code: None,
      }
    }

    fn is_configured(&self) -> bool {
      self.group_code.as_deref().is_some_and(|c| !c.is_empty())
    }
  }

  #[derive(Serialize, Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct PersistedRecord {
    version: u32,
    origin: String,
    device_id: String,
    credential_fingerprint: String,
    enabled: bool,
    group_code: Option<String>,
  }

  #[cfg(windows)]
  #[derive(Serialize, Deserialize)]
  struct DpapiEnvelope {
    v: u32,
    dpapi: String,
  }

  #[derive(Clone, Copy, PartialEq, Eq)]
  enum ObservedLifecycle {
    /// No broker lifecycle response has been observed yet in this process.
    Unknown,
    /// Explicitly observed disconnect, re-pair, or credential switch.
    Disconnected { cleared: bool },
    /// Explicitly observed connecting state.
    Connecting,
    /// Explicitly observed non-ready Center error state.
    Blocked(ConnectionState),
    /// Explicitly observed connected relay + ready Center state.
    Ready,
  }

  /// Metadata for the currently running clipboard sync session.
  /// Deliberately omits `Debug` because `group_code` is a secret.
  struct ActiveSessionMeta {
    fence: String,
    binding_fingerprint: String,
    group_code: String,
    device_id: String,
    transport_generation: Option<u64>,
  }

  /// Pending decrypted incoming text waiting for the bounded writer coordinator.
  /// Deliberately omits `Debug` because `text` is clipboard plaintext.
  struct PendingIncomingWrite {
    epoch: u64,
    fence: String,
    binding_fingerprint: String,
    link_generation: u64,
    text: String,
  }

  struct IncomingSlot {
    pending: Mutex<Option<PendingIncomingWrite>>,
    notify: Notify,
    alive: AtomicBool,
    spawned: AtomicBool,
  }

  impl IncomingSlot {
    fn new() -> Self {
      Self {
        pending: Mutex::new(None),
        notify: Notify::new(),
        alive: AtomicBool::new(false),
        spawned: AtomicBool::new(false),
      }
    }

    fn clear(&self) {
      let mut slot = self.pending.lock().unwrap_or_else(|e| e.into_inner());
      *slot = None;
    }

    fn put_conflated(&self, item: PendingIncomingWrite) {
      {
        let mut slot = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(item);
      }
      self.notify.notify_one();
    }
  }

  struct RuntimeInner {
    epoch: u64,
    shutting_down: bool,
    allow_exit: bool,
    lifecycle: ObservedLifecycle,
    active: Option<ActiveSessionMeta>,
    active_link: Option<Arc<Link>>,
    active_clipboard: Option<Arc<SystemClipboard>>,
    os_clipboard_healthy: bool,
    os_unsupported: bool,
    outbound_drop_streak: u32,
    outbound_drop_gen: u64,
    outbound_backpressured_gen: Option<u64>,
    cached_persisted: Option<(String, PersistedState)>,
    should_keep_tray: bool,
    tray_active: bool,
    reconcile_queued: bool,
  }

  impl RuntimeInner {
    fn new() -> Self {
      Self {
        epoch: 0,
        shutting_down: false,
        allow_exit: false,
        lifecycle: ObservedLifecycle::Unknown,
        active: None,
        active_link: None,
        active_clipboard: None,
        os_clipboard_healthy: false,
        os_unsupported: false,
        outbound_drop_streak: 0,
        outbound_drop_gen: 0,
        outbound_backpressured_gen: None,
        cached_persisted: None,
        should_keep_tray: false,
        tray_active: false,
        reconcile_queued: false,
      }
    }
  }

  struct RuntimeCore {
    inner: Arc<Mutex<RuntimeInner>>,
    incoming: Arc<IncomingSlot>,
    native_write: Mutex<()>,
    control_lock: tokio::sync::Mutex<()>,
  }

  pub struct ClipboardRuntime {
    core: Arc<RuntimeCore>,
  }

  impl Default for ClipboardRuntime {
    fn default() -> Self {
      Self::new()
    }
  }

  impl ClipboardRuntime {
    pub fn new() -> Self {
      Self {
        core: Arc::new(RuntimeCore {
          inner: Arc::new(Mutex::new(RuntimeInner::new())),
          incoming: Arc::new(IncomingSlot::new()),
          native_write: Mutex::new(()),
          control_lock: tokio::sync::Mutex::new(()),
        }),
      }
    }

    /// Returns `true` only when clipboard sync is actively enabled, a real tray icon
    /// is live so the user can reopen or quit PiBot, and no exit is in progress.
    pub fn can_close_to_tray(&self, app: &AppHandle) -> bool {
      let guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down
        || guard.allow_exit
        || !guard.should_keep_tray
        || !guard.tray_active
        || guard.os_unsupported
      {
        return false;
      }
      drop(guard);
      app.tray_by_id(TRAY_ID).is_some()
    }

    /// Handles the single global tray menu listener registered on `tauri::Builder`.
    pub fn handle_tray_menu_event(&self, app: &AppHandle, event: MenuEvent) {
      match event.id().as_ref() {
        TRAY_MENU_OPEN_ID => show_main_window(app),
        TRAY_MENU_QUIT_ID => {
          self.begin_explicit_quit(app);
          app.exit(0);
        }
        _ => {}
      }
    }

    /// Synchronously fences any running link, listener, or pending incoming write
    /// before a credential-changing or disconnect broker operation runs.
    pub fn before_broker_request(&self, app: &AppHandle, op: &str) {
      match op {
        "center_disconnect" => {
          let (link, clip) =
            detach_active_locked(&self.core, Some(ObservedLifecycle::Disconnected { cleared: true }), true, true);
          drop_detached_async(link, clip);
          remove_tray_on_main_thread(app, true);
        }
        "disconnect" | "center_store" => {
          let (link, clip) =
            detach_active_locked(&self.core, Some(ObservedLifecycle::Disconnected { cleared: false }), true, true);
          drop_detached_async(link, clip);
          remove_tray_on_main_thread(app, true);
        }
        "center_connect" | "connect" => {
          let (link, clip) =
            detach_active_locked(&self.core, Some(ObservedLifecycle::Connecting), true, false);
          drop_detached_async(link, clip);
        }
        _ => {}
      }
    }

    /// Passively observes broker lifecycle results without issuing extra broker RPCs.
    pub fn after_broker_request(&self, app: &AppHandle, op: &str, response: Option<&Value>) {
      match op {
        "center_disconnect" => {
          {
            let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.cached_persisted = None;
            guard.lifecycle = ObservedLifecycle::Disconnected { cleared: true };
          }
          if let Ok(root) = bridge::resolve_client_data_root(app) {
            let path = PathBuf::from(root).join(STATE_FILE_NAME);
            tauri::async_runtime::spawn_blocking(move || {
              let _ = fs::remove_file(path);
            });
          }
        }
        "disconnect" | "center_store" => {
          let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
          guard.cached_persisted = None;
          guard.lifecycle = ObservedLifecycle::Disconnected { cleared: false };
        }
        "center_connect" => {
          match response.and_then(|v| v.get("state").and_then(Value::as_str)) {
            Some("ready") => {
              {
                let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
                guard.cached_persisted = None;
                guard.lifecycle = ObservedLifecycle::Ready;
              }
              schedule_reconcile_if_enabled(Arc::clone(&self.core), app.clone());
            }
            Some("connecting") => {
              let (link, clip) =
                detach_active_locked(&self.core, Some(ObservedLifecycle::Connecting), true, false);
              drop_detached_async(link, clip);
            }
            Some("error") => {
              let code = response.and_then(|v| v.pointer("/error/code").and_then(Value::as_str));
              let (link, clip) = detach_active_locked(
                &self.core,
                Some(ObservedLifecycle::Blocked(map_broker_error_code(code))),
                true,
                false,
              );
              drop_detached_async(link, clip);
            }
            _ => {
              let (link, clip) = detach_active_locked(
                &self.core,
                Some(ObservedLifecycle::Disconnected { cleared: false }),
                true,
                true,
              );
              drop_detached_async(link, clip);
              remove_tray_on_main_thread(app, true);
            }
          }
        }
        "connect" => {
          if let Some(val) = response {
            if is_relay_connected(val) {
              {
                let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
                guard.lifecycle = ObservedLifecycle::Ready;
              }
              schedule_reconcile_if_enabled(Arc::clone(&self.core), app.clone());
            } else if val.get("phase").and_then(Value::as_str) == Some("connecting") {
              let (link, clip) =
                detach_active_locked(&self.core, Some(ObservedLifecycle::Connecting), false, false);
              drop_detached_async(link, clip);
            } else {
              let (link, clip) = detach_active_locked(
                &self.core,
                Some(ObservedLifecycle::Disconnected { cleared: false }),
                false,
                true,
              );
              drop_detached_async(link, clip);
              remove_tray_on_main_thread(app, true);
            }
          } else {
            let (link, clip) = detach_active_locked(
              &self.core,
              Some(ObservedLifecycle::Disconnected { cleared: false }),
              false,
              true,
            );
            drop_detached_async(link, clip);
            remove_tray_on_main_thread(app, true);
          }
        }
        "center_status" => {
          let Some(val) = response else { return };
          match val.get("state").and_then(Value::as_str) {
            Some("ready") => {
              let should_reconcile = {
                let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
                let prev_ready = matches!(guard.lifecycle, ObservedLifecycle::Ready);
                guard.lifecycle = ObservedLifecycle::Ready;
                !prev_ready || guard.active.is_none()
              };
              if should_reconcile {
                schedule_reconcile_if_enabled(Arc::clone(&self.core), app.clone());
              }
            }
            Some("connecting") => {
              let (link, clip) =
                detach_active_locked(&self.core, Some(ObservedLifecycle::Connecting), false, false);
              drop_detached_async(link, clip);
            }
            Some("disconnected") => {
              let (link, clip) = detach_active_locked(
                &self.core,
                Some(ObservedLifecycle::Disconnected { cleared: false }),
                true,
                true,
              );
              drop_detached_async(link, clip);
              remove_tray_on_main_thread(app, true);
            }
            Some("error") => {
              let code = val.pointer("/error/code").and_then(Value::as_str);
              let (link, clip) = detach_active_locked(
                &self.core,
                Some(ObservedLifecycle::Blocked(map_broker_error_code(code))),
                false,
                false,
              );
              drop_detached_async(link, clip);
            }
            _ => {}
          }
        }
        "status" => {
          let Some(val) = response else { return };
          if is_relay_connected(val) {
            let reported_gen = val.get("generation").and_then(Value::as_u64);
            let reported_dev = val.pointer("/connection/deviceId").and_then(Value::as_str);
            let (detached, needs_reconcile) = {
              let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
              let generation_changed = guard.active.as_ref().is_some_and(|meta| {
                meta.transport_generation != reported_gen
                  || reported_dev.is_some_and(|dev| meta.device_id != dev)
              });
              let detached = if generation_changed {
                guard.epoch = guard.epoch.saturating_add(1);
                guard.active = None;
                guard.os_clipboard_healthy = false;
                guard.outbound_drop_streak = 0;
                guard.outbound_drop_gen = 0;
                guard.outbound_backpressured_gen = None;
                (guard.active_link.take(), guard.active_clipboard.take())
              } else {
                (None, None)
              };
              let prev_ready = matches!(guard.lifecycle, ObservedLifecycle::Ready);
              guard.lifecycle = ObservedLifecycle::Ready;
              let needs = generation_changed || !prev_ready || guard.active.is_none();
              (detached, needs)
            };
            if detached.0.is_some() || detached.1.is_some() {
              self.core.incoming.clear();
              drop_detached_async(detached.0, detached.1);
            }
            if needs_reconcile {
              schedule_reconcile_if_enabled(Arc::clone(&self.core), app.clone());
            }
          } else if val.get("phase").and_then(Value::as_str) == Some("connecting") {
            let (link, clip) =
              detach_active_locked(&self.core, Some(ObservedLifecycle::Connecting), false, false);
            drop_detached_async(link, clip);
          } else {
            let (link, clip) = detach_active_locked(
              &self.core,
              Some(ObservedLifecycle::Disconnected { cleared: false }),
              false,
              true,
            );
            drop_detached_async(link, clip);
            remove_tray_on_main_thread(app, true);
          }
        }
        _ => {}
      }
    }

    /// Called by `host_service` before persisting newly paired/adopted credentials.
    pub fn on_center_credentials_changing(&self, app: &AppHandle) {
      let (link, clip) = detach_active_locked(
        &self.core,
        Some(ObservedLifecycle::Disconnected { cleared: false }),
        true,
        true,
      );
      drop_detached_async(link, clip);
      remove_tray_on_main_thread(app, true);
    }

    /// Called from `RunEvent::Exit` on the main thread during application teardown.
    pub fn shutdown(&self, app: &AppHandle) {
      let (link, clip) = {
        let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.shutting_down = true;
        guard.allow_exit = true;
        guard.should_keep_tray = false;
        guard.tray_active = false;
        guard.epoch = guard.epoch.saturating_add(1);
        guard.active = None;
        guard.os_clipboard_healthy = false;
        guard.outbound_drop_streak = 0;
        guard.outbound_drop_gen = 0;
        guard.outbound_backpressured_gen = None;
        (guard.active_link.take(), guard.active_clipboard.take())
      };
      self.core.incoming.clear();
      // `RunEvent::Exit` runs on the main thread after the event loop has exited.
      let removed = app.remove_tray_by_id(TRAY_ID);
      drop(removed);
      drop(link);
      drop(clip);
    }

    fn begin_explicit_quit(&self, app: &AppHandle) {
      let (link, clip) = {
        let mut guard = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.shutting_down = true;
        guard.allow_exit = true;
        guard.should_keep_tray = false;
        guard.tray_active = false;
        guard.epoch = guard.epoch.saturating_add(1);
        guard.active = None;
        guard.os_clipboard_healthy = false;
        guard.outbound_drop_streak = 0;
        guard.outbound_drop_gen = 0;
        guard.outbound_backpressured_gen = None;
        (guard.active_link.take(), guard.active_clipboard.take())
      };
      self.core.incoming.clear();
      drop_detached_async(link, clip);
      remove_tray_on_main_thread(app, false);
    }

    pub(super) async fn handle_action(
      &self,
      app: &AppHandle,
      action: ClipboardAction,
    ) -> Result<ClipboardSyncReply, BridgeError> {
      match action {
        ClipboardAction::Status => self.action_status(app).await,
        ClipboardAction::SetEnabled(enabled) => self.action_set_enabled(app, enabled).await,
        ClipboardAction::NewGroup => self.action_new_group(app).await,
        ClipboardAction::JoinGroup(code) => self.action_join_group(app, code).await,
        ClipboardAction::ShowCode => self.action_show_code(app).await,
      }
    }

    async fn action_status(&self, app: &AppHandle) -> Result<ClipboardSyncReply, BridgeError> {
      let _guard = self.core.control_lock.lock().await;
      if !is_platform_supported(&self.core).await {
        stop_active_on_control(&self.core, app, true).await;
        return Ok(ClipboardSyncReply {
          status: unsupported_status(),
          code: None,
        });
      }

      let (shutting_down, lifecycle) = {
        let inner = self.core.inner.lock().unwrap_or_else(|e| e.into_inner());
        (inner.shutting_down, inner.lifecycle)
      };
      if shutting_down {
        stop_active_on_control(&self.core, app, false).await;
        return Ok(ClipboardSyncReply {
          status: ClipboardSyncStatus {
            enabled: false,
            configured: false,
            mode: ClipboardMode::Automatic,
            connection: ConnectionState::Off,
          },
          code: None,
        });
      }

      // Explicit center_disconnect has priority without touching broker or stored credentials.
      if matches!(lifecycle, ObservedLifecycle::Disconnected { cleared: true }) {
        stop_active_on_control(&self.core, app, true).await;
        return Ok(ClipboardSyncReply {
          status: ClipboardSyncStatus {
            enabled: false,
            configured: false,
            mode: ClipboardMode::Automatic,
            connection: ConnectionState::NotPaired,
          },
          code: None,
        });
      }

      // Local-only binding check avoids starting the broker just to show notPaired/off state.
      let Some(disk_binding) = peek_disk_binding_async(app).await? else {
        stop_active_on_control(&self.core, app, true).await;
        return Ok(ClipboardSyncReply {
          status: ClipboardSyncStatus {
            enabled: false,
            configured: false,
            mode: ClipboardMode::Automatic,
            connection: ConnectionState::NotPaired,
          },
          code: None,
        });
      };

      let persisted = read_persisted_cached_or_disk(&self.core, app, &disk_binding).await?;
      let configured = persisted.is_configured();

      // Switch off or unconfigured: never start broker, relay link, OS listener, or tray.
      if !persisted.enabled || !configured {
        stop_active_on_control(&self.core, app, true).await;
        return Ok(ClipboardSyncReply {
          status: ClipboardSyncStatus {
            enabled: persisted.enabled,
            configured,
            mode: ClipboardMode::Automatic,
            connection: ConnectionState::Off,
          },
          code: None,
        });
      }

      // Enabled + configured: existing explicit non-ready lifecycle state has priority.
      match lifecycle {
        ObservedLifecycle::Disconnected { .. } => {
          stop_active_on_control(&self.core, app, true).await;
          return Ok(ClipboardSyncReply {
            status: ClipboardSyncStatus {
              enabled: true,
              configured: true,
              mode: ClipboardMode::Automatic,
              connection: ConnectionState::Offline,
            },
            code: None,
          });
        }
        ObservedLifecycle::Connecting => {
          stop_active_on_control(&self.core, app, false).await;
          return Ok(ClipboardSyncReply {
            status: ClipboardSyncStatus {
              enabled: true,
              configured: true,
              mode: ClipboardMode::Automatic,
              connection: ConnectionState::Connecting,
            },
            code: None,
          });
        }
        ObservedLifecycle::Blocked(conn) => {
          stop_active_on_control(&self.core, app, false).await;
          return Ok(ClipboardSyncReply {
            status: ClipboardSyncStatus {
              enabled: true,
              configured: true,
              mode: ClipboardMode::Automatic,
              connection: conn,
            },
            code: None,
          });
        }
        ObservedLifecycle::Ready | ObservedLifecycle::Unknown => {}
      }

      let status = reconcile_enabled_on_control(&self.core, app).await?;
      Ok(ClipboardSyncReply { status, code: None })
    }

    async fn action_set_enabled(
      &self,
      app: &AppHandle,
      enabled: bool,
    ) -> Result<ClipboardSyncReply, BridgeError> {
      // Immediately fence callbacks, incoming writes, listener, and tray when turning off.
      if !enabled {
        let (link, clip) = detach_active_locked(&self.core, None, false, true);
        drop_detached_async(link, clip);
        remove_tray_on_main_thread(app, true);
      }

      let _guard = self.core.control_lock.lock().await;
      if !is_platform_supported(&self.core).await {
        stop_active_on_control(&self.core, app, true).await;
        if !enabled {
          return Ok(ClipboardSyncReply {
            status: unsupported_status(),
            code: None,
          });
        }
        return Err(BridgeError::new(
          "UNSUPPORTED",
          "clipboard sync is not supported on this platform",
          "not-sent",
        ));
      }

      if !enabled {
        stop_active_on_control(&self.core, app, true).await;
        let lifecycle = self.core.inner.lock().unwrap_or_else(|e| e.into_inner()).lifecycle;
        if matches!(lifecycle, ObservedLifecycle::Disconnected { cleared: true }) {
          return Ok(ClipboardSyncReply {
            status: ClipboardSyncStatus {
              enabled: false,
              configured: false,
              mode: ClipboardMode::Automatic,
              connection: ConnectionState::NotPaired,
            },
            code: None,
          });
        }
        let Some(binding) = peek_disk_binding_async(app).await? else {
          return Ok(ClipboardSyncReply {
            status: ClipboardSyncStatus {
              enabled: false,
              configured: false,
              mode: ClipboardMode::Automatic,
              connection: ConnectionState::NotPaired,
            },
            code: None,
          });
        };
        let existing = match read_persisted_from_disk_async(app, &binding).await {
          Ok(state) => state,
          Err(_) => PersistedState::empty(),
        };
        let updated = PersistedState {
          enabled: false,
          group_code: existing.group_code,
        };
        save_persisted_async(&self.core, app, &binding, &updated).await?;
        return Ok(ClipboardSyncReply {
          status: ClipboardSyncStatus {
            enabled: false,
            configured: updated.is_configured(),
            mode: ClipboardMode::Automatic,
            connection: ConnectionState::Off,
          },
          code: None,
        });
      }

      let Some((auth, binding)) = resolve_verified_auth(&self.core, app).await? else {
        stop_active_on_control(&self.core, app, true).await;
        return Err(BridgeError::new(
          "NOT_PAIRED",
          "connect to a center before enabling clipboard sync",
          "not-sent",
        ));
      };
      let existing = read_persisted_from_disk_async(app, &binding).await?;
      let updated = PersistedState {
        enabled: true,
        group_code: existing.group_code,
      };
      save_persisted_async(&self.core, app, &binding, &updated).await?;
      let status = reconcile_with_auth_on_control(&self.core, app, auth, binding, updated).await;
      Ok(ClipboardSyncReply { status, code: None })
    }

    async fn action_new_group(&self, app: &AppHandle) -> Result<ClipboardSyncReply, BridgeError> {
      let _guard = self.core.control_lock.lock().await;
      if !is_platform_supported(&self.core).await {
        stop_active_on_control(&self.core, app, true).await;
        return Err(BridgeError::new(
          "UNSUPPORTED",
          "clipboard sync is not supported on this platform",
          "not-sent",
        ));
      }
      let Some((auth, binding)) = resolve_verified_auth(&self.core, app).await? else {
        stop_active_on_control(&self.core, app, true).await;
        return Err(BridgeError::new(
          "NOT_PAIRED",
          "connect to a center before creating a clipboard sync group",
          "not-sent",
        ));
      };
      let key = GroupKey::generate().map_err(|_| {
        BridgeError::new("INTERNAL", "failed to generate clipboard group code", "not-sent")
      })?;
      let code = key.to_code();
      // Preserve literal current switch; never auto-enable on newGroup.
      let keep_enabled = read_enabled_for_mutation_async(app, &binding).await;
      // Fence any previous group link immediately before persisting.
      stop_active_on_control(&self.core, app, !keep_enabled).await;
      let updated = PersistedState {
        enabled: keep_enabled,
        group_code: Some(code.clone()),
      };
      save_persisted_async(&self.core, app, &binding, &updated).await?;
      let status = reconcile_with_auth_on_control(&self.core, app, auth, binding, updated).await;
      Ok(ClipboardSyncReply {
        status,
        code: Some(code),
      })
    }

    async fn action_join_group(
      &self,
      app: &AppHandle,
      raw_code: String,
    ) -> Result<ClipboardSyncReply, BridgeError> {
      let _guard = self.core.control_lock.lock().await;
      if !is_platform_supported(&self.core).await {
        stop_active_on_control(&self.core, app, true).await;
        return Err(BridgeError::new(
          "UNSUPPORTED",
          "clipboard sync is not supported on this platform",
          "not-sent",
        ));
      }
      let Some((auth, binding)) = resolve_verified_auth(&self.core, app).await? else {
        stop_active_on_control(&self.core, app, true).await;
        return Err(BridgeError::new(
          "NOT_PAIRED",
          "connect to a center before joining a clipboard sync group",
          "not-sent",
        ));
      };
      let normalized = raw_code.trim().to_string();
      let _ = GroupKey::from_code(&normalized)
        .map_err(|_| BridgeError::new("INVALID_ARGUMENT", "invalid clipboard group code", "not-sent"))?;
      // Preserve literal current switch; never auto-enable on joinGroup.
      let keep_enabled = read_enabled_for_mutation_async(app, &binding).await;
      // Fence any previous group link immediately before persisting.
      stop_active_on_control(&self.core, app, !keep_enabled).await;
      let updated = PersistedState {
        enabled: keep_enabled,
        group_code: Some(normalized),
      };
      save_persisted_async(&self.core, app, &binding, &updated).await?;
      let status = reconcile_with_auth_on_control(&self.core, app, auth, binding, updated).await;
      Ok(ClipboardSyncReply { status, code: None })
    }

    async fn action_show_code(&self, app: &AppHandle) -> Result<ClipboardSyncReply, BridgeError> {
      let _guard = self.core.control_lock.lock().await;
      if !is_platform_supported(&self.core).await {
        stop_active_on_control(&self.core, app, true).await;
        return Err(BridgeError::new(
          "UNSUPPORTED",
          "clipboard sync is not supported on this platform",
          "not-sent",
        ));
      }
      let Some((auth, binding)) = resolve_verified_auth(&self.core, app).await? else {
        stop_active_on_control(&self.core, app, true).await;
        return Err(BridgeError::new(
          "NOT_PAIRED",
          "connect to a center before viewing the clipboard group code",
          "not-sent",
        ));
      };
      let existing = read_persisted_from_disk_async(app, &binding).await?;
      let Some(code) = existing.group_code.clone() else {
        return Err(BridgeError::new(
          "NOT_CONFIGURED",
          "no clipboard sync group is configured",
          "not-sent",
        ));
      };
      let status = reconcile_with_auth_on_control(&self.core, app, auth, binding, existing).await;
      Ok(ClipboardSyncReply {
        status,
        code: Some(code),
      })
    }
  }

  // ---------- Core Reconcile & Session Lifecycle ----------

  fn schedule_reconcile_if_enabled(core: Arc<RuntimeCore>, app: AppHandle) {
    {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down || guard.os_unsupported || guard.reconcile_queued {
        return;
      }
      guard.reconcile_queued = true;
    }
    tauri::async_runtime::spawn(async move {
      let _guard = core.control_lock.lock().await;
      {
        let mut inner = core.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.reconcile_queued = false;
        if inner.shutting_down || !matches!(inner.lifecycle, ObservedLifecycle::Ready) {
          return;
        }
      }
      if !is_platform_supported(&core).await {
        stop_active_on_control(&core, &app, true).await;
        return;
      }
      let Ok(Some(disk_binding)) = peek_disk_binding_async(&app).await else {
        stop_active_on_control(&core, &app, true).await;
        return;
      };
      let Ok(persisted) = read_persisted_cached_or_disk(&core, &app, &disk_binding).await else {
        stop_active_on_control(&core, &app, true).await;
        return;
      };
      if !persisted.enabled || !persisted.is_configured() {
        stop_active_on_control(&core, &app, true).await;
        return;
      }
      let _ = reconcile_enabled_on_control(&core, &app).await;
    });
  }

  async fn resolve_verified_auth(
    core: &Arc<RuntimeCore>,
    app: &AppHandle,
  ) -> Result<Option<(CenterAuth, CredentialBinding)>, BridgeError> {
    let auth = match updates::resolve_center_auth(app).await {
      Ok(Some(auth)) => auth,
      Ok(None) => return Ok(None),
      Err(err) if err.code == "NOT_CONNECTED" => return Ok(None),
      Err(err) => return Err(err),
    };
    let Some(binding) = CredentialBinding::from_center_auth(&auth) else {
      return Ok(None);
    };
    {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if !guard.shutting_down {
        guard.lifecycle = ObservedLifecycle::Ready;
      }
    }
    Ok(Some((auth, binding)))
  }

  async fn reconcile_enabled_on_control(
    core: &Arc<RuntimeCore>,
    app: &AppHandle,
  ) -> Result<ClipboardSyncStatus, BridgeError> {
    if !is_platform_supported(core).await {
      stop_active_on_control(core, app, true).await;
      return Ok(unsupported_status());
    }

    let Some((auth, binding)) = resolve_verified_auth(core, app).await? else {
      let lifecycle = core.inner.lock().unwrap_or_else(|e| e.into_inner()).lifecycle;
      let Some(disk_binding) = peek_disk_binding_async(app).await? else {
        stop_active_on_control(core, app, true).await;
        return Ok(ClipboardSyncStatus {
          enabled: false,
          configured: false,
          mode: ClipboardMode::Automatic,
          connection: ConnectionState::NotPaired,
        });
      };
      let persisted = read_persisted_cached_or_disk(core, app, &disk_binding).await?;
      let configured = persisted.is_configured();
      let clear_tray = !persisted.enabled
        || !configured
        || matches!(lifecycle, ObservedLifecycle::Disconnected { .. });
      stop_active_on_control(core, app, clear_tray).await;
      let connection = if !persisted.enabled || !configured {
        ConnectionState::Off
      } else {
        match lifecycle {
          ObservedLifecycle::Connecting => ConnectionState::Connecting,
          ObservedLifecycle::Blocked(conn) => conn,
          _ => ConnectionState::Offline,
        }
      };
      return Ok(ClipboardSyncStatus {
        enabled: persisted.enabled,
        configured,
        mode: ClipboardMode::Automatic,
        connection,
      });
    };

    let persisted = read_persisted_from_disk_async(app, &binding).await?;
    cache_persisted(core, &binding, &persisted);
    Ok(reconcile_with_auth_on_control(core, app, auth, binding, persisted).await)
  }

  async fn reconcile_with_auth_on_control(
    core: &Arc<RuntimeCore>,
    app: &AppHandle,
    auth: CenterAuth,
    binding: CredentialBinding,
    persisted: PersistedState,
  ) -> ClipboardSyncStatus {
    let configured = persisted.is_configured();
    if !persisted.enabled || !configured {
      stop_active_on_control(core, app, true).await;
      return ClipboardSyncStatus {
        enabled: persisted.enabled,
        configured,
        mode: ClipboardMode::Automatic,
        connection: ConnectionState::Off,
      };
    }

    let Some(group_code) = persisted.group_code else {
      stop_active_on_control(core, app, true).await;
      return ClipboardSyncStatus {
        enabled: persisted.enabled,
        configured: false,
        mode: ClipboardMode::Automatic,
        connection: ConnectionState::Off,
      };
    };

    let already_live = {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      !guard.shutting_down
        && !guard.os_unsupported
        && guard.os_clipboard_healthy
        && core.incoming.alive.load(Ordering::Acquire)
        && guard.active_link.is_some()
        && guard.active_clipboard.is_some()
        && guard.active.as_ref().is_some_and(|meta| {
          meta.fence == auth.fence
            && meta.binding_fingerprint == binding.credential_fingerprint
            && meta.group_code == group_code
        })
    };

    if !already_live {
      if let Err(err_state) = start_session_on_control(core, app, auth, binding, group_code).await {
        if err_state == ConnectionState::Unsupported {
          stop_active_on_control(core, app, true).await;
          return unsupported_status();
        }
        return ClipboardSyncStatus {
          enabled: true,
          configured: true,
          mode: ClipboardMode::Automatic,
          connection: err_state,
        };
      }
    }

    sync_tray_enabled_on_control(core, app, true).await;
    let connection = live_connection_state(core);
    if connection == ConnectionState::Unsupported {
      let os_unsupported = core.inner.lock().unwrap_or_else(|e| e.into_inner()).os_unsupported;
      if os_unsupported {
        stop_active_on_control(core, app, true).await;
        return unsupported_status();
      }
    }
    ClipboardSyncStatus {
      enabled: true,
      configured: true,
      mode: ClipboardMode::Automatic,
      connection,
    }
  }

  async fn start_session_on_control(
    core: &Arc<RuntimeCore>,
    app: &AppHandle,
    auth: CenterAuth,
    binding: CredentialBinding,
    group_code: String,
  ) -> Result<(), ConnectionState> {
    let key = GroupKey::from_code(&group_code).map_err(|_| ConnectionState::Offline)?;

    // Stop any previous session completely before creating a new OS clipboard adapter.
    stop_active_on_control(core, app, false).await;

    ensure_incoming_writer_task(Arc::clone(core), app.clone());
    if !core.incoming.alive.load(Ordering::Acquire) {
      return Err(ConnectionState::Offline);
    }

    let my_epoch = {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down {
        return Err(ConnectionState::Off);
      }
      if guard.os_unsupported {
        return Err(ConnectionState::Unsupported);
      }
      guard.epoch = guard.epoch.saturating_add(1);
      guard.epoch
    };

    // Start OS clipboard adapter first on a blocking thread so unsupported Wayland
    // or OS errors never open an unnecessary relay socket.
    let copy_core = Arc::clone(core);
    let clipboard_start = tokio::task::spawn_blocking(move || {
      SystemClipboard::start(move |text| {
        handle_local_copy(&copy_core, my_epoch, text);
      })
    })
    .await;

    let clipboard = match clipboard_start {
      Ok(Ok(cb)) => Arc::new(cb),
      Ok(Err(err)) if err.kind() == io::ErrorKind::Unsupported => {
        let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.os_unsupported = true;
        guard.os_clipboard_healthy = false;
        return Err(ConnectionState::Unsupported);
      }
      Ok(Err(_)) | Err(_) => {
        let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.os_clipboard_healthy = false;
        return Err(ConnectionState::Offline);
      }
    };

    // Verify we were not superseded while starting the OS adapter.
    let still_valid = {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      !guard.shutting_down
        && guard.epoch == my_epoch
        && matches!(guard.lifecycle, ObservedLifecycle::Ready)
    };
    if !still_valid {
      drop_clipboard_blocking(clipboard).await;
      return Err(ConnectionState::Offline);
    }

    let expected_fence = auth.fence.clone();
    let expected_fingerprint = binding.credential_fingerprint.clone();
    let transport_generation = parse_transport_generation(&auth.fence);
    let device_id = auth.device_id.clone();

    let clip_core = Arc::clone(core);
    let clip_fence = expected_fence.clone();
    let clip_fp = expected_fingerprint.clone();
    let link_res = clipboard_sync_relay_client::start(
      LinkConfig {
        origin: auth.origin,
        device_id: auth.device_id,
        device_token: auth.device_token,
        ca_pem: auth.ca_pem,
      },
      key,
      move |clip| {
        handle_incoming_clip(&clip_core, my_epoch, &clip_fence, &clip_fp, clip);
      },
    );

    let link = match link_res {
      Ok(link) => Arc::new(link),
      Err(err) => {
        drop_clipboard_blocking(clipboard).await;
        return Err(map_link_start_error(err));
      }
    };

    let installed = {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if !guard.shutting_down
        && !guard.os_unsupported
        && guard.epoch == my_epoch
        && matches!(guard.lifecycle, ObservedLifecycle::Ready)
        && core.incoming.alive.load(Ordering::Acquire)
      {
        guard.active = Some(ActiveSessionMeta {
          fence: expected_fence,
          binding_fingerprint: expected_fingerprint,
          group_code,
          device_id,
          transport_generation,
        });
        guard.active_link = Some(Arc::clone(&link));
        guard.active_clipboard = Some(Arc::clone(&clipboard));
        guard.os_clipboard_healthy = true;
        guard.outbound_drop_streak = 0;
        guard.outbound_drop_gen = 0;
        guard.outbound_backpressured_gen = None;
        guard.should_keep_tray = true;
        true
      } else {
        false
      }
    };

    if !installed {
      drop(link);
      drop_clipboard_blocking(clipboard).await;
      return Err(ConnectionState::Offline);
    }
    Ok(())
  }

  fn handle_local_copy(core: &Arc<RuntimeCore>, expected_epoch: u64, text: String) {
    if !eligible_text(&text, false) {
      return;
    }
    let link = {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down
        || guard.epoch != expected_epoch
        || !matches!(guard.lifecycle, ObservedLifecycle::Ready)
        || !guard.os_clipboard_healthy
        || guard.os_unsupported
      {
        return;
      }
      match guard.active_link.as_ref() {
        Some(link) => Arc::clone(link),
        None => return,
      }
    };

    let snap = link.snapshot();
    // Never retain or queue copies when not actively online on a valid generation.
    if snap.status != LinkStatus::Online || snap.generation == 0 {
      return;
    }

    let sent = link.publish(snap.generation, &text);
    if sent {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.epoch == expected_epoch {
        guard.outbound_drop_streak = 0;
        guard.outbound_drop_gen = 0;
        guard.outbound_backpressured_gen = None;
      }
      return;
    }

    // If still online on the same generation, outbound slot backpressure dropped the item.
    let after = link.snapshot();
    if after.status == LinkStatus::Online && after.generation == snap.generation {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.epoch == expected_epoch {
        if guard.outbound_drop_gen != snap.generation {
          guard.outbound_drop_gen = snap.generation;
          guard.outbound_drop_streak = 1;
        } else {
          guard.outbound_drop_streak = guard.outbound_drop_streak.saturating_add(1);
        }
        if guard.outbound_drop_streak >= MAX_CONSECUTIVE_PUBLISH_DROPS {
          guard.outbound_backpressured_gen = Some(snap.generation);
        }
      }
    }
  }

  fn handle_incoming_clip(
    core: &Arc<RuntimeCore>,
    expected_epoch: u64,
    expected_fence: &str,
    expected_fingerprint: &str,
    clip: IncomingClip,
  ) {
    if !core.incoming.alive.load(Ordering::Acquire) || !eligible_text(&clip.text, false) {
      return;
    }
    let link = {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down
        || guard.epoch != expected_epoch
        || !matches!(guard.lifecycle, ObservedLifecycle::Ready)
        || !guard.os_clipboard_healthy
        || guard.os_unsupported
      {
        return;
      }
      let matches_meta = guard.active.as_ref().is_some_and(|meta| {
        meta.fence == expected_fence && meta.binding_fingerprint == expected_fingerprint
      });
      if !matches_meta {
        return;
      }
      match guard.active_link.as_ref() {
        Some(link) => Arc::clone(link),
        None => return,
      }
    };

    let snap = link.snapshot();
    if snap.status != LinkStatus::Online || snap.generation != clip.generation {
      return;
    }

    core.incoming.put_conflated(PendingIncomingWrite {
      epoch: expected_epoch,
      fence: expected_fence.to_string(),
      binding_fingerprint: expected_fingerprint.to_string(),
      link_generation: clip.generation,
      text: clip.text,
    });
  }

  fn ensure_incoming_writer_task(core: Arc<RuntimeCore>, app: AppHandle) {
    if core
      .incoming
      .spawned
      .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
      .is_err()
    {
      return;
    }
    core.incoming.alive.store(true, Ordering::Release);
    tauri::async_runtime::spawn(async move {
      struct AliveGuard(Arc<IncomingSlot>);
      impl Drop for AliveGuard {
        fn drop(&mut self) {
          self.0.alive.store(false, Ordering::Release);
          self.0.spawned.store(false, Ordering::Release);
        }
      }
      let _alive_guard = AliveGuard(Arc::clone(&core.incoming));

      loop {
        core.incoming.notify.notified().await;
        loop {
          let pending = {
            let mut slot = core
              .incoming
              .pending
              .lock()
              .unwrap_or_else(|e| e.into_inner());
            slot.take()
          };
          let Some(pending) = pending else { break };
          process_incoming_write(&app, &core, pending).await;
        }
      }
    });
  }

  async fn process_incoming_write(
    app: &AppHandle,
    core: &Arc<RuntimeCore>,
    pending: PendingIncomingWrite,
  ) {
    // Recheck #1: fast in-memory state & handles.
    let (link, clipboard) = {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down
        || guard.epoch != pending.epoch
        || !matches!(guard.lifecycle, ObservedLifecycle::Ready)
        || !guard.os_clipboard_healthy
        || guard.os_unsupported
      {
        return;
      }
      let matches_meta = guard.active.as_ref().is_some_and(|meta| {
        meta.fence == pending.fence && meta.binding_fingerprint == pending.binding_fingerprint
      });
      if !matches_meta {
        return;
      }
      let (Some(link), Some(clipboard)) = (guard.active_link.as_ref(), guard.active_clipboard.as_ref())
      else {
        return;
      };
      (Arc::clone(link), Arc::clone(clipboard))
    };

    // Recheck #2: live relay link online generation.
    let snap = link.snapshot();
    if snap.status != LinkStatus::Online || snap.generation != pending.link_generation {
      return;
    }

    // Recheck #3: broker generation + credential binding fence before touching OS clipboard.
    match tokio::time::timeout(WRITE_AUTH_VERIFY_TIMEOUT, updates::resolve_center_auth(app)).await {
      Ok(Ok(Some(auth))) => {
        let binding_ok = CredentialBinding::from_center_auth(&auth)
          .is_some_and(|b| constant_time_eq(b.credential_fingerprint.as_bytes(), pending.binding_fingerprint.as_bytes()));
        if auth.fence != pending.fence || !binding_ok {
          fence_if_epoch_matches(core, app, pending.epoch, true);
          return;
        }
      }
      Ok(Ok(None)) => {
        fence_if_epoch_matches(core, app, pending.epoch, true);
        return;
      }
      Ok(Err(err)) if err.code == "NOT_CONNECTED" => {
        fence_if_epoch_matches(core, app, pending.epoch, true);
        return;
      }
      Ok(Err(_)) | Err(_) => {
        // Fail closed: never write clipboard if live broker auth could not be verified.
        return;
      }
    }

    // Recheck #4: confirm epoch & link generation right before spawning blocking OS write.
    {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down
        || guard.epoch != pending.epoch
        || !matches!(guard.lifecycle, ObservedLifecycle::Ready)
        || !guard.os_clipboard_healthy
        || guard.os_unsupported
      {
        return;
      }
    }
    let snap = link.snapshot();
    if snap.status != LinkStatus::Online || snap.generation != pending.link_generation {
      return;
    }

    // Execute blocking OS write off the Tokio/Tauri threads with final pre-write recheck.
    let write_outcome = tokio::task::spawn_blocking({
      let core = Arc::clone(core);
      let link = Arc::clone(&link);
      let clipboard = Arc::clone(&clipboard);
      let expected_epoch = pending.epoch;
      let expected_gen = pending.link_generation;
      let text = pending.text;
      move || -> Option<io::Result<()>> {
        let _write = core.native_write.lock().unwrap_or_else(|e| e.into_inner());
        {
          let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
          if guard.shutting_down
            || guard.epoch != expected_epoch
            || !matches!(guard.lifecycle, ObservedLifecycle::Ready)
            || !guard.os_clipboard_healthy
            || guard.os_unsupported
          {
            return None;
          }
        }
        let snap = link.snapshot();
        if snap.status != LinkStatus::Online || snap.generation != expected_gen {
          return None;
        }
        Some(clipboard.write(&text))
      }
    })
    .await;

    match write_outcome {
      Ok(None) | Ok(Some(Ok(()))) => {}
      Ok(Some(Err(err))) if err.kind() == io::ErrorKind::Unsupported => {
        {
          let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
          guard.os_unsupported = true;
          guard.os_clipboard_healthy = false;
        }
        fence_if_epoch_matches(core, app, pending.epoch, true);
      }
      Ok(Some(Err(_))) | Err(_) => {
        // Handle/write failure must not continue falsely reporting live.
        fence_if_epoch_matches(core, app, pending.epoch, false);
      }
    }
  }

  fn fence_if_epoch_matches(
    core: &Arc<RuntimeCore>,
    app: &AppHandle,
    expected_epoch: u64,
    clear_tray: bool,
  ) {
    let detached = {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.epoch != expected_epoch {
        return;
      }
      guard.epoch = guard.epoch.saturating_add(1);
      guard.active = None;
      guard.os_clipboard_healthy = false;
      guard.outbound_drop_streak = 0;
      guard.outbound_drop_gen = 0;
      guard.outbound_backpressured_gen = None;
      if clear_tray {
        guard.should_keep_tray = false;
        guard.tray_active = false;
      }
      (guard.active_link.take(), guard.active_clipboard.take())
    };
    core.incoming.clear();
    drop_detached_async(detached.0, detached.1);
    if clear_tray {
      remove_tray_on_main_thread(app, true);
    }
  }

  fn detach_active_locked(
    core: &Arc<RuntimeCore>,
    new_lifecycle: Option<ObservedLifecycle>,
    clear_cache: bool,
    clear_tray: bool,
  ) -> (Option<Arc<Link>>, Option<Arc<SystemClipboard>>) {
    let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
    guard.epoch = guard.epoch.saturating_add(1);
    guard.active = None;
    guard.os_clipboard_healthy = false;
    guard.outbound_drop_streak = 0;
    guard.outbound_drop_gen = 0;
    guard.outbound_backpressured_gen = None;
    if let Some(lifecycle) = new_lifecycle {
      guard.lifecycle = lifecycle;
    }
    if clear_cache {
      guard.cached_persisted = None;
    }
    if clear_tray {
      guard.should_keep_tray = false;
      guard.tray_active = false;
    }
    let detached = (guard.active_link.take(), guard.active_clipboard.take());
    drop(guard);
    core.incoming.clear();
    detached
  }

  async fn stop_active_on_control(core: &Arc<RuntimeCore>, app: &AppHandle, clear_tray: bool) {
    let (link, clip) = detach_active_locked(core, None, false, clear_tray);
    drop(link);
    let core = Arc::clone(core);
    let _ = tokio::task::spawn_blocking(move || {
      // A write that already passed its final fence must finish before stop returns.
      drop(core.native_write.lock().unwrap_or_else(|e| e.into_inner()));
      drop(clip);
    }).await;
    if clear_tray {
      remove_tray_on_main_thread(app, true);
    }
  }

  async fn drop_clipboard_blocking(clipboard: Arc<SystemClipboard>) {
    let _ = tokio::task::spawn_blocking(move || {
      drop(clipboard);
    })
    .await;
  }

  fn drop_detached_async(link: Option<Arc<Link>>, clipboard: Option<Arc<SystemClipboard>>) {
    drop(link);
    if let Some(clipboard) = clipboard {
      tauri::async_runtime::spawn_blocking(move || {
        drop(clipboard);
      });
    }
  }

  fn live_connection_state(core: &Arc<RuntimeCore>) -> ConnectionState {
    let (link, unhealthy, os_unsupported, backpressured_gen) = {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      (
        guard.active_link.clone(),
        !guard.os_clipboard_healthy
          || guard.active_clipboard.is_none()
          || !core.incoming.alive.load(Ordering::Acquire),
        guard.os_unsupported,
        guard.outbound_backpressured_gen,
      )
    };
    if os_unsupported {
      return ConnectionState::Unsupported;
    }
    let Some(link) = link else {
      return ConnectionState::Offline;
    };
    if unhealthy {
      return ConnectionState::Offline;
    }
    let snap = link.snapshot();
    if let Some(bp_gen) = backpressured_gen {
      if bp_gen == snap.generation && snap.status == LinkStatus::Online {
        return ConnectionState::Offline;
      }
      if bp_gen != snap.generation {
        let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.outbound_backpressured_gen == Some(bp_gen) {
          guard.outbound_backpressured_gen = None;
          guard.outbound_drop_streak = 0;
          guard.outbound_drop_gen = 0;
        }
      }
    }
    match snap.status {
      LinkStatus::Connecting => ConnectionState::Connecting,
      LinkStatus::Online => ConnectionState::Online,
      LinkStatus::Offline => ConnectionState::Offline,
      LinkStatus::Unauthorized => ConnectionState::Unauthorized,
      LinkStatus::Unsupported => ConnectionState::Unsupported,
      LinkStatus::CertificateError => ConnectionState::CertificateError,
    }
  }

  fn map_link_start_error(err: LinkStartError) -> ConnectionState {
    match err {
      LinkStartError::InvalidCaPem | LinkStartError::TlsConfig => ConnectionState::CertificateError,
      LinkStartError::InvalidOrigin
      | LinkStartError::InvalidDeviceId
      | LinkStartError::InvalidDeviceToken
      | LinkStartError::InvalidGroupKey
      | LinkStartError::NoTokioRuntime => ConnectionState::Offline,
    }
  }

  fn map_broker_error_code(code: Option<&str>) -> ConnectionState {
    match code {
      Some("UNAUTHORIZED" | "FORBIDDEN" | "INVALID_TOKEN") => ConnectionState::Unauthorized,
      Some(c) if c.starts_with("CERT") || c.starts_with("TLS") => ConnectionState::CertificateError,
      _ => ConnectionState::Offline,
    }
  }

  fn is_relay_connected(value: &Value) -> bool {
    value.get("phase").and_then(Value::as_str) == Some("connected")
      && value.pointer("/connection/kind").and_then(Value::as_str) == Some("relay")
  }

  fn parse_transport_generation(fence: &str) -> Option<u64> {
    fence.split(':').nth(1)?.parse().ok()
  }

  // ---------- Platform Support Probe ----------

  async fn is_platform_supported(core: &Arc<RuntimeCore>) -> bool {
    if core.inner.lock().unwrap_or_else(|e| e.into_inner()).os_unsupported {
      return false;
    }
    #[cfg(windows)]
    {
      true
    }
    #[cfg(target_os = "linux")]
    {
      if let Some(&supported) = LINUX_CLIPBOARD_SUPPORTED.get() {
        return supported;
      }
      let supported = tokio::task::spawn_blocking(probe_linux_clipboard_support)
        .await
        .unwrap_or(false);
      *LINUX_CLIPBOARD_SUPPORTED.get_or_init(|| supported)
    }
  }

  #[cfg(target_os = "linux")]
  fn probe_linux_clipboard_support() -> bool {
    let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
      || std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);
    if is_wayland {
      // One-shot protocol check (ext-data-control / wlr-data-control) without installing
      // a clipboard listener or reading clipboard contents.
      return wl_clipboard_rs::utils::is_primary_selection_supported().is_ok();
    }
    std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty())
  }

  // ---------- Tray Management (Windows/Linux only when sync enabled & tray really available) ----------

  fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
      let _ = window.unminimize();
      let _ = window.show();
      let _ = window.set_focus();
    }
  }

  fn remove_tray_on_main_thread(app: &AppHandle, restore_if_hidden: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
      let removed = handle.remove_tray_by_id(TRAY_ID);
      drop(removed);
      if restore_if_hidden {
        if let Some(window) = handle.get_webview_window("main") {
          if matches!(window.is_visible(), Ok(false)) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
          }
        }
      }
    });
  }

  async fn sync_tray_enabled_on_control(core: &Arc<RuntimeCore>, app: &AppHandle, enabled: bool) {
    if !enabled {
      {
        let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.should_keep_tray = false;
        guard.tray_active = false;
      }
      remove_tray_on_main_thread(app, true);
      return;
    }

    let already_active = {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if guard.shutting_down || guard.os_unsupported {
        return;
      }
      guard.should_keep_tray = true;
      guard.tray_active
    };
    if already_active && app.tray_by_id(TRAY_ID).is_some() {
      return;
    }

    let app_clone = app.clone();
    let created = tokio::task::spawn_blocking(move || create_tray_if_available(&app_clone))
      .await
      .unwrap_or(false);

    let still_wanted = {
      let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if created && guard.should_keep_tray && !guard.shutting_down && !guard.os_unsupported {
        guard.tray_active = true;
        true
      } else {
        guard.tray_active = false;
        false
      }
    };
    if created && !still_wanted {
      remove_tray_on_main_thread(app, false);
    }
  }

  fn create_tray_if_available(app: &AppHandle) -> bool {
    if app.tray_by_id(TRAY_ID).is_some() {
      return true;
    }
    #[cfg(target_os = "linux")]
    if !probe_linux_tray_available() {
      return false;
    }

    let Ok(menu) = MenuBuilder::new(app)
      .text(TRAY_MENU_OPEN_ID, "Open PiBot")
      .text(TRAY_MENU_QUIT_ID, "Quit")
      .build()
    else {
      return false;
    };

    let tray_result = TrayIconBuilder::with_id(TRAY_ID)
      .icon(tauri::include_image!("../build/icons/icon.png"))
      .tooltip("PiBot")
      .menu(&menu)
      .show_menu_on_left_click(false)
      .on_tray_icon_event(|tray, event| {
        let should_open = matches!(
          event,
          TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
          }
        );
        if should_open {
          show_main_window(tray.app_handle());
        }
      })
      .build(app);

    tray_result.is_ok()
  }

  #[cfg(target_os = "linux")]
  fn probe_linux_tray_available() -> bool {
    // 1. Confirm ayatana-appindicator3 or appindicator3 is present so libappindicator-sys
    //    cannot panic on the GTK main thread.
    let has_appindicator = unsafe {
      let try_open = |name: &[u8]| -> bool {
        let handle = libc::dlopen(
          name.as_ptr().cast::<libc::c_char>(),
          libc::RTLD_LAZY | libc::RTLD_LOCAL,
        );
        if !handle.is_null() {
          libc::dlclose(handle);
          true
        } else {
          false
        }
      };
      try_open(b"libayatana-appindicator3.so.1\0") || try_open(b"libappindicator3.so.1\0")
    };
    if !has_appindicator {
      return false;
    }

    // 2. Confirm a real StatusNotifierHost is registered on the session D-Bus
    //    so close-to-tray never traps the user on desktops without a visible tray.
    use gtk::gio::{self, BusType, Cancellable, DBusCallFlags};
    use gtk::glib::variant::ToVariant;

    let Ok(conn) = gio::bus_get_sync(BusType::Session, Cancellable::NONE) else {
      return false;
    };
    let params = (
      "org.kde.StatusNotifierWatcher",
      "IsStatusNotifierHostRegistered",
    )
      .to_variant();
    let Ok(reply) = conn.call_sync(
      Some("org.kde.StatusNotifierWatcher"),
      "/StatusNotifierWatcher",
      "org.freedesktop.DBus.Properties",
      "Get",
      Some(&params),
      None,
      DBusCallFlags::NO_AUTO_START,
      500,
      Cancellable::NONE,
    ) else {
      return false;
    };
    if reply.n_children() < 1 {
      return false;
    }
    reply
      .child_value(0)
      .as_variant()
      .and_then(|v| v.get::<bool>())
      == Some(true)
  }

  // ---------- Local Binding Peek & Protected Persistence ----------

  async fn peek_disk_binding_async(app: &AppHandle) -> Result<Option<CredentialBinding>, BridgeError> {
    let root = PathBuf::from(bridge::resolve_client_data_root(app)?);
    tokio::task::spawn_blocking(move || peek_disk_binding(&root))
      .await
      .map_err(|_| BridgeError::new("INTERNAL", "clipboard credential worker failed", "not-sent"))
  }

  fn peek_disk_binding(root: &Path) -> Option<CredentialBinding> {
    let path = root.join(CENTER_CREDENTIALS_FILE);
    let meta = fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_CREDENTIALS_FILE_BYTES {
      return None;
    }
    let mut raw = fs::read(&path).ok()?;
    let parsed: Result<Value, _> = serde_json::from_slice(&raw);
    zeroize_bytes(&mut raw);
    let credentials = parsed.ok()?;
    let url = credentials.get("url").and_then(Value::as_str)?;
    let parsed_url = tauri::Url::parse(url).ok()?;
    if parsed_url.scheme() != "https"
      || parsed_url.host_str().is_none()
      || !parsed_url.username().is_empty()
      || parsed_url.password().is_some()
    {
      return None;
    }
    let origin = parsed_url.origin().ascii_serialization();
    let device_id = credentials.get("deviceId").and_then(Value::as_str)?.trim();
    let device_token = credentials
      .get("deviceToken")
      .and_then(Value::as_str)?
      .trim();
    if device_id.is_empty()
      || device_id.len() > 128
      || device_id.starts_with('-')
      || device_id.chars().any(|c| c.is_whitespace() || c.is_control())
      || device_token.is_empty()
      || device_token.len() > 4096
      || device_token.chars().any(|c| c.is_whitespace() || c.is_control())
    {
      return None;
    }
    let ca_pem = credentials
      .get("ca")
      .and_then(Value::as_str)
      .map(str::trim)
      .filter(|pem| !pem.is_empty());
    if ca_pem.is_some_and(|pem| pem.len() > 64 * 1024 || !pem.contains("-----BEGIN CERTIFICATE-----"))
    {
      return None;
    }
    CredentialBinding::create(&origin, device_id, device_token, ca_pem)
  }

  fn cache_persisted(core: &Arc<RuntimeCore>, binding: &CredentialBinding, state: &PersistedState) {
    let mut guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
    guard.cached_persisted = Some((binding.credential_fingerprint.clone(), state.clone()));
  }

  async fn read_persisted_cached_or_disk(
    core: &Arc<RuntimeCore>,
    app: &AppHandle,
    binding: &CredentialBinding,
  ) -> Result<PersistedState, BridgeError> {
    {
      let guard = core.inner.lock().unwrap_or_else(|e| e.into_inner());
      if let Some((fp, state)) = &guard.cached_persisted {
        if constant_time_eq(fp.as_bytes(), binding.credential_fingerprint.as_bytes()) {
          return Ok(state.clone());
        }
      }
    }
    let state = read_persisted_from_disk_async(app, binding).await?;
    cache_persisted(core, binding, &state);
    Ok(state)
  }

  async fn read_persisted_from_disk_async(
    app: &AppHandle,
    binding: &CredentialBinding,
  ) -> Result<PersistedState, BridgeError> {
    let root = PathBuf::from(bridge::resolve_client_data_root(app)?);
    let binding = binding.clone();
    tokio::task::spawn_blocking(move || read_persisted_state(&root, &binding))
      .await
      .map_err(|_| storage_error("clipboard sync storage worker failed"))?
  }

  async fn read_enabled_for_mutation_async(app: &AppHandle, binding: &CredentialBinding) -> bool {
    match read_persisted_from_disk_async(app, binding).await {
      Ok(state) => state.enabled,
      Err(_) => false,
    }
  }

  async fn save_persisted_async(
    core: &Arc<RuntimeCore>,
    app: &AppHandle,
    binding: &CredentialBinding,
    state: &PersistedState,
  ) -> Result<(), BridgeError> {
    let root = PathBuf::from(bridge::resolve_client_data_root(app)?);
    let binding_clone = binding.clone();
    let state_clone = state.clone();
    tokio::task::spawn_blocking(move || save_persisted_state(&root, &binding_clone, &state_clone))
      .await
      .map_err(|_| storage_error("clipboard sync storage worker failed"))??;
    cache_persisted(core, binding, state);
    Ok(())
  }

  fn read_persisted_state(
    root: &Path,
    binding: &CredentialBinding,
  ) -> Result<PersistedState, BridgeError> {
    let path = root.join(STATE_FILE_NAME);
    let meta = match fs::symlink_metadata(&path) {
      Ok(meta) => meta,
      Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(PersistedState::empty()),
      Err(_) => return Err(storage_error("failed to access clipboard sync state")),
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_STATE_FILE_BYTES {
      return Err(storage_error("clipboard sync state file is invalid"));
    }

    let raw = fs::read(&path).map_err(|_| storage_error("failed to read clipboard sync state"))?;
    let mut plaintext = unprotect_storage_bytes(&raw)?;
    let parsed: Result<PersistedRecord, _> = serde_json::from_slice(&plaintext);
    zeroize_bytes(&mut plaintext);
    let record = parsed.map_err(|_| storage_error("clipboard sync state is corrupted"))?;

    if record.version != STATE_SCHEMA_VERSION {
      return Err(storage_error("clipboard sync state version is unsupported"));
    }
    if !binding.matches(&record.origin, &record.device_id, &record.credential_fingerprint) {
      // Never migrate group or toggle across Center origin, device ID, token, or CA changes.
      return Ok(PersistedState::empty());
    }
    let group_code = record.group_code.filter(|c| !c.is_empty());
    if let Some(ref code) = group_code {
      if GroupKey::from_code(code).is_err() {
        return Err(storage_error("stored clipboard sync group code is invalid"));
      }
    }
    Ok(PersistedState {
      enabled: record.enabled,
      group_code,
    })
  }

  fn save_persisted_state(
    root: &Path,
    binding: &CredentialBinding,
    state: &PersistedState,
  ) -> Result<(), BridgeError> {
    let record = PersistedRecord {
      version: STATE_SCHEMA_VERSION,
      origin: binding.origin.clone(),
      device_id: binding.device_id.clone(),
      credential_fingerprint: binding.credential_fingerprint.clone(),
      enabled: state.enabled,
      group_code: state.group_code.clone(),
    };
    let mut plaintext = serde_json::to_vec(&record)
      .map_err(|_| storage_error("failed to serialize clipboard sync state"))?;
    let payload = protect_storage_bytes(&plaintext);
    zeroize_bytes(&mut plaintext);
    let payload = payload?;
    write_file_atomic(root, STATE_FILE_NAME, &payload)
  }

  #[cfg(windows)]
  fn protect_storage_bytes(plaintext: &[u8]) -> Result<Vec<u8>, BridgeError> {
    let protected = dpapi_protect(plaintext)?;
    let envelope = DpapiEnvelope {
      v: DPAPI_ENVELOPE_VERSION,
      dpapi: STANDARD.encode(protected),
    };
    serde_json::to_vec(&envelope)
      .map_err(|_| storage_error("failed to encode protected clipboard sync state"))
  }

  #[cfg(windows)]
  fn unprotect_storage_bytes(raw: &[u8]) -> Result<Vec<u8>, BridgeError> {
    let envelope: DpapiEnvelope = serde_json::from_slice(raw)
      .map_err(|_| storage_error("protected clipboard sync state is invalid"))?;
    if envelope.v != DPAPI_ENVELOPE_VERSION {
      return Err(storage_error("protected clipboard sync state version is unsupported"));
    }
    let protected = STANDARD
      .decode(envelope.dpapi.as_bytes())
      .map_err(|_| storage_error("protected clipboard sync state is corrupted"))?;
    dpapi_unprotect(&protected)
  }

  #[cfg(windows)]
  fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, BridgeError> {
    use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
      CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };

    let cb_data =
      u32::try_from(plaintext.len()).map_err(|_| storage_error("clipboard sync state is too large"))?;
    let in_blob = CRYPT_INTEGER_BLOB {
      cbData: cb_data,
      pbData: plaintext.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
      cbData: DPAPI_ENTROPY.len() as u32,
      pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
      cbData: 0,
      pbData: std::ptr::null_mut(),
    };
    // SAFETY: All pointers are valid for the duration of the Win32 DPAPI call.
    let ok = unsafe {
      CryptProtectData(
        &in_blob,
        std::ptr::null(),
        &entropy,
        std::ptr::null(),
        std::ptr::null(),
        CRYPTPROTECT_UI_FORBIDDEN,
        &mut out_blob,
      )
    };
    if ok == 0 || out_blob.pbData.is_null() {
      return Err(storage_error("failed to protect clipboard sync state"));
    }
    // SAFETY: `CryptProtectData` allocated `cbData` bytes at `pbData` via `LocalAlloc`.
    let out = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) }.to_vec();
    unsafe {
      LocalFree(out_blob.pbData as HLOCAL);
    }
    Ok(out)
  }

  #[cfg(windows)]
  fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, BridgeError> {
    use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
      CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let cb_data =
      u32::try_from(ciphertext.len()).map_err(|_| storage_error("clipboard sync state is invalid"))?;
    let in_blob = CRYPT_INTEGER_BLOB {
      cbData: cb_data,
      pbData: ciphertext.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
      cbData: DPAPI_ENTROPY.len() as u32,
      pbData: DPAPI_ENTROPY.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
      cbData: 0,
      pbData: std::ptr::null_mut(),
    };
    // SAFETY: All pointers are valid for the duration of the Win32 DPAPI call.
    let ok = unsafe {
      CryptUnprotectData(
        &in_blob,
        std::ptr::null_mut(),
        &entropy,
        std::ptr::null(),
        std::ptr::null(),
        CRYPTPROTECT_UI_FORBIDDEN,
        &mut out_blob,
      )
    };
    if ok == 0 || out_blob.pbData.is_null() {
      return Err(storage_error("failed to decrypt protected clipboard sync state"));
    }
    // SAFETY: `CryptUnprotectData` allocated `cbData` bytes at `pbData` via `LocalAlloc`.
    let slice = unsafe { std::slice::from_raw_parts_mut(out_blob.pbData, out_blob.cbData as usize) };
    let out = slice.to_vec();
    zeroize_bytes(slice);
    unsafe {
      LocalFree(out_blob.pbData as HLOCAL);
    }
    Ok(out)
  }

  #[cfg(target_os = "linux")]
  fn protect_storage_bytes(plaintext: &[u8]) -> Result<Vec<u8>, BridgeError> {
    Ok(plaintext.to_vec())
  }

  #[cfg(target_os = "linux")]
  fn unprotect_storage_bytes(raw: &[u8]) -> Result<Vec<u8>, BridgeError> {
    Ok(raw.to_vec())
  }

  fn write_file_atomic(root: &Path, file_name: &str, bytes: &[u8]) -> Result<(), BridgeError> {
    let dest = root.join(file_name);
    if let Ok(meta) = fs::symlink_metadata(&dest) {
      if meta.file_type().is_symlink() {
        return Err(storage_error("refusing to write clipboard sync state through symlink"));
      }
    }

    #[cfg(target_os = "linux")]
    {
      use std::os::unix::fs::PermissionsExt;
      let _ = fs::set_permissions(root, fs::Permissions::from_mode(0o700));
    }

    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = root.join(format!("{file_name}.tmp.{}.{seq}", std::process::id()));

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_os = "linux")]
    {
      use std::os::unix::fs::OpenOptionsExt;
      options.mode(0o600);
    }

    let mut file = options
      .open(&tmp)
      .map_err(|_| storage_error("failed to create temporary clipboard sync state file"))?;

    let write_res = (|| -> io::Result<()> {
      #[cfg(target_os = "linux")]
      {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
      }
      file.write_all(bytes)?;
      file.sync_all()?;
      Ok(())
    })();

    drop(file);
    if write_res.is_err() {
      let _ = fs::remove_file(&tmp);
      return Err(storage_error("failed to write clipboard sync state"));
    }

    if fs::rename(&tmp, &dest).is_err() {
      let _ = fs::remove_file(&tmp);
      return Err(storage_error("failed to commit clipboard sync state"));
    }

    #[cfg(target_os = "linux")]
    if let Ok(dir) = fs::File::open(root) {
      let _ = dir.sync_all();
    }

    Ok(())
  }

  #[cfg(test)]
  #[test]
  fn toggle_replaces_persisted_state_without_crossing_bindings() {
    let root = std::env::temp_dir().join(format!(
      "pibot-clipboard-state-{}-{}",
      std::process::id(),
      TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let binding = CredentialBinding {
      origin: "https://example.test".into(),
      device_id: "test-device".into(),
      credential_fingerprint: "a".repeat(64),
    };
    let code = format!("pibot-clipboard-v1:{}", "A".repeat(43));
    let mut state = PersistedState { enabled: true, group_code: Some(code.clone()) };
    save_persisted_state(&root, &binding, &state).unwrap();

    state.enabled = false;
    save_persisted_state(&root, &binding, &state).unwrap();

    let saved = read_persisted_state(&root, &binding).unwrap();
    assert!(!saved.enabled);
    assert!(saved.group_code.as_deref() == Some(code.as_str()));
    let other = CredentialBinding { credential_fingerprint: "b".repeat(64), ..binding };
    assert!(!read_persisted_state(&root, &other).unwrap().is_configured());

    #[cfg(windows)]
    assert!(!fs::read(root.join(STATE_FILE_NAME))
      .unwrap()
      .windows(code.len())
      .any(|bytes| bytes == code.as_bytes()));
    fs::remove_dir_all(root).unwrap();
  }
}

pub use imp::ClipboardRuntime;
