//! Native X11 clipboard backend using `x11rb` + `XFixes` on the `CLIPBOARD` selection
//! (never `PRIMARY`).
//!
//! Architecture:
//! - Observer worker owns a dedicated X11 connection and unmapped `InputOnly` window (zero UI
//!   focus steal), subscribes to `XFixesSelectSelectionInput(CLIPBOARD, SET_SELECTION_OWNER)`,
//!   ignores pre-existing baseline contents, inspects `TARGETS` for concealed/origin/file-copy
//!   markers before fetching text, and reads both single-shot and `INCR` transfers under strict
//!   byte (`MAX_TEXT_BYTES`) and time (`READ_TIMEOUT`) bounds.
//! - Selection owner runs on a separate on-demand X11 owner thread (reused across consecutive
//!   `write()` calls and exiting automatically upon `SelectionClear`). Dropping
//!   `SystemClipboard` stops and joins only the observer worker without clearing `CLIPBOARD`,
//!   so synced text stays available for paste even on X11 sessions without a `CLIPBOARD_MANAGER`.

use std::collections::VecDeque;
use std::io;
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use clipboard_sync::{eligible_text, MAX_TEXT_BYTES};
use x11rb::connection::{Connection as _, RequestConnection as _};
use x11rb::protocol::xfixes::{self, SelectionEvent as XfixesSelectionEvent, SelectionEventMask};
use x11rb::protocol::xproto::{
  self, Atom, AtomEnum, ChangeWindowAttributesAux, CreateWindowAux, EventMask, PropMode, Property,
  SelectionNotifyEvent, SelectionRequestEvent, Timestamp, Window, WindowClass,
  SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{COPY_DEPTH_FROM_PARENT, COPY_FROM_PARENT, CURRENT_TIME, NONE};

use super::fd_util::{self, WakePipe, Waker};
use super::mime::{
  self, TextEncoding, CONCEALED_MIMES, FILE_COPY_MIMES, MIME_TEXT, MIME_TEXT_PLAIN,
  MIME_TEXT_PLAIN_UTF8, MIME_TEXT_PLAIN_UTF8_SPACED, MIME_UTF8_STRING, ORIGIN_MARKER_MIME,
  ORIGIN_MARKER_VALUE,
};

const START_TIMEOUT: Duration = Duration::from_secs(3);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const READ_TIMEOUT: Duration = Duration::from_millis(1500);
const INCR_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TARGETS_WORDS: u32 = 4096;
const MAX_PROPERTY_LONGS: u32 = ((MAX_TEXT_BYTES + 4) / 4) as u32;
const MAX_ACTIVE_INCR_SENDS: usize = 8;

/// Window ID currently serving our written X11 `CLIPBOARD` selection, or `0` when none.
static ACTIVE_OWNER_WINDOW: AtomicU32 = AtomicU32::new(0);
static NEXT_OWNER_ID: AtomicU64 = AtomicU64::new(1);
/// Short-held mutex guarding only handle lookup/swap (never held across I/O or channel waits).
static ACTIVE_OWNER: Mutex<Option<OwnerHandle>> = Mutex::new(None);
/// Serializes concurrent `write()` callers cleanly without conflicting with owner cleanup.
static WRITE_SERIALIZE: Mutex<()> = Mutex::new(());

#[derive(Clone)]
struct OwnerHandle {
  id: u64,
  tx: mpsc::SyncSender<OwnerCmd>,
  waker: Waker,
}

enum OwnerCmd {
  Update {
    text: String,
    reply: mpsc::SyncSender<io::Result<()>>,
  },
}

struct Atoms {
  clipboard: Atom,
  targets: Atom,
  timestamp: Atom,
  utf8_string: Atom,
  text_plain_utf8: Atom,
  text_plain_utf8_spaced: Atom,
  text_plain: Atom,
  text: Atom,
  incr: Atom,
  pibot_prop: Atom,
  timestamp_prop: Atom,
  origin_marker: Atom,
  concealed: Vec<Atom>,
  file_copy: Vec<Atom>,
}

impl Atoms {
  fn intern(conn: &RustConnection) -> io::Result<Self> {
    let mut concealed = Vec::with_capacity(CONCEALED_MIMES.len());
    for name in CONCEALED_MIMES {
      concealed.push(intern_atom(conn, name)?);
    }
    let mut file_copy = Vec::with_capacity(FILE_COPY_MIMES.len());
    for name in FILE_COPY_MIMES {
      file_copy.push(intern_atom(conn, name)?);
    }

    Ok(Self {
      clipboard: intern_atom(conn, "CLIPBOARD")?,
      targets: intern_atom(conn, "TARGETS")?,
      timestamp: intern_atom(conn, "TIMESTAMP")?,
      utf8_string: intern_atom(conn, MIME_UTF8_STRING)?,
      text_plain_utf8: intern_atom(conn, MIME_TEXT_PLAIN_UTF8)?,
      text_plain_utf8_spaced: intern_atom(conn, MIME_TEXT_PLAIN_UTF8_SPACED)?,
      text_plain: intern_atom(conn, MIME_TEXT_PLAIN)?,
      text: intern_atom(conn, MIME_TEXT)?,
      incr: intern_atom(conn, "INCR")?,
      pibot_prop: intern_atom(conn, "PIBOT_CLIPBOARD_PROP")?,
      timestamp_prop: intern_atom(conn, "PIBOT_CLIPBOARD_TIMESTAMP")?,
      origin_marker: intern_atom(conn, ORIGIN_MARKER_MIME)?,
      concealed,
      file_copy,
    })
  }
}

fn intern_atom(conn: &RustConnection, name: &str) -> io::Result<Atom> {
  xproto::intern_atom(conn, false, name.as_bytes())
    .map_err(|_| io::Error::new(io::ErrorKind::Other, "X11 intern_atom request failed"))?
    .reply()
    .map(|reply| reply.atom)
    .map_err(|_| io::Error::new(io::ErrorKind::Other, "X11 intern_atom reply failed"))
}

fn create_hidden_window(conn: &RustConnection, screen_num: usize) -> io::Result<Window> {
  let root = conn
    .setup()
    .roots
    .get(screen_num)
    .ok_or_else(|| io::Error::new(io::ErrorKind::Unsupported, "X11 screen is unavailable"))?
    .root;
  let window = conn
    .generate_id()
    .map_err(|_| io::Error::new(io::ErrorKind::Other, "failed to allocate X11 window id"))?;
  let aux = CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE);
  xproto::create_window(
    conn,
    COPY_DEPTH_FROM_PARENT,
    window,
    root,
    0,
    0,
    1,
    1,
    0,
    WindowClass::INPUT_ONLY,
    COPY_FROM_PARENT,
    &aux,
  )
  .map_err(|_| io::Error::new(io::ErrorKind::Other, "failed to create hidden X11 window"))?
  .check()
  .map_err(|_| io::Error::new(io::ErrorKind::Other, "X11 server rejected hidden window"))?;
  Ok(window)
}

pub(crate) struct X11Clipboard {
  stop_flag: Arc<AtomicBool>,
  stop_waker: Waker,
  worker: Mutex<Option<JoinHandle<()>>>,
}

impl X11Clipboard {
  pub(crate) fn start(
    on_copy: Arc<dyn Fn(String) + Send + Sync + 'static>,
  ) -> io::Result<Self> {
    let wake_pipe = WakePipe::new()?;
    let stop_waker = wake_pipe.waker();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let (init_tx, init_rx) = mpsc::sync_channel::<io::Result<()>>(1);

    let worker_stop = Arc::clone(&stop_flag);
    let handle = thread::Builder::new()
      .name("pibot-clip-x11-watch".to_string())
      .spawn(move || {
        let (conn, screen_num) = match RustConnection::connect(None) {
          Ok(pair) => pair,
          Err(_) => {
            let _ = init_tx.send(Err(io::Error::new(
              io::ErrorKind::Unsupported,
              "unable to connect to X11 display for clipboard access",
            )));
            return;
          }
        };

        let xfixes_ok = xfixes::query_version(&conn, 1, 0)
          .and_then(|cookie| cookie.reply().map_err(|_| x11rb::errors::ConnectionError::UnsupportedExtension))
          .map(|reply| reply.major_version >= 1)
          .unwrap_or(false);
        if !xfixes_ok {
          let _ = init_tx.send(Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "X11 XFixes extension is not available",
          )));
          return;
        }

        let window = match create_hidden_window(&conn, screen_num) {
          Ok(w) => w,
          Err(err) => {
            let _ = init_tx.send(Err(err));
            return;
          }
        };

        let atoms = match Atoms::intern(&conn) {
          Ok(a) => a,
          Err(err) => {
            let _ = xproto::destroy_window(&conn, window);
            let _ = conn.flush();
            let _ = init_tx.send(Err(err));
            return;
          }
        };

        // Subscribe strictly to CLIPBOARD owner changes (never PRIMARY).
        // XFixes does not emit an event for pre-existing ownership, naturally baselining
        // whatever was already in the clipboard before `start()`.
        let subscribed = xfixes::select_selection_input(
          &conn,
          window,
          atoms.clipboard,
          SelectionEventMask::SET_SELECTION_OWNER,
        )
        .and_then(|cookie| cookie.check().map_err(|_| x11rb::errors::ConnectionError::UnsupportedExtension))
        .is_ok();
        if !subscribed {
          let _ = xproto::destroy_window(&conn, window);
          let _ = conn.flush();
          let _ = init_tx.send(Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "X11 server rejected XFixes CLIPBOARD selection subscription",
          )));
          return;
        }

        // Roundtrip to ensure the subscription is live before reporting startup success.
        if xproto::get_selection_owner(&conn, atoms.clipboard)
          .and_then(|cookie| cookie.reply().map_err(|_| x11rb::errors::ConnectionError::UnknownError))
          .is_err()
        {
          let _ = xproto::destroy_window(&conn, window);
          let _ = conn.flush();
          let _ = init_tx.send(Err(io::Error::new(
            io::ErrorKind::Other,
            "X11 clipboard initialization roundtrip failed",
          )));
          return;
        }

        if init_tx.send(Ok(())).is_err() {
          let _ = xproto::destroy_window(&conn, window);
          let _ = conn.flush();
          return;
        }

        observer_loop(&conn, window, &atoms, &wake_pipe, &worker_stop, &on_copy);

        let _ = xproto::destroy_window(&conn, window);
        let _ = conn.flush();
      })
      .map_err(|err| io::Error::new(err.kind(), "failed to spawn X11 clipboard watcher"))?;

    match init_rx.recv_timeout(START_TIMEOUT) {
      Ok(Ok(())) => Ok(Self {
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
          "timed out probing X11 XFixes clipboard",
        ))
      }
      Err(RecvTimeoutError::Disconnected) => {
        let _ = handle.join();
        Err(io::Error::new(
          io::ErrorKind::Unsupported,
          "X11 clipboard watcher failed to initialize",
        ))
      }
    }
  }

  pub(crate) fn write(&self, text: &str) -> io::Result<()> {
    write_x11_clipboard(text)
  }

  /// Stops observation and joins the observer worker without clearing `CLIPBOARD`.
  pub(crate) fn stop(&self) {
    self.stop_flag.store(true, Ordering::Release);
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

enum ReadOutcome {
  Delivered,
  Ignored,
  Superseded(xfixes::SelectionNotifyEvent),
  Stopped,
}

fn is_external_clipboard_copy(
  ev: &xfixes::SelectionNotifyEvent,
  atoms: &Atoms,
  observer_window: Window,
) -> bool {
  ev.selection == atoms.clipboard
    && ev.subtype == XfixesSelectionEvent::SET_SELECTION_OWNER
    && ev.owner != NONE
    && ev.owner != observer_window
    && ev.owner != ACTIVE_OWNER_WINDOW.load(Ordering::Acquire)
}

fn observer_loop(
  conn: &RustConnection,
  window: Window,
  atoms: &Atoms,
  wake_pipe: &WakePipe,
  stop_flag: &AtomicBool,
  on_copy: &Arc<dyn Fn(String) + Send + Sync + 'static>,
) {
  let x11_fd = conn.stream().as_raw_fd();
  let wake_fd = wake_pipe.read_raw_fd();
  let mut pending_notify: Option<xfixes::SelectionNotifyEvent> = None;

  while !stop_flag.load(Ordering::Acquire) {
    let next_ev = if let Some(ev) = pending_notify.take() {
      Some(ev)
    } else {
      let mut latest: Option<xfixes::SelectionNotifyEvent> = None;
      loop {
        match conn.poll_for_event() {
          Ok(Some(Event::XfixesSelectionNotify(ev))) => {
            if ev.selection == atoms.clipboard
              && ev.subtype == XfixesSelectionEvent::SET_SELECTION_OWNER
            {
              if is_external_clipboard_copy(&ev, atoms, window) {
                latest = Some(ev);
              } else {
                // Clipboard was cleared or taken by our own owner; drop any queued older event.
                latest = None;
              }
            }
          }
          Ok(Some(_)) => {}
          Ok(None) => break,
          Err(_) => return,
        }
      }
      latest
    };

    if let Some(ev) = next_ev {
      match handle_selection_change(conn, window, atoms, &ev, wake_pipe, stop_flag, on_copy) {
        Ok(ReadOutcome::Superseded(newer)) => {
          pending_notify = Some(newer);
          continue;
        }
        Ok(ReadOutcome::Stopped) => break,
        Ok(ReadOutcome::Delivered | ReadOutcome::Ignored) => continue,
        Err(_) => break,
      }
    }

    if conn.flush().is_err() {
      break;
    }

    let outcome = match fd_util::poll_two(x11_fd, wake_fd, None) {
      Ok(o) => o,
      Err(_) => break,
    };
    if outcome.wake_ready {
      wake_pipe.drain();
      if stop_flag.load(Ordering::Acquire) {
        break;
      }
    }
    if outcome.primary_error && !outcome.primary_ready {
      break;
    }
  }
}

fn handle_selection_change(
  conn: &RustConnection,
  window: Window,
  atoms: &Atoms,
  ev: &xfixes::SelectionNotifyEvent,
  wake_pipe: &WakePipe,
  stop_flag: &AtomicBool,
  on_copy: &Arc<dyn Fn(String) + Send + Sync + 'static>,
) -> Result<ReadOutcome, ()> {
  if !is_external_clipboard_copy(ev, atoms, window) {
    return Ok(ReadOutcome::Ignored);
  }

  let deadline = Instant::now() + READ_TIMEOUT;
  let req_time = if ev.selection_timestamp != 0 {
    ev.selection_timestamp
  } else {
    CURRENT_TIME
  };

  // Step 1: Query TARGETS so we never fetch payload bytes from concealed/origin/non-text offers.
  let _ = xproto::delete_property(conn, window, atoms.pibot_prop);
  xproto::convert_selection(conn, window, atoms.clipboard, atoms.targets, atoms.pibot_prop, req_time)
    .map_err(|_| ())?;
  conn.flush().map_err(|_| ())?;

  let targets_notify = match wait_for_selection_notify(
    conn,
    window,
    atoms,
    atoms.targets,
    wake_pipe,
    stop_flag,
    deadline,
  )? {
    WaitNotify::Ready(sn) => sn,
    WaitNotify::Superseded(newer) => {
      let _ = xproto::delete_property(conn, window, atoms.pibot_prop);
      return Ok(ReadOutcome::Superseded(newer));
    }
    WaitNotify::Obsolete | WaitNotify::TimedOut => {
      let _ = xproto::delete_property(conn, window, atoms.pibot_prop);
      return Ok(ReadOutcome::Ignored);
    }
    WaitNotify::Stopped => {
      let _ = xproto::delete_property(conn, window, atoms.pibot_prop);
      return Ok(ReadOutcome::Stopped);
    }
  };

  if targets_notify.property == NONE {
    return Ok(ReadOutcome::Ignored);
  }

  let targets_reply = xproto::get_property(
    conn,
    true,
    window,
    targets_notify.property,
    AtomEnum::ANY,
    0,
    MAX_TARGETS_WORDS,
  )
  .map_err(|_| ())?
  .reply()
  .map_err(|_| ())?;

  if targets_reply.type_ == atoms.incr || targets_reply.format != 32 {
    return Ok(ReadOutcome::Ignored);
  }

  let targets: Vec<Atom> = targets_reply
    .value32()
    .map(|iter| iter.collect())
    .unwrap_or_default();

  if targets.contains(&atoms.origin_marker) {
    return Ok(ReadOutcome::Ignored);
  }
  if targets.iter().any(|atom| atoms.concealed.contains(atom)) {
    return Ok(ReadOutcome::Ignored);
  }
  if targets.iter().any(|atom| atoms.file_copy.contains(atom)) {
    return Ok(ReadOutcome::Ignored);
  }

  let Some((selected_target, encoding)) = pick_x11_text_target(&targets, atoms) else {
    return Ok(ReadOutcome::Ignored);
  };

  // Step 2: Request the selected plain-text target.
  xproto::convert_selection(
    conn,
    window,
    atoms.clipboard,
    selected_target,
    atoms.pibot_prop,
    req_time,
  )
  .map_err(|_| ())?;
  conn.flush().map_err(|_| ())?;

  let data_notify = match wait_for_selection_notify(
    conn,
    window,
    atoms,
    selected_target,
    wake_pipe,
    stop_flag,
    deadline,
  )? {
    WaitNotify::Ready(sn) => sn,
    WaitNotify::Superseded(newer) => {
      let _ = xproto::delete_property(conn, window, atoms.pibot_prop);
      return Ok(ReadOutcome::Superseded(newer));
    }
    WaitNotify::Obsolete | WaitNotify::TimedOut => {
      let _ = xproto::delete_property(conn, window, atoms.pibot_prop);
      return Ok(ReadOutcome::Ignored);
    }
    WaitNotify::Stopped => {
      let _ = xproto::delete_property(conn, window, atoms.pibot_prop);
      return Ok(ReadOutcome::Stopped);
    }
  };

  if data_notify.property == NONE {
    return Ok(ReadOutcome::Ignored);
  }

  let data_reply = xproto::get_property(
    conn,
    true,
    window,
    data_notify.property,
    AtomEnum::ANY,
    0,
    MAX_PROPERTY_LONGS,
  )
  .map_err(|_| ())?
  .reply()
  .map_err(|_| ())?;

  let raw_bytes = if data_reply.type_ == atoms.incr {
    if data_reply
      .value32()
      .and_then(|mut it| it.next())
      .is_some_and(|lower_bound| lower_bound as usize > MAX_TEXT_BYTES)
    {
      return Ok(ReadOutcome::Ignored);
    }
    match read_incr_property(
      conn,
      window,
      atoms,
      data_notify.property,
      wake_pipe,
      stop_flag,
      deadline,
    )? {
      IncrRead::Complete(bytes) => bytes,
      IncrRead::Superseded(newer) => {
        let _ = xproto::delete_property(conn, window, data_notify.property);
        return Ok(ReadOutcome::Superseded(newer));
      }
      IncrRead::Aborted => {
        let _ = xproto::delete_property(conn, window, data_notify.property);
        return Ok(ReadOutcome::Ignored);
      }
      IncrRead::Stopped => {
        let _ = xproto::delete_property(conn, window, data_notify.property);
        return Ok(ReadOutcome::Stopped);
      }
    }
  } else {
    if data_reply.format != 8
      || data_reply.bytes_after > 0
      || data_reply.value.len() > MAX_TEXT_BYTES
    {
      return Ok(ReadOutcome::Ignored);
    }
    data_reply.value
  };

  let Some(text) = mime::decode_text_bytes(raw_bytes, encoding, MAX_TEXT_BYTES) else {
    return Ok(ReadOutcome::Ignored);
  };
  if !eligible_text(&text, false) {
    return Ok(ReadOutcome::Ignored);
  }
  if stop_flag.load(Ordering::Acquire) {
    return Ok(ReadOutcome::Stopped);
  }
  on_copy(text);
  Ok(ReadOutcome::Delivered)
}

fn pick_x11_text_target(targets: &[Atom], atoms: &Atoms) -> Option<(Atom, TextEncoding)> {
  let string_atom = u32::from(AtomEnum::STRING);
  if targets.contains(&atoms.utf8_string) {
    return Some((atoms.utf8_string, TextEncoding::Utf8));
  }
  if targets.contains(&atoms.text_plain_utf8) {
    return Some((atoms.text_plain_utf8, TextEncoding::Utf8));
  }
  if targets.contains(&atoms.text_plain_utf8_spaced) {
    return Some((atoms.text_plain_utf8_spaced, TextEncoding::Utf8));
  }
  if targets.contains(&atoms.text_plain) {
    return Some((atoms.text_plain, TextEncoding::Utf8));
  }
  if targets.contains(&string_atom) {
    return Some((string_atom, TextEncoding::Iso88591));
  }
  if targets.contains(&atoms.text) {
    return Some((atoms.text, TextEncoding::Utf8));
  }
  None
}

enum WaitNotify {
  Ready(SelectionNotifyEvent),
  Superseded(xfixes::SelectionNotifyEvent),
  Obsolete,
  TimedOut,
  Stopped,
}

fn wait_for_selection_notify(
  conn: &RustConnection,
  window: Window,
  atoms: &Atoms,
  expected_target: Atom,
  wake_pipe: &WakePipe,
  stop_flag: &AtomicBool,
  deadline: Instant,
) -> Result<WaitNotify, ()> {
  let x11_fd = conn.stream().as_raw_fd();
  let wake_fd = wake_pipe.read_raw_fd();

  loop {
    if stop_flag.load(Ordering::Acquire) {
      return Ok(WaitNotify::Stopped);
    }

    loop {
      match conn.poll_for_event() {
        Ok(Some(Event::SelectionNotify(sn))) => {
          if sn.requestor == window
            && sn.selection == atoms.clipboard
            && sn.target == expected_target
          {
            return Ok(WaitNotify::Ready(sn));
          }
        }
        Ok(Some(Event::XfixesSelectionNotify(ev))) => {
          if ev.selection == atoms.clipboard
            && ev.subtype == XfixesSelectionEvent::SET_SELECTION_OWNER
          {
            if is_external_clipboard_copy(&ev, atoms, window) {
              return Ok(WaitNotify::Superseded(ev));
            }
            return Ok(WaitNotify::Obsolete);
          }
        }
        Ok(Some(_)) => {}
        Ok(None) => break,
        Err(_) => return Err(()),
      }
    }

    let outcome = fd_util::poll_two(x11_fd, wake_fd, Some(deadline)).map_err(|_| ())?;
    if outcome.wake_ready {
      wake_pipe.drain();
      if stop_flag.load(Ordering::Acquire) {
        return Ok(WaitNotify::Stopped);
      }
    }
    if outcome.timed_out {
      return Ok(WaitNotify::TimedOut);
    }
    if outcome.primary_error && !outcome.primary_ready {
      return Err(());
    }
  }
}

enum IncrRead {
  Complete(Vec<u8>),
  Superseded(xfixes::SelectionNotifyEvent),
  Aborted,
  Stopped,
}

fn read_incr_property(
  conn: &RustConnection,
  window: Window,
  atoms: &Atoms,
  property: Atom,
  wake_pipe: &WakePipe,
  stop_flag: &AtomicBool,
  deadline: Instant,
) -> Result<IncrRead, ()> {
  let x11_fd = conn.stream().as_raw_fd();
  let wake_fd = wake_pipe.read_raw_fd();
  let mut buf = Vec::new();

  loop {
    if stop_flag.load(Ordering::Acquire) {
      return Ok(IncrRead::Stopped);
    }

    let mut chunk_ready = false;
    loop {
      match conn.poll_for_event() {
        Ok(Some(Event::PropertyNotify(pn))) => {
          if pn.window == window && pn.atom == property && pn.state == Property::NEW_VALUE {
            chunk_ready = true;
            break;
          }
        }
        Ok(Some(Event::XfixesSelectionNotify(ev))) => {
          if ev.selection == atoms.clipboard
            && ev.subtype == XfixesSelectionEvent::SET_SELECTION_OWNER
          {
            if is_external_clipboard_copy(&ev, atoms, window) {
              return Ok(IncrRead::Superseded(ev));
            }
            return Ok(IncrRead::Aborted);
          }
        }
        Ok(Some(_)) => {}
        Ok(None) => break,
        Err(_) => return Err(()),
      }
    }

    if chunk_ready {
      let chunk = xproto::get_property(
        conn,
        true,
        window,
        property,
        AtomEnum::ANY,
        0,
        MAX_PROPERTY_LONGS,
      )
      .map_err(|_| ())?
      .reply()
      .map_err(|_| ())?;

      if chunk.value.is_empty() {
        return Ok(IncrRead::Complete(buf));
      }
      if chunk.format != 8
        || chunk.bytes_after > 0
        || buf.len().saturating_add(chunk.value.len()) > MAX_TEXT_BYTES
      {
        return Ok(IncrRead::Aborted);
      }
      buf.extend_from_slice(&chunk.value);
      continue;
    }

    let outcome = fd_util::poll_two(x11_fd, wake_fd, Some(deadline)).map_err(|_| ())?;
    if outcome.wake_ready {
      wake_pipe.drain();
      if stop_flag.load(Ordering::Acquire) {
        return Ok(IncrRead::Stopped);
      }
    }
    if outcome.timed_out {
      return Ok(IncrRead::Aborted);
    }
    if outcome.primary_error && !outcome.primary_ready {
      return Err(());
    }
  }
}

// ---------------------------------------------------------------------------
// Persistent X11 CLIPBOARD owner thread (exits automatically on SelectionClear)
// ---------------------------------------------------------------------------

struct IncrSendTransfer {
  requestor: Window,
  property: Atom,
  target: Atom,
  payload: Vec<u8>,
  offset: usize,
  deadline: Instant,
}

fn write_x11_clipboard(text: &str) -> io::Result<()> {
  let _write_guard = WRITE_SERIALIZE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());

  // Attempt to update an already-running owner thread in place.
  let existing = ACTIVE_OWNER
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .clone();

  if let Some(handle) = existing {
    let (reply_tx, reply_rx) = mpsc::sync_channel::<io::Result<()>>(1);
    if handle
      .tx
      .try_send(OwnerCmd::Update {
        text: text.to_string(),
        reply: reply_tx,
      })
      .is_ok()
    {
      handle.waker.wake();
      match reply_rx.recv_timeout(WRITE_TIMEOUT) {
        Ok(Ok(())) => return Ok(()),
        Ok(Err(err)) => return Err(err),
        Err(RecvTimeoutError::Timeout) => {
          return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "timed out updating X11 clipboard",
          ));
        }
        Err(RecvTimeoutError::Disconnected) => {
          // Owner exited on SelectionClear right before our update; clear stale slot and respawn.
          let mut slot = ACTIVE_OWNER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
          if slot.as_ref().is_some_and(|h| h.id == handle.id) {
            *slot = None;
          }
        }
      }
    } else {
      let mut slot = ACTIVE_OWNER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
      if slot.as_ref().is_some_and(|h| h.id == handle.id) {
        *slot = None;
      }
    }
  }

  spawn_x11_owner(text.to_string())
}

fn spawn_x11_owner(initial_text: String) -> io::Result<()> {
  let wake_pipe = WakePipe::new()?;
  let waker = wake_pipe.waker();
  let owner_id = NEXT_OWNER_ID.fetch_add(1, Ordering::Relaxed);
  let (cmd_tx, cmd_rx) = mpsc::sync_channel::<OwnerCmd>(8);
  let (ready_tx, ready_rx) = mpsc::sync_channel::<io::Result<()>>(1);

  thread::Builder::new()
    .name("pibot-clip-x11-owner".to_string())
    .spawn(move || {
      run_x11_owner(owner_id, initial_text, wake_pipe, cmd_rx, ready_tx);
    })
    .map_err(|err| io::Error::new(err.kind(), "failed to spawn X11 clipboard owner"))?;

  match ready_rx.recv_timeout(WRITE_TIMEOUT) {
    Ok(Ok(())) => {
      let mut slot = ACTIVE_OWNER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
      *slot = Some(OwnerHandle {
        id: owner_id,
        tx: cmd_tx,
        waker,
      });
      Ok(())
    }
    Ok(Err(err)) => Err(err),
    Err(RecvTimeoutError::Timeout) => Err(io::Error::new(
      io::ErrorKind::TimedOut,
      "timed out acquiring X11 CLIPBOARD ownership",
    )),
    Err(RecvTimeoutError::Disconnected) => Err(io::Error::new(
      io::ErrorKind::Other,
      "X11 clipboard owner exited unexpectedly",
    )),
  }
}

fn run_x11_owner(
  owner_id: u64,
  mut current_text: String,
  wake_pipe: WakePipe,
  cmd_rx: mpsc::Receiver<OwnerCmd>,
  ready_tx: mpsc::SyncSender<io::Result<()>>,
) {
  let (conn, screen_num) = match RustConnection::connect(None) {
    Ok(pair) => pair,
    Err(_) => {
      let _ = ready_tx.send(Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "unable to connect to X11 display for clipboard write",
      )));
      return;
    }
  };

  let window = match create_hidden_window(&conn, screen_num) {
    Ok(w) => w,
    Err(err) => {
      let _ = ready_tx.send(Err(err));
      return;
    }
  };

  let atoms = match Atoms::intern(&conn) {
    Ok(a) => a,
    Err(err) => {
      let _ = xproto::destroy_window(&conn, window);
      let _ = conn.flush();
      let _ = ready_tx.send(Err(err));
      return;
    }
  };

  let mut pending_events = VecDeque::new();
  let mut selection_timestamp =
    acquire_server_timestamp(&conn, window, &atoms, &mut pending_events, WRITE_TIMEOUT);

  if let Err(err) = claim_clipboard_ownership(&conn, window, &atoms, selection_timestamp) {
    let _ = xproto::destroy_window(&conn, window);
    let _ = conn.flush();
    let _ = ready_tx.send(Err(err));
    return;
  }

  ACTIVE_OWNER_WINDOW.store(window, Ordering::Release);
  if ready_tx.send(Ok(())).is_err() {
    cleanup_owner(&conn, window, owner_id, cmd_rx);
    return;
  }

  let x11_fd = conn.stream().as_raw_fd();
  let wake_fd = wake_pipe.read_raw_fd();
  let max_chunk = conn.maximum_request_bytes().saturating_sub(256).max(4096);
  let mut active_incr: Vec<IncrSendTransfer> = Vec::new();

  'owner: loop {
    // 1. Drain any buffered or newly arrived X11 events.
    loop {
      let event = if let Some(ev) = pending_events.pop_front() {
        ev
      } else {
        match conn.poll_for_event() {
          Ok(Some(ev)) => ev,
          Ok(None) => break,
          Err(_) => break 'owner,
        }
      };

      match event {
        Event::SelectionClear(ev) => {
          if ev.selection == atoms.clipboard && ev.owner == window {
            // Confirm ownership was actually lost; ignores stale SelectionClear events queued
            // right before an in-place `OwnerCmd::Update` re-claimed CLIPBOARD.
            let still_owner = xproto::get_selection_owner(&conn, atoms.clipboard)
              .ok()
              .and_then(|cookie| cookie.reply().ok())
              .is_some_and(|reply| reply.owner == window);
            if !still_owner {
              break 'owner;
            }
          }
        }
        Event::SelectionRequest(req) => {
          if handle_selection_request(
            &conn,
            window,
            &atoms,
            &req,
            &current_text,
            selection_timestamp,
            max_chunk,
            &mut active_incr,
          )
          .is_err()
          {
            break 'owner;
          }
        }
        Event::PropertyNotify(pn) => {
          if pn.state == Property::DELETE {
            if advance_incr_transfer(&conn, &pn, max_chunk, &mut active_incr).is_err() {
              break 'owner;
            }
          }
        }
        _ => {}
      }
    }

    // 2. Process any queued update commands from `SystemClipboard::write`.
    while let Ok(cmd) = cmd_rx.try_recv() {
      match cmd {
        OwnerCmd::Update { text, reply } => {
          let new_ts =
            acquire_server_timestamp(&conn, window, &atoms, &mut pending_events, WRITE_TIMEOUT);
          match claim_clipboard_ownership(&conn, window, &atoms, new_ts) {
            Ok(()) => {
              current_text = text;
              selection_timestamp = new_ts;
              ACTIVE_OWNER_WINDOW.store(window, Ordering::Release);
              let _ = reply.send(Ok(()));
            }
            Err(err) => {
              let _ = reply.send(Err(err));
              break 'owner;
            }
          }
        }
      }
    }

    // 3. Evict timed-out INCR sends so stalled requestors cannot retain buffers.
    let now = Instant::now();
    active_incr.retain(|t| t.deadline > now);

    if conn.flush().is_err() {
      break 'owner;
    }

    let next_deadline = active_incr.iter().map(|t| t.deadline).min();
    let outcome = match fd_util::poll_two(x11_fd, wake_fd, next_deadline) {
      Ok(o) => o,
      Err(_) => break 'owner,
    };
    if outcome.wake_ready {
      wake_pipe.drain();
    }
    if outcome.primary_error && !outcome.primary_ready {
      break 'owner;
    }
  }

  cleanup_owner(&conn, window, owner_id, cmd_rx);
}

fn cleanup_owner(
  conn: &RustConnection,
  window: Window,
  owner_id: u64,
  cmd_rx: mpsc::Receiver<OwnerCmd>,
) {
  // Drop receiver first so any concurrent `write()` sees disconnection immediately instead of
  // waiting on `ACTIVE_OWNER`.
  drop(cmd_rx);

  let _ = ACTIVE_OWNER_WINDOW.compare_exchange(window, 0, Ordering::AcqRel, Ordering::Acquire);
  {
    let mut slot = ACTIVE_OWNER
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.as_ref().is_some_and(|h| h.id == owner_id) {
      *slot = None;
    }
  }
  let _ = xproto::destroy_window(conn, window);
  let _ = conn.flush();
}

fn acquire_server_timestamp(
  conn: &RustConnection,
  window: Window,
  atoms: &Atoms,
  pending_events: &mut VecDeque<Event>,
  timeout: Duration,
) -> Timestamp {
  if conn
    .change_property8(
      PropMode::REPLACE,
      window,
      atoms.timestamp_prop,
      atoms.timestamp_prop,
      &[],
    )
    .is_err()
    || conn.flush().is_err()
  {
    return CURRENT_TIME;
  }

  let deadline = Instant::now() + timeout;
  let x11_fd = conn.stream().as_raw_fd();

  loop {
    loop {
      match conn.poll_for_event() {
        Ok(Some(Event::PropertyNotify(pn)))
          if pn.window == window && pn.atom == atoms.timestamp_prop =>
        {
          return pn.time;
        }
        Ok(Some(other)) => pending_events.push_back(other),
        Ok(None) => break,
        Err(_) => return CURRENT_TIME,
      }
    }

    let now = Instant::now();
    if now >= deadline {
      return CURRENT_TIME;
    }
    let rem_ms = deadline
      .saturating_duration_since(now)
      .as_millis()
      .clamp(1, libc::c_int::MAX as u128) as libc::c_int;
    let mut pfd = [libc::pollfd {
      fd: x11_fd,
      events: libc::POLLIN,
      revents: 0,
    }];
    // SAFETY: `pfd` is a valid 1-element `pollfd` array for `poll`.
    let rc = unsafe { libc::poll(pfd.as_mut_ptr(), 1, rem_ms) };
    if rc <= 0 {
      if rc < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
        continue;
      }
      return CURRENT_TIME;
    }
  }
}

fn claim_clipboard_ownership(
  conn: &RustConnection,
  window: Window,
  atoms: &Atoms,
  timestamp: Timestamp,
) -> io::Result<()> {
  xproto::set_selection_owner(conn, window, atoms.clipboard, timestamp)
    .map_err(|_| io::Error::new(io::ErrorKind::Other, "X11 set_selection_owner failed"))?;
  let owner = xproto::get_selection_owner(conn, atoms.clipboard)
    .map_err(|_| io::Error::new(io::ErrorKind::Other, "X11 get_selection_owner failed"))?
    .reply()
    .map_err(|_| io::Error::new(io::ErrorKind::Other, "X11 get_selection_owner reply failed"))?
    .owner;
  if owner != window {
    return Err(io::Error::new(
      io::ErrorKind::Other,
      "failed to acquire X11 CLIPBOARD ownership",
    ));
  }
  Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle_selection_request(
  conn: &RustConnection,
  window: Window,
  atoms: &Atoms,
  req: &SelectionRequestEvent,
  current_text: &str,
  selection_timestamp: Timestamp,
  max_chunk: usize,
  active_incr: &mut Vec<IncrSendTransfer>,
) -> Result<(), ()> {
  if req.selection != atoms.clipboard || req.owner != window {
    return send_selection_notify(conn, req, NONE);
  }

  let reply_prop = if req.property == NONE {
    req.target
  } else {
    req.property
  };
  let string_atom = u32::from(AtomEnum::STRING);

  if req.target == atoms.targets {
    let offered = [
      atoms.targets,
      atoms.timestamp,
      atoms.utf8_string,
      atoms.text_plain_utf8,
      atoms.text_plain,
      string_atom,
      atoms.text,
      atoms.origin_marker,
    ];
    conn
      .change_property32(
        PropMode::REPLACE,
        req.requestor,
        reply_prop,
        AtomEnum::ATOM,
        &offered,
      )
      .map_err(|_| ())?;
    return send_selection_notify(conn, req, reply_prop);
  }

  if req.target == atoms.timestamp {
    conn
      .change_property32(
        PropMode::REPLACE,
        req.requestor,
        reply_prop,
        AtomEnum::INTEGER,
        &[selection_timestamp],
      )
      .map_err(|_| ())?;
    return send_selection_notify(conn, req, reply_prop);
  }

  if req.target == atoms.origin_marker {
    conn
      .change_property8(
        PropMode::REPLACE,
        req.requestor,
        reply_prop,
        atoms.origin_marker,
        ORIGIN_MARKER_VALUE,
      )
      .map_err(|_| ())?;
    return send_selection_notify(conn, req, reply_prop);
  }

  let payload_opt: Option<Vec<u8>> = if req.target == atoms.utf8_string
    || req.target == atoms.text_plain_utf8
    || req.target == atoms.text_plain_utf8_spaced
    || req.target == atoms.text_plain
    || req.target == atoms.text
  {
    Some(current_text.as_bytes().to_vec())
  } else if req.target == string_atom {
    Some(mime::encode_iso88591(current_text))
  } else {
    None
  };

  let Some(payload) = payload_opt else {
    return send_selection_notify(conn, req, NONE);
  };

  if payload.len() <= max_chunk {
    conn
      .change_property8(
        PropMode::REPLACE,
        req.requestor,
        reply_prop,
        req.target,
        &payload,
      )
      .map_err(|_| ())?;
    return send_selection_notify(conn, req, reply_prop);
  }

  // Incremental INCR fallback if server max request size is smaller than payload.
  let now = Instant::now();
  active_incr.retain(|t| t.deadline > now);
  if active_incr.len() >= MAX_ACTIVE_INCR_SENDS {
    return send_selection_notify(conn, req, NONE);
  }

  let aux = ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE);
  xproto::change_window_attributes(conn, req.requestor, &aux).map_err(|_| ())?;
  conn
    .change_property32(
      PropMode::REPLACE,
      req.requestor,
      reply_prop,
      atoms.incr,
      &[payload.len().min(u32::MAX as usize) as u32],
    )
    .map_err(|_| ())?;
  active_incr.push(IncrSendTransfer {
    requestor: req.requestor,
    property: reply_prop,
    target: req.target,
    payload,
    offset: 0,
    deadline: now + INCR_SEND_TIMEOUT,
  });
  send_selection_notify(conn, req, reply_prop)
}

fn advance_incr_transfer(
  conn: &RustConnection,
  pn: &xproto::PropertyNotifyEvent,
  max_chunk: usize,
  active_incr: &mut Vec<IncrSendTransfer>,
) -> Result<(), ()> {
  let Some(idx) = active_incr
    .iter()
    .position(|t| t.requestor == pn.window && t.property == pn.atom)
  else {
    return Ok(());
  };

  let finished = {
    let transfer = &mut active_incr[idx];
    if transfer.offset >= transfer.payload.len() {
      conn
        .change_property8(
          PropMode::REPLACE,
          transfer.requestor,
          transfer.property,
          transfer.target,
          &[],
        )
        .map_err(|_| ())?;
      true
    } else {
      let end = transfer.offset.saturating_add(max_chunk).min(transfer.payload.len());
      let chunk = &transfer.payload[transfer.offset..end];
      conn
        .change_property8(
          PropMode::REPLACE,
          transfer.requestor,
          transfer.property,
          transfer.target,
          chunk,
        )
        .map_err(|_| ())?;
      transfer.offset = end;
      transfer.deadline = Instant::now() + INCR_SEND_TIMEOUT;
      false
    }
  };

  if finished {
    active_incr.swap_remove(idx);
  }
  Ok(())
}

fn send_selection_notify(
  conn: &RustConnection,
  req: &SelectionRequestEvent,
  property: Atom,
) -> Result<(), ()> {
  let notify = SelectionNotifyEvent {
    response_type: SELECTION_NOTIFY_EVENT,
    sequence: 0,
    time: req.time,
    requestor: req.requestor,
    selection: req.selection,
    target: req.target,
    property,
  };
  xproto::send_event(conn, false, req.requestor, EventMask::NO_EVENT, notify).map_err(|_| ())?;
  conn.flush().map_err(|_| ())?;
  Ok(())
}
