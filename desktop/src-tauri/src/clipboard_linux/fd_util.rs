//! Minimal POSIX pipe/poll helpers for cancellable, strictly time- and byte-bounded
//! clipboard reads and event loops on Linux.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Self-pipe used to interrupt blocking `poll(2)` loops immediately on shutdown or command wakeup.
pub(crate) struct WakePipe {
  read_fd: OwnedFd,
  write_fd: Arc<OwnedFd>,
}

/// Cross-thread handle that wakes the corresponding [`WakePipe`].
#[derive(Clone)]
pub(crate) struct Waker {
  write_fd: Arc<OwnedFd>,
}

impl WakePipe {
  pub(crate) fn new() -> io::Result<Self> {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: `fds` is a valid 2-element array for `pipe2`.
    let rc = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) };
    if rc != 0 {
      return Err(io::Error::last_os_error());
    }
    // SAFETY: `pipe2` succeeded and returned two newly opened, unique file descriptors.
    let read_fd = unsafe { OwnedFd::from_raw_fd(fds[0]) };
    let write_fd = unsafe { OwnedFd::from_raw_fd(fds[1]) };
    Ok(Self {
      read_fd,
      write_fd: Arc::new(write_fd),
    })
  }

  pub(crate) fn waker(&self) -> Waker {
    Waker {
      write_fd: Arc::clone(&self.write_fd),
    }
  }

  pub(crate) fn read_raw_fd(&self) -> RawFd {
    self.read_fd.as_raw_fd()
  }

  /// Drains pending wakeup bytes without blocking so level-triggered `poll` resets.
  pub(crate) fn drain(&self) {
    let mut buf = [0u8; 64];
    loop {
      // SAFETY: `read_fd` is valid and owned by `self`; `buf` is valid for `buf.len()` bytes.
      let n = unsafe {
        libc::read(
          self.read_fd.as_raw_fd(),
          buf.as_mut_ptr().cast(),
          buf.len(),
        )
      };
      if n > 0 {
        continue;
      }
      if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
        continue;
      }
      break;
    }
  }
}

impl Waker {
  /// Writes a single wakeup byte without blocking.
  pub(crate) fn wake(&self) {
    let byte = [1u8; 1];
    loop {
      // SAFETY: `write_fd` is valid and kept alive by `Arc<OwnedFd>`; `byte` is 1 readable byte.
      let n = unsafe { libc::write(self.write_fd.as_raw_fd(), byte.as_ptr().cast(), 1) };
      if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
        continue;
      }
      break;
    }
  }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PollOutcome {
  pub(crate) primary_ready: bool,
  pub(crate) primary_error: bool,
  pub(crate) wake_ready: bool,
  pub(crate) timed_out: bool,
}

/// Polls `primary_fd` and `wake_fd` for readability until `deadline` (or indefinitely if `None`),
/// automatically retrying `EINTR` without extending the deadline.
pub(crate) fn poll_two(
  primary_fd: RawFd,
  wake_fd: RawFd,
  deadline: Option<Instant>,
) -> io::Result<PollOutcome> {
  loop {
    let timeout_ms: libc::c_int = match deadline {
      None => -1,
      Some(end) => {
        let now = Instant::now();
        if now >= end {
          return Ok(PollOutcome {
            primary_ready: false,
            primary_error: false,
            wake_ready: false,
            timed_out: true,
          });
        }
        let rem = end.saturating_duration_since(now);
        // Round up sub-millisecond remainders to 1ms so we do not spin before `end`.
        let ms = rem.as_millis();
        if ms == 0 {
          1
        } else {
          ms.min(libc::c_int::MAX as u128) as libc::c_int
        }
      }
    };

    let mut fds = [
      libc::pollfd {
        fd: primary_fd,
        events: libc::POLLIN,
        revents: 0,
      },
      libc::pollfd {
        fd: wake_fd,
        events: libc::POLLIN,
        revents: 0,
      },
    ];

    // SAFETY: `fds` is a valid 2-element `pollfd` slice for the duration of `poll`.
    let rc = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout_ms) };
    if rc < 0 {
      let err = io::Error::last_os_error();
      if err.kind() == io::ErrorKind::Interrupted {
        continue;
      }
      return Err(err);
    }

    if rc == 0 {
      return Ok(PollOutcome {
        primary_ready: false,
        primary_error: false,
        wake_ready: false,
        timed_out: true,
      });
    }

    let p = fds[0].revents;
    let w = fds[1].revents;
    return Ok(PollOutcome {
      primary_ready: (p & (libc::POLLIN | libc::POLLHUP)) != 0,
      primary_error: (p & (libc::POLLERR | libc::POLLNVAL)) != 0,
      wake_ready: (w & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)) != 0,
      timed_out: false,
    });
  }
}

pub(crate) fn set_nonblocking(fd: RawFd) -> io::Result<()> {
  // SAFETY: `F_GETFL` takes no additional arguments and operates on a valid caller-owned fd.
  let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
  if flags < 0 {
    return Err(io::Error::last_os_error());
  }
  // SAFETY: `F_SETFL` sets file status flags with `O_NONBLOCK` preserved alongside existing flags.
  let rc = unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) };
  if rc < 0 {
    return Err(io::Error::last_os_error());
  }
  Ok(())
}

/// Reads from `read_fd` until EOF under strict byte (`max_bytes`) and wall-clock (`timeout`)
/// bounds, aborting immediately if `stop_flag` or `stop_fd` signals shutdown.
pub(crate) fn read_fd_bounded(
  read_fd: RawFd,
  stop_fd: RawFd,
  stop_flag: &AtomicBool,
  max_bytes: usize,
  timeout: Duration,
) -> Option<Vec<u8>> {
  if set_nonblocking(read_fd).is_err() {
    return None;
  }

  let deadline = Instant::now() + timeout;
  let mut buf = Vec::new();
  let mut scratch = [0u8; 4096];

  loop {
    if stop_flag.load(Ordering::Acquire) {
      return None;
    }

    let outcome = poll_two(read_fd, stop_fd, Some(deadline)).ok()?;
    if outcome.wake_ready || outcome.timed_out {
      return None;
    }
    if outcome.primary_error && !outcome.primary_ready {
      return None;
    }
    if !outcome.primary_ready {
      continue;
    }

    loop {
      if stop_flag.load(Ordering::Acquire) {
        return None;
      }
      // SAFETY: `read_fd` is valid for this call and `scratch` is writable for `scratch.len()`.
      let n = unsafe { libc::read(read_fd, scratch.as_mut_ptr().cast(), scratch.len()) };
      if n > 0 {
        let n = n as usize;
        if buf.len().saturating_add(n) > max_bytes {
          return None;
        }
        buf.extend_from_slice(&scratch[..n]);
      } else if n == 0 {
        return Some(buf);
      } else {
        match io::Error::last_os_error().kind() {
          io::ErrorKind::Interrupted => continue,
          io::ErrorKind::WouldBlock => break,
          _ => return None,
        }
      }
    }
  }
}
