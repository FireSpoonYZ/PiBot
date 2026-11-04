//! `config.json` (non-secret, schema version 1) and `secrets.env` (KEY=VALUE).

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;

use serde::{Deserialize, Serialize};

use crate::paths::HostPaths;
use crate::util::{write_atomic, AppError, AppResult};

pub const CONFIG_VERSION: u32 = 1;
pub const DEFAULT_PORT: u16 = 6279;
pub const CONTROL_TOKEN_KEY: &str = "E_LAUNCHER_CONTROL_TOKEN";
pub const RELAY_TOKEN_KEY: &str = "E_LAUNCHER_RELAY_TOKEN";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub version: u32,
    pub center_url: String,
    pub device_id: String,
    pub display_name: String,
    pub data_root: String,
    pub port: u16,
    #[serde(default)]
    pub center_ca_file: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

impl Config {
    pub fn control_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub fn parse_config(text: &str) -> AppResult<Config> {
    let config: Config = serde_json::from_str(text)
        .map_err(|e| AppError::new("CONFIG_INVALID", format!("config.json is invalid: {e}")))?;
    if config.version != CONFIG_VERSION {
        return Err(AppError::new("CONFIG_INVALID", format!("unsupported config.json version {}", config.version)));
    }
    if config.center_url.trim().is_empty() || config.device_id.trim().is_empty() || config.data_root.trim().is_empty() {
        return Err(AppError::new("CONFIG_INVALID", "config.json is missing centerUrl, deviceId or dataRoot"));
    }
    if config.port == 0 {
        return Err(AppError::new("CONFIG_INVALID", "config.json port must be 1..65535"));
    }
    Ok(config)
}

pub fn serialize_config(config: &Config) -> String {
    let mut text = serde_json::to_string_pretty(config).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    text
}

/// Ordered `KEY=VALUE` pairs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Secrets {
    pub entries: Vec<(String, String)>,
}

impl Secrets {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn set(&mut self, key: &str, value: &str) {
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| k == key) {
            entry.1 = value.to_string();
        } else {
            self.entries.push((key.to_string(), value.to_string()));
        }
    }
}

pub fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

pub fn parse_secrets(text: &str) -> Secrets {
    let mut secrets = Secrets::default();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if !valid_env_key(key) {
            continue;
        }
        let mut value = value.trim();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = &value[1..value.len() - 1];
        }
        secrets.set(key, value);
    }
    secrets
}

pub fn serialize_secrets(secrets: &Secrets) -> AppResult<String> {
    let mut text = String::new();
    for (key, value) in &secrets.entries {
        if !valid_env_key(key) {
            return Err(AppError::new("INVALID_ARGUMENT", format!("invalid secret key {key}")));
        }
        if value.contains('\n') || value.contains('\r') || value.contains('\0') {
            return Err(AppError::new("INVALID_ARGUMENT", format!("secret {key} contains invalid characters")));
        }
        text.push_str(key);
        text.push('=');
        text.push_str(value);
        text.push('\n');
    }
    Ok(text)
}

fn read_optional(path: &std::path::Path) -> AppResult<Option<String>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::io(&format!("read {}", path.display()), e)),
    }
}

pub fn read_config(paths: &HostPaths) -> AppResult<Option<Config>> {
    match read_optional(&paths.config)? {
        Some(text) => parse_config(&text).map(Some),
        None => Ok(None),
    }
}

pub fn read_secrets(paths: &HostPaths) -> AppResult<Option<Secrets>> {
    Ok(read_optional(&paths.secrets)?.map(|text| parse_secrets(&text)))
}

/// Config + secrets required by `run`/`start`; anything missing → `NOT_CONFIGURED`.
pub fn load(paths: &HostPaths) -> AppResult<(Config, Secrets)> {
    let config = read_config(paths)?
        .ok_or_else(|| AppError::new("NOT_CONFIGURED", "Host service is not paired (config.json missing)"))?;
    let secrets = read_secrets(paths)?
        .ok_or_else(|| AppError::new("NOT_CONFIGURED", "Host service is not paired (secrets.env missing)"))?;
    for key in [CONTROL_TOKEN_KEY, RELAY_TOKEN_KEY] {
        if secrets.get(key).map_or(true, str::is_empty) {
            return Err(AppError::new("NOT_CONFIGURED", format!("secrets.env is missing {key}")));
        }
    }
    Ok((config, secrets))
}

pub fn write_config(paths: &HostPaths, config: &Config) -> AppResult<()> {
    write_atomic(&paths.config, serialize_config(config).as_bytes(), false)
}

pub fn write_secrets(paths: &HostPaths, secrets: &Secrets) -> AppResult<()> {
    write_atomic(&paths.secrets, serialize_secrets(secrets)?.as_bytes(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Config {
        let mut env = BTreeMap::new();
        env.insert("HTTP_PROXY".to_string(), "http://proxy:8080".to_string());
        Config {
            version: 1,
            center_url: "https://relay.example.com:3000".into(),
            device_id: "0b8e5a4e-8f8d-4c43-9a5c-2f3f1d2e3c4b".into(),
            display_name: "my-pc".into(),
            data_root: "/home/u/.config/e-launcher/host-service/data".into(),
            port: 6279,
            center_ca_file: None,
            env,
        }
    }

    #[test]
    fn config_round_trip() {
        let config = sample();
        let text = serialize_config(&config);
        assert!(text.contains("\"centerUrl\""));
        assert!(text.contains("\"centerCaFile\": null"));
        assert!(text.contains("\"dataRoot\""));
        assert_eq!(parse_config(&text).unwrap(), config);
    }

    #[test]
    fn config_optional_fields_default() {
        let text = r#"{"version":1,"centerUrl":"https://c","deviceId":"d","displayName":"n","dataRoot":"/x","port":6279}"#;
        let config = parse_config(text).unwrap();
        assert!(config.env.is_empty());
        assert_eq!(config.center_ca_file, None);
        assert!(!serialize_config(&config).contains("\"env\""));
        assert_eq!(config.control_url(), "http://127.0.0.1:6279");
    }

    #[test]
    fn config_rejects_bad_version_and_json() {
        let text = r#"{"version":2,"centerUrl":"https://c","deviceId":"d","displayName":"n","dataRoot":"/x","port":1}"#;
        assert_eq!(parse_config(text).unwrap_err().code, "CONFIG_INVALID");
        assert_eq!(parse_config("not json").unwrap_err().code, "CONFIG_INVALID");
        let zero = r#"{"version":1,"centerUrl":"https://c","deviceId":"d","displayName":"n","dataRoot":"/x","port":0}"#;
        assert_eq!(parse_config(zero).unwrap_err().code, "CONFIG_INVALID");
    }

    #[test]
    fn secrets_parse() {
        let text = "# comment\r\nE_LAUNCHER_CONTROL_TOKEN=abc\r\n\r\nexport EXTRA=\"q v\"\nbad key=1\nE_LAUNCHER_RELAY_TOKEN=x=y\nE_LAUNCHER_CONTROL_TOKEN=def\n";
        let s = parse_secrets(text);
        assert_eq!(s.get(CONTROL_TOKEN_KEY), Some("def"));
        assert_eq!(s.get(RELAY_TOKEN_KEY), Some("x=y"));
        assert_eq!(s.get("EXTRA"), Some("q v"));
        assert_eq!(s.entries.len(), 3);
    }

    #[test]
    fn secrets_serialize_round_trip() {
        let mut s = Secrets::default();
        s.set(CONTROL_TOKEN_KEY, "c-tok");
        s.set(RELAY_TOKEN_KEY, "r_tok");
        s.set("OTHER", "1");
        let text = serialize_secrets(&s).unwrap();
        assert_eq!(text, "E_LAUNCHER_CONTROL_TOKEN=c-tok\nE_LAUNCHER_RELAY_TOKEN=r_tok\nOTHER=1\n");
        assert_eq!(parse_secrets(&text), s);
    }

    #[test]
    fn secrets_reject_newlines_and_bad_keys() {
        let mut s = Secrets::default();
        s.set("A", "x\ny");
        assert!(serialize_secrets(&s).is_err());
        let s = Secrets { entries: vec![("1A".into(), "v".into())] };
        assert!(serialize_secrets(&s).is_err());
    }
}
