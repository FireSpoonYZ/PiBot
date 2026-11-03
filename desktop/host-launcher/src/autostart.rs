//! Login autostart: Windows HKCU Run value; Linux systemd user unit + linger.

use serde_json::{json, Value};

#[allow(unused_imports)]
use crate::util::{AppError, AppResult};

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::path::Path;

    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    use crate::util::{AppError, AppResult};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "e-launcher-host";
    const ERROR_SUCCESS: u32 = 0;
    const ERROR_FILE_NOT_FOUND: u32 = 2;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn run_value(exe: &Path) -> String {
        format!("\"{}\" run", exe.display())
    }

    pub fn set(exe: &Path) -> AppResult<()> {
        let key = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        let data = wide(&run_value(exe));
        // SAFETY: all pointers reference live, NUL-terminated UTF-16 buffers.
        let status = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                REG_SZ,
                data.as_ptr() as *const c_void,
                (data.len() * 2) as u32,
            )
        };
        if status as u32 != ERROR_SUCCESS {
            return Err(AppError::new("AUTOSTART_FAILED", format!("RegSetKeyValueW failed ({})", status as u32)));
        }
        Ok(())
    }

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

    pub fn exists() -> bool {
        let key = wide(RUN_KEY);
        let name = wide(VALUE_NAME);
        let mut size: u32 = 0;
        // SAFETY: size query only (null data buffer).
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        } as u32;
        status == ERROR_SUCCESS
    }
}

#[cfg(target_os = "linux")]
fn current_user() -> Option<String> {
    if let Some(user) = std::env::var("USER").ok().filter(|u| !u.trim().is_empty()) {
        return Some(user.trim().to_string());
    }
    let mut cmd = crate::process::command("id");
    cmd.arg("-un");
    let out = crate::process::run_capture(cmd).ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !name.is_empty()).then_some(name)
}

/// Registers login autostart. Returns `{"autostart":true, ...}`.
pub fn enable() -> AppResult<Value> {
    #[cfg(windows)]
    {
        let exe = crate::paths::exe_path()?;
        win::set(&exe)?;
        Ok(json!({ "autostart": true }))
    }
    #[cfg(target_os = "linux")]
    {
        use crate::process::{output_message, systemctl_checked, systemctl_user, systemd_available, SYSTEMD_UNIT};
        if !systemd_available() {
            return Err(AppError::new(
                "AUTOSTART_UNAVAILABLE",
                "systemd user session or e-launcher-host.service unit is not available",
            ));
        }
        let _ = systemctl_user(&["daemon-reload"]);
        systemctl_checked(&["enable", SYSTEMD_UNIT], "AUTOSTART_FAILED")?;
        let (linger, message) = match current_user() {
            None => (false, Some("cannot determine current user for loginctl enable-linger".to_string())),
            Some(user) => {
                let mut cmd = crate::process::command("loginctl");
                cmd.args(["enable-linger", &user]);
                match crate::process::run_capture(cmd) {
                    Ok(out) if out.status.success() => (true, None),
                    Ok(out) => (false, Some(format!("loginctl enable-linger failed: {}", output_message(&out)))),
                    Err(e) => (false, Some(format!("loginctl enable-linger failed: {e}"))),
                }
            }
        };
        let mut result = json!({ "autostart": true, "linger": linger });
        if let Some(message) = message {
            result["message"] = Value::String(message);
        }
        Ok(result)
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Err(AppError::new("AUTOSTART_UNAVAILABLE", "autostart is not supported on this platform"))
    }
}

pub fn disable() -> AppResult<Value> {
    #[cfg(windows)]
    {
        win::delete()?;
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

pub fn is_enabled() -> bool {
    #[cfg(windows)]
    {
        win::exists()
    }
    #[cfg(target_os = "linux")]
    {
        match crate::process::systemctl_user(&["is-enabled", crate::process::SYSTEMD_UNIT]) {
            Ok(out) => String::from_utf8_lossy(&out.stdout).trim() == "enabled",
            Err(_) => false,
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        false
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn run_value_quotes_exe() {
        let v = super::win::run_value(std::path::Path::new(r"C:\Program Files\e\e-launcher-host.exe"));
        assert_eq!(v, r#""C:\Program Files\e\e-launcher-host.exe" run"#);
    }
}
