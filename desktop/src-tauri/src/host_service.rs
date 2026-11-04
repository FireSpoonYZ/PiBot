//! Tauri commands that drive the bundled `e-launcher-host` launcher binary.
//!
//! The launcher lives next to the desktop executable (Tauri externalBin). Every
//! call runs it as a short-lived child process without a console window,
//! passes secrets (owner password, device token) through stdin only — never
//! argv or logs — and parses the single-line JSON it prints on stdout.

use std::{
  env, fs,
  io::{BufRead, BufReader, Read, Write},
  path::PathBuf,
  process::{Command, Stdio},
  sync::mpsc,
  thread,
  time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

use serde_json::{Map, Value, json};
use tauri::{Webview, utils::platform};

use crate::{bridge::BridgeError, ensure_main_webview};

const LAUNCHER_NAME: &str = "e-launcher-host";
const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);
const PAIR_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How long to keep collecting stdout after the launcher exited. A detached
/// grandchild (`run`) may inherit the pipe, so EOF is not guaranteed.
const OUTPUT_GRACE: Duration = Duration::from_millis(500);
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;
const MAX_SECRET_BYTES: usize = 4096;
const MAX_CA_BYTES: usize = 64 * 1024;
const CA_FILE_NAME: &str = "center-ca.pem";
/// Secret-bearing variables the launcher prefers over stdin; never inherit them
/// from the desktop process so the stdin value is always the one used.
const SECRET_ENV_KEYS: &[&str] = &[
  "E_LAUNCHER_OWNER_PASSWORD",
  "E_LAUNCHER_RELAY_TOKEN",
  "E_LAUNCHER_CONTROL_TOKEN",
];
const CONTROL_ACTIONS: &[&str] = &["start", "stop", "restart", "enable", "disable"];

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
  let launcher = resolve_launcher()?;
  let mut cmd = Command::new(&launcher);
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

async fn run_blocking<F>(job: F) -> Result<Value, BridgeError>
where
  F: FnOnce() -> Result<Value, BridgeError> + Send + 'static,
{
  tauri::async_runtime::spawn_blocking(job)
    .await
    .map_err(|_| BridgeError::new("INTERNAL", "host launcher worker failed", "unconfirmed"))?
}

fn validate_center_url(raw: &str) -> Result<String, BridgeError> {
  let url = raw.trim();
  if url.is_empty() || url.len() > 2048 {
    return Err(invalid("invalid center URL"));
  }
  let parsed = tauri::Url::parse(url).map_err(|_| invalid("invalid center URL"))?;
  if !parsed.username().is_empty() || parsed.password().is_some() || parsed.host_str().is_none() {
    return Err(invalid("invalid center URL"));
  }
  let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
  match parsed.scheme() {
    "https" => {}
    "http" if loopback => {}
    _ => return Err(invalid("center URL must use HTTPS")),
  }
  Ok(url.to_string())
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

/// `HOST_HOME` per the host-service contract (§2).
fn host_home() -> Option<PathBuf> {
  if let Some(value) = env::var_os("E_LAUNCHER_HOST_HOME") {
    let path = PathBuf::from(value);
    if path.is_absolute() {
      return Some(path);
    }
  }
  #[cfg(windows)]
  {
    env::var_os("LOCALAPPDATA")
      .map(PathBuf::from)
      .filter(|p| p.is_absolute())
      .map(|p| p.join("e-launcher").join("host-service"))
  }
  #[cfg(not(windows))]
  {
    let config = env::var_os("XDG_CONFIG_HOME")
      .map(PathBuf::from)
      .filter(|p| p.is_absolute())
      .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(config.join("e-launcher").join("host-service"))
  }
}

/// Persists an optional self-signed center CA so the Host can use `--center-ca-file`.
fn write_center_ca(pem: &str) -> Result<PathBuf, BridgeError> {
  let pem = pem.trim();
  if pem.len() > MAX_CA_BYTES || !pem.contains("-----BEGIN CERTIFICATE-----") {
    return Err(invalid("invalid center CA certificate"));
  }
  let home = host_home()
    .ok_or_else(|| BridgeError::new("STORE_FAILED", "failed to resolve host service directory", "not-sent"))?;
  fs::create_dir_all(&home)
    .map_err(|_| BridgeError::new("STORE_FAILED", "failed to create host service directory", "not-sent"))?;
  let path = home.join(CA_FILE_NAME);
  fs::write(&path, format!("{pem}\n"))
    .map_err(|_| BridgeError::new("STORE_FAILED", "failed to write center CA file", "not-sent"))?;
  Ok(path)
}

fn local_hostname() -> Option<String> {
  #[cfg(windows)]
  let raw = env::var("COMPUTERNAME").ok();
  #[cfg(not(windows))]
  let raw = env::var("HOSTNAME")
    .ok()
    .or_else(|| fs::read_to_string("/etc/hostname").ok());
  raw
    .map(|name| name.trim().to_string())
    .filter(|name| !name.is_empty() && name.chars().count() <= 64)
}

fn is_running(status: &Value) -> bool {
  status.get("running").and_then(Value::as_bool).unwrap_or(false)
}

/// Starts the Host, or restarts it when already running so a fresh config is loaded.
fn start_or_restart() -> Result<Value, BridgeError> {
  let running = run_launcher(&["status".to_string()], None, STATUS_TIMEOUT)
    .map(|status| is_running(&status))
    .unwrap_or(false);
  let action = if running { "restart" } else { "start" };
  run_launcher(&[action.to_string()], None, CONTROL_TIMEOUT)
}

#[tauri::command]
pub async fn desktop_host_status(webview: Webview) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  run_blocking(|| {
    let mut status = run_launcher(&["status".to_string()], None, STATUS_TIMEOUT)?;
    if let (Some(obj), Some(name)) = (status.as_object_mut(), local_hostname()) {
      obj.entry("hostname").or_insert(Value::String(name));
    }
    Ok(status)
  })
  .await
}

#[tauri::command]
pub async fn desktop_host_pair(
  webview: Webview,
  center_url: String,
  password: String,
  display_name: Option<String>,
  force: Option<bool>,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let center_url = validate_center_url(&center_url)?;
  validate_secret(&password, "owner password is required")?;
  let display_name = match display_name.as_deref().map(str::trim) {
    Some(name) if !name.is_empty() => Some(validate_display_name(name)?),
    _ => None,
  };
  let force = force.unwrap_or(false);
  run_blocking(move || {
    let mut args = vec!["pair".to_string(), "--center-url".to_string(), center_url];
    if let Some(name) = display_name {
      args.push("--name".to_string());
      args.push(name);
    }
    if force {
      args.push("--force".to_string());
    }
    let result = run_launcher(&args, Some(password.as_str()), PAIR_TIMEOUT)?;
    drop(password);
    Ok(result)
  })
  .await
}

#[tauri::command]
pub async fn desktop_host_adopt(
  webview: Webview,
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
  let center_ca = center_ca.filter(|pem| !pem.trim().is_empty());
  run_blocking(move || {
    let mut args = vec![
      "adopt".to_string(),
      "--center-url".to_string(),
      center_url,
      "--device-id".to_string(),
      device_id,
    ];
    if let Some(pem) = center_ca {
      let ca_path = write_center_ca(&pem)?;
      args.push("--center-ca-file".to_string());
      args.push(ca_path.to_string_lossy().into_owned());
    }
    let adopt = run_launcher(&args, Some(device_token.as_str()), PAIR_TIMEOUT)?;
    drop(device_token);
    let enable = run_launcher(&["enable".to_string()], None, CONTROL_TIMEOUT)?;
    let start = if adopt.get("restarted").and_then(Value::as_bool) == Some(true) {
      json!({ "status": "restarted" })
    } else {
      start_or_restart()?
    };
    let mut out = Map::new();
    out.insert("adopt".to_string(), adopt);
    out.insert("enable".to_string(), enable);
    out.insert("start".to_string(), start);
    Ok(Value::Object(out))
  })
  .await
}

#[tauri::command]
pub async fn desktop_host_control(webview: Webview, action: String) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  if !CONTROL_ACTIONS.contains(&action.as_str()) {
    return Err(invalid("unsupported host control action"));
  }
  run_blocking(move || run_launcher(&[action], None, CONTROL_TIMEOUT)).await
}
