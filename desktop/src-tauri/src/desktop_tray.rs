//! Application-owned native tray for Windows and Linux.

use std::{
  sync::{Mutex, atomic::{AtomicBool, Ordering}},
  time::Duration,
};

use tauri::{
  AppHandle, Manager,
  menu::{Menu, MenuBuilder, MenuItem, Submenu},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::clipboard_runtime::{ClipboardRuntime, ConnectionState};

const TRAY_ID: &str = "pibot-tray";
const OPEN_ID: &str = "pibot_tray_open";
const PET_ID: &str = "pibot_tray_pet";
const QUIT_ID: &str = "pibot_tray_quit";
const CLIPBOARD_ID: &str = "pibot_tray_clipboard";
const PAUSE_ID: &str = "clipboard_tray_pause";
const RESUME_ID: &str = "clipboard_tray_resume";

struct DesktopTray {
  quitting: AtomicBool,
  menu: Menu<tauri::Wry>,
  clipboard: Submenu<tauri::Wry>,
  status: MenuItem<tauri::Wry>,
  pause: MenuItem<tauri::Wry>,
  resume: MenuItem<tauri::Wry>,
  displayed: Mutex<Option<(ConnectionState, bool)>>,
}

impl DesktopTray {
  /// Called on the main thread so native menu mutations stay ordered.
  fn refresh_clipboard(&self, next: Option<(ConnectionState, bool)>) -> tauri::Result<()> {
    let mut displayed = self.displayed.lock().unwrap_or_else(|e| e.into_inner());
    if *displayed == next || self.quitting.load(Ordering::Acquire) {
      return Ok(());
    }
    if let Some((connection, paused)) = next {
      let label = match connection {
        ConnectionState::Off => "Clipboard sync: paused",
        ConnectionState::Connecting => "Clipboard sync: connecting",
        ConnectionState::Online => "Clipboard sync: online",
        ConnectionState::NotPaired | ConnectionState::Unauthorized => "Clipboard sync: not authorized",
        ConnectionState::CertificateError => "Clipboard sync: certificate error",
        ConnectionState::Unsupported => "Clipboard sync: upgrade Center",
        ConnectionState::DisplayUnsupported => "Clipboard sync: unsupported display",
        ConnectionState::GroupFull => "Clipboard sync: group full",
        ConnectionState::Replaced => "Clipboard sync: replaced by this device ID",
        ConnectionState::Offline => "Clipboard sync: offline",
      };
      self.status.set_text(label)?;
      self.pause.set_enabled(!paused)?;
      self.resume.set_enabled(paused)?;
      if self.menu.get(CLIPBOARD_ID).is_none() {
        self.menu.insert(&self.clipboard, 1)?;
      }
    } else if self.menu.get(CLIPBOARD_ID).is_some() {
      self.menu.remove(&self.clipboard)?;
    }
    *displayed = next;
    Ok(())
  }
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
  if app.tray_by_id(TRAY_ID).is_some() {
    return Ok(());
  }
  #[cfg(target_os = "linux")]
  if !probe_linux_tray_available() {
    return Ok(());
  }

  let menu = MenuBuilder::new(app)
    .text(OPEN_ID, "Open PiBot")
    .text(PET_ID, "Show / Hide desktop pet")
    .text(QUIT_ID, "Quit Client")
    .build()?;
  let status = MenuItem::new(app, "Clipboard sync: connecting", false, None::<&str>)?;
  let pause = MenuItem::with_id(app, PAUSE_ID, "Pause clipboard sync", true, None::<&str>)?;
  let resume = MenuItem::with_id(app, RESUME_ID, "Resume clipboard sync", false, None::<&str>)?;
  let clipboard = Submenu::with_id_and_items(
    app, CLIPBOARD_ID, "Clipboard sync", true, &[&status, &pause, &resume],
  )?;

  TrayIconBuilder::with_id(TRAY_ID)
    .icon(tauri::include_image!("../build/icons/icon.png"))
    .tooltip("PiBot")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| {
      let Some(tray) = app.try_state::<DesktopTray>() else { return };
      if tray.quitting.load(Ordering::Acquire) {
        return;
      }
      match event.id().as_ref() {
        OPEN_ID => crate::show_main_window(app),
        PET_ID => {
          let app = app.clone();
          tauri::async_runtime::spawn(async move {
            if crate::desktop_pet::control(&app, "toggle", None).await.is_err() {
              crate::show_main_window(&app);
            }
          });
        }
        QUIT_ID => {
          if !tray.quitting.swap(true, Ordering::AcqRel) {
            crate::quit_from_tray(app);
          }
        }
        id @ (PAUSE_ID | RESUME_ID) => {
          let enabled = id == RESUME_ID;
          let app = app.clone();
          tauri::async_runtime::spawn(async move {
            if app.state::<ClipboardRuntime>().set_enabled_from_tray(&app, enabled).await.is_err() {
              crate::show_main_window(&app);
            }
          });
        }
        _ => {}
      }
    })
    .on_tray_icon_event(|tray, event| {
      if matches!(
        event,
        TrayIconEvent::Click {
          button: MouseButton::Left,
          button_state: MouseButtonState::Up,
          ..
        } | TrayIconEvent::DoubleClick {
          button: MouseButton::Left,
          ..
        }
      ) && can_close_to_tray(tray.app_handle()) {
        crate::show_main_window(tray.app_handle());
      }
    })
    .build(app)?;

  app.manage(DesktopTray {
    quitting: AtomicBool::new(false),
    menu,
    clipboard,
    status,
    pause,
    resume,
    displayed: Mutex::new(None),
  });

  let app = app.clone();
  tauri::async_runtime::spawn(async move {
    while !app.state::<DesktopTray>().quitting.load(Ordering::Acquire) {
      let handle = app.clone();
      if app.run_on_main_thread(move || {
        let next = handle.state::<ClipboardRuntime>().tray_status();
        // Keep the last successful state so a failed native menu update is retried.
        let _ = handle.state::<DesktopTray>().refresh_clipboard(next);
      }).is_err() {
        break;
      }
      tokio::time::sleep(Duration::from_secs(1)).await;
    }
  });
  Ok(())
}

pub fn can_close_to_tray(app: &AppHandle) -> bool {
  app.try_state::<DesktopTray>()
    .is_some_and(|tray| !tray.quitting.load(Ordering::Acquire))
    && app.tray_by_id(TRAY_ID).is_some()
}

pub fn shutdown(app: &AppHandle) {
  if let Some(tray) = app.try_state::<DesktopTray>() {
    tray.quitting.store(true, Ordering::Release);
  }
  drop(app.remove_tray_by_id(TRAY_ID));
}

#[cfg(target_os = "linux")]
fn probe_linux_tray_available() -> bool {
  // 1. Confirm ayatana-appindicator3 or appindicator3 is present so libappindicator-sys
  //    cannot panic on the GTK main thread.
  let has_appindicator = unsafe {
    let try_open = |name: &[u8]| -> bool {
      let handle = libc::dlopen(
        name.as_ptr().cast::<libc::c_char>(),
        libc::RTLD_LAZY | libc::RTLD_LOCAL,
      );
      if !handle.is_null() {
        libc::dlclose(handle);
        true
      } else {
        false
      }
    };
    try_open(b"libayatana-appindicator3.so.1\0") || try_open(b"libappindicator3.so.1\0")
  };
  if !has_appindicator {
    return false;
  }

  // 2. Confirm a real StatusNotifierHost is registered on the session D-Bus
  //    so close-to-tray never traps the user on desktops without a visible tray.
  use gtk::gio::{self, BusType, Cancellable, DBusCallFlags};
  use gtk::glib::variant::ToVariant;

  let Ok(conn) = gio::bus_get_sync(BusType::Session, Cancellable::NONE) else {
    return false;
  };
  let params = (
    "org.kde.StatusNotifierWatcher",
    "IsStatusNotifierHostRegistered",
  )
    .to_variant();
  let Ok(reply) = conn.call_sync(
    Some("org.kde.StatusNotifierWatcher"),
    "/StatusNotifierWatcher",
    "org.freedesktop.DBus.Properties",
    "Get",
    Some(&params),
    None,
    DBusCallFlags::NO_AUTO_START,
    500,
    Cancellable::NONE,
  ) else {
    return false;
  };
  if reply.n_children() < 1 {
    return false;
  }
  reply
    .child_value(0)
    .as_variant()
    .and_then(|v| v.get::<bool>())
    == Some(true)
}
