// host-core/bot-browser/desktop-cdp.js
//
// Direct Chromium DevTools Protocol (CDP) transport and child process lifecycle:
//   - Primary on POSIX (Linux/macOS): private stdio pipe (--remote-debugging-pipe,
//     FD 3 write / FD 4 read, NUL-delimited JSON-RPC, zero listening TCP ports).
//   - Primary on Windows (or explicit loopback mode): ephemeral 127.0.0.1-only
//     DevTools WebSocket via `ws` (strictly validated ws://127.0.0.1:<port>/devtools/browser/<id>,
//     never 0.0.0.0, never --remote-allow-origins=*).
//
// Portions of profile lock error detection adapted from Orca v1.4.265
// (commit e64e561738d8d465ab459e7e3f9e46d08b6396ea):
//   - src/main/orcad/browser-providers/chromium/external-chromium-browser-session.ts
// MIT License — Copyright (c) 2026 Lovecast Inc.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import {
  buildChromiumLaunchArgs,
  isolateChildBrowserEnvironment,
} from './desktop-discovery.js';
import { browserError, DESKTOP_BROWSER_DEFAULT_VIEWPORT } from './desktop-policy.js';
import {
  isWindowsDevToolsProfileInUse,
  readWindowsDevToolsEndpoint,
  verifyWindowsDevToolsOwner,
} from './desktop-windows-endpoint.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const WINDOWS_PROFILE_OCCUPANCY_TIMEOUT_MS = 2_500;
const DEFAULT_COMMAND_TIMEOUT_MS = 25_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_CDP_MESSAGE_BYTES = 24 * 1024 * 1024;
const MAX_STDERR_TAIL_BYTES = 8_192;
// CHROME_RESULT_CODE_PROFILE_IN_USE in chrome/common/chrome_result_codes.h.
const CHROMIUM_PROFILE_IN_USE_EXIT_CODE = 21;

const DEVTOOLS_PATH_RE = /^\/devtools\/browser\/[A-Za-z0-9_-]+$/;
const DEVTOOLS_LISTENING_RE = /DevTools listening on (ws:\/\/[^\s\r\n]+)/;

/**
 * Strictly validate a Chromium DevTools WebSocket endpoint so the client can
 * ONLY ever connect to a local 127.0.0.1 loopback browser target.
 */
export function parseLoopbackDevToolsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw browserError('BROWSER_UNSAFE_ENDPOINT', 'Missing DevTools WebSocket URL.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw browserError('BROWSER_UNSAFE_ENDPOINT', 'Malformed DevTools WebSocket URL.');
  }
  if (parsed.protocol !== 'ws:') {
    throw browserError('BROWSER_UNSAFE_ENDPOINT', 'DevTools endpoint must use ws: on loopback.');
  }
  if (parsed.hostname !== '127.0.0.1') {
    throw browserError('BROWSER_UNSAFE_ENDPOINT', 'Refusing non-loopback DevTools endpoint.');
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw browserError('BROWSER_UNSAFE_ENDPOINT', 'Invalid DevTools loopback port.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw browserError('BROWSER_UNSAFE_ENDPOINT', 'Unexpected credentials or query in DevTools endpoint.');
  }
  if (!DEVTOOLS_PATH_RE.test(parsed.pathname)) {
    throw browserError('BROWSER_UNSAFE_ENDPOINT', 'Unexpected DevTools browser path.');
  }
  return parsed.toString();
}

export function parseDevToolsListeningUrl(stderrText) {
  if (typeof stderrText !== 'string' || !stderrText) return null;
  const match = DEVTOOLS_LISTENING_RE.exec(stderrText);
  if (!match) return null;
  return parseLoopbackDevToolsUrl(match[1]);
}

// Adapted from Orca external-chromium-browser-session.ts (MIT).
export function unwritableProfileLockLine(stderrText) {
  if (typeof stderrText !== 'string' || !stderrText) return undefined;
  return stderrText
    .split(/\r?\n/)
    .find((line) => /SingletonLock: (Permission denied|Read-only file system)/.test(line))
    ?.trim();
}

/**
 * Private POSIX stdio pipe transport for Chromium `--remote-debugging-pipe`.
 * Chromium reads NUL-delimited JSON from FD 3 and writes NUL-delimited JSON to FD 4.
 */
export class PipeCdpTransport {
  constructor(writeStream, readStream, { maxMessageBytes = MAX_CDP_MESSAGE_BYTES } = {}) {
    if (!writeStream || !readStream) {
      throw browserError('BROWSER_START_FAILED', 'Missing stdio pipes for --remote-debugging-pipe.');
    }
    this._writeStream = writeStream;
    this._readStream = readStream;
    this._maxMessageBytes = maxMessageBytes;
    this._messageHandlers = new Set();
    this._closeHandlers = new Set();
    this._buffer = Buffer.alloc(0);
    this._closed = false;

    this._onData = (chunk) => {
      if (this._closed) return;
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this._buffer = this._buffer.length === 0 ? incoming : Buffer.concat([this._buffer, incoming]);
      if (this._buffer.length > this._maxMessageBytes) {
        this._emitClose(
          browserError('BROWSER_CDP_PROTOCOL_ERROR', 'CDP pipe message exceeded size limit.')
        );
        return;
      }
      let nulIndex = this._buffer.indexOf(0x00);
      while (nulIndex !== -1) {
        const frameBytes = this._buffer.subarray(0, nulIndex);
        this._buffer = this._buffer.subarray(nulIndex + 1);
        if (frameBytes.length > 0) {
          let parsed;
          try {
            parsed = JSON.parse(frameBytes.toString('utf8'));
          } catch {
            this._emitClose(
              browserError('BROWSER_CDP_PROTOCOL_ERROR', 'Received malformed JSON on CDP pipe.')
            );
            return;
          }
          for (const handler of this._messageHandlers) {
            try {
              handler(parsed);
            } catch {
              // Ignore listener errors to avoid corrupting transport framing.
            }
          }
        }
        nulIndex = this._buffer.indexOf(0x00);
      }
    };

    this._onEnd = () => {
      this._emitClose();
    };
    this._onError = (err) => {
      this._emitClose(err);
    };

    this._readStream.on('data', this._onData);
    this._readStream.on('end', this._onEnd);
    this._readStream.on('close', this._onEnd);
    this._readStream.on('error', this._onError);
    this._writeStream.on('error', this._onError);
    this._writeStream.on('close', this._onEnd);
  }

  get kind() {
    return 'pipe';
  }

  onMessage(handler) {
    this._messageHandlers.add(handler);
    return () => this._messageHandlers.delete(handler);
  }

  onClose(handler) {
    this._closeHandlers.add(handler);
    return () => this._closeHandlers.delete(handler);
  }

  send(payload) {
    if (this._closed) {
      throw browserError('BROWSER_PROCESS_EXITED', 'CDP pipe transport is closed.', {
        outcome: 'not-sent',
      });
    }
    const serialized = `${JSON.stringify(payload)}\0`;
    this._writeStream.write(serialized, 'utf8');
  }

  close() {
    this._emitClose();
  }

  _emitClose(error = null) {
    if (this._closed) return;
    this._closed = true;
    this._buffer = Buffer.alloc(0);
    this._readStream.off('data', this._onData);
    this._readStream.off('end', this._onEnd);
    this._readStream.off('close', this._onEnd);
    this._readStream.off('error', this._onError);
    this._writeStream.off('error', this._onError);
    this._writeStream.off('close', this._onEnd);
    try {
      this._writeStream.end();
    } catch {
      // ignore
    }
    try {
      this._readStream.destroy();
    } catch {
      // ignore
    }
    for (const handler of this._closeHandlers) {
      try {
        handler(error);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Loopback-only 127.0.0.1 DevTools WebSocket transport (Windows primary).
 */
export class LoopbackWebSocketCdpTransport {
  constructor(ws) {
    this._ws = ws;
    this._messageHandlers = new Set();
    this._closeHandlers = new Set();
    this._closed = false;

    this._onMessage = (data) => {
      if (this._closed) return;
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        this._emitClose(
          browserError('BROWSER_CDP_PROTOCOL_ERROR', 'Received malformed JSON on CDP WebSocket.')
        );
        return;
      }
      for (const handler of this._messageHandlers) {
        try {
          handler(parsed);
        } catch {
          // ignore
        }
      }
    };

    this._onClose = () => {
      this._emitClose();
    };
    this._onError = (err) => {
      this._emitClose(err);
    };

    this._ws.on('message', this._onMessage);
    this._ws.on('close', this._onClose);
    this._ws.on('error', this._onError);
  }

  static connect(
    wsUrl,
    {
      timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
      signal = undefined,
      createWebSocket = (url, options) => new WebSocket(url, options),
    } = {}
  ) {
    const validatedUrl = parseLoopbackDevToolsUrl(wsUrl);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(browserError('CANCELLED', 'Browser connection aborted.', { outcome: 'not-sent' }));
        return;
      }
      let settled = false;
      const ws = createWebSocket(validatedUrl, {
        perMessageDeflate: false,
        maxPayload: MAX_CDP_MESSAGE_BYTES,
      });

      const cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onEarlyClose);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          ws.terminate?.();
        } catch {
          try {
            ws.close();
          } catch {
            // ignore
          }
        }
        reject(err);
      };

      const onAbort = () => {
        fail(browserError('CANCELLED', 'Browser connection aborted.', { outcome: 'not-sent' }));
      };
      const onOpen = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(new LoopbackWebSocketCdpTransport(ws));
      };
      const onError = (err) => {
        fail(
          browserError(
            'BROWSER_START_FAILED',
            `Failed to connect to local Chromium DevTools WebSocket: ${err?.message || 'error'}`
          )
        );
      };
      const onEarlyClose = () => {
        fail(browserError('BROWSER_START_FAILED', 'Chromium DevTools WebSocket closed during startup.'));
      };

      const timer = setTimeout(() => {
        fail(browserError('BROWSER_TIMEOUT', 'Timed out connecting to Chromium DevTools WebSocket.'));
      }, timeoutMs);
      timer.unref?.();

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onEarlyClose);
    });
  }

  get kind() {
    return 'loopback';
  }

  onMessage(handler) {
    this._messageHandlers.add(handler);
    return () => this._messageHandlers.delete(handler);
  }

  onClose(handler) {
    this._closeHandlers.add(handler);
    return () => this._closeHandlers.delete(handler);
  }

  send(payload) {
    if (this._closed || this._ws.readyState !== 1) {
      throw browserError('BROWSER_PROCESS_EXITED', 'CDP WebSocket transport is closed.', {
        outcome: 'not-sent',
      });
    }
    this._ws.send(JSON.stringify(payload));
  }

  close() {
    this._emitClose();
  }

  _emitClose(error = null) {
    if (this._closed) return;
    this._closed = true;
    this._ws.off('message', this._onMessage);
    this._ws.off('close', this._onClose);
    this._ws.off('error', this._onError);
    try {
      this._ws.close();
    } catch {
      // ignore
    }
    for (const handler of this._closeHandlers) {
      try {
        handler(error);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Transport-agnostic multiplexed CDP JSON-RPC client.
 * Never logs command parameters or frame payloads.
 */
export class CdpClient {
  constructor(transport, { defaultTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    this._transport = transport;
    this._defaultTimeoutMs = defaultTimeoutMs;
    this._nextId = 1;
    this._pending = new Map();
    this._eventHandlers = new Set();
    this._closeHandlers = new Set();
    this._closed = false;

    this._offMessage = transport.onMessage((msg) => this._handleMessage(msg));
    this._offClose = transport.onClose((err) => this._handleClose(err));
  }

  get closed() {
    return this._closed;
  }

  onEvent(handler) {
    this._eventHandlers.add(handler);
    return () => this._eventHandlers.delete(handler);
  }

  onClose(handler) {
    this._closeHandlers.add(handler);
    return () => this._closeHandlers.delete(handler);
  }

  send(method, params = {}, { sessionId = undefined, timeoutMs = undefined, signal = undefined } = {}) {
    if (this._closed) {
      return Promise.reject(
        browserError('BROWSER_PROCESS_EXITED', `Cannot send ${method}: browser session is closed.`, {
          outcome: 'not-sent',
        })
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        browserError('CANCELLED', `Browser command ${method} aborted before dispatch.`, {
          outcome: 'not-sent',
        })
      );
    }

    const id = this._nextId++;
    const effectiveTimeout = timeoutMs ?? this._defaultTimeoutMs;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this._pending.delete(id);
      };

      const onAbort = () => {
        cleanup();
        reject(
          browserError('CANCELLED', `Browser command ${method} aborted while in flight.`, {
            outcome: 'unconfirmed',
          })
        );
      };

      timer = setTimeout(() => {
        cleanup();
        reject(
          browserError('BROWSER_TIMEOUT', `Browser CDP command timed out: ${method}`, {
            outcome: 'unconfirmed',
          })
        );
      }, effectiveTimeout);
      timer.unref?.();

      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      this._pending.set(id, {
        method,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });

      try {
        this._transport.send(payload);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  close() {
    this._handleClose();
    this._transport.close();
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.id === 'number') {
      const entry = this._pending.get(msg.id);
      if (!entry) return;
      if (msg.error) {
        const errMsg = typeof msg.error.message === 'string' ? msg.error.message : 'CDP command failed';
        const code = classifyCdpError(errMsg);
        entry.reject(browserError(code, `${entry.method}: ${errMsg}`));
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const event = {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId ?? null,
      };
      for (const handler of this._eventHandlers) {
        try {
          handler(event);
        } catch {
          // ignore
        }
      }
    }
  }

  _handleClose(error = null) {
    if (this._closed) return;
    this._closed = true;
    this._offMessage?.();
    this._offClose?.();
    const closeErr = browserError(
      'BROWSER_PROCESS_EXITED',
      error?.message ? `Browser connection closed: ${error.message}` : 'Browser connection closed.',
      { outcome: 'unconfirmed' }
    );
    for (const entry of this._pending.values()) {
      entry.reject(closeErr);
    }
    this._pending.clear();
    for (const handler of this._closeHandlers) {
      try {
        handler(error);
      } catch {
        // ignore
      }
    }
  }
}

function classifyCdpError(message) {
  if (/no node with given id|could not find node|cannot find context/i.test(message)) {
    return 'BROWSER_STALE_REF';
  }
  if (/target closed|session with given id not found|inspected target navigated or closed/i.test(message)) {
    return 'BROWSER_TAB_CLOSED';
  }
  if (/net::err_|cannot navigate to invalid url/i.test(message)) {
    return 'BROWSER_NAVIGATION_FAILED';
  }
  return 'BROWSER_CDP_ERROR';
}

function terminateChildTree(child, platform, force = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;

  if (platform === 'win32') {
    if (force) {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.unref?.();
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    // Kill the detached child process group we spawned; never pkill by name.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('exit', finish);
      child.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once('exit', finish);
    child.once('close', finish);
  });
}

function waitForLoopbackUrl(child, { timeoutMs, signal, getStderr, windowsEndpoint }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(browserError('CANCELLED', 'Chromium startup aborted.', { outcome: 'not-sent' }));
      return;
    }

    let settled = false;
    let checking = false;
    let cleanExit = child.exitCode === 0 && !child.signalCode;
    let unchangedProfileEndpoint = false;
    let checkedProfileOccupancy = false;
    let pollTimer;
    const verification = new AbortController();
    const deadline = Date.now() + timeoutMs;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(pollTimer);
      verification.abort();
      if (signal) signal.removeEventListener('abort', onAbort);
      child.stderr?.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (url) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };

    const failProfileInUse = () => {
      fail(browserError('BROWSER_START_FAILED', 'Chromium is already using this Bot browser profile.', {
        data: { profileInUse: true },
      }));
    };

    const checkStderr = async () => {
      if (checking || settled) return;
      clearTimeout(pollTimer);
      checking = true;
      try {
        let url = parseDevToolsListeningUrl(getStderr());
        let fromProfile = false;
        if (!url && windowsEndpoint && cleanExit) {
          if (windowsEndpoint.baselineError) throw windowsEndpoint.baselineError;
          const record = await windowsEndpoint.readEndpoint(windowsEndpoint.profilePath);
          unchangedProfileEndpoint = Boolean(record && record.contents === windowsEndpoint.baseline?.contents);
          if (unchangedProfileEndpoint && !checkedProfileOccupancy && !settled) {
            checkedProfileOccupancy = true;
            // A clean wrapper exit can mean a new de-elevated browser is
            // still starting. Keep polling while independently checking whether
            // the previous listener's process already owns this exact profile.
            void windowsEndpoint.isProfileInUse({
              url: record.url, executablePath: windowsEndpoint.executablePath,
              profilePath: windowsEndpoint.profilePath, nonce: windowsEndpoint.nonce,
              signal: verification.signal,
              timeoutMs: Math.max(1, Math.min(WINDOWS_PROFILE_OCCUPANCY_TIMEOUT_MS, deadline - Date.now())),
            }).then(inUse => {
              if (inUse && unchangedProfileEndpoint) failProfileInUse();
            });
          }
          if (record && record.contents !== windowsEndpoint.baseline?.contents
              && record.mtimeMs >= windowsEndpoint.startedAt) {
            url = parseLoopbackDevToolsUrl(record.url);
            fromProfile = true;
          }
        }
        if (url && !settled) {
          if (fromProfile) {
            await windowsEndpoint.verifyOwner({
              url, executablePath: windowsEndpoint.executablePath, nonce: windowsEndpoint.nonce,
              signal: verification.signal, timeoutMs: Math.max(1, deadline - Date.now()),
            });
          }
          if (!settled) succeed(url);
        }
      } catch (err) {
        fail(err);
      } finally {
        checking = false;
        if (!settled && windowsEndpoint && cleanExit) {
          pollTimer = setTimeout(checkStderr, 50);
          pollTimer.unref?.();
        }
      }
    };

    const onStderr = () => checkStderr();
    const onAbort = () => {
      fail(browserError('CANCELLED', 'Chromium startup aborted.', { outcome: 'not-sent' }));
    };
    const onError = (err) => {
      fail(browserError('BROWSER_START_FAILED', `Failed to spawn Chromium: ${err?.message || 'error'}`));
    };
    const onExit = (code, exitSignal) => {
      if (windowsEndpoint && code === CHROMIUM_PROFILE_IN_USE_EXIT_CODE && !exitSignal) {
        failProfileInUse();
        return;
      }
      const stderr = getStderr();
      const lockLine = unwritableProfileLockLine(stderr);
      if (lockLine) {
        fail(
          browserError(
            'BROWSER_PROFILE_UNWRITABLE',
            `Chromium cannot lock its profile directory (${lockLine}).`
          )
        );
        return;
      }
      // Elevated Chrome may hand off to a de-elevated browser with the same
      // arguments. Inherited stderr is trusted; profile-file endpoints require
      // independent listener ownership proof before connecting.
      if (windowsEndpoint && code === 0 && !exitSignal) {
        cleanExit = true;
        void checkStderr();
        return;
      }
      fail(
        browserError(
          'BROWSER_START_FAILED',
          `Chromium exited before DevTools became ready (code=${String(code)}, signal=${String(exitSignal)}).`
        )
      );
    };

    const timer = setTimeout(() => {
      const message = windowsEndpoint?.baseline
        ? 'Timed out waiting for a new Chromium DevTools endpoint. An existing browser may still be using this Bot profile; close that browser before retrying.'
        : 'Timed out waiting for Chromium DevTools startup.';
      const details = cleanExit && unchangedProfileEndpoint ? { data: { profileInUse: true } } : {};
      fail(browserError('BROWSER_TIMEOUT', message, details));
    }, timeoutMs);
    if (!windowsEndpoint) timer.unref?.();

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
    if (!settled) void checkStderr();
  });
}

/**
 * Spawn an isolated headless Chromium process for a single Bot and establish a
 * private CDP session (POSIX pipe or Windows loopback WebSocket).
 */
export async function launchDesktopChromium({
  executablePath,
  profilePath,
  transport = process.platform === 'win32' ? 'loopback' : 'pipe',
  viewport = DESKTOP_BROWSER_DEFAULT_VIEWPORT,
  platform = process.platform,
  env = process.env,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  signal = undefined,
  spawnImpl = spawn,
  createWebSocket = undefined,
  readWindowsEndpoint = readWindowsDevToolsEndpoint,
  verifyWindowsOwner = verifyWindowsDevToolsOwner,
  checkWindowsProfileInUse = isWindowsDevToolsProfileInUse,
} = {}) {
  if (signal?.aborted) {
    throw browserError('CANCELLED', 'Chromium launch aborted.', { outcome: 'not-sent' });
  }

  const args = buildChromiumLaunchArgs({
    profilePath,
    transport,
    viewport,
    platform,
  });
  const windowsLoopback = platform === 'win32' && transport === 'loopback';
  const startupDeadline = Date.now() + startupTimeoutMs;
  const nonce = windowsLoopback ? randomBytes(32).toString('hex') : null;
  let baseline = null;
  let baselineError = null;
  if (windowsLoopback) {
    try { baseline = await readWindowsEndpoint(profilePath); } catch (error) { baselineError = error; }
  }
  const startedAt = Date.now();
  if (windowsLoopback) args.unshift(`--pibot-launch-nonce=${nonce}`);
  if (signal?.aborted) throw browserError('CANCELLED', 'Chromium launch aborted.', { outcome: 'not-sent' });
  const remainingStartupMs = () => {
    const remaining = startupDeadline - Date.now();
    if (remaining <= 0) throw browserError('BROWSER_TIMEOUT', 'Timed out waiting for Chromium DevTools startup.');
    return remaining;
  };
  remainingStartupMs();
  const childEnv = isolateChildBrowserEnvironment(env);
  const stdio =
    transport === 'pipe'
      ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
      : ['ignore', 'ignore', 'pipe'];

  const child = spawnImpl(executablePath, args, {
    stdio,
    env: childEnv,
    detached: platform !== 'win32',
    windowsHide: true,
  });

  let spawnError = null;
  let stderrTail = '';
  child.stderr?.on('data', (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    stderrTail += text;
    if (stderrTail.length > MAX_STDERR_TAIL_BYTES) {
      stderrTail = stderrTail.slice(-MAX_STDERR_TAIL_BYTES);
    }
  });

  const onHostExit = () => {
    terminateChildTree(child, platform, true);
  };
  process.once('exit', onHostExit);

  let closed = false;
  let client = null;
  let cdpTransport = null;

  // Always attach error/exit listeners so async spawn failures (ENOENT/EACCES)
  // never become uncaught EventEmitter errors in pipe or loopback mode.
  child.on('error', (err) => {
    spawnError = err;
    cdpTransport?.close();
  });
  child.on('exit', (code, exitSignal) => {
    if (!(windowsLoopback && code === 0 && !exitSignal)) cdpTransport?.close();
  });

  const close = async () => {
    if (closed) return;
    closed = true;
    process.off('exit', onHostExit);

    if (client && !client.closed) {
      try {
        await client.send('Browser.close', {}, { timeoutMs: CLOSE_GRACE_MS });
      } catch {
        // Fallback to process termination below.
      }
      client.close();
    } else if (cdpTransport) {
      cdpTransport.close();
    }

    await waitForChildExit(child, 500);
    if (child.exitCode === null && child.signalCode === null) {
      terminateChildTree(child, platform, false);
      await waitForChildExit(child, CLOSE_GRACE_MS);
    }
    if (child.exitCode === null && child.signalCode === null) {
      terminateChildTree(child, platform, true);
      await waitForChildExit(child, 1_000);
    }
  };

  try {
    if (transport === 'pipe') {
      const writePipe = child.stdio?.[3];
      const readPipe = child.stdio?.[4];
      if (!writePipe || !readPipe) {
        throw browserError(
          'BROWSER_START_FAILED',
          'Chromium process did not expose private FD 3/4 debugging pipes.'
        );
      }
      cdpTransport = new PipeCdpTransport(writePipe, readPipe);
    } else {
      const wsUrl = await waitForLoopbackUrl(child, {
        timeoutMs: remainingStartupMs(),
        signal,
        getStderr: () => stderrTail,
        windowsEndpoint: windowsLoopback ? {
          profilePath, executablePath, nonce, baseline, baselineError, startedAt,
          readEndpoint: readWindowsEndpoint, verifyOwner: verifyWindowsOwner,
          isProfileInUse: checkWindowsProfileInUse,
        } : null,
      });
      cdpTransport = await LoopbackWebSocketCdpTransport.connect(wsUrl, {
        timeoutMs: remainingStartupMs(),
        signal,
        ...(createWebSocket ? { createWebSocket } : {}),
      });
      if (spawnError || (child.exitCode !== null && !(windowsLoopback && child.exitCode === 0)) || child.signalCode !== null) {
        throw browserError('BROWSER_START_FAILED', 'Chromium exited while connecting to DevTools.');
      }
    }

    client = new CdpClient(cdpTransport, { defaultTimeoutMs: commandTimeoutMs });

    const browserVersion = await client.send(
      'Browser.getVersion',
      {},
      { timeoutMs: remainingStartupMs(), signal }
    );

    return {
      client,
      transport,
      pid: child.pid ?? null,
      browserVersion: {
        product: browserVersion?.product ?? null,
        protocolVersion: browserVersion?.protocolVersion ?? null,
      },
      close,
    };
  } catch (err) {
    const lockLine = unwritableProfileLockLine(stderrTail);
    const earlySpawnErr = spawnError;
    await close();
    if (lockLine && err?.code !== 'BROWSER_PROFILE_UNWRITABLE' && !err?.data?.profileInUse) {
      throw browserError(
        'BROWSER_PROFILE_UNWRITABLE',
        `Chromium cannot lock its profile directory (${lockLine}).`
      );
    }
    if (earlySpawnErr && err?.code === 'BROWSER_PROCESS_EXITED') {
      throw browserError(
        'BROWSER_START_FAILED',
        `Failed to spawn Chromium: ${earlySpawnErr.message || 'error'}`
      );
    }
    throw err;
  }
}
