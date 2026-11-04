// host-core/cua-mcp.js
// Minimal managed stdio MCP client for the per-session Cua driver (cua-driver-rs
// started as `mcp --direct`). The shared @earendil-works/pi-mcp StdioTransport
// already supports inheritEnv:false with a fully explicit env and process-group
// teardown; this module exists for what it cannot do: the 2 MiB per-line output
// bound, corrupt-stream detection that marks the driver unrecoverable, and the
// not-sent/unconfirmed cancellation accounting e-launcher needs for Cua input.
// Only the three methods e-launcher actually uses are exposed; driver
// notifications are accepted but never treated as results, and cancelled or
// timed-out requests are never replayed on a recycled driver.
import { spawn } from 'node:child_process';
import { messageError } from './message-protocol.js';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = Object.freeze({ name: 'e-launcher', version: '1.0.0' });
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // 2 MiB per response line
const MAX_REQUEST_BYTES = 128 * 1024;      // refuse oversized outbound frames
const MAX_STDERR_BYTES = 64 * 1024;        // rolling tail for error messages
const CALL_TIMEOUT_MS = 30_000;
const INIT_TIMEOUT_MS = 15_000;
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message) {
  return messageError('INVALID_ARGUMENT', message);
}

function mcpError(message) {
  return messageError('SHOWER_BACKEND_FAILED', 'cua driver MCP error: ' + message);
}

/** The driver stream is corrupt; the process must be recycled, never reused. */
function fatalProtocolError(message) {
  const error = mcpError(message);
  error.protocolFatal = true;
  return error;
}

/** Outcome markers mirror the manager contract: never report a cancelled call as confirmed. */
function cancelledError(outcome, detail) {
  const error = messageError('CANCELLED', 'cua driver call was cancelled (' + outcome + ')' + (detail ? ': ' + detail : ''));
  error.outcome = outcome;
  return error;
}

function driverDiedError(tail) {
  const error = mcpError('the driver exited' + (tail ? ': ' + tail : ''));
  error.driverExited = true;
  return error;
}

/** Wait for a child's 'close', treating an already-exited child as settled. */
function waitForClose(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    function onClose() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once('close', onClose);
  });
}

/**
 * Validate the exact request shapes e-launcher forwards. The core already
 * validates too, but this is the process-protocol boundary: anything else (or a
 * request that cannot fit the outbound bound) is refused before touching the pipe.
 */
export function validateCuaRequest(request) {
  if (!isPlainObject(request)) throw invalid('cua request must be a plain object');
  if (request.method === 'tools/list') {
    if (request.params !== undefined && !isPlainObject(request.params)) {
      throw invalid('cua tools/list params must be an object when present');
    }
    return { method: 'tools/list', params: request.params ?? {} };
  }
  if (request.method === 'tools/call') {
    const params = request.params;
    if (!isPlainObject(params) || typeof params.name !== 'string' || params.name === '') {
      throw invalid('cua tools/call params must carry a tool name');
    }
    if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
      throw invalid('cua tools/call params.arguments must be an object when present');
    }
    const clean = { name: params.name };
    if (params.arguments !== undefined) clean.arguments = params.arguments;
    if (params._meta !== undefined) clean._meta = params._meta;
    return { method: 'tools/call', params: clean };
  }
  throw invalid('cua supports only tools/list and tools/call, not ' + String(request.method));
}

function encode(payload) {
  const line = Buffer.from(JSON.stringify(payload) + '\n', 'utf8');
  if (line.length > MAX_REQUEST_BYTES) {
    throw invalid('cua request exceeds the 128 KiB outbound limit');
  }
  return line;
}

/**
 * One stdio JSONL driver session. Spawned with a caller-provided env (already
 * the private-session env plus DO_NOT_TRACK) in its own process group; close()
 * tears the whole group down so the driver can never keep injecting input.
 */
export class CuaMcpClient {
  constructor({ command, args = [], env, stderrLabel = 'cua-driver' }) {
    if (typeof command !== 'string' || command === '') throw invalid('cua driver command is required');
    this.command = command;
    this.args = args;
    this.env = env;
    this.stderrLabel = stderrLabel;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.stderrTail = '';
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer, onAbort}
    this.closed = false;
    this.started = false;
    this.closing = null;  // single close() promise: cleanup is never skipped or doubled
    this.onClose = null;  // set by the backend so a dead driver is always recycled
  }

  /** Spawn + MCP initialize handshake; resolves when notifications/initialized was sent. */
  async connect({ signal } = {}) {
    if (this.started) throw mcpError('connect called twice');
    this.started = true;
    // Aborted before spawn: nothing exists and nothing was sent.
    if (signal?.aborted) {
      throw cancelledError('not-sent', 'aborted before the driver started');
    }
    const child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so close() reaches helpers the driver may spawn.
      detached: true,
    });
    this.child = child;
    child.on('error', (error) => this.failAll(mcpError('spawn failed: ' + error.message)));
    child.on('close', (code, signalCode) => {
      const how = signalCode ? 'signal ' + signalCode : 'code ' + code;
      this.closed = true;
      // Any exit (clean, crash or signal) sweeps the owned group for helpers the
      // leader may have spawned; a backend awaiting close() still sees the error.
      void this.close().catch(() => {});
      this.failAll(driverDiedError('exited with ' + how + this.stderrSuffix()));
      this.onClose?.();
    });
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-MAX_STDERR_BYTES);
    });
    child.stdin.on('error', () => {
      // EPIPE after driver exit; pending requests already fail via 'close'.
    });
    try {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      }, { timeoutMs: INIT_TIMEOUT_MS, signal });
      this.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (error) {
      await this.close();
      throw error;
    }
    return this;
  }

  stderrSuffix() {
    const tail = this.stderrTail.trim().replace(/\s+/g, ' ').slice(-400);
    return tail ? ' (stderr: ' + tail + ')' : '';
  }

  onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > MAX_MESSAGE_BYTES) {
          this.buffer = Buffer.alloc(0);
          this.markBroken(fatalProtocolError('driver response exceeded the 2 MiB message bound'));
        }
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > MAX_MESSAGE_BYTES) {
        this.markBroken(fatalProtocolError('driver response exceeded the 2 MiB message bound'));
        return;
      }
      const text = line.toString('utf8').replace(/\r$/, '');
      if (!text.trim()) continue;
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        this.markBroken(fatalProtocolError('driver sent a malformed JSON-RPC line'));
        return;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (!isPlainObject(message)) {
      this.markBroken(fatalProtocolError('driver sent a non-object JSON-RPC message'));
      return;
    }
    // Responses carry our id. Notifications (no id) and driver-initiated requests
    // (id + method) are ignored: a notification is never a result.
    if (!('id' in message) || message.id === null) return;
    if ('method' in message) {
      // Driver-initiated request: we serve none; answer methodNotFound so it does not hang.
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'e-launcher serves no MCP requests' },
      });
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return; // stale response for a timed-out request; never replayed
    this.pending.delete(message.id);
    entry.settle();
    if ('error' in message) {
      entry.reject(mcpError(String(message.error?.message ?? 'unknown error')));
    } else {
      entry.resolve(message.result);
    }
  }

  failAll(error) {
    if (this.pending.size === 0 && this.closed) return;
    for (const [, entry] of this.pending) {
      entry.settle();
      entry.reject(error);
    }
    this.pending.clear();
  }

  /**
   * The stream violated the protocol even while idle: the process can never be
   * trusted again. onClose fires immediately (not at process close) so the
   * backend marks its entry dead before any concurrent reuse, then the process
   * group is torn down. markBroken is safe to call from any parser path.
   */
  markBroken(error) {
    this.closed = true;
    this.failAll(error);
    this.onClose?.();
    // Background cleanup must not leave an unhandled rejection; the shared
    // 'closing' promise still rejects for any backend awaiting it.
    void this.close().catch(() => {});
  }

  write(payload) {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) throw driverDiedError('stdin is closed' + this.stderrSuffix());
    stdin.write(encode(payload));
  }

  /**
   * One outbound request. A signal abort detaches the waiter only; the driver
   * process is the caller's problem (it is recycled, never reused for a reply).
   */
  request(method, params, { timeoutMs = CALL_TIMEOUT_MS, signal } = {}) {
    if (this.closed) return Promise.reject(driverDiedError('client is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          entry.settle();
          const error = messageError('SHOWER_TIMEOUT', 'cua driver call timed out after ' + timeoutMs + 'ms');
          error.outcome = 'unconfirmed';
          reject(error);
        }, timeoutMs),
        onAbort: null,
        settle() {
          clearTimeout(this.timer);
          if (this.onAbort) signal?.removeEventListener('abort', this.onAbort);
        },
      };
      if (signal) {
        entry.onAbort = () => {
          this.pending.delete(id);
          entry.settle();
          reject(cancelledError('unconfirmed', String(signal.reason ?? 'aborted')));
        };
        if (signal.aborted) {
          entry.onAbort();
          return;
        }
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        entry.settle();
        reject(error);
      }
    });
  }

  /** Outward-facing call: validate shape, send, return the raw MCP result object. */
  async call(request, { signal } = {}) {
    const clean = validateCuaRequest(request);
    // An aborted signal before anything is written is 'not-sent', never unconfirmed.
    if (signal?.aborted) throw cancelledError('not-sent', String(signal.reason ?? 'aborted'));
    return this.request(clean.method, clean.params, { signal });
  }

  /**
   * SIGTERM then SIGKILL on the driver's own process group. One shared 'closing'
   * promise: a second call never skips an in-flight cleanup. Whatever the
   * leader's exit code or timing, the group is always swept for helpers it may
   * have spawned, and resolve happens only after 'close' is observed — a grace
   * expiry rejects instead of silently reporting success.
   */
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      this.failAll(driverDiedError('client is closing'));
      const child = this.child;
      if (!child || child.pid === undefined) return;
      const kill = (sig) => {
        try {
          process.kill(-child.pid, sig);
        } catch {
          try { child.kill(sig); } catch { /* group already gone */ }
        }
      };
      if (child.exitCode === null && child.signalCode === null) {
        kill('SIGTERM');
        await waitForClose(child, TERM_GRACE_MS);
      }
      // Leader exited (naturally or under SIGTERM) or ignored it entirely:
      // helpers in its group may still live, so the group always gets SIGKILL.
      kill('SIGKILL');
      if (await waitForClose(child, KILL_GRACE_MS)) return;
      if (child.exitCode === null && child.signalCode === null) {
        throw mcpError('the driver process was not confirmed stopped after SIGKILL; input cleanup is unconfirmed');
      }
    })();
    return this.closing;
  }
}

export const CUA_MCP_LIMITS = Object.freeze({
  MAX_MESSAGE_BYTES,
  MAX_REQUEST_BYTES,
  CALL_TIMEOUT_MS,
});
