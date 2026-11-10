//! `pibot-host`: pairs this machine with a center and supervises the
//! bundled Host service (contract §3). All machine output is one JSON line
//! on stdout; failures print `{"error":{"code","message"}}` and exit 1.

#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

mod autostart;
mod center;
mod config;
mod paths;
mod process;
mod supervisor;
mod util;

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::io::{self, BufRead};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::config::{Config, Secrets, CONFIG_VERSION, CONTROL_TOKEN_KEY, DEFAULT_PORT, RELAY_TOKEN_KEY};
use crate::paths::HostPaths;
use crate::util::{print_json, random_token, AppError, AppResult};

const USAGE: &str = "usage: pibot-host <command> [options]
commands:
  run        foreground supervisor for the Host service
  start      start the supervisor in the background (systemd user unit on Linux / LaunchAgent on macOS when installed)
  stop       stop the supervisor and the Host
  restart    stop + start
  status     print service status
  enable     register boot autostart on Linux or login autostart on Windows/macOS
  disable    remove autostart registration
  remove     stop and remove service registration, preserving business data
  prepare-update [--stop-active]
             suspend new work and report readiness; optionally stop active work
  cancel-update
             resume work after a cancelled update
  setup-shower
             run the interactive Windows Shower credential setup (briefly stops the Host)
  pair --center-url <url> [--name <displayName>] [--port <n>] [--data-root <abs>] [--center-ca-file <f>] [--force]
             owner password from E_LAUNCHER_OWNER_PASSWORD or first stdin line
  adopt --center-url <url> --device-id <id> [--name <displayName>] [--port <n>] [--data-root <abs>] [--center-ca-file <f>]
             device token from E_LAUNCHER_RELAY_TOKEN or first stdin line
  help | version";

const START_TIMEOUT: Duration = Duration::from_secs(10);
/// The outer stop waits for the supervisor's graceful child shutdown (45s for
/// Node service.close incl. ~20s native release) plus polling and write slack.
const STOP_TIMEOUT: Duration = Duration::from_secs(70);
const KILL_TIMEOUT: Duration = Duration::from_secs(5);
/// Single authenticated /v1/service probe bound for the status command.
const READY_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CANCEL_UPDATE_RETRY_TIMEOUT: Duration = Duration::from_secs(10);
const CANCEL_UPDATE_RETRY_INTERVAL: Duration = Duration::from_millis(200);
/// Slice of the setup-shower budget kept for restarting the Host afterwards:
/// host-task start 40s + lock wait 10s + pipe drain slack ≈ 55s.
const RESTART_RESERVE: Duration = Duration::from_secs(55);
/// Hard cap for the native shower-setup call itself (its internal ready poll
/// is 180s); the 300s total still covers outer stop + restart.
const SETUP_HELPER_TIMEOUT: Duration = Duration::from_secs(200);
/// Total setup-shower budget covering stop + native setup + restart.
const SETUP_SHOWER_TIMEOUT: Duration = Duration::from_secs(300);
/// Bound for the bundled cli.js init identity probe.
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_NAME_CHARS: usize = 64;

fn main() {
    let code = match collect_args().and_then(|args| dispatch(&args)) {
        Ok(value) => {
            print_json(&value);
            0
        }
        Err(error) => {
            print_json(&error.to_json());
            1
        }
    };
    std::process::exit(code);
}

fn collect_args() -> AppResult<Vec<String>> {
    std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string().map_err(|_| AppError::new("INVALID_ARGUMENT", "arguments must be valid UTF-8")))
        .collect()
}

fn dispatch(args: &[String]) -> AppResult<Value> {
    let Some((command, rest)) = args.split_first() else {
        return Err(AppError::new("INVALID_ARGUMENT", format!("missing command\n{USAGE}")));
    };
    match command.as_str() {
        "help" | "--help" | "-h" => Ok(json!({ "usage": USAGE })),
        "version" | "--version" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "run" | "start" | "stop" | "restart" | "status" | "enable" | "disable" | "remove" | "setup-shower" => {
            parse_flags(rest, &[], &[])?;
            let paths = HostPaths::resolve()?;
            match command.as_str() {
                "run" => supervisor::run(&paths),
                "start" => cmd_start(&paths),
                "stop" => cmd_stop(&paths),
                "restart" => cmd_restart(&paths),
                "status" => cmd_status(&paths),
                "enable" => autostart::enable(),
                "disable" => autostart::disable(),
                "remove" => { cmd_stop(&paths)?; autostart::remove() },
                _ => cmd_setup_shower(&paths),
            }
        }
        "prepare-update" | "cancel-update" => {
            let flags = parse_flags(rest, &[], if command == "prepare-update" { &["stop-active"] } else { &[] })?;
            cmd_update(&HostPaths::resolve()?, command == "prepare-update", flags.has("stop-active"))
        }
        "pair" => {
            let flags = parse_flags(rest, &["center-url", "name", "port", "data-root", "center-ca-file"], &["force"])?;
            cmd_pair(&HostPaths::resolve()?, &flags)
        }
        "adopt" => {
            let flags =
                parse_flags(rest, &["center-url", "device-id", "name", "port", "data-root", "center-ca-file"], &[])?;
            cmd_adopt(&HostPaths::resolve()?, &flags)
        }
        other => Err(AppError::new("INVALID_ARGUMENT", format!("unknown command {other:?}\n{USAGE}"))),
    }
}

// ------------------------------------------------------------------ flags

#[derive(Debug, Default, PartialEq)]
struct Flags {
    values: BTreeMap<String, String>,
    switches: BTreeSet<String>,
}

impl Flags {
    fn get(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    fn has(&self, name: &str) -> bool {
        self.switches.contains(name)
    }

    fn required(&self, name: &str) -> AppResult<&str> {
        self.get(name).ok_or_else(|| AppError::new("INVALID_ARGUMENT", format!("--{name} is required")))
    }
}

/// `--name value`, `--name=value` and bare switches; anything else is rejected.
fn parse_flags(args: &[String], value_flags: &[&str], switch_flags: &[&str]) -> AppResult<Flags> {
    let mut flags = Flags::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        let Some(body) = arg.strip_prefix("--") else {
            return Err(AppError::new("INVALID_ARGUMENT", format!("unexpected argument {arg:?}")));
        };
        let (name, inline) = match body.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (body, None),
        };
        if value_flags.contains(&name) {
            let value = match inline {
                Some(v) => v,
                None => {
                    let v = args
                        .get(index)
                        .ok_or_else(|| AppError::new("INVALID_ARGUMENT", format!("--{name} requires a value")))?;
                    index += 1;
                    v.clone()
                }
            };
            if flags.values.insert(name.to_string(), value).is_some() {
                return Err(AppError::new("INVALID_ARGUMENT", format!("--{name} given more than once")));
            }
        } else if switch_flags.contains(&name) {
            if inline.is_some() {
                return Err(AppError::new("INVALID_ARGUMENT", format!("--{name} does not take a value")));
            }
            flags.switches.insert(name.to_string());
        } else {
            return Err(AppError::new("INVALID_ARGUMENT", format!("unknown option --{name}")));
        }
    }
    Ok(flags)
}

fn parse_port(value: Option<&str>) -> AppResult<Option<u16>> {
    match value {
        None => Ok(None),
        Some(text) => match text.trim().parse::<u16>() {
            Ok(port) if port > 0 => Ok(Some(port)),
            _ => Err(AppError::new("INVALID_ARGUMENT", "--port must be an integer 1..65535")),
        },
    }
}

fn parse_data_root(value: Option<&str>) -> AppResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(text) => {
            let path = std::path::Path::new(text.trim());
            if text.trim().is_empty() || !path.is_absolute() {
                return Err(AppError::new("INVALID_ARGUMENT", "--data-root must be an absolute path"));
            }
            Ok(Some(path.display().to_string()))
        }
    }
}

fn parse_ca_file(value: Option<&str>) -> AppResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(text) => {
            let path = paths::absolutize(text.trim())?;
            if !path.is_file() {
                return Err(AppError::new("INVALID_ARGUMENT", format!("--center-ca-file {} does not exist", path.display())));
            }
            Ok(Some(path.display().to_string()))
        }
    }
}

fn parse_name(value: Option<&str>) -> AppResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(text) => {
            let name = text.trim();
            if name.is_empty() || name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
                return Err(AppError::new("INVALID_ARGUMENT", "--name must be 1..64 printable characters"));
            }
            Ok(Some(name.to_string()))
        }
    }
}

fn parse_device_id(text: &str) -> AppResult<String> {
    let id = text.trim();
    if id.is_empty() || id.len() > 200 || !id.bytes().all(|c| (b'!'..=b'~').contains(&c)) {
        return Err(AppError::new("INVALID_ARGUMENT", "--device-id is invalid"));
    }
    Ok(id.to_string())
}

fn default_display_name() -> String {
    let mut candidates: Vec<String> = Vec::new();
    if cfg!(windows) {
        candidates.extend(std::env::var("COMPUTERNAME").ok());
    } else if cfg!(target_os = "macos") {
        // The user-facing "Computer Name" from System Settings, then the Bonjour name.
        for key in ["ComputerName", "LocalHostName"] {
            let mut cmd = process::command("/usr/sbin/scutil");
            cmd.args(["--get", key]);
            if let Ok(out) = process::run_capture(cmd) {
                if out.status.success() {
                    candidates.push(String::from_utf8_lossy(&out.stdout).into_owned());
                }
            }
        }
    } else {
        candidates.extend(std::env::var("HOSTNAME").ok());
        candidates.extend(std::fs::read_to_string("/etc/hostname").ok());
        candidates.extend(std::fs::read_to_string("/proc/sys/kernel/hostname").ok());
    }
    candidates
        .into_iter()
        .map(|c| c.trim().chars().filter(|ch| !ch.is_control()).take(MAX_NAME_CHARS).collect::<String>())
        .find(|c| !c.is_empty())
        .unwrap_or_else(|| "pibot-host".to_string())
}

/// Secret from `env_name`, else the first stdin line (line ending removed).
fn read_secret_input(env_name: &str, what: &str) -> AppResult<String> {
    if let Ok(value) = std::env::var(env_name) {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| AppError::new("INVALID_ARGUMENT", format!("cannot read {what} from stdin: {e}")))?;
    let value = line.trim_end_matches(|c| c == '\r' || c == '\n').to_string();
    if value.is_empty() {
        return Err(AppError::new("INVALID_ARGUMENT", format!("{what} is required via {env_name} or stdin")));
    }
    Ok(value)
}

// ------------------------------------------------------------------ service control

/// Contract-restricted platform tag; the launcher ships on Windows/Linux/macOS.
fn platform_tag() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// Authenticated probe of the real Host: GET /v1/service with the local control
/// token, short timeout, no proxy/env redirects. A merely listening port or an
/// unauthenticated endpoint never counts as ready; the token never leaves here.
fn probe_ready(control_url: &str, token: &str) -> bool {
    let url = format!("{control_url}/v1/service");
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout(READY_PROBE_TIMEOUT)
        .redirects(0)
        .build()
        .get(&url)
        .set("authorization", &format!("Bearer {token}"))
        .call()
        .is_ok()
}

fn cmd_status(paths: &HostPaths) -> AppResult<Value> {
    let (config, config_error) = match config::read_config(paths) {
        Ok(config) => (config, None),
        Err(e) => (None, Some(e)),
    };
    let secrets = config::read_secrets(paths).ok().flatten();
    let configured = config.is_some() && config::load(paths).is_ok();
    let running = process::lock_held(paths);
    let launcher = if running { supervisor::read_status(paths) } else { None };
    let ready = match (config.as_ref(), secrets.as_ref()) {
        (Some(config), Some(secrets)) => secrets
            .get(CONTROL_TOKEN_KEY)
            .map(|token| probe_ready(&config.control_url(), token))
            .unwrap_or(false),
        _ => false,
    };
    let autostart = autostart::status();
    let mut value = json!({
        "configured": configured,
        "running": running,
        "ready": ready,
        "platform": platform_tag(),
        "pid": launcher.as_ref().map(|s| s.pid),
        "hostPid": launcher.as_ref().and_then(|s| s.host_pid),
        "controlUrl": config.as_ref().map(Config::control_url),
        "centerUrl": config.as_ref().map(|c| c.center_url.clone()),
        "deviceId": config.as_ref().map(|c| c.device_id.clone()),
        "displayName": config.as_ref().map(|c| c.display_name.clone()),
        "autostart": autostart
            .as_ref()
            .ok()
            .and_then(|s| s.get("autostart"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "autostartScope": if cfg!(any(windows, target_os = "macos")) { "user-login" } else { "system-boot" },
        "hostHome": paths.home.display().to_string(),
        "logFile": paths.log.display().to_string(),
    });
    if let Some(extra) = autostart::status_extra() {
        if let (Some(target), Some(source)) = (value.as_object_mut(), extra.as_object()) {
            target.extend(source.clone());
        }
    }
    if let Err(error) = autostart {
        value["autostartError"] = error.to_json()["error"].clone();
    }
    if let Some(error) = config_error {
        value["configError"] = error.to_json()["error"].clone();
    }
    if let Some(status) = launcher {
        value["restarts"] = json!(status.restarts);
        value["lastExit"] = serde_json::to_value(&status.last_exit).unwrap_or(Value::Null);
    }
    Ok(value)
}

fn cmd_start(paths: &HostPaths) -> AppResult<Value> {
    if process::lock_held(paths) {
        return Ok(json!({ "status": "running" }));
    }
    config::load(paths)?;
    paths::locate_runtime()?;
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut warnings: Vec<String> = Vec::new();
    if process::systemd_available() {
        let _ = process::systemctl_user(&["daemon-reload"]);
        process::systemctl_checked(&["start", process::SYSTEMD_UNIT], "START_FAILED")?;
    } else {
        process::remove_file_quiet(&paths.stop_request);
        #[cfg(windows)]
        {
            // Start goes through the protected scheduled task only; a missing
            // helper or unprotected install is an explicit error, never a
            // normal-privilege spawn fallback.
            autostart::host_task("start", autostart::HOST_TASK_START_TIMEOUT)?;
        }
        #[cfg(target_os = "macos")]
        {
            // A current, enabled LaunchAgent runs the Host under launchd (crash
            // restarts); otherwise, or when launchd refuses, start directly.
            if let autostart::LaunchdStart::Direct(note) = autostart::launchd_start() {
                warnings.extend(note);
                process::spawn_detached_run(&paths::exe_path()?, &paths.home)?;
            }
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            process::spawn_detached_run(&paths::exe_path()?, &paths.home)?;
        }
    }
    if process::wait_until(START_TIMEOUT, || process::lock_held(paths)) {
        let mut result = json!({ "status": "started" });
        if !warnings.is_empty() {
            result["warnings"] = json!(warnings);
        }
        Ok(result)
    } else {
        Err(AppError::new(
            "START_TIMEOUT",
            format!("launcher did not start within 10s; see {}", paths.log.display()),
        ))
    }
}

/// Result of a completed stop. On macOS the LaunchAgent job is also unloaded
/// so KeepAlive cannot respawn a `run` that keeps failing at startup (the
/// equivalent of `systemctl stop` ending a Restart=always loop); `start`
/// reloads it and so does the next login.
fn stopped(forced: bool) -> Value {
    let mut value = json!({ "status": "stopped" });
    if forced {
        value["forced"] = json!(true);
    }
    #[cfg(target_os = "macos")]
    if let Err(e) = autostart::launchd_unload() {
        value["warnings"] = json!([format!("{}: {}", e.code, e.message)]);
    }
    value
}

fn cmd_stop(paths: &HostPaths) -> AppResult<Value> {
    let mut systemd_error = None;
    if process::systemd_available() {
        if let Err(e) = process::systemctl_checked(&["stop", process::SYSTEMD_UNIT], "STOP_FAILED") {
            systemd_error = Some(e);
        }
    }
    if !process::lock_held(paths) {
        process::remove_file_quiet(&paths.stop_request);
        return Ok(stopped(false));
    }
    // Not managed by systemd (or systemctl failed): ask `run` to exit.
    std::fs::write(&paths.stop_request, b"stop\n").map_err(|e| AppError::io("write stop.request", e))?;
    if process::wait_until(STOP_TIMEOUT, || !process::lock_held(paths)) {
        process::remove_file_quiet(&paths.stop_request);
        return Ok(stopped(false));
    }
    // launchd answers a killed (non-zero exit) supervisor with a KeepAlive
    // respawn; request the unload before killing so a forced stop stays stopped.
    #[cfg(target_os = "macos")]
    autostart::launchd_release_for_kill();
    if let Some(status) = supervisor::read_status(paths) {
        if let Some(host_pid) = status.host_pid {
            process::kill_tree(host_pid);
        }
        process::kill_tree(status.pid);
    }
    let released = process::wait_until(KILL_TIMEOUT, || !process::lock_held(paths));
    process::remove_file_quiet(&paths.stop_request);
    if released {
        Ok(stopped(true))
    } else {
        Err(systemd_error.unwrap_or_else(|| AppError::new("STOP_FAILED", "launcher did not stop")))
    }
}

fn cmd_restart(paths: &HostPaths) -> AppResult<Value> {
    cmd_stop(paths)?;
    cmd_start(paths)
}

/// setup-shower (Windows): stop the Host, run the interactive native credential
/// onboarding (shower-windows.exe shower-setup) within the 300s total budget,
/// then restart the Host when it was running. The original setup error is kept
/// even when the restart afterwards also fails.
fn cmd_setup_shower(paths: &HostPaths) -> AppResult<Value> {
    if !cfg!(windows) {
        return Err(AppError::new("SETUP_UNAVAILABLE", "setup-shower is only supported on Windows"));
    }
    let deadline = Instant::now() + SETUP_SHOWER_TIMEOUT;
    // Works before the first pairing too: without config.json the state dir
    // falls back to the default data dir, matching <dataRoot>/shower-windows
    // from host-core/shower-windows.js once paired.
    let state_dir = match config::read_config(paths)? {
        Some(config) => std::path::Path::new(&config.data_root).join("shower-windows"),
        None => paths.data.join("shower-windows"),
    };
    let shower = paths::locate_runtime()?.shower.ok_or_else(|| {
        AppError::new("RUNTIME_MISSING", "protected shower-windows.exe setup helper is not installed")
    })?;
    let was_running = process::lock_held(paths);
    if was_running {
        cmd_stop(paths)?;
    }
    // Reserve the restart slice inside the 300s total so a slow helper cannot
    // consume the whole budget before the Host is started again.
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .saturating_sub(if was_running { RESTART_RESERVE } else { Duration::ZERO })
        .min(SETUP_HELPER_TIMEOUT);
    let result = if remaining.is_zero() {
        Err(AppError::new("SETUP_TIMEOUT", "setup-shower timed out before the native helper started"))
    } else {
        let mut cmd = process::command(&shower);
        cmd.arg("shower-setup").arg("--state-dir").arg(&state_dir);
        process::run_json_command(cmd, remaining, "SETUP_FAILED")
    };
    let mut restart_error = None;
    if was_running {
        if let Err(e) = cmd_start(paths) {
            restart_error = Some(format!("{}: {}", e.code, e.message));
        }
    }
    match result {
        Ok(mut value) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("restarted".to_string(), Value::Bool(was_running && restart_error.is_none()));
                if let Some(warning) = restart_error {
                    if let Some(list) = obj
                        .entry("warnings".to_string())
                        .or_insert_with(|| json!([]))
                        .as_array_mut()
                    {
                        list.push(Value::String(warning));
                    }
                }
            }
            Ok(value)
        }
        Err(mut error) => {
            if let Some(warning) = restart_error {
                error.message = format!("{}; host restart afterwards failed: {}", error.message, warning);
            }
            Err(error)
        }
    }
}

fn cmd_update(paths: &HostPaths, prepare: bool, stop_active: bool) -> AppResult<Value> {
    if !process::lock_held(paths) {
        return Ok(json!({ "ready": true, "activeCount": 0, "maintenance": false }));
    }
    let (config, secrets) = config::load(paths)?;
    let token = secrets.get(CONTROL_TOKEN_KEY)
        .ok_or_else(|| AppError::new("CONFIG_INVALID", "control token is missing"))?;
    let url = format!("{}/v1/service/update", config.control_url());
    let agent = ureq::AgentBuilder::new().redirects(0)
        .timeout_connect(Duration::from_secs(2)).timeout(Duration::from_secs(55)).build();
    let authorization = format!("Bearer {token}");
    let body = json!({ "action": if prepare { "prepare" } else { "cancel" }, "stopActive": stop_active });
    let retry_deadline = Instant::now() + CANCEL_UPDATE_RETRY_TIMEOUT;
    let response = loop {
        match agent.post(&url).set("authorization", &authorization).send_json(&body) {
            Ok(response) => break response,
            // A DEB upgrade can restart the supervisor before its control port starts listening.
            Err(ureq::Error::Transport(error)) if !prepare
                && error.source().and_then(|source| source.downcast_ref::<io::Error>())
                    .is_some_and(|cause| cause.kind() == io::ErrorKind::ConnectionRefused)
                && Instant::now() + CANCEL_UPDATE_RETRY_INTERVAL <= retry_deadline =>
            {
                std::thread::sleep(CANCEL_UPDATE_RETRY_INTERVAL);
            }
            Err(error) => return Err(AppError::new("UPDATE_FAILED", format!("Host update coordination failed: {error}"))),
        }
    };
    response
        .into_json::<Value>()
        .map_err(|_| AppError::new("UPDATE_FAILED", "Host returned invalid update state"))
}

// ------------------------------------------------------------------ pairing

/// Writes secrets first and config last, so `configured` only flips once both exist.
fn write_pairing(paths: &HostPaths, config: &Config, relay_token: &str, control_token: &str) -> AppResult<()> {
    let mut secrets: Secrets = config::read_secrets(paths).ok().flatten().unwrap_or_default();
    secrets.set(CONTROL_TOKEN_KEY, control_token);
    secrets.set(RELAY_TOKEN_KEY, relay_token);
    let _ = std::fs::create_dir_all(&config.data_root);
    let _ = std::fs::create_dir_all(&paths.logs);
    config::write_secrets(paths, &secrets)?;
    config::write_config(paths, config)
}

/// The local Host store's own deviceId via the bundled Node +
/// host-core/cli.js init — Node always answers with this ID, so it is the only
/// one the center may register. init opens (and on first use creates) the
/// store; it never starts the Agent.
fn host_identity(runtime: &paths::Runtime, data_root: &str, expected: Option<&str>) -> AppResult<String> {
    let cli = runtime
        .cli
        .parent()
        .map(|dir| dir.join("host-service-cli.js"))
        .filter(|p| p.is_file())
        .ok_or_else(|| AppError::new("RUNTIME_MISSING", "bundled host-core/cli.js not found"))?;
    let mut cmd = process::command(&runtime.node);
    cmd.arg("--preserve-symlinks-main").arg(&cli).arg("identity").arg("--data-root").arg(data_root);
    if let Some(id) = expected { cmd.arg("--expected-device-id").arg(id); }
    let out = process::run_json_command(cmd, IDENTITY_TIMEOUT, "IDENTITY_FAILED")?;
    out.get("deviceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::new("IDENTITY_FAILED", "host identity init returned no deviceId"))
}

/// Effective Host data root: explicit --data-root, else the previous config's,
/// else the default under HOST_HOME.
fn effective_data_root(flag: Option<String>, previous: Option<&Config>, paths: &HostPaths) -> String {
    flag.or_else(|| previous.map(|c| c.data_root.clone()))
        .unwrap_or_else(|| paths.data.display().to_string())
}

fn cmd_pair(paths: &HostPaths, flags: &Flags) -> AppResult<Value> {
    let center_url = center::normalize_center_url(flags.required("center-url")?)?;
    let port = parse_port(flags.get("port"))?;
    let data_root = parse_data_root(flags.get("data-root"))?;
    let ca_file = parse_ca_file(flags.get("center-ca-file"))?;
    let name = parse_name(flags.get("name"))?;
    if paths.config.exists() && !flags.has("force") {
        return Err(AppError::new("ALREADY_CONFIGURED", "Host service is already paired; use --force to re-pair"));
    }
    let previous = config::read_config(paths).ok().flatten();
    let display_name = name.unwrap_or_else(default_display_name);
    let password = read_secret_input("E_LAUNCHER_OWNER_PASSWORD", "owner password")?;
    let data_root = effective_data_root(data_root, previous.as_ref(), paths);
    let runtime = paths::locate_runtime()?;
    let device_id = host_identity(&runtime, &data_root, None)?;
    let pending_path = paths.home.join("pairing-pending.json");
    let force = flags.has("force");
    let pending = match std::fs::read(&pending_path) {
        Ok(bytes) => Some(serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| AppError::new("CONFIG_INVALID", "pending pairing is invalid"))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(AppError::io("read pending pairing", e)),
    };
    let token = pending.as_ref().filter(|p|
        p["centerUrl"] == center_url && p["deviceId"] == device_id && p["force"] == force
    ).and_then(|p| p["deviceToken"].as_str()).map(str::to_owned).unwrap_or(random_token()?);
    crate::util::write_atomic(&pending_path, json!({
        "centerUrl": center_url, "deviceId": device_id, "deviceToken": token, "force": force
    }).to_string().as_bytes(), true)?;

    let mut client = center::CenterClient::new(&center_url, ca_file.as_deref().map(std::path::Path::new))?;
    let registered = client.register_device(
        &password,
        &display_name,
        center::platform(),
        &device_id,
        &token,
        force,
    )?;
    drop(password);
    if registered.device_id != device_id || registered.device_token != token {
        return Err(AppError::new(
            "CENTER_ERROR",
            "POST /api/devices returned a deviceId different from the local Host identity",
        ));
    }

    // Registration + persistence only: enable/start/wait-ready are separate UI
    // steps (each with its own budget) so a slow helper cannot strand pairing.
    let mut warnings: Vec<String> = Vec::new();
    let mut stop_failed = false;
    if process::lock_held(paths) {
        if let Err(e) = cmd_stop(paths) {
            stop_failed = true;
            warnings.push(format!("{}: {}", e.code, e.message));
        }
    }
    let config = Config {
        version: CONFIG_VERSION,
        center_url: center_url.clone(),
        device_id: registered.device_id.clone(),
        display_name: registered.display_name.clone(),
        data_root,
        port: port.or_else(|| previous.as_ref().map(|c| c.port)).unwrap_or(DEFAULT_PORT),
        center_ca_file: ca_file,
        env: previous.map(|c| c.env).unwrap_or_default(),
    };
    let control_token = random_token()?;
    write_pairing(paths, &config, &registered.device_token, &control_token)?;
    // Pairing is committed; cleanup failure must not hide the recoverable credentials.
    let _ = std::fs::remove_file(&pending_path);

    // Report the real current state; nothing was enabled or started here.
    // A failed stop leaves the OLD process serving the previous config, so the
    // UI must call restart (not start, which would no-op on the live process).
    let running = process::lock_held(paths);
    let ready = running && probe_ready(&config.control_url(), &control_token);
    let mut result = json!({
        "configured": true,
        "deviceId": registered.device_id,
        "deviceToken": registered.device_token,
        "centerUrl": center_url,
        "displayName": config.display_name,
        "controlUrl": config.control_url(),
        "running": running,
        "ready": ready,
        "restartRequired": stop_failed && running,
    });
    match autostart::status() {
        Ok(status) => {
            result["autostart"] = json!(status.get("autostart").and_then(Value::as_bool).unwrap_or(false));
        }
        Err(e) => {
            result["autostart"] = json!(false);
            warnings.push(format!("{}: {}", e.code, e.message));
        }
    }
    if !warnings.is_empty() {
        result["warnings"] = json!(warnings);
    }
    Ok(result)
}

fn cmd_adopt(paths: &HostPaths, flags: &Flags) -> AppResult<Value> {
    let center_url = center::normalize_center_url(flags.required("center-url")?)?;
    let device_id = parse_device_id(flags.required("device-id")?)?;
    let port = parse_port(flags.get("port"))?;
    let data_root = parse_data_root(flags.get("data-root"))?;
    let ca_file = parse_ca_file(flags.get("center-ca-file"))?;
    let name = parse_name(flags.get("name"))?;
    let relay_token = read_secret_input(RELAY_TOKEN_KEY, "device token")?.trim().to_string();
    if relay_token.is_empty() || relay_token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new("INVALID_ARGUMENT", "device token is invalid"));
    }
    let existing_secrets = config::read_secrets(paths).ok().flatten();
    let control_token = match std::env::var(CONTROL_TOKEN_KEY)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| {
            existing_secrets
                .as_ref()
                .and_then(|s| s.get(CONTROL_TOKEN_KEY))
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
        }) {
        Some(token) => token,
        None => random_token()?,
    };
    let previous = config::read_config(paths).ok().flatten();
    let data_root = effective_data_root(data_root, previous.as_ref(), paths);
    // Manual adopt must target the ID the local Host store actually presents;
    // anything else would write a config Node can never authenticate with.
    let runtime = paths::locate_runtime()?;
    let identity = host_identity(&runtime, &data_root, Some(&device_id))?;
    if identity != device_id {
        return Err(AppError::new(
            "DEVICE_ID_MISMATCH",
            format!(
                "--device-id {device_id} does not match the local Host identity {identity}; adopting an existing device requires a matching Host store"
            ),
        ));
    }
    let config = Config {
        version: CONFIG_VERSION,
        center_url: center_url.clone(),
        device_id: device_id.clone(),
        display_name: name
            .or_else(|| previous.as_ref().map(|c| c.display_name.clone()))
            .unwrap_or_else(default_display_name),
        data_root,
        port: port.or_else(|| previous.as_ref().map(|c| c.port)).unwrap_or(DEFAULT_PORT),
        center_ca_file: ca_file,
        env: previous.map(|c| c.env).unwrap_or_default(),
    };

    // A launcher already running with the old identity is restarted so it
    // picks up the new files; a stopped one stays stopped.
    let was_running = process::lock_held(paths);
    if was_running {
        cmd_stop(paths)?;
    }
    write_pairing(paths, &config, &relay_token, &control_token)?;
    let mut result = json!({
        "configured": true,
        "deviceId": device_id,
        "centerUrl": center_url,
        "displayName": config.display_name,
        "controlUrl": config.control_url(),
        "restarted": false,
    });
    if was_running {
        // A failed restart must not lose the already-persisted adoption: the
        // caller can retry via start/enable once the task helper is present.
        match cmd_start(paths) {
            Ok(_) => result["restarted"] = json!(true),
            Err(e) => {
                result["restarted"] = json!(false);
                result["warnings"] = json!([format!("{}: {}", e.code, e.message)]);
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_parse_values_and_switches() {
        let args = strings(&["--center-url", "https://c", "--port=7000", "--force"]);
        let flags = parse_flags(&args, &["center-url", "port"], &["force"]).unwrap();
        assert_eq!(flags.get("center-url"), Some("https://c"));
        assert_eq!(flags.get("port"), Some("7000"));
        assert!(flags.has("force"));
    }

    #[test]
    fn flags_reject_unknown_duplicate_and_positional() {
        let unknown = parse_flags(&strings(&["--bogus"]), &["port"], &[]).unwrap_err();
        assert_eq!(unknown.code, "INVALID_ARGUMENT");
        assert!(parse_flags(&strings(&["--port", "1", "--port", "2"]), &["port"], &[]).is_err());
        assert!(parse_flags(&strings(&["extra"]), &[], &[]).is_err());
        assert!(parse_flags(&strings(&["--port"]), &["port"], &[]).is_err());
        assert!(parse_flags(&strings(&["--force=1"]), &[], &["force"]).is_err());
        assert!(parse_flags(&strings(&["--x"]), &[], &[]).is_err());
    }

    #[test]
    fn port_and_name_validation() {
        assert_eq!(parse_port(Some("6279")).unwrap(), Some(6279));
        assert!(parse_port(Some("0")).is_err());
        assert!(parse_port(Some("70000")).is_err());
        assert_eq!(parse_name(Some("  pc ")).unwrap().as_deref(), Some("pc"));
        assert!(parse_name(Some("   ")).is_err());
        assert!(parse_name(Some(&"x".repeat(65))).is_err());
        assert!(parse_data_root(Some("relative/dir")).is_err());
        assert!(parse_device_id("a b").is_err());
    }

    #[test]
    fn unknown_command_is_invalid_argument() {
        assert_eq!(dispatch(&strings(&["nope"])).unwrap_err().code, "INVALID_ARGUMENT");
        assert_eq!(dispatch(&[]).unwrap_err().code, "INVALID_ARGUMENT");
        assert_eq!(dispatch(&strings(&["status", "--x"])).unwrap_err().code, "INVALID_ARGUMENT");
    }
}
