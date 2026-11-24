//! Lightweight local pet window. The main webview owns all bot/broker state.
use std::{
  sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
  },
  time::Duration,
};

use serde::Serialize;
use tauri::{
  webview::{NewWindowResponse, PermissionKind, PermissionResponse},
  AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
  Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use crate::BridgeError;

pub const PET_LABEL: &str = "pet";
const WINDOW_EVENT: &str = "pibot:pet-window";
const COLLAPSED_SIZE: (f64, f64) = (132.0, 138.0);
const EXPANDED_SIZE: (f64, f64) = (380.0, 560.0);
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
const STAGE_PADDING: f64 = 6.0;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const STAGE_GAP: f64 = 4.0;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DOCK_WIDTH: f64 = 120.0;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DOCK_HEIGHT: f64 = 126.0;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const CHAT_RADIUS: i32 = 18;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const DOCK_RADIUS: i32 = 20;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExpandAnchor {
  collapsed_pos: PhysicalPosition<i32>,
  expanded_pos: PhysicalPosition<i32>,
  dock_side: DockSide,
  panel_side: PanelSide,
}

struct PetGeometry {
  dock_side: DockSide,
  panel_side: PanelSide,
  composited: bool,
  last_collapsed_pos: Option<PhysicalPosition<i32>>,
  expand_anchor: Option<ExpandAnchor>,
  move_seq: u64,
}

impl Default for PetGeometry {
  fn default() -> Self {
    Self {
      dock_side: DockSide::Right,
      panel_side: PanelSide::Top,
      composited: true,
      last_collapsed_pos: None,
      expand_anchor: None,
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

fn plan_expand(
  collapsed_pos: PhysicalPosition<i32>,
  collapsed_size: PhysicalSize<u32>,
  expanded_size: PhysicalSize<u32>,
  area: Option<WorkArea>,
) -> (PhysicalPosition<i32>, DockSide, PanelSide) {
  let (dock_side, panel_side) = if let Some(area) = area {
    let extra_w = expanded_size.width.saturating_sub(collapsed_size.width) as i32;
    let extra_h = expanded_size.height.saturating_sub(collapsed_size.height) as i32;
    let room_left = collapsed_pos.x - area.x;
    let room_right = (area.x + area.width as i32) - (collapsed_pos.x + collapsed_size.width as i32);
    let room_above = collapsed_pos.y - area.y;
    let room_below = (area.y + area.height as i32) - (collapsed_pos.y + collapsed_size.height as i32);

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
  } else {
    (DockSide::Right, PanelSide::Top)
  };

  let raw_x = match dock_side {
    DockSide::Right => collapsed_pos.x + collapsed_size.width as i32 - expanded_size.width as i32,
    DockSide::Left => collapsed_pos.x,
  };
  let raw_y = match panel_side {
    PanelSide::Top => collapsed_pos.y + collapsed_size.height as i32 - expanded_size.height as i32,
    PanelSide::Bottom => collapsed_pos.y,
  };
  let raw = PhysicalPosition::new(raw_x, raw_y);
  let pos = area.map_or(raw, |a| clamp_to_area(raw, expanded_size, a));
  (pos, dock_side, panel_side)
}

fn plan_collapse(
  current_pos: PhysicalPosition<i32>,
  expanded_size: PhysicalSize<u32>,
  collapsed_size: PhysicalSize<u32>,
  anchor: Option<ExpandAnchor>,
  dock_side: DockSide,
  panel_side: PanelSide,
  area: Option<WorkArea>,
) -> PhysicalPosition<i32> {
  let raw = if let Some(anchor) = anchor {
    let dx = current_pos.x - anchor.expanded_pos.x;
    let dy = current_pos.y - anchor.expanded_pos.y;
    if dx.abs() <= 2 && dy.abs() <= 2 {
      anchor.collapsed_pos
    } else {
      PhysicalPosition::new(anchor.collapsed_pos.x + dx, anchor.collapsed_pos.y + dy)
    }
  } else {
    let x = match dock_side {
      DockSide::Right => current_pos.x + expanded_size.width as i32 - collapsed_size.width as i32,
      DockSide::Left => current_pos.x,
    };
    let y = match panel_side {
      PanelSide::Top => current_pos.y + expanded_size.height as i32 - collapsed_size.height as i32,
      PanelSide::Bottom => current_pos.y,
    };
    PhysicalPosition::new(x, y)
  };
  area.map_or(raw, |a| clamp_to_area(raw, collapsed_size, a))
}

/// Interactive hit-test rectangles for the expanded window (with shadow margin)
/// so the empty corner beside the mascot dock stays completely click-through.
#[cfg_attr(not(any(windows, target_os = "linux")), allow(dead_code))]
fn expanded_hit_rects(
  width: i32,
  height: i32,
  dock_w: i32,
  dock_h: i32,
  pad: i32,
  dock_side: DockSide,
  panel_side: PanelSide,
) -> [RectI; 2] {
  let dw = dock_w.clamp(1, width.max(1));
  let dh = dock_h.clamp(1, height.max(1));
  let dock_x = match dock_side {
    DockSide::Right => (width - dw).max(0),
    DockSide::Left => 0,
  };
  match panel_side {
    PanelSide::Top => {
      let chat_h = (height - dh + pad).clamp(1, height.max(1));
      let dock_y = (height - dh - pad).max(0);
      [
        RectI { x: 0, y: 0, width: width.max(1), height: chat_h },
        RectI { x: dock_x, y: dock_y, width: dw, height: (height - dock_y).max(1) },
      ]
    }
    PanelSide::Bottom => {
      let dock_band_h = (dh + pad).clamp(1, height.max(1));
      let chat_y = (dh - pad).max(0);
      [
        RectI { x: dock_x, y: 0, width: dw, height: dock_band_h },
        RectI { x: 0, y: chat_y, width: width.max(1), height: (height - chat_y).max(1) },
      ]
    }
  }
}

/// Tight visible card + dock rectangles (logical coordinates) used for non-composited
/// X11 shape masks where transparent pixels would otherwise paint solid black.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn non_composited_card_rects(
  width: i32,
  height: i32,
  expanded: bool,
  dock_side: DockSide,
  panel_side: PanelSide,
) -> Vec<(RectI, i32)> {
  let pad = STAGE_PADDING as i32;
  let gap = STAGE_GAP as i32;
  let dw = (DOCK_WIDTH as i32).min((width - pad * 2).max(1));
  let dh = (DOCK_HEIGHT as i32).min((height - pad * 2).max(1));
  if !expanded {
    return vec![(
      RectI { x: pad, y: pad, width: dw, height: dh },
      DOCK_RADIUS,
    )];
  }
  let chat_w = (width - pad * 2).max(1);
  let chat_h = (height - pad * 2 - dh - gap).max(1);
  let dock_x = match dock_side {
    DockSide::Right => (width - pad - dw).max(pad),
    DockSide::Left => pad,
  };
  match panel_side {
    PanelSide::Top => vec![
      (RectI { x: pad, y: pad, width: chat_w, height: chat_h }, CHAT_RADIUS),
      (RectI { x: dock_x, y: height - pad - dh, width: dw, height: dh }, DOCK_RADIUS),
    ],
    PanelSide::Bottom => vec![
      (RectI { x: dock_x, y: pad, width: dw, height: dh }, DOCK_RADIUS),
      (RectI { x: pad, y: pad + dh + gap, width: chat_w, height: chat_h }, CHAT_RADIUS),
    ],
  }
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
  expanded: bool,
  dock_side: DockSide,
  panel_side: PanelSide,
  composited: bool,
) {
  #[cfg(windows)]
  {
    let _ = composited;
    let Ok(hwnd_raw) = window.hwnd() else { return };
    let hwnd = hwnd_raw.0 as usize;
    let Ok(size) = window.outer_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let dock_w = (COLLAPSED_SIZE.0 * scale).round() as i32;
    let dock_h = (COLLAPSED_SIZE.1 * scale).round() as i32;
    let pad = (STAGE_PADDING * scale).round() as i32;
    let rects = expanded.then(|| {
      expanded_hit_rects(
        size.width as i32,
        size.height as i32,
        dock_w,
        dock_h,
        pad,
        dock_side,
        panel_side,
      )
    });
    let _ = window.run_on_main_thread(move || unsafe {
      use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
      };
      if let Some([a, b]) = rects {
        let r1 = CreateRectRgn(a.x, a.y, a.x + a.width, a.y + a.height);
        let r2 = CreateRectRgn(b.x, b.y, b.x + b.width, b.y + b.height);
        let combined = CreateRectRgn(0, 0, 0, 0);
        if !r1.is_null() && !r2.is_null() && !combined.is_null() {
          CombineRgn(combined, r1, r2, RGN_OR);
          DeleteObject(r1);
          DeleteObject(r2);
          // Windows takes ownership of `combined` on success.
          if SetWindowRgn(hwnd as _, combined, 1) == 0 {
            DeleteObject(combined);
          }
        } else {
          if !r1.is_null() { DeleteObject(r1); }
          if !r2.is_null() { DeleteObject(r2); }
          if !combined.is_null() { DeleteObject(combined); }
        }
      } else {
        SetWindowRgn(hwnd as _, std::ptr::null_mut(), 1);
      }
    });
  }

  #[cfg(target_os = "linux")]
  {
    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
    let (logical_w, logical_h) = window
      .outer_size()
      .map(|s| ((s.width as f64 / scale).round() as i32, (s.height as f64 / scale).round() as i32))
      .unwrap_or_else(|_| {
        let (w, h) = if expanded { EXPANDED_SIZE } else { COLLAPSED_SIZE };
        (w as i32, h as i32)
      });
    let win_clone = window.clone();
    let _ = window.run_on_main_thread(move || {
      use gtk::cairo::{RectangleInt, Region};
      use gtk::prelude::WidgetExt;
      let Ok(gtk_win) = win_clone.gtk_window() else { return };
      if !composited {
        let shape = Region::create();
        for (rect, radius) in non_composited_card_rects(logical_w, logical_h, expanded, dock_side, panel_side) {
          for span in rounded_rect_scanlines(rect, radius) {
            let _ = shape.union_rectangle(&RectangleInt::new(span.x, span.y, span.width, span.height));
          }
        }
        gtk_win.shape_combine_region(Some(&shape));
        gtk_win.input_shape_combine_region(Some(&shape));
      } else if expanded {
        let input = Region::create();
        let rects = expanded_hit_rects(
          logical_w,
          logical_h,
          COLLAPSED_SIZE.0 as i32,
          COLLAPSED_SIZE.1 as i32,
          STAGE_PADDING as i32,
          dock_side,
          panel_side,
        );
        for r in rects {
          let _ = input.union_rectangle(&RectangleInt::new(r.x, r.y, r.width, r.height));
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
    let _ = (window, expanded, dock_side, panel_side, composited);
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

fn resize(app: &AppHandle, window: &WebviewWindow, expanded: bool) -> Result<(), BridgeError> {
  let pet = app.state::<DesktopPet>();
  if pet.expanded.load(Ordering::Acquire) == expanded {
    if expanded {
      let _ = window.set_focus();
    }
    return Ok(());
  }

  let old_position = window.outer_position().ok();
  let scale = window
    .scale_factor()
    .map_err(|_| native_error("Could not read pet window scale"))?;
  let monitor = window_monitor(window);
  let area = monitor.as_ref().map(WorkArea::from_monitor);
  let collapsed_size = cap_size(
    LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let expanded_size = cap_size(
    LogicalSize::new(EXPANDED_SIZE.0, EXPANDED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let composited = detect_composited(window);

  let (target_size, next_pos, dock_side, panel_side) = {
    let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.composited = composited;
    if expanded {
      let collapsed_pos = old_position
        .or(geo.last_collapsed_pos)
        .unwrap_or_else(|| PhysicalPosition::new(0, 0));
      let collapsed_pos = area.map_or(collapsed_pos, |a| clamp_to_area(collapsed_pos, collapsed_size, a));
      let (expanded_pos, dock_side, panel_side) =
        plan_expand(collapsed_pos, collapsed_size, expanded_size, area);
      geo.dock_side = dock_side;
      geo.panel_side = panel_side;
      geo.last_collapsed_pos = Some(collapsed_pos);
      geo.expand_anchor = Some(ExpandAnchor {
        collapsed_pos,
        expanded_pos,
        dock_side,
        panel_side,
      });
      (expanded_size, Some(expanded_pos), dock_side, panel_side)
    } else {
      let anchor = geo.expand_anchor.take();
      let cur_dock = geo.dock_side;
      let cur_panel = geo.panel_side;
      let collapsed_pos = old_position.map(|current_pos| {
        plan_collapse(
          current_pos,
          expanded_size,
          collapsed_size,
          anchor,
          cur_dock,
          cur_panel,
          area,
        )
      }).or(geo.last_collapsed_pos);
      if let Some(pos) = collapsed_pos {
        geo.last_collapsed_pos = Some(pos);
      }
      geo.dock_side = DockSide::Right;
      geo.panel_side = PanelSide::Top;
      (collapsed_size, collapsed_pos, DockSide::Right, PanelSide::Top)
    }
  };

  // Clear previous region before changing window dimensions so no frames clip against stale bounds.
  #[cfg(windows)]
  apply_window_region(window, false, dock_side, panel_side, composited);

  pet.expanded.store(expanded, Ordering::Release);
  apply_linux_size_lock(window, None);
  window
    .set_size(target_size)
    .map_err(|_| native_error("Could not resize desktop pet"))?;
  apply_linux_size_lock(window, Some(target_size));
  if let Some(next) = next_pos {
    // Native Wayland compositors may own placement; resizing and native dragging still work.
    let _ = window.set_position(next);
  }
  apply_window_region(window, expanded, dock_side, panel_side, composited);
  if expanded {
    window
      .set_focus()
      .map_err(|_| native_error("Could not focus desktop pet"))?;
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
  if let Some(monitor) = monitor {
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = cap_size(
      LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
      Some(WorkArea::from_monitor(&monitor)),
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
    apply_linux_size_lock(&window, None);
    let _ = window.set_size(size);
    apply_linux_size_lock(&window, Some(size));
    let _ = window.set_position(clamped);
  }

  {
    let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
    geo.dock_side = DockSide::Right;
    geo.panel_side = PanelSide::Top;
    geo.composited = composited;
    geo.expand_anchor = None;
    if let Some(pos) = initial_pos {
      geo.last_collapsed_pos = Some(pos);
    }
  }
  apply_window_region(&window, false, DockSide::Right, PanelSide::Top, composited);
  Ok(window)
}

fn snapshot_collapsed_pos_before_hide(app: &AppHandle, window: &WebviewWindow) {
  let pet = app.state::<DesktopPet>();
  let Ok(pos) = window.outer_position() else { return };
  let scale = window.scale_factor().unwrap_or(1.0);
  let monitor = window_monitor(window);
  let area = monitor.as_ref().map(WorkArea::from_monitor);
  let collapsed_size = cap_size(
    LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let expanded_size = cap_size(
    LogicalSize::new(EXPANDED_SIZE.0, EXPANDED_SIZE.1).to_physical::<u32>(scale),
    area,
  );
  let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
  let saved = if pet.expanded.load(Ordering::Acquire) {
    plan_collapse(
      pos,
      expanded_size,
      collapsed_size,
      geo.expand_anchor,
      geo.dock_side,
      geo.panel_side,
      area,
    )
  } else {
    area.map_or(pos, |a| clamp_to_area(pos, collapsed_size, a))
  };
  geo.last_collapsed_pos = Some(saved);
  geo.expand_anchor = None;
  geo.dock_side = DockSide::Right;
  geo.panel_side = PanelSide::Top;
}

/// All mutations share one short operation lock; window creation runs off the UI event callback.
pub async fn control(
  app: &AppHandle,
  action: &str,
  expanded: Option<bool>,
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
      let (is_expanded, dock_side, panel_side, composited) = {
        let composited = detect_composited(&window);
        let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
        geo.composited = composited;
        (pet.expanded.load(Ordering::Acquire), geo.dock_side, geo.panel_side, composited)
      };
      apply_window_region(&window, is_expanded, dock_side, panel_side, composited);
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
        resize(app, &window, expanded)?;
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
) -> Result<DesktopPetWindowState, BridgeError> {
  let label = webview.label();
  if !matches!(label, "main" | PET_LABEL) || webview.window().label() != label {
    return Err(BridgeError::new(
      "UNAUTHORIZED",
      "desktop pet commands require a local app window",
      "not-sent",
    ));
  }
  control(&app, &action, expanded).await
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
        let clamped = clamp_position(pos, size, &monitor);
        if clamped != pos {
          let _ = win.set_position(clamped);
        }
        if !pet.expanded.load(Ordering::Acquire) {
          let mut geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          geo.last_collapsed_pos = Some(clamped);
        }
      });
    }
    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
      let app = window.app_handle();
      if let Some(win) = app.get_webview_window(PET_LABEL) {
        let pet = app.state::<DesktopPet>();
        let (expanded, dock_side, panel_side, composited) = {
          let geo = pet.geometry.lock().unwrap_or_else(|e| e.into_inner());
          (pet.expanded.load(Ordering::Acquire), geo.dock_side, geo.panel_side, geo.composited)
        };
        apply_window_region(&win, expanded, dock_side, panel_side, composited);
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
        geo.expand_anchor = None;
        geo.dock_side = DockSide::Right;
        geo.panel_side = PanelSide::Top;
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
  const COLLAPSED_1X: PhysicalSize<u32> = PhysicalSize::new(132, 138);
  const EXPANDED_1X: PhysicalSize<u32> = PhysicalSize::new(380, 560);

  #[test]
  fn expand_and_collapse_at_top_left_has_zero_teleportation() {
    let start = PhysicalPosition::new(40, 40);
    let (expanded_pos, dock_side, panel_side) =
      plan_expand(start, COLLAPSED_1X, EXPANDED_1X, Some(WORK_1080));
    assert_eq!(dock_side, DockSide::Left);
    assert_eq!(panel_side, PanelSide::Bottom);
    // Mascot dock stays pinned at (40, 40) while chat opens below and to the right.
    assert_eq!(expanded_pos, PhysicalPosition::new(40, 40));

    let anchor = ExpandAnchor { collapsed_pos: start, expanded_pos, dock_side, panel_side };
    let collapsed_pos = plan_collapse(
      expanded_pos,
      EXPANDED_1X,
      COLLAPSED_1X,
      Some(anchor),
      dock_side,
      panel_side,
      Some(WORK_1080),
    );
    assert_eq!(collapsed_pos, start);
  }

  #[test]
  fn expand_and_collapse_at_all_four_corners_keeps_dock_pinned() {
    let cases = [
      (PhysicalPosition::new(1772, 886), DockSide::Right, PanelSide::Top, PhysicalPosition::new(1524, 464)),
      (PhysicalPosition::new(20, 886), DockSide::Left, PanelSide::Top, PhysicalPosition::new(20, 464)),
      (PhysicalPosition::new(1772, 20), DockSide::Right, PanelSide::Bottom, PhysicalPosition::new(1524, 20)),
      (PhysicalPosition::new(0, 0), DockSide::Left, PanelSide::Bottom, PhysicalPosition::new(0, 0)),
    ];
    for (start, expected_dock, expected_panel, expected_expanded) in cases {
      let (expanded_pos, dock, panel) =
        plan_expand(start, COLLAPSED_1X, EXPANDED_1X, Some(WORK_1080));
      assert_eq!((dock, panel, expanded_pos), (expected_dock, expected_panel, expected_expanded));
      let anchor = ExpandAnchor { collapsed_pos: start, expanded_pos, dock_side: dock, panel_side: panel };
      let back = plan_collapse(
        expanded_pos,
        EXPANDED_1X,
        COLLAPSED_1X,
        Some(anchor),
        dock,
        panel,
        Some(WORK_1080),
      );
      assert_eq!(back, start);
    }
  }

  #[test]
  fn collapse_preserves_drag_delta_and_clamps_to_work_area() {
    let start = PhysicalPosition::new(40, 40);
    let (expanded_pos, dock, panel) =
      plan_expand(start, COLLAPSED_1X, EXPANDED_1X, Some(WORK_1080));
    let anchor = ExpandAnchor { collapsed_pos: start, expanded_pos, dock_side: dock, panel_side: panel };

    // Drag expanded window by (+120, +80)
    let dragged = PhysicalPosition::new(expanded_pos.x + 120, expanded_pos.y + 80);
    let collapsed = plan_collapse(
      dragged,
      EXPANDED_1X,
      COLLAPSED_1X,
      Some(anchor),
      dock,
      panel,
      Some(WORK_1080),
    );
    assert_eq!(collapsed, PhysicalPosition::new(160, 120));

    // Drag far off top-left -> clamps back inside work area
    let offscreen = PhysicalPosition::new(-200, -300);
    let clamped = plan_collapse(
      offscreen,
      EXPANDED_1X,
      COLLAPSED_1X,
      Some(anchor),
      dock,
      panel,
      Some(WORK_1080),
    );
    assert_eq!(clamped, PhysicalPosition::new(0, 0));
  }

  #[test]
  fn expanded_hit_rects_exclude_empty_corner_for_every_layout() {
    let in_rect = |r: RectI, x: i32, y: i32| x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
    let hits = |rects: [RectI; 2], x: i32, y: i32| in_rect(rects[0], x, y) || in_rect(rects[1], x, y);

    let br = expanded_hit_rects(380, 560, 132, 138, 6, DockSide::Right, PanelSide::Top);
    assert!(hits(br, 190, 200)); // chat card
    assert!(hits(br, 320, 500)); // dock
    assert!(!hits(br, 60, 500)); // bottom-left dead zone excluded

    let tl = expanded_hit_rects(380, 560, 132, 138, 6, DockSide::Left, PanelSide::Bottom);
    assert!(hits(tl, 60, 60));   // top-left dock
    assert!(hits(tl, 200, 350)); // bottom chat card
    assert!(!hits(tl, 300, 60)); // top-right dead zone excluded
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
