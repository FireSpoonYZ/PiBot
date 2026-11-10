//! HOST_HOME layout (contract §2) and bundled runtime discovery (contract §3).

use std::env;
use std::path::{Path, PathBuf};

use crate::util::{AppError, AppResult};

/// All files under `HOST_HOME`.
#[derive(Debug, Clone)]
pub struct HostPaths {
    pub home: PathBuf,
    pub config: PathBuf,
    pub secrets: PathBuf,
    pub data: PathBuf,
    pub logs: PathBuf,
    pub log: PathBuf,
    pub log_old: PathBuf,
    pub lock: PathBuf,
    pub status: PathBuf,
    pub stop_request: PathBuf,
}

impl HostPaths {
    pub fn new(home: PathBuf) -> Self {
        let logs = home.join("logs");
        HostPaths {
            config: home.join("config.json"),
            secrets: home.join("secrets.env"),
            data: home.join("data"),
            log: logs.join("host.log"),
            log_old: logs.join("host.log.1"),
            logs,
            lock: home.join("launcher.lock"),
            status: home.join("launcher.json"),
            stop_request: home.join("stop.request"),
            home,
        }
    }

    pub fn resolve() -> AppResult<Self> {
        Ok(HostPaths::new(host_home()?))
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

/// `E_LAUNCHER_HOST_HOME` override, else the per-OS default.
pub fn host_home() -> AppResult<PathBuf> {
    if let Some(value) = non_empty_env("E_LAUNCHER_HOST_HOME") {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(AppError::new("INVALID_ARGUMENT", "E_LAUNCHER_HOST_HOME must be an absolute path"));
        }
        return Ok(path);
    }
    default_host_home()
}

#[cfg(windows)]
fn default_host_home() -> AppResult<PathBuf> {
    let base = non_empty_env("LOCALAPPDATA")
        .ok_or_else(|| AppError::new("IO_ERROR", "LOCALAPPDATA is not set"))?;
    Ok(PathBuf::from(base).join("e-launcher").join("host-service"))
}

/// macOS: `~/Library/Application Support/e-launcher/host-service`.
#[cfg(target_os = "macos")]
fn default_host_home() -> AppResult<PathBuf> {
    let home = non_empty_env("HOME").ok_or_else(|| AppError::new("IO_ERROR", "HOME is not set"))?;
    Ok(mac_host_home(Path::new(&home)))
}

#[cfg(any(target_os = "macos", test))]
fn mac_host_home(user_home: &Path) -> PathBuf {
    user_home.join("Library").join("Application Support").join("e-launcher").join("host-service")
}

#[cfg(not(any(windows, target_os = "macos")))]
fn default_host_home() -> AppResult<PathBuf> {
    let base = match non_empty_env("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()) {
        Some(p) => p,
        None => {
            let home = non_empty_env("HOME").ok_or_else(|| AppError::new("IO_ERROR", "HOME is not set"))?;
            PathBuf::from(home).join(".config")
        }
    };
    Ok(base.join("e-launcher").join("host-service"))
}

pub fn exe_path() -> AppResult<PathBuf> {
    env::current_exe().map_err(|e| AppError::io("locate launcher executable", e))
}

pub fn exe_dir() -> AppResult<PathBuf> {
    let exe = exe_path()?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::new("IO_ERROR", "launcher executable has no parent directory"))
}

/// Bundled files needed to run the Host.
#[derive(Debug, Clone)]
pub struct Runtime {
    pub node: PathBuf,
    pub cli: PathBuf,
    pub npm: PathBuf,
    pub shower: Option<PathBuf>,
}

fn node_path(exe_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        exe_dir.join("pibot-node.exe")
    } else {
        exe_dir.join("pibot-node")
    }
}

fn runtime_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let mut list = Vec::new();
    // Windows runs under the scheduled task with the interactive user's
    // environment; honoring the override there would resolve executable code
    // outside the protected install directory, so the bundled root is fixed.
    if !cfg!(windows) {
        if let Some(value) = non_empty_env("E_LAUNCHER_HOST_RUNTIME") {
            list.push(PathBuf::from(value));
        }
    }
    if cfg!(windows) {
        list.push(exe_dir.join("host-runtime"));
    } else if cfg!(target_os = "macos") {
        // PiBot.app/Contents/MacOS/pibot-host -> PiBot.app/Contents/Resources/host-runtime
        list.push(mac_bundle_runtime(exe_dir));
    } else {
        list.push(exe_dir.join("..").join("lib").join("e-launcher-desktop").join("host-runtime"));
        list.push(PathBuf::from("/usr/lib/e-launcher-desktop/host-runtime"));
    }
    list
}

fn mac_bundle_runtime(exe_dir: &Path) -> PathBuf {
    exe_dir.join("..").join("Resources").join("host-runtime")
}

pub fn host_runtime_root(exe_dir: &Path) -> Option<PathBuf> {
    runtime_candidates(exe_dir).into_iter().find(|p| p.is_dir())
}

pub fn locate_runtime() -> AppResult<Runtime> {
    let dir = exe_dir()?;
    let node = node_path(&dir);
    if !node.is_file() {
        return Err(AppError::new("RUNTIME_MISSING", format!("bundled Node not found at {}", node.display())));
    }
    let root = host_runtime_root(&dir)
        .ok_or_else(|| AppError::new("RUNTIME_MISSING", "bundled host-runtime directory not found"))?;
    let core = root.join("host-core");
    let cli = core.join("host-service-cli.js");
    if !cli.is_file() {
        return Err(AppError::new("RUNTIME_MISSING", format!("Host CLI not found at {}", cli.display())));
    }
    let npm = core.join("node_modules").join("npm").join("bin").join("npm-cli.js");
    if !npm.is_file() {
        return Err(AppError::new("RUNTIME_MISSING", format!("bundled npm not found at {}", npm.display())));
    }
    let shower = if cfg!(windows) {
        Some(root.join("native").join("shower-windows.exe")).filter(|p| p.is_file())
    } else {
        None
    };
    Ok(Runtime { node, cli, npm, shower })
}

/// Makes a user-supplied path absolute relative to the current directory.
pub fn absolutize(value: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Ok(path);
    }
    let cwd = env::current_dir().map_err(|e| AppError::io("read current directory", e))?;
    Ok(cwd.join(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_contract() {
        let home = PathBuf::from("/tmp/hh");
        let p = HostPaths::new(home.clone());
        assert_eq!(p.config, home.join("config.json"));
        assert_eq!(p.secrets, home.join("secrets.env"));
        assert_eq!(p.data, home.join("data"));
        assert_eq!(p.log, home.join("logs").join("host.log"));
        assert_eq!(p.log_old, home.join("logs").join("host.log.1"));
        assert_eq!(p.lock, home.join("launcher.lock"));
        assert_eq!(p.status, home.join("launcher.json"));
        assert_eq!(p.stop_request, home.join("stop.request"));
    }

    #[test]
    fn macos_layout_uses_application_support_and_bundle_resources() {
        assert_eq!(
            mac_host_home(Path::new("/Users/u")),
            PathBuf::from("/Users/u/Library/Application Support/e-launcher/host-service")
        );
        assert_eq!(
            mac_bundle_runtime(Path::new("/Applications/PiBot.app/Contents/MacOS")),
            PathBuf::from("/Applications/PiBot.app/Contents/MacOS/../Resources/host-runtime")
        );
    }
}
