pub mod bridge;
pub mod host_service;
pub mod updates;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, State, Webview, ipc::Channel};
use tauri_plugin_dialog::DialogExt;

pub use bridge::{BridgeError, DesktopBridge, DesktopObserveAck, DesktopRequestInput, PickedFileRef};

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
  #[cfg(not(windows))]
  let result = std::process::Command::new("xdg-open").arg(parsed.as_str()).spawn();
  result.map_err(|_| BridgeError::new("INTERNAL", "could not open browser", "not-sent"))?;
  Ok(())
}

#[tauri::command]
async fn desktop_request(
  app: AppHandle,
  webview: Webview,
  bridge: State<'_, DesktopBridge>,
  request: DesktopRequestInput,
) -> Result<Value, BridgeError> {
  ensure_main_webview(&webview)?;
  bridge
    .request(&app, &request.op, request.params)
    .await
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NavigationGuardConfig {
  pub main_label: String,
}

pub fn run() {
  let bridge = DesktopBridge::new();
  let mut builder = tauri::Builder::default()
    .manage(bridge)
    .manage(updates::UpdateState::default())
    .plugin(
      tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard")
        .on_navigation(|webview, url| webview.label() == "main" && is_allowed_navigation(url))
        .build(),
    )
    .plugin(tauri_plugin_dialog::init());
  if let Some(pubkey) = updates::configured_pubkey() {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().pubkey(pubkey).build());
  }
  let app = builder
    .setup(|app| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("e-助手");
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
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      desktop_request,
      desktop_open_center,
      desktop_observe,
      desktop_unobserve,
      desktop_pick_file,
      host_service::desktop_host_status,
      host_service::desktop_host_pair,
      host_service::desktop_host_adopt,
      host_service::desktop_host_control,
      updates::desktop_update_status,
      updates::desktop_update_check,
      updates::desktop_update_download,
      updates::desktop_update_install,
      updates::desktop_update_cancel,
    ])
    .build(tauri::generate_context!())
    .expect("failed to build e-launcher desktop application");

  app.run(|app_handle, event| {
    if matches!(event, RunEvent::Exit) {
      app_handle.state::<DesktopBridge>().shutdown();
    }
  });
}
