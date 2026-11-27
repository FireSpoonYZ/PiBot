//! Automatic and user-controllable KDE Plasma (KWin) window rule management for the desktop pet.
//!
//! On native Wayland, GTK 3 top-level windows cannot ask KWin to keep a window above others or
//! hide it from the taskbar/pager/switcher. KWin reads persistent rules from
//! `$XDG_CONFIG_HOME/kwinrulesrc` (shared by both `kwin_wayland` and `kwin_x11`) and reloads them
//! on `org.kde.KWin /KWin org.kde.KWin.reconfigure`.
//!
//! Pure INI parsing/merging/state-machine helpers are compiled on all platforms so `cargo test`
//! exercises them on Windows, macOS, and Linux alike.

use std::{
  ffi::OsStr,
  fs,
  io::Write,
  path::{Path, PathBuf},
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
  },
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Webview};

use crate::{ensure_main_webview, BridgeError};

/// Deterministic RFC-4122 UUID (without braces, matching KWin's `QUuid::WithoutBraces` format)
/// identifying the PiBot-managed desktop pet rule in `kwinrulesrc`.
pub const MANAGED_RULE_ID: &str = "c8a5f2b0-7d1e-4b3a-9e6c-5069426f7450";
pub const RULE_DESCRIPTION: &str = "PiBot desktop pet";
pub const RULE_WMCLASS: &str = "pibot";
pub const RULE_TITLE: &str = "PiBot";
pub const CURRENT_RULE_VERSION: u32 = 1;

const STATE_FILE_NAME: &str = "kde-kwin-rule-state.json";
const KWINRULES_FILE_NAME: &str = "kwinrulesrc";
const GENERAL_SECTION: &str = "General";

/// Exact key/value pairs written into the managed KWin rule group.
/// Kept in sync with `desktop/linux/desktop-pet.kwinrule`.
const MANAGED_RULE_ENTRIES: &[(&str, &str)] = &[
  ("Description", RULE_DESCRIPTION),
  ("wmclass", RULE_WMCLASS),
  ("wmclassmatch", "1"),
  ("title", RULE_TITLE),
  ("titlematch", "1"),
  ("above", "true"),
  ("aboverule", "2"),
  ("skiptaskbar", "true"),
  ("skiptaskbarrule", "2"),
  ("skippager", "true"),
  ("skippagerrule", "2"),
  ("skipswitcher", "true"),
  ("skipswitcherrule", "2"),
];

/// Required behavioral keys used to verify whether an installed rule is up to date.
/// (`Description` is excluded so renaming the label in KDE System Settings does not force re-apply.)
const REQUIRED_RULE_ENTRIES: &[(&str, &str)] = &[
  ("wmclass", RULE_WMCLASS),
  ("wmclassmatch", "1"),
  ("title", RULE_TITLE),
  ("titlematch", "1"),
  ("above", "true"),
  ("aboverule", "2"),
  ("skiptaskbar", "true"),
  ("skiptaskbarrule", "2"),
  ("skippager", "true"),
  ("skippagerrule", "2"),
  ("skipswitcher", "true"),
  ("skipswitcherrule", "2"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopSessionInfo {
  pub is_kde: bool,
  pub session_type: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KdeWindowRuleStatus {
  pub supported: bool,
  pub session_type: &'static str,
  pub installed: bool,
  pub managed_by_pibot: bool,
  pub up_to_date: bool,
  pub externally_managed: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub reconfigured: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub config_path: Option<String>,
}

impl KdeWindowRuleStatus {
  fn unsupported(session_type: &'static str) -> Self {
    Self {
      supported: false,
      session_type,
      installed: false,
      managed_by_pibot: false,
      up_to_date: false,
      externally_managed: false,
      reconfigured: None,
      config_path: None,
    }
  }
}

#[derive(Default)]
pub struct KdeWindowRuleManager {
  auto_checked: AtomicBool,
  operation: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedKdeRuleState {
  #[serde(default)]
  auto_configured_rule_version: u32,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  managed_rule_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RuleInspection {
  installed: bool,
  managed_by_pibot: bool,
  up_to_date: bool,
  rule_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AutoEnsurePlan {
  SkipNotKde,
  SkipExternallyManaged,
  SkipAlreadyConfigured,
  AdoptExistingRule,
  InstallRule,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn detect_session_from_env(
  xdg_current_desktop: Option<&str>,
  kde_full_session: Option<&str>,
  desktop_session: Option<&str>,
  wayland_display: Option<&str>,
  xdg_session_type: Option<&str>,
  display: Option<&str>,
) -> DesktopSessionInfo {
  let current_desktop_kde = xdg_current_desktop.is_some_and(|raw| {
    raw
      .split(':')
      .map(str::trim)
      .any(|part| part.eq_ignore_ascii_case("kde") || part.eq_ignore_ascii_case("plasma"))
  });
  let full_session_kde = kde_full_session.is_some_and(|raw| {
    let v = raw.trim();
    v.eq_ignore_ascii_case("true") || v == "1"
  });
  let desktop_session_kde = desktop_session.is_some_and(|raw| {
    let lower = raw.trim().to_ascii_lowercase();
    lower.contains("plasma") || lower.contains("kde")
  });
  let is_kde = current_desktop_kde || full_session_kde || desktop_session_kde;

  let session_type = if wayland_display.is_some_and(|v| !v.trim().is_empty())
    || xdg_session_type.is_some_and(|v| v.trim().eq_ignore_ascii_case("wayland"))
  {
    "wayland"
  } else if display.is_some_and(|v| !v.trim().is_empty())
    || xdg_session_type.is_some_and(|v| v.trim().eq_ignore_ascii_case("x11"))
  {
    "x11"
  } else {
    "unknown"
  };

  DesktopSessionInfo {
    is_kde,
    session_type,
  }
}

pub fn current_session() -> DesktopSessionInfo {
  #[cfg(target_os = "linux")]
  {
    let xdg_current_desktop = std::env::var("XDG_CURRENT_DESKTOP").ok();
    let kde_full_session = std::env::var("KDE_FULL_SESSION").ok();
    let desktop_session = std::env::var("DESKTOP_SESSION").ok();
    let wayland_display = std::env::var("WAYLAND_DISPLAY").ok();
    let xdg_session_type = std::env::var("XDG_SESSION_TYPE").ok();
    let display = std::env::var("DISPLAY").ok();
    detect_session_from_env(
      xdg_current_desktop.as_deref(),
      kde_full_session.as_deref(),
      desktop_session.as_deref(),
      wayland_display.as_deref(),
      xdg_session_type.as_deref(),
      display.as_deref(),
    )
  }
  #[cfg(not(target_os = "linux"))]
  {
    DesktopSessionInfo {
      is_kde: false,
      session_type: "unknown",
    }
  }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_posix_absolute(path: &Path) -> bool {
  path.is_absolute() || path.to_str().is_some_and(|s| s.starts_with('/'))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn resolve_kwinrulesrc_path_from_env(
  xdg_config_home: Option<&OsStr>,
  home: Option<&OsStr>,
) -> Option<PathBuf> {
  if let Some(config_home) = xdg_config_home.filter(|v| !v.is_empty()) {
    let path = PathBuf::from(config_home);
    if is_posix_absolute(&path) {
      return Some(path.join(KWINRULES_FILE_NAME));
    }
  }
  let home = home.filter(|v| !v.is_empty())?;
  let path = PathBuf::from(home);
  if !is_posix_absolute(&path) {
    return None;
  }
  Some(path.join(".config").join(KWINRULES_FILE_NAME))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn kwinrulesrc_path() -> Option<PathBuf> {
  let xdg = std::env::var_os("XDG_CONFIG_HOME");
  let home = std::env::var_os("HOME");
  resolve_kwinrulesrc_path_from_env(xdg.as_deref(), home.as_deref())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct IniSection {
  name: String,
  lines: Vec<String>,
}

impl IniSection {
  fn new(name: impl Into<String>) -> Self {
    Self {
      name: name.into(),
      lines: Vec::new(),
    }
  }

  fn get(&self, key: &str) -> Option<&str> {
    for line in &self.lines {
      let trimmed = line.trim_start();
      if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
        continue;
      }
      if let Some((k, v)) = line.split_once('=') {
        if k.trim() == key {
          return Some(v.trim());
        }
      }
    }
    None
  }

  fn set(&mut self, key: &str, value: &str) {
    let formatted = format!("{key}={value}");
    let mut updated = false;
    let mut kept = Vec::with_capacity(self.lines.len() + 1);
    for line in self.lines.drain(..) {
      let trimmed = line.trim_start();
      let is_target = !trimmed.is_empty()
        && !trimmed.starts_with('#')
        && !trimmed.starts_with(';')
        && line.split_once('=').is_some_and(|(k, _)| k.trim() == key);
      if is_target {
        if !updated {
          kept.push(formatted.clone());
          updated = true;
        }
      } else {
        kept.push(line);
      }
    }
    if !updated {
      let insert_at = kept
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map_or(0, |idx| idx + 1);
      kept.insert(insert_at, formatted);
    }
    self.lines = kept;
  }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct KwinRulesDoc {
  preamble: Vec<String>,
  sections: Vec<IniSection>,
}

impl KwinRulesDoc {
  fn parse(content: &str) -> Self {
    let mut doc = Self::default();
    let mut current: Option<IniSection> = None;

    for raw_line in content.lines() {
      let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
      let trimmed = line.trim();
      if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() >= 3 {
        if let Some(section) = current.take() {
          doc.sections.push(section);
        }
        current = Some(IniSection::new(&trimmed[1..trimmed.len() - 1]));
      } else if let Some(section) = current.as_mut() {
        section.lines.push(line.to_string());
      } else {
        doc.preamble.push(line.to_string());
      }
    }
    if let Some(section) = current {
      doc.sections.push(section);
    }
    doc
  }

  fn serialize(&self) -> String {
    let mut out = String::new();
    for line in &self.preamble {
      out.push_str(line);
      out.push('\n');
    }
    for (idx, section) in self.sections.iter().enumerate() {
      if idx > 0 && !out.ends_with("\n\n") {
        if !out.ends_with('\n') {
          out.push('\n');
        }
        out.push('\n');
      } else if idx == 0 && !self.preamble.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
      }
      out.push('[');
      out.push_str(&section.name);
      out.push_str("]\n");
      for line in &section.lines {
        out.push_str(line);
        out.push('\n');
      }
    }
    while out.ends_with("\n\n") {
      out.pop();
    }
    out
  }

  fn section(&self, name: &str) -> Option<&IniSection> {
    self.sections.iter().find(|s| s.name == name)
  }

  fn section_mut(&mut self, name: &str) -> Option<&mut IniSection> {
    self.sections.iter_mut().find(|s| s.name == name)
  }

  fn ensure_general_mut(&mut self) -> &mut IniSection {
    if let Some(idx) = self.sections.iter().position(|s| s.name == GENERAL_SECTION) {
      return &mut self.sections[idx];
    }
    self.sections.insert(0, IniSection::new(GENERAL_SECTION));
    &mut self.sections[0]
  }

  /// Returns active rule group IDs in KWin evaluation order, supporting both modern
  /// comma-separated `[General] rules=...` (Plasma 5.19+ / Plasma 6) and legacy
  /// `[General] count=N` with numbered `[1]..[N]` sections.
  fn active_rule_ids(&self) -> Vec<String> {
    let Some(general) = self.section(GENERAL_SECTION) else {
      return Vec::new();
    };
    if let Some(raw_rules) = general.get("rules") {
      let mut ids = Vec::new();
      for item in raw_rules.split(',') {
        let id = item.trim();
        if !id.is_empty() && !ids.iter().any(|existing| existing == id) {
          ids.push(id.to_string());
        }
      }
      if !ids.is_empty() {
        return ids;
      }
      // Explicitly present `rules=` (empty) with count=0 means no active rules.
      if general.get("count").and_then(|c| c.parse::<usize>().ok()).unwrap_or(0) == 0 {
        return Vec::new();
      }
    }
    let count = general
      .get("count")
      .and_then(|c| c.parse::<usize>().ok())
      .unwrap_or(0);
    if count == 0 {
      return Vec::new();
    }
    (1..=count)
      .map(|i| i.to_string())
      .filter(|id| self.section(id).is_some())
      .collect()
  }

  fn inspect(&self) -> RuleInspection {
    let active_ids = self.active_rule_ids();
    if let Some(managed) = active_ids
      .iter()
      .find(|id| id.as_str() == MANAGED_RULE_ID)
      .and_then(|id| self.section(id))
    {
      return RuleInspection {
        installed: true,
        managed_by_pibot: true,
        up_to_date: section_is_up_to_date(managed),
        rule_id: Some(MANAGED_RULE_ID.to_string()),
      };
    }

    for id in &active_ids {
      if let Some(section) = self.section(id) {
        if section_matches_pibot_pet(section) {
          return RuleInspection {
            installed: true,
            managed_by_pibot: false,
            up_to_date: section_is_up_to_date(section),
            rule_id: Some(id.clone()),
          };
        }
      }
    }

    RuleInspection {
      installed: false,
      managed_by_pibot: false,
      up_to_date: false,
      rule_id: None,
    }
  }

  /// Inserts or updates the PiBot desktop pet rule while preserving all unrelated rules and
  /// sections verbatim. Returns `(target_rule_id, file_changed)`.
  fn upsert_pibot_rule(&mut self) -> (String, bool) {
    let before = self.serialize();
    let mut ids = self.active_rule_ids();
    let existing = self.inspect();
    let target_id = existing
      .rule_id
      .unwrap_or_else(|| MANAGED_RULE_ID.to_string());

    if !ids.iter().any(|id| id == &target_id) {
      ids.push(target_id.clone());
    }

    let count_str = ids.len().to_string();
    let rules_str = ids.join(",");
    {
      let general = self.ensure_general_mut();
      general.set("count", &count_str);
      general.set("rules", &rules_str);
    }

    if let Some(section) = self.section_mut(&target_id) {
      for (k, v) in MANAGED_RULE_ENTRIES {
        section.set(k, v);
      }
    } else {
      let mut section = IniSection::new(target_id.clone());
      for (k, v) in MANAGED_RULE_ENTRIES {
        section.set(k, v);
      }
      self.sections.push(section);
    }

    let changed = self.serialize() != before;
    (target_id, changed)
  }

  /// Removes any active PiBot desktop pet rules (and any orphaned managed rule section) while
  /// keeping all unrelated rules intact. Returns `true` if the serialized content changed.
  fn remove_pibot_rules(&mut self) -> bool {
    let before = self.serialize();
    let active_ids = self.active_rule_ids();
    let mut removed_ids: Vec<String> = active_ids
      .iter()
      .filter(|id| {
        id.as_str() == MANAGED_RULE_ID
          || self
            .section(id)
            .is_some_and(section_matches_pibot_pet)
      })
      .cloned()
      .collect();

    if !removed_ids.is_empty() {
      let remaining: Vec<String> = active_ids
        .into_iter()
        .filter(|id| !removed_ids.iter().any(|rem| rem == id))
        .collect();
      let count_str = remaining.len().to_string();
      let rules_str = remaining.join(",");
      let general = self.ensure_general_mut();
      general.set("count", &count_str);
      general.set("rules", &rules_str);
    }

    if !removed_ids.iter().any(|id| id == MANAGED_RULE_ID) {
      removed_ids.push(MANAGED_RULE_ID.to_string());
    }
    self
      .sections
      .retain(|sec| !removed_ids.iter().any(|id| id == &sec.name));

    self.serialize() != before
  }
}

fn section_matches_pibot_pet(section: &IniSection) -> bool {
  let wmclass_ok = section
    .get("wmclass")
    .is_some_and(|v| v.eq_ignore_ascii_case(RULE_WMCLASS))
    && section.get("wmclassmatch") == Some("1");
  let title_ok =
    section.get("title") == Some(RULE_TITLE) && section.get("titlematch") == Some("1");
  wmclass_ok && title_ok
}

fn section_is_up_to_date(section: &IniSection) -> bool {
  REQUIRED_RULE_ENTRIES.iter().all(|(key, expected)| {
    let Some(actual) = section.get(key) else {
      return false;
    };
    if *key == "wmclass" || *expected == "true" || *expected == "false" {
      actual.eq_ignore_ascii_case(expected)
    } else {
      actual == *expected
    }
  })
}

fn plan_auto_ensure(
  session: DesktopSessionInfo,
  state: &PersistedKdeRuleState,
  externally_managed: bool,
  inspection: &RuleInspection,
) -> AutoEnsurePlan {
  if !session.is_kde {
    return AutoEnsurePlan::SkipNotKde;
  }
  if state.auto_configured_rule_version >= CURRENT_RULE_VERSION {
    return AutoEnsurePlan::SkipAlreadyConfigured;
  }
  if externally_managed {
    return AutoEnsurePlan::SkipExternallyManaged;
  }
  if inspection.installed {
    if inspection.managed_by_pibot && !inspection.up_to_date {
      return AutoEnsurePlan::InstallRule;
    }
    return AutoEnsurePlan::AdoptExistingRule;
  }
  AutoEnsurePlan::InstallRule
}

fn state_file_path(app: &AppHandle) -> Option<PathBuf> {
  app
    .path()
    .app_config_dir()
    .ok()
    .map(|dir| dir.join(STATE_FILE_NAME))
}

fn load_persisted_state(path: &Path) -> PersistedKdeRuleState {
  fs::read_to_string(path)
    .ok()
    .and_then(|raw| serde_json::from_str::<PersistedKdeRuleState>(&raw).ok())
    .unwrap_or_default()
}

fn save_persisted_state(path: &Path, state: &PersistedKdeRuleState) -> Result<(), String> {
  let Some(parent) = path.parent() else {
    return Err("invalid KDE rule state path".to_string());
  };
  fs::create_dir_all(parent).map_err(|err| format!("failed to create config dir: {err}"))?;
  let payload = serde_json::to_vec_pretty(state)
    .map_err(|err| format!("failed to serialize KDE rule state: {err}"))?;
  let mut temp = tempfile::NamedTempFile::new_in(parent)
    .map_err(|err| format!("failed to create temporary state file: {err}"))?;
  temp
    .write_all(&payload)
    .map_err(|err| format!("failed to write temporary state file: {err}"))?;
  temp
    .persist(path)
    .map_err(|err| format!("failed to persist KDE rule state: {}", err.error))?;
  Ok(())
}

#[derive(Debug)]
enum KwinFileError {
  ExternallyManaged,
  Io(String),
}

fn is_symlink_path(path: &Path) -> Result<bool, String> {
  match fs::symlink_metadata(path) {
    Ok(meta) => Ok(meta.file_type().is_symlink()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(err) => Err(format!("could not inspect {}: {err}", path.display())),
  }
}

fn read_kwinrulesrc(path: &Path) -> Result<(KwinRulesDoc, bool), String> {
  let externally_managed = is_symlink_path(path)?;
  let content = match fs::read_to_string(path) {
    Ok(text) => text,
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
    Err(err) => return Err(format!("could not read {}: {err}", path.display())),
  };
  Ok((KwinRulesDoc::parse(&content), externally_managed))
}

fn write_kwinrulesrc_atomic(path: &Path, doc: &KwinRulesDoc) -> Result<(), KwinFileError> {
  let existing_meta = match fs::symlink_metadata(path) {
    Ok(meta) => {
      if meta.file_type().is_symlink() {
        return Err(KwinFileError::ExternallyManaged);
      }
      Some(meta)
    }
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
    Err(err) => {
      return Err(KwinFileError::Io(format!(
        "could not inspect {}: {err}",
        path.display()
      )))
    }
  };

  let Some(parent) = path.parent() else {
    return Err(KwinFileError::Io("invalid kwinrulesrc path".to_string()));
  };
  fs::create_dir_all(parent)
    .map_err(|err| KwinFileError::Io(format!("could not create {}: {err}", parent.display())))?;

  let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|err| {
    KwinFileError::Io(format!(
      "could not create temporary file in {}: {err}",
      parent.display()
    ))
  })?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    let mode = existing_meta
      .as_ref()
      .map(|m| m.permissions().mode() & 0o7777)
      .unwrap_or(0o600);
    let _ = fs::set_permissions(temp.path(), fs::Permissions::from_mode(mode));
  }
  #[cfg(not(unix))]
  let _ = existing_meta;

  temp
    .write_all(doc.serialize().as_bytes())
    .and_then(|_| temp.flush())
    .map_err(|err| KwinFileError::Io(format!("could not write kwinrulesrc: {err}")))?;

  temp
    .persist(path)
    .map_err(|err| KwinFileError::Io(format!("could not save {}: {}", path.display(), err.error)))?;
  Ok(())
}

#[cfg(target_os = "linux")]
fn reconfigure_kwin() -> bool {
  use std::process::{Command, Stdio};

  let candidates: &[(&str, &[&str])] = &[
    (
      "dbus-send",
      &[
        "--session",
        "--type=method_call",
        "--print-reply",
        "--reply-timeout=2000",
        "--dest=org.kde.KWin",
        "/KWin",
        "org.kde.KWin.reconfigure",
      ],
    ),
    (
      "gdbus",
      &[
        "call",
        "--session",
        "--dest",
        "org.kde.KWin",
        "--object-path",
        "/KWin",
        "--method",
        "org.kde.KWin.reconfigure",
        "--timeout",
        "2",
      ],
    ),
    ("qdbus6", &["org.kde.KWin", "/KWin", "reconfigure"]),
    ("qdbus-qt6", &["org.kde.KWin", "/KWin", "reconfigure"]),
    ("qdbus", &["org.kde.KWin", "/KWin", "reconfigure"]),
  ];

  for (program, args) in candidates {
    match Command::new(program)
      .args(*args)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status()
    {
      Ok(status) => return status.success(),
      Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
      Err(_) => return false,
    }
  }
  false
}

#[cfg(not(target_os = "linux"))]
fn reconfigure_kwin() -> bool {
  false
}

fn ensure_auto_configured_sync(
  session: DesktopSessionInfo,
  kwin_path: &Path,
  state_path: &Path,
) -> Result<bool, String> {
  if !session.is_kde {
    return Ok(false);
  }
  let state = load_persisted_state(state_path);
  let (mut doc, externally_managed) = read_kwinrulesrc(kwin_path)?;
  let inspection = doc.inspect();

  match plan_auto_ensure(session, &state, externally_managed, &inspection) {
    AutoEnsurePlan::SkipNotKde
    | AutoEnsurePlan::SkipExternallyManaged
    | AutoEnsurePlan::SkipAlreadyConfigured => Ok(false),
    AutoEnsurePlan::AdoptExistingRule => {
      let next = PersistedKdeRuleState {
        auto_configured_rule_version: CURRENT_RULE_VERSION,
        managed_rule_id: inspection
          .managed_by_pibot
          .then(|| inspection.rule_id.unwrap_or_else(|| MANAGED_RULE_ID.to_string())),
      };
      let _ = save_persisted_state(state_path, &next);
      Ok(false)
    }
    AutoEnsurePlan::InstallRule => {
      let (rule_id, changed) = doc.upsert_pibot_rule();
      if changed {
        write_kwinrulesrc_atomic(kwin_path, &doc).map_err(|err| match err {
          KwinFileError::ExternallyManaged => {
            "kwinrulesrc is a symlink managed externally".to_string()
          }
          KwinFileError::Io(message) => message,
        })?;
      }
      let next = PersistedKdeRuleState {
        auto_configured_rule_version: CURRENT_RULE_VERSION,
        managed_rule_id: Some(rule_id),
      };
      let _ = save_persisted_state(state_path, &next);
      Ok(changed)
    }
  }
}

fn status_sync(session: DesktopSessionInfo, kwin_path: &Path) -> Result<KdeWindowRuleStatus, String> {
  if !session.is_kde {
    return Ok(KdeWindowRuleStatus::unsupported(session.session_type));
  }
  let (doc, externally_managed) = read_kwinrulesrc(kwin_path)?;
  let inspection = doc.inspect();
  Ok(KdeWindowRuleStatus {
    supported: true,
    session_type: session.session_type,
    installed: inspection.installed,
    managed_by_pibot: inspection.managed_by_pibot,
    up_to_date: inspection.up_to_date,
    externally_managed,
    reconfigured: None,
    config_path: Some(kwin_path.display().to_string()),
  })
}

fn apply_sync(
  session: DesktopSessionInfo,
  kwin_path: &Path,
  state_path: Option<&Path>,
) -> Result<KdeWindowRuleStatus, BridgeError> {
  if !session.is_kde {
    return Ok(KdeWindowRuleStatus::unsupported(session.session_type));
  }
  let (mut doc, externally_managed) = read_kwinrulesrc(kwin_path)
    .map_err(|message| BridgeError::new("INTERNAL", message, "not-sent"))?;
  if externally_managed {
    return Err(BridgeError::new(
      "EXTERNALLY_MANAGED",
      format!(
        "{} is a symlink managed externally; import /usr/share/pibot/desktop-pet.kwinrule manually or add it to your declarative config",
        kwin_path.display()
      ),
      "not-sent",
    ));
  }
  let (rule_id, changed) = doc.upsert_pibot_rule();
  if changed {
    write_kwinrulesrc_atomic(kwin_path, &doc).map_err(|err| match err {
      KwinFileError::ExternallyManaged => BridgeError::new(
        "EXTERNALLY_MANAGED",
        format!("{} is a symlink managed externally", kwin_path.display()),
        "not-sent",
      ),
      KwinFileError::Io(message) => BridgeError::new("INTERNAL", message, "not-sent"),
    })?;
  }
  if let Some(state_path) = state_path {
    let next = PersistedKdeRuleState {
      auto_configured_rule_version: CURRENT_RULE_VERSION,
      managed_rule_id: Some(rule_id),
    };
    let _ = save_persisted_state(state_path, &next);
  }
  let reconfigured = reconfigure_kwin();
  let inspection = doc.inspect();
  Ok(KdeWindowRuleStatus {
    supported: true,
    session_type: session.session_type,
    installed: inspection.installed,
    managed_by_pibot: inspection.managed_by_pibot,
    up_to_date: inspection.up_to_date,
    externally_managed: false,
    reconfigured: Some(reconfigured),
    config_path: Some(kwin_path.display().to_string()),
  })
}

fn remove_sync(
  session: DesktopSessionInfo,
  kwin_path: &Path,
  state_path: Option<&Path>,
) -> Result<KdeWindowRuleStatus, BridgeError> {
  if !session.is_kde {
    return Ok(KdeWindowRuleStatus::unsupported(session.session_type));
  }
  let (mut doc, externally_managed) = read_kwinrulesrc(kwin_path)
    .map_err(|message| BridgeError::new("INTERNAL", message, "not-sent"))?;
  if externally_managed {
    return Err(BridgeError::new(
      "EXTERNALLY_MANAGED",
      format!(
        "{} is a symlink managed externally and was not modified",
        kwin_path.display()
      ),
      "not-sent",
    ));
  }
  let changed = doc.remove_pibot_rules();
  if changed {
    write_kwinrulesrc_atomic(kwin_path, &doc).map_err(|err| match err {
      KwinFileError::ExternallyManaged => BridgeError::new(
        "EXTERNALLY_MANAGED",
        format!("{} is a symlink managed externally", kwin_path.display()),
        "not-sent",
      ),
      KwinFileError::Io(message) => BridgeError::new("INTERNAL", message, "not-sent"),
    })?;
  }
  if let Some(state_path) = state_path {
    let next = PersistedKdeRuleState {
      auto_configured_rule_version: CURRENT_RULE_VERSION,
      managed_rule_id: None,
    };
    let _ = save_persisted_state(state_path, &next);
  }
  let reconfigured = if changed { Some(reconfigure_kwin()) } else { None };
  let inspection = doc.inspect();
  Ok(KdeWindowRuleStatus {
    supported: true,
    session_type: session.session_type,
    installed: inspection.installed,
    managed_by_pibot: inspection.managed_by_pibot,
    up_to_date: inspection.up_to_date,
    externally_managed: false,
    reconfigured,
    config_path: Some(kwin_path.display().to_string()),
  })
}

/// Ensures the KDE desktop pet window rule has been auto-imported at least once for this user.
/// Fast-paths immediately after the first check in this process lifetime or on non-KDE sessions.
pub async fn ensure_auto_configured(app: &AppHandle) {
  let session = current_session();
  if !session.is_kde {
    return;
  }
  let manager = app.state::<KdeWindowRuleManager>();
  if manager.auto_checked.load(Ordering::Acquire) {
    return;
  }
  let _guard = manager.operation.lock().await;
  if manager.auto_checked.load(Ordering::Acquire) {
    return;
  }
  let Some(kwin_path) = kwinrulesrc_path() else {
    manager.auto_checked.store(true, Ordering::Release);
    return;
  };
  let Some(state_path) = state_file_path(app) else {
    manager.auto_checked.store(true, Ordering::Release);
    return;
  };
  let result = tauri::async_runtime::spawn_blocking(move || {
    match ensure_auto_configured_sync(session, &kwin_path, &state_path) {
      Ok(changed) => {
        if changed {
          let _ = reconfigure_kwin();
        }
      }
      Err(err) => {
        eprintln!("Failed to auto-configure KDE desktop pet window rule: {err}");
      }
    }
  })
  .await;
  if result.is_ok() {
    manager.auto_checked.store(true, Ordering::Release);
  }
}

/// Best-effort startup check so users who upgrade via the built-in updater get the KWin rule
/// configured as soon as the updated client starts, even before opening the pet.
pub fn ensure_auto_configured_in_background(app: &AppHandle) {
  if !current_session().is_kde {
    return;
  }
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    ensure_auto_configured(&app).await;
  });
}

#[tauri::command]
pub async fn desktop_pet_kde_rule(
  app: AppHandle,
  webview: Webview,
  manager: State<'_, KdeWindowRuleManager>,
  action: String,
) -> Result<KdeWindowRuleStatus, BridgeError> {
  ensure_main_webview(&webview)?;
  let session = current_session();
  if !session.is_kde {
    return Ok(KdeWindowRuleStatus::unsupported(session.session_type));
  }
  let Some(kwin_path) = kwinrulesrc_path() else {
    return Err(BridgeError::new(
      "INTERNAL",
      "could not resolve KDE kwinrulesrc path",
      "not-sent",
    ));
  };
  let state_path = state_file_path(&app);
  let _guard = manager.operation.lock().await;

  match action.as_str() {
    "status" => tauri::async_runtime::spawn_blocking(move || status_sync(session, &kwin_path))
      .await
      .map_err(|_| BridgeError::new("INTERNAL", "KDE rule status worker failed", "not-sent"))?
      .map_err(|message| BridgeError::new("INTERNAL", message, "not-sent")),
    "apply" => {
      let status = tauri::async_runtime::spawn_blocking(move || {
        apply_sync(session, &kwin_path, state_path.as_deref())
      })
      .await
      .map_err(|_| BridgeError::new("INTERNAL", "KDE rule apply worker failed", "not-sent"))??;
      manager.auto_checked.store(true, Ordering::Release);
      Ok(status)
    }
    "remove" => {
      let status = tauri::async_runtime::spawn_blocking(move || {
        remove_sync(session, &kwin_path, state_path.as_deref())
      })
      .await
      .map_err(|_| BridgeError::new("INTERNAL", "KDE rule remove worker failed", "not-sent"))??;
      manager.auto_checked.store(true, Ordering::Release);
      Ok(status)
    }
    _ => Err(BridgeError::new(
      "INVALID_ARGUMENT",
      "Unknown KDE window rule action",
      "not-sent",
    )),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::ffi::OsString;

  #[test]
  fn detects_kde_wayland_x11_and_non_kde_sessions() {
    assert_eq!(
      detect_session_from_env(Some("KDE"), None, None, Some("wayland-0"), Some("wayland"), Some(":0")),
      DesktopSessionInfo { is_kde: true, session_type: "wayland" }
    );
    assert_eq!(
      detect_session_from_env(Some("ubuntu:KDE"), None, None, None, Some("x11"), Some(":0")),
      DesktopSessionInfo { is_kde: true, session_type: "x11" }
    );
    assert_eq!(
      detect_session_from_env(None, Some("true"), None, None, None, Some(":1")),
      DesktopSessionInfo { is_kde: true, session_type: "x11" }
    );
    assert_eq!(
      detect_session_from_env(None, None, Some("plasmawayland"), Some("wayland-0"), None, None),
      DesktopSessionInfo { is_kde: true, session_type: "wayland" }
    );
    assert_eq!(
      detect_session_from_env(Some("ubuntu:GNOME"), None, Some("ubuntu"), Some("wayland-0"), Some("wayland"), None),
      DesktopSessionInfo { is_kde: false, session_type: "wayland" }
    );
    assert_eq!(
      detect_session_from_env(Some("XFCE"), None, Some("xfce"), None, Some("x11"), Some(":0")),
      DesktopSessionInfo { is_kde: false, session_type: "x11" }
    );
  }

  #[test]
  fn resolves_kwinrulesrc_path_respecting_xdg_config_home_and_home() {
    let custom = OsString::from("/tmp/custom-config");
    let home = OsString::from("/home/alice");
    assert_eq!(
      resolve_kwinrulesrc_path_from_env(Some(&custom), Some(&home)),
      Some(PathBuf::from("/tmp/custom-config").join(KWINRULES_FILE_NAME))
    );

    let relative = OsString::from("relative/path");
    assert_eq!(
      resolve_kwinrulesrc_path_from_env(Some(&relative), Some(&home)),
      Some(PathBuf::from("/home/alice").join(".config").join(KWINRULES_FILE_NAME))
    );

    assert_eq!(
      resolve_kwinrulesrc_path_from_env(None, Some(&home)),
      Some(PathBuf::from("/home/alice").join(".config").join(KWINRULES_FILE_NAME))
    );

    assert_eq!(resolve_kwinrulesrc_path_from_env(None, None), None);
  }

  #[test]
  fn never_matches_or_removes_rule_for_pibot_main_window() {
    let main_win_rule = "\
[General]
count=1
rules=main-window-uuid

[main-window-uuid]
Description=PiBot main window
wmclass=pibot
wmclassmatch=1
title=Pi Bot
titlematch=1
size=1200,820
sizerule=3
";
    let mut doc = KwinRulesDoc::parse(main_win_rule);
    assert!(!doc.inspect().installed);

    let (id, changed) = doc.upsert_pibot_rule();
    assert_eq!(id, MANAGED_RULE_ID);
    assert!(changed);
    assert_eq!(
      doc.active_rule_ids(),
      vec!["main-window-uuid".to_string(), MANAGED_RULE_ID.to_string()]
    );

    assert!(doc.remove_pibot_rules());
    assert_eq!(doc.active_rule_ids(), vec!["main-window-uuid".to_string()]);
    assert!(doc.section("main-window-uuid").is_some());
    assert!(doc.section(MANAGED_RULE_ID).is_none());
  }

  #[test]
  fn inserts_managed_rule_into_empty_document_and_is_idempotent() {
    let mut doc = KwinRulesDoc::parse("");
    let (id, changed) = doc.upsert_pibot_rule();
    assert_eq!(id, MANAGED_RULE_ID);
    assert!(changed);

    let serialized = doc.serialize();
    let reparsed = KwinRulesDoc::parse(&serialized);
    assert_eq!(reparsed.active_rule_ids(), vec![MANAGED_RULE_ID.to_string()]);
    assert_eq!(reparsed.section(GENERAL_SECTION).unwrap().get("count"), Some("1"));
    assert_eq!(reparsed.section(GENERAL_SECTION).unwrap().get("rules"), Some(MANAGED_RULE_ID));

    let inspection = reparsed.inspect();
    assert_eq!(
      inspection,
      RuleInspection {
        installed: true,
        managed_by_pibot: true,
        up_to_date: true,
        rule_id: Some(MANAGED_RULE_ID.to_string()),
      }
    );

    // Second upsert must be a no-op
    let mut doc2 = reparsed;
    let (id2, changed2) = doc2.upsert_pibot_rule();
    assert_eq!(id2, MANAGED_RULE_ID);
    assert!(!changed2);
    assert_eq!(doc2.serialize(), serialized);
  }

  #[test]
  fn preserves_existing_modern_uuid_rules_and_removes_only_pibot_rule() {
    let initial = "\
[General]
count=1
rules=11111111-2222-3333-4444-555555555555

[11111111-2222-3333-4444-555555555555]
Description=Keep Konsole transparent
opacityactive=85
opacityactiverule=2
wmclass=konsole
wmclassmatch=1
";
    let mut doc = KwinRulesDoc::parse(initial);
    let (id, changed) = doc.upsert_pibot_rule();
    assert_eq!(id, MANAGED_RULE_ID);
    assert!(changed);
    assert_eq!(
      doc.active_rule_ids(),
      vec![
        "11111111-2222-3333-4444-555555555555".to_string(),
        MANAGED_RULE_ID.to_string(),
      ]
    );
    assert_eq!(doc.section(GENERAL_SECTION).unwrap().get("count"), Some("2"));
    assert_eq!(
      doc.section("11111111-2222-3333-4444-555555555555").unwrap().get("opacityactive"),
      Some("85")
    );

    // Removing PiBot rule leaves unrelated rule intact
    assert!(doc.remove_pibot_rules());
    assert_eq!(
      doc.active_rule_ids(),
      vec!["11111111-2222-3333-4444-555555555555".to_string()]
    );
    assert_eq!(doc.section(GENERAL_SECTION).unwrap().get("count"), Some("1"));
    assert_eq!(
      doc.section(GENERAL_SECTION).unwrap().get("rules"),
      Some("11111111-2222-3333-4444-555555555555")
    );
    assert!(doc.section(MANAGED_RULE_ID).is_none());
    assert!(doc.section("11111111-2222-3333-4444-555555555555").is_some());
    assert!(!doc.remove_pibot_rules());
  }

  #[test]
  fn preserves_legacy_numbered_plasma_rules_when_appending_managed_rule() {
    let legacy = "\
[General]
count=2

[1]
Description=Legacy Firefox rule
wmclass=firefox
wmclassmatch=1
noborder=true
noborderrule=2

[2]
Description=Legacy Terminal rule
wmclass=alacritty
wmclassmatch=1
";
    let mut doc = KwinRulesDoc::parse(legacy);
    assert_eq!(doc.active_rule_ids(), vec!["1".to_string(), "2".to_string()]);

    let (id, changed) = doc.upsert_pibot_rule();
    assert_eq!(id, MANAGED_RULE_ID);
    assert!(changed);
    assert_eq!(
      doc.active_rule_ids(),
      vec!["1".to_string(), "2".to_string(), MANAGED_RULE_ID.to_string()]
    );
    assert_eq!(doc.section(GENERAL_SECTION).unwrap().get("count"), Some("3"));
    assert_eq!(
      doc.section(GENERAL_SECTION).unwrap().get("rules"),
      Some(format!("1,2,{MANAGED_RULE_ID}").as_str())
    );
    assert!(doc.section("1").is_some());
    assert!(doc.section("2").is_some());
    assert!(doc.section(MANAGED_RULE_ID).is_some());
  }

  #[test]
  fn detects_and_updates_previously_manually_imported_rule_without_duplicating() {
    let manual = "\
[General]
count=1
rules=deadbeef-0000-4000-8000-123456789abc

[deadbeef-0000-4000-8000-123456789abc]
Description=PiBot desktop pet
wmclass=pibot
wmclassmatch=1
title=PiBot
titlematch=1
above=true
aboverule=2
skiptaskbar=true
skiptaskbarrule=2
";
    let mut doc = KwinRulesDoc::parse(manual);
    let before_inspect = doc.inspect();
    assert_eq!(
      before_inspect,
      RuleInspection {
        installed: true,
        managed_by_pibot: false,
        up_to_date: false, // missing skippager / skipswitcher
        rule_id: Some("deadbeef-0000-4000-8000-123456789abc".to_string()),
      }
    );

    // Explicit upsert upgrades the existing manual rule in place instead of creating a duplicate
    let (id, changed) = doc.upsert_pibot_rule();
    assert_eq!(id, "deadbeef-0000-4000-8000-123456789abc");
    assert!(changed);
    assert_eq!(doc.active_rule_ids().len(), 1);
    assert!(doc.section(MANAGED_RULE_ID).is_none());
    let after = doc.inspect();
    assert!(after.installed);
    assert!(!after.managed_by_pibot);
    assert!(after.up_to_date);
  }

  #[test]
  fn auto_ensure_respects_manual_import_and_user_deletion_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let kwin_path = dir.path().join("kwinrulesrc");
    let state_path = dir.path().join(STATE_FILE_NAME);
    let kde_wayland = DesktopSessionInfo { is_kde: true, session_type: "wayland" };

    // 1. Fresh install / first upgrade auto-installs rule and writes marker
    assert_eq!(
      ensure_auto_configured_sync(kde_wayland, &kwin_path, &state_path).unwrap(),
      true
    );
    let st1 = status_sync(kde_wayland, &kwin_path).unwrap();
    assert!(st1.installed && st1.managed_by_pibot && st1.up_to_date);

    // 2. Subsequent startup is a no-op
    assert_eq!(
      ensure_auto_configured_sync(kde_wayland, &kwin_path, &state_path).unwrap(),
      false
    );

    // 3. User manually deletes the rule in KDE System Settings (empty kwinrulesrc)
    fs::write(&kwin_path, "[General]\ncount=0\nrules=\n").unwrap();
    let st_deleted = status_sync(kde_wayland, &kwin_path).unwrap();
    assert!(!st_deleted.installed);

    // 4. Next startup / update respects user's deletion and does NOT resurrect the rule
    assert_eq!(
      ensure_auto_configured_sync(kde_wayland, &kwin_path, &state_path).unwrap(),
      false
    );
    assert!(!status_sync(kde_wayland, &kwin_path).unwrap().installed);

    // 5. Explicit apply restores the rule
    let applied = apply_sync(kde_wayland, &kwin_path, Some(&state_path)).unwrap();
    assert!(applied.installed && applied.managed_by_pibot && applied.up_to_date);

    // 6. Explicit remove deletes it and keeps marker so startup does not resurrect it
    let removed = remove_sync(kde_wayland, &kwin_path, Some(&state_path)).unwrap();
    assert!(!removed.installed);
    assert_eq!(
      ensure_auto_configured_sync(kde_wayland, &kwin_path, &state_path).unwrap(),
      false
    );
    assert!(!status_sync(kde_wayland, &kwin_path).unwrap().installed);
  }

  #[test]
  fn auto_ensure_adopts_existing_manual_rule_without_modifying_kwinrulesrc() {
    let dir = tempfile::tempdir().unwrap();
    let kwin_path = dir.path().join("kwinrulesrc");
    let state_path = dir.path().join(STATE_FILE_NAME);
    let kde_x11 = DesktopSessionInfo { is_kde: true, session_type: "x11" };
    let original = "\
[General]
count=1
rules=custom-uuid-1

[custom-uuid-1]
Description=PiBot desktop pet
wmclass=pibot
wmclassmatch=1
title=PiBot
titlematch=1
above=true
aboverule=2
skiptaskbar=true
skiptaskbarrule=2
";
    fs::write(&kwin_path, original).unwrap();

    // Auto-ensure adopts the existing rule without modifying disk
    assert_eq!(
      ensure_auto_configured_sync(kde_x11, &kwin_path, &state_path).unwrap(),
      false
    );
    assert_eq!(fs::read_to_string(&kwin_path).unwrap(), original);
    assert_eq!(
      load_persisted_state(&state_path).auto_configured_rule_version,
      CURRENT_RULE_VERSION
    );
  }

  #[test]
  fn auto_ensure_does_nothing_on_non_kde_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let kwin_path = dir.path().join("kwinrulesrc");
    let state_path = dir.path().join(STATE_FILE_NAME);
    let gnome = DesktopSessionInfo { is_kde: false, session_type: "wayland" };

    assert_eq!(ensure_auto_configured_sync(gnome, &kwin_path, &state_path).unwrap(), false);
    assert!(!kwin_path.exists());
    assert!(!state_path.exists());
    let st = status_sync(gnome, &kwin_path).unwrap();
    assert!(!st.supported);
  }

  #[test]
  fn plan_auto_ensure_upgrades_older_pibot_managed_rule_when_version_bumps() {
    let kde = DesktopSessionInfo { is_kde: true, session_type: "wayland" };
    let old_state = PersistedKdeRuleState {
      auto_configured_rule_version: 0,
      managed_rule_id: Some(MANAGED_RULE_ID.to_string()),
    };
    let outdated_managed = RuleInspection {
      installed: true,
      managed_by_pibot: true,
      up_to_date: false,
      rule_id: Some(MANAGED_RULE_ID.to_string()),
    };
    assert_eq!(
      plan_auto_ensure(kde, &old_state, false, &outdated_managed),
      AutoEnsurePlan::InstallRule
    );

    let external_symlink = RuleInspection {
      installed: false,
      managed_by_pibot: false,
      up_to_date: false,
      rule_id: None,
    };
    assert_eq!(
      plan_auto_ensure(kde, &PersistedKdeRuleState::default(), true, &external_symlink),
      AutoEnsurePlan::SkipExternallyManaged
    );
  }
}
