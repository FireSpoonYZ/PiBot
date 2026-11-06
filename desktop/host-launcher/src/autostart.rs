// Linux systemd user unit + linger, with the resolved Host home pinned in a
// user drop-in and the configured target registered for DEB package lifecycle
// hooks. Linux autostart lives in linux_service below; Windows delegates to
// crate::windows_service, which the Windows worker provides.

use serde_json::Value;

// AppError is only referenced by the unsupported-platform fallback below.
#[allow(unused_imports)]
use crate::util::{AppError, AppResult};

#[cfg(windows)]
pub fn enable() -> AppResult<Value> {
    crate::windows_service::enable()
}

#[cfg(windows)]
pub fn disable() -> AppResult<Value> {
    crate::windows_service::disable()
}

#[cfg(windows)]
pub fn is_enabled() -> bool {
    crate::windows_service::is_enabled()
}

#[cfg(windows)]
pub fn remove() -> AppResult<Value> {
    crate::windows_service::remove()
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
    const HOSTCTL: &str = "/usr/lib/e-launcher-desktop/e-launcher-hostctl";
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

    /// `loginctl enable-linger` for the calling user, then verify via
    /// `loginctl show-user`. Returns (enabled, warning).
    fn enable_linger() -> (bool, Option<String>) {
        let Some(user) = current_user_name() else {
            return (false, Some("cannot determine current user for loginctl enable-linger".to_string()));
        };
        let mut cmd = process::command("loginctl");
        cmd.args(["enable-linger", &user]);
        match process::run_capture(cmd) {
            Ok(out) if out.status.success() => {}
            Ok(out) => {
                return (
                    false,
                    Some(format!("loginctl enable-linger failed: {}", process::output_message(&out))),
                )
            }
            Err(e) => return (false, Some(format!("loginctl enable-linger failed: {e}"))),
        }
        let (enabled, detail) = linger_state();
        if enabled {
            (true, None)
        } else {
            (false, Some(detail.unwrap_or_else(|| "linger verification failed".to_string())))
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
        let out = hostctl(&["register", home_str])
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
        let (linger, linger_message) = enable_linger();
        // The registered home must be the real Host home: prefer the drop-in
        // we just wrote (covers re-enable after a partial failure), never the
        // login home.
        let registered_home = dropin_host_home().unwrap_or(home);
        register_home(&registered_home)?;
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
        let mut result = json!({ "removed": true });
        let mut messages: Vec<String> = Vec::new();
        if process::systemd_available() {
            for args in [
                &["daemon-reload"][..],
                &["stop", SYSTEMD_UNIT][..],
                &["disable", SYSTEMD_UNIT][..],
            ] {
                if let Err(e) = process::systemctl_checked(args, "AUTOSTART_FAILED") {
                    messages.push(format!("systemctl --user {} failed: {}", args.join(" "), e.message));
                }
            }
        }
        if let Err(e) = unregister_home() {
            messages.push(e.message);
        }
        if let Err(e) = remove_home_dropin() {
            messages.push(e.message);
        }
        if !messages.is_empty() {
            result["message"] = Value::String(messages.join("; "));
        }
        Ok(result)
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
