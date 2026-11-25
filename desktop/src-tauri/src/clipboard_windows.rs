#![cfg(windows)]

//! Windows system clipboard adapter for PiBot clipboard sync.
//!
//! Uses a dedicated message-only Win32 window (`HWND_MESSAGE`) on a private worker
//! thread with `AddClipboardFormatListener` / `WM_CLIPBOARDUPDATE` so the adapter
//! never steals UI focus, never creates a visible window, and never runs blocking
//! clipboard operations on the Tauri main/UI thread.

use std::cell::Cell;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::io;
use std::marker::PhantomData;
use std::mem::size_of;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle, ThreadId};
use std::time::Duration;

use clipboard_sync::{eligible_text, MAX_TEXT_BYTES};
use windows_sys::core::PCWSTR;
use windows_sys::w;
use windows_sys::Win32::Foundation::{
  GetLastError, GlobalFree, ERROR_ACCESS_DENIED, ERROR_CLASS_ALREADY_EXISTS, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT,
  WPARAM,
};
use windows_sys::Win32::System::DataExchange::{
  AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardOwner,
  GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
  RemoveClipboardFormatListener, SetClipboardData,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Memory::{
  GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows_sys::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows_sys::Win32::UI::WindowsAndMessaging::{
  CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostMessageW,
  PostQuitMessage, PostThreadMessageW, RegisterClassExW, TranslateMessage, HWND_MESSAGE, MSG,
  WM_APP, WM_CLIPBOARDUPDATE, WM_DESTROY, WM_QUIT, WNDCLASSEXW,
};

const WINDOW_CLASS_NAME: PCWSTR = w!("PiBotClipboardSyncListenerClass");
const WINDOW_TITLE: PCWSTR = w!("PiBotClipboardSyncListener");

const FMT_EXCLUDE_MONITOR: PCWSTR = w!("ExcludeClipboardContentFromMonitorProcessing");
const FMT_CAN_INCLUDE_HISTORY: PCWSTR = w!("CanIncludeInClipboardHistory");
const FMT_CAN_UPLOAD_CLOUD: PCWSTR = w!("CanUploadToCloudClipboard");
const FMT_OWN_WRITE_MARKER: PCWSTR = w!("PiBot.ClipboardSync.OwnWrite.v1");

const WM_APP_WRITE: u32 = WM_APP + 1;
const WM_APP_SHUTDOWN: u32 = WM_APP + 2;
const WM_APP_WAKE: u32 = WM_APP + 3;

/// Strictly bounded retry backoff for transient `OpenClipboard` contention.
/// Interrupted immediately on shutdown; never wait for another app indefinitely.
const OPEN_CLIPBOARD_BACKOFF_MS: &[u64] = &[2, 4, 8, 12, 16, 20, 25, 50, 80, 120];

/// Upper bound for a caller waiting on the worker thread to complete `write()`.
const WRITE_REPLY_TIMEOUT: Duration = Duration::from_secs(2);

/// Upper bound for `SystemClipboard::start()` waiting on worker initialization.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

static NEXT_INSTANCE_ID: AtomicU64 = AtomicU64::new(1);

thread_local! {
  static CLIPBOARD_UPDATED: Cell<bool> = const { Cell::new(false) };
}

fn take_clipboard_updated_flag() -> bool {
  CLIPBOARD_UPDATED.with(|flag| flag.replace(false))
}

struct ThreadLocalResetGuard;

impl ThreadLocalResetGuard {
  fn new() -> Self {
    CLIPBOARD_UPDATED.with(|flag| flag.set(false));
    Self
  }
}

impl Drop for ThreadLocalResetGuard {
  fn drop(&mut self) {
    CLIPBOARD_UPDATED.with(|flag| flag.set(false));
  }
}

/// Active Windows clipboard observer and writer.
///
/// Deliberately omits `Debug` so no internal handles or transient state are logged.
/// Dropping stops observation and releases the worker without clearing the user's clipboard.
pub(crate) struct SystemClipboard {
  hwnd: isize,
  win_thread_id: u32,
  worker_thread_id: ThreadId,
  control: Arc<WorkerControl>,
  worker: Mutex<Option<JoinHandle<()>>>,
}

const _: fn() = || {
  fn assert_send_sync<T: Send + Sync>() {}
  assert_send_sync::<SystemClipboard>();
};

struct WorkerStartInfo {
  hwnd: isize,
  win_thread_id: u32,
}

struct WriteRequest {
  text: String,
  cancelled: Arc<AtomicBool>,
  reply: mpsc::SyncSender<io::Result<()>>,
}

struct WorkerControl {
  shutdown: AtomicBool,
  shutdown_lock: Mutex<bool>,
  shutdown_cv: Condvar,
  pending_writes: Mutex<VecDeque<WriteRequest>>,
}

impl WorkerControl {
  fn new() -> Self {
    Self {
      shutdown: AtomicBool::new(false),
      shutdown_lock: Mutex::new(false),
      shutdown_cv: Condvar::new(),
      pending_writes: Mutex::new(VecDeque::new()),
    }
  }

  fn is_shutdown(&self) -> bool {
    self.shutdown.load(Ordering::Acquire)
  }

  fn request_shutdown(&self) {
    self.shutdown.store(true, Ordering::Release);
    {
      let mut stopped = self
        .shutdown_lock
        .lock()
        .unwrap_or_else(|e| e.into_inner());
      *stopped = true;
      self.shutdown_cv.notify_all();
    }
    self.fail_pending_writes();
  }

  fn fail_pending_writes(&self) {
    let mut drained = VecDeque::new();
    {
      let mut queue = self
        .pending_writes
        .lock()
        .unwrap_or_else(|e| e.into_inner());
      std::mem::swap(&mut *queue, &mut drained);
    }
    for req in drained {
      let _ = req.reply.try_send(Err(io::Error::new(
        io::ErrorKind::BrokenPipe,
        "clipboard observer stopped",
      )));
    }
  }

  fn take_pending_writes(&self) -> VecDeque<WriteRequest> {
    let mut drained = VecDeque::new();
    let mut queue = self
      .pending_writes
      .lock()
      .unwrap_or_else(|e| e.into_inner());
    std::mem::swap(&mut *queue, &mut drained);
    drained
  }

  /// Waits up to `delay`, returning `true` immediately if shutdown is requested.
  fn wait_or_shutdown(&self, delay: Duration) -> bool {
    if self.is_shutdown() {
      return true;
    }
    let stopped = self
      .shutdown_lock
      .lock()
      .unwrap_or_else(|e| e.into_inner());
    if *stopped {
      return true;
    }
    let (stopped, _) = self
      .shutdown_cv
      .wait_timeout_while(stopped, delay, |is_stopped| !*is_stopped)
      .unwrap_or_else(|e| e.into_inner());
    *stopped || self.is_shutdown()
  }
}

impl SystemClipboard {
  pub(crate) fn start(
    on_copy: impl Fn(String) + Send + Sync + 'static,
    on_stopped: impl FnOnce() + Send + 'static,
  ) -> io::Result<Self> {
    let control = Arc::new(WorkerControl::new());
    let worker_control = Arc::clone(&control);
    let instance_id = NEXT_INSTANCE_ID.fetch_add(1, Ordering::Relaxed);
    let (startup_tx, startup_rx) = mpsc::sync_channel::<io::Result<WorkerStartInfo>>(1);

    let handle = thread::Builder::new()
      .name("pibot-clipboard-win".to_owned())
      .spawn(move || {
        run_worker(instance_id, worker_control, Box::new(on_copy), startup_tx, on_stopped);
      })?;

    let worker_thread_id = handle.thread().id();

    match startup_rx.recv_timeout(STARTUP_TIMEOUT) {
      Ok(Ok(info)) => Ok(Self {
        hwnd: info.hwnd,
        win_thread_id: info.win_thread_id,
        worker_thread_id,
        control,
        worker: Mutex::new(Some(handle)),
      }),
      Ok(Err(err)) => {
        control.request_shutdown();
        let _ = handle.join();
        Err(err)
      }
      Err(mpsc::RecvTimeoutError::Timeout) => {
        control.request_shutdown();
        Err(io::Error::new(
          io::ErrorKind::TimedOut,
          "timed out starting Windows clipboard listener",
        ))
      }
      Err(mpsc::RecvTimeoutError::Disconnected) => {
        control.request_shutdown();
        let _ = handle.join();
        Err(io::Error::new(
          io::ErrorKind::Other,
          "Windows clipboard worker exited during startup",
        ))
      }
    }
  }

  pub(crate) fn write(&self, text: &str) -> io::Result<()> {
    // Defense in depth: validate incoming remote text before touching the OS clipboard.
    if !eligible_text(text) {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "clipboard text is not eligible for sync",
      ));
    }

    if self.control.is_shutdown() {
      return Err(io::Error::new(
        io::ErrorKind::BrokenPipe,
        "clipboard observer is stopped",
      ));
    }

    if thread::current().id() == self.worker_thread_id {
      return Err(io::Error::new(
        io::ErrorKind::WouldBlock,
        "cannot write clipboard re-entrantly from copy callback",
      ));
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let (reply_tx, reply_rx) = mpsc::sync_channel::<io::Result<()>>(1);
    {
      let mut queue = self
        .control
        .pending_writes
        .lock()
        .unwrap_or_else(|e| e.into_inner());
      if self.control.is_shutdown() {
        return Err(io::Error::new(
          io::ErrorKind::BrokenPipe,
          "clipboard observer is stopped",
        ));
      }
      queue.push_back(WriteRequest {
        text: text.to_owned(),
        cancelled: Arc::clone(&cancelled),
        reply: reply_tx,
      });
    }

    let posted = unsafe { PostMessageW(self.hwnd as HWND, WM_APP_WRITE, 0, 0) };
    if posted == 0 {
      cancelled.store(true, Ordering::Release);
      let err = io::Error::last_os_error();
      if self.control.is_shutdown() {
        return Err(io::Error::new(
          io::ErrorKind::BrokenPipe,
          "clipboard observer is stopped",
        ));
      }
      return Err(err);
    }

    match reply_rx.recv_timeout(WRITE_REPLY_TIMEOUT) {
      Ok(result) => result,
      Err(mpsc::RecvTimeoutError::Timeout) => {
        cancelled.store(true, Ordering::Release);
        Err(io::Error::new(
          io::ErrorKind::TimedOut,
          "timed out waiting for Windows clipboard write",
        ))
      }
      Err(mpsc::RecvTimeoutError::Disconnected) => {
        cancelled.store(true, Ordering::Release);
        Err(io::Error::new(
          io::ErrorKind::BrokenPipe,
          "clipboard observer stopped during write",
        ))
      }
    }
  }
}

impl Drop for SystemClipboard {
  fn drop(&mut self) {
    self.control.request_shutdown();

    let hwnd = self.hwnd as HWND;
    if !hwnd.is_null() {
      let posted = unsafe { PostMessageW(hwnd, WM_APP_SHUTDOWN, 0, 0) };
      if posted == 0 && self.win_thread_id != 0 {
        unsafe {
          let _ = PostThreadMessageW(self.win_thread_id, WM_QUIT, 0, 0);
        }
      }
    }

    let handle = self
      .worker
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(handle) = handle {
      if handle.thread().id() != thread::current().id() {
        let _ = handle.join();
      }
    }
  }
}

#[derive(Clone, Copy)]
struct ClipboardFormats {
  exclude_monitor: u32,
  can_include_history: u32,
  can_upload_cloud: u32,
  own_marker: u32,
}

impl ClipboardFormats {
  fn register() -> io::Result<Self> {
    Ok(Self {
      exclude_monitor: register_clipboard_format(FMT_EXCLUDE_MONITOR)?,
      can_include_history: register_clipboard_format(FMT_CAN_INCLUDE_HISTORY)?,
      can_upload_cloud: register_clipboard_format(FMT_CAN_UPLOAD_CLOUD)?,
      own_marker: register_clipboard_format(FMT_OWN_WRITE_MARKER)?,
    })
  }
}

fn register_clipboard_format(name: PCWSTR) -> io::Result<u32> {
  let id = unsafe { RegisterClipboardFormatW(name) };
  if id == 0 {
    return Err(io::Error::last_os_error());
  }
  Ok(id)
}

/// RAII guard for a message-only `HWND`.
///
/// Destroying the window never clears already-rendered clipboard data because all
/// formats written by this adapter use concrete `HGLOBAL` buffers (no delayed rendering).
struct WindowGuard(HWND);

impl WindowGuard {
  fn create(hinst: *mut c_void) -> io::Result<Self> {
    let hwnd = unsafe {
      CreateWindowExW(
        0,
        WINDOW_CLASS_NAME,
        WINDOW_TITLE,
        0,
        0,
        0,
        0,
        0,
        HWND_MESSAGE,
        ptr::null_mut(),
        hinst,
        ptr::null(),
      )
    };
    if hwnd.is_null() {
      return Err(io::Error::last_os_error());
    }
    Ok(Self(hwnd))
  }

  fn hwnd(&self) -> HWND {
    self.0
  }
}

impl Drop for WindowGuard {
  fn drop(&mut self) {
    unsafe {
      let _ = DestroyWindow(self.0);
    }
  }
}

/// RAII guard for `AddClipboardFormatListener` / `RemoveClipboardFormatListener`.
struct ClipboardListenerGuard(HWND);

impl ClipboardListenerGuard {
  fn attach(hwnd: HWND) -> io::Result<Self> {
    let ok = unsafe { AddClipboardFormatListener(hwnd) };
    if ok == 0 {
      return Err(io::Error::last_os_error());
    }
    Ok(Self(hwnd))
  }
}

impl Drop for ClipboardListenerGuard {
  fn drop(&mut self) {
    unsafe {
      let _ = RemoveClipboardFormatListener(self.0);
    }
  }
}

struct ListenerWindow {
  // Declared first so RemoveClipboardFormatListener runs before DestroyWindow.
  _listener: ClipboardListenerGuard,
  window: WindowGuard,
}

impl ListenerWindow {
  fn hwnd(&self) -> HWND {
    self.window.hwnd()
  }
}

/// RAII guard for an open Win32 clipboard session (`OpenClipboard` / `CloseClipboard`).
struct ClipboardGuard {
  _private: (),
}

impl ClipboardGuard {
  fn open_bounded(hwnd: HWND, control: &WorkerControl) -> io::Result<Self> {
    if unsafe { OpenClipboard(hwnd) } != 0 {
      return Ok(Self { _private: () });
    }
    let mut last_err = io::Error::last_os_error();

    for &delay_ms in OPEN_CLIPBOARD_BACKOFF_MS {
      if control.wait_or_shutdown(Duration::from_millis(delay_ms)) {
        return Err(io::Error::new(
          io::ErrorKind::Interrupted,
          "clipboard observer stopped",
        ));
      }
      if unsafe { OpenClipboard(hwnd) } != 0 {
        return Ok(Self { _private: () });
      }
      last_err = io::Error::last_os_error();
    }

    if last_err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
      return Err(io::Error::new(io::ErrorKind::WouldBlock, "Windows clipboard is busy"));
    }
    Err(last_err)
  }
}

impl Drop for ClipboardGuard {
  fn drop(&mut self) {
    unsafe {
      let _ = CloseClipboard();
    }
  }
}

/// RAII guard for a `GlobalLock` / `GlobalUnlock` region tied to an open `ClipboardGuard`.
struct GlobalLockGuard<'a> {
  hmem: HGLOBAL,
  ptr: *const c_void,
  _clip: PhantomData<&'a ClipboardGuard>,
}

impl<'a> GlobalLockGuard<'a> {
  fn lock(_clip: &'a ClipboardGuard, hmem: HGLOBAL) -> Option<Self> {
    if hmem.is_null() {
      return None;
    }
    let ptr = unsafe { GlobalLock(hmem) };
    if ptr.is_null() {
      return None;
    }
    Some(Self {
      hmem,
      ptr: ptr.cast_const(),
      _clip: PhantomData,
    })
  }

  fn as_ptr(&self) -> *const u8 {
    self.ptr.cast::<u8>()
  }
}

impl Drop for GlobalLockGuard<'_> {
  fn drop(&mut self) {
    unsafe {
      let _ = GlobalUnlock(self.hmem);
    }
  }
}

/// RAII guard for a `GMEM_MOVEABLE` allocation owned by this process until
/// ownership is transferred to Windows via a successful `SetClipboardData` call.
struct OwnedHGlobal {
  hmem: HGLOBAL,
}

impl OwnedHGlobal {
  fn from_bytes(bytes: &[u8]) -> io::Result<Self> {
    if bytes.is_empty() {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "cannot allocate empty global clipboard buffer",
      ));
    }

    let hmem = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) };
    if hmem.is_null() {
      return Err(io::Error::last_os_error());
    }
    let owned = Self { hmem };

    let dst = unsafe { GlobalLock(owned.hmem) };
    if dst.is_null() {
      return Err(io::Error::last_os_error());
    }
    unsafe {
      ptr::copy_nonoverlapping(bytes.as_ptr(), dst.cast::<u8>(), bytes.len());
      let _ = GlobalUnlock(owned.hmem);
    }

    Ok(owned)
  }

  fn set_clipboard_data(self, _clip: &ClipboardGuard, format: u32) -> io::Result<()> {
    let result = unsafe { SetClipboardData(format, self.hmem as HANDLE) };
    if result.is_null() {
      // Clipboard did not take ownership; `self` drops and calls GlobalFree.
      return Err(io::Error::last_os_error());
    }
    // Windows now owns the HGLOBAL; do not call GlobalFree.
    std::mem::forget(self);
    Ok(())
  }
}

impl Drop for OwnedHGlobal {
  fn drop(&mut self) {
    if !self.hmem.is_null() {
      unsafe {
        let _ = GlobalFree(self.hmem);
      }
    }
  }
}

unsafe extern "system" fn clipboard_wnd_proc(
  hwnd: HWND,
  msg: u32,
  wparam: WPARAM,
  lparam: LPARAM,
) -> LRESULT {
  match msg {
    WM_CLIPBOARDUPDATE => {
      let already_set = CLIPBOARD_UPDATED.with(|flag| flag.replace(true));
      if !already_set {
        let _ = PostMessageW(hwnd, WM_APP_WAKE, 0, 0);
      }
      0
    }
    WM_DESTROY => {
      PostQuitMessage(0);
      0
    }
    _ => DefWindowProcW(hwnd, msg, wparam, lparam),
  }
}

fn register_window_class() -> io::Result<*mut c_void> {
  let hinst = unsafe { GetModuleHandleW(ptr::null()) };
  if hinst.is_null() {
    return Err(io::Error::last_os_error());
  }

  let wc = WNDCLASSEXW {
    cbSize: size_of::<WNDCLASSEXW>() as u32,
    lpfnWndProc: Some(clipboard_wnd_proc),
    hInstance: hinst,
    lpszClassName: WINDOW_CLASS_NAME,
    ..Default::default()
  };

  let atom = unsafe { RegisterClassExW(&wc) };
  if atom == 0 {
    let err_code = unsafe { GetLastError() };
    if err_code != ERROR_CLASS_ALREADY_EXISTS {
      return Err(io::Error::from_raw_os_error(err_code as i32));
    }
  }

  Ok(hinst)
}

fn initialize_worker() -> io::Result<(ListenerWindow, ClipboardFormats, u32)> {
  let hinst = register_window_class()?;
  let formats = ClipboardFormats::register()?;
  let window = WindowGuard::create(hinst)?;
  // Capture baseline sequence before registering the listener so pre-existing
  // clipboard contents are never emitted as a new copy.
  let baseline_seq = unsafe { GetClipboardSequenceNumber() };
  let listener = ClipboardListenerGuard::attach(window.hwnd())?;
  Ok((
    ListenerWindow {
      _listener: listener,
      window,
    },
    formats,
    baseline_seq,
  ))
}

fn run_worker(
  instance_id: u64,
  control: Arc<WorkerControl>,
  on_copy: Box<dyn Fn(String) + Send + Sync + 'static>,
  startup_tx: mpsc::SyncSender<io::Result<WorkerStartInfo>>,
  on_stopped: impl FnOnce(),
) {
  let _tls_guard = ThreadLocalResetGuard::new();

  let (listener_window, formats, baseline_seq) = match initialize_worker() {
    Ok(parts) => parts,
    Err(err) => {
      let _ = startup_tx.send(Err(err));
      return;
    }
  };

  let start_info = WorkerStartInfo {
    hwnd: listener_window.hwnd() as isize,
    win_thread_id: unsafe { GetCurrentThreadId() },
  };
  if startup_tx.send(Ok(start_info)).is_err() {
    return;
  }

  let mut state = WorkerState {
    instance_id,
    write_counter: 0,
    hwnd: listener_window.hwnd(),
    formats,
    control: Arc::clone(&control),
    on_copy,
    last_seen_seq: baseline_seq,
    last_own_seq: None,
  };

  let mut msg = MSG::default();
  while !control.is_shutdown() {
    state.drain_pending_writes();
    if control.is_shutdown() {
      break;
    }

    let ret = unsafe { GetMessageW(&mut msg, ptr::null_mut(), 0, 0) };
    if ret <= 0 {
      // 0 => WM_QUIT, -1 => Win32 error; exit cleanly in both cases.
      break;
    }

    if control.is_shutdown() || msg.message == WM_APP_SHUTDOWN {
      break;
    }

    match msg.message {
      WM_APP_WRITE => {
        state.drain_pending_writes();
      }
      WM_APP_WAKE => {
        // Wakeup sentinel for synchronously dispatched WM_CLIPBOARDUPDATE.
      }
      _ => unsafe {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
      },
    }

    if control.is_shutdown() {
      break;
    }

    if take_clipboard_updated_flag() {
      state.handle_clipboard_update();
    }
  }

  if !control.is_shutdown() {
    control.request_shutdown();
    on_stopped();
  }
}

struct WorkerState {
  instance_id: u64,
  write_counter: u64,
  hwnd: HWND,
  formats: ClipboardFormats,
  control: Arc<WorkerControl>,
  on_copy: Box<dyn Fn(String) + Send + Sync + 'static>,
  last_seen_seq: u32,
  last_own_seq: Option<u32>,
}

impl WorkerState {
  fn drain_pending_writes(&mut self) {
    let pending = self.control.take_pending_writes();
    for req in pending {
      if self.control.is_shutdown() {
        let _ = req.reply.try_send(Err(io::Error::new(
          io::ErrorKind::BrokenPipe,
          "clipboard observer stopped",
        )));
        continue;
      }
      if req.cancelled.load(Ordering::Acquire) {
        continue;
      }
      let result = self.apply_remote_write(&req.text);
      let _ = req.reply.try_send(result);
    }
  }

  fn apply_remote_write(&mut self, text: &str) -> io::Result<()> {
    // Defense in depth: verify shared eligibility policy before allocating/writing.
    if !eligible_text(text) {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "clipboard text is not eligible for sync",
      ));
    }

    self.write_counter = self.write_counter.wrapping_add(1);

    // Pre-allocate all HGLOBAL buffers before opening or emptying the clipboard so
    // an allocation failure leaves the user's existing clipboard untouched.
    let utf16_bytes = encode_utf16_nul_bytes(text);
    let marker_bytes = build_own_marker_payload(self.instance_id, self.write_counter);
    let text_hmem = OwnedHGlobal::from_bytes(&utf16_bytes)?;
    let marker_hmem = OwnedHGlobal::from_bytes(&marker_bytes)?;
    let exclude_hmem = OwnedHGlobal::from_bytes(&1u32.to_ne_bytes())?;
    let history_hmem = OwnedHGlobal::from_bytes(&0u32.to_ne_bytes())?;
    let cloud_hmem = OwnedHGlobal::from_bytes(&0u32.to_ne_bytes())?;

    let clip = ClipboardGuard::open_bounded(self.hwnd, &self.control)?;

    if unsafe { EmptyClipboard() } == 0 {
      return Err(io::Error::last_os_error());
    }

    // Set CF_UNICODETEXT first (required for normal paste), then atomically attach
    // the private own-write marker and standard Windows exclusion flags before CloseClipboard.
    text_hmem.set_clipboard_data(&clip, u32::from(CF_UNICODETEXT))?;
    let _ = marker_hmem.set_clipboard_data(&clip, self.formats.own_marker);
    let _ = exclude_hmem.set_clipboard_data(&clip, self.formats.exclude_monitor);
    let _ = history_hmem.set_clipboard_data(&clip, self.formats.can_include_history);
    let _ = cloud_hmem.set_clipboard_data(&clip, self.formats.can_upload_cloud);

    // Capture the final sequence number while still holding the clipboard lock so
    // no concurrent external write can race ahead of our sequence record.
    let seq = unsafe { GetClipboardSequenceNumber() };
    if seq != 0 {
      self.last_own_seq = Some(seq);
      self.last_seen_seq = seq;
    }

    drop(clip);
    Ok(())
  }

  fn handle_clipboard_update(&mut self) {
    if self.control.is_shutdown() {
      return;
    }

    let seq = unsafe { GetClipboardSequenceNumber() };
    if seq == 0 || seq == self.last_seen_seq {
      return;
    }
    if self.last_own_seq == Some(seq) {
      self.last_seen_seq = seq;
      return;
    }

    let owner = unsafe { GetClipboardOwner() };
    if !owner.is_null() && owner == self.hwnd {
      self.last_seen_seq = seq;
      return;
    }

    let text = match self.read_eligible_external_text() {
      Some(text) => text,
      None => return,
    };

    if self.control.is_shutdown() {
      return;
    }

    if !eligible_text(&text) {
      return;
    }

    if self.control.is_shutdown() {
      return;
    }

    (self.on_copy)(text);
  }

  fn read_eligible_external_text(&mut self) -> Option<String> {
    let clip = ClipboardGuard::open_bounded(self.hwnd, &self.control).ok()?;

    let open_seq = unsafe { GetClipboardSequenceNumber() };
    if open_seq == 0 || open_seq == self.last_seen_seq {
      return None;
    }
    if self.last_own_seq == Some(open_seq) {
      self.last_seen_seq = open_seq;
      return None;
    }

    let open_owner = unsafe { GetClipboardOwner() };
    if !open_owner.is_null() && open_owner == self.hwnd {
      self.last_seen_seq = open_seq;
      return None;
    }

    // Record this sequence as observed now that we hold a consistent clipboard snapshot.
    self.last_seen_seq = open_seq;

    // Skip our own write marker, not OS history/cloud/monitor exclusion formats.
    if unsafe { IsClipboardFormatAvailable(self.formats.own_marker) } != 0 {
      return None;
    }

    // Skip file-drop / file-only clipboards and non-text clipboards.
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_HDROP)) } != 0 {
      return None;
    }
    if unsafe { IsClipboardFormatAvailable(u32::from(CF_UNICODETEXT)) } == 0 {
      return None;
    }

    read_bounded_unicode_text(&clip, MAX_TEXT_BYTES)
  }
}

fn read_bounded_unicode_text(clip: &ClipboardGuard, max_utf8_bytes: usize) -> Option<String> {
  if max_utf8_bytes == 0 {
    return None;
  }
  let hdata = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT)) };
  if hdata.is_null() {
    return None;
  }
  let alloc_bytes = unsafe { GlobalSize(hdata as HGLOBAL) };
  if alloc_bytes < size_of::<u16>() {
    return None;
  }

  let lock = GlobalLockGuard::lock(clip, hdata as HGLOBAL)?;

  // Any sequence of N non-NUL UTF-16 code units decodes to at least N UTF-8 bytes
  // (BMP chars are 1..=3 bytes; surrogate pairs are 2 units -> 4 bytes = 2 bytes/unit).
  // Capping the scan at `max_utf8_bytes + 1` code units bounds memory inspection even
  // when a huge HGLOBAL is placed on the clipboard.
  let alloc_units = alloc_bytes / size_of::<u16>();
  let max_scan_units = max_utf8_bytes.saturating_add(1);
  let scan_units = alloc_units.min(max_scan_units);
  let scan_bytes = scan_units.saturating_mul(size_of::<u16>());

  let raw_bytes = unsafe { std::slice::from_raw_parts(lock.as_ptr(), scan_bytes) };

  let mut nul_pos = None;
  for (idx, chunk) in raw_bytes.chunks_exact(size_of::<u16>()).enumerate() {
    if u16::from_ne_bytes([chunk[0], chunk[1]]) == 0 {
      nul_pos = Some(idx);
      break;
    }
  }

  let effective_units = match nul_pos {
    Some(idx) => idx,
    None => {
      if alloc_units > max_utf8_bytes {
        return None;
      }
      scan_units
    }
  };

  if effective_units == 0 || effective_units > max_utf8_bytes {
    return None;
  }

  let effective_bytes = &raw_bytes[..effective_units * size_of::<u16>()];
  let utf16_iter = effective_bytes
    .chunks_exact(size_of::<u16>())
    .map(|chunk| u16::from_ne_bytes([chunk[0], chunk[1]]));

  let mut out = String::with_capacity(effective_units.min(max_utf8_bytes));
  for decoded in char::decode_utf16(utf16_iter) {
    let ch = decoded.ok()?;
    let next_len = out.len().checked_add(ch.len_utf8())?;
    if next_len > max_utf8_bytes {
      return None;
    }
    out.push(ch);
  }

  Some(out)
}

fn encode_utf16_nul_bytes(text: &str) -> Vec<u8> {
  let mut bytes =
    Vec::with_capacity(text.len().saturating_add(1).saturating_mul(size_of::<u16>()));
  for unit in text.encode_utf16() {
    bytes.extend_from_slice(&unit.to_ne_bytes());
  }
  bytes.extend_from_slice(&0u16.to_ne_bytes());
  bytes
}

fn build_own_marker_payload(instance_id: u64, write_counter: u64) -> [u8; 20] {
  let pid = unsafe { GetCurrentProcessId() };
  let mut buf = [0u8; 20];
  buf[0..4].copy_from_slice(&pid.to_ne_bytes());
  buf[4..12].copy_from_slice(&instance_id.to_ne_bytes());
  buf[12..20].copy_from_slice(&write_counter.to_ne_bytes());
  buf
}
