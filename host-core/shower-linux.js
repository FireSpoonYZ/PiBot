// host-core/shower-linux.js
// Linux Shower backend: one private Xvnc (Xvnc/Xtigervnc) DISPLAY per session, with
// its own Xauthority, 0700 runtime dir and own dbus-daemon session bus, a
// lightweight desktop, and xdotool/ffmpeg bound to that DISPLAY only. The physical
// desktop is never captured, injected or shadowed (no x0vncserver/shadow, never
// :0). Programs must already be installed; nothing is ever installed
// automatically. Cleanup stops only the process groups this backend started and
// removes only its own temporary dirs: never pkill, never adopt or reuse a display
// owned by someone else.
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as FS_CONSTANTS,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { messageError } from './message-protocol.js';
import { CuaMcpClient, validateCuaRequest } from './cua-mcp.js';
import { resolveCuaDriverPath } from './cua-driver.js';
import { SHOWER_MAX_FRAME_BASE64_BYTES } from './shower-protocol.js';

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_DIMENSION = 160;
const MAX_DIMENSION = 4096;

// Private display range, far from :0 and from the displays a user habitually runs.
const DISPLAY_FIRST = 100;
const DISPLAY_LAST = 599;
const RFB_PORT_BASE = 5900;
const X11_SOCKET_DIR = '/tmp/.X11-unix';

const READY_TIMEOUT_MS = 15_000;
const DBUS_ADDRESS_TIMEOUT_MS = 1_500;
const WM_START_GRACE_MS = 300;
const COMMAND_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;
const STOP_TIMEOUT_MS = 3_000;
const LOG_TAIL_LIMIT = 2_000;
const MIN_DRAG_MS = 50;
const MAX_DRAG_MS = 3000;
const MAX_TEXT_LENGTH = 1000;
const MAX_WHEEL_NOTCHES = 20;
// Keysyms the driver may leave latched on the private display when it is killed
// mid-call: every left/right modifier variant plus X11 pointer buttons 1-5.
const CUA_RELEASE_KEYSYMS = [
  'Control_L', 'Control_R', 'Alt_L', 'Alt_R', 'Shift_L', 'Shift_R',
  'Super_L', 'Super_R', 'Meta_L', 'Meta_R',
];
const CUA_RELEASE_BUTTONS = ['1', '2', '3', '4', '5'];

const REQUIREMENTS = [
  { key: 'server', label: 'Xvnc or Xtigervnc', candidates: ['Xtigervnc', 'Xvnc'] },
  { key: 'wm', label: 'xfwm4 or openbox', candidates: ['xfwm4', 'openbox'] },
  { key: 'desktop', label: 'xfdesktop', candidates: ['xfdesktop'] },
  { key: 'panel', label: 'xfce4-panel', candidates: ['xfce4-panel'] },
  { key: 'terminal', label: 'xfce4-terminal', candidates: ['xfce4-terminal'] },
  { key: 'xauth', label: 'xauth', candidates: ['xauth'] },
  { key: 'dbus', label: 'dbus-daemon', candidates: ['dbus-daemon'] },
  { key: 'xdotool', label: 'xdotool', candidates: ['xdotool'] },
  { key: 'ffmpeg', label: 'ffmpeg', candidates: ['ffmpeg'] },
];

const KEYSYM_BY_KEY = Object.freeze({
  ENTER: 'Return',
  TAB: 'Tab',
  ESCAPE: 'Escape',
  SPACE: 'space',
  BACKSPACE: 'BackSpace',
  DELETE: 'Delete',
  LEFT: 'Left',
  RIGHT: 'Right',
  UP: 'Up',
  DOWN: 'Down',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'Prior',
  PAGEDOWN: 'Next',
});

const CAPABILITY_KEYS = Object.freeze([
  ...Object.keys(KEYSYM_BY_KEY),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

const MODIFIER_SYMBOL = Object.freeze({ CTRL: 'ctrl', ALT: 'alt', SHIFT: 'shift', META: 'super' });
const POINTER_BUTTON = Object.freeze({ left: '1', middle: '2', right: '3' });
// X11 wheel buttons: 4 up, 5 down, 6 left, 7 right. Scroll deltas are notches with
// positive Y = down and positive X = right, so the sign maps directly to the button.
const WHEEL_UP_BUTTON = '4';
const WHEEL_DOWN_BUTTON = '5';
const WHEEL_LEFT_BUTTON = '6';
const WHEEL_RIGHT_BUTTON = '7';

function checkAborted(signal) {
  if (signal?.aborted) throw messageError('CANCELLED', 'shower operation was cancelled');
}

function capabilities() {
  return {
    // Linux launches programs only: no app catalog or desktop-entry layer.
    launchKinds: ['process'],
    inputKinds: ['click', 'drag', 'scroll', 'key', 'text'],
    keys: [...CAPABILITY_KEYS],
    nativePreview: false,
  };
}

function summary(text) {
  const tail = String(text ?? '').trim().slice(-400).replace(/\s+/g, ' ');
  return tail ? ': ' + tail : '';
}

function isExecutableFile(candidate) {
  try {
    accessSync(candidate, FS_CONSTANTS.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findExecutable(name, env = process.env) {
  if (name.includes('/')) {
    const resolved = path.resolve(name);
    return isExecutableFile(resolved) ? resolved : null;
  }
  for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function isExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(400, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(messageError('CANCELLED', 'shower operation was cancelled'));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function readLogTail(logPath) {
  if (!logPath) return '';
  try {
    if (statSync(logPath).size > 512 * 1024) return '';
    return readFileSync(logPath, 'utf8').trim().slice(-LOG_TAIL_LIMIT).replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

function logSuffix(logPath) {
  const tail = readLogTail(logPath);
  return tail ? ': ' + tail : '';
}

/** Run one program without a shell; the caller abort signal kills it immediately. */
function runCommand(command, args, options = {}) {
  const { env, signal, timeoutMs = COMMAND_TIMEOUT_MS, stdin = null, maxStdoutBytes = 8 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(messageError('CANCELLED', 'shower operation was cancelled'));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        env,
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(messageError('SHOWER_BACKEND_FAILED', `${path.basename(command)} could not start: ${error.message}`));
      return;
    }
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      kill();
      settle(messageError('SHOWER_BACKEND_FAILED', `${path.basename(command)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    function kill() {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    function settle(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    }
    function onAbort() {
      kill();
      settle(messageError('CANCELLED', 'shower operation was cancelled'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      settle(messageError('SHOWER_BACKEND_FAILED', `${path.basename(command)} failed: ${error.message}`));
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        kill();
        settle(messageError('SHOWER_FRAME_TOO_LARGE', `${path.basename(command)} output exceeded the frame budget`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < LOG_TAIL_LIMIT) stderr += String(chunk);
    });
    child.on('close', (code) => settle(null, { code, stdout: Buffer.concat(stdout), stderr }));
    if (stdin !== null && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
  });
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function waitForExit(child, timeoutMs) {
  if (isExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    function onExit() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('exit', onExit);
  });
}

/** Stop only a child this backend spawned (own process group), SIGTERM then SIGKILL. */
async function stopChild(child, timeoutMs = STOP_TIMEOUT_MS) {
  if (!child || isExited(child)) return;
  signalGroup(child, 'SIGTERM');
  if (await waitForExit(child, timeoutMs)) return;
  signalGroup(child, 'SIGKILL');
  await waitForExit(child, 1000);
}

/**
 * Environment of the private display. WAYLAND_DISPLAY is dropped so launched
 * applications cannot fall back to the physical Wayland session, and the private
 * D-Bus address replaces the physical session bus once it is known.
 */
function sessionEnv(state) {
  const env = {
    ...process.env,
    DISPLAY: `:${state.display}`,
    XAUTHORITY: state.authFile,
    XDG_RUNTIME_DIR: state.runtimeDir,
    XDG_SESSION_TYPE: 'x11',
    XDG_SESSION_DESKTOP: 'shower',
    DESKTOP_SESSION: 'shower',
  };
  delete env.WAYLAND_DISPLAY;
  delete env.XDG_ACTIVATION_TOKEN;
  delete env.SESSION_MANAGER;
  // Never inherit the physical session bus; only our private dbus-daemon bus.
  delete env.DBUS_SESSION_BUS_ADDRESS;
  if (state.dbusAddress) env.DBUS_SESSION_BUS_ADDRESS = state.dbusAddress;
  return env;
}

function desktopEnv(state) {
  return { ...sessionEnv(state), XDG_CONFIG_HOME: state.configDir, XDG_CURRENT_DESKTOP: 'XFCE' };
}

function keysymFor(key) {
  if (Object.hasOwn(KEYSYM_BY_KEY, key)) return KEYSYM_BY_KEY[key];
  if (/^[A-Z]$/.test(key)) return key.toLowerCase();
  if (/^[0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-2])$/.test(key)) return key;
  // BACK/ANDROID_HOME and anything else: SHOWER_UNSUPPORTED, never approximated.
  return null;
}

function coordinate(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DIMENSION) {
    throw messageError('INVALID_ARGUMENT', `${name} must be an integer source pixel between 0 and ${MAX_DIMENSION}`);
  }
  return value;
}

function integerInRange(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw messageError('INVALID_ARGUMENT', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function notches(value, name) {
  return integerInRange(value, -MAX_WHEEL_NOTCHES, MAX_WHEEL_NOTCHES, name);
}

function modifierSymbols(modifiers) {
  if (modifiers === undefined) return [];
  if (!Array.isArray(modifiers)) throw messageError('INVALID_ARGUMENT', 'key modifiers must be an array');
  return modifiers.map((modifier) => {
    const symbol = MODIFIER_SYMBOL[modifier];
    if (!symbol) throw messageError('INVALID_ARGUMENT', 'key modifiers must be CTRL, ALT, SHIFT or META');
    return symbol;
  });
}

/** Validate/normalize one tagged input for Linux; unsupported kinds never approximate. */
function inputAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw messageError('INVALID_ARGUMENT', 'input must be an object');
  }
  switch (input.type) {
    case 'click': {
      const button = input.button === undefined ? 'left' : input.button;
      if (!Object.hasOwn(POINTER_BUTTON, button)) {
        throw messageError('INVALID_ARGUMENT', "click button must be 'left', 'right' or 'middle'");
      }
      return {
        type: 'click',
        x: coordinate(input.x, 'x'),
        y: coordinate(input.y, 'y'),
        button,
        count: input.count === 2 ? 2 : 1,
      };
    }
    case 'drag':
      return {
        type: 'drag',
        x1: coordinate(input.x1, 'x1'),
        y1: coordinate(input.y1, 'y1'),
        x2: coordinate(input.x2, 'x2'),
        y2: coordinate(input.y2, 'y2'),
        durationMs:
          input.durationMs === undefined
            ? 300
            : integerInRange(input.durationMs, MIN_DRAG_MS, MAX_DRAG_MS, 'durationMs'),
      };
    case 'scroll': {
      const deltaX = notches(input.deltaX === undefined ? 0 : input.deltaX, 'deltaX');
      const deltaY = notches(input.deltaY, 'deltaY');
      if (deltaX === 0 && deltaY === 0) throw messageError('INVALID_ARGUMENT', 'scroll needs at least one nonzero delta');
      return {
        type: 'scroll',
        x: coordinate(input.x, 'x'),
        y: coordinate(input.y, 'y'),
        deltaX,
        deltaY,
      };
    }
    case 'key': {
      if (typeof input.key !== 'string') throw messageError('INVALID_ARGUMENT', 'key must be a string');
      const keysym = keysymFor(input.key.toUpperCase());
      if (!keysym) throw messageError('SHOWER_UNSUPPORTED', 'unsupported key on Linux: ' + input.key);
      return { type: 'key', keysym, modifiers: modifierSymbols(input.modifiers) };
    }
    case 'text': {
      if (typeof input.text !== 'string' || input.text.length === 0) {
        throw messageError('INVALID_ARGUMENT', 'text must be a non-empty string');
      }
      if (input.text.length > MAX_TEXT_LENGTH) {
        throw messageError('INVALID_ARGUMENT', `text must be at most ${MAX_TEXT_LENGTH} characters`);
      }
      return { type: 'text', text: input.text };
    }
    default:
      throw messageError('SHOWER_UNSUPPORTED', 'unsupported shower input type: ' + String(input.type));
  }
}

export function createLinuxShowerBackend({ dataRoot } = {}) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw messageError('INVALID_ARGUMENT', 'createLinuxShowerBackend: dataRoot must be a non-empty absolute path');
  }
  const root = path.join(path.resolve(dataRoot), 'shower-linux');
  const sessions = new Map();
  const reservedDisplays = new Set();
  let closed = false;

  function sessionView(state) {
    const view = {
      sessionId: state ? state.sessionId : null,
      platform: 'linux',
      phase: state ? state.phase : 'idle',
      width: state ? state.width : DEFAULT_WIDTH,
      height: state ? state.height : DEFAULT_HEIGHT,
      capabilities: capabilities(),
      updatedAt: new Date().toISOString(),
    };
    if (state?.error) view.error = { code: state.error.code, message: state.error.message };
    return view;
  }

  /** Reflect dead session components without starting any work. */
  function observe(state) {
    if (state.phase === 'closed' || state.phase === 'error') return state;
    for (const [key, label] of [['xvnc', 'private Xvnc server'], ['bus', 'private dbus-daemon'],
      ['wm', 'window manager'], ['desktop', 'xfdesktop'], ['panel', 'xfce4-panel']]) {
      if (state[key] && (state[key].showerError || isExited(state[key]))) {
        state.phase = 'error';
        state.error = {
          code: 'SHOWER_BACKEND_FAILED',
          message: `the ${label} exited` + summary(state[key].showerError?.message) + logSuffix(state[`${key}Log`]),
        };
        state.updatedAt = new Date().toISOString();
        break;
      }
    }
    return state;
  }

  function requireRecordSessionId(record) {
    if (typeof record?.sessionId !== 'string' || record.sessionId.trim() === '') {
      throw messageError('INVALID_ARGUMENT', 'shower record must carry the manager-allocated sessionId');
    }
    return record.sessionId;
  }

  function requireSession(record) {
    const sessionId = requireRecordSessionId(record);
    const state = sessions.get(sessionId);
    if (!state || state.phase === 'closed') {
      throw messageError('SHOWER_SESSION_NOT_FOUND', 'no shower environment for this session on this host: ' + sessionId);
    }
    return state;
  }

  function requireReady(state) {
    observe(state);
    if (state.phase === 'error') throw messageError(state.error.code, state.error.message);
    if (state.phase !== 'ready') {
      throw messageError('SHOWER_NOT_READY', 'the shower environment is ' + state.phase);
    }
    return state;
  }

  function resolveDependencies() {
    const programs = {};
    const missing = [];
    for (const requirement of REQUIREMENTS) {
      let found = null;
      for (const name of requirement.candidates) {
        found = findExecutable(name);
        if (found) break;
      }
      if (found) programs[requirement.key] = found;
      else missing.push(requirement.label);
    }
    if (missing.length > 0) {
      // Explicit dependency error: these programs must already be installed.
      throw messageError(
        'SHOWER_UNAVAILABLE',
        'missing Linux system programs (install them manually; shower installs nothing): ' + missing.join(', '),
      );
    }
    return programs;
  }

  async function reserveDisplay() {
    for (let display = DISPLAY_FIRST; display <= DISPLAY_LAST; display += 1) {
      if (reservedDisplays.has(display)) continue;
      // An existing lock or socket belongs to another X server: never adopt/reuse it.
      if (existsSync(`/tmp/.X${display}-lock`)) continue;
      if (existsSync(path.join(X11_SOCKET_DIR, `X${display}`))) continue;
      if (await isPortOpen(RFB_PORT_BASE + display)) continue;
      reservedDisplays.add(display);
      return display;
    }
    throw messageError(
      'SHOWER_UNAVAILABLE',
      `no free X display in ${DISPLAY_FIRST}..${DISPLAY_LAST} for a private Xvnc`,
    );
  }

  async function probeDisplay(state, signal) {
    try {
      const probe = await runCommand(state.programs.xdotool, ['getdisplaygeometry'], {
        env: sessionEnv(state),
        signal,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return probe.code === 0;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  async function waitForDisplay(state, { signal }) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      checkAborted(signal);
      observe(state);
      if (state.error) throw messageError(state.error.code, state.error.message);
      if (existsSync(path.join(X11_SOCKET_DIR, `X${state.display}`)) && (await probeDisplay(state, signal))) return;
      if (Date.now() >= deadline) {
        throw messageError('SHOWER_NOT_READY', `the private X display :${state.display} did not become ready`);
      }
      await delay(100, signal);
    }
  }

  function startXServer(state) {
    // No shell: the display number and geometry are already validated integers.
    const args = [
      `:${state.display}`,
      '-geometry',
      `${state.width}x${state.height}`,
      '-depth',
      '24',
      '-rfbport',
      String(RFB_PORT_BASE + state.display),
      // RFB is reachable on 127.0.0.1 only; control uses xdotool/ffmpeg, never RFB,
      // so an unauthenticated remote port is never opened.
      '-localhost',
      // X clients connect over the private unix socket only.
      '-nolisten',
      'tcp',
      // Keep WM/apps alive across client connects/disconnects (no server reset).
      '-noreset',
      '-auth',
      state.authFile,
    ];
    state.xvncLog = path.join(state.dir, 'xvnc.log');
    const logFd = openSync(state.xvncLog, 'a', 0o600);
    try {
      state.xvnc = spawn(state.programs.server, args, {
        env: sessionEnv(state),
        detached: true,
        stdio: ['ignore', 'ignore', logFd],
      });
    } finally {
      closeSync(logFd);
    }
    state.xvnc.on('error', (error) => { state.xvnc.showerError = error; });
    state.xvnc.unref();
  }

  function startBus(state) {
    // Own private session bus, replacing the physical one for this environment. The
    // address is read from stdout so WM/apps can join it explicitly.
    state.busLog = path.join(state.dir, 'dbus.log');
    const logFd = openSync(state.busLog, 'a', 0o600);
    try {
      state.bus = spawn(state.programs.dbus, ['--session', '--nofork', '--print-address=1', '--nopidfile'], {
        env: desktopEnv(state),
        detached: true,
        stdio: ['ignore', 'pipe', logFd],
      });
    } finally {
      closeSync(logFd);
    }
    state.bus.on('error', (error) => { state.bus.showerError = error; });
    let busOutput = '';
    state.bus.stdout.on('data', (chunk) => {
      if (state.dbusAddress) return;
      busOutput = (busOutput + String(chunk)).slice(0, 4096);
      // Wait for the complete line so a split write cannot yield a truncated address.
      if (!busOutput.includes('\n') && busOutput.length < 400) return;
      const match = /(unix|tcp|nonce-tcp|unixexec|launchd|autolaunch):[^\s]+/.exec(busOutput.split('\n')[0]);
      if (match) state.dbusAddress = match[0];
    });
    // Never let the address pipe keep the host process alive.
    state.bus.stdout.unref?.();
    state.bus.unref();
  }

  async function waitForBusAddress(state, { signal }) {
    const deadline = Date.now() + DBUS_ADDRESS_TIMEOUT_MS;
    while (!state.dbusAddress) {
      checkAborted(signal);
      observe(state);
      if (state.error) throw messageError(state.error.code, state.error.message);
      if (Date.now() >= deadline) {
        throw messageError('SHOWER_BACKEND_FAILED', 'the private dbus-daemon printed no bus address' + logSuffix(state.busLog));
      }
      await delay(50, signal);
    }
  }

  function startDesktopComponent(state, key) {
    state[`${key}Log`] = path.join(state.dir, `${key}.log`);
    const logFd = openSync(state[`${key}Log`], 'a', 0o600);
    try {
      state[key] = spawn(state.programs[key], [], {
        env: desktopEnv(state),
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
    } finally {
      closeSync(logFd);
    }
    state[key].on('error', (error) => { state[key].showerError = error; });
    state[key].unref();
  }

  async function waitForWindowManager(state, { signal }) {
    await delay(WM_START_GRACE_MS, signal);
    observe(state);
    if (state.error) throw messageError(state.error.code, state.error.message);
  }

  async function waitForDesktop(state, { signal }) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      checkAborted(signal);
      observe(state);
      if (state.error) throw messageError(state.error.code, state.error.message);
      let visible = true;
      for (const name of ['xfdesktop', 'xfce4-panel']) {
        const probe = await runCommand(state.programs.xdotool, ['search', '--onlyvisible', '--class', name], {
          env: sessionEnv(state), signal, timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (probe.code !== 0) visible = false;
      }
      observe(state);
      if (state.error) throw messageError(state.error.code, state.error.message);
      if (visible) return;
      if (Date.now() >= deadline) {
        throw messageError('SHOWER_NOT_READY', 'xfdesktop and xfce4-panel windows did not become ready' +
          logSuffix(state.desktopLog) + logSuffix(state.panelLog));
      }
      await delay(100, signal);
    }
  }

  async function startEnvironment(state, { signal }) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    state.dir = path.join(root, `session-${randomUUID()}`);
    mkdirSync(state.dir, { mode: 0o700 });
    state.runtimeDir = path.join(state.dir, 'runtime');
    mkdirSync(state.runtimeDir, { mode: 0o700 });
    state.configDir = path.join(state.dir, 'config');
    const xfconfDir = path.join(state.configDir, 'xfce4', 'xfconf', 'xfce-perchannel-xml');
    mkdirSync(xfconfDir, { recursive: true, mode: 0o700 });
    // Seed a usable panel rather than the first-run configuration dialog.
    writeFileSync(path.join(xfconfDir, 'xfce4-panel.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=6;x=0;y=0"/>
      <property name="length" type="uint" value="100"/>
      <property name="size" type="uint" value="32"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu"/>
    <property name="plugin-2" type="string" value="tasklist"/>
  </property>
</channel>
`, { mode: 0o600 });
    // shortcut: the solid background targets Xvnc's VNC-0 monitor, update if other monitor names are supported.
    writeFileSync(path.join(xfconfDir, 'xfce4-desktop.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorVNC-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="image-style" type="int" value="0"/>
          <property name="color-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0.12"/>
            <value type="double" value="0.16"/>
            <value type="double" value="0.20"/>
            <value type="double" value="1.0"/>
          </property>
        </property>
      </property>
    </property>
  </property>
</channel>
`, { mode: 0o600 });
    writeFileSync(path.join(state.configDir, 'xfce4', 'helpers.rc'), '[Helpers]\nTerminalEmulator=xfce4-terminal\n', { mode: 0o600 });
    state.authFile = path.join(state.dir, 'Xauthority');
    state.display = await reserveDisplay();
    checkAborted(signal);

    const cookie = randomBytes(16).toString('hex');
    const auth = await runCommand(state.programs.xauth, ['-f', state.authFile, 'add', `:${state.display}`, '.', cookie], {
      env: { PATH: String(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'), HOME: state.runtimeDir, XDG_RUNTIME_DIR: state.runtimeDir },
      signal,
    });
    if (auth.code !== 0) {
      throw messageError('SHOWER_BACKEND_FAILED', 'xauth could not write the session Xauthority file' + summary(auth.stderr));
    }

    startXServer(state);
    await waitForDisplay(state, { signal });
    startBus(state);
    await waitForBusAddress(state, { signal });
    startDesktopComponent(state, 'wm');
    await waitForWindowManager(state, { signal });
    startDesktopComponent(state, 'desktop');
    startDesktopComponent(state, 'panel');
    await waitForDesktop(state, { signal });
    state.phase = 'ready';
    state.updatedAt = new Date().toISOString();
  }

  async function teardown(state) {
    state.phase = 'closed';
    state.updatedAt = new Date().toISOString();
    if (state.released) return;
    state.released = true;
    // The driver goes first so it cannot inject input while the display dies.
    await stopCuaDriver(state);
    // Only children this backend spawned: their own process groups, nothing else.
    for (const app of [...state.apps]) await stopChild(app);
    state.apps.clear();
    await stopChild(state.panel);
    await stopChild(state.desktop);
    await stopChild(state.wm);
    await stopChild(state.bus);
    await stopChild(state.xvnc);
    if (state.display !== null) reservedDisplays.delete(state.display);
    if (state.dir) {
      try {
        rmSync(state.dir, { recursive: true, force: true });
      } catch {
        // best-effort removal of our own private dir
      }
    }
    state.dir = null;
    state.authFile = null;
    state.runtimeDir = null;
    state.configDir = null;
  }

  function createState({ sessionId, width, height, programs }) {
    return {
      sessionId,
      width,
      height,
      programs,
      phase: 'starting',
      dir: null,
      runtimeDir: null,
      configDir: null,
      authFile: null,
      display: null,
      xvnc: null,
      wm: null,
      desktop: null,
      panel: null,
      bus: null,
      xvncLog: null,
      wmLog: null,
      desktopLog: null,
      panelLog: null,
      busLog: null,
      dbusAddress: null,
      apps: new Set(),
      // Persistent per-session cua driver handle: { client, dead, starting } or null.
      // Lazily created on the first backend.cua call; recycled on cancel/timeout/death.
      cua: null,
      startedAt: Date.now(),
      updatedAt: new Date().toISOString(),
      error: null,
      released: false,
    };
  }

  async function xdotool(state, args, signal, stdin = null) {
    const result = await runCommand(state.programs.xdotool, args, {
      env: sessionEnv(state),
      signal,
      stdin,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw messageError('SHOWER_INPUT_FAILED', `xdotool ${args[0]} failed` + summary(result.stderr));
    }
    return result;
  }

  async function releaseDragButton(state) {
    // Always release the physical button even when the caller aborted mid-drag.
    try {
      await runCommand(state.programs.xdotool, ['mouseup', '1'], {
        env: sessionEnv(state),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    } catch {
      // best effort
    }
  }

  async function injectInput(state, action, signal) {
    // Every xdotool call carries this session's DISPLAY/XAUTHORITY, so input never
    // reaches (or steals focus from) the physical desktop.
    switch (action.type) {
      case 'click':
        await xdotool(
          state,
          [
            'mousemove',
            String(action.x),
            String(action.y),
            'click',
            '--repeat',
            String(action.count),
            '--delay',
            '120',
            POINTER_BUTTON[action.button],
          ],
          signal,
        );
        return;
      case 'drag':
        await xdotool(state, ['mousemove', String(action.x1), String(action.y1)], signal);
        await xdotool(state, ['mousedown', '1'], signal);
        try {
          const steps = Math.max(2, Math.min(20, Math.round(action.durationMs / 50)));
          for (let step = 1; step <= steps; step += 1) {
            await delay(Math.max(1, Math.round(action.durationMs / steps)), signal);
            checkAborted(signal);
            const x = Math.round(action.x1 + ((action.x2 - action.x1) * step) / steps);
            const y = Math.round(action.y1 + ((action.y2 - action.y1) * step) / steps);
            await xdotool(state, ['mousemove', String(x), String(y)], signal);
          }
        } finally {
          await releaseDragButton(state);
        }
        return;
      case 'scroll':
        await xdotool(state, ['mousemove', String(action.x), String(action.y)], signal);
        if (action.deltaY !== 0) {
          await xdotool(
            state,
            [
              'click',
              '--repeat',
              String(Math.abs(action.deltaY)),
              '--delay',
              '40',
              action.deltaY > 0 ? WHEEL_DOWN_BUTTON : WHEEL_UP_BUTTON,
            ],
            signal,
          );
        }
        if (action.deltaX !== 0) {
          await xdotool(
            state,
            [
              'click',
              '--repeat',
              String(Math.abs(action.deltaX)),
              '--delay',
              '40',
              action.deltaX > 0 ? WHEEL_RIGHT_BUTTON : WHEEL_LEFT_BUTTON,
            ],
            signal,
          );
        }
        return;
      case 'key':
        await xdotool(
          state,
          ['key', '--clearmodifiers', [...action.modifiers, action.keysym].join('+')],
          signal,
        );
        return;
      case 'text':
        // stdin avoids any option parsing of the text itself.
        await xdotool(state, ['type', '--clearmodifiers', '--delay', '12', '--file', '-'], signal, action.text);
        return;
      default:
        throw messageError('SHOWER_UNSUPPORTED', 'unsupported shower input type: ' + String(action.type));
    }
  }

  async function captureJpeg(state, imageWidth, imageHeight, quality, maxRawBytes, signal) {
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'x11grab',
      '-draw_mouse',
      '1',
      '-video_size',
      `${state.width}x${state.height}`,
      // Private display only: the physical display is never grabbed.
      '-i',
      `:${state.display}.0`,
    ];
    if (imageWidth !== state.width || imageHeight !== state.height) args.push('-vf', `scale=${imageWidth}:${imageHeight}`);
    args.push('-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', String(quality), 'pipe:1');
    const result = await runCommand(state.programs.ffmpeg, args, {
      env: sessionEnv(state),
      signal,
      timeoutMs: COMMAND_TIMEOUT_MS,
      // A too-large JPEG is returned so the caller can shrink/recompress it; the
      // cap only stops a runaway capture.
      maxStdoutBytes: Math.max(maxRawBytes * 2, 256 * 1024),
    });
    if (result.code !== 0 || result.stdout.length === 0) {
      throw messageError('SHOWER_BACKEND_FAILED', 'ffmpeg x11grab capture failed' + summary(result.stderr));
    }
    return result.stdout;
  }

  function frameLimit(value, fallback, label) {
    if (value === undefined) return fallback;
    return integerInRange(value, MIN_DIMENSION, MAX_DIMENSION, label);
  }

  function frameLimitBytes(value) {
    if (value === undefined) return SHOWER_MAX_FRAME_BASE64_BYTES;
    return integerInRange(value, 1, SHOWER_MAX_FRAME_BASE64_BYTES, 'maxBytes');
  }

  function resolveProgram(state, program, cwd) {
    if (program.includes('/')) {
      const candidate = path.isAbsolute(program) ? program : path.resolve(cwd ?? process.cwd(), program);
      if (!isExecutableFile(candidate)) {
        throw messageError('SHOWER_UNAVAILABLE', 'program is not executable inside the shower environment: ' + program);
      }
      return candidate;
    }
    const found = findExecutable(program, sessionEnv(state));
    if (!found) {
      throw messageError('SHOWER_UNAVAILABLE', 'program is not installed or not on PATH inside the shower environment: ' + program);
    }
    return found;
  }

  function launchCwd(launch) {
    if (launch.cwd === undefined) return undefined;
    const candidate = path.resolve(launch.cwd);
    let stats;
    try {
      stats = statSync(candidate);
    } catch {
      throw messageError('INVALID_ARGUMENT', 'launch cwd does not exist: ' + launch.cwd);
    }
    if (!stats.isDirectory()) throw messageError('INVALID_ARGUMENT', 'launch cwd is not a directory: ' + launch.cwd);
    return candidate;
  }

  function spawnInSession(state, program, args, cwd) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(program, args, {
          cwd,
          env: sessionEnv(state),
          detached: true,
          stdio: 'ignore',
        });
      } catch (error) {
        reject(messageError('SHOWER_BACKEND_FAILED', `could not launch ${program}: ${error.message}`));
        return;
      }
      child.once('error', (error) => {
        reject(messageError('SHOWER_BACKEND_FAILED', `could not launch ${program}: ${error.message}`));
      });
      child.once('spawn', () => {
        child.unref();
        resolve(child);
      });
    });
  }

  /**
   * Drop the session's cua driver. Idempotent; marks the handle dead first so a
   * close-triggered 'exit' cannot be mistaken for a usable client. The driver runs
   * on this session's private display only, so anything it was typing dies with it.
   * A close() failure means the process may still be injecting input: mark the
   * session broken so nothing else can drive it until teardown.
   */
  async function stopCuaDriver(state) {
    const cua = state.cua;
    state.cua = null;
    if (!cua) return;
    cua.dead = true;
    const client = cua.starting ? await cua.starting.catch(() => null) : cua.client;
    if (client) await client.close();
  }

  /**
   * Lazily start the per-session driver on the private display. Requires a ready
   * session with its private D-Bus address known; the env comes from sessionEnv
   * (WAYLAND_DISPLAY and the host session bus already removed) plus DO_NOT_TRACK.
   * The driver connects only via stdin/stdout JSONL, never a shared daemon.
   */
  async function ensureCuaDriver(state, signal) {
    const cua = state.cua;
    // Live, connected client: reuse it.
    if (cua && !cua.dead && cua.client && !cua.client.closed) return cua.client;
    // A start still in flight shares its driver; a dead one is retired below.
    if (cua?.starting && !cua.dead) {
      try {
        return await cua.starting;
      } catch {
        // fell through: the start died, recycle below
      }
    }
    // Retire a dead or closed instance before creating a fresh entry.
    if (cua && (cua.dead || (cua.client && cua.client.closed))) {
      await stopCuaDriver(state);
    }
    if (!state.dbusAddress) {
      throw messageError('SHOWER_NOT_READY', 'the private D-Bus session bus is not ready for the cua driver');
    }
    // Aborted before a driver is spawned or written to: nothing was sent.
    checkAborted(signal);
    const entry = { client: null, dead: false, starting: null };
    entry.starting = (async () => {
      try {
        const driverPath = resolveCuaDriverPath();
        const client = new CuaMcpClient({
          command: driverPath,
          args: ['mcp', '--direct'],
          env: { ...sessionEnv(state), DO_NOT_TRACK: '1' },
        });
        client.onClose = () => { entry.dead = true; };
        await client.connect({ signal });
        entry.client = client;
        return client;
      } finally {
        // starting must clear on success AND failure: a stale promise would pin
        // a dead client and block every future restart for this session.
        entry.starting = null;
      }
    })();
    state.cua = entry;
    const starting = entry.starting;
    try {
      return await starting;
    } catch (error) {
      // A failed start never leaves a half-open client behind.
      if (state.cua === entry) await stopCuaDriver(state);
      throw error;
    }
  }

  /**
   * Best-effort release of anything the driver may have held down on the private
   * display before it was killed. Uses the session's own xdotool/DISPLAY; failure
   * here must not block recycling (the whole Xvnc dies on release anyway).
   */
  async function releaseCuaInput(state) {
    // One xdotool chain for all keys+buttons: no per-command process delay, and a
    // failure on one step does not abort the rest of the release sequence.
    // xdotool commands have fixed arity, so they chain without separators.
    const chain = [
      ...CUA_RELEASE_KEYSYMS.flatMap((k) => ['keyup', k]),
      ...CUA_RELEASE_BUTTONS.flatMap((b) => ['mouseup', b]),
    ];
    try {
      await runCommand(
        state.programs.xdotool,
        chain,
        { env: sessionEnv(state), timeoutMs: COMMAND_TIMEOUT_MS },
      );
    } catch {
      // best effort only
    }
    // Fallback: release each button individually so one bad step can't skip them.
    for (const button of CUA_RELEASE_BUTTONS) {
      try {
        await runCommand(
          state.programs.xdotool,
          ['mouseup', button],
          { env: sessionEnv(state), timeoutMs: PROBE_TIMEOUT_MS },
        );
      } catch {
        // keep releasing the rest
      }
    }
  }

  /**
   * backend.cua(record, request, options): forward one canonical {method,params}
   * MCP request to this session's persistent driver and return the raw result.
   * The shape is re-validated here because this is the process boundary.
   * Cancel/timeout: the in-flight request is never replayed and never answered
   * after the fact — the driver is killed (whole process group), held keys are
   * released on the same private display, and a fresh driver starts next call.
   */
  async function cua(record, request, options = {}) {
    const { signal } = options;
    checkAborted(signal);
    const state = requireReady(requireSession(record));
    const clean = validateCuaRequest(request);
    checkAborted(signal);
    const entry = state.cua;
    const client = await ensureCuaDriver(state, signal);
    try {
      return await client.call(clean, { signal });
    } catch (error) {
      // Cancel/timeout/death/corrupt stream: kill the driver BEFORE releasing
      // keys (releasing first would re-press on a live driver), then release on
      // the same private display, and only then fail the request. Cleanup is
      // awaited so the manager queue cannot advance while input is still live.
      const needsRecycle =
        error?.code === 'CANCELLED' ||
        error?.code === 'SHOWER_TIMEOUT' ||
        error?.driverExited ||
        error?.protocolFatal;
      if (needsRecycle) {
        // Only drop a driver that is still THIS call's instance; a concurrent
        // teardown or a failed start may already have replaced state.cua.
        if (state.cua?.client === client || (entry && state.cua === entry)) {
          await stopCuaDriver(state).catch((closeError) => {
            // Unconfirmed process kill: the driver may still be injecting on
            // this display, so the session must refuse further input until it
            // is torn down entirely. The caller also sees it on this request.
            state.phase = 'error';
            state.error = {
              code: 'SHOWER_BACKEND_FAILED',
              message: 'cua driver cleanup failed; the session can no longer be used safely: ' + closeError.message,
            };
            state.updatedAt = new Date().toISOString();
            error.cuaCleanup = closeError.message;
          });
        }
        await releaseCuaInput(state);
      }
      throw error;
    }
  }

  async function status(record, { signal } = {}) {
    checkAborted(signal);
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : null;
    const state = sessionId ? sessions.get(sessionId) : undefined;
    if (state) return sessionView(observe(state));
    // No environment for this id: report idle (or unavailable without the required
    // system programs). Status never creates, starts or touches anything.
    try {
      resolveDependencies();
    } catch (error) {
      const view = sessionView(null);
      view.phase = 'unavailable';
      view.error = { code: 'SHOWER_UNAVAILABLE', message: error.message };
      return view;
    }
    return sessionView(null);
  }

  async function ensure(record, createOptions = {}, { signal } = {}) {
    checkAborted(signal);
    const sessionId = requireRecordSessionId(record);
    if (closed) throw messageError('SHOWER_UNAVAILABLE', 'the shower backend is closed');
    const existing = sessions.get(sessionId);
    if (existing) {
      observe(existing);
      if (existing.phase === 'starting' || existing.phase === 'ready') return sessionView(existing);
      // Ended/failed environment: recreate under the SAME manager-allocated id.
      await teardown(existing);
    }
    const options = createOptions && typeof createOptions === 'object' ? createOptions : {};
    const width = options.width === undefined ? DEFAULT_WIDTH : integerInRange(options.width, MIN_DIMENSION, MAX_DIMENSION, 'width');
    const height = options.height === undefined ? DEFAULT_HEIGHT : integerInRange(options.height, MIN_DIMENSION, MAX_DIMENSION, 'height');
    const programs = resolveDependencies();
    const state = createState({ sessionId, width, height, programs });
    sessions.set(sessionId, state);
    try {
      await startEnvironment(state, { signal });
    } catch (error) {
      await teardown(state);
      throw error;
    }
    return sessionView(state);
  }

  async function frame(record, limits = {}, { signal } = {}) {
    checkAborted(signal);
    const state = requireReady(requireSession(record));
    const requested = limits && typeof limits === 'object' ? limits : {};
    const maxWidth = frameLimit(requested.maxWidth, DEFAULT_WIDTH, 'maxWidth');
    const maxHeight = frameLimit(requested.maxHeight, DEFAULT_HEIGHT, 'maxHeight');
    const maxBytes = frameLimitBytes(requested.maxBytes);
    const scale = Math.min(1, maxWidth / state.width, maxHeight / state.height);
    let imageWidth = Math.max(1, Math.min(state.width, Math.round(state.width * scale)));
    let imageHeight = Math.max(1, Math.min(state.height, Math.round(state.height * scale)));
    // Base64 of n bytes is ceil(n/3)*4, so raw JPEG must stay below maxBytes*3/4.
    const maxRawBytes = Math.floor((maxBytes * 3) / 4);
    let quality = 5;
    let jpeg = null;
    for (let attempt = 0; ; attempt += 1) {
      jpeg = await captureJpeg(state, imageWidth, imageHeight, quality, maxRawBytes, signal);
      if (jpeg.length <= maxRawBytes) break;
      if (attempt >= 3) {
        throw messageError(
          'SHOWER_FRAME_TOO_LARGE',
          `a ${imageWidth}x${imageHeight} JPEG cannot fit ${maxBytes} base64 bytes`,
        );
      }
      quality = Math.min(10, quality + 2);
      imageWidth = Math.max(1, Math.floor(imageWidth * 0.75));
      imageHeight = Math.max(1, Math.floor(imageHeight * 0.75));
    }
    return {
      sessionId: state.sessionId,
      frameId: randomUUID(),
      capturedAt: new Date().toISOString(),
      width: state.width,
      height: state.height,
      imageWidth,
      imageHeight,
      mimeType: 'image/jpeg',
      data: jpeg.toString('base64'),
    };
  }

  async function input(record, value, { signal, source, callId } = {}) {
    checkAborted(signal);
    // Ownership first: a wrong/released sessionId is refused before input is judged.
    const state = requireReady(requireSession(record));
    const action = inputAction(value);
    checkAborted(signal);
    await injectInput(state, action, signal);
    // Small JSON only; partial input is reported as cancelled/unconfirmed upstream.
    return { sessionId: state.sessionId, type: action.type, source: source ?? 'agent', callId: callId ?? null };
  }

  async function launch(record, value, { signal, source, callId } = {}) {
    checkAborted(signal);
    const state = requireReady(requireSession(record));
    if (value?.kind !== 'process') {
      // Linux launches programs only: there is no app catalog/desktop-entry layer.
      throw messageError('SHOWER_UNSUPPORTED', "Linux shower supports only kind 'process' launch: " + String(value?.kind));
    }
    if (typeof value.program !== 'string' || value.program.trim() === '') {
      throw messageError('INVALID_ARGUMENT', 'process launch needs a program');
    }
    if (value.args !== undefined && !Array.isArray(value.args)) {
      throw messageError('INVALID_ARGUMENT', 'process args must be an array');
    }
    const cwd = launchCwd(value);
    const program = resolveProgram(state, value.program, cwd);
    // argv is passed through as given; a bad argument must fail loudly, not be coerced.
    const args = value.args ?? [];
    checkAborted(signal);
    const child = await spawnInSession(state, program, args, cwd);
    state.apps.add(child);
    child.once('exit', () => state.apps.delete(child));
    return {
      sessionId: state.sessionId,
      kind: 'process',
      pid: child.pid ?? null,
      target: program,
      source: source ?? 'agent',
      callId: callId ?? null,
    };
  }

  async function release(record, { signal } = {}) {
    // Explicit cleanup ignores the caller abort: a cancelled request must never
    // leave an owned Xvnc (or its WM/apps) running.
    void signal;
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : null;
    const state = sessionId ? sessions.get(sessionId) : undefined;
    if (!state) return { sessionId, released: false, phase: 'idle' };
    await teardown(state);
    return { sessionId, released: true, phase: 'closed' };
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const state of sessions.values()) await teardown(state);
    sessions.clear();
    try {
      // Only this backend's own root below dataRoot; session dirs are already gone.
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  return { platform: 'linux', status, ensure, frame, input, launch, cua, release, close };
}
