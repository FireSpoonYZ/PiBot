//! Child-process helpers: window-less commands, detached spawn, kill, lock
//! probing and systemd (Linux) integration.

use std::fs::{self, OpenOptions};
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use crate::paths::HostPaths;
use crate::util::{AppError, AppResult};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
pub const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
pub const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

pub const SYSTEMD_UNIT: &str = "e-launcher-host.service";

/// Environment variables that must never leak into the launcher/Host children.
pub const SCRUBBED_ENV: &[&str] = &["E_LAUNCHER_OWNER_PASSWORD"];

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
pub fn spawn_detached_run(exe: &Path, cwd: &Path) -> AppResult<()> {
    let mut cmd = Command::new(exe);
    cmd.arg("run").current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    for key in SCRUBBED_ENV {
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

pub fn listening_pid(port: u16) -> Option<u32> {
    #[cfg(windows)]
    {
        let mut cmd = command("netstat");
        cmd.args(["-ano", "-p", "tcp"]);
        let out = run_capture(cmd).ok()?;
        let needle_local = format!("127.0.0.1:{port}");
        let needle_any = format!("0.0.0.0:{port}");
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 5 && cols[3].eq_ignore_ascii_case("LISTENING") {
                if cols[1] == needle_local || cols[1] == needle_any {
                    if let Ok(pid) = cols[4].parse::<u32>() {
                        if pid > 0 {
                            return Some(pid);
                        }
                    }
                }
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        let _ = port;
        None
    }
}

// ---------------------------------------------------------------- systemd

pub fn systemctl_user(args: &[&str]) -> std::io::Result<Output> {
    let mut cmd = command("systemctl");
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
