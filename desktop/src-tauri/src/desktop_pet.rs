//! Lightweight local pet window. The main webview owns all bot/broker state.
use std::{
  sync::{
    atomic::{AtomicBool, Ordering},
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
/// Ambient mascot window: holds the 88px mascot + subtle breathing room + side hover rail.
const COLLAPSED_SIZE: (f64, f64) = (152.0, 116.0);
const EXPANDED_SIZE: (f64, f64) = (448.0, 560.0);
const MAX_STAGE_WIDTH: f64 = 520.0;
const MAX_STAGE_HEIGHT: f64 = 640.0;
/// Probe envelope when choosing bubble/panel orientation from collapsed state so
/// short thought bubbles never flip orientation as they grow into replies or QA cards.
const ORIENTATION_PROBE_SIZE: (f64, f64) = (448.0, 480.0);
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const STAGE_PADDING: f64 = 6.0;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DOCK_RADIUS: i32 = 22;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DockSide {
  Right,
  Left,
}

impl DockSide {
  const fn as_str(self) -> &'static str {
    match self {
      Self::Right => "right",
      Self::Left => "left",
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
  pub focus: bool,
  #[serde(default)]
  pub hit_rects: Vec<LogicalHitRect>,
}

struct PetGeometry {
  dock_side: DockSide,
  panel_side: PanelSide,
  composited: bool,
  last_collapsed_pos: Option<PhysicalPosition<i32>>,
  current_logical_size: (f64, f64),
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
      current_logical_size: COLLAPSED_SIZE,
      hit_rects: Vec::new(),
      move_seq: 0,
    }
  }
}

#[derive(Default)]
pub struct DesktopPet {
  visible: AtomicBool,
  expanded: AtomicBool,
  geometry: Mutex<PetGeometry>,
  operation: tokio::sync::Mutex<()>,
  destroyed: tokio::sync::Notify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetWindowState {
  visible: bool,
  expanded: bool,
  dock_side: &'static str,
  panel_side: &'static str,
  composited: bool,
}

fn state(app: &AppHandle) -> DesktopPetWindowState {
  let pet = app.state::<DesktopPet>();
  let geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
  DesktopPetWindowState {
    visible: pet.visible.load(Ordering::Acquire),
    expanded: pet.expanded.load(Ordering::Acquire),
    dock_side: geo.dock_side.as_str(),
    panel_side: geo.panel_side.as_str(),
    composited: geo.composited,
  }
}

#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
pub fn is_visible(app: &AppHandle) -> bool {
  app.try_state::<DesktopPet>()
    .is_some_and(|pet| pet.visible.load(Ordering::Acquire))
}

fn publish(app: &AppHandle) -> DesktopPetWindowState {
  let next = state(app);
  let _ = app.emit_to("main", WINDOW_EVENT, next);
  let _ = app.emit_to(PET_LABEL, WINDOW_EVENT, next);
  #[cfg(any(windows, target_os = "linux"))]
  crate::desktop_tray::sync_pet_visible(app, next.visible);
  next
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

fn dock_origin_from_window(
  window_pos: PhysicalPosition<i32>,
  window_size: PhysicalSize<u32>,
  collapsed_size: PhysicalSize<u32>,
  dock_side: DockSide,
  panel_side: PanelSide,
) -> PhysicalPosition<i32> {
  let x = match dock_side {
    DockSide::Right => window_pos.x + window_size.width as i32 - collapsed_size.width as i32,
    DockSide::Left => window_pos.x,
  };
  let y = match panel_side {
    PanelSide::Top => window_pos.y + window_size.height as i32 - collapsed_size.height as i32,
    PanelSide::Bottom => window_pos.y,
  };
  PhysicalPosition::new(x, y)
}

fn window_pos_from_dock(
  dock_pos: PhysicalPosition<i32>,
  collapsed_size: PhysicalSize<u32>,
  target_size: PhysicalSize<u32>,
  dock_side: DockSide,
  panel_side: PanelSide,
  area: Option<WorkArea>,
) -> PhysicalPosition<i32> {
  let raw_x = match dock_side {
    DockSide::Right => dock_pos.x + collapsed_size.width as i32 - target_size.width as i32,
    DockSide::Left => dock_pos.x,
  };
  let raw_y = match panel_side {
    PanelSide::Top => dock_pos.y + collapsed_size.height as i32 - target_size.height as i32,
    PanelSide::Bottom => dock_pos.y,
  };
  let raw = PhysicalPosition::new(raw_x, raw_y);
  area.map_or(raw, |a| clamp_to_area(raw, target_size, a))
}

fn choose_orientation(
  dock_pos: PhysicalPosition<i32>,
  collapsed_size: PhysicalSize<u32>,
  probe_size: PhysicalSize<u32>,
  area: Option<WorkArea>,
) -> (DockSide, PanelSide) {
  let Some(area) = area else {
    return (DockSide::Right, PanelSide::Top);
  };
  let extra_w = probe_size.width.saturating_sub(collapsed_size.width) as i32;
  let extra_h = probe_size.height.saturating_sub(collapsed_size.height) as i32;
  let room_left = dock_pos.x - area.x;
  let room_right = (area.x + area.width as i32) - (dock_pos.x + collapsed_size.width as i32);
  let room_above = dock_pos.y - area.y;
  let room_below = (area.y + area.height as i32) - (dock_pos.y + collapsed_size.height as i32);

  let dock_side = if room_left >= extra_w {
    DockSide::Right
  } else if room_right >= extra_w {
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

/// Plans a dynamic resize while locking the mascot dock corner on screen.
fn plan_dynamic_resize(
  current_pos: PhysicalPosition<i32>,
  current_size: PhysicalSize<u32>,
  collapsed_size: PhysicalSize<u32>,
  target_size: PhysicalSize<u32>,
  probe_size: PhysicalSize<u32>,
  was_expanded: bool,
  cur_dock: DockSide,
  cur_panel: PanelSide,
  area: Option<WorkArea>,
) -> (PhysicalPosition<i32>, DockSide, PanelSide, bool, PhysicalPosition<i32>) {
  let dock_pos = dock_origin_from_window(current_pos, current_size, collapsed_size, cur_dock, cur_panel);
  let dock_clamped = area.map_or(dock_pos, |a| clamp_to_area(dock_pos, collapsed_size, a));
  let next_expanded = target_size.width > collapsed_size.width + 2
    || target_size.height > collapsed_size.height + 2;

  let (next_dock, next_panel) = if !next_expanded {
    (
      preferred_collapsed_dock_side(dock_clamped, collapsed_size, area),
      PanelSide::Top,
    )
  } else if !was_expanded {
    choose_orientation(dock_clamped, collapsed_size, probe_size, area)
  } else {
    (cur_dock, cur_panel)
  };

  let next_pos = if !next_expanded {
    dock_clamped
  } else {
    window_pos_from_dock(
      dock_clamped,
      collapsed_size,
      target_size,
      next_dock,
      next_panel,
      area,
    )
  };

  (next_pos, next_dock, next_panel, next_expanded, dock_clamped)
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

fn window_monitor(window: &WebviewWindow) -> Option<Monitor> {
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
      monitors
        .into_iter()
        .find(|m| WorkArea::from_monitor(m).contains(pos))
    })
    .or_else(|| window_monitor(window))
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
    let Ok(hwnd_raw) = window.hwnd() else { return };
    let hwnd = hwnd_raw.0 as usize;
    let Ok(size) = window.outer_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let rects: Vec<RectI> = scale_hit_rects(hit_rects, size.width as i32, size.height as i32, scale)
      .into_iter()
      .map(|(r, _)| r)
      .collect();
    let _ = window.run_on_main_thread(move || unsafe {
      use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
      };
      if rects.is_empty() {
        SetWindowRgn(hwnd as _, std::ptr::null_mut(), 1);
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
      if SetWindowRgn(hwnd as _, combined, 1) == 0 {
        DeleteObject(combined);
      }
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
fn apply_linux_size_lock(window: &WebviewWindow, size: Option<PhysicalSize<u32>>) {
  let _ = window.set_min_size(size);
  let _ = window.set_max_size(size);
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_size_lock(_window: &WebviewWindow, _size: Option<PhysicalSize<u32>>) {}

fn apply_layout(
  app: &AppHandle,
  window: &WebviewWindow,
  request: PetWindowLayoutRequest,
) -> Result<(), BridgeError> {
  let pet = app.state::<DesktopPet>();
  let scale = window
    .scale_factor()
    .map_err(|_| native_error("Could not read pet window scale"))?;
  let monitor = window_monitor(window);
  let area = monitor.as_ref().map(WorkArea::from_monitor);
  let collapsed_size = cap_size(
    LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let (logical_w, logical_h) = sanitize_logical_size(request.width, request.height);
  let target_size = cap_size(
    LogicalSize::new(logical_w, logical_h).to_physical::<u32>(scale),
    area,
  );
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

  let (next_pos, next_dock, next_panel, next_expanded, size_changed) = {
    let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.composited = composited;
    geo.hit_rects = request.hit_rects.clone();
    let cur_pos = old_position
      .or(geo.last_collapsed_pos)
      .unwrap_or_else(|| PhysicalPosition::new(0, 0));
    let (next_pos, next_dock, next_panel, next_expanded, dock_pos) = plan_dynamic_resize(
      cur_pos,
      current_size,
      collapsed_size,
      target_size,
      probe_size,
      was_expanded,
      geo.dock_side,
      geo.panel_side,
      area,
    );
    let size_changed = current_size.width.abs_diff(target_size.width) > 1
      || current_size.height.abs_diff(target_size.height) > 1
      || next_dock != geo.dock_side
      || next_panel != geo.panel_side;
    geo.dock_side = next_dock;
    geo.panel_side = next_panel;
    geo.last_collapsed_pos = Some(dock_pos);
    geo.current_logical_size = (logical_w, logical_h);
    (next_pos, next_dock, next_panel, next_expanded, size_changed)
  };

  pet.expanded.store(next_expanded, Ordering::Release);

  if size_changed {
    // Clear previous region before changing window dimensions so no frames clip against stale bounds.
    #[cfg(windows)]
    apply_window_region(window, &[], composited);

    apply_linux_size_lock(window, None);
    window
      .set_size(target_size)
      .map_err(|_| native_error("Could not resize desktop pet"))?;
    apply_linux_size_lock(window, Some(target_size));
    if old_position != Some(next_pos) {
      let _ = window.set_position(next_pos);
    }
  }

  let _ = (next_dock, next_panel);
  apply_window_region(window, &request.hit_rects, composited);
  if request.focus {
    let _ = window.set_focus();
  }
  Ok(())
}

fn create(app: &AppHandle) -> Result<WebviewWindow, BridgeError> {
  let window = WebviewWindowBuilder::new(app, PET_LABEL, WebviewUrl::App("index.html?view=pet".into()))
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
    .or_else(|| app.get_webview_window("main").and_then(|main| window_monitor(&main)))
    .or_else(|| window_monitor(&window));

  let composited = detect_composited(&window);
  let mut initial_pos = saved_pos;
  let mut initial_dock = DockSide::Right;
  if let Some(monitor) = monitor {
    let area = monitor.work_area();
    let work = WorkArea::from_monitor(&monitor);
    let scale = monitor.scale_factor();
    let size = cap_size(
      LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
      Some(work),
    );
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
    apply_linux_size_lock(&window, None);
    let _ = window.set_size(size);
    apply_linux_size_lock(&window, Some(size));
    let _ = window.set_position(clamped);
  }

  {
    let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.dock_side = initial_dock;
    geo.panel_side = PanelSide::Top;
    geo.composited = composited;
    geo.current_logical_size = COLLAPSED_SIZE;
    geo.hit_rects.clear();
    if let Some(pos) = initial_pos {
      geo.last_collapsed_pos = Some(pos);
    }
  }
  apply_window_region(&window, &[], composited);
  Ok(window)
}

fn snapshot_collapsed_pos_before_hide(app: &AppHandle, window: &WebviewWindow) {
  let pet = app.state::<DesktopPet>();
  let (Ok(pos), Ok(cur_size)) = (window.outer_position(), window.outer_size()) else { return };
  let scale = window.scale_factor().unwrap_or(1.0);
  let monitor = window_monitor(window);
  let area = monitor.as_ref().map(WorkArea::from_monitor);
  let collapsed_size = cap_size(
    LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
  let dock_pos = dock_origin_from_window(pos, cur_size, collapsed_size, geo.dock_side, geo.panel_side);
  let saved = area.map_or(dock_pos, |a| clamp_to_area(dock_pos, collapsed_size, a));
  geo.last_collapsed_pos = Some(saved);
  geo.dock_side = preferred_collapsed_dock_side(saved, collapsed_size, area);
  geo.panel_side = PanelSide::Top;
  geo.current_logical_size = COLLAPSED_SIZE;
  geo.hit_rects.clear();
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
  match action {
    "show" => {
      let window = match app.get_webview_window(PET_LABEL) {
        Some(window) => window,
        None => create(app)?,
      };
      window
        .show()
        .map_err(|_| native_error("Could not show desktop pet"))?;
      let (hit_rects, composited) = {
        let composited = detect_composited(&window);
        let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
        geo.composited = composited;
        (geo.hit_rects.clone(), composited)
      };
      apply_window_region(&window, &hit_rects, composited);
      pet.visible.store(true, Ordering::Release);
    }
    "hide" => {
      // destroy() only queues the native operation. Keep show/hide serialized until
      // Destroyed has removed the old label, so a quick reopen creates a new window.
      let destroyed = pet.destroyed.notified();
      tokio::pin!(destroyed);
      destroyed.as_mut().enable();
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        snapshot_collapsed_pos_before_hide(app, &window);
        window
          .destroy()
          .map_err(|_| native_error("Could not close desktop pet"))?;
        destroyed.await;
      }
      pet.visible.store(false, Ordering::Release);
      pet.expanded.store(false, Ordering::Release);
    }
    "set-expanded" => {
      let expanded = expanded.ok_or_else(|| {
        BridgeError::new("INVALID_ARGUMENT", "expanded is required", "not-sent")
      })?;
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        let (width, height) = if expanded { EXPANDED_SIZE } else { COLLAPSED_SIZE };
        apply_layout(
          app,
          &window,
          PetWindowLayoutRequest {
            width,
            height,
            focus: expanded,
            hit_rects: Vec::new(),
          },
        )?;
      }
    }
    "set-layout" => {
      let req = layout.ok_or_else(|| {
        BridgeError::new("INVALID_ARGUMENT", "layout is required", "not-sent")
      })?;
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        apply_layout(app, &window, req)?;
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
  Ok(publish(app))
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
    WindowEvent::Moved(_) => {
      let app = window.app_handle().clone();
      let seq = {
        let pet = app.state::<DesktopPet>();
        let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
        geo.move_seq = geo.move_seq.wrapping_add(1);
        geo.move_seq
      };
      tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(160)).await;
        let pet = app.state::<DesktopPet>();
        let current_seq = pet.geometry.lock().unwrap_or_else(|e| e.into_inner()).move_seq;
        if current_seq != seq || !pet.visible.load(Ordering::Acquire) {
          return;
        }
        let Some(win) = app.get_webview_window(PET_LABEL) else { return };
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
        let Some(monitor) = window_monitor(&win) else { return };
        let work = WorkArea::from_monitor(&monitor);
        let clamped = clamp_to_area(pos, size, work);
        if clamped != pos {
          let _ = win.set_position(clamped);
        }
        let scale = win.scale_factor().unwrap_or(1.0);
        let collapsed_size = cap_size(
          LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
          Some(work),
        );
        let dock_changed = {
          let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          let dock_pos = dock_origin_from_window(clamped, size, collapsed_size, geo.dock_side, geo.panel_side);
          geo.last_collapsed_pos = Some(clamp_to_area(dock_pos, collapsed_size, work));
          if !pet.expanded.load(Ordering::Acquire) {
            let preferred = preferred_collapsed_dock_side(clamped, collapsed_size, Some(work));
            let changed = preferred != geo.dock_side;
            geo.dock_side = preferred;
            changed
          } else {
            false
          }
        };
        if dock_changed {
          publish(&app);
        }
      });
    }
    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
      let app = window.app_handle();
      if let Some(win) = app.get_webview_window(PET_LABEL) {
        let pet = app.state::<DesktopPet>();
        let (hit_rects, composited) = {
          let geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          (geo.hit_rects.clone(), geo.composited)
        };
        apply_window_region(&win, &hit_rects, composited);
      }
    }
    WindowEvent::Destroyed => {
      let app = window.app_handle();
      crate::pet_voice::cancel_window_jobs(app, PET_LABEL);
      let pet = app.state::<DesktopPet>();
      pet.visible.store(false, Ordering::Release);
      pet.expanded.store(false, Ordering::Release);
      {
        let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
        geo.dock_side = DockSide::Right;
        geo.panel_side = PanelSide::Top;
        geo.current_logical_size = COLLAPSED_SIZE;
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
  const COLLAPSED_1X: PhysicalSize<u32> = PhysicalSize::new(152, 116);
  const PROBE_1X: PhysicalSize<u32> = PhysicalSize::new(448, 480);

  #[test]
  fn dynamic_resize_locks_dock_across_all_four_corners_and_returns_cleanly() {
    let bubble_1x = PhysicalSize::new(370, 320);
    let cases = [
      (PhysicalPosition::new(1752, 908), DockSide::Right, PanelSide::Top),
      (PhysicalPosition::new(20, 908), DockSide::Left, PanelSide::Top),
      (PhysicalPosition::new(1752, 20), DockSide::Right, PanelSide::Bottom),
      (PhysicalPosition::new(20, 20), DockSide::Left, PanelSide::Bottom),
    ];
    for (start, expected_dock, expected_panel) in cases {
      let (pos1, dock1, panel1, exp1, dock_anchor) = plan_dynamic_resize(
        start,
        COLLAPSED_1X,
        COLLAPSED_1X,
        bubble_1x,
        PROBE_1X,
        false,
        DockSide::Right,
        PanelSide::Top,
        Some(WORK_1080),
      );
      assert_eq!((dock1, panel1, exp1, dock_anchor), (expected_dock, expected_panel, true, start));

      // Grow taller while already expanded -> orientation stays locked and dock stays pinned!
      let taller = PhysicalSize::new(430, 480);
      let (pos2, dock2, panel2, exp2, dock_anchor2) = plan_dynamic_resize(
        pos1,
        bubble_1x,
        COLLAPSED_1X,
        taller,
        PROBE_1X,
        true,
        dock1,
        panel1,
        Some(WORK_1080),
      );
      assert_eq!((dock2, panel2, exp2, dock_anchor2), (expected_dock, expected_panel, true, start));

      // Collapse back -> exact original dock position!
      let (back, _, _, exp3, _) = plan_dynamic_resize(
        pos2,
        taller,
        COLLAPSED_1X,
        COLLAPSED_1X,
        PROBE_1X,
        true,
        dock2,
        panel2,
        Some(WORK_1080),
      );
      assert_eq!((back, exp3), (start, false));
    }
  }

  #[test]
  fn dynamic_resize_preserves_drag_delta_when_collapsing() {
    let start = PhysicalPosition::new(40, 40);
    let expanded = PhysicalSize::new(380, 360);
    let (pos1, dock, panel, _, _) = plan_dynamic_resize(
      start,
      COLLAPSED_1X,
      COLLAPSED_1X,
      expanded,
      PROBE_1X,
      false,
      DockSide::Left,
      PanelSide::Top,
      Some(WORK_1080),
    );
    let dragged = PhysicalPosition::new(pos1.x + 120, pos1.y + 80);
    let (collapsed, _, _, exp, _) = plan_dynamic_resize(
      dragged,
      expanded,
      COLLAPSED_1X,
      COLLAPSED_1X,
      PROBE_1X,
      true,
      dock,
      panel,
      Some(WORK_1080),
    );
    assert_eq!(exp, false);
    assert_eq!(collapsed, PhysicalPosition::new(160, 120));
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
}
