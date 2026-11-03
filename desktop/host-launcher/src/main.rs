//! `e-launcher-host`: pairs this machine with a center and supervises the
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
use std::io::BufRead;
use std::time::Duration;

use serde_json::{json, Value};

use crate::config::{Config, Secrets, CONFIG_VERSION, CONTROL_TOKEN_KEY, DEFAULT_PORT, RELAY_TOKEN_KEY};
use crate::paths::HostPaths;
use crate::util::{print_json, random_token, AppError, AppResult};

const USAGE: &str = "usage: e-launcher-host <command> [options]
commands:
  run        foreground supervisor for the Host service
  start      start the supervisor in the background (systemd user unit on Linux when installed)
  stop       stop the supervisor and the Host
  restart    stop + start
  status     print service status
  enable     register login autostart
  disable    remove login autostart
  pair --center-url <url> [--name <displayName>] [--port <n>] [--data-root <abs>] [--center-ca-file <f>] [--force]
             owner password from E_LAUNCHER_OWNER_PASSWORD or first stdin line
  adopt --center-url <url> --device-id <id> [--name <displayName>] [--port <n>] [--data-root <abs>] [--center-ca-file <f>]
             device token from E_LAUNCHER_RELAY_TOKEN or first stdin line
  help | version";

const START_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
const KILL_TIMEOUT: Duration = Duration::from_secs(5);
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
        "run" | "start" | "stop" | "restart" | "status" | "enable" | "disable" => {
            parse_flags(rest, &[], &[])?;
            let paths = HostPaths::resolve()?;
            match command.as_str() {
                "run" => supervisor::run(&paths),
                "start" => cmd_start(&paths),
                "stop" => cmd_stop(&paths),
                "restart" => cmd_restart(&paths),
                "status" => cmd_status(&paths),
                "enable" => autostart::enable(),
                _ => autostart::disable(),
            }
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
    if id.is_empty() || id.len() > 200 || id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new("INVALID_ARGUMENT", "--device-id is invalid"));
    }
    Ok(id.to_string())
}

fn default_display_name() -> String {
    let mut candidates: Vec<String> = Vec::new();
    if cfg!(windows) {
        candidates.extend(std::env::var("COMPUTERNAME").ok());
    } else {
        candidates.extend(std::env::var("HOSTNAME").ok());
        candidates.extend(std::fs::read_to_string("/etc/hostname").ok());
        candidates.extend(std::fs::read_to_string("/proc/sys/kernel/hostname").ok());
    }
    candidates
        .into_iter()
        .map(|c| c.trim().chars().filter(|ch| !ch.is_control()).take(MAX_NAME_CHARS).collect::<String>())
        .find(|c| !c.is_empty())
        .unwrap_or_else(|| "e-launcher-host".to_string())
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

fn cmd_status(paths: &HostPaths) -> AppResult<Value> {
    let (config, config_error) = match config::read_config(paths) {
        Ok(config) => (config, None),
        Err(e) => (None, Some(e)),
    };
    let configured = config.is_some() && config::load(paths).is_ok();
    let running = process::lock_held(paths);
    let launcher = if running { supervisor::read_status(paths) } else { None };
    let mut value = json!({
        "configured": configured,
        "running": running,
        "pid": launcher.as_ref().map(|s| s.pid),
        "hostPid": launcher.as_ref().and_then(|s| s.host_pid),
        "controlUrl": config.as_ref().map(Config::control_url),
        "centerUrl": config.as_ref().map(|c| c.center_url.clone()),
        "deviceId": config.as_ref().map(|c| c.device_id.clone()),
        "displayName": config.as_ref().map(|c| c.display_name.clone()),
        "autostart": autostart::is_enabled(),
        "logFile": paths.log.display().to_string(),
    });
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
    if process::systemd_available() {
        let _ = process::systemctl_user(&["daemon-reload"]);
        process::systemctl_checked(&["start", process::SYSTEMD_UNIT], "START_FAILED")?;
    } else {
        process::remove_file_quiet(&paths.stop_request);
        process::spawn_detached_run(&paths::exe_path()?, &paths.home)?;
    }
    if process::wait_until(START_TIMEOUT, || process::lock_held(paths)) {
        Ok(json!({ "status": "started" }))
    } else {
        Err(AppError::new(
            "START_TIMEOUT",
            format!("launcher did not start within 5s; see {}", paths.log.display()),
        ))
    }
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
        return Ok(json!({ "status": "stopped" }));
    }
    // Not managed by systemd (or systemctl failed): ask `run` to exit.
    std::fs::write(&paths.stop_request, b"stop\n").map_err(|e| AppError::io("write stop.request", e))?;
    if process::wait_until(STOP_TIMEOUT, || !process::lock_held(paths)) {
        process::remove_file_quiet(&paths.stop_request);
        return Ok(json!({ "status": "stopped" }));
    }
    if let Some(status) = supervisor::read_status(paths) {
        if let Some(host_pid) = status.host_pid {
            process::kill_tree(host_pid);
        }
        process::kill_tree(status.pid);
    }
    let released = process::wait_until(KILL_TIMEOUT, || !process::lock_held(paths));
    process::remove_file_quiet(&paths.stop_request);
    if released {
        Ok(json!({ "status": "stopped", "forced": true }))
    } else {
        Err(systemd_error.unwrap_or_else(|| AppError::new("STOP_FAILED", "launcher did not stop")))
    }
}

fn cmd_restart(paths: &HostPaths) -> AppResult<Value> {
    cmd_stop(paths)?;
    cmd_start(paths)
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

    let mut client = center::CenterClient::new(&center_url, ca_file.as_deref().map(std::path::Path::new))?;
    let registered = client.register_device(&password, &display_name, center::platform())?;
    drop(password);

    let mut warnings: Vec<String> = Vec::new();
    if process::lock_held(paths) {
        if let Err(e) = cmd_stop(paths) {
            warnings.push(format!("{}: {}", e.code, e.message));
        }
    }
    let config = Config {
        version: CONFIG_VERSION,
        center_url: center_url.clone(),
        device_id: registered.device_id.clone(),
        display_name: registered.display_name.clone(),
        data_root: data_root
            .or_else(|| previous.as_ref().map(|c| c.data_root.clone()))
            .unwrap_or_else(|| paths.data.display().to_string()),
        port: port.or_else(|| previous.as_ref().map(|c| c.port)).unwrap_or(DEFAULT_PORT),
        center_ca_file: ca_file,
        env: previous.map(|c| c.env).unwrap_or_default(),
    };
    write_pairing(paths, &config, &registered.device_token, &random_token()?)?;

    let mut result = json!({
        "deviceId": registered.device_id,
        "deviceToken": registered.device_token,
        "centerUrl": center_url,
        "displayName": config.display_name,
        "controlUrl": config.control_url(),
    });
    match autostart::enable() {
        Ok(detail) => {
            result["autostart"] = json!(true);
            if let Some(linger) = detail.get("linger") {
                result["linger"] = linger.clone();
            }
            if let Some(message) = detail.get("message").and_then(Value::as_str) {
                warnings.push(message.to_string());
            }
        }
        Err(e) => {
            result["autostart"] = json!(false);
            warnings.push(format!("{}: {}", e.code, e.message));
        }
    }
    match cmd_start(paths) {
        Ok(_) => result["running"] = json!(true),
        Err(e) => {
            result["running"] = json!(false);
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
    let config = Config {
        version: CONFIG_VERSION,
        center_url: center_url.clone(),
        device_id: device_id.clone(),
        display_name: name
            .or_else(|| previous.as_ref().map(|c| c.display_name.clone()))
            .unwrap_or_else(default_display_name),
        data_root: data_root
            .or_else(|| previous.as_ref().map(|c| c.data_root.clone()))
            .unwrap_or_else(|| paths.data.display().to_string()),
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
        cmd_start(paths)?;
        result["restarted"] = json!(true);
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
