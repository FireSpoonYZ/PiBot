//! Child-process helpers: window-less commands, detached spawn, kill, lock
//! probing and systemd (Linux) integration.

use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::paths::HostPaths;
use crate::util::{AppError, AppResult};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
pub const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

pub const SYSTEMD_UNIT: &str = "e-launcher-host.service";

/// Environment variables that must never leak into the launcher/Host
/// children. Besides the secret, this covers the selectors for executable code
/// (runtime dir, native helper, Node loader hooks): under the Windows scheduled
/// task the inherited user environment cannot be trusted to keep them inside
/// the protected install directory, so only the supervisor's bundled paths may
/// set them. env_remove matches case-insensitively on Windows.
pub const SCRUBBED_ENV: &[&str] = &[
    "E_LAUNCHER_OWNER_PASSWORD",
    "E_LAUNCHER_HOST_RUNTIME",
    "E_LAUNCHER_SHOWER_WINDOWS_EXE",
    "NODE_OPTIONS",
    "NODE_PATH",
];

/// Whether a config.json/secrets.env entry may reach the Host child. Both files
/// are user-editable while the child can run under the elevated scheduled task,
/// so loader/executable-path overrides are rejected. Windows environment names
/// are case-insensitive, so the filter compares case-insensitively there.
pub fn config_env_allowed(key: &str) -> bool {
    if cfg!(windows) {
        !SCRUBBED_ENV.iter().any(|denied| denied.eq_ignore_ascii_case(key))
    } else {
        !SCRUBBED_ENV.contains(&key)
    }
}

/// A `Command` that never opens a console window on Windows.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs a short helper command with no stdin and captured output.
pub fn run_capture(mut cmd: Command) -> std::io::Result<Output> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).output()
}

const MAX_HELPER_OUTPUT: usize = 256 * 1024;
/// How long to wait for the pipe readers to drain after the helper exited.
const OUTPUT_DRAIN: Duration = Duration::from_secs(1);

/// Drains one pipe into a shared tail-capped buffer, then bumps the done count.
/// Incremental collection means a grandchild inheriting the pipe never blocks
/// result collection — the buffer already holds whatever arrived.
fn pipe_drain(mut reader: impl Read + Send + 'static, sink: Arc<Mutex<Vec<u8>>>, done: Arc<AtomicUsize>) {
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut buf) = sink.lock() {
                        buf.extend_from_slice(&chunk[..n]);
                        // Keep only the tail beyond the cap; the result line is last.
                        if buf.len() > MAX_HELPER_OUTPUT {
                            let excess = buf.len() - MAX_HELPER_OUTPUT;
                            buf.drain(..excess);
                        }
                    }
                }
            }
        }
        done.fetch_add(1, Ordering::SeqCst);
    });
}

/// Last non-empty line of captured output.
fn last_line(bytes: &[u8]) -> Option<String> {
    bytes
        .split(|b| *b == b'\n')
        .rev()
        .map(|line| String::from_utf8_lossy(line).trim().to_string())
        .find(|line| !line.is_empty())
}

/// Runs a trusted helper and parses the LAST non-empty stdout line as JSON;
/// helpers that report errors on stderr instead (e.g. host-core/cli.js) are
/// handled by falling back to stderr's last line. An {"error":{"code","message"}}
/// payload is propagated with its code kept; fail_code covers spawn/wait
/// failures, timeouts, missing or invalid output and non-zero exits without a
/// payload. The helper inherits a scrubbed environment (no secret or
/// executable-path variables) and raw stderr text never enters our output.
pub fn run_json_command(mut cmd: Command, timeout: Duration, fail_code: &str) -> AppResult<Value> {
    for key in SCRUBBED_ENV {
        cmd.env_remove(key);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::new(fail_code, format!("failed to start helper: {e}")))?;
    let stdout_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::<u8>::new()));
    let readers_done = Arc::new(AtomicUsize::new(0));
    let mut readers = 0usize;
    if let Some(out) = child.stdout.take() {
        readers += 1;
        pipe_drain(out, stdout_buf.clone(), readers_done.clone());
    }
    if let Some(err) = child.stderr.take() {
        readers += 1;
        pipe_drain(err, stderr_buf.clone(), readers_done.clone());
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::new(fail_code, format!("failed to wait for helper: {e}")));
            }
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(AppError::new(fail_code, format!("helper timed out after {}s", timeout.as_secs())));
    };
    // Bounded drain: the child's own writes land in the pipes before it exits,
    // so the readers finish almost immediately; a leaked grandchild holding a
    // pipe open must not extend this wait past OUTPUT_DRAIN, and never past the
    // caller's own deadline — the whole call stays inside the given budget.
    let drain_deadline = (Instant::now() + OUTPUT_DRAIN).min(deadline);
    while readers_done.load(Ordering::SeqCst) < readers && Instant::now() < drain_deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    let stdout = stdout_buf.lock().map(|buf| buf.clone()).unwrap_or_default();
    let stderr = stderr_buf.lock().map(|buf| buf.clone()).unwrap_or_default();
    let parsed = last_line(&stdout)
        .and_then(|line| serde_json::from_str::<Value>(&line).ok())
        .or_else(|| last_line(&stderr).and_then(|line| serde_json::from_str::<Value>(&line).ok()));
    let Some(value) = parsed else {
        return Err(AppError::new(fail_code, format!("helper exited {status} without a JSON result")));
    };
    if let Some(error) = value.get("error").filter(|e| e.is_object()) {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .unwrap_or(fail_code)
            .to_string();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("helper failed")
            .to_string();
        return Err(AppError::new(&code, message));
    }
    if !status.success() {
        return Err(AppError::new(fail_code, format!("helper exited {status}")));
    }
    Ok(value)
}

pub fn output_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    format!("exit status {}", output.status)
}

/// True when another process holds `launcher.lock`.
pub fn lock_held(paths: &HostPaths) -> bool {
    use fs2::FileExt;
    let file = match OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&paths.lock) {
        Ok(file) => file,
        Err(_) => return false,
    };
    // Dropping the handle releases the probe lock immediately.
    file.try_lock_exclusive().is_err()
}

pub fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// Spawns `<exe> run` fully detached from the caller (no inherited stdio).
// Windows never uses this: starting goes through the protected scheduled task.
#[cfg_attr(windows, allow(dead_code))]
pub fn spawn_detached_run(exe: &Path, cwd: &Path) -> AppResult<()> {
    let mut cmd = Command::new(exe);
    cmd.arg("run").current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    for key in SCRUBBED_ENV {
        // A detached "run" resolves the runtime itself; the override is honored
        // on unix where no elevated task exists, so it must still reach the child.
        if *key == "E_LAUNCHER_HOST_RUNTIME" {
            continue;
        }
        cmd.env_remove(key);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe and only affects the forked child.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    cmd.spawn()
        .map(|_child| ())
        .map_err(|e| AppError::new("START_FAILED", format!("failed to spawn launcher: {e}")))
}

/// Asks a process to terminate gracefully (unix SIGTERM; Windows has no
/// equivalent for window-less console apps, so this is a no-op there).
#[cfg_attr(not(unix), allow(dead_code))]
pub fn terminate(pid: u32) {
    #[cfg(unix)]
    {
        if pid > 0 {
            // SAFETY: plain kill(2) call.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGTERM);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
    }
}

/// Forcefully kills a process (Windows: including its child tree).
pub fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let mut cmd = command("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let _ = run_capture(cmd);
    }
    #[cfg(unix)]
    {
        // SAFETY: plain kill(2) call.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

pub fn remove_file_quiet(path: &Path) {
    let _ = fs::remove_file(path);
}

pub fn port_open(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream};
    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

// ---------------------------------------------------------------- systemd

/// Absolute `systemctl` path on standard Debian/systemd layouts; falls back to
/// a bare `systemctl` (PATH lookup) on other distributions.
fn systemctl_program() -> std::path::PathBuf {
    for candidate in ["/usr/bin/systemctl", "/bin/systemctl", "/usr/local/bin/systemctl"] {
        let path = Path::new(candidate);
        if path.is_file() {
            return path.to_path_buf();
        }
    }
    std::path::PathBuf::from("systemctl")
}

pub fn systemctl_user(args: &[&str]) -> std::io::Result<Output> {
    let mut cmd = command(systemctl_program());
    cmd.arg("--user").args(args);
    run_capture(cmd)
}

#[cfg(target_os = "linux")]
fn unit_installed() -> bool {
    if Path::new("/usr/lib/systemd/user").join(SYSTEMD_UNIT).is_file() {
        return true;
    }
    let config = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| v.starts_with('/'))
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().filter(|v| !v.is_empty()).map(|h| Path::new(&h).join(".config")));
    let home_unit = std::env::var("HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .map(|h| Path::new(&h).join(".config/systemd/user").join(SYSTEMD_UNIT));
    home_unit.map_or(false, |p| p.is_file())
        || config.map_or(false, |c| c.join("systemd/user").join(SYSTEMD_UNIT).is_file())
}

/// Linux: a systemd user manager is reachable and the unit file is installed.
/// This is independent of whether the current `run` was started by systemd
/// (`INVOCATION_ID`), so `start`/`stop` always route through systemctl then.
#[cfg(target_os = "linux")]
pub fn systemd_available() -> bool {
    if !unit_installed() {
        return false;
    }
    matches!(systemctl_user(&["show-environment"]), Ok(out) if out.status.success())
}

#[cfg(not(target_os = "linux"))]
pub fn systemd_available() -> bool {
    false
}

/// True when this process was started by systemd as a unit.
pub fn started_by_systemd() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("INVOCATION_ID").is_some()
}

pub fn systemctl_checked(args: &[&str], code: &str) -> AppResult<()> {
    match systemctl_user(args) {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => Err(AppError::new(code, format!("systemctl --user {}: {}", args.join(" "), output_message(&out)))),
        Err(e) => Err(AppError::new(code, format!("systemctl --user {}: {e}", args.join(" ")))),
    }
}
