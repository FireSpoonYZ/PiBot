#![cfg(target_os = "linux")]

//! Linux desktop clipboard adapter for PiBot clipboard sync.
//!
//! Runtime backend selection (zero UI focus stealing, regular `CLIPBOARD` only — never `PRIMARY`):
//! - In a Wayland session (`WAYLAND_DISPLAY` set or `XDG_SESSION_TYPE=wayland`), probes native
//!   `ext-data-control` / `wlr-data-control` via `wl-clipboard-rs`. If the compositor does not
//!   expose either protocol, returns `io::ErrorKind::Unsupported` directly rather than claiming
//!   XWayland mirroring provides bidirectional clipboard sync.
//! - In an X11 session (`DISPLAY` set and not Wayland), probes native X11 `CLIPBOARD` + `XFixes`.
//! - Otherwise returns `io::ErrorKind::Unsupported`.

mod fd_util;
mod mime;
mod wayland;
mod x11;

use std::io;
use std::sync::Arc;

use clipboard_sync::{eligible_text, MAX_TEXT_BYTES};

enum Backend {
  Wayland(wayland::WaylandClipboard),
  X11(x11::X11Clipboard),
}

pub(crate) struct SystemClipboard {
  backend: Backend,
}

const _: fn() = || {
  fn assert_send_sync<T: Send + Sync>() {}
  assert_send_sync::<SystemClipboard>();
};

impl SystemClipboard {
  pub(crate) fn start(on_copy: impl Fn(String) + Send + Sync + 'static) -> io::Result<Self> {
    let on_copy: Arc<dyn Fn(String) + Send + Sync + 'static> = Arc::new(on_copy);

    if is_wayland_session() {
      let backend = wayland::WaylandClipboard::start(on_copy)?;
      return Ok(Self {
        backend: Backend::Wayland(backend),
      });
    }

    if has_x11_display() {
      let backend = x11::X11Clipboard::start(on_copy)?;
      return Ok(Self {
        backend: Backend::X11(backend),
      });
    }

    Err(io::Error::new(
      io::ErrorKind::Unsupported,
      "no supported Wayland data-control or X11 XFixes clipboard backend available",
    ))
  }

  pub(crate) fn write(&self, text: &str) -> io::Result<()> {
    if text.len() > MAX_TEXT_BYTES || !eligible_text(text, false) {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "clipboard text is not eligible for sync",
      ));
    }

    match &self.backend {
      Backend::Wayland(w) => w.write(text),
      Backend::X11(x) => x.write(text),
    }
  }
}

impl Drop for SystemClipboard {
  fn drop(&mut self) {
    match &self.backend {
      Backend::Wayland(w) => w.stop(),
      Backend::X11(x) => x.stop(),
    }
  }
}

fn is_wayland_session() -> bool {
  if std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty()) {
    return true;
  }
  std::env::var("XDG_SESSION_TYPE")
    .map(|v| v.eq_ignore_ascii_case("wayland"))
    .unwrap_or(false)
}

fn has_x11_display() -> bool {
  std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty())
}
