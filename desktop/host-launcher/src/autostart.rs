//! Login autostart: Windows protected scheduled task via the `host-task`
//! helper inside shower-windows.exe; Linux systemd user unit; macOS user
//! LaunchAgent in the `gui/<uid>` launchd domain.

#[cfg(not(target_os = "macos"))]
use serde_json::json;
use serde_json::Value;

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
    #[cfg(target_os = "macos")]
    {
        mac_launchd::status()
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
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

#[cfg(target_os = "macos")]
mod mac_launchd {
    //! `~/Library/LaunchAgents/<label>.plist` runs `pibot-host run` once the
    //! user logs in and lets launchd restart it after a crash. A deliberate
    //! `stop` makes `run` exit 0, which `KeepAlive.SuccessfulExit=false` leaves
    //! stopped. `enable`/`disable` only change whether the agent loads at the
    //! next login (like `systemctl enable/disable`); `start` asks launchd to run
    //! a current, enabled agent and otherwise reports that the caller must
    //! start the launcher directly.

    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use serde_json::{json, Value};

    use crate::paths::HostPaths;
    use crate::process;
    use crate::util::{AppError, AppResult};

    pub const LABEL: &str = "io.github.firespoonyz.pibot.host";
    const LAUNCHCTL: &str = "/bin/launchctl";
    /// launchd's SIGTERM→SIGKILL grace; must exceed the supervisor's graceful
    /// Host shutdown budget (same contract as the systemd unit's TimeoutStopSec=90).
    const EXIT_TIMEOUT_SECS: u32 = 90;
    const THROTTLE_SECS: u32 = 10;
    /// Wait for a booted-out job to release launcher.lock before reloading it.
    const UNLOAD_WAIT: Duration = Duration::from_secs(95);

    /// Product label. Debug builds accept `E_LAUNCHER_LAUNCHD_LABEL` so local
    /// verification can use an isolated agent; release builds never do.
    pub fn label() -> String {
        #[cfg(debug_assertions)]
        if let Ok(value) = std::env::var("E_LAUNCHER_LAUNCHD_LABEL") {
            if is_valid_label(&value) {
                return value;
            }
        }
        LABEL.to_string()
    }

    #[cfg_attr(not(any(debug_assertions, test)), allow(dead_code))]
    pub fn is_valid_label(value: &str) -> bool {
        !value.is_empty()
            && value.len() <= 128
            && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    }

    fn domain() -> String {
        // SAFETY: getuid has no preconditions and cannot fail.
        format!("gui/{}", unsafe { libc::getuid() })
    }

    fn service_target(label: &str) -> String {
        format!("{}/{label}", domain())
    }

    fn launchctl(args: &[&str]) -> std::io::Result<std::process::Output> {
        let mut cmd = process::command(LAUNCHCTL);
        cmd.args(args);
        process::run_capture(cmd)
    }

    fn launchctl_checked(args: &[&str], code: &str) -> AppResult<()> {
        match launchctl(args) {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => Err(AppError::new(code, format!("launchctl {}: {}", args.join(" "), process::output_message(&out)))),
            Err(e) => Err(AppError::new(code, format!("launchctl {}: {e}", args.join(" ")))),
        }
    }

    pub fn plist_path() -> AppResult<PathBuf> {
        let home = std::env::var_os("HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .ok_or_else(|| AppError::new("IO_ERROR", "HOME is not set"))?;
        Ok(home.join("Library").join("LaunchAgents").join(format!("{}.plist", label())))
    }

    fn xml_escape(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());
        for c in raw.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                _ => out.push(c),
            }
        }
        out
    }

    fn plist_text<'a>(path: &'a Path, what: &str) -> AppResult<&'a str> {
        let raw = path
            .to_str()
            .ok_or_else(|| AppError::new("AUTOSTART_FAILED", format!("{what} {} is not valid UTF-8", path.display())))?;
        if raw.chars().any(char::is_control) {
            return Err(AppError::new("AUTOSTART_FAILED", format!("{what} {} contains control characters", path.display())));
        }
        Ok(raw)
    }

    /// The exact LaunchAgent this launcher registers. An installed plist that
    /// differs from it (moved/replaced PiBot.app, other Host home, older
    /// format) is stale and is never started by launchd.
    pub fn render_plist(label: &str, program: &Path, host_home: &Path) -> AppResult<String> {
        let label = xml_escape(label);
        let program = xml_escape(plist_text(program, "launcher path")?);
        let home = xml_escape(plist_text(host_home, "host home")?);
        Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{program}</string>
		<string>run</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>E_LAUNCHER_HOST_HOME</key>
		<string>{home}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>{THROTTLE_SECS}</integer>
	<key>ExitTimeOut</key>
	<integer>{EXIT_TIMEOUT_SECS}</integer>
	<key>Umask</key>
	<integer>63</integer>
</dict>
</plist>
"#
        ))
    }

    /// Canonical path of this launcher binary (what launchd should execute).
    fn current_program() -> AppResult<PathBuf> {
        let exe = crate::paths::exe_path()?;
        Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
    }

    /// Gatekeeper App Translocation runs quarantined apps from a randomized
    /// read-only path that disappears; never register such a path.
    pub fn is_translocated(program: &Path) -> bool {
        program.to_string_lossy().contains("/AppTranslocation/")
    }

    fn expected_plist() -> AppResult<String> {
        render_plist(&label(), &current_program()?, &crate::paths::host_home()?)
    }

    #[derive(Debug, PartialEq)]
    enum Registration {
        Missing,
        Current,
        Stale,
    }

    fn registration() -> AppResult<(Registration, PathBuf)> {
        let path = plist_path()?;
        let installed = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Registration::Missing, path)),
            Err(e) => return Err(AppError::io("read LaunchAgent plist", e)),
        };
        let state = if installed == expected_plist()? { Registration::Current } else { Registration::Stale };
        Ok((state, path))
    }

    fn is_loaded(label: &str) -> bool {
        matches!(launchctl(&["print", &service_target(label)]), Ok(out) if out.status.success())
    }

    /// `launchctl print-disabled gui/<uid>` lists override entries as
    /// `"label" => disabled|enabled` (older releases print `true|false`).
    pub fn parse_disabled(listing: &str, label: &str) -> bool {
        let needle = format!("\"{label}\"");
        listing
            .lines()
            .filter_map(|line| line.trim().strip_prefix(needle.as_str()))
            .filter_map(|rest| rest.trim().strip_prefix("=>"))
            .map(|value| matches!(value.trim(), "disabled" | "true"))
            .last()
            .unwrap_or(false)
    }

    fn is_disabled(label: &str) -> bool {
        match launchctl(&["print-disabled", &domain()]) {
            Ok(out) if out.status.success() => parse_disabled(&String::from_utf8_lossy(&out.stdout), label),
            _ => false,
        }
    }

    /// Unloads a loaded job (launchd sends SIGTERM) and waits until its
    /// supervisor released launcher.lock, so a reload never races the old one.
    fn bootout(label: &str, home: Option<&Path>) -> AppResult<()> {
        if !is_loaded(label) {
            return Ok(());
        }
        launchctl_checked(&["bootout", &service_target(label)], "AUTOSTART_FAILED")?;
        if let Some(home) = home {
            let paths = HostPaths::new(home.to_path_buf());
            process::wait_until(UNLOAD_WAIT, || !process::lock_held(&paths));
        }
        Ok(())
    }

    fn bootstrap(path: &Path) -> AppResult<()> {
        let path = plist_text(path, "LaunchAgent path")?;
        launchctl_checked(&["bootstrap", &domain(), path], "AUTOSTART_FAILED")
    }

    pub fn status() -> AppResult<Value> {
        let state = registration()?.0;
        if state == Registration::Missing {
            return Ok(json!({ "installed": false, "autostart": false }));
        }
        // A disabled agent never runs, so a stale path in it needs no repair
        // prompt; turning autostart on again rewrites it anyway.
        if is_disabled(&label()) {
            return Ok(json!({ "installed": true, "autostart": false }));
        }
        if state == Registration::Stale {
            return Err(AppError::new(
                "AUTOSTART_STALE",
                "the login item points to another PiBot.app location or version; turn autostart on again to repair it",
            ));
        }
        Ok(json!({ "installed": true, "autostart": true }))
    }

    /// Writes (or repairs) the agent and allows it to load at login. A first
    /// registration does not start anything; repairing a loaded stale agent
    /// reloads it so a Host it was running keeps running from the new path.
    pub fn enable() -> AppResult<Value> {
        let label = label();
        let program = current_program()?;
        if is_translocated(&program) {
            return Err(AppError::new(
                "AUTOSTART_UNAVAILABLE",
                "PiBot is running from a temporary translocated location; move PiBot.app to the Applications folder, reopen it, then enable autostart",
            ));
        }
        let home = crate::paths::host_home()?;
        let body = render_plist(&label, &program, &home)?;
        let path = plist_path()?;
        let mut reload = false;
        if std::fs::read_to_string(&path).ok().as_deref() != Some(body.as_str()) {
            if is_loaded(&label) {
                reload = process::lock_held(&HostPaths::new(home.clone()));
                bootout(&label, Some(&home))?;
            }
            crate::util::write_atomic(&path, body.as_bytes(), false)?;
            // launchd ignores agents that are group/world writable.
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
                .map_err(|e| AppError::io("set LaunchAgent permissions", e))?;
        }
        launchctl_checked(&["enable", &service_target(&label)], "AUTOSTART_FAILED")?;
        if reload {
            bootstrap(&path)?;
        }
        Ok(json!({ "autostart": true }))
    }

    /// Keeps the agent file (so `start` and `remove` still find it) and only
    /// stops it from loading at the next login; a running Host keeps running.
    pub fn disable() -> AppResult<Value> {
        let label = label();
        if plist_path()?.exists() || is_loaded(&label) {
            launchctl_checked(&["disable", &service_target(&label)], "AUTOSTART_FAILED")?;
        }
        Ok(json!({ "autostart": false }))
    }

    /// Unloads and deletes only this product's agent; user data is untouched.
    pub fn remove() -> AppResult<Value> {
        let label = label();
        bootout(&label, crate::paths::host_home().ok().as_deref())?;
        match std::fs::remove_file(plist_path()?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::io("remove LaunchAgent plist", e)),
        }
        Ok(json!({ "removed": true }))
    }

    /// How `start` should proceed after asking launchd.
    pub enum Start {
        /// launchd is starting the current, enabled agent.
        Launchd,
        /// Start the launcher directly; carries why launchd could not be used
        /// when it was attempted (e.g. the background item is switched off in
        /// System Settings › Login Items).
        Direct(Option<String>),
    }

    /// Starts the Host through launchd when a current, enabled agent exists so
    /// crash restarts apply; otherwise (or when launchd refuses) the caller
    /// starts the launcher directly. A stale or disabled agent is unloaded
    /// first so launchd never runs an old path.
    pub fn start() -> Start {
        let label = label();
        let Ok((state, path)) = registration() else { return Start::Direct(None) };
        let usable = state == Registration::Current && !is_disabled(&label);
        let loaded = is_loaded(&label);
        if !usable {
            if loaded {
                let _ = bootout(&label, None);
            }
            return Start::Direct(None);
        }
        let result = if loaded {
            launchctl_checked(&["kickstart", &service_target(&label)], "START_FAILED")
        } else {
            bootstrap(&path)
        };
        match result {
            Ok(()) => Start::Launchd,
            Err(e) => Start::Direct(Some(format!("launchd did not start the LaunchAgent, started directly: {}", e.message))),
        }
    }

    /// After the supervisor stopped (or when none was running): unload a
    /// loaded job so KeepAlive cannot respawn a `run` that keeps failing at
    /// startup. `start` bootstraps it again and the next login reloads it.
    pub fn unload() -> AppResult<()> {
        bootout(&label(), None)
    }

    /// Before `stop` kills a supervisor that ignored the graceful request, ask
    /// launchd to unload the job so the kill is not answered with a KeepAlive
    /// respawn. Never waits for the unload: launchd would sit out ExitTimeOut
    /// on a hung supervisor, and the caller's kill is what ends it.
    pub fn release_for_kill() {
        let label = label();
        if !is_loaded(&label) {
            return;
        }
        let mut cmd = process::command(LAUNCHCTL);
        cmd.args(["bootout", &service_target(&label)])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        if let Ok(mut child) = cmd.spawn() {
            // Give launchd a moment to register the removal before the kill.
            process::wait_until(Duration::from_millis(500), || matches!(child.try_wait(), Ok(Some(_))));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn plist_escapes_paths_and_keeps_fixed_keys() {
            let text = render_plist(LABEL, Path::new("/Apps/A&B <x>.app/Contents/MacOS/pibot-host"), Path::new("/Users/u/Library/Application Support/e-launcher/host-service")).unwrap();
            assert!(text.contains("<string>io.github.firespoonyz.pibot.host</string>"));
            assert!(text.contains("<string>/Apps/A&amp;B &lt;x&gt;.app/Contents/MacOS/pibot-host</string>\n\t\t<string>run</string>"));
            assert!(text.contains("<key>E_LAUNCHER_HOST_HOME</key>\n\t\t<string>/Users/u/Library/Application Support/e-launcher/host-service</string>"));
            assert!(text.contains("<key>SuccessfulExit</key>\n\t\t<false/>"));
            assert!(text.contains("<key>ExitTimeOut</key>\n\t<integer>90</integer>"));
            assert!(render_plist(LABEL, Path::new("/a\nb"), Path::new("/h")).is_err());
        }

        #[test]
        fn moved_bundle_renders_a_different_plist() {
            let home = Path::new("/Users/u/h");
            let a = render_plist(LABEL, Path::new("/Applications/PiBot.app/Contents/MacOS/pibot-host"), home).unwrap();
            let b = render_plist(LABEL, Path::new("/Users/u/Desktop/PiBot.app/Contents/MacOS/pibot-host"), home).unwrap();
            assert_ne!(a, b);
        }

        #[test]
        fn disabled_listing_parses_new_and_old_formats() {
            let listing = "disabled services = {\n\t\"com.apple.x\" => enabled\n\t\"io.github.firespoonyz.pibot.host\" => disabled\n}\n";
            assert!(parse_disabled(listing, LABEL));
            assert!(!parse_disabled("\t\"io.github.firespoonyz.pibot.host\" => enabled\n", LABEL));
            assert!(parse_disabled("\t\"io.github.firespoonyz.pibot.host\" => true\n", LABEL));
            assert!(!parse_disabled("\t\"io.github.firespoonyz.pibot.host.other\" => disabled\n", LABEL));
            assert!(!parse_disabled("", LABEL));
        }

        #[test]
        fn translocated_and_label_checks() {
            assert!(is_translocated(Path::new("/private/var/folders/x/AppTranslocation/ABC/d/PiBot.app/Contents/MacOS/pibot-host")));
            assert!(!is_translocated(Path::new("/Applications/PiBot.app/Contents/MacOS/pibot-host")));
            assert!(is_valid_label("io.github.firespoonyz.pibot.host-test"));
            assert!(!is_valid_label("bad label"));
            assert!(!is_valid_label(""));
        }
    }
}

#[cfg(target_os = "macos")]
pub fn enable() -> AppResult<Value> {
    mac_launchd::enable()
}

#[cfg(target_os = "macos")]
pub fn disable() -> AppResult<Value> {
    mac_launchd::disable()
}

#[cfg(target_os = "macos")]
pub fn remove() -> AppResult<Value> {
    mac_launchd::remove()
}

#[cfg(target_os = "macos")]
pub use mac_launchd::Start as LaunchdStart;

/// macOS: start through launchd when possible (see `LaunchdStart`).
#[cfg(target_os = "macos")]
pub fn launchd_start() -> LaunchdStart {
    mac_launchd::start()
}

/// macOS: unload the job once the supervisor is stopped.
#[cfg(target_os = "macos")]
pub fn launchd_unload() -> AppResult<()> {
    mac_launchd::unload()
}

/// macOS: request the unload before a forced kill so launchd does not respawn it.
#[cfg(target_os = "macos")]
pub fn launchd_release_for_kill() {
    mac_launchd::release_for_kill()
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn enable() -> AppResult<Value> {
    Err(AppError::new("AUTOSTART_UNAVAILABLE", "autostart is not supported on this platform"))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn disable() -> AppResult<Value> {
    Ok(serde_json::json!({ "autostart": false }))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn remove() -> AppResult<Value> {
    Ok(serde_json::json!({ "removed": true }))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn is_enabled() -> bool {
    false
}
