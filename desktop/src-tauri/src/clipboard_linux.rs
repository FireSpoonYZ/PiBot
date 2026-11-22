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

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clipboard_sync::{eligible_text, MAX_TEXT_BYTES};
use sha2::{Digest, Sha256};

// Bound retries when a compositor stops answering the blocking observer handshake.
static OBSERVER_STARTUP: Mutex<()> = Mutex::new(());

const ECHO_WINDOW: Duration = Duration::from_secs(2);
const MAX_RECENT_WRITES: usize = 8;
type RecentWrites = VecDeque<([u8; 32], Instant)>;

enum Backend {
  Wayland(wayland::WaylandClipboard),
  X11(x11::X11Clipboard),
}

pub(crate) struct SystemClipboard {
  backend: Backend,
  recent_writes: Arc<Mutex<RecentWrites>>,
}

const _: fn() = || {
  fn assert_send_sync<T: Send + Sync>() {}
  assert_send_sync::<SystemClipboard>();
};

impl SystemClipboard {
  pub(crate) fn has_graphical_session() -> bool {
    is_wayland_session() || has_x11_display()
  }

  pub(crate) fn start(
    on_copy: impl Fn(String) + Send + Sync + 'static,
    on_stopped: impl FnOnce() + Send + 'static,
  ) -> io::Result<Self> {
    let recent_writes = Arc::new(Mutex::new(RecentWrites::new()));
    let observed_writes = Arc::clone(&recent_writes);
    let on_copy: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |text| {
      let digest: [u8; 32] = Sha256::digest(text.as_bytes()).into();
      let echoed = observed_writes.lock().unwrap_or_else(|e| e.into_inner()).iter()
        .any(|(prior, start)| *prior == digest && start.elapsed() <= ECHO_WINDOW);
      if !echoed {
        on_copy(text);
      }
    });

    let backend = if is_wayland_session() {
      Backend::Wayland(wayland::WaylandClipboard::start(on_copy, on_stopped)?)
    } else if has_x11_display() {
      Backend::X11(x11::X11Clipboard::start(on_copy, on_stopped)?)
    } else {
      return Err(io::Error::new(io::ErrorKind::Unsupported, "no Linux graphical session"));
    };
    Ok(Self { backend, recent_writes })
  }

  pub(crate) fn write(&self, text: &str) -> io::Result<()> {
    if text.len() > MAX_TEXT_BYTES || !eligible_text(text, false) {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "clipboard text is not eligible for sync",
      ));
    }

    // A clipboard manager may re-offer text without preserving the native origin marker.
    let write = (Sha256::digest(text.as_bytes()).into(), Instant::now());
    {
      let mut recent = self.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
      if recent.len() == MAX_RECENT_WRITES {
        recent.pop_front();
      }
      recent.push_back(write);
    }
    let result = match &self.backend {
      Backend::Wayland(w) => w.write(text),
      Backend::X11(x) => x.write(text),
    };
    let mut recent = self.recent_writes.lock().unwrap_or_else(|e| e.into_inner());
    recent.retain(|entry| *entry != write);
    if result.is_ok() {
      recent.push_back((write.0, Instant::now()));
    }
    result
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
