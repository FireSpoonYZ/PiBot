use std::{
  collections::{HashMap, VecDeque},
  fs,
  io::{BufRead, BufReader, Write},
  path::{Path, PathBuf},
  process::{Child, ChildStdin, ChildStdout, Command, Stdio},
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc::{self, SyncSender},
  },
  thread,
  time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Manager, ipc::Channel, utils::platform};
use tokio::sync::oneshot;

const MAX_LINE_BYTES: usize = 40 * 1024 * 1024;
const MAX_PENDING_CALLS: usize = 8;
const MAX_OBSERVERS: usize = 8;
const WRITER_QUEUE_CAP: usize = 16;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
/// Nested long RPCs: Hindsight memory calls and one manual compaction wait on a model/backend request.
const MEMORY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(150);
/// Exact long control methods carried inside the generic `call` broker op.
const MEMORY_METHODS: &[&str] = &[
  "memoryStatus",
  "recallMemory",
  "reflectMemory",
  "retainMemory",
  "getMemory",
  "getMemorySource",
  "correctMemory",
  "retryMemory",
  "compact",
];
const MAX_OBSERVER_FRAME_FIFO: usize = 8;
const MAX_OBSERVER_FIFO_BYTES: usize = 80 * 1024 * 1024;
const OBSERVE_ACK_OP: &str = "observe_ack";
const SIDECAR_NAME: &str = "e-launcher-client-node";
const CLIENT_SCRIPT_NAME: &str = "desktop-client.mjs";

const PUBLIC_OPERATIONS: &[&str] = &[
  "center_connect",
  "center_status",
  "center_disconnect",
  "center_store",
  "center_owner_session",
  "center_owner_login",
  "center_model_picker_get",
  "center_model_star_set",
  "center_bot_model_get",
  "center_bot_model_set",
  "center_bot_avatar_get",
  "center_bot_avatar_set",
  "center_bot_cwd_get",
  "center_bot_cwd_set",
  "center_bot_capabilities_get",
  "center_bot_capability_set",
  "center_runtime_status",
  "connect",
  "disconnect",
  "status",
  "devices",
  "bot_directory",
  "bot_sync",
  "rename_device",
  "call",
  "settings_get",
  "settings_set",
  "service_status",
  "pending_enqueue",
  "pending_get",
  "pending_list",
  "pending_send",
  "pending_reconcile",
  "pending_cancel",
  "ui_get",
  "ui_set",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopRequestInput {
  pub op: String,
  #[serde(default = "empty_object")]
  pub params: Value,
}

fn empty_object() -> Value {
  Value::Object(Map::new())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopObserveAck {
  pub observation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PickedFileRef {
  pub name: String,
  pub path: String,
  pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeError {
  pub code: String,
  pub message: String,
  pub outcome: String,
}

impl BridgeError {
  pub fn new(code: &str, message: impl Into<String>, outcome: &str) -> Self {
    Self {
      code: normalize_error_code(code),
      message: message.into(),
      outcome: normalize_outcome(outcome),
    }
  }
}

fn normalize_error_code(code: &str) -> String {
  let trimmed = code.trim();
  if trimmed.is_empty() {
    "INTERNAL".to_string()
  } else {
    trimmed.to_string()
  }
}

fn normalize_outcome(outcome: &str) -> String {
  match outcome {
    "not-sent" | "unconfirmed" | "responded" => outcome.to_string(),
    _ => "unconfirmed".to_string(),
  }
}

struct PendingEntry {
  written: Arc<AtomicBool>,
  tx: Option<oneshot::Sender<Result<Value, BridgeError>>>,
}

struct WriteJob {
  id: String,
  line: Vec<u8>,
  written: Arc<AtomicBool>,
  write_ack: Option<oneshot::Sender<Result<(), BridgeError>>>,
}

struct ObserverFrame {
  frame: Value,
  bytes: usize,
  terminal: bool,
}

struct InflightObservationEvent {
  delivery_id: String,
  terminal: bool,
  bytes: usize,
}

struct ObserverState {
  connection: bool,
  channel: Channel<Value>,
  fifo: VecDeque<ObserverFrame>,
  fifo_bytes: usize,
  in_flight: Option<InflightObservationEvent>,
  generation: u64,
  instance_nonce: u64,
  next_delivery_seq: u64,
}

impl ObserverState {
  fn new(channel: Channel<Value>, generation: u64, instance_nonce: u64, connection: bool) -> Self {
    Self {
      connection,
      channel,
      fifo: VecDeque::new(),
      fifo_bytes: 0,
      in_flight: None,
      generation,
      instance_nonce,
      next_delivery_seq: 1,
    }
  }

  fn enqueue(&mut self, frame: Value, terminal: bool) -> Result<(), BridgeError> {
    let bytes = serde_json::to_vec(&frame)
      .map_err(|_| {
        BridgeError::new("INVALID_JSON", "failed to serialize observation frame", "unconfirmed")
      })?
      .len();
    let in_flight_frames = usize::from(self.in_flight.is_some());
    let in_flight_bytes = self.in_flight.as_ref().map_or(0, |inf| inf.bytes);
    if self.fifo.len() + in_flight_frames >= MAX_OBSERVER_FRAME_FIFO
      || self.fifo_bytes + in_flight_bytes + bytes > MAX_OBSERVER_FIFO_BYTES
    {
      return Err(BridgeError::new(
        "OBSERVER_OVERFLOW",
        "observation event queue bounds exceeded",
        "unconfirmed",
      ));
    }
    self.fifo.push_back(ObserverFrame { frame, bytes, terminal });
    self.fifo_bytes += bytes;
    Ok(())
  }
}

struct SessionState {
  generation: u64,
  ready: bool,
  closing: bool,
  failed: Option<BridgeError>,
  child: Arc<Mutex<Option<Child>>>,
  writer_tx: Option<SyncSender<WriteJob>>,
  pending: HashMap<String, PendingEntry>,
  observers: HashMap<String, ObserverState>,
}

impl SessionState {
  fn is_healthy(&self) -> bool {
    !self.closing && self.failed.is_none() && self.writer_tx.is_some()
  }

  // A spawned session only becomes ready after the init handshake; public
  // requests must not run against a session that is still initializing.
  fn is_ready(&self) -> bool {
    self.ready && self.is_healthy()
  }
}

#[derive(Clone)]
pub struct DesktopBridge {
  inner: Arc<BridgeInner>,
}

struct BridgeInner {
  next_generation: AtomicU64,
  next_request_seq: AtomicU64,
  next_observer_nonce: AtomicU64,
  shutting_down: AtomicBool,
  spawn_lock: tokio::sync::Mutex<()>,
  launch_gate: Mutex<()>,
  session: Mutex<Option<Arc<Mutex<SessionState>>>>,
}

impl Default for DesktopBridge {
  fn default() -> Self {
    Self::new()
  }
}

impl DesktopBridge {
  pub fn new() -> Self {
    Self {
      inner: Arc::new(BridgeInner {
        next_generation: AtomicU64::new(1),
        next_request_seq: AtomicU64::new(1),
        next_observer_nonce: AtomicU64::new(1),
        shutting_down: AtomicBool::new(false),
        spawn_lock: tokio::sync::Mutex::new(()),
        launch_gate: Mutex::new(()),
        session: Mutex::new(None),
      }),
    }
  }

  pub async fn request(
    &self,
    app: &AppHandle,
    op: &str,
    params: Value,
  ) -> Result<Value, BridgeError> {
    if op == OBSERVE_ACK_OP {
      // Local-only flow-control ack; never forwarded to the Node child.
      return self.handle_observe_ack(params);
    }
    if !is_public_operation(op) {
      return Err(BridgeError::new(
        "INVALID_ARGUMENT",
        "unsupported desktop broker operation",
        "not-sent",
      ));
    }
    if !params.is_object() {
      return Err(BridgeError::new(
        "INVALID_ARGUMENT",
        "request params must be a JSON object",
        "not-sent",
      ));
    }
    let session = self.ensure_session(app).await?;
    self.dispatch_request(&session, op, params).await
  }

  pub(crate) async fn request_with_session_generation(
    &self,
    app: &AppHandle,
    op: &str,
  ) -> Result<(u64, Value), BridgeError> {
    let session = self.ensure_session(app).await?;
    let generation = session.lock().unwrap().generation;
    let result = self.dispatch_request(&session, op, json!({})).await?;
    Ok((generation, result))
  }

  pub async fn observe(
    &self,
    app: &AppHandle,
    observation_id: String,
    target_device_id: String,
    target: Value,
    on_event: Channel<Value>,
  ) -> Result<DesktopObserveAck, BridgeError> {
    validate_non_empty_id(&observation_id, "observationId")?;
    validate_non_empty_id(&target_device_id, "targetDeviceId")?;
    if !target.is_object() {
      return Err(BridgeError::new(
        "INVALID_ARGUMENT",
        "observe target must be a JSON object",
        "not-sent",
      ));
    }

    let connection = target.get("kind").and_then(Value::as_str) == Some("connection");
    let session = self.ensure_session(app).await?;
    {
      let mut guard = session.lock().unwrap();
      if !guard.is_ready() {
        return Err(
          guard
            .failed
            .clone()
            .unwrap_or_else(|| BridgeError::new("DISCONNECTED", "desktop client unavailable", "not-sent")),
        );
      }
      if guard.observers.contains_key(&observation_id) {
        return Err(BridgeError::new(
          "INVALID_ARGUMENT",
          "duplicate observationId",
          "not-sent",
        ));
      }
      if (connection && guard.observers.values().any(|o| o.connection))
        || (!connection && guard.observers.values().filter(|o| !o.connection).count() >= MAX_OBSERVERS) {
        return Err(BridgeError::new(
          "RPC_BUSY",
          "maximum active observations reached",
          "not-sent",
        ));
      }
      // Install event routing before dispatching observe so initial snapshots cannot be lost.
      // Allocate a unique observer nonce so deliveryIds stay unique across
      // observer instances and session replacements (late ack can never match
      // a different observer's in-flight frame).
      let instance_nonce = self.inner.next_observer_nonce.fetch_add(1, Ordering::SeqCst);
      // Capture generation into a local before the insert so the MutexGuard's
      // DerefMut borrow is not active while reading a field from the same guard.
      let session_generation = guard.generation;
      guard.observers.insert(
        observation_id.clone(),
        ObserverState::new(on_event, session_generation, instance_nonce, connection),
      );
    }

    let params = json!({
      "observationId": observation_id,
      "targetDeviceId": target_device_id,
      "target": target,
    });

    match self.dispatch_request(&session, "observe", params).await {
      Ok(_) => Ok(DesktopObserveAck { observation_id }),
      Err(err) => {
        let mut guard = session.lock().unwrap();
        guard.observers.remove(&observation_id);
        Err(err)
      }
    }
  }

  pub async fn unobserve(
    &self,
    _app: &AppHandle,
    observation_id: String,
  ) -> Result<(), BridgeError> {
    validate_non_empty_id(&observation_id, "observationId")?;
    let maybe_session = { self.inner.session.lock().unwrap().clone() };
    let Some(session) = maybe_session else {
      return Ok(());
    };
    {
      let mut guard = session.lock().unwrap();
      guard.observers.remove(&observation_id);
      if !guard.is_ready() {
        return Ok(());
      }
    }
    let params = json!({ "observationId": observation_id });
    match self.dispatch_request(&session, "unobserve", params).await {
      Ok(_) => Ok(()),
      Err(err) if err.code == "DISCONNECTED" || err.code == "NOT_CONNECTED" => Ok(()),
      Err(err) => Err(err),
    }
  }

  // Local-only flow-control ack for observation delivery. Idempotent; never
  // spawns or forwards to the Node child. Returns {acknowledged:boolean}.
  fn handle_observe_ack(&self, params: Value) -> Result<Value, BridgeError> {
    let obj = params.as_object().ok_or_else(|| {
      BridgeError::new("INVALID_ARGUMENT", "observe_ack params must be a JSON object", "not-sent")
    })?;
    // Strict schema: no extra fields are accepted.
    for key in obj.keys() {
      if key != "observationId" && key != "deliveryId" {
        return Err(BridgeError::new(
          "INVALID_ARGUMENT",
          format!("observe_ack unexpected field: {}", key),
          "not-sent",
        ));
      }
    }
    let observation_id = obj.get("observationId").and_then(Value::as_str).ok_or_else(|| {
      BridgeError::new("INVALID_ARGUMENT", "observe_ack missing observationId", "not-sent")
    })?;
    let delivery_id = obj.get("deliveryId").and_then(Value::as_str).ok_or_else(|| {
      BridgeError::new("INVALID_ARGUMENT", "observe_ack missing deliveryId", "not-sent")
    })?;
    validate_non_empty_id(observation_id, "observationId")?;
    if delivery_id.trim().is_empty() || delivery_id.len() > 256 {
      return Err(BridgeError::new(
        "INVALID_ARGUMENT",
        "deliveryId must be a non-empty string of at most 256 bytes",
        "not-sent",
      ));
    }

    let maybe_session = { self.inner.session.lock().unwrap().clone() };
    let Some(session) = maybe_session else {
      return Ok(json!({ "acknowledged": false }));
    };

    let mut acknowledged = false;
    let mut terminal = false;
    {
      let mut guard = session.lock().unwrap();
      let Some(state) = guard.observers.get_mut(observation_id) else {
        return Ok(json!({ "acknowledged": false }));
      };
      match state.in_flight.as_ref() {
        Some(inf) if inf.delivery_id == delivery_id => {
          acknowledged = true;
          terminal = inf.terminal;
          state.in_flight = None;
        }
        _ => { /* stale/late/unknown deliveryId: idempotent no-op */ }
      }
      if terminal {
        guard.observers.remove(observation_id);
      }
    }
    if acknowledged && !terminal {
      // Advance the bounded FIFO now that the previous event is acked.
      if pump_observation_channel(&session, observation_id).is_err() {
        let err =
          BridgeError::new("DISCONNECTED", "failed to deliver observation event", "unconfirmed");
        teardown_session(&self.inner, &session, err.clone());
        return Err(err);
      }
    }
    Ok(json!({ "acknowledged": acknowledged }))
  }

  pub fn shutdown(&self) {
    // Take the launch gate so spawn/publish cannot race between the shutdown
    // check and session publication; release it before tearing down so the
    // teardown child mutex is never held while waiting on the gate.
    let _gate = self.inner.launch_gate.lock().unwrap();
    self.inner.shutting_down.store(true, Ordering::SeqCst);
    let session = { self.inner.session.lock().unwrap().take() };
    drop(_gate);
    if let Some(session) = session {
      teardown_session(
        &self.inner,
        &session,
        BridgeError::new("DISCONNECTED", "desktop application shutting down", "unconfirmed"),
      );
    }
  }

  async fn ensure_session(&self, app: &AppHandle) -> Result<Arc<Mutex<SessionState>>, BridgeError> {
    if self.inner.shutting_down.load(Ordering::SeqCst) {
      return Err(BridgeError::new(
        "DISCONNECTED",
        "desktop bridge is shutting down",
        "not-sent",
      ));
    }

    if let Some(existing) = self.current_healthy_session() {
      return Ok(existing);
    }

    let _guard = self.inner.spawn_lock.lock().await;
    if self.inner.shutting_down.load(Ordering::SeqCst) {
      return Err(BridgeError::new(
        "DISCONNECTED",
        "desktop bridge is shutting down",
        "not-sent",
      ));
    }
    if let Some(existing) = self.current_healthy_session() {
      return Ok(existing);
    }

    // The launch gate makes the shutdown check + spawn + publish atomic, so a
    // concurrent shutdown cannot observe None between spawn and publish. The
    // lock lives only inside this lexical block; init is awaited after the
    // gate is released.
    let (session, data_root_str) = {
      let _launch = self.inner.launch_gate.lock().unwrap();
      if self.inner.shutting_down.load(Ordering::SeqCst) {
        return Err(BridgeError::new(
          "DISCONNECTED",
          "desktop bridge is shutting down",
          "not-sent",
        ));
      }

      let stale = { self.inner.session.lock().unwrap().take() };
      if let Some(old) = stale {
        teardown_session(
          &self.inner,
          &old,
          BridgeError::new("DISCONNECTED", "replacing terminated client session", "unconfirmed"),
        );
      }

      let data_root_str = resolve_client_data_root(app)?;
      let generation = self.inner.next_generation.fetch_add(1, Ordering::SeqCst);
      let session = spawn_supervised_session(Arc::clone(&self.inner), app, generation, &data_root_str)?;

      {
        let mut slot = self.inner.session.lock().unwrap();
        *slot = Some(Arc::clone(&session));
      }
      (session, data_root_str)
    };

    let init_params = json!({
      "dataRoot": data_root_str,
    });

    if let Err(err) = self.dispatch_request(&session, "init", init_params).await {
      teardown_session(&self.inner, &session, err.clone());
      return Err(err);
    }

    // Post-init publication check: mark ready only if the session is still the
    // published one and the bridge is not shutting down.
    let shutting_down = self.inner.shutting_down.load(Ordering::SeqCst);
    {
      let slot = self.inner.session.lock().unwrap();
      let still_published = match slot.as_ref() {
        Some(active) => Arc::ptr_eq(active, &session),
        None => false,
      };
      if shutting_down || !still_published {
        drop(slot);
        teardown_session(
          &self.inner,
          &session,
          BridgeError::new("DISCONNECTED", "desktop bridge is shutting down", "unconfirmed"),
        );
        return Err(BridgeError::new(
          "DISCONNECTED",
          "desktop bridge is shutting down",
          "not-sent",
        ));
      }
      session.lock().unwrap().ready = true;
    }
    Ok(session)
  }

  fn current_healthy_session(&self) -> Option<Arc<Mutex<SessionState>>> {
    let slot = self.inner.session.lock().unwrap();
    let session = slot.as_ref()?;
    let guard = session.lock().unwrap();
    if guard.is_ready() {
      Some(Arc::clone(session))
    } else {
      None
    }
  }

  async fn dispatch_request(
    &self,
    session: &Arc<Mutex<SessionState>>,
    op: &str,
    params: Value,
  ) -> Result<Value, BridgeError> {
    let req_seq = self.inner.next_request_seq.fetch_add(1, Ordering::SeqCst);
    let generation = {
      let guard = session.lock().unwrap();
      guard.generation
    };
    let request_id = format!("req-{generation}-{req_seq}");
    let deadline = response_timeout(op, &params);

    let payload = json!({
      "type": "request",
      "id": request_id,
      "op": op,
      "params": params,
    });
    let mut bytes = serde_json::to_vec(&payload).map_err(|_| {
      BridgeError::new(
        "INVALID_JSON",
        "failed to serialize broker request",
        "not-sent",
      )
    })?;
    if bytes.len() > MAX_LINE_BYTES {
      return Err(BridgeError::new(
        "REQUEST_TOO_LARGE",
        "broker request exceeds 40 MiB line cap",
        "not-sent",
      ));
    }
    bytes.push(b'\n');

    let written = Arc::new(AtomicBool::new(false));
    let (resp_tx, resp_rx) = oneshot::channel();
    let (write_ack_tx, write_ack_rx) = oneshot::channel();

    let job = WriteJob {
      id: request_id.clone(),
      line: bytes,
      written: Arc::clone(&written),
      write_ack: Some(write_ack_tx),
    };

    // Publish the pending entry and enqueue the job atomically under the session
    // lock so a concurrent teardown can neither strand the job nor misreport
    // backpressure on a session that just closed.
    {
      let mut guard = session.lock().unwrap();
      if !guard.is_healthy() {
        return Err(
          guard
            .failed
            .clone()
            .unwrap_or_else(|| BridgeError::new("DISCONNECTED", "desktop client unavailable", "not-sent")),
        );
      }
      if guard.pending.len() >= MAX_PENDING_CALLS {
        return Err(BridgeError::new(
          "RPC_BUSY",
          "maximum in-flight broker requests reached",
          "not-sent",
        ));
      }
      let Some(writer_tx) = guard.writer_tx.clone() else {
        return Err(BridgeError::new(
          "DISCONNECTED",
          "desktop client stdin closed",
          "not-sent",
        ));
      };
      guard.pending.insert(
        request_id.clone(),
        PendingEntry {
          written: Arc::clone(&written),
          tx: Some(resp_tx),
        },
      );
      if writer_tx.try_send(job).is_err() {
        guard.pending.remove(&request_id);
        return Err(BridgeError::new(
          "BACKPRESSURE",
          "desktop client writer queue is full",
          "not-sent",
        ));
      }
    }

    match tokio::time::timeout(WRITE_TIMEOUT, write_ack_rx).await {
      Ok(Ok(Ok(()))) => {}
      Ok(Ok(Err(err))) => {
        teardown_session(&self.inner, session, err.clone());
        return Err(err);
      }
      Ok(Err(_)) | Err(_) => {
        // Removing the pending entry and reading `written` happen under the same
        // lock as the writer's claim, so a revoked queued job that was never
        // sent cannot be reported as sent (not-sent vs unconfirmed).
        let outcome = {
          let mut guard = session.lock().unwrap();
          guard.pending.remove(&request_id);
          if written.load(Ordering::SeqCst) {
            "unconfirmed"
          } else {
            "not-sent"
          }
        };
        let err = BridgeError::new("TIMEOUT", "broker request write timed out", outcome);
        teardown_session(&self.inner, session, err.clone());
        return Err(err);
      }
    }

    match tokio::time::timeout(deadline, resp_rx).await {
      Ok(Ok(result)) => result,
      Ok(Err(_)) => {
        let outcome = if written.load(Ordering::SeqCst) {
          "unconfirmed"
        } else {
          "not-sent"
        };
        Err(BridgeError::new(
          "DISCONNECTED",
          "broker session closed before response",
          outcome,
        ))
      }
      Err(_) => {
        let err = BridgeError::new(
          "TIMEOUT",
          "broker response deadline exceeded",
          "unconfirmed",
        );
        teardown_session(&self.inner, session, err.clone());
        Err(err)
      }
    }
  }
}

fn is_public_operation(op: &str) -> bool {
  PUBLIC_OPERATIONS.contains(&op)
}

/// Only the eight Hindsight methods get the long deadline; every other op keeps
/// RESPONSE_TIMEOUT (no broad relaxation). The broker carries them as op=call
/// with params.method = control method.
fn response_timeout(op: &str, params: &Value) -> Duration {
  if op == "call" {
    if let Some(method) = params.get("method").and_then(Value::as_str) {
      if MEMORY_METHODS.contains(&method) {
        return MEMORY_RESPONSE_TIMEOUT;
      }
    }
  }
  RESPONSE_TIMEOUT
}

fn validate_non_empty_id(value: &str, name: &str) -> Result<(), BridgeError> {
  if value.trim().is_empty() || value.len() > 256 {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      format!("{name} must be a non-empty string of at most 256 bytes"),
      "not-sent",
    ));
  }
  Ok(())
}

pub(crate) fn resolve_client_data_root(app: &AppHandle) -> Result<String, BridgeError> {
  #[cfg(debug_assertions)]
  if let Some(override_root) = std::env::var_os("E_LAUNCHER_DESKTOP_DATA_ROOT") {
    let path = PathBuf::from(override_root);
    if !path.is_absolute() {
      return Err(BridgeError::new(
        "INVALID_ARGUMENT",
        "E_LAUNCHER_DESKTOP_DATA_ROOT must be an absolute path",
        "not-sent",
      ));
    }
    fs::create_dir_all(&path).map_err(|_| {
      BridgeError::new(
        "STORE_FAILED",
        "failed to create override desktop data root",
        "not-sent",
      )
    })?;
    return path_to_utf8_string(&dunce::simplified(&path));
  }

  let base = app.path().app_local_data_dir().map_err(|_| {
    BridgeError::new(
      "STORE_FAILED",
      "failed to resolve appLocalDataDir",
      "not-sent",
    )
  })?;
  let client_root = base.join("client");
  fs::create_dir_all(&client_root).map_err(|_| {
    BridgeError::new(
      "STORE_FAILED",
      "failed to create private client data directory",
      "not-sent",
    )
  })?;
  path_to_utf8_string(&dunce::simplified(&client_root))
}

fn resolve_sidecar_executable() -> Result<PathBuf, BridgeError> {
  let exe_path = platform::current_exe().map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "failed to resolve current executable path",
      "not-sent",
    )
  })?;
  let exe_dir = exe_path.parent().ok_or_else(|| {
    BridgeError::new(
      "INTERNAL",
      "current executable has no parent directory",
      "not-sent",
    )
  })?;
  let base_dir = if exe_dir.ends_with("deps") {
    exe_dir.parent().unwrap_or(exe_dir)
  } else {
    exe_dir
  };

  let mut sidecar = base_dir.join(SIDECAR_NAME);
  #[cfg(windows)]
  {
    if sidecar.extension().is_none_or(|ext| ext != "exe") {
      sidecar.as_mut_os_string().push(".exe");
    }
  }
  #[cfg(not(windows))]
  {
    if sidecar.extension().is_some_and(|ext| ext == "exe") {
      sidecar.set_extension("");
    }
  }

  let meta = fs::symlink_metadata(&sidecar).map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "bundled Node sidecar binary is missing",
      "not-sent",
    )
  })?;
  if !meta.file_type().is_file() {
    return Err(BridgeError::new(
      "INTERNAL",
      "bundled Node sidecar binary must be a regular file",
      "not-sent",
    ));
  }
  Ok(sidecar)
}

fn resolve_client_script(app: &AppHandle) -> Result<PathBuf, BridgeError> {
  let resource_dir = app.path().resource_dir().map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "failed to resolve resource directory",
      "not-sent",
    )
  })?;
  let script_path = resource_dir.join(CLIENT_SCRIPT_NAME);
  let meta = fs::symlink_metadata(&script_path).map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "bundled desktop-client.mjs resource is missing",
      "not-sent",
    )
  })?;
  if !meta.file_type().is_file() {
    return Err(BridgeError::new(
      "INTERNAL",
      "bundled desktop-client.mjs resource must be a regular file",
      "not-sent",
    ));
  }
  Ok(script_path)
}

fn spawn_supervised_session(
  bridge_inner: Arc<BridgeInner>,
  app: &AppHandle,
  generation: u64,
  data_root_str: &str,
) -> Result<Arc<Mutex<SessionState>>, BridgeError> {
  let node_bin = resolve_sidecar_executable()?;
  let script_path = resolve_client_script(app)?;
  let data_root_path = PathBuf::from(data_root_str);
  let private_home = data_root_path.join("home");
  let private_tmp = data_root_path.join("tmp");
  fs::create_dir_all(&private_home).map_err(|_| {
    BridgeError::new(
      "STORE_FAILED",
      "failed to create private HOME directory",
      "not-sent",
    )
  })?;
  fs::create_dir_all(&private_tmp).map_err(|_| {
    BridgeError::new(
      "STORE_FAILED",
      "failed to create private TMPDIR directory",
      "not-sent",
    )
  })?;

  let mut cmd = Command::new(&node_bin);
  cmd.arg(&script_path);
  cmd.current_dir(&data_root_path);
  cmd.env_clear();
  cmd.env("HOME", &private_home);
  cmd.env("USERPROFILE", &private_home);
  cmd.env("TMPDIR", &private_tmp);
  cmd.env("TMP", &private_tmp);
  cmd.env("TEMP", &private_tmp);

  if let Some(path_val) = std::env::var_os("PATH") {
    cmd.env("PATH", path_val);
  }
  #[cfg(windows)]
  {
    for key in ["SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "ComSpec"] {
      if let Some(val) = std::env::var_os(key) {
        cmd.env(key, val);
      }
    }
    cmd.creation_flags(CREATE_NO_WINDOW);
  }

  cmd.stdin(Stdio::piped());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::null());

  let mut child = cmd.spawn().map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "failed to spawn bundled Node client process",
      "not-sent",
    )
  })?;

  let stdin = child.stdin.take().ok_or_else(|| {
    let _ = child.kill();
    let _ = child.wait();
    BridgeError::new("INTERNAL", "failed to open child stdin", "not-sent")
  })?;
  let stdout = child.stdout.take().ok_or_else(|| {
    let _ = child.kill();
    let _ = child.wait();
    BridgeError::new("INTERNAL", "failed to open child stdout", "not-sent")
  })?;

  let (writer_tx, writer_rx) = mpsc::sync_channel::<WriteJob>(WRITER_QUEUE_CAP);
  let child_arc = Arc::new(Mutex::new(Some(child)));

  let session = Arc::new(Mutex::new(SessionState {
    generation,
    ready: false,
    closing: false,
    failed: None,
    child: Arc::clone(&child_arc),
    writer_tx: Some(writer_tx),
    pending: HashMap::new(),
    observers: HashMap::new(),
  }));

  spawn_writer_thread(
    Arc::clone(&bridge_inner),
    Arc::clone(&session),
    stdin,
    writer_rx,
  );
  spawn_reader_thread(
    Arc::clone(&bridge_inner),
    Arc::clone(&session),
    stdout,
  );

  Ok(session)
}

fn spawn_writer_thread(
  bridge_inner: Arc<BridgeInner>,
  session: Arc<Mutex<SessionState>>,
  mut stdin: ChildStdin,
  rx: mpsc::Receiver<WriteJob>,
) {
  thread::spawn(move || {
    while let Ok(job) = rx.recv() {
      // Claim the write under the session lock: send only while the session is
      // healthy and the job is still pending (not revoked by a write timeout).
      // Marking `written` before the actual write keeps timeout outcomes
      // conservative (unconfirmed whenever the write may have been attempted).
      let claimed = {
        let guard = session.lock().unwrap();
        if guard.is_healthy() && guard.pending.contains_key(&job.id) {
          job.written.store(true, Ordering::SeqCst);
          true
        } else {
          false
        }
      };
      if !claimed {
        // Revoked or session closed: never send. Ack so the awaiting caller
        // fails fast instead of hanging until its write timeout.
        if let Some(ack) = job.write_ack {
          let err = BridgeError::new(
            "DISCONNECTED",
            "desktop client session closed before write",
            "not-sent",
          );
          let _ = ack.send(Err(err));
        }
        continue;
      }

      let start = Instant::now();
      let write_res = stdin.write_all(&job.line).and_then(|_| stdin.flush());
      match write_res {
        Ok(()) => {
          if start.elapsed() > WRITE_TIMEOUT {
            let err = BridgeError::new("TIMEOUT", "child stdin write exceeded deadline", "unconfirmed");
            if let Some(ack) = job.write_ack {
              let _ = ack.send(Err(err.clone()));
            }
            teardown_session(&bridge_inner, &session, err);
            break;
          }
          if let Some(ack) = job.write_ack {
            let _ = ack.send(Ok(()));
          }
        }
        Err(_) => {
          let err = BridgeError::new("DISCONNECTED", "failed to write to child stdin", "unconfirmed");
          if let Some(ack) = job.write_ack {
            let _ = ack.send(Err(err.clone()));
          }
          teardown_session(&bridge_inner, &session, err);
          break;
        }
      }
    }
  });
}

fn spawn_reader_thread(
  bridge_inner: Arc<BridgeInner>,
  session: Arc<Mutex<SessionState>>,
  stdout: ChildStdout,
) {
  thread::spawn(move || {
    let mut reader = BufReader::new(stdout);
    loop {
      let mut line_bytes = Vec::new();
      match read_bounded_line(&mut reader, &mut line_bytes, MAX_LINE_BYTES) {
        Ok(0) => {
          teardown_session(
            &bridge_inner,
            &session,
            BridgeError::new("DISCONNECTED", "desktop client process closed stdout", "unconfirmed"),
          );
          break;
        }
        Ok(_) => {
          let Ok(line_str) = std::str::from_utf8(&line_bytes) else {
            teardown_session(
              &bridge_inner,
              &session,
              BridgeError::new("INVALID_UTF8", "child stdout emitted invalid UTF-8", "unconfirmed"),
            );
            break;
          };
          let trimmed = line_str.trim_end_matches(['\r', '\n']);
          if trimmed.is_empty() {
            teardown_session(
              &bridge_inner,
              &session,
              BridgeError::new("BAD_FRAME", "child stdout emitted empty frame", "unconfirmed"),
            );
            break;
          }
          let Ok(frame) = serde_json::from_str::<Value>(trimmed) else {
            teardown_session(
              &bridge_inner,
              &session,
              BridgeError::new("INVALID_JSON", "child stdout emitted invalid JSON", "unconfirmed"),
            );
            break;
          };
          if let Err(err) = handle_stdout_frame(&bridge_inner, &session, frame) {
            teardown_session(&bridge_inner, &session, err);
            break;
          }
        }
        Err(err) => {
          teardown_session(&bridge_inner, &session, err);
          break;
        }
      }
    }
  });
}

fn read_bounded_line<R: BufRead>(
  reader: &mut R,
  out: &mut Vec<u8>,
  max_bytes: usize,
) -> Result<usize, BridgeError> {
  let mut total = 0usize;
  loop {
    let available = reader.fill_buf().map_err(|_| {
      BridgeError::new("DISCONNECTED", "failed to read child stdout", "unconfirmed")
    })?;
    if available.is_empty() {
      return Ok(total);
    }
    if let Some(newline_pos) = available.iter().position(|&b| b == b'\n') {
      let chunk_len = newline_pos + 1;
      if total + chunk_len > max_bytes {
        reader.consume(chunk_len);
        return Err(BridgeError::new(
          "RESPONSE_TOO_LARGE",
          "child stdout line exceeds 40 MiB limit",
          "unconfirmed",
        ));
      }
      out.extend_from_slice(&available[..chunk_len]);
      reader.consume(chunk_len);
      total += chunk_len;
      return Ok(total);
    } else {
      let chunk_len = available.len();
      if total + chunk_len > max_bytes {
        reader.consume(chunk_len);
        return Err(BridgeError::new(
          "RESPONSE_TOO_LARGE",
          "child stdout line exceeds 40 MiB limit",
          "unconfirmed",
        ));
      }
      out.extend_from_slice(available);
      reader.consume(chunk_len);
      total += chunk_len;
    }
  }
}

fn handle_stdout_frame(
  bridge_inner: &BridgeInner,
  session: &Arc<Mutex<SessionState>>,
  frame: Value,
) -> Result<(), BridgeError> {
  let Some(obj) = frame.as_object() else {
    return Err(BridgeError::new(
      "BAD_FRAME",
      "child frame must be a JSON object",
      "unconfirmed",
    ));
  };
  let Some(frame_type) = obj.get("type").and_then(Value::as_str) else {
    return Err(BridgeError::new(
      "BAD_FRAME",
      "child frame missing type",
      "unconfirmed",
    ));
  };

  // Generation fence: ignore or abort if this session is no longer active.
  if !is_session_current(bridge_inner, session) {
    return Ok(());
  }

  match frame_type {
    "response" => {
      let Some(id) = obj.get("id").and_then(Value::as_str) else {
        return Err(BridgeError::new(
          "BAD_FRAME",
          "response frame missing id",
          "unconfirmed",
        ));
      };
      let Some(ok) = obj.get("ok").and_then(Value::as_bool) else {
        return Err(BridgeError::new(
          "BAD_FRAME",
          "response frame missing boolean ok",
          "unconfirmed",
        ));
      };

      let result = if ok {
        let Some(res_val) = obj.get("result") else {
          return Err(BridgeError::new(
            "BAD_FRAME",
            "ok response missing result",
            "unconfirmed",
          ));
        };
        Ok(res_val.clone())
      } else {
        let Some(err_obj) = obj.get("error").and_then(Value::as_object) else {
          return Err(BridgeError::new(
            "BAD_FRAME",
            "error response missing error object",
            "unconfirmed",
          ));
        };
        let code = err_obj
          .get("code")
          .and_then(Value::as_str)
          .ok_or_else(|| BridgeError::new("BAD_FRAME", "error missing code", "unconfirmed"))?;
        let message = err_obj
          .get("message")
          .and_then(Value::as_str)
          .ok_or_else(|| BridgeError::new("BAD_FRAME", "error missing message", "unconfirmed"))?;
        let outcome = err_obj
          .get("outcome")
          .and_then(Value::as_str)
          .ok_or_else(|| BridgeError::new("BAD_FRAME", "error missing outcome", "unconfirmed"))?;
        Err(BridgeError::new(code, message, outcome))
      };

      let maybe_tx = {
        let mut guard = session.lock().unwrap();
        guard.pending.remove(id).and_then(|mut entry| entry.tx.take())
      };
      if let Some(tx) = maybe_tx {
        let _ = tx.send(result);
      }
      Ok(())
    }
    "event" => {
      // Copy the short id to an owned String so the borrow on `frame` ends
      // before the frame is moved into the observer FIFO below.
      let observation_id = obj
        .get("observationId")
        .and_then(Value::as_str)
        .ok_or_else(|| BridgeError::new("BAD_FRAME", "event frame missing observationId", "unconfirmed"))?
        .to_string();
      let has_frame = obj.contains_key("frame");
      let has_error = obj.contains_key("error");
      if has_frame == has_error {
        return Err(BridgeError::new(
          "BAD_FRAME",
          "event frame must carry exactly one of frame or error",
          "unconfirmed",
        ));
      }
      let is_terminal = has_error
        || obj
          .get("frame")
          .and_then(Value::as_object)
          .and_then(|f| f.get("type"))
          .and_then(Value::as_str)
          == Some("end");

      // Enqueue into the bounded per-observation FIFO, then pump the next frame
      // when the in-flight event has been acked. Terminal frames stay until
      // they are delivered and acked; no frame is dropped or merged.
      {
        let mut guard = session.lock().unwrap();
        let Some(state) = guard.observers.get_mut(&observation_id) else {
          return Ok(());
        };
        state.enqueue(frame, is_terminal)?;
      }
      match pump_observation_channel(session, &observation_id) {
        Ok(()) => Ok(()),
        Err(()) => {
          let err =
            BridgeError::new("DISCONNECTED", "failed to deliver observation event", "unconfirmed");
          teardown_session(bridge_inner, session, err);
          Ok(())
        }
      }
    }
    _ => Err(BridgeError::new(
      "BAD_FRAME",
      "unknown frame type from child",
      "unconfirmed",
    )),
  }
}

fn is_session_current(bridge_inner: &BridgeInner, session: &Arc<Mutex<SessionState>>) -> bool {
  // Generation fence: only a session that is still the published one may
  // deliver frames to the UI.
  let session_gen = session.lock().unwrap().generation;
  let slot = bridge_inner.session.lock().unwrap();
  match slot.as_ref() {
    Some(active) => active.lock().unwrap().generation == session_gen,
    // During initial `init` handshake before session is stored in `bridge_inner.session`,
    // generation matches the latest allocated generation.
    None => bridge_inner.next_generation.load(Ordering::SeqCst) == session_gen + 1,
  }
}

// Deliver the next FIFO frame for an observation when no event is in flight.
// The observer is removed after exactly one in-flight event; the terminal frame
// therefore stays in the FIFO until acked, then the observer entry disappears.
fn pump_observation_channel(
  session: &Arc<Mutex<SessionState>>,
  observation_id: &str,
) -> Result<(), ()> {
  let (frame, channel) = {
    let mut guard = session.lock().unwrap();
    let Some(state) = guard.observers.get_mut(observation_id) else {
      return Ok(());
    };
    if state.in_flight.is_some() {
      return Ok(());
    }
    let Some(next) = state.fifo.pop_front() else {
      return Ok(());
    };
    state.fifo_bytes -= next.bytes;
    let delivery_id = format!(
      "g{}-o{}-d{}",
      state.generation, state.instance_nonce, state.next_delivery_seq
    );
    state.next_delivery_seq += 1;
    let mut frame = next.frame;
    frame["deliveryId"] = Value::String(delivery_id.clone());
    // Mark in-flight before the actual send; delivery outcome stays unknown
    // until acked, and a failed send fails closed the client session.
    state.in_flight = Some(InflightObservationEvent {
      delivery_id,
      terminal: next.terminal,
      bytes: next.bytes,
    });
    (frame, state.channel.clone())
  };

  if channel.send(frame).is_err() {
    return Err(());
  }
  Ok(())
}

fn teardown_session(
  bridge_inner: &BridgeInner,
  session: &Arc<Mutex<SessionState>>,
  reason: BridgeError,
) {
  let (pending_map, observers_map, child_arc, session_gen, first) = {
    let mut guard = session.lock().unwrap();
    if guard.closing {
      // A concurrent teardown already closed this session; still wait for the
      // shared child reap below.
      (
        HashMap::new(),
        HashMap::new(),
        Arc::clone(&guard.child),
        guard.generation,
        false,
      )
    } else {
      guard.closing = true;
      guard.failed = Some(reason.clone());
      guard.writer_tx = None;
      let pending = std::mem::take(&mut guard.pending);
      let observers = std::mem::take(&mut guard.observers);
      (pending, observers, Arc::clone(&guard.child), guard.generation, true)
    }
  };

  if first {
    for (_, mut entry) in pending_map {
      if let Some(tx) = entry.tx.take() {
        let outcome = if entry.written.load(Ordering::SeqCst) {
          "unconfirmed"
        } else {
          "not-sent"
        };
        let _ = tx.send(Err(BridgeError::new(
          &reason.code,
          reason.message.clone(),
          outcome,
        )));
      }
    }

    for (observation_id, state) in observers_map {
      // Small terminal error; no deliveryId required.
      let event = json!({
        "type": "event",
        "observationId": observation_id,
        "error": {
          "code": reason.code,
          "message": reason.message,
          "outcome": "unconfirmed",
        }
      });
      let _ = state.channel.send(event);
    }
  }

  // Kill and reap the child under the child mutex, outside the session/global
  // locks. Holding the mutex across kill/wait makes concurrent teardown and
  // replacement startup deterministically wait for this same child's reaping
  // (the former detached thread left an exit race).
  {
    let mut child_guard = child_arc.lock().unwrap();
    if let Some(mut child) = child_guard.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
  }

  // Clear the shared slot only after this child has been fully reaped, so a
  // concurrent ensure_session waiting on the child mutex cannot observe None
  // and spawn a replacement before the old child is gone. Guarded by Arc
  // identity/generation so a session published meanwhile is never cleared.
  if first {
    let mut slot = bridge_inner.session.lock().unwrap();
    if let Some(active) = slot.as_ref() {
      if Arc::ptr_eq(active, session) || active.lock().unwrap().generation == session_gen {
        *slot = None;
      }
    }
  }
}

pub fn validate_picked_regular_file(path: &Path) -> Result<PickedFileRef, BridgeError> {
  if !path.is_absolute() {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "selected file path must be absolute",
      "not-sent",
    ));
  }
  let sym_meta = fs::symlink_metadata(path).map_err(|_| {
    BridgeError::new(
      "INVALID_ARGUMENT",
      "selected file does not exist or cannot be stat'd",
      "not-sent",
    )
  })?;
  if sym_meta.file_type().is_symlink() || !sym_meta.file_type().is_file() {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "selected path must be a regular file",
      "not-sent",
    ));
  }
  let simplified = dunce::simplified(path);
  if !simplified.is_absolute() {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "normalized file path must be absolute",
      "not-sent",
    ));
  }
  let path_str = path_to_utf8_string(simplified)?;
  let name = simplified
    .file_name()
    .and_then(|n| n.to_str())
    .filter(|n| !n.trim().is_empty())
    .ok_or_else(|| {
      BridgeError::new(
        "INVALID_ARGUMENT",
        "selected file must have a valid UTF-8 filename",
        "not-sent",
      )
    })?
    .to_string();

  Ok(PickedFileRef {
    name,
    path: path_str,
    size: sym_meta.len(),
  })
}

fn path_to_utf8_string(path: &Path) -> Result<String, BridgeError> {
  let s = path.to_str().ok_or_else(|| {
    BridgeError::new(
      "INVALID_UTF8",
      "filesystem path must be valid UTF-8",
      "not-sent",
    )
  })?;
  if s.trim().is_empty() {
    return Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "filesystem path must not be empty",
      "not-sent",
    ));
  }
  Ok(s.to_string())
}
