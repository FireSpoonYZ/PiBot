//! Lightweight local pet window. The main webview owns all bot/broker state.
use std::{
  fs,
  path::PathBuf,
  sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex,
  },
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
  webview::{NewWindowResponse, PermissionKind, PermissionResponse},
  AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
  Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use crate::BridgeError;

pub const PET_LABEL: &str = "pet";
const WINDOW_EVENT: &str = "pibot:pet-window";
/// Ambient mascot window: holds the 96px mascot + hover rail + shadow breathing room.
const COLLAPSED_SIZE: (f64, f64) = (164.0, 128.0);
const EXPANDED_SIZE: (f64, f64) = (380.0, 560.0);
const MAX_STAGE_WIDTH: f64 = 520.0;
const MAX_STAGE_HEIGHT: f64 = 720.0;
/// Probe envelope when choosing bubble/panel orientation from collapsed state so
/// short thought bubbles never flip orientation as they grow into replies or QA cards.
const ORIENTATION_PROBE_SIZE: (f64, f64) = (380.0, 480.0);
const STAGE_PADDING: f64 = 12.0;
const AVATAR_HALF_SIZE: f64 = 48.0;
const DOCK_CENTER_OFFSET_Y: f64 = 64.0;
const EDGE_ANCHOR_OFFSET_X: f64 = STAGE_PADDING + AVATAR_HALF_SIZE;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DOCK_RADIUS: i32 = 22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DockSide {
  Right,
  Left,
  Center,
}

impl DockSide {
  const fn as_str(self) -> &'static str {
    match self {
      Self::Right => "right",
      Self::Left => "left",
      Self::Center => "center",
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PanelSide {
  Top,
  Bottom,
}

impl PanelSide {
  const fn as_str(self) -> &'static str {
    match self {
      Self::Top => "top",
      Self::Bottom => "bottom",
    }
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WorkArea {
  x: i32,
  y: i32,
  width: u32,
  height: u32,
}

impl WorkArea {
  fn from_monitor(monitor: &Monitor) -> Self {
    let area = monitor.work_area();
    Self {
      x: area.position.x,
      y: area.position.y,
      width: area.size.width,
      height: area.size.height,
    }
  }

  fn from_monitor_bounds(monitor: &Monitor) -> Self {
    let pos = monitor.position();
    let size = monitor.size();
    Self {
      x: pos.x,
      y: pos.y,
      width: size.width,
      height: size.height,
    }
  }

  fn contains(self, pos: PhysicalPosition<i32>) -> bool {
    pos.x >= self.x
      && pos.y >= self.y
      && pos.x < self.x + self.width as i32
      && pos.y < self.y + self.height as i32
  }
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RectI {
  x: i32,
  y: i32,
  width: i32,
  height: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalHitRect {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  #[serde(default)]
  pub radius: i32,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWindowLayoutRequest {
  pub width: f64,
  pub height: f64,
  #[serde(default)]
  pub composer_height: f64,
  #[serde(default)]
  pub focus: bool,
  #[serde(default)]
  pub hit_rects: Vec<LogicalHitRect>,
}

struct PetGeometry {
  dock_side: DockSide,
  panel_side: PanelSide,
  composited: bool,
  last_collapsed_pos: Option<PhysicalPosition<i32>>,
  anchor_pos: Option<PhysicalPosition<i32>>,
  expected_window_pos: Option<PhysicalPosition<i32>>,
  current_logical_size: (f64, f64),
  current_composer_height: f64,
  hit_rects: Vec<LogicalHitRect>,
  move_seq: u64,
}

impl Default for PetGeometry {
  fn default() -> Self {
    Self {
      dock_side: DockSide::Right,
      panel_side: PanelSide::Top,
      composited: true,
      last_collapsed_pos: None,
      anchor_pos: None,
      expected_window_pos: None,
      current_logical_size: COLLAPSED_SIZE,
      current_composer_height: 0.0,
      hit_rects: Vec::new(),
      move_seq: 0,
    }
  }
}

#[derive(Default)]
pub struct DesktopPet {
  visible: AtomicBool,
  revealed: AtomicBool,
  expanded: AtomicBool,
  focused: AtomicBool,
  layout_in_progress: AtomicUsize,
  geometry: Mutex<PetGeometry>,
  operation: tokio::sync::Mutex<()>,
  destroyed: tokio::sync::Notify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PetRevealState {
  visible: bool,
  revealed: bool,
}

fn should_show_window_on_show_action(window_existed: bool, revealed: bool) -> bool {
  window_existed && revealed
}

fn should_show_window_on_reveal_action(state: PetRevealState) -> bool {
  state.visible && !state.revealed
}

fn should_track_native_geometry(state: PetRevealState) -> bool {
  state.visible && state.revealed
}

impl DesktopPet {
  fn is_applying_layout(&self) -> bool {
    self.layout_in_progress.load(Ordering::Acquire) > 0
  }

  fn begin_layout_apply(&self) -> LayoutApplyGuard<'_> {
    self.layout_in_progress.fetch_add(1, Ordering::AcqRel);
    // Cancel any pending pre-layout user-drag settle timer so it cannot overwrite programmatic state.
    let mut geo = self.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.move_seq = geo.move_seq.wrapping_add(1);
    drop(geo);
    LayoutApplyGuard { pet: self }
  }
}

struct LayoutApplyGuard<'a> {
  pet: &'a DesktopPet,
}

impl Drop for LayoutApplyGuard<'_> {
  fn drop(&mut self) {
    self.pet.layout_in_progress.fetch_sub(1, Ordering::AcqRel);
  }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedPetState {
  #[serde(default)]
  visible: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  x: Option<i32>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  y: Option<i32>,
}

fn persisted_state_path(app: &AppHandle) -> Option<PathBuf> {
  app.path().app_config_dir().ok().map(|dir| dir.join("pet-state.json"))
}

fn load_persisted_state(app: &AppHandle) -> PersistedPetState {
  let Some(path) = persisted_state_path(app) else {
    return PersistedPetState::default();
  };
  fs::read_to_string(path)
    .ok()
    .and_then(|raw| serde_json::from_str::<PersistedPetState>(&raw).ok())
    .unwrap_or_default()
}

fn save_persisted_state(app: &AppHandle, state: &PersistedPetState) {
  let Some(path) = persisted_state_path(app) else {
    return;
  };
  let Some(parent) = path.parent() else {
    return;
  };
  let Ok(serialized) = serde_json::to_vec_pretty(state) else {
    return;
  };
  if fs::create_dir_all(parent).is_err() {
    return;
  }
  let temp = path.with_extension("json.tmp");
  if fs::write(&temp, serialized).is_ok() {
    let _ = fs::rename(&temp, &path).or_else(|_| {
      let _ = fs::remove_file(&path);
      fs::rename(&temp, &path)
    });
  }
}

fn save_current_preference(app: &AppHandle, visible: bool) {
  let pet = app.state::<DesktopPet>();
  let pos = pet.geometry.lock().unwrap_or_else(|e| e.into_inner()).last_collapsed_pos;
  save_persisted_state(
    app,
    &PersistedPetState {
      visible,
      x: pos.map(|p| p.x),
      y: pos.map(|p| p.y),
    },
  );
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetWindowState {
  visible: bool,
  expanded: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  focused: Option<bool>,
  dock_side: &'static str,
  panel_side: &'static str,
  composited: bool,
  width: u32,
  height: u32,
}

fn state_with_focus(
  app: &AppHandle,
  focused_override: Option<Option<bool>>,
) -> DesktopPetWindowState {
  let pet = app.state::<DesktopPet>();
  let geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
  let focused = focused_override.unwrap_or_else(|| Some(pet.focused.load(Ordering::Acquire)));
  DesktopPetWindowState {
    visible: pet.visible.load(Ordering::Acquire),
    expanded: pet.expanded.load(Ordering::Acquire),
    focused,
    dock_side: geo.dock_side.as_str(),
    panel_side: geo.panel_side.as_str(),
    composited: geo.composited,
    width: geo.current_logical_size.0.round().max(1.0) as u32,
    height: geo.current_logical_size.1.round().max(1.0) as u32,
  }
}

fn state(app: &AppHandle) -> DesktopPetWindowState {
  state_with_focus(app, None)
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn is_visible(app: &AppHandle) -> bool {
  app.try_state::<DesktopPet>()
    .is_some_and(|pet| pet.visible.load(Ordering::Acquire))
}

fn publish_with_focus(
  app: &AppHandle,
  focused_override: Option<Option<bool>>,
) -> DesktopPetWindowState {
  let next = state_with_focus(app, focused_override);
  let _ = app.emit_to("main", WINDOW_EVENT, next);
  let _ = app.emit_to(PET_LABEL, WINDOW_EVENT, next);
  #[cfg(any(windows, target_os = "linux"))]
  crate::desktop_tray::sync_pet_visible(app, next.visible);
  next
}

fn publish(app: &AppHandle) -> DesktopPetWindowState {
  publish_with_focus(app, None)
}

fn native_error(message: &str) -> BridgeError {
  BridgeError::new("INTERNAL", message, "not-sent")
}

pub fn permits(url: &tauri::Url) -> bool {
  crate::is_allowed_navigation(url)
    && matches!(url.path(), "/" | "/index.html")
    && url.query_pairs().any(|(key, value)| key == "view" && value == "pet")
}

fn clamp_to_area(
  position: PhysicalPosition<i32>,
  size: PhysicalSize<u32>,
  area: WorkArea,
) -> PhysicalPosition<i32> {
  let max_x = area.x + area.width.saturating_sub(size.width) as i32;
  let max_y = area.y + area.height.saturating_sub(size.height) as i32;
  PhysicalPosition::new(
    position.x.clamp(area.x, max_x),
    position.y.clamp(area.y, max_y),
  )
}

fn clamp_position(
  position: PhysicalPosition<i32>,
  size: PhysicalSize<u32>,
  monitor: &Monitor,
) -> PhysicalPosition<i32> {
  clamp_to_area(position, size, WorkArea::from_monitor(monitor))
}

fn cap_size(size: PhysicalSize<u32>, area: Option<WorkArea>) -> PhysicalSize<u32> {
  match area {
    Some(area) => PhysicalSize::new(size.width.min(area.width), size.height.min(area.height)),
    None => size,
  }
}

fn sanitize_logical_size(width: f64, height: f64) -> (f64, f64) {
  let w = if width.is_finite() {
    width.clamp(COLLAPSED_SIZE.0, MAX_STAGE_WIDTH).ceil()
  } else {
    COLLAPSED_SIZE.0
  };
  let h = if height.is_finite() {
    height.clamp(COLLAPSED_SIZE.1, MAX_STAGE_HEIGHT).ceil()
  } else {
    COLLAPSED_SIZE.1
  };
  (w, h)
}

fn sanitize_composer_height(composer_height: f64, logical_height: f64) -> f64 {
  if !composer_height.is_finite() || composer_height <= 0.0 {
    return 0.0;
  }
  let max_below = (logical_height - COLLAPSED_SIZE.1).max(0.0);
  composer_height.clamp(0.0, max_below).ceil()
}

fn mascot_anchor_in_window(
  window_size: PhysicalSize<u32>,
  dock_side: DockSide,
  panel_side: PanelSide,
  composer_height_phys: i32,
  scale: f64,
) -> PhysicalPosition<i32> {
  let edge_x = (EDGE_ANCHOR_OFFSET_X * scale).round() as i32;
  let edge_y = (DOCK_CENTER_OFFSET_Y * scale).round() as i32;
  let w = window_size.width as i32;
  let h = window_size.height as i32;

  let ax = match dock_side {
    DockSide::Left => edge_x.min(w / 2),
    DockSide::Right => (w - edge_x).max(w / 2),
    DockSide::Center => w / 2,
  };
  let ay = match panel_side {
    PanelSide::Top => (h - edge_y - composer_height_phys.max(0)).clamp(edge_y.min(h / 2), h),
    PanelSide::Bottom => edge_y.min(h / 2),
  };
  PhysicalPosition::new(ax, ay)
}

fn moved_externally(
  actual_pos: PhysicalPosition<i32>,
  expected_pos: Option<PhysicalPosition<i32>>,
) -> bool {
  match expected_pos {
    Some(exp) => (actual_pos.x - exp.x).abs() > 2 || (actual_pos.y - exp.y).abs() > 2,
    None => true,
  }
}

fn preferred_collapsed_dock_side_for_anchor(
  anchor_x: i32,
  area: Option<WorkArea>,
) -> DockSide {
  let Some(area) = area else {
    return DockSide::Right;
  };
  let area_mid_x = area.x + (area.width as i32) / 2;
  if anchor_x < area_mid_x {
    DockSide::Left
  } else {
    DockSide::Right
  }
}

fn collapsed_pos_from_anchor(
  anchor_pos: PhysicalPosition<i32>,
  collapsed_size: PhysicalSize<u32>,
  dock_side: DockSide,
  area: Option<WorkArea>,
  scale: f64,
) -> PhysicalPosition<i32> {
  let collapsed_dock = match dock_side {
    DockSide::Left => DockSide::Left,
    DockSide::Right => DockSide::Right,
    DockSide::Center => preferred_collapsed_dock_side_for_anchor(anchor_pos.x, area),
  };
  let offset = mascot_anchor_in_window(collapsed_size, collapsed_dock, PanelSide::Top, 0, scale);
  let raw = PhysicalPosition::new(anchor_pos.x - offset.x, anchor_pos.y - offset.y);
  area.map_or(raw, |a| clamp_to_area(raw, collapsed_size, a))
}

fn choose_orientation(
  anchor_pos: PhysicalPosition<i32>,
  collapsed_size: PhysicalSize<u32>,
  probe_size: PhysicalSize<u32>,
  area: Option<WorkArea>,
  scale: f64,
) -> (DockSide, PanelSide) {
  let Some(area) = area else {
    return (DockSide::Center, PanelSide::Top);
  };
  let edge_x = (EDGE_ANCHOR_OFFSET_X * scale).round() as i32;
  let edge_y = (DOCK_CENTER_OFFSET_Y * scale).round() as i32;
  let half_probe_w = (probe_size.width as i32 + 1) / 2;
  let extra_h = probe_size.height.saturating_sub(collapsed_size.height) as i32;

  let room_left = anchor_pos.x - area.x;
  let room_right = (area.x + area.width as i32) - anchor_pos.x;
  let room_above = (anchor_pos.y - edge_y) - area.y;
  let room_below = (area.y + area.height as i32) - (anchor_pos.y + edge_y);

  let dock_side = if room_left >= half_probe_w && room_right >= half_probe_w {
    DockSide::Center
  } else if room_left >= probe_size.width as i32 - edge_x && room_right >= edge_x {
    DockSide::Right
  } else if room_right >= probe_size.width as i32 - edge_x && room_left >= edge_x {
    DockSide::Left
  } else if room_left >= room_right {
    DockSide::Right
  } else {
    DockSide::Left
  };

  let panel_side = if room_above >= extra_h {
    PanelSide::Top
  } else if room_below >= extra_h {
    PanelSide::Bottom
  } else if room_above >= room_below {
    PanelSide::Top
  } else {
    PanelSide::Bottom
  };

  (dock_side, panel_side)
}

fn preferred_collapsed_dock_side(
  dock_pos: PhysicalPosition<i32>,
  collapsed_size: PhysicalSize<u32>,
  area: Option<WorkArea>,
) -> DockSide {
  let Some(area) = area else {
    return DockSide::Right;
  };
  let center_x = dock_pos.x + (collapsed_size.width as i32) / 2;
  let area_mid_x = area.x + (area.width as i32) / 2;
  if center_x < area_mid_x {
    DockSide::Left
  } else {
    DockSide::Right
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DynamicResizePlan {
  window_pos: PhysicalPosition<i32>,
  dock_side: DockSide,
  panel_side: PanelSide,
  expanded: bool,
  anchor_pos: PhysicalPosition<i32>,
  collapsed_pos: PhysicalPosition<i32>,
}

/// Plans a dynamic resize while locking the mascot avatar center on screen.
#[allow(clippy::too_many_arguments)]
fn plan_dynamic_resize(
  current_pos: PhysicalPosition<i32>,
  current_size: PhysicalSize<u32>,
  collapsed_size: PhysicalSize<u32>,
  target_size: PhysicalSize<u32>,
  probe_size: PhysicalSize<u32>,
  was_expanded: bool,
  cur_dock: DockSide,
  cur_panel: PanelSide,
  cur_composer_h_phys: i32,
  next_composer_h_phys: i32,
  saved_anchor: Option<PhysicalPosition<i32>>,
  expected_pos: Option<PhysicalPosition<i32>>,
  area: Option<WorkArea>,
  scale: f64,
) -> DynamicResizePlan {
  let raw_anchor = if !moved_externally(current_pos, expected_pos) {
    saved_anchor.unwrap_or_else(|| {
      let offset = mascot_anchor_in_window(current_size, cur_dock, cur_panel, cur_composer_h_phys, scale);
      PhysicalPosition::new(current_pos.x + offset.x, current_pos.y + offset.y)
    })
  } else {
    let offset = mascot_anchor_in_window(current_size, cur_dock, cur_panel, cur_composer_h_phys, scale);
    PhysicalPosition::new(current_pos.x + offset.x, current_pos.y + offset.y)
  };

  let collapsed_dock = preferred_collapsed_dock_side_for_anchor(raw_anchor.x, area);
  let collapsed_pos = collapsed_pos_from_anchor(raw_anchor, collapsed_size, collapsed_dock, area, scale);
  let collapsed_offset = mascot_anchor_in_window(collapsed_size, collapsed_dock, PanelSide::Top, 0, scale);
  let anchor_clamped = PhysicalPosition::new(
    collapsed_pos.x + collapsed_offset.x,
    collapsed_pos.y + collapsed_offset.y,
  );

  let next_expanded = target_size.width > collapsed_size.width + 2
    || target_size.height > collapsed_size.height + 2;

  let (next_dock, next_panel) = if !next_expanded {
    (collapsed_dock, PanelSide::Top)
  } else if !was_expanded {
    choose_orientation(anchor_clamped, collapsed_size, probe_size, area, scale)
  } else {
    (cur_dock, cur_panel)
  };

  let next_pos = if !next_expanded {
    collapsed_pos
  } else {
    let next_offset = mascot_anchor_in_window(
      target_size,
      next_dock,
      next_panel,
      next_composer_h_phys,
      scale,
    );
    let raw = PhysicalPosition::new(
      anchor_clamped.x - next_offset.x,
      anchor_clamped.y - next_offset.y,
    );
    area.map_or(raw, |a| clamp_to_area(raw, target_size, a))
  };

  DynamicResizePlan {
    window_pos: next_pos,
    dock_side: next_dock,
    panel_side: next_panel,
    expanded: next_expanded,
    anchor_pos: anchor_clamped,
    collapsed_pos,
  }
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn scale_hit_rects(
  hit_rects: &[LogicalHitRect],
  window_w: i32,
  window_h: i32,
  scale: f64,
) -> Vec<(RectI, i32)> {
  let mut out = Vec::with_capacity(hit_rects.len());
  for r in hit_rects {
    if !r.x.is_finite() || !r.y.is_finite() || !r.width.is_finite() || !r.height.is_finite() {
      continue;
    }
    if r.width <= 1.0 || r.height <= 1.0 {
      continue;
    }
    let x1 = (r.x * scale).floor() as i32;
    let y1 = (r.y * scale).floor() as i32;
    let x2 = ((r.x + r.width) * scale).ceil() as i32;
    let y2 = ((r.y + r.height) * scale).ceil() as i32;
    let cx1 = x1.clamp(0, window_w.max(1));
    let cy1 = y1.clamp(0, window_h.max(1));
    let cx2 = x2.clamp(cx1, window_w.max(1));
    let cy2 = y2.clamp(cy1, window_h.max(1));
    if cx2 > cx1 && cy2 > cy1 {
      let radius = ((r.radius.max(0) as f64) * scale).round() as i32;
      out.push((
        RectI {
          x: cx1,
          y: cy1,
          width: cx2 - cx1,
          height: cy2 - cy1,
        },
        radius,
      ));
    }
  }
  out
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn rounded_rect_scanlines(rect: RectI, radius: i32) -> Vec<RectI> {
  if rect.width <= 0 || rect.height <= 0 {
    return Vec::new();
  }
  let r = radius.clamp(0, (rect.width / 2).min(rect.height / 2));
  if r == 0 {
    return vec![rect];
  }
  let mut spans = Vec::with_capacity((r as usize) * 2 + 1);
  let rf = r as f64;
  for row in 0..r {
    let dy = rf - (row as f64 + 0.5);
    let dx = (rf * rf - dy * dy).max(0.0).sqrt();
    let inset = (rf - dx).ceil().max(0.0) as i32;
    let span_w = (rect.width - inset * 2).max(1);
    spans.push(RectI { x: rect.x + inset, y: rect.y + row, width: span_w, height: 1 });
    spans.push(RectI { x: rect.x + inset, y: rect.y + rect.height - 1 - row, width: span_w, height: 1 });
  }
  if rect.height > r * 2 {
    spans.push(RectI {
      x: rect.x,
      y: rect.y + r,
      width: rect.width,
      height: rect.height - r * 2,
    });
  }
  spans
}

fn effective_logical_size(
  requested_logical: (f64, f64),
  target_physical: PhysicalSize<u32>,
  area: Option<WorkArea>,
  scale: f64,
) -> (f64, f64) {
  let safe_scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
  let uncapped = LogicalSize::new(requested_logical.0, requested_logical.1)
    .to_physical::<u32>(safe_scale);
  let w = if area.is_some() && target_physical.width < uncapped.width {
    (target_physical.width as f64 / safe_scale).floor().max(1.0)
  } else {
    requested_logical.0.round().max(1.0)
  };
  let h = if area.is_some() && target_physical.height < uncapped.height {
    (target_physical.height as f64 / safe_scale).floor().max(1.0)
  } else {
    requested_logical.1.round().max(1.0)
  };
  (w, h)
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeFocusProbe {
  window_visible: bool,
  window_minimized: bool,
  foreground_matches_window: bool,
  focus_hwnd_present: bool,
  focus_matches_window: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn evaluate_native_window_focus(probe: NativeFocusProbe) -> bool {
  if !probe.window_visible || probe.window_minimized {
    return false;
  }
  if probe.focus_hwnd_present {
    probe.foreground_matches_window && probe.focus_matches_window
  } else {
    probe.foreground_matches_window
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LayoutFocusResolution {
  stored_focused: bool,
  reported_focused: Option<bool>,
}

fn resolve_focus_after_layout(
  prev_focused: bool,
  probed_focused: Option<bool>,
  requested_focus: bool,
) -> LayoutFocusResolution {
  match (requested_focus, probed_focused) {
    (_, Some(true)) => LayoutFocusResolution {
      stored_focused: true,
      reported_focused: Some(true),
    },
    (true, Some(false) | None) => LayoutFocusResolution {
      stored_focused: prev_focused,
      reported_focused: if prev_focused { Some(true) } else { None },
    },
    (false, Some(false)) => LayoutFocusResolution {
      stored_focused: false,
      reported_focused: Some(false),
    },
    (false, None) => LayoutFocusResolution {
      stored_focused: prev_focused,
      reported_focused: Some(prev_focused),
    },
  }
}

fn resolve_focus_on_query(prev_focused: bool, probed_focused: Option<bool>) -> bool {
  probed_focused.unwrap_or(prev_focused)
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PostRegionAction {
  KeepCleared,
  Clear { redraw: bool },
  ApplyRects,
}

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WindowsLayoutCommitPlan {
  clear_region_before_pos: bool,
  run_set_window_pos: bool,
  move_window: bool,
  resize_window: bool,
  x: i32,
  y: i32,
  width: i32,
  height: i32,
  post_region: PostRegionAction,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn plan_windows_layout_commit(
  current_pos: Option<PhysicalPosition<i32>>,
  current_outer_size: PhysicalSize<u32>,
  target_pos: PhysicalPosition<i32>,
  target_outer_size: PhysicalSize<u32>,
  has_region_rects: bool,
) -> WindowsLayoutCommitPlan {
  let pos_changed = current_pos != Some(target_pos);
  let size_changed = current_outer_size != target_outer_size;
  let run_set_window_pos = pos_changed || size_changed;
  // Clear any stale window region before SetWindowPos whenever dimensions change
  // (growing OR shrinking) with bRedraw=FALSE so no intermediate frame clips against old bounds.
  let clear_region_before_pos = size_changed;
  let post_region = if has_region_rects {
    PostRegionAction::ApplyRects
  } else if clear_region_before_pos && run_set_window_pos {
    PostRegionAction::KeepCleared
  } else {
    PostRegionAction::Clear { redraw: true }
  };
  WindowsLayoutCommitPlan {
    clear_region_before_pos,
    run_set_window_pos,
    move_window: pos_changed,
    resize_window: size_changed,
    x: target_pos.x,
    y: target_pos.y,
    width: target_outer_size.width as i32,
    height: target_outer_size.height as i32,
    post_region,
  }
}

fn select_monitor_index_for_position(
  monitors: &[(WorkArea, WorkArea)],
  pos: PhysicalPosition<i32>,
) -> Option<usize> {
  monitors
    .iter()
    .position(|(work, _)| work.contains(pos))
    .or_else(|| monitors.iter().position(|(_, bounds)| bounds.contains(pos)))
}

fn window_monitor(window: &WebviewWindow) -> Option<Monitor> {
  window
    .current_monitor()
    .ok()
    .flatten()
    .or_else(|| window.primary_monitor().ok().flatten())
}

fn monitor_of_window(window: &tauri::Window) -> Option<Monitor> {
  window
    .current_monitor()
    .ok()
    .flatten()
    .or_else(|| window.primary_monitor().ok().flatten())
}

fn monitor_for_position(window: &WebviewWindow, pos: PhysicalPosition<i32>) -> Option<Monitor> {
  window
    .available_monitors()
    .ok()
    .and_then(|monitors| {
      let rects: Vec<(WorkArea, WorkArea)> = monitors
        .iter()
        .map(|m| (WorkArea::from_monitor(m), WorkArea::from_monitor_bounds(m)))
        .collect();
      select_monitor_index_for_position(&rects, pos).and_then(|idx| monitors.into_iter().nth(idx))
    })
    .or_else(|| window_monitor(window))
}

fn resolve_scale_factor(monitor: Option<&Monitor>, window: &WebviewWindow) -> Option<f64> {
  monitor
    .map(Monitor::scale_factor)
    .filter(|s| s.is_finite() && *s > 0.0)
    .or_else(|| {
      window
        .scale_factor()
        .ok()
        .filter(|s| s.is_finite() && *s > 0.0)
    })
}

#[cfg(windows)]
unsafe fn hwnd_matches_window(
  root: windows_sys::Win32::Foundation::HWND,
  candidate: windows_sys::Win32::Foundation::HWND,
  include_owned: bool,
) -> bool {
  use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, IsChild, GA_ROOT, GA_ROOTOWNER};
  if root.is_null() || candidate.is_null() {
    return false;
  }
  if candidate == root || IsChild(root, candidate) != 0 {
    return true;
  }
  if GetAncestor(candidate, GA_ROOT) == root {
    return true;
  }
  include_owned && GetAncestor(candidate, GA_ROOTOWNER) == root
}

#[cfg(windows)]
fn query_hwnd_focused(hwnd_raw: isize) -> bool {
  use windows_sys::Win32::Foundation::HWND;
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetGUIThreadInfo, IsIconic, IsWindowVisible, GUITHREADINFO,
  };
  if hwnd_raw == 0 {
    return false;
  }
  let hwnd = hwnd_raw as HWND;
  unsafe {
    let window_visible = IsWindowVisible(hwnd) != 0;
    let window_minimized = IsIconic(hwnd) != 0;
    let fg = GetForegroundWindow();
    let foreground_matches_window = hwnd_matches_window(hwnd, fg, false);
    let mut gti: GUITHREADINFO = std::mem::zeroed();
    gti.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    let (focus_hwnd_present, focus_matches_window) =
      if GetGUIThreadInfo(0, &mut gti) != 0 && !gti.hwndFocus.is_null() {
        (true, hwnd_matches_window(hwnd, gti.hwndFocus, true))
      } else {
        (false, false)
      };
    evaluate_native_window_focus(NativeFocusProbe {
      window_visible,
      window_minimized,
      foreground_matches_window,
      focus_hwnd_present,
      focus_matches_window,
    })
  }
}

#[cfg(windows)]
fn query_hwnd_has_child_focus(hwnd_raw: isize) -> bool {
  use windows_sys::Win32::Foundation::HWND;
  use windows_sys::Win32::UI::WindowsAndMessaging::{GetGUIThreadInfo, GUITHREADINFO};
  if hwnd_raw == 0 {
    return false;
  }
  let hwnd = hwnd_raw as HWND;
  unsafe {
    let mut gti: GUITHREADINFO = std::mem::zeroed();
    gti.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
    GetGUIThreadInfo(0, &mut gti) != 0
      && !gti.hwndFocus.is_null()
      && gti.hwndFocus != hwnd
      && hwnd_matches_window(hwnd, gti.hwndFocus, true)
  }
}

fn query_window_focused(window: &WebviewWindow) -> Option<bool> {
  #[cfg(windows)]
  {
    window.hwnd().ok().map(|raw| query_hwnd_focused(raw.0 as isize))
  }
  #[cfg(not(windows))]
  {
    window.is_focused().ok()
  }
}

#[cfg(windows)]
unsafe fn set_hwnd_region(
  hwnd: windows_sys::Win32::Foundation::HWND,
  rects: &[RectI],
  redraw: bool,
) {
  use windows_sys::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
  };
  let redraw_flag = i32::from(redraw);
  if rects.is_empty() {
    SetWindowRgn(hwnd, std::ptr::null_mut(), redraw_flag);
    return;
  }
  let combined = CreateRectRgn(0, 0, 0, 0);
  if combined.is_null() {
    return;
  }
  for r in rects {
    let part = CreateRectRgn(r.x, r.y, r.x + r.width, r.y + r.height);
    if !part.is_null() {
      CombineRgn(combined, combined, part, RGN_OR);
      DeleteObject(part);
    }
  }
  // Windows takes ownership of `combined` on success.
  if SetWindowRgn(hwnd, combined, redraw_flag) == 0 {
    DeleteObject(combined);
  }
}

#[cfg(windows)]
unsafe fn measure_hwnd_geometry(
  hwnd: windows_sys::Win32::Foundation::HWND,
) -> (Option<PhysicalPosition<i32>>, Option<PhysicalSize<u32>>, (u32, u32)) {
  use windows_sys::Win32::Foundation::RECT;
  use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};
  let mut win_rect: RECT = std::mem::zeroed();
  let mut cli_rect: RECT = std::mem::zeroed();
  let has_win = GetWindowRect(hwnd, &mut win_rect) != 0;
  let has_cli = GetClientRect(hwnd, &mut cli_rect) != 0;
  let pos = has_win.then(|| PhysicalPosition::new(win_rect.left, win_rect.top));
  let outer = has_win.then(|| {
    PhysicalSize::new(
      (win_rect.right - win_rect.left).max(0) as u32,
      (win_rect.bottom - win_rect.top).max(0) as u32,
    )
  });
  let frame = if has_win && has_cli {
    let ww = (win_rect.right - win_rect.left).max(0) as u32;
    let wh = (win_rect.bottom - win_rect.top).max(0) as u32;
    let cw = (cli_rect.right - cli_rect.left).max(0) as u32;
    let ch = (cli_rect.bottom - cli_rect.top).max(0) as u32;
    (ww.saturating_sub(cw), wh.saturating_sub(ch))
  } else {
    (0, 0)
  };
  (pos, outer, frame)
}

#[cfg(windows)]
async fn sync_windows_webview_after_layout(
  window: &WebviewWindow,
  hwnd_raw: isize,
  moved: bool,
  focus: bool,
) -> Option<bool> {
  if !moved && !focus {
    return Some(query_hwnd_focused(hwnd_raw));
  }
  let (tx, rx) = tokio::sync::oneshot::channel();
  let scheduled = window.with_webview(move |platform_webview| {
    let controller = platform_webview.controller();
    unsafe {
      if moved {
        let _ = controller.NotifyParentWindowPositionChanged();
      }
      if focus && !query_hwnd_has_child_focus(hwnd_raw) {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
        let _ = controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      }
    }
    let _ = tx.send(query_hwnd_focused(hwnd_raw));
  });
  if scheduled.is_err() {
    return Some(query_hwnd_focused(hwnd_raw));
  }
  rx.await.ok().or_else(|| Some(query_hwnd_focused(hwnd_raw)))
}

#[cfg(windows)]
async fn apply_windows_layout_atomic(
  window: &WebviewWindow,
  target_pos: PhysicalPosition<i32>,
  target_size: PhysicalSize<u32>,
  scale: f64,
  hit_rects: Vec<LogicalHitRect>,
  focus: bool,
) -> Result<Option<bool>, BridgeError> {
  let hwnd_raw = window
    .hwnd()
    .map_err(|_| native_error("Could not read desktop pet handle"))?
    .0 as isize;
  let (tx, rx) = tokio::sync::oneshot::channel();
  window
    .run_on_main_thread(move || {
      use windows_sys::Win32::Foundation::HWND;
      use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, SetForegroundWindow, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
      };
      let hwnd = hwnd_raw as HWND;
      let outcome = unsafe {
        let (cur_pos, cur_outer, (frame_w, frame_h)) = measure_hwnd_geometry(hwnd);
        let target_outer = PhysicalSize::new(
          target_size.width.saturating_add(frame_w),
          target_size.height.saturating_add(frame_h),
        );
        let commit = plan_windows_layout_commit(
          cur_pos,
          cur_outer.unwrap_or(target_outer),
          target_pos,
          target_outer,
          !hit_rects.is_empty(),
        );

        if commit.clear_region_before_pos {
          set_hwnd_region(hwnd, &[], false);
        }

        let pos_ok = if commit.run_set_window_pos {
          let mut flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
          if !commit.move_window {
            flags |= SWP_NOMOVE;
          }
          if !commit.resize_window {
            flags |= SWP_NOSIZE;
          }
          // Synchronous atomic move+resize (no SWP_ASYNCWINDOWPOS) so DWM commits both together.
          SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            commit.x,
            commit.y,
            commit.width,
            commit.height,
            flags,
          ) != 0
        } else {
          true
        };

        let (_, actual_outer, _) = measure_hwnd_geometry(hwnd);
        let final_size = actual_outer.unwrap_or(target_outer);
        match commit.post_region {
          PostRegionAction::ApplyRects => {
            let rects: Vec<RectI> = scale_hit_rects(
              &hit_rects,
              final_size.width as i32,
              final_size.height as i32,
              scale,
            )
            .into_iter()
            .map(|(r, _)| r)
            .collect();
            set_hwnd_region(hwnd, &rects, true);
          }
          PostRegionAction::Clear { redraw } => {
            set_hwnd_region(hwnd, &[], redraw);
          }
          PostRegionAction::KeepCleared => {}
        }

        if focus {
          let fg = GetForegroundWindow();
          if !hwnd_matches_window(hwnd, fg, false) {
            let _ = SetForegroundWindow(hwnd);
          }
        }

        (pos_ok, commit.move_window, query_hwnd_focused(hwnd_raw))
      };
      let _ = tx.send(outcome);
    })
    .map_err(|_| native_error("Could not schedule desktop pet layout update"))?;

  let (pos_ok, moved, focused_after_pos) = rx
    .await
    .map_err(|_| native_error("Desktop pet layout update was cancelled"))?;
  if !pos_ok {
    return Err(native_error("Could not resize desktop pet"));
  }
  if focus && !focused_after_pos {
    let _ = window.set_focus();
  }
  Ok(sync_windows_webview_after_layout(window, hwnd_raw, moved, focus).await)
}

#[cfg(windows)]
async fn position_windows_pet_on_create(
  window: &WebviewWindow,
  target_pos: PhysicalPosition<i32>,
  target_size: PhysicalSize<u32>,
) {
  let Ok(hwnd_raw) = window.hwnd().map(|h| h.0 as isize) else { return };
  let (tx, rx) = tokio::sync::oneshot::channel();
  let scheduled = window.run_on_main_thread(move || {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
      SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };
    let hwnd = hwnd_raw as HWND;
    unsafe {
      let (_, _, (frame_w, frame_h)) = measure_hwnd_geometry(hwnd);
      let outer_w = target_size.width.saturating_add(frame_w) as i32;
      let outer_h = target_size.height.saturating_add(frame_h) as i32;
      let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
      set_hwnd_region(hwnd, &[], false);
      let _ = SetWindowPos(
        hwnd,
        std::ptr::null_mut(),
        target_pos.x,
        target_pos.y,
        outer_w,
        outer_h,
        flags,
      );
      // Crossing into a different-DPI monitor can trigger WM_DPICHANGED and rescale the rect;
      // enforce exact target bounds once the HWND resides on the destination monitor.
      let (actual_pos, actual_outer, (frame_w2, frame_h2)) = measure_hwnd_geometry(hwnd);
      let expected_outer = PhysicalSize::new(
        target_size.width.saturating_add(frame_w2),
        target_size.height.saturating_add(frame_h2),
      );
      if actual_pos != Some(target_pos) || actual_outer != Some(expected_outer) {
        let _ = SetWindowPos(
          hwnd,
          std::ptr::null_mut(),
          target_pos.x,
          target_pos.y,
          expected_outer.width as i32,
          expected_outer.height as i32,
          flags,
        );
      }
    }
    let _ = tx.send(());
  });
  if scheduled.is_ok() {
    let _ = rx.await;
  }
  let _ = sync_windows_webview_after_layout(window, hwnd_raw, true, false).await;
}

#[cfg(windows)]
async fn move_windows_pet_atomic(window: &WebviewWindow, target_pos: PhysicalPosition<i32>) {
  let Ok(hwnd_raw) = window.hwnd().map(|h| h.0 as isize) else { return };
  let (tx, rx) = tokio::sync::oneshot::channel();
  let scheduled = window.run_on_main_thread(move || {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
      SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
    };
    let hwnd = hwnd_raw as HWND;
    unsafe {
      let _ = SetWindowPos(
        hwnd,
        std::ptr::null_mut(),
        target_pos.x,
        target_pos.y,
        0,
        0,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSIZE,
      );
    }
    let _ = tx.send(());
  });
  if scheduled.is_ok() {
    let _ = rx.await;
  }
  let _ = sync_windows_webview_after_layout(window, hwnd_raw, true, false).await;
}

fn detect_composited(window: &WebviewWindow) -> bool {
  #[cfg(target_os = "linux")]
  {
    use gtk::prelude::WidgetExt;
    if let Ok(gtk_win) = window.gtk_window() {
      return gtk_win.screen().is_some_and(|screen| screen.is_composited());
    }
  }
  #[cfg(not(target_os = "linux"))]
  let _ = window;
  true
}

fn apply_window_region(
  window: &WebviewWindow,
  hit_rects: &[LogicalHitRect],
  composited: bool,
) {
  #[cfg(windows)]
  {
    let _ = composited;
    let Ok(hwnd_raw) = window.hwnd().map(|h| h.0 as isize) else { return };
    let monitor = window_monitor(window);
    let scale = resolve_scale_factor(monitor.as_ref(), window).unwrap_or(1.0);
    let hit_rects = hit_rects.to_vec();
    let _ = window.run_on_main_thread(move || unsafe {
      let hwnd = hwnd_raw as windows_sys::Win32::Foundation::HWND;
      if hit_rects.is_empty() {
        set_hwnd_region(hwnd, &[], true);
        return;
      }
      let (_, Some(size), _) = measure_hwnd_geometry(hwnd) else {
        set_hwnd_region(hwnd, &[], true);
        return;
      };
      let rects: Vec<RectI> =
        scale_hit_rects(&hit_rects, size.width as i32, size.height as i32, scale)
          .into_iter()
          .map(|(r, _)| r)
          .collect();
      set_hwnd_region(hwnd, &rects, true);
    });
  }

  #[cfg(target_os = "linux")]
  {
    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
    let (logical_w, logical_h) = window
      .outer_size()
      .map(|s| ((s.width as f64 / scale).round() as i32, (s.height as f64 / scale).round() as i32))
      .unwrap_or((COLLAPSED_SIZE.0 as i32, COLLAPSED_SIZE.1 as i32));
    let mut rects = scale_hit_rects(hit_rects, logical_w, logical_h, 1.0);
    if !composited && rects.is_empty() {
      let pad = STAGE_PADDING as i32;
      rects.push((
        RectI {
          x: pad,
          y: pad,
          width: (logical_w - pad * 2).max(1),
          height: (logical_h - pad * 2).max(1),
        },
        DOCK_RADIUS,
      ));
    }
    let win_clone = window.clone();
    let _ = window.run_on_main_thread(move || {
      use gtk::cairo::{RectangleInt, Region};
      use gtk::prelude::WidgetExt;
      let Ok(gtk_win) = win_clone.gtk_window() else { return };
      if !composited {
        let shape = Region::create();
        for (rect, radius) in rects {
          for span in rounded_rect_scanlines(rect, radius) {
            let _ = shape.union_rectangle(&RectangleInt::new(span.x, span.y, span.width, span.height));
          }
        }
        gtk_win.shape_combine_region(Some(&shape));
        gtk_win.input_shape_combine_region(Some(&shape));
      } else if !rects.is_empty() {
        let input = Region::create();
        for (rect, _) in rects {
          let _ = input.union_rectangle(&RectangleInt::new(rect.x, rect.y, rect.width, rect.height));
        }
        gtk_win.shape_combine_region(None);
        gtk_win.input_shape_combine_region(Some(&input));
      } else {
        gtk_win.shape_combine_region(None);
        gtk_win.input_shape_combine_region(None);
      }
    });
  }

  #[cfg(not(any(windows, target_os = "linux")))]
  {
    let _ = (window, hit_rects, composited);
  }
}

#[cfg(target_os = "linux")]
fn release_linux_webview_pointer_press(window: &WebviewWindow) {
  let _ = window.with_webview(|platform_webview| {
    use gtk::gdk;
    use gtk::gdk::prelude::SeatExt;
    use gtk::glib::translate::{ToGlibPtr, ToGlibPtrMut};
    use gtk::prelude::WidgetExt;
    let wv = platform_webview.inner();
    let Some(gdk_win) = wv.window() else { return };
    let mut ev = gdk::Event::new(gdk::EventType::ButtonRelease);
    if let Some(pointer) = gdk_win.display().default_seat().and_then(|s| s.pointer()) {
      ev.set_device(Some(&pointer));
    }
    unsafe {
      let raw: *mut gdk::ffi::GdkEvent = ev.to_glib_none_mut().0;
      let ptr = raw as *mut gdk::ffi::GdkEventButton;
      if !ptr.is_null() {
        (*ptr).window = gdk_win.to_glib_full();
        (*ptr).send_event = 1;
        (*ptr).time = gdk::ffi::GDK_CURRENT_TIME as u32;
        (*ptr).x = -1.0;
        (*ptr).y = -1.0;
        (*ptr).x_root = -1.0;
        (*ptr).y_root = -1.0;
        (*ptr).button = 1;
      }
    }
    let _ = wv.event(&ev);
  });
}

#[cfg(not(target_os = "linux"))]
fn release_linux_webview_pointer_press(_window: &WebviewWindow) {}

#[cfg(target_os = "linux")]
fn reapply_linux_window_hints(window: &WebviewWindow) {
  // Re-assert X11/EWMH hints after map so WMs that drop pre-map hints on hidden windows
  // still keep the pet above other windows and out of the taskbar/pager.
  let _ = window.set_always_on_top(true);
  let _ = window.set_skip_taskbar(true);
}

#[cfg(not(target_os = "linux"))]
fn reapply_linux_window_hints(_window: &WebviewWindow) {}

#[cfg(target_os = "linux")]
fn apply_linux_size_lock(window: &WebviewWindow, size: Option<PhysicalSize<u32>>) {
  let _ = window.set_min_size(size);
  let _ = window.set_max_size(size);
}

#[cfg(all(not(target_os = "linux"), not(windows)))]
fn apply_linux_size_lock(_window: &WebviewWindow, _size: Option<PhysicalSize<u32>>) {}

async fn apply_layout(
  app: &AppHandle,
  window: &WebviewWindow,
  request: PetWindowLayoutRequest,
) -> Result<Option<bool>, BridgeError> {
  let pet = app.state::<DesktopPet>();
  let monitor = window_monitor(window);
  let scale = resolve_scale_factor(monitor.as_ref(), window)
    .ok_or_else(|| native_error("Could not read pet window scale"))?;
  let area = monitor.as_ref().map(WorkArea::from_monitor);
  let collapsed_size = cap_size(
    LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let (logical_w, logical_h) = sanitize_logical_size(request.width, request.height);
  let composer_h_logical = sanitize_composer_height(request.composer_height, logical_h);
  let next_composer_h_phys = (composer_h_logical * scale).round() as i32;
  let target_size = cap_size(
    LogicalSize::new(logical_w, logical_h).to_physical::<u32>(scale),
    area,
  );
  let applied_logical = effective_logical_size((logical_w, logical_h), target_size, area, scale);
  let probe_size = cap_size(
    LogicalSize::new(
      logical_w.max(ORIENTATION_PROBE_SIZE.0),
      logical_h.max(ORIENTATION_PROBE_SIZE.1),
    )
    .to_physical::<u32>(scale),
    area,
  );
  let composited = detect_composited(window);
  let current_size = window.outer_size().unwrap_or(collapsed_size);
  let old_position = window.outer_position().ok();
  let was_expanded = pet.expanded.load(Ordering::Acquire);

  let (plan, size_changed, pos_changed) = {
    let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.composited = composited;
    geo.hit_rects = request.hit_rects.clone();
    let cur_pos = old_position
      .or(geo.last_collapsed_pos)
      .unwrap_or_else(|| PhysicalPosition::new(0, 0));
    let cur_composer_h_phys = (geo.current_composer_height * scale).round() as i32;
    let plan = plan_dynamic_resize(
      cur_pos,
      current_size,
      collapsed_size,
      target_size,
      probe_size,
      was_expanded,
      geo.dock_side,
      geo.panel_side,
      cur_composer_h_phys,
      next_composer_h_phys,
      geo.anchor_pos,
      geo.expected_window_pos,
      area,
      scale,
    );
    let size_changed = current_size.width.abs_diff(target_size.width) > 1
      || current_size.height.abs_diff(target_size.height) > 1
      || plan.dock_side != geo.dock_side
      || plan.panel_side != geo.panel_side;
    let pos_changed = old_position != Some(plan.window_pos);
    geo.dock_side = plan.dock_side;
    geo.panel_side = plan.panel_side;
    geo.anchor_pos = Some(plan.anchor_pos);
    geo.last_collapsed_pos = Some(plan.collapsed_pos);
    geo.expected_window_pos = Some(plan.window_pos);
    geo.current_logical_size = applied_logical;
    geo.current_composer_height = composer_h_logical;
    (plan, size_changed, pos_changed)
  };

  pet.expanded.store(plan.expanded, Ordering::Release);

  let probed_focused = {
    let _guard = pet.begin_layout_apply();
    #[cfg(windows)]
    {
      let _ = (size_changed, pos_changed);
      apply_windows_layout_atomic(
        window,
        plan.window_pos,
        target_size,
        scale,
        request.hit_rects,
        request.focus,
      )
      .await?
    }
    #[cfg(not(windows))]
    {
      if size_changed {
        let growing =
          target_size.width > current_size.width || target_size.height > current_size.height;
        apply_linux_size_lock(window, None);
        if growing && pos_changed {
          let _ = window.set_position(plan.window_pos);
        }
        window
          .set_size(target_size)
          .map_err(|_| native_error("Could not resize desktop pet"))?;
        apply_linux_size_lock(window, Some(target_size));
        if !growing && pos_changed {
          let _ = window.set_position(plan.window_pos);
        } else if growing && window.outer_position().ok() != Some(plan.window_pos) {
          let _ = window.set_position(plan.window_pos);
        }
      } else if pos_changed {
        let _ = window.set_position(plan.window_pos);
      }

      apply_window_region(window, &request.hit_rects, composited);
      if request.focus {
        let _ = window.set_focus();
      }
      query_window_focused(window)
    }
  };

  let prev_focused = pet.focused.load(Ordering::Acquire);
  let focus_resolution = resolve_focus_after_layout(prev_focused, probed_focused, request.focus);
  pet.focused.store(focus_resolution.stored_focused, Ordering::Release);
  Ok(focus_resolution.reported_focused)
}

async fn create(app: &AppHandle) -> Result<WebviewWindow, BridgeError> {
  // Ensure KDE Plasma has the KWin window rule loaded before creating the pet window so
  // native Wayland (and KDE X11) apply keep-above and skip-taskbar immediately on map.
  crate::kde_window_rule::ensure_auto_configured(app).await;
  let window = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("index.html?view=pet".into()))
    // desktop-pet.kwinrule matches "PiBot" exactly; the main window is "Pi Bot".
    .title("PiBot")
    .inner_size(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    // Tao/GTK forces non-resizable windows to at least 200px (tao#561).
    .resizable(cfg!(target_os = "linux"))
    .maximizable(false)
    .minimizable(false)
    // Keep focusability from creation: some Linux window managers ignore later changes.
    .focusable(true)
    .focused(false)
    .visible(false)
    .no_redirection_bitmap(true)
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .on_permission_request(|view, kind| {
      if kind == PermissionKind::Microphone && view.url().is_ok_and(|url| permits(&url)) {
        PermissionResponse::Allow
      } else {
        PermissionResponse::Default
      }
    })
    .build()
    .map_err(|_| native_error("Could not create desktop pet"))?;

  let pet = app.state::<DesktopPet>();
  let saved_pos = pet.geometry.lock().unwrap_or_else(|e| e.into_inner()).last_collapsed_pos;
  let monitor = saved_pos
    .and_then(|pos| monitor_for_position(&window, pos))
    .or_else(|| app.get_window("main").and_then(|main| monitor_of_window(&main)))
    .or_else(|| window_monitor(&window));

  let composited = detect_composited(&window);
  let mut initial_pos = saved_pos;
  let mut initial_anchor = None;
  let mut initial_dock = DockSide::Right;
  let mut initial_logical = COLLAPSED_SIZE;
  if let Some(monitor) = monitor {
    let area = monitor.work_area();
    let work = WorkArea::from_monitor(&monitor);
    let scale = monitor.scale_factor();
    let size = cap_size(
      LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
      Some(work),
    );
    initial_logical = effective_logical_size(COLLAPSED_SIZE, size, Some(work), scale);
    let target = saved_pos.unwrap_or_else(|| {
      let margin = (16.0 * scale).round() as i32;
      PhysicalPosition::new(
        area.position.x + area.size.width as i32 - size.width as i32 - margin,
        area.position.y + area.size.height as i32 - size.height as i32 - margin,
      )
    });
    let clamped = clamp_position(target, size, &monitor);
    initial_pos = Some(clamped);
    initial_dock = preferred_collapsed_dock_side(clamped, size, Some(work));
    let offset = mascot_anchor_in_window(size, initial_dock, PanelSide::Top, 0, scale);
    initial_anchor = Some(PhysicalPosition::new(clamped.x + offset.x, clamped.y + offset.y));
    let _guard = pet.begin_layout_apply();
    #[cfg(windows)]
    {
      position_windows_pet_on_create(&window, clamped, size).await;
    }
    #[cfg(not(windows))]
    {
      apply_linux_size_lock(&window, None);
      let _ = window.set_size(size);
      apply_linux_size_lock(&window, Some(size));
      let _ = window.set_position(clamped);
    }
  }

  {
    let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.dock_side = initial_dock;
    geo.panel_side = PanelSide::Top;
    geo.composited = composited;
    geo.current_logical_size = initial_logical;
    geo.current_composer_height = 0.0;
    geo.anchor_pos = initial_anchor;
    geo.expected_window_pos = initial_pos;
    geo.hit_rects.clear();
    if let Some(pos) = initial_pos {
      geo.last_collapsed_pos = Some(pos);
    }
  }
  pet.revealed.store(false, Ordering::Release);
  pet.focused.store(false, Ordering::Release);
  apply_window_region(&window, &[], composited);
  Ok(window)
}

fn snapshot_collapsed_pos_before_hide(app: &AppHandle, window: &WebviewWindow) {
  let pet = app.state::<DesktopPet>();
  let (Ok(pos), Ok(cur_size)) = (window.outer_position(), window.outer_size()) else { return };
  let monitor = window_monitor(window);
  let scale = resolve_scale_factor(monitor.as_ref(), window).unwrap_or(1.0);
  let area = monitor.as_ref().map(WorkArea::from_monitor);
  let collapsed_size = cap_size(
    LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
  let anchor = if !moved_externally(pos, geo.expected_window_pos) {
    geo.anchor_pos.unwrap_or_else(|| {
      let composer_h_phys = (geo.current_composer_height * scale).round() as i32;
      let offset = mascot_anchor_in_window(cur_size, geo.dock_side, geo.panel_side, composer_h_phys, scale);
      PhysicalPosition::new(pos.x + offset.x, pos.y + offset.y)
    })
  } else {
    let composer_h_phys = (geo.current_composer_height * scale).round() as i32;
    let offset = mascot_anchor_in_window(cur_size, geo.dock_side, geo.panel_side, composer_h_phys, scale);
    PhysicalPosition::new(pos.x + offset.x, pos.y + offset.y)
  };
  let collapsed_dock = preferred_collapsed_dock_side_for_anchor(anchor.x, area);
  let saved = collapsed_pos_from_anchor(anchor, collapsed_size, collapsed_dock, area, scale);
  geo.last_collapsed_pos = Some(saved);
  geo.anchor_pos = None;
  geo.expected_window_pos = None;
  geo.dock_side = collapsed_dock;
  geo.panel_side = PanelSide::Top;
  geo.current_logical_size = COLLAPSED_SIZE;
  geo.current_composer_height = 0.0;
  geo.hit_rects.clear();
}

/// Restores saved position and re-opens the pet if it was enabled before exit.
pub fn restore_if_enabled(app: &AppHandle) {
  let saved = load_persisted_state(app);
  if let (Some(x), Some(y)) = (saved.x, saved.y) {
    let pet = app.state::<DesktopPet>();
    let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.last_collapsed_pos = Some(PhysicalPosition::new(x, y));
  }
  if saved.visible {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
      let _ = control(&app, "show", None).await;
    });
  }
}

/// Tears down the pet window during application exit without clearing the saved visibility preference.
pub async fn shutdown(app: &AppHandle) {
  let pet = app.state::<DesktopPet>();
  let _operation = pet.operation.lock().await;
  let was_visible = pet.visible.load(Ordering::Acquire);
  let was_revealed = pet.revealed.load(Ordering::Acquire);
  let destroyed = pet.destroyed.notified();
  tokio::pin!(destroyed);
  destroyed.as_mut().enable();
  if let Some(window) = app.get_webview_window(PET_LABEL) {
    if should_track_native_geometry(PetRevealState {
      visible: was_visible,
      revealed: was_revealed,
    }) {
      snapshot_collapsed_pos_before_hide(app, &window);
    }
    if was_visible {
      save_current_preference(app, true);
    }
    if window.destroy().is_ok() {
      let _ = tokio::time::timeout(Duration::from_secs(2), destroyed).await;
    }
  }
  pet.visible.store(false, Ordering::Release);
  pet.revealed.store(false, Ordering::Release);
  pet.expanded.store(false, Ordering::Release);
}

/// Public control helper used by tray & app lifecycle.
pub async fn control(
  app: &AppHandle,
  action: &str,
  expanded: Option<bool>,
) -> Result<DesktopPetWindowState, BridgeError> {
  control_with_layout(app, action, expanded, None).await
}

/// All mutations share one short operation lock; window creation runs off the UI event callback.
pub async fn control_with_layout(
  app: &AppHandle,
  action: &str,
  expanded: Option<bool>,
  layout: Option<PetWindowLayoutRequest>,
) -> Result<DesktopPetWindowState, BridgeError> {
  let pet = app.state::<DesktopPet>();
  let _operation = pet.operation.lock().await;
  let action = if action == "toggle" {
    if pet.visible.load(Ordering::Acquire) { "hide" } else { "show" }
  } else {
    action
  };
  let mut focus_override: Option<Option<bool>> = None;
  match action {
    "show" => {
      let existed = app.get_webview_window(PET_LABEL).is_some();
      let window = match app.get_webview_window(PET_LABEL) {
        Some(window) => window,
        None => create(app).await?,
      };
      if should_show_window_on_show_action(existed, pet.revealed.load(Ordering::Acquire)) {
        window
          .show()
          .map_err(|_| native_error("Could not show desktop pet"))?;
        reapply_linux_window_hints(&window);
        let (hit_rects, composited) = {
          let composited = detect_composited(&window);
          let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          geo.composited = composited;
          (geo.hit_rects.clone(), composited)
        };
        apply_window_region(&window, &hit_rects, composited);
        let focused = resolve_focus_on_query(
          pet.focused.load(Ordering::Acquire),
          query_window_focused(&window),
        );
        pet.focused.store(focused, Ordering::Release);
      }
      pet.visible.store(true, Ordering::Release);
      save_current_preference(app, true);
    }
    "reveal" => {
      let reveal_state = PetRevealState {
        visible: pet.visible.load(Ordering::Acquire),
        revealed: pet.revealed.load(Ordering::Acquire),
      };
      if !reveal_state.visible {
        return Ok(state(app));
      }
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        if should_show_window_on_reveal_action(reveal_state) {
          window
            .show()
            .map_err(|_| native_error("Could not show desktop pet"))?;
          reapply_linux_window_hints(&window);
          pet.revealed.store(true, Ordering::Release);
          let (hit_rects, composited) = {
            let composited = detect_composited(&window);
            let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
            geo.composited = composited;
            (geo.hit_rects.clone(), composited)
          };
          apply_window_region(&window, &hit_rects, composited);
          let focused = resolve_focus_on_query(
            pet.focused.load(Ordering::Acquire),
            query_window_focused(&window),
          );
          pet.focused.store(focused, Ordering::Release);
        }
      }
    }
    "hide" => {
      // destroy() only queues the native operation. Keep show/hide serialized until
      // Destroyed has removed the old label, so a quick reopen creates a new window.
      let destroyed = pet.destroyed.notified();
      tokio::pin!(destroyed);
      destroyed.as_mut().enable();
      let was_visible = pet.visible.load(Ordering::Acquire);
      let was_revealed = pet.revealed.load(Ordering::Acquire);
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        if should_track_native_geometry(PetRevealState {
          visible: was_visible,
          revealed: was_revealed,
        }) {
          snapshot_collapsed_pos_before_hide(app, &window);
        }
        window
          .destroy()
          .map_err(|_| native_error("Could not close desktop pet"))?;
        destroyed.await;
      }
      pet.visible.store(false, Ordering::Release);
      pet.revealed.store(false, Ordering::Release);
      pet.expanded.store(false, Ordering::Release);
      pet.focused.store(false, Ordering::Release);
      save_current_preference(app, false);
    }
    "set-expanded" => {
      let expanded = expanded.ok_or_else(|| {
        BridgeError::new("INVALID_ARGUMENT", "expanded is required", "not-sent")
      })?;
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        let (width, height) = if expanded { EXPANDED_SIZE } else { COLLAPSED_SIZE };
        let reported_focused = apply_layout(
          app,
          &window,
          PetWindowLayoutRequest {
            width,
            height,
            composer_height: 0.0,
            focus: expanded,
            hit_rects: Vec::new(),
          },
        )
        .await?;
        focus_override = Some(reported_focused);
      }
    }
    "set-layout" => {
      let req = layout.ok_or_else(|| {
        BridgeError::new("INVALID_ARGUMENT", "layout is required", "not-sent")
      })?;
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        let reported_focused = apply_layout(app, &window, req).await?;
        focus_override = Some(reported_focused);
      }
    }
    "show-main" => crate::show_main_window(app),
    "drag" => {
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        window
          .start_dragging()
          .map_err(|_| native_error("Could not drag desktop pet"))?;
        release_linux_webview_pointer_press(&window);
      }
    }
    "status" => {
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        let composited = detect_composited(&window);
        let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
        geo.composited = composited;
        drop(geo);
        let focused = resolve_focus_on_query(
          pet.focused.load(Ordering::Acquire),
          query_window_focused(&window),
        );
        pet.focused.store(focused, Ordering::Release);
      }
      return Ok(state(app));
    }
    _ => {
      return Err(BridgeError::new(
        "INVALID_ARGUMENT",
        "Unknown desktop pet action",
        "not-sent",
      ))
    }
  }
  Ok(publish_with_focus(app, focus_override))
}

#[tauri::command]
pub async fn desktop_pet(
  app: AppHandle,
  webview: Webview,
  action: String,
  expanded: Option<bool>,
  layout: Option<PetWindowLayoutRequest>,
) -> Result<DesktopPetWindowState, BridgeError> {
  let label = webview.label();
  if !matches!(label, "main" | PET_LABEL) || webview.window().label() != label {
    return Err(BridgeError::new(
      "UNAUTHORIZED",
      "desktop pet commands require a local app window",
      "not-sent",
    ));
  }
  control_with_layout(&app, &action, expanded, layout).await
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
  match event {
    WindowEvent::CloseRequested { api, .. } => {
      api.prevent_close();
      let app = window.app_handle().clone();
      tauri::async_runtime::spawn(async move {
        let _ = control(&app, "hide", None).await;
      });
    }
    WindowEvent::Focused(focused) => {
      let app = window.app_handle();
      let pet = app.state::<DesktopPet>();
      if pet.focused.swap(*focused, Ordering::AcqRel) != *focused {
        publish(app);
      }
    }
    WindowEvent::Moved(_) => {
      let app = window.app_handle().clone();
      let pet = app.state::<DesktopPet>();
      let seq = {
        let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
        geo.move_seq = geo.move_seq.wrapping_add(1);
        geo.move_seq
      };
      if pet.is_applying_layout() {
        return;
      }
      tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(160)).await;
        let pet = app.state::<DesktopPet>();
        let _operation = pet.operation.lock().await;
        if pet.is_applying_layout()
          || !should_track_native_geometry(PetRevealState {
            visible: pet.visible.load(Ordering::Acquire),
            revealed: pet.revealed.load(Ordering::Acquire),
          })
        {
          return;
        }
        let current_seq = pet.geometry.lock().unwrap_or_else(|e| e.into_inner()).move_seq;
        if current_seq != seq {
          return;
        }
        let Some(win) = app.get_webview_window(PET_LABEL) else { return };
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
        let Some(monitor) = window_monitor(&win) else { return };
        let work = WorkArea::from_monitor(&monitor);
        let clamped = clamp_to_area(pos, size, work);
        if clamped != pos {
          let _guard = pet.begin_layout_apply();
          #[cfg(windows)]
          move_windows_pet_atomic(&win, clamped).await;
          #[cfg(not(windows))]
          let _ = win.set_position(clamped);
        } else {
          #[cfg(windows)]
          if let Ok(hwnd_raw) = win.hwnd().map(|h| h.0 as isize) {
            let _ = sync_windows_webview_after_layout(&win, hwnd_raw, true, false).await;
          }
        }
        let scale = resolve_scale_factor(Some(&monitor), &win).unwrap_or(1.0);
        let collapsed_size = cap_size(
          LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
          Some(work),
        );
        let (dock_changed, moved_by_user) = {
          let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          if !moved_externally(clamped, geo.expected_window_pos) {
            (false, false)
          } else {
            geo.expected_window_pos = Some(clamped);
            if !pet.expanded.load(Ordering::Acquire) {
              let preferred = preferred_collapsed_dock_side(clamped, collapsed_size, Some(work));
              let changed = preferred != geo.dock_side;
              geo.dock_side = preferred;
              geo.last_collapsed_pos = Some(clamped);
              let offset = mascot_anchor_in_window(collapsed_size, preferred, PanelSide::Top, 0, scale);
              geo.anchor_pos = Some(PhysicalPosition::new(clamped.x + offset.x, clamped.y + offset.y));
              (changed, true)
            } else {
              let composer_h_phys = (geo.current_composer_height * scale).round() as i32;
              let offset = mascot_anchor_in_window(size, geo.dock_side, geo.panel_side, composer_h_phys, scale);
              let anchor = PhysicalPosition::new(clamped.x + offset.x, clamped.y + offset.y);
              let collapsed_dock = preferred_collapsed_dock_side_for_anchor(anchor.x, Some(work));
              let collapsed_pos = collapsed_pos_from_anchor(anchor, collapsed_size, collapsed_dock, Some(work), scale);
              geo.anchor_pos = Some(anchor);
              geo.last_collapsed_pos = Some(collapsed_pos);
              (false, true)
            }
          }
        };
        if dock_changed {
          publish(&app);
        }
        if moved_by_user && pet.visible.load(Ordering::Acquire) {
          save_current_preference(&app, true);
        }
      });
    }
    WindowEvent::Resized(_) => {
      let app = window.app_handle();
      let pet = app.state::<DesktopPet>();
      if pet.is_applying_layout() {
        return;
      }
      if let Some(win) = app.get_webview_window(PET_LABEL) {
        let (hit_rects, composited) = {
          let geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          (geo.hit_rects.clone(), geo.composited)
        };
        apply_window_region(&win, &hit_rects, composited);
      }
    }
    WindowEvent::ScaleFactorChanged { .. } => {
      let app = window.app_handle();
      let pet = app.state::<DesktopPet>();
      if pet.is_applying_layout() {
        return;
      }
      if let Some(win) = app.get_webview_window(PET_LABEL) {
        let composited = {
          let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          // Stale hit rects from the previous DPI would clip visuals on Windows after DPI change.
          geo.hit_rects.clear();
          geo.composited
        };
        apply_window_region(&win, &[], composited);
      }
    }
    WindowEvent::Destroyed => {
      let app = window.app_handle();
      crate::pet_voice::cancel_window_jobs(app, PET_LABEL);
      let pet = app.state::<DesktopPet>();
      pet.visible.store(false, Ordering::Release);
      pet.revealed.store(false, Ordering::Release);
      pet.expanded.store(false, Ordering::Release);
      pet.focused.store(false, Ordering::Release);
      {
        let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
        geo.dock_side = DockSide::Right;
        geo.panel_side = PanelSide::Top;
        geo.anchor_pos = None;
        geo.expected_window_pos = None;
        geo.current_logical_size = COLLAPSED_SIZE;
        geo.current_composer_height = 0.0;
        geo.hit_rects.clear();
      }
      publish(app);
      pet.destroyed.notify_waiters();
    }
    _ => {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const WORK_1080: WorkArea = WorkArea { x: 0, y: 0, width: 1920, height: 1040 };
  const COLLAPSED_1X: PhysicalSize<u32> = PhysicalSize::new(164, 128);
  const PROBE_1X: PhysicalSize<u32> = PhysicalSize::new(380, 480);

  #[test]
  fn dynamic_resize_locks_dock_across_all_four_corners_and_returns_cleanly() {
    let bubble_1x = PhysicalSize::new(370, 320);
    let cases = [
      (PhysicalPosition::new(1740, 896), DockSide::Right, DockSide::Right, PanelSide::Top),
      (PhysicalPosition::new(20, 896), DockSide::Left, DockSide::Left, PanelSide::Top),
      (PhysicalPosition::new(1740, 20), DockSide::Right, DockSide::Right, PanelSide::Bottom),
      (PhysicalPosition::new(20, 20), DockSide::Left, DockSide::Left, PanelSide::Bottom),
    ];
    for (start, initial_dock, expected_dock, expected_panel) in cases {
      let p1 = plan_dynamic_resize(
        start,
        COLLAPSED_1X,
        COLLAPSED_1X,
        bubble_1x,
        PROBE_1X,
        false,
        initial_dock,
        PanelSide::Top,
        0,
        0,
        None,
        None,
        Some(WORK_1080),
        1.0,
      );
      assert_eq!((p1.dock_side, p1.panel_side, p1.expanded, p1.collapsed_pos), (expected_dock, expected_panel, true, start));

      // Grow taller while already expanded -> orientation stays locked and mascot stays pinned!
      let taller = PhysicalSize::new(380, 480);
      let p2 = plan_dynamic_resize(
        p1.window_pos,
        bubble_1x,
        COLLAPSED_1X,
        taller,
        PROBE_1X,
        true,
        p1.dock_side,
        p1.panel_side,
        0,
        0,
        Some(p1.anchor_pos),
        Some(p1.window_pos),
        Some(WORK_1080),
        1.0,
      );
      assert_eq!((p2.dock_side, p2.panel_side, p2.expanded, p2.collapsed_pos), (expected_dock, expected_panel, true, start));

      // Collapse back -> exact original dock position!
      let p3 = plan_dynamic_resize(
        p2.window_pos,
        taller,
        COLLAPSED_1X,
        COLLAPSED_1X,
        PROBE_1X,
        true,
        p2.dock_side,
        p2.panel_side,
        0,
        0,
        Some(p2.anchor_pos),
        Some(p2.window_pos),
        Some(WORK_1080),
        1.0,
      );
      assert_eq!((p3.window_pos, p3.expanded), (start, false));
    }
  }

  #[test]
  fn composer_below_centers_under_mascot_in_open_space_without_moving_mascot() {
    let start = PhysicalPosition::new(880, 456);
    let initial_dock = DockSide::Left; // center X = 940 (< 960)
    let expected_mascot_center = PhysicalPosition::new(880 + 60, 456 + 64); // (940, 520)

    // Open composer directly below mascot (width 320, height 180, composer_h 52)
    let composer_only = PhysicalSize::new(320, 180);
    let p1 = plan_dynamic_resize(
      start,
      COLLAPSED_1X,
      COLLAPSED_1X,
      composer_only,
      PROBE_1X,
      false,
      initial_dock,
      PanelSide::Top,
      0,
      52,
      None,
      None,
      Some(WORK_1080),
      1.0,
    );
    assert_eq!(p1.dock_side, DockSide::Center);
    assert_eq!(p1.panel_side, PanelSide::Top);
    assert_eq!(p1.window_pos, PhysicalPosition::new(940 - 160, 520 - 64));

    // Grow composer textarea +30px -> mascot stays frozen at (940, 520)
    let taller_composer = PhysicalSize::new(320, 210);
    let p2 = plan_dynamic_resize(
      p1.window_pos,
      composer_only,
      COLLAPSED_1X,
      taller_composer,
      PROBE_1X,
      true,
      p1.dock_side,
      p1.panel_side,
      52,
      82,
      Some(p1.anchor_pos),
      Some(p1.window_pos),
      Some(WORK_1080),
      1.0,
    );
    assert_eq!(p2.window_pos, p1.window_pos);
    let mascot_after_grow = {
      let off = mascot_anchor_in_window(taller_composer, p2.dock_side, p2.panel_side, 82, 1.0);
      PhysicalPosition::new(p2.window_pos.x + off.x, p2.window_pos.y + off.y)
    };
    assert_eq!(mascot_after_grow, expected_mascot_center);

    // Bubble opens above mascot while composer stays open below -> mascot STILL frozen!
    let with_bubble = PhysicalSize::new(356, 404);
    let p3 = plan_dynamic_resize(
      p2.window_pos,
      taller_composer,
      COLLAPSED_1X,
      with_bubble,
      PROBE_1X,
      true,
      p2.dock_side,
      p2.panel_side,
      82,
      82,
      Some(p2.anchor_pos),
      Some(p2.window_pos),
      Some(WORK_1080),
      1.0,
    );
    let mascot_with_bubble = {
      let off = mascot_anchor_in_window(with_bubble, p3.dock_side, p3.panel_side, 82, 1.0);
      PhysicalPosition::new(p3.window_pos.x + off.x, p3.window_pos.y + off.y)
    };
    assert_eq!(mascot_with_bubble, expected_mascot_center);

    // Collapse back -> exact original collapsed window pos
    let p4 = plan_dynamic_resize(
      p3.window_pos,
      with_bubble,
      COLLAPSED_1X,
      COLLAPSED_1X,
      PROBE_1X,
      true,
      p3.dock_side,
      p3.panel_side,
      82,
      0,
      Some(p3.anchor_pos),
      Some(p3.window_pos),
      Some(WORK_1080),
      1.0,
    );
    assert_eq!((p4.window_pos, p4.expanded), (start, false));
  }

  #[test]
  fn composer_below_clamps_upward_near_bottom_edge_and_restores_corner_on_close() {
    let start = PhysicalPosition::new(1740, 896); // default bottom-right corner
    let composer_only = PhysicalSize::new(320, 180);

    let p1 = plan_dynamic_resize(
      start,
      COLLAPSED_1X,
      COLLAPSED_1X,
      composer_only,
      PROBE_1X,
      false,
      DockSide::Right,
      PanelSide::Top,
      0,
      52,
      None,
      None,
      Some(WORK_1080),
      1.0,
    );
    assert_eq!(p1.dock_side, DockSide::Right);
    assert_eq!(p1.panel_side, PanelSide::Top);
    // Clamped up so bottom edge stays at 1040 (860 + 180 = 1040), x stays aligned with mascot right edge
    assert_eq!(p1.window_pos, PhysicalPosition::new(1584, 860));

    // Close composer -> mascot smoothly returns to exact original corner (1740, 896)
    let p2 = plan_dynamic_resize(
      p1.window_pos,
      composer_only,
      COLLAPSED_1X,
      COLLAPSED_1X,
      PROBE_1X,
      true,
      p1.dock_side,
      p1.panel_side,
      52,
      0,
      Some(p1.anchor_pos),
      Some(p1.window_pos),
      Some(WORK_1080),
      1.0,
    );
    assert_eq!((p2.window_pos, p2.expanded), (start, false));
  }

  #[test]
  fn dynamic_resize_preserves_drag_delta_when_collapsing() {
    let start = PhysicalPosition::new(40, 40);
    let expanded = PhysicalSize::new(380, 360);
    let p1 = plan_dynamic_resize(
      start,
      COLLAPSED_1X,
      COLLAPSED_1X,
      expanded,
      PROBE_1X,
      false,
      DockSide::Left,
      PanelSide::Top,
      0,
      52,
      None,
      None,
      Some(WORK_1080),
      1.0,
    );
    let dragged = PhysicalPosition::new(p1.window_pos.x + 120, p1.window_pos.y + 80);
    let p2 = plan_dynamic_resize(
      dragged,
      expanded,
      COLLAPSED_1X,
      COLLAPSED_1X,
      PROBE_1X,
      true,
      p1.dock_side,
      p1.panel_side,
      52,
      0,
      Some(p1.anchor_pos),
      Some(p1.window_pos),
      Some(WORK_1080),
      1.0,
    );
    assert_eq!(p2.expanded, false);
    assert_eq!(p2.window_pos, PhysicalPosition::new(160, 120));
  }

  #[test]
  fn scale_hit_rects_clamps_and_drops_empty_regions() {
    let input = vec![
      LogicalHitRect { x: -4.0, y: 10.0, width: 100.0, height: 80.0, radius: 18 },
      LogicalHitRect { x: 10.0, y: 10.0, width: 0.0, height: 50.0, radius: 0 },
      LogicalHitRect { x: 300.0, y: 200.0, width: 200.0, height: 200.0, radius: 12 },
    ];
    let scaled = scale_hit_rects(&input, 400, 300, 1.0);
    assert_eq!(scaled.len(), 2);
    assert_eq!(scaled[0].0, RectI { x: 0, y: 10, width: 96, height: 80 });
    assert_eq!(scaled[1].0, RectI { x: 300, y: 200, width: 100, height: 100 });
  }

  #[test]
  fn rounded_rect_scanlines_trim_corners_cleanly() {
    let rect = RectI { x: 6, y: 6, width: 120, height: 126 };
    let spans = rounded_rect_scanlines(rect, 20);
    assert!(!spans.is_empty());
    let top_row = spans.iter().find(|s| s.y == 6).unwrap();
    let mid_row = spans.iter().find(|s| s.y == 26).unwrap();
    assert!(top_row.x > rect.x);
    assert!(top_row.width < rect.width);
    assert_eq!(mid_row.x, rect.x);
    assert_eq!(mid_row.width, rect.width);
  }

  #[test]
  fn persisted_pet_state_round_trips_and_defaults_safely() {
    let state = PersistedPetState { visible: true, x: Some(1740), y: Some(896) };
    let json = serde_json::to_string(&state).unwrap();
    let decoded: PersistedPetState = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded, state);

    let minimal: PersistedPetState = serde_json::from_str(r#"{"visible":true}"#).unwrap();
    assert_eq!(minimal, PersistedPetState { visible: true, x: None, y: None });
  }

  #[test]
  fn composer_expand_preserves_anchor_across_orientations_and_dpi_scales() {
    struct Case {
      label: &'static str,
      work: WorkArea,
      scale: f64,
      start: PhysicalPosition<i32>,
      initial_dock: DockSide,
      composer_logical: (f64, f64, f64), // (width, height, composer_height)
      expected_dock: DockSide,
      expected_panel: PanelSide,
    }

    let cases = [
      // Real-world 4K 1.5x monitor (DISPLAY2): saved pos (2999, 1446) switches Right -> Center
      Case {
        label: "4k_1.5x_right_to_center_top",
        work: WorkArea { x: 0, y: 0, width: 3840, height: 2088 },
        scale: 1.5,
        start: PhysicalPosition::new(2999, 1446),
        initial_dock: DockSide::Right,
        composer_logical: (320.0, 180.0, 52.0),
        expected_dock: DockSide::Center,
        expected_panel: PanelSide::Top,
      },
      // 4K 1.5x with recall chip taller composer (height 207, composer_h 79)
      Case {
        label: "4k_1.5x_center_with_recall_chip",
        work: WorkArea { x: 0, y: 0, width: 3840, height: 2088 },
        scale: 1.5,
        start: PhysicalPosition::new(2999, 1446),
        initial_dock: DockSide::Right,
        composer_logical: (320.0, 207.0, 79.0),
        expected_dock: DockSide::Center,
        expected_panel: PanelSide::Top,
      },
      // 1.25x DPI near right edge (cannot fit Center -> stays Right, PanelSide::Top)
      Case {
        label: "1.25x_right_edge_top",
        work: WorkArea { x: 0, y: 0, width: 2400, height: 1300 },
        scale: 1.25,
        start: PhysicalPosition::new(2170, 900),
        initial_dock: DockSide::Right,
        composer_logical: (320.0, 180.0, 52.0),
        expected_dock: DockSide::Right,
        expected_panel: PanelSide::Top,
      },
      // 1.25x DPI near left edge (stays Left, PanelSide::Top)
      Case {
        label: "1.25x_left_edge_top",
        work: WorkArea { x: 0, y: 0, width: 2400, height: 1300 },
        scale: 1.25,
        start: PhysicalPosition::new(16, 900),
        initial_dock: DockSide::Left,
        composer_logical: (320.0, 180.0, 52.0),
        expected_dock: DockSide::Left,
        expected_panel: PanelSide::Top,
      },
      // 2.0x HiDPI near top-left edge (PanelSide::Bottom, DockSide::Left)
      Case {
        label: "2.0x_top_left_panel_bottom",
        work: WorkArea { x: 0, y: 0, width: 3840, height: 2080 },
        scale: 2.0,
        start: PhysicalPosition::new(24, 24),
        initial_dock: DockSide::Left,
        composer_logical: (320.0, 207.0, 79.0),
        expected_dock: DockSide::Left,
        expected_panel: PanelSide::Bottom,
      },
      // 2.0x HiDPI near top-center open space (PanelSide::Bottom, DockSide::Center)
      Case {
        label: "2.0x_top_center_panel_bottom",
        work: WorkArea { x: 0, y: 0, width: 3840, height: 2080 },
        scale: 2.0,
        start: PhysicalPosition::new(1800, 24),
        initial_dock: DockSide::Right,
        composer_logical: (320.0, 180.0, 52.0),
        expected_dock: DockSide::Center,
        expected_panel: PanelSide::Bottom,
      },
      // 1.0x near top-right corner (PanelSide::Bottom, DockSide::Right)
      Case {
        label: "1.0x_top_right_panel_bottom",
        work: WORK_1080,
        scale: 1.0,
        start: PhysicalPosition::new(1740, 20),
        initial_dock: DockSide::Right,
        composer_logical: (320.0, 207.0, 79.0),
        expected_dock: DockSide::Right,
        expected_panel: PanelSide::Bottom,
      },
    ];

    for case in cases {
      let collapsed = cap_size(
        LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(case.scale),
        Some(case.work),
      );
      let target = cap_size(
        LogicalSize::new(case.composer_logical.0, case.composer_logical.1)
          .to_physical::<u32>(case.scale),
        Some(case.work),
      );
      let probe = cap_size(
        LogicalSize::new(
          case.composer_logical.0.max(ORIENTATION_PROBE_SIZE.0),
          case.composer_logical.1.max(ORIENTATION_PROBE_SIZE.1),
        )
        .to_physical::<u32>(case.scale),
        Some(case.work),
      );
      let composer_h_phys = (case.composer_logical.2 * case.scale).round() as i32;
      let start_offset =
        mascot_anchor_in_window(collapsed, case.initial_dock, PanelSide::Top, 0, case.scale);
      let expected_anchor = PhysicalPosition::new(
        case.start.x + start_offset.x,
        case.start.y + start_offset.y,
      );

      let expanded = plan_dynamic_resize(
        case.start,
        collapsed,
        collapsed,
        target,
        probe,
        false,
        case.initial_dock,
        PanelSide::Top,
        0,
        composer_h_phys,
        None,
        None,
        Some(case.work),
        case.scale,
      );

      assert_eq!(
        (expanded.dock_side, expanded.panel_side, expanded.expanded),
        (case.expected_dock, case.expected_panel, true),
        "orientation mismatch for {}",
        case.label
      );
      // Window must remain strictly inside work area
      assert!(expanded.window_pos.x >= case.work.x, "x underflow for {}", case.label);
      assert!(expanded.window_pos.y >= case.work.y, "y underflow for {}", case.label);
      assert!(
        expanded.window_pos.x + target.width as i32 <= case.work.x + case.work.width as i32,
        "x overflow for {}",
        case.label
      );
      assert!(
        expanded.window_pos.y + target.height as i32 <= case.work.y + case.work.height as i32,
        "y overflow for {}",
        case.label
      );

      // Screen-space mascot center must stay pixel-pinned when unclamped
      let expanded_offset = mascot_anchor_in_window(
        target,
        expanded.dock_side,
        expanded.panel_side,
        composer_h_phys,
        case.scale,
      );
      let actual_anchor = PhysicalPosition::new(
        expanded.window_pos.x + expanded_offset.x,
        expanded.window_pos.y + expanded_offset.y,
      );
      assert_eq!(actual_anchor, expected_anchor, "mascot anchor shifted for {}", case.label);

      // Subsequent growth (e.g., reply bubble appears while composer stays open) preserves orientation & anchor
      let with_bubble = cap_size(
        LogicalSize::new(356.0, 440.0).to_physical::<u32>(case.scale),
        Some(case.work),
      );
      let grown = plan_dynamic_resize(
        expanded.window_pos,
        target,
        collapsed,
        with_bubble,
        probe,
        true,
        expanded.dock_side,
        expanded.panel_side,
        composer_h_phys,
        composer_h_phys,
        Some(expanded.anchor_pos),
        Some(expanded.window_pos),
        Some(case.work),
        case.scale,
      );
      assert_eq!(
        (grown.dock_side, grown.panel_side),
        (case.expected_dock, case.expected_panel),
        "orientation flipped on growth for {}",
        case.label
      );

      // Collapse returns to exact original collapsed position
      let collapsed_back = plan_dynamic_resize(
        grown.window_pos,
        with_bubble,
        collapsed,
        collapsed,
        probe,
        true,
        grown.dock_side,
        grown.panel_side,
        composer_h_phys,
        0,
        Some(grown.anchor_pos),
        Some(grown.window_pos),
        Some(case.work),
        case.scale,
      );
      assert_eq!(
        (collapsed_back.window_pos, collapsed_back.expanded),
        (case.start, false),
        "collapse failed to restore start for {}",
        case.label
      );
    }
  }

  #[test]
  fn multi_monitor_negative_and_offset_work_areas_clamp_and_restore_cleanly() {
    let display1 = WorkArea { x: -1920, y: 0, width: 1920, height: 1032 };
    let display2 = WorkArea { x: 0, y: 0, width: 3840, height: 2088 };
    let display3 = WorkArea { x: 3840, y: 0, width: 1080, height: 1872 };

    // Left-edge bottom corner on negative-X DISPLAY1 (1.0x)
    let start_d1 = PhysicalPosition::new(-1910, 900);
    let composer_1x = PhysicalSize::new(320, 207);
    let p_d1 = plan_dynamic_resize(
      start_d1,
      COLLAPSED_1X,
      COLLAPSED_1X,
      composer_1x,
      PROBE_1X,
      false,
      DockSide::Left,
      PanelSide::Top,
      0,
      79,
      None,
      None,
      Some(display1),
      1.0,
    );
    assert_eq!(p_d1.dock_side, DockSide::Left);
    assert_eq!(p_d1.panel_side, PanelSide::Top);
    assert_eq!(p_d1.window_pos.x, -1910);
    // Clamped up so bottom edge stays within display1 work area (y + 207 <= 1032 => y <= 825)
    assert_eq!(p_d1.window_pos.y, 825);

    let back_d1 = plan_dynamic_resize(
      p_d1.window_pos,
      composer_1x,
      COLLAPSED_1X,
      COLLAPSED_1X,
      PROBE_1X,
      true,
      p_d1.dock_side,
      p_d1.panel_side,
      79,
      0,
      Some(p_d1.anchor_pos),
      Some(p_d1.window_pos),
      Some(display1),
      1.0,
    );
    assert_eq!(back_d1.window_pos, start_d1);

    // Bottom-right corner on portrait DISPLAY3 (x >= 3840, 1.0x)
    let start_d3 = PhysicalPosition::new(3840 + 1080 - 164 - 8, 1872 - 128 - 8);
    let p_d3 = plan_dynamic_resize(
      start_d3,
      COLLAPSED_1X,
      COLLAPSED_1X,
      composer_1x,
      PROBE_1X,
      false,
      DockSide::Right,
      PanelSide::Top,
      0,
      79,
      None,
      None,
      Some(display3),
      1.0,
    );
    assert_eq!(p_d3.dock_side, DockSide::Right);
    assert_eq!(p_d3.panel_side, PanelSide::Top);
    assert!(p_d3.window_pos.x >= display3.x);
    assert!(p_d3.window_pos.x + composer_1x.width as i32 <= display3.x + display3.width as i32);
    assert_eq!(p_d3.window_pos.y + composer_1x.height as i32, 1872);

    let back_d3 = plan_dynamic_resize(
      p_d3.window_pos,
      composer_1x,
      COLLAPSED_1X,
      COLLAPSED_1X,
      PROBE_1X,
      true,
      p_d3.dock_side,
      p_d3.panel_side,
      79,
      0,
      Some(p_d3.anchor_pos),
      Some(p_d3.window_pos),
      Some(display3),
      1.0,
    );
    assert_eq!(back_d3.window_pos, start_d3);

    // Monitor selection prefers work area, then falls back to full monitor bounds (taskbar band)
    let monitors = [
      (display1, WorkArea { x: -1920, y: 0, width: 1920, height: 1080 }),
      (display2, WorkArea { x: 0, y: 0, width: 3840, height: 2160 }),
      (display3, WorkArea { x: 3840, y: 0, width: 1080, height: 1920 }),
    ];
    assert_eq!(
      select_monitor_index_for_position(&monitors, PhysicalPosition::new(-500, 1050)),
      Some(0)
    );
    assert_eq!(
      select_monitor_index_for_position(&monitors, PhysicalPosition::new(2999, 1446)),
      Some(1)
    );
    assert_eq!(
      select_monitor_index_for_position(&monitors, PhysicalPosition::new(4100, 1900)),
      Some(2)
    );
    assert_eq!(
      select_monitor_index_for_position(&monitors, PhysicalPosition::new(9999, 9999)),
      None
    );
  }

  #[test]
  fn windows_layout_commit_plan_orders_region_clear_and_atomic_pos_correctly() {
    // 1. Expand (grow + move left) with empty hit_rects while opening
    let grow_empty = plan_windows_layout_commit(
      Some(PhysicalPosition::new(2999, 1446)),
      PhysicalSize::new(246, 192),
      PhysicalPosition::new(2915, 1446),
      PhysicalSize::new(480, 270),
      false,
    );
    assert!(grow_empty.clear_region_before_pos);
    assert!(grow_empty.run_set_window_pos);
    assert!(grow_empty.move_window);
    assert!(grow_empty.resize_window);
    assert_eq!(grow_empty.post_region, PostRegionAction::KeepCleared);

    // 2. Expand with non-empty hit_rects: clears stale region before SetWindowPos, applies new after
    let grow_rects = plan_windows_layout_commit(
      Some(PhysicalPosition::new(2999, 1446)),
      PhysicalSize::new(246, 192),
      PhysicalPosition::new(2915, 1446),
      PhysicalSize::new(480, 270),
      true,
    );
    assert!(grow_rects.clear_region_before_pos);
    assert!(grow_rects.run_set_window_pos);
    assert_eq!(grow_rects.post_region, PostRegionAction::ApplyRects);

    // 3. Shrink (collapse back to right-docked collapsed bounds): MUST still clear stale region
    //    before SetWindowPos so old right-offset rects do not clip the smaller window.
    let shrink = plan_windows_layout_commit(
      Some(PhysicalPosition::new(2915, 1446)),
      PhysicalSize::new(480, 270),
      PhysicalPosition::new(2999, 1446),
      PhysicalSize::new(246, 192),
      true,
    );
    assert!(shrink.clear_region_before_pos);
    assert!(shrink.run_set_window_pos);
    assert!(shrink.move_window);
    assert!(shrink.resize_window);
    assert_eq!(shrink.post_region, PostRegionAction::ApplyRects);

    // 4. Hit-rects-only update after viewport matches: no SetWindowPos, applies rects directly
    let rects_only = plan_windows_layout_commit(
      Some(PhysicalPosition::new(2915, 1446)),
      PhysicalSize::new(480, 270),
      PhysicalPosition::new(2915, 1446),
      PhysicalSize::new(480, 270),
      true,
    );
    assert!(!rects_only.clear_region_before_pos);
    assert!(!rects_only.run_set_window_pos);
    assert_eq!(rects_only.post_region, PostRegionAction::ApplyRects);

    // 5. Move-only without size change: window-relative region stays valid before move
    let move_only = plan_windows_layout_commit(
      Some(PhysicalPosition::new(2915, 1446)),
      PhysicalSize::new(480, 270),
      PhysicalPosition::new(2800, 1400),
      PhysicalSize::new(480, 270),
      true,
    );
    assert!(!move_only.clear_region_before_pos);
    assert!(move_only.run_set_window_pos);
    assert!(move_only.move_window);
    assert!(!move_only.resize_window);
    assert_eq!(move_only.post_region, PostRegionAction::ApplyRects);

    // 6. Clear hit-rects without geometry change
    let clear_only = plan_windows_layout_commit(
      Some(PhysicalPosition::new(2915, 1446)),
      PhysicalSize::new(480, 270),
      PhysicalPosition::new(2915, 1446),
      PhysicalSize::new(480, 270),
      false,
    );
    assert!(!clear_only.clear_region_before_pos);
    assert!(!clear_only.run_set_window_pos);
    assert_eq!(clear_only.post_region, PostRegionAction::Clear { redraw: true });
  }

  #[test]
  fn scale_hit_rects_handles_hidpi_and_post_resize_bounds() {
    let rects = vec![
      // Avatar centered in 320x180 expanded composer window
      LogicalHitRect { x: 102.0, y: 6.0, width: 116.0, height: 116.0, radius: 26 },
      // Composer pill directly below avatar
      LogicalHitRect { x: 0.0, y: 116.0, width: 320.0, height: 64.0, radius: 24 },
      // Invalid / NaN / degenerate rects must be ignored
      LogicalHitRect { x: f64::NAN, y: 0.0, width: 50.0, height: 50.0, radius: 0 },
      LogicalHitRect { x: 10.0, y: 10.0, width: 1.0, height: 50.0, radius: 0 },
    ];
    // At 1.5x, expanded outer size is 480x270: both avatar and full composer pill fit unclipped.
    let scaled_15 = scale_hit_rects(&rects, 480, 270, 1.5);
    assert_eq!(scaled_15.len(), 2);
    assert_eq!(scaled_15[0], (RectI { x: 153, y: 9, width: 174, height: 174 }, 39));
    assert_eq!(scaled_15[1], (RectI { x: 0, y: 174, width: 480, height: 96 }, 36));
  }

  #[test]
  fn native_window_focus_evaluation_handles_webview2_child_and_unfocused_states() {
    // WebView2 child HWND focused while pet top-level HWND is foreground -> true
    assert!(evaluate_native_window_focus(NativeFocusProbe {
      window_visible: true,
      window_minimized: false,
      foreground_matches_window: true,
      focus_hwnd_present: true,
      focus_matches_window: true,
    }));

    // Foreground window right after SetForegroundWindow before child HWND grabs focus -> true
    assert!(evaluate_native_window_focus(NativeFocusProbe {
      window_visible: true,
      window_minimized: false,
      foreground_matches_window: true,
      focus_hwnd_present: false,
      focus_matches_window: false,
    }));

    // Another app is foreground -> false
    assert!(!evaluate_native_window_focus(NativeFocusProbe {
      window_visible: true,
      window_minimized: false,
      foreground_matches_window: false,
      focus_hwnd_present: true,
      focus_matches_window: false,
    }));

    // Focus HWND belongs to a foreign window -> false
    assert!(!evaluate_native_window_focus(NativeFocusProbe {
      window_visible: true,
      window_minimized: false,
      foreground_matches_window: true,
      focus_hwnd_present: true,
      focus_matches_window: false,
    }));

    // Hidden or minimized window -> never focused
    assert!(!evaluate_native_window_focus(NativeFocusProbe {
      window_visible: false,
      window_minimized: false,
      foreground_matches_window: true,
      focus_hwnd_present: true,
      focus_matches_window: true,
    }));
    assert!(!evaluate_native_window_focus(NativeFocusProbe {
      window_visible: true,
      window_minimized: true,
      foreground_matches_window: true,
      focus_hwnd_present: true,
      focus_matches_window: true,
    }));
  }

  #[test]
  fn focus_resolution_protects_against_spurious_false_overwrite_and_echo() {
    // Query protection ("show" / "status"): preserve tracked focus when probe unavailable
    assert!(resolve_focus_on_query(true, None));
    assert!(!resolve_focus_on_query(false, None));
    assert!(resolve_focus_on_query(false, Some(true)));
    assert!(!resolve_focus_on_query(true, Some(false)));

    // set-layout with focus=true & live probe true -> confirmed true
    assert_eq!(
      resolve_focus_after_layout(false, Some(true), true),
      LayoutFocusResolution { stored_focused: true, reported_focused: Some(true) }
    );

    // set-layout with focus=true before OS finishes activating -> suppress spurious `focused: false`
    assert_eq!(
      resolve_focus_after_layout(false, Some(false), true),
      LayoutFocusResolution { stored_focused: false, reported_focused: None }
    );

    // set-layout with focus=true when already focused -> never clobber `true` with `false`
    assert_eq!(
      resolve_focus_after_layout(true, Some(false), true),
      LayoutFocusResolution { stored_focused: true, reported_focused: Some(true) }
    );

    // set-layout with focus=false reports real probed state
    assert_eq!(
      resolve_focus_after_layout(false, Some(true), false),
      LayoutFocusResolution { stored_focused: true, reported_focused: Some(true) }
    );
    assert_eq!(
      resolve_focus_after_layout(true, Some(false), false),
      LayoutFocusResolution { stored_focused: false, reported_focused: Some(false) }
    );
    assert_eq!(
      resolve_focus_after_layout(true, None, false),
      LayoutFocusResolution { stored_focused: true, reported_focused: Some(true) }
    );
  }

  #[test]
  fn desktop_pet_window_state_serialization_contract() {
    let focused_state = DesktopPetWindowState {
      visible: true,
      expanded: true,
      focused: Some(true),
      dock_side: "center",
      panel_side: "top",
      composited: true,
      width: 320,
      height: 180,
    };
    let v = serde_json::to_value(focused_state).unwrap();
    assert_eq!(v["visible"], true);
    assert_eq!(v["expanded"], true);
    assert_eq!(v["focused"], true);
    assert_eq!(v["dockSide"], "center");
    assert_eq!(v["panelSide"], "top");
    assert_eq!(v["composited"], true);
    assert_eq!(v["width"], 320);
    assert_eq!(v["height"], 180);

    // During focus:true transition before OS confirms focus, `focused` is omitted instead of `false`
    let transitioning = DesktopPetWindowState {
      focused: None,
      ..focused_state
    };
    let v2 = serde_json::to_value(transitioning).unwrap();
    assert!(v2.get("focused").is_none());
    assert_eq!(v2["width"], 320);
    assert_eq!(v2["height"], 180);
  }

  #[test]
  fn effective_logical_size_preserves_requested_and_respects_work_area_cap() {
    let work = WorkArea { x: 0, y: 0, width: 3840, height: 2088 };
    for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
      let phys = cap_size(LogicalSize::new(320.0, 180.0).to_physical::<u32>(scale), Some(work));
      assert_eq!(effective_logical_size((320.0, 180.0), phys, Some(work), scale), (320.0, 180.0));
    }

    // Small monitor caps physical size -> effective logical size reflects actual capped viewport
    let tiny = WorkArea { x: 0, y: 0, width: 450, height: 300 };
    let capped_phys = cap_size(LogicalSize::new(380.0, 480.0).to_physical::<u32>(1.5), Some(tiny));
    assert_eq!(capped_phys, PhysicalSize::new(450, 300));
    assert_eq!(
      effective_logical_size((380.0, 480.0), capped_phys, Some(tiny), 1.5),
      (300.0, 200.0)
    );
  }

  #[test]
  fn pet_reveal_guards_defer_native_show_and_protect_saved_geometry_until_avatar_ready() {
    // Freshly created window stays hidden until frontend sends "reveal"
    assert!(!should_show_window_on_show_action(false, false));
    // Re-invoking "show" while still waiting for avatar load must not prematurely reveal
    assert!(!should_show_window_on_show_action(true, false));
    // Re-invoking "show" after already revealed remains idempotent
    assert!(should_show_window_on_show_action(true, true));

    // "reveal" only shows when pet is still enabled (visible) and not yet revealed
    assert!(should_show_window_on_reveal_action(PetRevealState {
      visible: true,
      revealed: false,
    }));
    assert!(!should_show_window_on_reveal_action(PetRevealState {
      visible: true,
      revealed: true,
    }));
    // If user hid the pet before avatar finished loading, a racing "reveal" must stay ignored
    assert!(!should_show_window_on_reveal_action(PetRevealState {
      visible: false,
      revealed: false,
    }));
    assert!(!should_show_window_on_reveal_action(PetRevealState {
      visible: false,
      revealed: true,
    }));

    // Do not snapshot native outer position or treat OS move events as user drags before reveal
    assert!(!should_track_native_geometry(PetRevealState {
      visible: false,
      revealed: false,
    }));
    assert!(!should_track_native_geometry(PetRevealState {
      visible: true,
      revealed: false,
    }));
    assert!(should_track_native_geometry(PetRevealState {
      visible: true,
      revealed: true,
    }));
  }
}
