//! Tauri commands that drive the bundled `pibot-host` launcher binary.
//!
//! The launcher lives next to the desktop executable (Tauri externalBin). Every
//! call runs it as a short-lived child process without a console window,
//! passes secrets (owner password, device token) through stdin only — never
//! argv or logs — and parses the single-line JSON it prints on stdout.

use std::{
  fs,
  io::{BufRead, BufReader, Read, Write},
  net::{SocketAddr, TcpStream},
  path::{Path, PathBuf},
  process::{Command, Stdio},
  sync::{mpsc, Mutex},
  thread,
  time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use serde_json::{Map, Value, json};
use tauri::{AppHandle, State, Webview, utils::platform};

use crate::{
  bridge::{self, BridgeError, DesktopBridge},
  ensure_main_webview, pairing_code,
};

const LAUNCHER_NAME: &str = "pibot-host";
/// status probes the supervisor plus the authenticated /v1/service ready check.
const STATUS_TIMEOUT: Duration = Duration::from_secs(35);
/// pair registers over HTTPS and persists config/secrets: identity read ~30s
/// + 4x60s network worst case + ~75s stop + status/ready probe per the
/// launcher's own budget (~380s), rounded up with margin.
const PAIR_TIMEOUT: Duration = Duration::from_secs(420);
/// setup-shower stops the Host, runs the native onboarding (UAC + credential
/// prompt + temporary RDP child), then restores the Host; the launcher keeps
/// its restart reserve inside this outer budget.
const SETUP_SHOWER_TIMEOUT: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How long to keep collecting stdout after the launcher exited. A detached
/// grandchild (`run`) may inherit the pipe, so EOF is not guaranteed.
const OUTPUT_GRACE: Duration = Duration::from_millis(500);
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_SECRET_BYTES: usize = 4096;
const MAX_CA_BYTES: usize = 64 * 1024;
const CA_FILE_PREFIX: &str = "center-ca-";
const CONFIG_FILE_NAME: &str = "config.json";
/// Secret-bearing variables the launcher prefers over stdin; never inherit them
/// from the desktop process so the stdin value is always the one used.
const SECRET_ENV_KEYS: &[&str] = &[
  "E_LAUNCHER_OWNER_PASSWORD",
  "E_LAUNCHER_PAIRING_SECRET",
  "E_LAUNCHER_RELAY_TOKEN",
  "E_LAUNCHER_CONTROL_TOKEN",
];
static HOST_CONTROL_LOCK: Mutex<()> = Mutex::new(());
const CONTROL_ACTIONS: &[&str] = &["start", "stop", "restart", "enable", "disable", "setup-shower", "remove"];

fn invalid(message: &str) -> BridgeError {
  BridgeError::new("INVALID_ARGUMENT", message, "not-sent")
}

fn resolve_launcher() -> Result<PathBuf, BridgeError> {
  let exe_path = platform::current_exe().map_err(|_| {
    BridgeError::new("INTERNAL", "failed to resolve current executable path", "not-sent")
  })?;
  let exe_dir = exe_path.parent().ok_or_else(|| {
    BridgeError::new("INTERNAL", "current executable has no parent directory", "not-sent")
  })?;
  let base_dir = if exe_dir.ends_with("deps") {
    exe_dir.parent().unwrap_or(exe_dir)
  } else {
    exe_dir
  };
  #[allow(unused_mut)]
  let mut launcher = base_dir.join(LAUNCHER_NAME);
  #[cfg(windows)]
  launcher.as_mut_os_string().push(".exe");
  let meta = fs::metadata(&launcher).map_err(|_| {
    BridgeError::new("HOST_LAUNCHER_MISSING", "bundled host launcher binary is missing", "not-sent")
  })?;
  if !meta.is_file() {
    return Err(BridgeError::new(
      "HOST_LAUNCHER_MISSING",
      "bundled host launcher must be a regular file",
      "not-sent",
    ));
  }
  Ok(launcher)
}

/// Runs one launcher subcommand synchronously. Call only from a blocking thread.
fn run_launcher(args: &[String], secret: Option<&str>, timeout: Duration) -> Result<Value, BridgeError> {
  run_launcher_at(&resolve_launcher()?, args, secret, timeout)
}

fn run_launcher_at(launcher: &Path, args: &[String], secret: Option<&str>, timeout: Duration) -> Result<Value, BridgeError> {
  let mut cmd = Command::new(launcher);
  cmd.args(args);
  for key in SECRET_ENV_KEYS {
    cmd.env_remove(key);
  }
  cmd.stdin(if secret.is_some() { Stdio::piped() } else { Stdio::null() });
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::null());
  #[cfg(windows)]
  cmd.creation_flags(CREATE_NO_WINDOW);

  let mut child = cmd
    .spawn()
    .map_err(|_| BridgeError::new("INTERNAL", "failed to start bundled host launcher", "not-sent"))?;

  if let Some(secret) = secret {
    if let Some(mut stdin) = child.stdin.take() {
      // A write failure means the launcher exited early; its JSON error (if any)
      // is still collected below.
      let _ = stdin
        .write_all(secret.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush());
      drop(stdin);
    }
  }

  let Some(stdout) = child.stdout.take() else {
    let _ = child.kill();
    let _ = child.wait();
    return Err(BridgeError::new("INTERNAL", "failed to open host launcher stdout", "unconfirmed"));
  };
  let (tx, rx) = mpsc::channel::<String>();
  thread::spawn(move || {
    let mut reader = BufReader::new(stdout.take(MAX_OUTPUT_BYTES));
    loop {
      let mut line = String::new();
      match reader.read_line(&mut line) {
        Ok(0) | Err(_) => break,
        Ok(_) => {
          if tx.send(line).is_err() {
            break;
          }
        }
      }
    }
  });

  let deadline = Instant::now() + timeout;
  let exit = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) => {}
      Err(_) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err(BridgeError::new("INTERNAL", "failed to wait for host launcher", "unconfirmed"));
      }
    }
    if Instant::now() >= deadline {
      let _ = child.kill();
      let _ = child.wait();
      return Err(BridgeError::new("TIMEOUT", "host launcher timed out", "unconfirmed"));
    }
    thread::sleep(POLL_INTERVAL);
  };

  let mut result: Option<Value> = None;
  let grace = Instant::now() + OUTPUT_GRACE;
  loop {
    let remaining = grace.saturating_duration_since(Instant::now());
    match rx.recv_timeout(remaining) {
      Ok(line) => {
        let trimmed = line.trim();
        if trimmed.is_empty() {
          continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
          if value.is_object() {
            result = Some(value);
            break;
          }
        }
      }
      Err(_) => break,
    }
  }

  if exit.success() {
    return result.ok_or_else(|| {
      BridgeError::new("INVALID_JSON", "host launcher returned no JSON result", "unconfirmed")
    });
  }

  let error = result.as_ref().and_then(|value| value.get("error"));
  let code = error.and_then(|e| e.get("code")).and_then(Value::as_str);
  let message = error.and_then(|e| e.get("message")).and_then(Value::as_str);
  match code {
    Some(code) => Err(BridgeError::new(
      code,
      message.unwrap_or("host launcher failed"),
      "responded",
    )),
    None => Err(BridgeError::new(
      "INTERNAL",
      match exit.code() {
        Some(n) => format!("host launcher exited with status {n}"),
        None => "host launcher terminated".to_string(),
      },
      "unconfirmed",
    )),
  }
}

async fn run_blocking<F, T: Send + 'static>(job: F) -> Result<T, BridgeError>
where
  F: FnOnce() -> Result<T, BridgeError> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(job)
    .await
    .map_err(|_| BridgeError::new("INTERNAL", "host launcher worker failed", "unconfirmed"))?
}

/// Runs a launcher subcommand without secret input (e.g. `prepare-update`,
/// `cancel-update`) for the updater coordination path.
pub(crate) async fn host_cli(args: Vec<String>, timeout: Duration) -> Result<Value, BridgeError> {
  run_blocking(move || run_launcher(&args, None, timeout)).await
}

/// macOS has no installer lifecycle around an update: the Host runs code from
/// inside PiBot.app, so it is stopped with the current launcher before `swap`
/// replaces the bundle, then the LaunchAgent is refreshed (if autostart was on)
/// and the Host restarted with the new launcher at the same path. The whole
/// sequence holds the host-control lock so no UI action interleaves. See
/// [`cycle_host_for_update`] for the rules.
#[cfg(target_os = "macos")]
pub(crate) async fn with_host_stopped<T: Send + 'static>(
  swap: impl FnOnce() -> T + Send + 'static,
) -> Result<(T, Option<String>), BridgeError> {
  run_blocking(move || {
    let _guard = HOST_CONTROL_LOCK.lock().unwrap();
    let mut launcher = |action: &str| {
      let timeout = if action == "status" { STATUS_TIMEOUT } else { control_timeout(action) };
      run_launcher(&[action.to_string()], None, timeout)
    };
    cycle_host_for_update(&mut launcher, swap)
  })
  .await
}

/// Runs one launcher subcommand and returns its JSON result.
type LauncherCall<'a> = dyn FnMut(&str) -> Result<Value, BridgeError> + 'a;

/// `stop` always runs: besides stopping a live supervisor it unloads the
/// LaunchAgent job, so launchd cannot respawn bundle code mid-swap. `swap`
/// runs only after the launcher confirmed both (see [`confirm_stopped`]);
/// otherwise this returns Err without swapping, after trying to bring a
/// previously running Host back. Restore problems after `swap` are returned
/// as a message next to its result.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn cycle_host_for_update<T>(
  launcher: &mut LauncherCall<'_>,
  swap: impl FnOnce() -> T,
) -> Result<(T, Option<String>), BridgeError> {
  let status = launcher("status")?;
  let was_running = is_running(&status);
  let autostart = status.get("autostart").and_then(Value::as_bool) == Some(true);
  if let Err(err) = launcher("stop").and_then(|result| confirm_stopped(&result)) {
    if was_running {
      let _ = launcher("start");
    }
    return Err(err);
  }
  let output = swap();
  let mut problems = Vec::new();
  let mut step = |action: &str| {
    if let Err(e) = launcher(action) {
      problems.push(format!("{action}: {}: {}", e.code, e.message));
    }
  };
  if autostart {
    step("enable");
  }
  if was_running {
    step("start");
  }
  let message = (!problems.is_empty()).then(|| format!("local Host was not fully restored ({})", problems.join("; ")));
  Ok((output, message))
}

/// A stop result only allows the swap when the supervisor exited and launchd
/// reported the LaunchAgent unloaded (`launchdLoaded: false`). A result
/// without that confirmation (an older launcher, or one that only warned
/// about the unload) is treated as a failed stop.
fn confirm_stopped(result: &Value) -> Result<(), BridgeError> {
  let stopped = result.get("status").and_then(Value::as_str) == Some("stopped");
  let unloaded = result.get("launchdLoaded").and_then(Value::as_bool) == Some(false);
  if stopped && unloaded {
    return Ok(());
  }
  Err(BridgeError::new(
    "STOP_UNCONFIRMED",
    "the launcher did not confirm that the Host stopped and its LaunchAgent is unloaded",
    "responded",
  ))
}

/// A center is addressed by its origin only: scheme, host and optional port (plain `http` only for loopback).
/// The launcher and the center build every request path themselves, so a path, query or fragment would
/// quietly redirect requests (`/subpath/api/...`) or be refused later with a different error. One trailing
/// slash is dropped, which is what the launcher stores, so the same center always compares equal.
fn validate_center_url(raw: &str) -> Result<String, BridgeError> {
  let url = raw.trim();
  if url.is_empty() || url.len() > 2048 {
    return Err(invalid("invalid center URL"));
  }
  let parsed = tauri::Url::parse(url).map_err(|_| invalid("invalid center URL"))?;
  if !parsed.username().is_empty() || parsed.password().is_some() || parsed.host_str().is_none() {
    return Err(invalid("invalid center URL"));
  }
  if parsed.query().is_some() || parsed.fragment().is_some() || parsed.path() != "/" {
    return Err(invalid("center URL must be an origin: scheme, host and optional port only"));
  }
  let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
  match parsed.scheme() {
    "https" => {}
    "http" if loopback => {}
    _ => return Err(invalid("center URL must use HTTPS")),
  }
  Ok(url.strip_suffix('/').unwrap_or(url).to_string())
}

fn validate_display_name(raw: &str) -> Result<String, BridgeError> {
  let name = raw.trim();
  let count = name.chars().count();
  if count == 0 || count > 64 || name.chars().any(char::is_control) {
    return Err(invalid("display name must be 1-64 characters"));
  }
  Ok(name.to_string())
}

fn validate_device_id(raw: &str) -> Result<String, BridgeError> {
  let id = raw.trim();
  if id.is_empty()
    || id.len() > 128
    || id.starts_with('-')
    || id.chars().any(|c| c.is_whitespace() || c.is_control())
  {
    return Err(invalid("invalid device ID"));
  }
  Ok(id.to_string())
}

fn validate_secret(value: &str, what: &str) -> Result<(), BridgeError> {
  if value.is_empty() || value.len() > MAX_SECRET_BYTES || value.contains(&['\r', '\n', '\0'][..]) {
    return Err(invalid(what));
  }
  Ok(())
}

/// The launcher resolves the registered home, including migrated Windows data.
fn reported_host_home(status: &Value) -> Option<PathBuf> {
  status.get("hostHome").and_then(Value::as_str)
    .map(PathBuf::from).filter(|path| path.is_absolute())
}

const AUTOSTART_PENDING_FILE: &str = "host-autostart-pending";

fn set_autostart_pending(data_root: &Path, pending: Option<&str>) -> Result<(), BridgeError> {
  let path = data_root.join(AUTOSTART_PENDING_FILE);
  let result = match pending {
    Some(step) => fs::write(path, step),
    None => fs::remove_file(path),
  };
  match result {
    Ok(()) => Ok(()),
    Err(err) if pending.is_none() && err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(_) => Err(BridgeError::new("STORE_FAILED", "could not save Host autostart state", "not-sent")),
  }
}

/// A center CA written to its own unique file — the previously configured CA
/// is never touched, and the launcher config simply records this path. On drop
/// the file is removed only when pairing provably failed AND config.json does
/// not reference it; ambiguous outcomes (launcher timeout after it may have
/// persisted the config, unreadable config) conservatively keep the file.
struct StagedCa {
  path: PathBuf,
  home: PathBuf,
  committed: bool,
}

impl StagedCa {
  fn commit(mut self) {
    self.committed = true;
  }

  /// True only when config.json was read and does not point at this file.
  /// A missing config counts as unreferenced; every other ambiguity (read
  /// error, unparseable JSON) reports "still referenced" so nothing committed
  /// is deleted by accident.
  fn referenced_nowhere(&self) -> bool {
    let text = match fs::read_to_string(self.home.join(CONFIG_FILE_NAME)) {
      Ok(text) => text,
      Err(e) => return e.kind() == std::io::ErrorKind::NotFound,
    };
    let config: Value = match serde_json::from_str(&text) {
      Ok(config) => config,
      Err(_) => return false,
    };
    match config.get("centerCaFile").and_then(Value::as_str) {
      Some(current) => current != self.path.to_string_lossy().as_ref(),
      None => true,
    }
  }
}

impl Drop for StagedCa {
  fn drop(&mut self) {
    if self.committed || !self.referenced_nowhere() {
      return;
    }
    let _ = fs::remove_file(&self.path);
  }
}

/// Validates the PEM and writes it under a fresh unique name in HOST_HOME via
/// create_new, so an existing CA can never be overwritten. The PEM itself is
/// neither returned nor logged — only the path flows to the launcher.
fn stage_center_ca(pem: &str, home: PathBuf) -> Result<StagedCa, BridgeError> {
  let pem = pem.trim();
  if pem.len() > MAX_CA_BYTES || !pem.contains("-----BEGIN CERTIFICATE-----") {
    return Err(invalid("invalid center CA certificate"));
  }
  fs::create_dir_all(&home)
    .map_err(|_| BridgeError::new("STORE_FAILED", "failed to create host service directory", "not-sent"))?;
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  for attempt in 0..4u32 {
    let path = home.join(format!("{CA_FILE_PREFIX}{stamp:x}-{}-{attempt}.pem", std::process::id()));
    match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(mut file) => {
        file
          .write_all(format!("{pem}\n").as_bytes())
          .map_err(|_| BridgeError::new("STORE_FAILED", "failed to write center CA file", "not-sent"))?;
        return Ok(StagedCa { path, home, committed: false });
      }
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
      Err(_) => {
        return Err(BridgeError::new(
          "STORE_FAILED",
          "failed to write center CA file",
          "not-sent",
        ));
      }
    }
  }
  Err(BridgeError::new(
    "STORE_FAILED",
    "failed to allocate a center CA file name",
    "not-sent",
  ))
}

fn local_hostname() -> Option<String> {
  #[cfg(windows)]
  let raw = std::env::var("COMPUTERNAME").ok();
  // The user-facing "Computer Name" from System Settings (same source as the launcher).
  #[cfg(target_os = "macos")]
  let raw = Command::new("/usr/sbin/scutil")
    .args(["--get", "ComputerName"])
    .stdin(Stdio::null())
    .stderr(Stdio::null())
    .output()
    .ok()
    .filter(|out| out.status.success())
    .map(|out| String::from_utf8_lossy(&out.stdout).into_owned());
  #[cfg(not(any(windows, target_os = "macos")))]
  let raw = std::env::var("HOSTNAME")
    .ok()
    .or_else(|| fs::read_to_string("/etc/hostname").ok());
  raw
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty() && name.chars().count() <= 64)
}

fn is_running(status: &Value) -> bool {
  status.get("running").and_then(Value::as_bool).unwrap_or(false)
}

/// Per-action outer budgets matching the launcher's own worst cases: graceful
/// stops wait on Node stdin shutdown, enable/disable may sit on a UAC prompt.
fn control_timeout(action: &str) -> Duration {
  match action {
    "start" => Duration::from_secs(60),
    "stop" => Duration::from_secs(85),
    "restart" => Duration::from_secs(145),
    "enable" | "disable" => Duration::from_secs(400),
    "setup-shower" => SETUP_SHOWER_TIMEOUT,
    _ => Duration::from_secs(60),
  }
}

const CONTROL_TOKEN_ENV: &str = "E_LAUNCHER_CONTROL_TOKEN";
const RELAY_TOKEN_ENV: &str = "E_LAUNCHER_RELAY_TOKEN";
const SERVICE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_SERVICE_RESPONSE: usize = 64 * 1024;

/// Reads `E_LAUNCHER_CONTROL_TOKEN` from the Host `secrets.env` using the same
/// KEY=VALUE rules as the launcher parser. The token never leaves this process.
fn read_control_token(home: &Path) -> Option<String> {
  read_env_secret(home, CONTROL_TOKEN_ENV)
}

/// One `KEY=VALUE` secret from the Host `secrets.env`; the last assignment wins.
fn read_env_secret(home: &Path, wanted: &str) -> Option<String> {
  let text = fs::read_to_string(home.join("secrets.env")).ok()?;
  let mut found = None;
  for raw in text.lines() {
    let line = raw.trim_end_matches('\r').trim();
    if line.is_empty() || line.starts_with('#') {
      continue;
    }
    let line = line.strip_prefix("export ").unwrap_or(line);
    let Some((key, value)) = line.split_once('=') else {
      continue;
    };
    if key.trim() != wanted {
      continue;
    }
    let mut token = value.trim();
    if token.len() >= 2
      && ((token.starts_with('"') && token.ends_with('"'))
        || (token.starts_with('\'') && token.ends_with('\'')))
    {
      token = &token[1..token.len() - 1];
    }
    found = if token.is_empty() { None } else { Some(token.to_string()) };
  }
  found
}

/// Queries the running Host's local control API for its real center state.
/// Returns `(online, centerState, hostPhase)`; `online` is only true when the
/// Host itself reports a ready center session — never assumed from the
/// launcher process alone.
fn probe_host_service(control_url: &str, home: Option<&Path>) -> Option<(bool, Option<String>, Option<String>)> {
  let token = read_control_token(home?)?;
  let parsed = tauri::Url::parse(control_url).ok()?;
  if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1")
    || !parsed.username().is_empty() || parsed.password().is_some()
    || token.contains(&['\r', '\n', '\0'][..]) {
    return None;
  }
  let host = "127.0.0.1";
  let port = parsed.port().unwrap_or(80);
  let socket: SocketAddr = format!("{host}:{port}").parse().ok()?;
  let mut stream = TcpStream::connect_timeout(&socket, SERVICE_PROBE_TIMEOUT).ok()?;
  stream
    .set_read_timeout(Some(SERVICE_PROBE_TIMEOUT))
    .ok()?;
  stream
    .set_write_timeout(Some(SERVICE_PROBE_TIMEOUT))
    .ok()?;
  let request = format!(
    "GET /v1/service HTTP/1.1\r\nHost: {host}:{port}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
  );
  stream.write_all(request.as_bytes()).ok()?;

  let mut raw = Vec::with_capacity(8192);
  let mut chunk = [0u8; 8192];
  loop {
    match stream.read(&mut chunk) {
      Ok(0) => break,
      Ok(n) => {
        raw.extend_from_slice(&chunk[..n]);
        if raw.len() > MAX_SERVICE_RESPONSE {
          return None;
        }
      }
      Err(_) => break,
    }
  }
  let text = String::from_utf8_lossy(&raw);
  let (head, body) = text.split_once("\r\n\r\n")?;
  let status_ok = head
    .lines()
    .next()
    .map(|line| line.contains(" 200"))
    .unwrap_or(false);
  if !status_ok {
    return Some((false, None, None));
  }
  let service: Value = serde_json::from_str(body.trim()).ok()?;
  let center_state = service
    .get("center")
    .and_then(|center| center.get("state"))
    .and_then(Value::as_str)
    .map(str::to_string);
  let host_phase = service
    .get("phase")
    .and_then(Value::as_str)
    .map(str::to_string);
  let online = center_state.as_deref() == Some("ready");
  Some((online, center_state, host_phase))
}


/// Starts the Host, or restarts it when already running so a fresh config is loaded.
fn start_or_restart() -> Result<Value, BridgeError> {
  let running = run_launcher(&["status".to_string()], None, STATUS_TIMEOUT)
    .map(|status| is_running(&status))
    .unwrap_or(false);
  let action = if running { "restart" } else { "start" };
  run_launcher(&[action.to_string()], None, control_timeout(action))
}

#[tauri::command]
pub async fn desktop_host_status(webview: Webview) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let mut status = run_blocking(|| {
    let mut status = run_launcher(&["status".to_string()], None, STATUS_TIMEOUT)?;
    if let Some(obj) = status.as_object_mut() {
      if let Some(name) = local_hostname() {
        obj.entry("hostname").or_insert(Value::String(name));
      }
      // Static knowledge: lets the UI gate Windows-only actions even if an
      // older launcher build omits the field.
      obj.entry("platform").or_insert(Value::String(
        if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "macos" } else { "linux" }.to_string(),
      ));
    }
    Ok(status)
  })
  .await?;

  // Configuration, service registration, process state and center-online are
  // reported separately: `configured`/`autostart` come from the launcher,
  // `running`/`pid`/`hostPid` describe the process, and `online` is only
  // set from the Host's own control API answer — never inferred.
  let running = status
    .get("running")
    .and_then(Value::as_bool)
    .unwrap_or(false);
  let control_url = status
    .get("controlUrl")
    .and_then(Value::as_str)
    .map(str::to_string);
  let mut online = false;
  let mut center_state = None;
  let mut host_phase = None;
  if running {
    if let Some(url) = control_url {
      // Resolve the Host home the same way the launcher reports it so the
      // control token is read from the directory the running Host actually uses.
      let home = reported_host_home(&status);
      if let Ok(probe) = tauri::async_runtime::spawn_blocking(move || {
        probe_host_service(&url, home.as_deref())
      })
      .await
      {
        if let Some((is_online, state, phase)) = probe {
          online = is_online;
          center_state = state;
          host_phase = phase;
        }
      }
    }
  }
  if let Some(obj) = status.as_object_mut() {
    obj.insert("online".to_string(), json!(online));
    if let Some(state) = center_state {
      obj.insert("centerState".to_string(), json!(state));
    }
    if let Some(phase) = host_phase {
      obj.insert("hostPhase".to_string(), json!(phase));
    }
  }
  Ok(status)
}

/// Persists the just-registered client credentials through the broker's own
/// `center_store` op (single writer of center-credentials.json). Called only
/// after the launcher pair/adopt actually succeeded, so user-authorized new
/// bindings replace the old client credentials. Never throws into the
/// command — the outcome is reported via `clientCredentialsSaved`/`storeError`.
async fn store_client_credentials(
  app: &AppHandle,
  bridge: &DesktopBridge,
  result: &mut Value,
  url: String,
  device_id: String,
  device_token: String,
  ca: String,
) {
  let stored = bridge
    .request(
      app,
      "center_store",
      json!({
        "url": url,
        "deviceId": device_id,
        "deviceToken": device_token,
        "ca": ca,
      }),
    )
    .await;
  if let Some(obj) = result.as_object_mut() {
    match &stored {
      Ok(_) => {
        obj.insert("clientCredentialsSaved".to_string(), json!(true));
      }
      Err(e) => {
        obj.insert("clientCredentialsSaved".to_string(), json!(false));
        obj.insert(
          "storeError".to_string(),
          serde_json::to_value(e)
            .unwrap_or_else(|_| json!({"code": "INTERNAL", "message": "credential store failed"})),
        );
      }
    }
  }
}

/// Optional display name: blank means "let the launcher pick the computer name".
fn optional_display_name(raw: Option<String>) -> Result<Option<String>, BridgeError> {
  match raw.as_deref().map(str::trim) {
    Some(name) if !name.is_empty() => Ok(Some(validate_display_name(name)?)),
    _ => Ok(None),
  }
}

/// Pairs the local Host through the launcher and records the same credentials for the
/// desktop client. The owner-password and pairing-code flows differ only in the launcher
/// mode (`--redeem`) and in what `secret` means; everything after registration is shared.
async fn pair_with_launcher(
  app: &AppHandle,
  bridge: &DesktopBridge,
  center_url: String,
  secret: String,
  display_name: Option<String>,
  center_ca: Option<String>,
  force: bool,
  redeem: bool,
) -> Result<Value, BridgeError> {
  let store_ca = center_ca.clone();
  let mut result = run_blocking(move || {
    let _guard = HOST_CONTROL_LOCK.lock().unwrap();
    let prior = run_launcher(&["status".to_string()], None, STATUS_TIMEOUT)?;
    let staged = match center_ca {
      Some(pem) => Some(stage_center_ca(&pem, reported_host_home(&prior).ok_or_else(|| invalid("Host home is unavailable"))?)?),
      None => None,
    };
    let mut args = vec!["pair".to_string(), "--center-url".to_string(), center_url];
    if let Some(name) = display_name {
      args.push("--name".to_string());
      args.push(name);
    }
    if let Some(staged) = &staged {
      args.push("--center-ca-file".to_string());
      args.push(staged.path.to_string_lossy().into_owned());
    }
    if force {
      args.push("--force".to_string());
    }
    if redeem {
      args.push("--redeem".to_string());
    }
    let result = run_launcher(&args, Some(secret.as_str()), PAIR_TIMEOUT);
    drop(secret);
    // Commit the staged CA only once pairing actually wrote the new config;
    // a failure drops the guard and restores the previous CA bytes.
    if result.is_ok() {
      if let Some(staged) = staged {
        staged.commit();
      }
    }
    result
  })
  .await?;
  // The certificate is public. A pairing code carries it, so the webview has to be told which
  // one the client must trust when it connects; the owner-password flow echoes what it sent.
  let center_ca = store_ca.unwrap_or_default();
  if let Some(obj) = result.as_object_mut() {
    obj.insert("centerCa".to_string(), json!(center_ca));
  }
  // Persist client credentials right after registration — long enable/start
  // steps (and any window close during them) must not lose the token.
  if let (Some(url), Some(device_id), Some(device_token)) = (
    result.get("centerUrl").and_then(Value::as_str).map(str::to_owned),
    result.get("deviceId").and_then(Value::as_str).map(str::to_owned),
    result.get("deviceToken").and_then(Value::as_str).map(str::to_owned),
  ) {
    store_client_credentials(app, bridge, &mut result, url, device_id, device_token, center_ca).await;
  }
  Ok(result)
}

#[tauri::command]
pub async fn desktop_host_pair(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
  center_url: String,
  password: String,
  display_name: Option<String>,
  center_ca: Option<String>,
  force: Option<bool>,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let center_url = validate_center_url(&center_url)?;
  validate_secret(&password, "owner password is required")?;
  let display_name = optional_display_name(display_name)?;
  let center_ca = center_ca.filter(|pem| !pem.trim().is_empty());
  pair_with_launcher(&app, &bridge, center_url, password, display_name, center_ca, force.unwrap_or(false), false).await
}

fn pairing_code_error(error: pairing_code::PairingCodeError) -> BridgeError {
  use pairing_code::PairingCodeError::{Malformed, NotACode, UnsupportedVersion};
  match error {
    NotACode => BridgeError::new("NOT_A_PAIRING_CODE", "this is not a pairing code", "not-sent"),
    UnsupportedVersion => BridgeError::new("UNSUPPORTED_PAIRING_CODE", "this pairing code needs a newer PiBot", "not-sent"),
    Malformed => BridgeError::new("INVALID_PAIRING_CODE", "the pairing code is damaged or incomplete", "not-sent"),
  }
}

/// Pairs this computer with a one-time pairing code from the center: the code carries the
/// center address, the one-time secret and (for a private CA) the certificate, so nothing
/// else has to be typed. The webview passes the opaque string; it is decoded only here.
#[tauri::command]
pub async fn desktop_host_pair_code(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
  code: String,
  display_name: Option<String>,
  force: Option<bool>,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let (parsed, center_url) = read_pairing_code(&code)?;
  drop(code);
  let display_name = optional_display_name(display_name)?;
  pair_with_launcher(&app, &bridge, center_url, parsed.secret, display_name, parsed.ca, force.unwrap_or(false), true).await
}

/// Decodes a pasted code and checks the center address it carries. A code whose address is not a bare
/// origin (a path, query, userinfo, plain http to a remote host) is as unusable as a damaged one, and is
/// reported the same way before anything is sent.
fn read_pairing_code(code: &str) -> Result<(pairing_code::PairingCode, String), BridgeError> {
  let parsed = pairing_code::parse(code).map_err(pairing_code_error)?;
  let center_url = validate_center_url(&parsed.url)
    .map_err(|_| BridgeError::new("INVALID_PAIRING_CODE", "the pairing code is damaged or incomplete", "not-sent"))?;
  Ok((parsed, center_url))
}

/// What the desktop client needs to reuse an already paired Host's identity.
struct LocalIdentity {
  center_url: String,
  device_id: String,
  device_token: String,
  ca: String,
}

/// Reads the paired Host's own credentials from its files. The token stays on the Rust
/// side: the webview only learns whether the credentials were stored.
fn local_identity(status: &Value) -> Result<LocalIdentity, BridgeError> {
  let not_configured = || BridgeError::new("NOT_CONFIGURED", "the local Host is not paired yet", "not-sent");
  if status.get("configured").and_then(Value::as_bool) != Some(true) || status.get("configError").is_some_and(|e| !e.is_null()) {
    return Err(not_configured());
  }
  let text = |key: &str| status.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
  let (Some(center_url), Some(device_id)) = (text("centerUrl"), text("deviceId")) else {
    return Err(not_configured());
  };
  let home = reported_host_home(status).ok_or_else(|| invalid("Host home is unavailable"))?;
  let device_token = read_env_secret(&home, RELAY_TOKEN_ENV)
    .ok_or_else(|| BridgeError::new("NOT_CONFIGURED", "the local Host has no device token", "not-sent"))?;
  Ok(LocalIdentity {
    center_url: center_url.to_string(),
    device_id: device_id.to_string(),
    device_token,
    ca: read_host_center_ca(&home)?,
  })
}

/// The private CA the Host was paired with, or an empty string when it uses none.
fn read_host_center_ca(home: &Path) -> Result<String, BridgeError> {
  let unreadable = || BridgeError::new("STORE_FAILED", "could not read the Host center CA file", "not-sent");
  let config: Value = match fs::read_to_string(home.join(CONFIG_FILE_NAME)) {
    Ok(text) => serde_json::from_str(&text).map_err(|_| unreadable())?,
    Err(_) => return Err(unreadable()),
  };
  let Some(path) = config.get("centerCaFile").and_then(Value::as_str).filter(|path| !path.trim().is_empty()) else {
    return Ok(String::new());
  };
  let pem = fs::read_to_string(path).map_err(|_| unreadable())?;
  if pem.len() > MAX_CA_BYTES {
    return Err(unreadable());
  }
  Ok(pem.trim().to_string())
}

/// Hands the paired Host's identity to the desktop client, so a client that lost its login
/// (reinstall, cleared data) reconnects without asking for anything. No network and no
/// Host lifecycle: it only records credentials the Host already holds.
#[tauri::command]
pub async fn desktop_host_connect_local(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let identity = run_blocking(|| {
    let _guard = HOST_CONTROL_LOCK.lock().unwrap();
    let status = run_launcher(&["status".to_string()], None, STATUS_TIMEOUT)?;
    local_identity(&status)
  })
  .await?;
  // `centerCa` is public; the webview needs it to connect with the same trust the Host uses.
  let mut result = json!({ "centerUrl": identity.center_url, "deviceId": identity.device_id, "centerCa": identity.ca });
  store_client_credentials(
    &app,
    &bridge,
    &mut result,
    identity.center_url,
    identity.device_id,
    identity.device_token,
    identity.ca,
  )
  .await;
  Ok(result)
}

#[tauri::command]
pub async fn desktop_host_adopt(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
  center_url: String,
  device_id: String,
  device_token: String,
  center_ca: Option<String>,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let center_url = validate_center_url(&center_url)?;
  let device_id = validate_device_id(&device_id)?;
  let device_token = device_token.trim().to_string();
  validate_secret(&device_token, "device token is required")?;
  let store_token = device_token.clone();
  let center_ca = center_ca.filter(|pem| !pem.trim().is_empty());
  let store_ca = center_ca.clone();
  let marker_root = bridge::resolve_client_data_root(&app)?;
  let marker = PathBuf::from(marker_root);
  let (result, needs_enable, needs_start) = run_blocking({
    let marker = marker.clone();
    move || {
    let _guard = HOST_CONTROL_LOCK.lock().unwrap();
    let prior = run_launcher(&["status".to_string()], None, STATUS_TIMEOUT)?;
    let configured = prior.get("configured").and_then(Value::as_bool) == Some(true);
    let same_identity = configured
      && prior.get("centerUrl").and_then(Value::as_str) == Some(center_url.as_str())
      && prior.get("deviceId").and_then(Value::as_str) == Some(device_id.as_str());
    if !same_identity && (configured || prior.get("configError").is_some()) {
      return Err(BridgeError::new("ALREADY_CONFIGURED", "re-pair explicitly to change the local Host", "not-sent"));
    }
    let pending = match fs::read_to_string(marker.join(AUTOSTART_PENDING_FILE)) {
      Ok(value) => Some(value),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
      Err(_) => return Err(BridgeError::new("STORE_FAILED", "could not read Host autostart state", "not-sent")),
    };
    if !configured { set_autostart_pending(&marker, Some("enable"))?; }
    let needs_enable = !configured || pending.as_deref() == Some("enable");
    let needs_start = !configured || pending.is_some();
    let staged = match center_ca {
      Some(pem) => Some(stage_center_ca(&pem, reported_host_home(&prior).ok_or_else(|| invalid("Host home is unavailable"))?)?),
      None => None,
    };
    let mut args = vec![
      "adopt".to_string(),
      "--center-url".to_string(),
      center_url,
      "--device-id".to_string(),
      device_id,
    ];
    if let Some(staged) = &staged {
      args.push("--center-ca-file".to_string());
      args.push(staged.path.to_string_lossy().into_owned());
    }
    let adopt = if same_identity {
      prior.clone()
    } else {
      run_launcher(&args, Some(device_token.as_str()), PAIR_TIMEOUT)?
    };
    drop(device_token);
    // adopt already wrote the config referencing the CA path; enable/start
    // failures must not roll back the file the new config now needs.
    if let Some(staged) = staged {
      staged.commit();
    }
    Ok((adopt, needs_enable, needs_start))
  }})
  .await?;
  let restarted = result.get("restarted").and_then(Value::as_bool) == Some(true);
  let adopt_url = result.get("centerUrl").and_then(Value::as_str).map(str::to_owned);
  let adopt_device_id = result.get("deviceId").and_then(Value::as_str).map(str::to_owned);
  let mut out = json!({ "adopt": result });
  // Same safety net as pair: persist the adopted client credentials BEFORE the
  // long enable/start (UAC) — a window close must never strand the adopt flow.
  if let (Some(url), Some(device_id)) = (adopt_url, adopt_device_id) {
    store_client_credentials(&app, &bridge, &mut out, url, device_id, store_token, store_ca.unwrap_or_default()).await;
  }
  // enable/start run after the credentials are safe; failures are reported as
  // retryable warnings on the adopt result — never as a failed command.
  let post = run_blocking(move || {
    let _guard = HOST_CONTROL_LOCK.lock().unwrap();
    let mut warnings: Vec<Value> = Vec::new();
    let enable = if needs_enable { match run_launcher(&["enable".to_string()], None, control_timeout("enable")) {
      Ok(value) => {
        set_autostart_pending(&marker, Some("start"))?;
        value
      },
      Err(e) => {
        warnings.push(json!({ "code": e.code, "message": e.message }));
        json!({ "error": { "code": e.code, "message": e.message } })
      }
    }} else { json!({ "status": "unchanged" }) };
    let start = if !needs_start { json!({ "status": "unchanged" }) } else if restarted {
      json!({ "status": "restarted" })
    } else {
      match start_or_restart() {
        Ok(value) => value,
        Err(e) => {
          warnings.push(json!({ "code": e.code, "message": e.message }));
          json!({ "error": { "code": e.code, "message": e.message } })
        }
      }
    };
    if warnings.is_empty() { set_autostart_pending(&marker, None)?; }
    let mut post = Map::new();
    post.insert("enable".to_string(), enable);
    post.insert("start".to_string(), start);
    if !warnings.is_empty() {
      post.insert("warnings".to_string(), Value::Array(warnings));
    }
    Ok(Value::Object(post))
  })
  .await?;
  if let (Some(obj), Some(post)) = (out.as_object_mut(), post.as_object()) {
    for (key, value) in post {
      obj.insert(key.clone(), value.clone());
    }
  }
  Ok(out)
}

#[tauri::command]
pub async fn desktop_host_control(
  app: AppHandle,
  webview: Webview,
  action: String,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  if !CONTROL_ACTIONS.contains(&action.as_str()) {
    return Err(invalid("unsupported host control action"));
  }
  let timeout = control_timeout(&action);
  let marker_root = bridge::resolve_client_data_root(&app)?;
  run_blocking(move || {
    let _guard = HOST_CONTROL_LOCK.lock().unwrap();
    let result = run_launcher(&[action.clone()], None, timeout)?;
    if matches!(action.as_str(), "stop" | "disable" | "enable" | "remove") {
      set_autostart_pending(Path::new(&marker_root), None)?;
    }
    Ok(result)
  }).await
}

#[cfg(test)]
mod tests {
  use std::{cell::RefCell, rc::Rc};

  use super::*;

  type Answer = Box<dyn FnMut(&str) -> Result<Value, BridgeError>>;

  /// Runs the update cycle against a scripted launcher. Returns the result
  /// and the call order, with `swap` recorded where the bundle was replaced.
  fn cycle(mut answer: Answer) -> (Result<(&'static str, Option<String>), BridgeError>, Vec<String>) {
    let log = Rc::new(RefCell::new(Vec::<String>::new()));
    let launcher_log = log.clone();
    let mut launcher = move |action: &str| {
      launcher_log.borrow_mut().push(action.to_string());
      answer(action)
    };
    let swap_log = log.clone();
    let result = cycle_host_for_update(&mut launcher, move || {
      swap_log.borrow_mut().push("swap".to_string());
      "swapped"
    });
    let calls = log.borrow().clone();
    (result, calls)
  }

  /// A running Host with autostart on, whose `stop` answers `stop`.
  fn running_host(stop: Result<Value, BridgeError>) -> Answer {
    let mut stop = Some(stop);
    Box::new(move |action| match action {
      "status" => Ok(json!({ "running": true, "autostart": true })),
      "stop" => stop.take().expect("stop runs once"),
      _ => Ok(json!({ "status": "started" })),
    })
  }

  fn confirmed_stop() -> Value {
    json!({ "status": "stopped", "launchdLoaded": false })
  }

  #[test]
  fn unload_failure_never_swaps_and_brings_the_host_back() {
    let unload_failed = BridgeError::new(
      "STOP_FAILED",
      "the Host stopped, but its LaunchAgent could not be confirmed unloaded, so launchd may start it again: launchctl exited 5",
      "responded",
    );
    let (result, calls) = cycle(running_host(Err(unload_failed)));
    assert_eq!(result.unwrap_err().code, "STOP_FAILED");
    assert_eq!(calls, ["status", "stop", "start"]);
  }

  #[test]
  fn stop_without_unload_confirmation_never_swaps() {
    let unconfirmed = [
      // Pre-fix launcher shape: unload error demoted to a warning.
      json!({ "status": "stopped", "warnings": ["AUTOSTART_FAILED: launchctl bootout: exited 5"] }),
      json!({ "status": "stopped" }),
      json!({ "status": "stopped", "launchdLoaded": true }),
      json!({ "status": "stopped", "launchdLoaded": "false" }),
      json!({ "status": "running", "launchdLoaded": false }),
      json!({}),
    ];
    for stop in unconfirmed {
      let (result, calls) = cycle(running_host(Ok(stop.clone())));
      assert_eq!(result.unwrap_err().code, "STOP_UNCONFIRMED", "{stop}");
      assert_eq!(calls, ["status", "stop", "start"], "{stop}");
    }
  }

  #[test]
  fn stop_timeout_never_swaps() {
    let (result, calls) = cycle(running_host(Err(BridgeError::new("TIMEOUT", "host launcher timed out", "unconfirmed"))));
    assert_eq!(result.unwrap_err().code, "TIMEOUT");
    assert!(!calls.iter().any(|c| c == "swap"));
  }

  #[test]
  fn unreadable_status_neither_stops_nor_swaps() {
    let (result, calls) = cycle(Box::new(|_| Err(BridgeError::new("HOST_LAUNCHER_MISSING", "missing", "not-sent"))));
    assert_eq!(result.unwrap_err().code, "HOST_LAUNCHER_MISSING");
    assert_eq!(calls, ["status"]);
  }

  #[test]
  fn stopped_host_is_not_started_when_its_stop_fails() {
    let mut stop = Some(Err(BridgeError::new("STOP_FAILED", "unload failed", "responded")));
    let (result, calls) = cycle(Box::new(move |action| match action {
      "status" => Ok(json!({ "running": false, "autostart": true })),
      "stop" => stop.take().unwrap(),
      _ => Ok(json!({})),
    }));
    assert!(result.is_err());
    assert_eq!(calls, ["status", "stop"]);
  }

  #[test]
  fn confirmed_stop_swaps_then_restores_in_order() {
    let (result, calls) = cycle(running_host(Ok(confirmed_stop())));
    assert_eq!(result.unwrap(), ("swapped", None));
    assert_eq!(calls, ["status", "stop", "swap", "enable", "start"]);
  }

  #[test]
  fn host_that_was_stopped_without_autostart_stays_stopped() {
    let (result, calls) = cycle(Box::new(|action| match action {
      "status" => Ok(json!({ "running": false, "autostart": false })),
      "stop" => Ok(confirmed_stop()),
      other => panic!("unexpected {other}"),
    }));
    assert_eq!(result.unwrap(), ("swapped", None));
    assert_eq!(calls, ["status", "stop", "swap"]);
  }

  #[test]
  fn restore_problems_are_reported_next_to_the_swap_result() {
    let (result, calls) = cycle(Box::new(|action| match action {
      "status" => Ok(json!({ "running": true, "autostart": true })),
      "stop" => Ok(confirmed_stop()),
      "enable" => Err(BridgeError::new("AUTOSTART_FAILED", "launchctl enable: denied", "responded")),
      _ => Err(BridgeError::new("START_TIMEOUT", "launcher did not start within 10s", "responded")),
    }));
    let (output, message) = result.unwrap();
    assert_eq!(output, "swapped");
    let message = message.unwrap();
    assert!(message.contains("enable: AUTOSTART_FAILED") && message.contains("start: START_TIMEOUT"), "{message}");
    assert_eq!(calls, ["status", "stop", "swap", "enable", "start"]);
  }

  /// The update cycle against real launchd, the real launcher and copies of
  /// a built PiBot.app. Ignored by default; scripts/macos-update-cycle-test.sh
  /// runs it with a debug launcher (the only build that honours the test
  /// label), an isolated Host home and a throwaway LaunchAgent label.
  #[cfg(target_os = "macos")]
  mod launchd {
    use std::{
      fs,
      os::unix::fs::{MetadataExt, PermissionsExt},
      path::{Path, PathBuf},
      process::Command,
      thread,
      time::{Duration, Instant},
    };

    use serde_json::{Value, json};

    use super::super::{BridgeError, STATUS_TIMEOUT, control_timeout, cycle_host_for_update, run_launcher_at};

    const PRODUCT_LABEL: &str = "io.github.firespoonyz.pibot.host";
    /// How long the swap watches for launchd bringing the Host back.
    const SWAP_WATCH: Duration = Duration::from_secs(3);

    fn env_path(name: &str) -> PathBuf {
      std::env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| panic!("{name} is not set; run scripts/macos-update-cycle-test.sh"))
    }

    fn uid() -> String {
      let out = Command::new("/usr/bin/id").arg("-u").output().unwrap();
      String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    /// None when launchd has no such job; otherwise the job's pid, if running.
    fn job(label: &str) -> Option<Option<u32>> {
      let out = Command::new("/bin/launchctl").args(["print", &format!("gui/{}/{label}", uid())]).output().unwrap();
      match out.status.code() {
        Some(0) => Some(
          String::from_utf8_lossy(&out.stdout)
            .lines()
            .find_map(|line| line.trim().strip_prefix("pid = ").and_then(|pid| pid.trim().parse().ok())),
        ),
        Some(113) => None,
        other => panic!("launchctl print exited {other:?}: {}", String::from_utf8_lossy(&out.stderr)),
      }
    }

    fn alive(pid: u32) -> bool {
      Command::new("/bin/kill").args(["-0", &pid.to_string()]).stderr(std::process::Stdio::null()).status().unwrap().success()
    }

    /// Inodes of the executable images a process has mapped (lsof `txt`).
    fn mapped_inodes(pid: u32) -> Vec<u64> {
      let out = Command::new("/usr/sbin/lsof").args(["-a", "-p", &pid.to_string(), "-d", "txt", "-Fi"]).output().unwrap();
      String::from_utf8_lossy(&out.stdout).lines().filter_map(|line| line.strip_prefix('i')?.parse().ok()).collect()
    }

    /// Copies the built bundle and puts the debug launcher in place of the
    /// release one (which ignores the test label).
    fn copy_app(from: &Path, to: &Path, launcher: &Path) {
      fs::create_dir_all(to.parent().unwrap()).unwrap();
      assert!(Command::new("/usr/bin/ditto").arg(from).arg(to).status().unwrap().success());
      fs::copy(launcher, to.join("Contents/MacOS/pibot-host")).unwrap();
    }

    /// A paired-looking Host whose center is unreachable: the supervisor runs
    /// and holds launcher.lock, the Host itself keeps retrying.
    fn write_host_config(home: &Path) {
      fs::create_dir_all(home.join("data")).unwrap();
      let config = json!({
        "version": 1,
        "centerUrl": "https://127.0.0.1:9",
        "deviceId": "00000000-0000-4000-8000-00000000c1c1",
        "displayName": "launchd update-cycle test",
        "dataRoot": home.join("data"),
        "port": 40000 + std::process::id() % 20000,
      });
      fs::write(home.join("config.json"), serde_json::to_vec_pretty(&config).unwrap()).unwrap();
      let secrets = home.join("secrets.env");
      fs::write(&secrets, "E_LAUNCHER_CONTROL_TOKEN=update-cycle-control\nE_LAUNCHER_RELAY_TOKEN=update-cycle-relay\n").unwrap();
      fs::set_permissions(&secrets, fs::Permissions::from_mode(0o600)).unwrap();
    }

    struct Fixture {
      dir: PathBuf,
      label: String,
      installed: PathBuf,
    }

    impl Fixture {
      fn run(&self, action: &str) -> Result<Value, BridgeError> {
        let timeout = if action == "status" { STATUS_TIMEOUT } else { control_timeout(action) };
        run_launcher_at(&self.installed.join("Contents/MacOS/pibot-host"), &[action.to_string()], None, timeout)
      }
    }

    impl Drop for Fixture {
      /// Leaves no job, plist or process behind, also after a failed assertion.
      fn drop(&mut self) {
        let _ = self.run("remove");
        let _ = Command::new("/bin/launchctl").args(["bootout", &format!("gui/{}/{}", uid(), self.label)]).output();
        if let Some(home) = std::env::var_os("HOME") {
          let _ = fs::remove_file(Path::new(&home).join("Library/LaunchAgents").join(format!("{}.plist", self.label)));
        }
        let _ = fs::remove_dir_all(&self.dir);
      }
    }

    #[test]
    #[ignore = "needs a GUI launchd domain and a built PiBot.app; run scripts/macos-update-cycle-test.sh"]
    fn update_cycle_against_real_launchd() {
      let app = env_path("PIBOT_LAUNCHD_TEST_APP");
      let debug_launcher = env_path("PIBOT_LAUNCHD_TEST_LAUNCHER");
      let dir = env_path("PIBOT_LAUNCHD_TEST_DIR");
      let home = env_path("E_LAUNCHER_HOST_HOME");
      let label = std::env::var("E_LAUNCHER_LAUNCHD_LABEL").expect("E_LAUNCHER_LAUNCHD_LABEL is not set");
      assert_ne!(label, PRODUCT_LABEL, "never touch the product LaunchAgent");
      assert!(home.starts_with(&dir) && !home.exists(), "E_LAUNCHER_HOST_HOME must be a new directory inside PIBOT_LAUNCHD_TEST_DIR");
      assert_eq!(job(&label), None, "{label} is already loaded");

      let installed = dir.join("Applications/PiBot.app");
      let staged = dir.join("staged/PiBot.app");
      let backup = dir.join("backup/PiBot.app");
      copy_app(&app, &installed, &debug_launcher);
      copy_app(&app, &staged, &debug_launcher);
      write_host_config(&home);
      let fixture = Fixture { dir: dir.clone(), label: label.clone(), installed: installed.clone() };

      // Before: autostart on and launchd running the supervisor.
      fixture.run("enable").unwrap();
      let started = fixture.run("start").unwrap();
      assert!(started.get("warnings").is_none(), "launchd did not start the Host: {started}");
      let before = fixture.run("status").unwrap();
      assert_eq!((before["running"].as_bool(), before["autostart"].as_bool()), (Some(true), Some(true)), "{before}");
      let old_pid = before["pid"].as_u64().unwrap() as u32;
      assert_eq!(job(&label), Some(Some(old_pid)), "launchd should be running supervisor {old_pid}");
      let old_inode = fs::metadata(installed.join("Contents/MacOS/pibot-host")).unwrap().ino();
      let new_inode = fs::metadata(staged.join("Contents/MacOS/pibot-host")).unwrap().ino();

      let mut launcher = |action: &str| fixture.run(action);
      let (output, note) = cycle_host_for_update(&mut launcher, || {
        // The job is gone and stays gone: launchd cannot start bundle code mid-swap.
        let watch = Instant::now() + SWAP_WATCH;
        while Instant::now() < watch {
          assert_eq!(job(&label), None, "LaunchAgent loaded during the swap");
          assert!(!alive(old_pid), "supervisor {old_pid} still running during the swap");
          thread::sleep(Duration::from_millis(200));
        }
        let during = fixture.run("status").unwrap();
        assert_eq!(during["running"].as_bool(), Some(false), "{during}");
        // Same moves as the updater: old bundle aside, new bundle into place.
        fs::create_dir_all(backup.parent().unwrap()).unwrap();
        fs::rename(&installed, &backup).unwrap();
        fs::rename(&staged, &installed).unwrap();
        "swapped"
      })
      .unwrap();
      assert_eq!((output, note), ("swapped", None));

      // After: the LaunchAgent is loaded again and launchd runs the new launcher.
      let after = fixture.run("status").unwrap();
      assert_eq!((after["running"].as_bool(), after["autostart"].as_bool()), (Some(true), Some(true)), "{after}");
      let new_pid = after["pid"].as_u64().unwrap() as u32;
      assert_ne!(new_pid, old_pid);
      assert_eq!(job(&label), Some(Some(new_pid)), "launchd should be running supervisor {new_pid}");
      let inodes = mapped_inodes(new_pid);
      assert!(inodes.contains(&new_inode) && !inodes.contains(&old_inode), "supervisor {new_pid} maps {inodes:?}, new launcher is {new_inode}, old {old_inode}");
    }
  }
}

#[cfg(test)]
mod local_identity_tests {
  use super::*;

  const TOKEN: &str = "t0ken_t0ken_t0ken_t0ken_t0ken_t0ken_ABC";

  /// A throw-away Host home with the files the launcher would have written.
  struct Home(PathBuf);

  impl Home {
    fn new(tag: &str) -> Self {
      let path = std::env::temp_dir().join(format!("pibot-local-identity-{tag}-{}", std::process::id()));
      let _ = fs::remove_dir_all(&path);
      fs::create_dir_all(&path).unwrap();
      Home(path)
    }

    fn write(&self, name: &str, text: &str) -> &Self {
      fs::write(self.0.join(name), text).unwrap();
      self
    }

    fn status(&self) -> Value {
      json!({
        "configured": true,
        "centerUrl": "https://center.example",
        "deviceId": "mac-host-1",
        "hostHome": self.0.to_string_lossy(),
      })
    }
  }

  impl Drop for Home {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  fn err_code(result: Result<LocalIdentity, BridgeError>) -> String {
    result.err().expect("expected an error").code
  }

  #[test]
  fn reads_the_hosts_own_credentials_without_a_ca() {
    let home = Home::new("plain");
    home
      .write("secrets.env", &format!("E_LAUNCHER_CONTROL_TOKEN=ctl\nE_LAUNCHER_RELAY_TOKEN={TOKEN}\n"))
      .write("config.json", r#"{"centerUrl":"https://center.example","deviceId":"mac-host-1"}"#);
    let identity = local_identity(&home.status()).ok().expect("identity");
    assert_eq!(
      (identity.center_url.as_str(), identity.device_id.as_str(), identity.device_token.as_str(), identity.ca.as_str()),
      ("https://center.example", "mac-host-1", TOKEN, "")
    );
  }

  #[test]
  fn carries_the_private_ca_the_host_was_paired_with() {
    let home = Home::new("ca");
    let ca_path = home.0.join("center-ca-1.pem");
    fs::write(&ca_path, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n").unwrap();
    home
      .write("secrets.env", &format!("export E_LAUNCHER_RELAY_TOKEN=\"{TOKEN}\"\n"))
      .write("config.json", &json!({ "centerCaFile": ca_path.to_string_lossy() }).to_string());
    let identity = local_identity(&home.status()).ok().expect("identity");
    assert_eq!(identity.device_token, TOKEN, "quotes and `export` are part of the launcher's secrets syntax");
    assert!(identity.ca.starts_with("-----BEGIN CERTIFICATE-----") && identity.ca.ends_with("-----END CERTIFICATE-----"));
  }

  #[test]
  fn refuses_when_the_host_is_not_a_usable_pairing() {
    let home = Home::new("refuse");
    home.write("secrets.env", &format!("E_LAUNCHER_RELAY_TOKEN={TOKEN}\n")).write("config.json", "{}");
    let status = home.status();
    let with = |key: &str, value: Value| {
      let mut copy = status.clone();
      copy[key] = value;
      copy
    };
    assert_eq!(err_code(local_identity(&with("configured", json!(false)))), "NOT_CONFIGURED");
    assert_eq!(err_code(local_identity(&with("configError", json!({ "code": "CONFIG_INVALID" })))), "NOT_CONFIGURED");
    assert_eq!(err_code(local_identity(&with("centerUrl", json!("  ")))), "NOT_CONFIGURED");
    assert_eq!(err_code(local_identity(&with("deviceId", Value::Null))), "NOT_CONFIGURED");
    assert_eq!(err_code(local_identity(&with("hostHome", json!("relative/home")))), "INVALID_ARGUMENT");
    // A null configError is the launcher's way of saying "none".
    assert!(local_identity(&with("configError", Value::Null)).is_ok());
  }

  #[test]
  fn refuses_when_the_token_or_ca_file_is_unusable() {
    let missing = Home::new("no-token");
    missing.write("secrets.env", "E_LAUNCHER_CONTROL_TOKEN=ctl\n").write("config.json", "{}");
    assert_eq!(err_code(local_identity(&missing.status())), "NOT_CONFIGURED");

    let empty = Home::new("empty-token");
    empty.write("secrets.env", "E_LAUNCHER_RELAY_TOKEN=\n").write("config.json", "{}");
    assert_eq!(err_code(local_identity(&empty.status())), "NOT_CONFIGURED");

    let dangling = Home::new("dangling-ca");
    dangling
      .write("secrets.env", &format!("E_LAUNCHER_RELAY_TOKEN={TOKEN}\n"))
      .write("config.json", r#"{"centerCaFile":"/definitely/not/here.pem"}"#);
    assert_eq!(err_code(local_identity(&dangling.status())), "STORE_FAILED");

    let no_config = Home::new("no-config");
    no_config.write("secrets.env", &format!("E_LAUNCHER_RELAY_TOKEN={TOKEN}\n"));
    assert_eq!(err_code(local_identity(&no_config.status())), "STORE_FAILED");
  }

  #[test]
  fn the_token_and_pairing_secret_never_reach_the_launcher_through_the_environment() {
    for key in ["E_LAUNCHER_OWNER_PASSWORD", "E_LAUNCHER_PAIRING_SECRET", "E_LAUNCHER_RELAY_TOKEN", "E_LAUNCHER_CONTROL_TOKEN"] {
      assert!(SECRET_ENV_KEYS.contains(&key), "{key} must be scrubbed so stdin is the only source");
    }
  }
}

#[cfg(test)]
mod center_url_tests {
  use super::*;
  use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

  fn code_for(center: &str) -> String {
    let payload = json!({ "u": center, "c": "A".repeat(43) });
    format!("{}{}", pairing_code::PREFIX, URL_SAFE_NO_PAD.encode(payload.to_string()))
  }

  #[test]
  fn accepts_a_bare_origin_and_drops_one_trailing_slash() {
    for (raw, expected) in [
      ("https://center.example", "https://center.example"),
      (" https://center.example/ ", "https://center.example"),
      ("https://center.example:8443", "https://center.example:8443"),
      ("https://192.168.1.10:8443/", "https://192.168.1.10:8443"),
      ("http://localhost:8080", "http://localhost:8080"),
      ("http://127.0.0.1:8080/", "http://127.0.0.1:8080"),
      ("http://[::1]:8080", "http://[::1]:8080"),
    ] {
      assert_eq!(validate_center_url(raw).ok().as_deref(), Some(expected), "{raw}");
    }
  }

  #[test]
  fn refuses_anything_that_is_more_than_an_origin() {
    for bad in [
      "https://center.example/subpath",
      "https://center.example/subpath/",
      "https://center.example//",
      "https://center.example/?x=1",
      "https://center.example?x=1",
      "https://center.example/#top",
      "https://center.example#top",
      "https://user@center.example",
      "https://user:pw@center.example",
      "http://center.example",
      "ftp://center.example",
      "center.example",
      "",
    ] {
      assert!(validate_center_url(bad).is_err(), "{bad} must be refused");
    }
  }

  #[test]
  fn a_pairing_code_must_carry_a_bare_origin() {
    let center = |text: &str| read_pairing_code(&code_for(text)).ok().map(|(_, url)| url);
    assert_eq!(center("https://center.example").as_deref(), Some("https://center.example"));
    assert_eq!(center("https://center.example/").as_deref(), Some("https://center.example"));
    // Each of these used to get past the check and fail later in the launcher, or send requests to a sub path.
    for bad in ["https://center.example/sub", "https://center.example/?q=1", "https://center.example/#x", "https://u:p@center.example", "http://center.example"] {
      let error = read_pairing_code(&code_for(bad)).err().expect(bad);
      assert_eq!(error.code, "INVALID_PAIRING_CODE", "{bad}");
    }
  }
}
