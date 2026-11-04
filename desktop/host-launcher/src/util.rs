//! Shared helpers: error type, JSON output, time formatting, tokens, atomic writes.

use std::fmt;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

/// Machine-readable error printed as `{"error":{"code","message"}}`.
#[derive(Debug, Clone, PartialEq)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        AppError { code: code.to_string(), message: message.into() }
    }

    pub fn io(context: &str, error: std::io::Error) -> Self {
        AppError::new("IO_ERROR", format!("{context}: {error}"))
    }

    pub fn to_json(&self) -> Value {
        json!({ "error": { "code": self.code, "message": self.message } })
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Prints one line of JSON to stdout. Errors (e.g. no stdout handle when
/// started from the Windows Run key) are ignored on purpose.
pub fn print_json(value: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// 32 random bytes, base64url without padding (43 chars).
pub fn random_token() -> AppResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| AppError::new("IO_ERROR", format!("random source unavailable: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub fn unix_millis_now() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

pub fn now_iso() -> String {
    iso_from_unix_millis(unix_millis_now() as i128)
}

/// Days since 1970-01-01 → (year, month, day) in the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC), same shape as JavaScript `toISOString()`.
pub fn iso_from_unix_millis(millis: i128) -> String {
    let total_secs = millis.div_euclid(1000) as i64;
    let ms = millis.rem_euclid(1000) as u32;
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
        ms
    )
}

/// Writes `bytes` to a temp file in the same directory, then renames it over
/// `path`. With `secret = true` the file is created with mode 0600 on unix.
pub fn write_atomic(path: &Path, bytes: &[u8], secret: bool) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::new("IO_ERROR", format!("invalid path {}", path.display())))?;
    fs::create_dir_all(dir).map_err(|e| AppError::io(&format!("create {}", dir.display()), e))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.tmp-{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let result = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            if secret {
                options.mode(0o600);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = secret;
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        #[cfg(unix)]
        {
            if secret {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
            }
        }
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(AppError::io(&format!("write {}", path.display()), e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_43_char_base64url() {
        let token = random_token().unwrap();
        assert_eq!(token.len(), 43);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(URL_SAFE_NO_PAD.decode(&token).unwrap().len(), 32);
        assert_ne!(token, random_token().unwrap());
    }

    #[test]
    fn iso_formatting() {
        assert_eq!(iso_from_unix_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_unix_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_from_unix_millis(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn error_json_shape() {
        let e = AppError::new("NOT_CONFIGURED", "missing");
        assert_eq!(e.to_json(), json!({"error": {"code": "NOT_CONFIGURED", "message": "missing"}}));
    }

    #[test]
    fn atomic_write_replaces() {
        let dir = std::env::temp_dir().join(format!("elh-test-{}", unix_millis_now()));
        let path = dir.join("secrets.env");
        write_atomic(&path, b"A=1\n", true).unwrap();
        write_atomic(&path, b"A=2\n", true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "A=2\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
