//! Native Wayland clipboard backend using `wl-clipboard-rs` 0.9.5 (`ext-data-control` /
//! `wlr-data-control`). Operates without creating any Wayland surface or stealing UI focus,
//! watches only the regular clipboard (never PRIMARY), and serves writes natively until
//! superseded by another selection.

use std::io;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use clipboard_sync::{eligible_text, MAX_TEXT_BYTES};
use wl_clipboard_rs::copy::{self as wl_copy, Error as CopyError};
use wl_clipboard_rs::paste::{
  ClipboardType as PasteClipboardType, Error as PasteError, Seat as PasteSeat,
};
use wl_clipboard_rs::watch::{
  CancelHandle, ClipboardEvent, ClipboardType as WatchClipboardType, Watcher,
};

use super::fd_util::{self, WakePipe, Waker};
use super::mime::{
  self, MIME_TEXT_PLAIN_UTF8, ORIGIN_MARKER_MIME, ORIGIN_MARKER_VALUE,
};

static COPY_STARTUP: Mutex<()> = Mutex::new(());

const START_TIMEOUT: Duration = Duration::from_secs(3);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_millis(1500);
/// `Watcher::new` executes a roundtrip that buffers any pre-existing selection offer before
/// the first `next_event()` call. Ignoring a first offer that returns within this tiny startup
/// window baselines existing clipboard contents without swallowing later real copies on
/// compositors that omit an initial empty `Selection(None)` event.
const BASELINE_GRACE: Duration = Duration::from_millis(150);

pub(crate) struct WaylandClipboard {
  cancel: CancelHandle,
  stop_flag: Arc<AtomicBool>,
  stop_waker: Waker,
  worker: Mutex<Option<JoinHandle<()>>>,
}

impl WaylandClipboard {
  pub(crate) fn start(
    on_copy: Arc<dyn Fn(String) + Send + Sync + 'static>,
    on_stopped: impl FnOnce() + Send + 'static,
  ) -> io::Result<Self> {
    let wake_pipe = WakePipe::new()?;
    let stop_waker = wake_pipe.waker();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (init_tx, init_rx) = mpsc::sync_channel::<io::Result<CancelHandle>>(1);

    let worker_stop = Arc::clone(&stop_flag);
    let handle = thread::Builder::new()
      .name("pibot-clip-wl-watch".to_string())
      .spawn(move || {
        let Ok(startup) = super::OBSERVER_STARTUP.try_lock() else {
          let _ = init_tx.send(Err(io::Error::new(io::ErrorKind::WouldBlock, "clipboard observer is starting")));
          return;
        };
        let mut watcher =
          match Watcher::new(WatchClipboardType::Regular, PasteSeat::Unspecified) {
            Ok(w) => w,
            Err(err) => {
              let _ = init_tx.send(Err(map_paste_error_for_start(err)));
              return;
            }
          };

        drop(startup);
        let cancel = watcher.cancel_handle();
        if init_tx.send(Ok(cancel)).is_err() {
          return;
        }

        watch_loop(&mut watcher, &wake_pipe, &worker_stop, &on_copy);
        if !worker_stop.swap(true, Ordering::AcqRel) {
          on_stopped();
        }
      })
      .map_err(|err| io::Error::new(err.kind(), "failed to spawn Wayland clipboard watcher"))?;

    match init_rx.recv_timeout(START_TIMEOUT) {
      Ok(Ok(cancel)) => Ok(Self {
        cancel,
        stop_flag,
        stop_waker,
        worker: Mutex::new(Some(handle)),
      }),
      Ok(Err(err)) => {
        let _ = handle.join();
        Err(err)
      }
      Err(RecvTimeoutError::Timeout) => {
        stop_flag.store(true, Ordering::Release);
        stop_waker.wake();
        Err(io::Error::new(
          io::ErrorKind::TimedOut,
          "timed out probing Wayland data-control clipboard",
        ))
      }
      Err(RecvTimeoutError::Disconnected) => {
        let _ = handle.join();
        Err(io::Error::new(
          io::ErrorKind::BrokenPipe,
          "Wayland clipboard watcher failed to initialize",
        ))
      }
    }
  }

  /// Writes `text` natively via `ext-data-control`/`wlr-data-control`, tagging the offer with
  /// [`ORIGIN_MARKER_MIME`] so our watcher (and marker-preserving managers) never echo it back.
  ///
  /// The detached serving thread stays alive until the compositor sends `Event::Cancelled`
  /// (when replaced by another copy or a subsequent `write`), so clipboard contents remain
  /// pasteable even after `SystemClipboard` is dropped.
  pub(crate) fn write(&self, text: &str) -> io::Result<()> {
    let text_bytes: Box<[u8]> = text.as_bytes().to_vec().into_boxed_slice();
    let marker_bytes: Box<[u8]> = ORIGIN_MARKER_VALUE.to_vec().into_boxed_slice();
    let sources = vec![
      wl_copy::MimeSource {
        source: wl_copy::Source::Bytes(text_bytes),
        mime_type: wl_copy::MimeType::Specific(MIME_TEXT_PLAIN_UTF8.to_string()),
      },
      wl_copy::MimeSource {
        source: wl_copy::Source::Bytes(marker_bytes),
        mime_type: wl_copy::MimeType::Specific(ORIGIN_MARKER_MIME.to_string()),
      },
    ];

    let (tx, rx) = mpsc::sync_channel::<io::Result<()>>(1);
    thread::Builder::new()
      .name("pibot-clip-wl-serve".to_string())
      .spawn(move || {
        let Ok(startup) = COPY_STARTUP.try_lock() else {
          let _ = tx.send(Err(io::Error::new(io::ErrorKind::WouldBlock, "Wayland clipboard writer is starting")));
          return;
        };
        let mut opts = wl_copy::Options::new();
        opts
          .clipboard(wl_copy::ClipboardType::Regular)
          .seat(wl_copy::Seat::All)
          .foreground(true)
          .serve_requests(wl_copy::ServeRequests::Unlimited)
          .omit_additional_text_mime_types(false);

        let prepared = opts.prepare_copy_multi(sources);
        drop(startup);
        match prepared {
          Ok(prepared) => {
            if tx.send(Ok(())).is_ok() {
              // Serves paste requests until the compositor cancels all data sources.
              let _ = prepared.serve();
            }
          }
          Err(err) => {
            let _ = tx.send(Err(map_copy_error(err)));
          }
        }
      })
      .map_err(|err| io::Error::new(err.kind(), "failed to spawn Wayland clipboard writer"))?;

    match rx.recv_timeout(WRITE_TIMEOUT) {
      Ok(result) => result,
      Err(RecvTimeoutError::Timeout) => Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "timed out writing to Wayland clipboard",
      )),
      Err(RecvTimeoutError::Disconnected) => Err(io::Error::new(
        io::ErrorKind::Other,
        "Wayland clipboard writer exited unexpectedly",
      )),
    }
  }

  /// Stops observation and joins the watcher thread without clearing the user's clipboard.
  pub(crate) fn stop(&self) {
    self.stop_flag.store(true, Ordering::Release);
    self.cancel.cancel();
    self.stop_waker.wake();

    let handle = self
      .worker
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .take();
    if let Some(handle) = handle {
      if handle.thread().id() != thread::current().id() {
        let _ = handle.join();
      }
    }
  }
}

fn watch_loop(
  watcher: &mut Watcher,
  wake_pipe: &WakePipe,
  stop_flag: &AtomicBool,
  on_copy: &Arc<dyn Fn(String) + Send + Sync + 'static>,
) {
  let mut baseline_settled = false;
  let first_wait_at = Instant::now();

  while !stop_flag.load(Ordering::Acquire) {
    let event = match watcher.next_event() {
      Ok(Some(ev)) => ev,
      Ok(None) | Err(_) => break,
    };

    if stop_flag.load(Ordering::Acquire) {
      break;
    }

    if !baseline_settled {
      baseline_settled = true;
      match &event {
        ClipboardEvent::Cleared { .. } => continue,
        ClipboardEvent::Changed { .. } if first_wait_at.elapsed() <= BASELINE_GRACE => {
          continue;
        }
        ClipboardEvent::Changed { .. } => {}
      }
    }

    let ClipboardEvent::Changed {
      clipboard,
      mime_types,
      mut offer,
    } = event
    else {
      continue;
    };

    if clipboard != PasteClipboardType::Regular {
      continue;
    }
    if mime::has_origin_marker(&mime_types) {
      continue;
    }
    if mime::has_concealed_mime(&mime_types) {
      continue;
    }
    if mime::has_file_copy_mime(&mime_types) {
      continue;
    }

    let Some((selected_mime, encoding)) = mime::pick_plain_text_mime(&mime_types) else {
      continue;
    };

    let pipe_reader = match offer.receive(selected_mime) {
      Ok(reader) => reader,
      Err(PasteError::WaylandCommunication(_)) => break,
      Err(_) => continue,
    };
    drop(offer);

    let raw_bytes = fd_util::read_fd_bounded(
      pipe_reader.as_raw_fd(),
      wake_pipe.read_raw_fd(),
      stop_flag,
      MAX_TEXT_BYTES,
      READ_TIMEOUT,
    );
    drop(pipe_reader);

    let Some(bytes) = raw_bytes else {
      continue;
    };
    let Some(text) = mime::decode_text_bytes(bytes, encoding, MAX_TEXT_BYTES) else {
      continue;
    };
    if !eligible_text(&text, false) {
      continue;
    }
    if stop_flag.load(Ordering::Acquire) {
      break;
    }
    on_copy(text);
  }
}

fn map_paste_error_for_start(err: PasteError) -> io::Error {
  match err {
    PasteError::MissingProtocol { .. } => io::Error::new(
      io::ErrorKind::Unsupported,
      "Wayland compositor does not expose ext-data-control or wlr-data-control clipboard protocol",
    ),
    PasteError::NoSeats | PasteError::SeatNotFound => io::Error::new(
      io::ErrorKind::NotConnected,
      "Wayland compositor has no active seat for clipboard access",
    ),
    PasteError::PrimarySelectionUnsupported => io::Error::new(
      io::ErrorKind::Unsupported,
      "Wayland clipboard protocol feature is unsupported",
    ),
    PasteError::WaylandConnection(_) | PasteError::SocketOpenError(_) => io::Error::new(
      io::ErrorKind::NotConnected,
      "unable to connect to Wayland compositor for clipboard access",
    ),
    PasteError::WaylandCommunication(_) => io::Error::new(
      io::ErrorKind::BrokenPipe,
      "Wayland clipboard communication failed",
    ),
    PasteError::PipeCreation(io_err) => io_err,
    PasteError::ClipboardEmpty | PasteError::NoMimeType => io::Error::new(
      io::ErrorKind::Other,
      "unexpected Wayland clipboard initialization state",
    ),
  }
}

fn map_copy_error(err: CopyError) -> io::Error {
  match err {
    CopyError::MissingProtocol { .. } => io::Error::new(
      io::ErrorKind::Unsupported,
      "Wayland compositor does not expose ext-data-control or wlr-data-control clipboard protocol",
    ),
    CopyError::NoSeats | CopyError::SeatNotFound => io::Error::new(
      io::ErrorKind::NotConnected,
      "Wayland compositor has no active seat for clipboard write",
    ),
    CopyError::PrimarySelectionUnsupported => io::Error::new(
      io::ErrorKind::Unsupported,
      "Wayland clipboard protocol feature is unsupported",
    ),
    CopyError::WaylandConnection(_) | CopyError::SocketOpenError(_) => io::Error::new(
      io::ErrorKind::NotConnected,
      "unable to connect to Wayland compositor for clipboard write",
    ),
    CopyError::WaylandCommunication(_)
    | CopyError::TempCopy(_)
    | CopyError::TempFileRemove(_)
    | CopyError::TempDirRemove(_)
    | CopyError::Paste(_) => io::Error::new(
      io::ErrorKind::Other,
      "failed to write to Wayland clipboard",
    ),
  }
}
