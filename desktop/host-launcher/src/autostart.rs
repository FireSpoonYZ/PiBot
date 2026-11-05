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

/// Autostart state for `status`: `{installed, autostart}`.
/// Windows normalizes the raw helper answer: autostart only counts when the
/// scheduled task is installed AND enabled; a legacy HKCU Run value without the
/// task (helper reports installed:false, autostart:true) is a migration error,
/// not a working autostart — start would fail with TASK_NOT_INSTALLED.
pub fn status() -> AppResult<Value> {
    #[cfg(windows)]
    {
        let status = host_task("status", HOST_TASK_FAST_TIMEOUT)?;
        let installed = bool_field(&status, "installed");
        let raw_autostart = bool_field(&status, "autostart");
        if !installed && raw_autostart {
            return Err(AppError::new(
                "AUTOSTART_MIGRATION_REQUIRED",
                "legacy autostart is present but the scheduled task is not installed; run 'e-launcher-host enable' to migrate",
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

/// Registers login autostart. Returns `{"autostart":true}`.
pub fn enable() -> AppResult<Value> {
    #[cfg(windows)]
    {
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
    #[cfg(target_os = "linux")]
    {
        use crate::process::{systemctl_checked, systemctl_user, systemd_available, SYSTEMD_UNIT};
        if !systemd_available() {
            return Err(AppError::new(
                "AUTOSTART_UNAVAILABLE",
                "systemd user session or e-launcher-host.service unit is not available",
            ));
        }
        let _ = systemctl_user(&["daemon-reload"]);
        systemctl_checked(&["enable", SYSTEMD_UNIT], "AUTOSTART_FAILED")?;
        // Linger is a machine policy: never enabled or disabled from here.
        Ok(json!({ "autostart": true }))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Err(AppError::new("AUTOSTART_UNAVAILABLE", "autostart is not supported on this platform"))
    }
}

pub fn disable() -> AppResult<Value> {
    #[cfg(windows)]
    {
        let status = host_task("status", HOST_TASK_FAST_TIMEOUT)?;
        if bool_field(&status, "installed") {
            host_task("disable", HOST_TASK_ELEVATED_TIMEOUT)?;
        }
        let _ = win::delete();
        Ok(json!({ "autostart": false }))
    }
    #[cfg(target_os = "linux")]
    {
        use crate::process::{systemctl_checked, systemd_available, SYSTEMD_UNIT};
        if !systemd_available() {
            // Nothing can be enabled without systemd; report disabled.
            return Ok(json!({ "autostart": false }));
        }
        systemctl_checked(&["disable", SYSTEMD_UNIT], "AUTOSTART_FAILED")?;
        Ok(json!({ "autostart": false }))
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Ok(json!({ "autostart": false }))
    }
}

#[cfg(target_os = "linux")]
fn is_enabled() -> bool {
    match crate::process::systemctl_user(&["is-enabled", crate::process::SYSTEMD_UNIT]) {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim() == "enabled",
        Err(_) => false,
    }
}
