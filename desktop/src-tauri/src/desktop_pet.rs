//! Lightweight local pet window. The main webview owns all bot/broker state.
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{
  webview::{NewWindowResponse, PermissionKind, PermissionResponse},
  AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
  Webview, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use crate::BridgeError;

pub const PET_LABEL: &str = "pet";
const WINDOW_EVENT: &str = "pibot:pet-window";
const COLLAPSED_SIZE: (f64, f64) = (132.0, 148.0);
const EXPANDED_SIZE: (f64, f64) = (380.0, 560.0);

#[derive(Default)]
pub struct DesktopPet {
  visible: AtomicBool,
  expanded: AtomicBool,
  operation: tokio::sync::Mutex<()>,
  destroyed: tokio::sync::Notify,
}

#[derive(Clone, Copy, Serialize)]
pub struct DesktopPetWindowState {
  visible: bool,
  expanded: bool,
}

fn state(app: &AppHandle) -> DesktopPetWindowState {
  let pet = app.state::<DesktopPet>();
  DesktopPetWindowState {
    visible: pet.visible.load(Ordering::Acquire),
    expanded: pet.expanded.load(Ordering::Acquire),
  }
}

fn publish(app: &AppHandle) -> DesktopPetWindowState {
  let next = state(app);
  let _ = app.emit_to("main", WINDOW_EVENT, next);
  let _ = app.emit_to(PET_LABEL, WINDOW_EVENT, next);
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

fn clamp_position(
  position: PhysicalPosition<i32>,
  size: PhysicalSize<u32>,
  monitor: &Monitor,
) -> PhysicalPosition<i32> {
  let area = monitor.work_area();
  let max_x = area.position.x + area.size.width.saturating_sub(size.width) as i32;
  let max_y = area.position.y + area.size.height.saturating_sub(size.height) as i32;
  PhysicalPosition::new(
    position.x.clamp(area.position.x, max_x),
    position.y.clamp(area.position.y, max_y),
  )
}

fn window_monitor(window: &WebviewWindow) -> Option<Monitor> {
  window.current_monitor().ok().flatten()
    .or_else(|| window.primary_monitor().ok().flatten())
}

fn resize(window: &WebviewWindow, expanded: bool) -> Result<(), BridgeError> {
  let old_position = window.outer_position().ok();
  let old_size = window.outer_size().ok();
  let scale = window.scale_factor().map_err(|_| native_error("Could not read pet window scale"))?;
  let (width, height) = if expanded { EXPANDED_SIZE } else { COLLAPSED_SIZE };
  let mut size = LogicalSize::new(width, height).to_physical::<u32>(scale);
  let monitor = window_monitor(window);
  if let Some(monitor) = &monitor {
    let area = monitor.work_area();
    size.width = size.width.min(area.size.width);
    size.height = size.height.min(area.size.height);
  }
  window.set_size(size).map_err(|_| native_error("Could not resize desktop pet"))?;
  if let (Some(position), Some(previous)) = (old_position, old_size) {
    let anchored = PhysicalPosition::new(
      position.x + previous.width as i32 - size.width as i32,
      position.y + previous.height as i32 - size.height as i32,
    );
    let next = monitor.as_ref().map_or(anchored, |m| clamp_position(anchored, size, m));
    // Native Wayland compositors may own placement; resizing and native dragging still work.
    let _ = window.set_position(next);
  }
  if expanded {
    window.set_focus().map_err(|_| native_error("Could not focus desktop pet"))?;
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
  let monitor = app.get_webview_window("main")
    .and_then(|main| window_monitor(&main))
    .or_else(|| window_monitor(&window));
  if let Some(monitor) = monitor {
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1).to_physical::<u32>(scale);
    let margin = (16.0 * scale).round() as i32;
    let position = PhysicalPosition::new(
      area.position.x + area.size.width as i32 - size.width as i32 - margin,
      area.position.y + area.size.height as i32 - size.height as i32 - margin,
    );
    let _ = window.set_size(size);
    let _ = window.set_position(clamp_position(position, size, &monitor));
  }
  Ok(window)
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
  } else { action };
  match action {
    "show" => {
      let window = match app.get_webview_window(PET_LABEL) {
        Some(window) => window,
        None => create(app)?,
      };
      window.show().map_err(|_| native_error("Could not show desktop pet"))?;
      pet.visible.store(true, Ordering::Release);
    }
    "hide" => {
      // destroy() only queues the native operation. Keep show/hide serialized until
      // Destroyed has removed the old label, so a quick reopen creates a new window.
      let destroyed = pet.destroyed.notified();
      tokio::pin!(destroyed);
      destroyed.as_mut().enable();
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        window.destroy().map_err(|_| native_error("Could not close desktop pet"))?;
        destroyed.await;
      }
      pet.visible.store(false, Ordering::Release);
      pet.expanded.store(false, Ordering::Release);
    }
    "set-expanded" => {
      let expanded = expanded.ok_or_else(|| BridgeError::new(
        "INVALID_ARGUMENT", "expanded is required", "not-sent",
      ))?;
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        resize(&window, expanded)?;
        pet.expanded.store(expanded, Ordering::Release);
      }
    }
    "show-main" => crate::show_main_window(app),
    "drag" => {
      if let Some(window) = app.get_webview_window(PET_LABEL) {
        window.start_dragging().map_err(|_| native_error("Could not drag desktop pet"))?;
      }
    }
    "status" => return Ok(state(app)),
    _ => return Err(BridgeError::new("INVALID_ARGUMENT", "Unknown desktop pet action", "not-sent")),
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
      "UNAUTHORIZED", "desktop pet commands require a local app window", "not-sent",
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
    WindowEvent::Destroyed => {
      let app = window.app_handle();
      crate::pet_voice::cancel_window_jobs(app, PET_LABEL);
      let pet = app.state::<DesktopPet>();
      pet.visible.store(false, Ordering::Release);
      pet.expanded.store(false, Ordering::Release);
      publish(app);
      pet.destroyed.notify_waiters();
    }
    _ => {}
  }
}
