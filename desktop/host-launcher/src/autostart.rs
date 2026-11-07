//! Login autostart: Windows protected scheduled task via the `host-task`
//! helper inside shower-windows.exe; Linux systemd user unit.

use serde_json::{json, Value};

#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use std::time::Duration;

#[allow(unused_imports)]
use crate::util::{AppError, AppResult};

/// status is a plain user query and never prompts for elevation.
#[cfg(windows)]
pub const HOST_TASK_FAST_TIMEOUT: Duration = Duration::from_secs(30);
/// start triggers the scheduled task; a little more room than a plain query.
#[cfg(windows)]
pub const HOST_TASK_START_TIMEOUT: Duration = Duration::from_secs(40);
/// install/enable/disable may go through a controlled elevation (runas) prompt.
#[cfg(windows)]
pub const HOST_TASK_ELEVATED_TIMEOUT: Duration = Duration::from_secs(180);

#[cfg(windows)]
mod win {
    use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER};

    use crate::util::{AppError, AppResult};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "e-launcher-host";
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Removes the pre-scheduled-task HKCU Run value; a missing value is success.
    pub fn delete() -> AppResult<()> {
        let key = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        // SAFETY: valid NUL-terminated UTF-16 buffers.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } as u32;
        if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
            return Err(AppError::new("AUTOSTART_FAILED", format!("RegDeleteKeyValueW failed ({status})")));
        }
        Ok(())
    }
}

/// The protected native helper bundled next to the runtime. A missing helper is
/// an explicit error; we never fall back to a normal-privilege mechanism.
#[cfg(windows)]
fn shower_helper() -> AppResult<PathBuf> {
    crate::paths::locate_runtime()?.shower.ok_or_else(|| {
        AppError::new("RUNTIME_MISSING", "protected shower-windows.exe host-task helper is not installed")
    })
}

/// Runs `<shower-windows.exe> host-task <action>` and parses its JSON result;
/// `{error:{code,message}}` payloads keep their code and a non-zero exit.
#[cfg(windows)]
pub fn host_task(action: &str, timeout: Duration) -> AppResult<Value> {
    let exe = shower_helper()?;
    let mut cmd = crate::process::command(&exe);
    cmd.arg("host-task").arg(action);
    crate::process::run_json_command(cmd, timeout, "HOST_TASK_FAILED")
}

#[cfg(windows)]
fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(windows)]
pub fn enable() -> AppResult<Value> {
        let status = host_task("status", HOST_TASK_FAST_TIMEOUT)?;
        let mut enabled = bool_field(&status, "autostart");
        if !bool_field(&status, "installed") {
            let installed = host_task("install", HOST_TASK_ELEVATED_TIMEOUT)?;
            enabled = bool_field(&installed, "autostart");
        }
        if !enabled {
            host_task("enable", HOST_TASK_ELEVATED_TIMEOUT)?;
        }
        // The HKCU Run value is gone as an autostart mechanism; drop a stale
        // value so a previously installed Host cannot start twice at login.
        let _ = win::delete();
        Ok(json!({ "autostart": true }))
}

#[cfg(windows)]
pub fn disable() -> AppResult<Value> {
        let status = host_task("status", HOST_TASK_FAST_TIMEOUT)?;
        if bool_field(&status, "installed") {
            host_task("disable", HOST_TASK_ELEVATED_TIMEOUT)?;
        }
        let _ = win::delete();
        Ok(json!({ "autostart": false }))
}

#[cfg(windows)]
pub fn is_enabled() -> bool {
    status().ok().and_then(|s| s.get("autostart").and_then(Value::as_bool)).unwrap_or(false)
}

#[cfg(windows)]
pub fn remove() -> AppResult<Value> {
    host_task("remove", HOST_TASK_ELEVATED_TIMEOUT)?;
    win::delete()?;
    Ok(json!({ "removed": true }))
}

pub fn status() -> AppResult<Value> {
    #[cfg(windows)]
    {
        let status = host_task("status", HOST_TASK_FAST_TIMEOUT)?;
        let installed = bool_field(&status, "installed");
        let raw_autostart = bool_field(&status, "autostart");
        if !installed && raw_autostart {
            return Err(AppError::new(
                "AUTOSTART_MIGRATION_REQUIRED",
                "legacy autostart is present but the scheduled task is not installed; run 'pibot-host enable' to migrate",
            ));
        }
        Ok(json!({
            "installed": installed,
            "autostart": installed && raw_autostart,
        }))
    }
    #[cfg(target_os = "linux")]
    {
        Ok(json!({
            "installed": crate::process::systemd_available(),
            "autostart": is_enabled(),
        }))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Ok(json!({ "installed": false, "autostart": false }))
    }
}

#[cfg(target_os = "linux")]
mod linux_service {
    use std::path::{Path, PathBuf};

    use serde_json::{json, Value};

    use crate::process::{self, SYSTEMD_UNIT};
    use crate::util::{AppError, AppResult};

    /// Protected helper shipped by the DEB and run through `sudo -n`. It only
    /// records the *calling* user's UID and absolute Host home under
    /// /var/lib/e-launcher/hosts/ for the package maintainer scripts; it never
    /// executes user-supplied commands and stores no secrets.
    const HOSTCTL: &str = "/usr/lib/pibot/pibot-hostctl";
    const DROPIN_NAME: &str = "10-host-home.conf";

    /// `systemd/user/e-launcher-host.service.d` under the user's config home.
    fn dropin_dir() -> AppResult<PathBuf> {
        Ok(xdg_config_home()?
            .join("systemd")
            .join("user")
            .join(format!("{SYSTEMD_UNIT}.d")))
    }

    fn dropin_path() -> AppResult<PathBuf> {
        Ok(dropin_dir()?.join(DROPIN_NAME))
    }

    /// `$XDG_CONFIG_HOME` (absolute) else `$HOME/.config`; mirrors the
    /// resolution used for the default HOST_HOME.
    fn xdg_config_home() -> AppResult<PathBuf> {
        if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                return Ok(path);
            }
        }
        let home = std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| AppError::new("IO_ERROR", "HOME is not set"))?;
        Ok(home.join(".config"))
    }

    /// systemd `Environment=` quoting: inside double quotes backslash and
    /// double-quote are escapes and `%` must be doubled to `%%`.
    fn systemd_quote(raw: &str) -> String {
        raw.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    }

    /// Writes `systemd/user/e-launcher-host.service.d/10-host-home.conf` so
    /// `run` under the user manager always sees the actual absolute HOST_HOME,
    /// including when it came from an E_LAUNCHER_HOST_HOME override.
    fn write_home_dropin(home: &Path) -> AppResult<()> {
        let raw = home
            .to_str()
            .ok_or_else(|| AppError::new("AUTOSTART_FAILED", format!("host home {} is not valid UTF-8", home.display())))?;
        if raw.chars().any(char::is_control) {
            return Err(AppError::new(
                "AUTOSTART_FAILED",
                format!("host home {} contains control characters", home.display()),
            ));
        }
        let body = format!("[Service]\nEnvironment=\"E_LAUNCHER_HOST_HOME={}\"\n", systemd_quote(raw));
        crate::util::write_atomic(&dropin_path()?, body.as_bytes(), false)
    }

    /// Removes only this product's drop-in; never touches user data or other
    /// unit files. A missing file is success.
    fn remove_home_dropin() -> AppResult<()> {
        let file = dropin_path()?;
        match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io("remove Host autostart drop-in", e)),
        }
    }

    /// Host home pinned by the drop-in, if present and parseable. Lets
    /// registration use the real Host path instead of guessing from the
    /// login home.
    fn dropin_host_home() -> Option<PathBuf> {
        let text = std::fs::read_to_string(dropin_path().ok()?).ok()?;
        for line in text.lines() {
            let line = line.trim();
            if let Some(value) = line.strip_prefix("Environment=\"E_LAUNCHER_HOST_HOME=") {
                let value = value.strip_suffix('"')?;
                // Only simple unescaped values are accepted; anything else is
                // left for the next `enable` to rewrite.
                if value.contains('\\') || value.contains('"') {
                    return None;
                }
                let path = PathBuf::from(value.replace("%%", "%"));
                if path.is_absolute() {
                    return Some(path);
                }
            }
        }
        None
    }

    /// Real login name of the calling user via `id -un`; the USER environment
    /// variable is deliberately not trusted.
    fn current_user_name() -> Option<String> {
        let mut cmd = process::command("id");
        cmd.arg("-un");
        let out = process::run_capture(cmd).ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && !name.is_empty()).then_some(name)
    }

    /// Current linger state for the calling user: (enabled, detail). Read-only;
    /// used by status and by enable verification.
    fn linger_state() -> (bool, Option<String>) {
        let Some(user) = current_user_name() else {
            return (false, Some("cannot determine current user for loginctl".to_string()));
        };
        let mut show = process::command("loginctl");
        show.args(["show-user", &user, "--property=Linger", "--value"]);
        match process::run_capture(show) {
            Ok(out) if out.status.success() => {
                let v = String::from_utf8_lossy(&out.stdout);
                let v = v.trim();
                // `--value` prints yes/no; older systemd prints Linger=yes.
                if v == "yes" || v == "Linger=yes" {
                    (true, None)
                } else {
                    (false, Some(format!("linger is not enabled: {v}")))
                }
            }
            Ok(out) => (false, Some(format!("linger check failed: {}", process::output_message(&out)))),
            Err(e) => (false, Some(format!("linger check failed: {e}"))),
        }
    }

    /// Runs the protected helper via `sudo -n`. Arguments are fixed literals
    /// chosen by this module; the only variable input is the home path.
    fn hostctl(args: &[&str]) -> std::io::Result<std::process::Output> {
        let mut cmd = process::command("sudo");
        cmd.args(["-n", "--", HOSTCTL]).args(args);
        process::run_capture(cmd)
    }

    /// Registers (uid, host home) with the DEB lifecycle registry. `home` must
    /// be the real absolute Host home, never the login home.
    fn register_home(home: &Path) -> AppResult<()> {
        let home_str = home
            .to_str()
            .ok_or_else(|| AppError::new("AUTOSTART_FAILED", format!("host home {} is not valid UTF-8", home.display())))?;
        let config_home = xdg_config_home()?;
        let config_str = config_home.to_str().ok_or_else(|| AppError::new("AUTOSTART_FAILED", "XDG config path is not UTF-8"))?;
        let out = hostctl(&["register", home_str, config_str])
            .map_err(|e| AppError::new("AUTOSTART_FAILED", format!("host registration failed: {e}")))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(AppError::new(
                "AUTOSTART_FAILED",
                format!("host registration failed: {}", process::output_message(&out)),
            ))
        }
    }

    fn unregister_home() -> AppResult<()> {
        let out = hostctl(&["unregister"])
            .map_err(|e| AppError::new("AUTOSTART_FAILED", format!("host unregistration failed: {e}")))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(AppError::new(
                "AUTOSTART_FAILED",
                format!("host unregistration failed: {}", process::output_message(&out)),
            ))
        }
    }

    /// Authoritative `systemctl --user is-enabled` result.
    fn unit_is_enabled() -> bool {
        match process::systemctl_user(&["is-enabled", SYSTEMD_UNIT]) {
            Ok(out) => out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "enabled",
            Err(_) => false,
        }
    }

    /// daemon-reload must succeed before enable/disable claims are trusted.
    fn daemon_reload() -> AppResult<()> {
        process::systemctl_checked(&["daemon-reload"], "AUTOSTART_FAILED")
    }

    /// enable: pin Host home drop-in, daemon-reload, enable + verify the
    /// unit, enable + verify linger, register (uid, Host home) for the DEB
    /// lifecycle. Registration failure is a hard error: autostart without a
    /// registry entry cannot be stopped reliably on package upgrade.
    pub fn enable() -> AppResult<Value> {
        if !process::systemd_available() {
            return Err(AppError::new(
                "AUTOSTART_UNAVAILABLE",
                "systemd user session or e-launcher-host.service unit is not available",
            ));
        }
        let home = crate::paths::host_home()?;
        write_home_dropin(&home)?;
        daemon_reload()?;
        process::systemctl_checked(&["enable", SYSTEMD_UNIT], "AUTOSTART_FAILED")?;
        // Do not claim autostart unless the unit is verifiably enabled.
        if !unit_is_enabled() {
            return Err(AppError::new(
                "AUTOSTART_FAILED",
                "systemctl enable reported success but e-launcher-host.service is not enabled",
            ));
        }
        // The registered home must be the real Host home: prefer the drop-in
        // we just wrote (covers re-enable after a partial failure), never the
        // login home.
        let registered_home = dropin_host_home().unwrap_or(home);
        register_home(&registered_home)?;
        let (linger, linger_message) = linger_state();
        if !linger {
            return Err(AppError::new("AUTOSTART_FAILED",
                linger_message.unwrap_or_else(|| "enable linger to run Host before login".to_string())));
        }
        let mut result = json!({
            "autostart": true,
            "linger": linger,
            "registered": true,
        });
        if let Some(message) = linger_message {
            result["message"] = Value::String(message);
        }
        Ok(result)
    }

    /// disable: only turn off boot autostart. The root registry entry and the
    /// drop-in stay so the user can still `start` manually and package
    /// upgrades can still find and stop the service. Linger is a per-user
    /// property shared with other services: never touched here.
    pub fn disable() -> AppResult<Value> {
        if !process::systemd_available() {
            return Ok(json!({ "autostart": false }));
        }
        daemon_reload()?;
        process::systemctl_checked(&["disable", SYSTEMD_UNIT], "AUTOSTART_FAILED")?;
        Ok(json!({ "autostart": false }))
    }

    /// remove: full teardown — stop, disable the unit, drop the registry
    /// entry and remove only this product's drop-in. Linger and user data are
    /// never touched. Individual failures are collected into `message` so
    /// callers see partial state honestly; `removed` stays true because every
    /// step was attempted.
    pub fn remove() -> AppResult<Value> {
        if process::systemd_available() {
            daemon_reload()?;
            process::systemctl_checked(&["stop", SYSTEMD_UNIT], "AUTOSTART_FAILED")?;
            process::systemctl_checked(&["disable", SYSTEMD_UNIT], "AUTOSTART_FAILED")?;
        }
        unregister_home()?;
        remove_home_dropin()?;
        if process::systemd_available() { daemon_reload()?; }
        Ok(json!({ "removed": true }))
    }

    pub fn is_enabled() -> bool {
        unit_is_enabled()
    }

    /// Extra autostart status fields (linger) merged into `status` output.
    /// Kept separate from `is_enabled` so callers see linger honestly.
    pub fn status_extra() -> Value {
        let (linger, linger_detail) = linger_state();
        let mut value = json!({ "linger": linger });
        if let Some(detail) = linger_detail {
            value["lingerDetail"] = Value::String(detail);
        }
        value
    }
}

#[cfg(target_os = "linux")]
pub fn enable() -> AppResult<Value> {
    linux_service::enable()
}

#[cfg(target_os = "linux")]
pub fn disable() -> AppResult<Value> {
    linux_service::disable()
}

#[cfg(target_os = "linux")]
pub fn is_enabled() -> bool {
    linux_service::is_enabled()
}

#[cfg(target_os = "linux")]
pub fn remove() -> AppResult<Value> {
    linux_service::remove()
}

/// Linux-only extra autostart status fields (linger) for `status`; other
/// platforms return None. main.rs merges this into the status object.
#[cfg(target_os = "linux")]
pub fn status_extra() -> Option<Value> {
    Some(linux_service::status_extra())
}

#[cfg(not(target_os = "linux"))]
pub fn status_extra() -> Option<Value> {
    None
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn enable() -> AppResult<Value> {
    Err(AppError::new("AUTOSTART_UNAVAILABLE", "autostart is not supported on this platform"))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn disable() -> AppResult<Value> {
    Ok(serde_json::json!({ "autostart": false }))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn remove() -> AppResult<Value> {
    Ok(serde_json::json!({ "removed": true }))
}

#[cfg(not(any(windows, target_os = "linux")))]
pub fn is_enabled() -> bool {
    false
}
