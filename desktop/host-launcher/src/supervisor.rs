//! `run`: foreground supervisor for the Host Node process (contract §3).

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{self, Config, Secrets, CONTROL_TOKEN_KEY, RELAY_TOKEN_KEY};
use crate::paths::{self, HostPaths, Runtime};
use crate::process;
use crate::util::{now_iso, write_atomic, AppError, AppResult};

pub const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
pub const BACKOFF_RESET_UPTIME: Duration = Duration::from_secs(5 * 60);
pub const BACKOFF_MAX: Duration = Duration::from_secs(60);
const CHILD_STOP_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_POLL: Duration = Duration::from_secs(1);
const TICK: Duration = Duration::from_millis(200);

// ------------------------------------------------------------------ backoff

/// Delay before restart number `attempt` (0-based): 2s, 4s, 8s, … capped at 60s.
pub fn backoff_delay(attempt: u32) -> Duration {
    let secs = 2u64.saturating_mul(1u64 << attempt.min(16));
    Duration::from_secs(secs).min(BACKOFF_MAX)
}

/// Attempt index to use after a child ran for `uptime`; long runs reset the backoff.
pub fn next_attempt(previous: u32, uptime: Duration) -> u32 {
    if uptime >= BACKOFF_RESET_UPTIME {
        0
    } else {
        previous
    }
}

// ------------------------------------------------------------------ status

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastExit {
    pub code: Option<i32>,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherStatus {
    pub pid: u32,
    pub host_pid: Option<u32>,
    pub started_at: String,
    pub restarts: u32,
    pub last_exit: Option<LastExit>,
}

pub fn read_status(paths: &HostPaths) -> Option<LauncherStatus> {
    let text = fs::read_to_string(&paths.status).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_status(paths: &HostPaths, status: &LauncherStatus, log: &SharedLog) {
    let mut text = serde_json::to_string(status).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    if let Err(e) = write_atomic(&paths.status, text.as_bytes(), false) {
        log_event(log, &format!("failed to write launcher.json: {}", e.message));
    }
}

// ------------------------------------------------------------------ log

/// Append-only log with single-generation rotation at 10 MiB.
pub struct LogWriter {
    path: PathBuf,
    old: PathBuf,
    file: Option<File>,
    size: u64,
    max: u64,
}

impl LogWriter {
    pub fn open(path: &Path, old: &Path, max: u64) -> Self {
        let mut writer = LogWriter { path: path.to_path_buf(), old: old.to_path_buf(), file: None, size: 0, max };
        writer.reopen();
        if writer.size > writer.max {
            writer.rotate();
        }
        writer
    }

    fn reopen(&mut self) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.size = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
    }

    fn rotate(&mut self) {
        self.file = None;
        let _ = fs::remove_file(&self.old);
        if fs::rename(&self.path, &self.old).is_err() {
            // e.g. another process has host.log open without delete sharing: truncate instead.
            let _ = File::create(&self.path);
        }
        self.reopen();
    }

    pub fn write(&mut self, bytes: &[u8]) {
        if self.file.is_none() {
            self.reopen();
        }
        if let Some(file) = self.file.as_mut() {
            if file.write_all(bytes).is_ok() {
                self.size += bytes.len() as u64;
            } else {
                self.file = None;
            }
        }
        if self.size > self.max {
            self.rotate();
        }
    }

    pub fn event(&mut self, message: &str) {
        let line = format!("[launcher {}] {}\n", now_iso(), message);
        self.write(line.as_bytes());
    }
}

type SharedLog = Arc<Mutex<LogWriter>>;

fn log_event(log: &SharedLog, message: &str) {
    if let Ok(mut writer) = log.lock() {
        writer.event(message);
    }
}

fn pipe_to_log(mut reader: impl Read + Send + 'static, log: SharedLog) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut writer) = log.lock() {
                        writer.write(&buf[..n]);
                    }
                }
            }
        }
    });
}

// ------------------------------------------------------------------ stop detection

struct StopWatch {
    signal: Arc<AtomicBool>,
    stop_request: PathBuf,
    last_poll: Instant,
}

impl StopWatch {
    /// True once Ctrl-C/SIGTERM arrived or `stop.request` exists (polled every 1s).
    fn requested(&mut self, log: &SharedLog) -> bool {
        if self.signal.load(Ordering::SeqCst) {
            return true;
        }
        if self.last_poll.elapsed() >= STOP_POLL {
            self.last_poll = Instant::now();
            if self.stop_request.exists() {
                log_event(log, "stop.request found; shutting down");
                if process::started_by_systemd() {
                    // Tell systemd this stop is intentional so Restart=always does not respawn us.
                    let _ = process::command("systemctl")
                        .args(["--user", "stop", "--no-block", process::SYSTEMD_UNIT])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
                self.signal.store(true, Ordering::SeqCst);
                return true;
            }
        }
        false
    }

    /// Sleeps up to `duration`; returns true if a stop was requested meanwhile.
    fn sleep(&mut self, duration: Duration, log: &SharedLog) -> bool {
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            if self.requested(log) {
                return true;
            }
            std::thread::sleep(TICK);
        }
        self.requested(log)
    }
}

// ------------------------------------------------------------------ child

fn host_command(paths: &HostPaths, config: &Config, secrets: &Secrets, runtime: &Runtime) -> std::process::Command {
    let mut cmd = process::command(&runtime.node);
    cmd.arg(&runtime.cli)
        .arg("serve")
        .arg("--data-root")
        .arg(&config.data_root)
        .arg("--token-env")
        .arg(CONTROL_TOKEN_KEY)
        .arg("--port")
        .arg(config.port.to_string())
        .arg("--center-url")
        .arg(&config.center_url)
        .arg("--device-token-env")
        .arg(RELAY_TOKEN_KEY)
        .arg("--npm-path")
        .arg(&runtime.npm);
    if let Some(ca) = config.center_ca_file.as_deref().filter(|c| !c.is_empty()) {
        cmd.arg("--center-ca-file").arg(ca);
    }
    cmd.current_dir(&paths.home);
    for key in process::SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    cmd.envs(&config.env);
    for (key, value) in &secrets.entries {
        cmd.env(key, value);
    }
    if let Some(shower) = &runtime.shower {
        cmd.env("E_LAUNCHER_SHOWER_WINDOWS_EXE", shower);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd
}

fn wait_timeout(child: &mut Child, timeout: Duration) -> Option<Option<i32>> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.code()),
            Ok(None) => {}
            Err(_) => return Some(None),
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Forwards termination to the Host and waits up to 10s, then kills it.
fn shutdown_child(child: &mut Child) -> Option<i32> {
    if let Ok(Some(status)) = child.try_wait() {
        return status.code();
    }
    #[cfg(unix)]
    {
        process::terminate(child.id());
        if let Some(code) = wait_timeout(child, CHILD_STOP_TIMEOUT) {
            return code;
        }
    }
    #[cfg(windows)]
    {
        process::kill_tree(child.id());
    }
    let _ = child.kill();
    match wait_timeout(child, CHILD_STOP_TIMEOUT) {
        Some(code) => code,
        None => None,
    }
}

enum Outcome {
    Exited(Option<i32>),
    Stop,
}

fn supervise(child: &mut Child, watch: &mut StopWatch, log: &SharedLog) -> Outcome {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Outcome::Exited(status.code()),
            Ok(None) => {}
            Err(_) => return Outcome::Exited(None),
        }
        if watch.requested(log) {
            return Outcome::Stop;
        }
        std::thread::sleep(TICK);
    }
}

// ------------------------------------------------------------------ run

pub fn run(paths: &HostPaths) -> AppResult<Value> {
    use fs2::FileExt;

    fs::create_dir_all(&paths.home).map_err(|e| AppError::io(&format!("create {}", paths.home.display()), e))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&paths.lock)
        .map_err(|e| AppError::io("open launcher.lock", e))?;
    if lock.try_lock_exclusive().is_err() {
        return Ok(json!({ "status": "already-running" }));
    }

    let (config, secrets) = config::load(paths)?;
    let runtime = paths::locate_runtime()?;
    process::remove_file_quiet(&paths.stop_request);
    let _ = fs::create_dir_all(&config.data_root);

    let log: SharedLog = Arc::new(Mutex::new(LogWriter::open(&paths.log, &paths.log_old, MAX_LOG_BYTES)));
    let signal = Arc::new(AtomicBool::new(false));
    {
        let signal = signal.clone();
        // No console on Windows (windows subsystem): failure to register is harmless.
        let _ = ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst));
    }
    let mut watch = StopWatch { signal, stop_request: paths.stop_request.clone(), last_poll: Instant::now() };

    let mut status = LauncherStatus {
        pid: std::process::id(),
        host_pid: None,
        started_at: now_iso(),
        restarts: 0,
        last_exit: None,
    };
    write_status(paths, &status, &log);
    log_event(&log, &format!("launcher started pid={}", status.pid));

    let mut attempt: u32 = 0;
    if process::port_open(config.port) {
        let adopted_pid = process::listening_pid(config.port);
        status.host_pid = adopted_pid;
        write_status(paths, &status, &log);
        log_event(
            &log,
            &format!(
                "adopted existing host listening on 127.0.0.1:{} pid={}",
                config.port,
                adopted_pid.map_or_else(|| "unknown".to_string(), |p| p.to_string())
            ),
        );
        let mut last_probe = Instant::now();
        let stopped = loop {
            if watch.requested(&log) {
                if let Some(pid) = adopted_pid {
                    process::kill_tree(pid);
                }
                status.host_pid = None;
                status.last_exit = Some(LastExit { code: Some(0), at: now_iso() });
                break true;
            }
            if last_probe.elapsed() >= STOP_POLL {
                last_probe = Instant::now();
                if !process::port_open(config.port) {
                    log_event(&log, "adopted host exited; switching to bundled host");
                    status.host_pid = None;
                    write_status(paths, &status, &log);
                    break false;
                }
            }
            std::thread::sleep(TICK);
        };
        if stopped {
            write_status(paths, &status, &log);
            log_event(&log, "launcher exiting");
            process::remove_file_quiet(&paths.stop_request);
            drop(lock);
            return Ok(json!({ "status": "stopped" }));
        }
    }
    loop {
        if watch.requested(&log) {
            break;
        }
        let spawned_at = Instant::now();
        let exit_code = match host_command(paths, &config, &secrets, &runtime).spawn() {
            Ok(mut child) => {
                status.host_pid = Some(child.id());
                write_status(paths, &status, &log);
                log_event(&log, &format!("host started pid={}", child.id()));
                if let Some(out) = child.stdout.take() {
                    pipe_to_log(out, log.clone());
                }
                if let Some(err) = child.stderr.take() {
                    pipe_to_log(err, log.clone());
                }
                match supervise(&mut child, &mut watch, &log) {
                    Outcome::Exited(code) => code,
                    Outcome::Stop => {
                        let code = shutdown_child(&mut child);
                        log_event(&log, &format!("host stopped code={}", fmt_code(code)));
                        status.host_pid = None;
                        status.last_exit = Some(LastExit { code, at: now_iso() });
                        break;
                    }
                }
            }
            Err(e) => {
                log_event(&log, &format!("failed to spawn host: {e}"));
                None
            }
        };

        attempt = next_attempt(attempt, spawned_at.elapsed());
        let delay = backoff_delay(attempt);
        attempt = attempt.saturating_add(1);
        status.host_pid = None;
        status.restarts = status.restarts.saturating_add(1);
        status.last_exit = Some(LastExit { code: exit_code, at: now_iso() });
        write_status(paths, &status, &log);
        log_event(&log, &format!("host exited code={}; restarting in {}s", fmt_code(exit_code), delay.as_secs()));
        if watch.sleep(delay, &log) {
            break;
        }
    }

    status.host_pid = None;
    write_status(paths, &status, &log);
    log_event(&log, "launcher exiting");
    process::remove_file_quiet(&paths.stop_request);
    drop(lock);
    Ok(json!({ "status": "stopped" }))
}

fn fmt_code(code: Option<i32>) -> String {
    code.map_or_else(|| "null".to_string(), |c| c.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_sequence() {
        let secs: Vec<u64> = (0..8).map(|a| backoff_delay(a).as_secs()).collect();
        assert_eq!(secs, vec![2, 4, 8, 16, 32, 60, 60, 60]);
        assert_eq!(backoff_delay(u32::MAX).as_secs(), 60);
    }

    #[test]
    fn backoff_resets_after_long_uptime() {
        assert_eq!(next_attempt(5, Duration::from_secs(299)), 5);
        assert_eq!(next_attempt(5, Duration::from_secs(300)), 0);
        assert_eq!(next_attempt(0, Duration::from_secs(1)), 0);
    }

    #[test]
    fn status_json_shape() {
        let status = LauncherStatus {
            pid: 10,
            host_pid: None,
            started_at: "2024-01-01T00:00:00.000Z".into(),
            restarts: 2,
            last_exit: Some(LastExit { code: None, at: "2024-01-01T00:00:01.000Z".into() }),
        };
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(
            value,
            json!({"pid":10,"hostPid":null,"startedAt":"2024-01-01T00:00:00.000Z","restarts":2,
                   "lastExit":{"code":null,"at":"2024-01-01T00:00:01.000Z"}})
        );
        let back: LauncherStatus = serde_json::from_value(value).unwrap();
        assert_eq!(back, status);
    }

    #[test]
    fn log_rotation_keeps_one_generation() {
        let dir = std::env::temp_dir().join(format!("elh-log-{}", crate::util::unix_millis_now()));
        let path = dir.join("host.log");
        let old = dir.join("host.log.1");
        let mut log = LogWriter::open(&path, &old, 16);
        log.write(b"0123456789");
        assert!(!old.exists());
        log.write(b"abcdefghij");
        assert_eq!(fs::read(&old).unwrap(), b"0123456789abcdefghij");
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        log.write(b"xyz");
        assert_eq!(fs::read(&path).unwrap(), b"xyz");
        drop(log);
        let _ = fs::remove_dir_all(&dir);
    }
}
