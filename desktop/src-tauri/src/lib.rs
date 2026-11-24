pub mod bridge;
pub mod browser_guest;
mod desktop_pet;
#[cfg(target_os = "linux")]
mod clipboard_linux;
pub mod clipboard_runtime;
#[cfg(windows)]
mod clipboard_windows;
#[cfg(any(windows, target_os = "linux"))]
mod desktop_tray;
pub mod host_service;
pub mod image_picker;
pub mod pairing_code;
pub mod pet_voice;
pub mod updates;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, State, Webview, WindowEvent, ipc::Channel, webview::PageLoadEvent};
use tauri_plugin_dialog::DialogExt;

pub use bridge::{BridgeError, DesktopBridge, DesktopObserveAck, DesktopRequestInput, PickedFileRef};
pub use image_picker::{DesktopImagePickSource, PickedImageData};

fn ensure_main_webview(webview: &Webview) -> Result<(), BridgeError> {
  if webview.label() != "main" || webview.window().label() != "main" {
    return Err(BridgeError::new(
      "UNAUTHORIZED",
      "desktop commands are restricted to the main window",
      "not-sent",
    ));
  }
  Ok(())
}

fn is_allowed_navigation(url: &tauri::Url) -> bool {
  match url.scheme() {
    "tauri" => url.host_str() == Some("localhost"),
    "http" if cfg!(windows) && url.host_str() == Some("tauri.localhost") && url.port().is_none() => {
      true
    }
    "http" if cfg!(dev) && url.host_str() == Some("127.0.0.1") && url.port() == Some(1420) => true,
    _ => false,
  }
}

#[tauri::command]
fn desktop_open_center(webview: Webview, url: String) -> Result<(), BridgeError> {
  ensure_main_webview(&webview)?;
  let parsed = tauri::Url::parse(&url).map_err(|_| BridgeError::new("INVALID_ARGUMENT", "invalid center URL", "not-sent"))?;
  if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
    return Err(BridgeError::new("INVALID_ARGUMENT", "center URL must use HTTPS", "not-sent"));
  }
  #[cfg(windows)]
  let result = std::process::Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", parsed.as_str()]).spawn();
  #[cfg(target_os = "macos")]
  let result = std::process::Command::new("/usr/bin/open").arg(parsed.as_str()).spawn();
  #[cfg(not(any(windows, target_os = "macos")))]
  let result = std::process::Command::new("xdg-open").arg(parsed.as_str()).spawn();
  result.map_err(|_| BridgeError::new("INTERNAL", "could not open browser", "not-sent"))?;
  Ok(())
}

#[tauri::command]
async fn desktop_request(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
  clipboard: State<'_, clipboard_runtime::ClipboardRuntime>,
  request: DesktopRequestInput,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  let op = request.op.as_str();
  clipboard.before_broker_request(&app, op);
  let result = bridge.request(&app, op, request.params).await;
  clipboard.after_broker_request(&app, op, result.as_ref().ok());
  result
}

#[tauri::command]
async fn desktop_observe(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
  observation_id: String,
  target_device_id: String,
  target: Value,
  on_event: Channel<Value>,
) -> Result<DesktopObserveAck, BridgeError> {
  ensure_main_webview(&webview)?;
  bridge
    .observe(&app, observation_id, target_device_id, target, on_event)
    .await
}

#[tauri::command]
async fn desktop_unobserve(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
  observation_id: String,
) -> Result<(), BridgeError> {
  ensure_main_webview(&webview)?;
  bridge.unobserve(&app, observation_id).await
}

#[tauri::command]
async fn desktop_pick_file(
  app: AppHandle,
  webview: Webview,
) -> Result<Option<PickedFileRef>, BridgeError> {
  ensure_main_webview(&webview)?;
  let picked = tauri::async_runtime::spawn_blocking(move || {
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
      dialog = dialog.set_parent(&window);
    }
    dialog.blocking_pick_file()
  })
  .await
  .map_err(|_| {
    BridgeError::new(
      "INTERNAL",
      "file dialog worker failed",
      "not-sent",
    )
  })?;

  let Some(file_path) = picked else {
    return Ok(None);
  };

  let raw_path = file_path.into_path().map_err(|_| {
    BridgeError::new(
      "INVALID_ARGUMENT",
      "selected item is not a local filesystem path",
      "not-sent",
    )
  })?;

  bridge::validate_picked_regular_file(&raw_path).map(Some)
}

#[tauri::command]
async fn desktop_pick_images(
  app: AppHandle,
  webview: Webview,
  source: DesktopImagePickSource,
) -> Result<Vec<PickedImageData>, BridgeError> {
  ensure_main_webview(&webview)?;
  image_picker::pick_images(app, source).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavigationGuardConfig {
  pub main_label: String,
}

async fn close_browser_window(app: &AppHandle, guest_ids: Vec<String>) {
  browser_guest::close_drained_guests(app, guest_ids);
  let bridge = app.state::<DesktopBridge>().inner().clone();
  bridge.notify_browser_window_close().await;
}

fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[cfg(any(windows, target_os = "linux"))]
fn quit_from_tray(app: &AppHandle) {
  let Some(guest_ids) = browser_guest::begin_window_close(app) else {
    return;
  };
  app.state::<clipboard_runtime::ClipboardRuntime>().begin_explicit_quit();
  desktop_tray::shutdown(app);
  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    close_browser_window(&app, guest_ids).await;
    app.exit(0);
  });
}

pub fn run() {
  let bridge = DesktopBridge::new();
  let builder = tauri::Builder::default()
    // Register single-instance first so secondary launches exit before other plugins initialize.
    .plugin(tauri_plugin_single_instance::init(|app, _, _| show_main_window(app)))
    .manage(bridge)
    .manage(browser_guest::BrowserGuests::default())
    .manage(updates::UpdateState::default())
    .manage(clipboard_runtime::ClipboardRuntime::new())
    .manage(host_service::HostStartup::default())
    .manage(desktop_pet::DesktopPet::default())
    .manage(pet_voice::PetVoiceState::default())
    .on_window_event(|window, event| {
      if window.label() == desktop_pet::PET_LABEL {
        desktop_pet::on_window_event(window, event);
        return;
      }
      if window.label() != "main" {
        return;
      }
      if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        #[cfg(any(windows, target_os = "linux"))]
        if !app.state::<updates::UpdateState>().blocks_close_to_tray()
          && desktop_tray::can_close_to_tray(app)
          && window.hide().is_ok()
        {
          api.prevent_close();
          return;
        }
        api.prevent_close();
        let Some(guest_ids) = browser_guest::begin_window_close(app) else {
          return;
        };
        let app = app.clone();
        let window = window.clone();
        tauri::async_runtime::spawn(async move {
          close_browser_window(&app, guest_ids).await;
          desktop_pet::shutdown(&app).await;
          let _ = window.destroy();
        });
      }
    })
    // Reload/navigation kills every observer Channel owned by the old
    // document; evict them before the new page's JS installs its watches.
    .on_page_load(|webview, payload| {
      if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
        webview.state::<DesktopBridge>().evict_page_observers();
        browser_guest::hide_all(webview.app_handle());
      }
    })
    .plugin(
      tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard")
        .on_navigation(|webview, url| {
          (webview.label() == "main" && is_allowed_navigation(url))
            || (webview.label() == desktop_pet::PET_LABEL && desktop_pet::permits(url))
            || browser_guest::permits(webview.app_handle(), webview.label(), url)
        })
        .build(),
    )
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .setup(|app| {
      browser_guest::start_watchdog(app.handle().clone());
      host_service::start_configured_host(app.handle());
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("Pi Bot");
        window.set_icon(tauri::include_image!("../build/icons/icon.png"))?;
        #[cfg(windows)]
        {
          let hwnd = window.hwnd()?.0 as usize;
          // Tao updates ICON_SMALL only; the Windows taskbar uses ICON_BIG.
          window.run_on_main_thread(move || unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
              SendMessageW, ICON_BIG, ICON_SMALL, WM_GETICON, WM_SETICON,
            };
            let icon = SendMessageW(hwnd as _, WM_GETICON, ICON_SMALL as usize, 0);
            SendMessageW(hwnd as _, WM_SETICON, ICON_BIG as usize, icon);
          })?;
        }
      }
      #[cfg(any(windows, target_os = "linux"))]
      if let Err(error) = desktop_tray::install(app.handle()) {
        eprintln!("Failed to create the PiBot system tray: {error}");
      }
      desktop_pet::restore_if_enabled(app.handle());
      Ok(())
    });

  let app = builder
    .invoke_handler(tauri::generate_handler![
      desktop_request,
      desktop_pet::desktop_pet,
      pet_voice::desktop_pet_voice,
      browser_guest::desktop_browser_guest,
      desktop_open_center,
      desktop_observe,
      desktop_unobserve,
      desktop_pick_file,
      desktop_pick_images,
      host_service::desktop_host_status,
      host_service::desktop_browser_local_route,
      host_service::desktop_host_pair,
      host_service::desktop_host_pair_code,
      host_service::desktop_host_connect_local,
      host_service::desktop_host_adopt,
      host_service::desktop_host_control,
      updates::desktop_update_status,
      updates::desktop_update_check,
      updates::desktop_update_download,
      updates::desktop_update_install,
      updates::desktop_update_cancel,
      clipboard_runtime::desktop_clipboard_sync,
    ])
    .build(tauri::generate_context!())
    .expect("failed to build pibot desktop application");

  app.run(|app_handle, event| {
    if matches!(event, RunEvent::Exit) {
      pet_voice::cancel_window_jobs(app_handle, "pet");
      pet_voice::cancel_window_jobs(app_handle, "main");
      app_handle
        .state::<clipboard_runtime::ClipboardRuntime>()
        .shutdown(app_handle);
      #[cfg(any(windows, target_os = "linux"))]
      desktop_tray::shutdown(app_handle);
      app_handle.state::<DesktopBridge>().shutdown();
    }
  });
}
