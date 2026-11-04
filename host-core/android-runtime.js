// host-core/android-runtime.js
// M15 Android Host child runtime: bounded private JSONL IPC with the Java
// supervisor, host/settings/client process modes, and the native tool bridge.
// Reuses the M14 control/live/settings adapters (createLocalControlAdapter,
// createControlClient, openHostService/openHostSettings) and, in client mode
// only, the M17 desktop broker (openDesktopClient) as a client-only transport.
// Client mode never opens a Host, never reads model credentials and never
// dispatches native tool calls. Nothing starts on import; runAndroidRuntime()
// (or the strict entrypoint guard) drives the process stdio loop.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { messageError } from './message-protocol.js';
import { createLocalControlAdapter } from './local-control-adapter.js';
import { createControlClient } from './control-client.js';
import { openHostService } from './host-service.js';
import { openHost } from './host.js';
import { openHostSettings } from './host-settings.js';
import { openDesktopClient } from './desktop-client.js';
import {
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_MAX_CONTROL_BYTES,
  BRIDGE_MAX_CONTROL_CALLS,
  BRIDGE_MAX_OBSERVERS,
  BRIDGE_MAX_NATIVE_CALLS,
  BRIDGE_NATIVE_TIMEOUT_MS,
  BRIDGE_CLIENT_OPERATIONS,
  BRIDGE_ERROR_CODES,
  BRIDGE_OUTCOMES,
  normalizeInitFrame,
  normalizeBridgeCommandFrame,
  BridgeCommandError,
  normalizeNativeResultFrame,
  normalizeNativeRequest,
  encodeReadyFrame,
  encodeClosedFrame,
  encodeResultFrame,
  encodeErrorFrame,
  encodeFrameFrame,
  encodeNativeCallFrame,
  encodeNativeCancelFrame,
  buildLine,
} from './android-bridge-protocol.js';

const RESULT_LABEL = 'result frame';
const FRAME_LABEL = 'frame frame';
const READY_LABEL = 'ready frame';
const CLOSED_LABEL = 'closed frame';
const NATIVE_LABEL = 'native_call frame';
const MAX_QUEUED_OUTPUT_BYTES = 80 * 1024 * 1024; // bound queued stdout frames
const DRAIN_TIMEOUT_MS = 5000;

function fixedCode(err) {
  return err && typeof err.code === 'string' && BRIDGE_ERROR_CODES.has(err.code) ? err.code : 'INTERNAL';
}

function fixedOutcome(err, code) {
  if (err && BRIDGE_OUTCOMES.has(err.outcome)) return err.outcome;
  if (code === 'INVALID_ARGUMENT' || code === 'REQUEST_TOO_LARGE') return 'not-sent';
  if (code === 'CANCELLED') return 'unconfirmed';
  return 'responded';
}

function commandErrorFrame(id, err) {
  const code = fixedCode(err);
  // Never promote unknown exception text to a trusted bridge message; fixed
  // INTERNAL frames carry no message at all.
  const message = code === 'INTERNAL' ? undefined : err?.message;
  return encodeErrorFrame(id, code, fixedOutcome(err, code), message);
}

function nativeError(info, outcome, message) {
  const err = new Error(message ?? 'android native call failed');
  err.name = 'AndroidNativeError';
  err.code = info;
  err.outcome = outcome;
  return err;
}

function boundDiag(text) {
  const line = String(text).replace(/\s+/g, ' ').trim();
  if (line.length === 0) return '\n';
  return line.slice(0, 4096) + '\n';
}

function errorWithOutcome(err, outcome) {
  err.outcome = outcome;
  return err;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fire(promise) {
  promise.catch(() => {});
  return promise;
}

function safeOn(stream, event, fn) {
  try {
    stream.on(event, fn);
    return true;
  } catch {
    return false;
  }
}

function safeOff(stream, event, fn) {
  try {
    stream.removeListener(event, fn);
  } catch {
    /* best effort */
  }
}

class OversizeError extends Error {
  constructor(label) {
    super(`frame exceeds size limit: ${label}`);
    this.name = 'OversizeError';
    this.label = label;
  }
}

/**
 * Read JSONL frames from a readable byte stream. Raw-byte limits: init/ordinary
 * command frames <=40MiB (including whitespace), native_result <=40MiB. UTF-8
 * and JSON decoding are fatal; a trailing partial line at EOF is a protocol
 * failure. Each incoming chunk is scanned once for newlines; the only repeated
 * scan is for a long unterminated partial line, which is capped at 40MiB.
 */
async function* readFrames(input) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let chunks = [];
  let headPos = 0; // bytes already consumed inside chunks[0]
  let size = 0; // unread raw bytes (sum of chunk lengths minus headPos)

  function recalcSize() {
    size = 0;
    for (const c of chunks) size += c.length;
    size -= headPos;
  }

  // Incremental newline scan: the front chunk is only scanned forward from
  // headPos, so many lines inside one chunk cost O(chunk) total. A line that
  // spans chunks concatenates once; an unterminated partial line is capped by
  // the 40MiB frame bound.
  function takeLine() {
    if (chunks.length === 0) return null;
    const idx = chunks[0].indexOf(0x0a, headPos);
    if (idx !== -1) {
      let line = chunks[0].subarray(headPos, idx);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
      headPos = idx + 1;
      if (headPos >= chunks[0].length) {
        chunks.shift();
        headPos = 0;
      }
      recalcSize();
      return { line, bytes: line.length };
    }
    const parts = [chunks[0].subarray(headPos)];
    let total = chunks[0].length - headPos;
    for (let i = 1; i < chunks.length; i += 1) {
      const b = chunks[i];
      const j = b.indexOf(0x0a);
      if (j !== -1) {
        let tail = b.subarray(0, j);
        if (tail.length > 0 && tail[tail.length - 1] === 0x0d) tail = tail.subarray(0, -1);
        parts.push(tail);
        const rest = b.subarray(j + 1);
        chunks = rest.length > 0 ? [rest, ...chunks.slice(i + 1)] : chunks.slice(i + 1);
        headPos = 0;
        recalcSize();
        return { line: Buffer.concat(parts), bytes: total + j };
      }
      parts.push(b);
      total += b.length;
    }
    return null; // still an incomplete line
  }

  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
    for (;;) {
      const found = takeLine();
      if (!found) break;
      if (found.bytes > BRIDGE_MAX_FRAME_BYTES) {
        throw messageError('BAD_FRAME', 'frame exceeds 40MiB limit');
      }
      let text;
      try {
        text = decoder.decode(found.line);
      } catch {
        throw messageError('INVALID_UTF8', 'frame is not valid UTF-8');
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw messageError('INVALID_JSON', 'frame is not valid JSON');
      }
      // Control frame raw-byte budget (including whitespace); native_result uses
      // the 40MiB hard frame cap checked above.
      if (parsed && typeof parsed === 'object' && parsed.type !== 'native_result') {
        if (found.bytes > BRIDGE_MAX_CONTROL_BYTES) {
          throw messageError('REQUEST_TOO_LARGE', 'command frame exceeds 40MiB');
        }
      }
      yield parsed;
    }
    if (size > BRIDGE_MAX_FRAME_BYTES) {
      throw messageError('BAD_FRAME', 'frame exceeds 40MiB limit');
    }
  }
  if (size > 0) throw messageError('BAD_FRAME', 'stream ended with an incomplete frame');
}

/**
 * Create the Android bridge. Returns { run, nativeBridge }. All streams and
 * callbacks are injectable; process stdio is the default.
 */
export function createAndroidBridge(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const exitOnClose = options.exitOnClose ?? (input === process.stdin && output === process.stdout);
  const onExit = options.onExit ?? ((code) => process.exit(code));

  let mode = null; // null | 'host' | 'settings' | 'client'
  let phase = 'starting'; // starting | ready | closing | closed
  let admitting = true;
  let terminated = false;
  let service = null;
  let settingsStore = null;
  let settingsHost = null; // offline settings-mode host identity
  let broker = null; // client-mode desktop broker (never opens a Host/Runtime/model)
  let deviceId = null;
  let controlUrl = null;
  let token = null;
  let adapter = null;
  let controlClient = null;
  let outputWritable = true;
  let outputFatal = false;
  let queuedBytes = 0;
  let previousWrite = Promise.resolve();
  let shutdownPromise = null;
  let startupOp = null; // tracked initialization promise
  const appliedCredentialNames = [];

  const calls = new Map(); // id -> { controller, op } (call/settings/status/shutdown)
  const observers = new Map(); // id -> { controller, done, op, terminal }
  const nativePending = new Map(); // id -> { resolve, reject, timer, onAbort, state, ... }

  function diag(line) {
    try {
      diagnostics.write(boundDiag(line));
    } catch {
      /* diagnostics are best effort */
    }
  }

  // ---- output backpressure (serialized writer) ----

  // Treat EPIPE/error/close/drain-deadline/queue overflow as fatal IPC failure:
  // pending mutations are unconfirmed and the host closes.
  function failOutput(err) {
    if (outputFatal) return;
    outputFatal = true;
    diag(`android host output failure: ${fixedCode(err)}`);
    void requestShutdown(1, null, false).then((code) => terminate(code));
  }

  // A single write task: waits for the previous task, then performs the actual
  // write under one deadline. Completion is the Writable callback (the write is
  // only complete once flushed), with drain as an extra wakeup under
  // backpressure and error/close listeners for fast failure. All listeners and
  // the timer are removed when the task settles. A synchronous write throw is
  // fatal immediately.
  function enqueueLine(line, opts = {}) {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (!outputWritable || outputFatal) return Promise.resolve(false);
    if (queuedBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
      failOutput(messageError('BACKPRESSURE', 'output queue exceeded'));
      return Promise.resolve(false);
    }
    queuedBytes += bytes;
    const task = () => new Promise((resolve) => {
      if (!outputWritable || outputFatal) {
        resolve(false);
        return;
      }
      // Recheck at actual writer execution (native dispatch hook).
      if (opts.beforeWrite && !opts.beforeWrite()) {
        resolve(false);
        return;
      }
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        safeOff(output, 'drain', onDrain);
        safeOff(output, 'error', onFail);
        safeOff(output, 'close', onFail);
      };
      const onFail = () => {
        cleanup();
        failOutput(messageError('NETWORK', 'output stream failed'));
        resolve(false);
      };
      const onDrain = () => {
        if (!settled) {
          cleanup();
          resolve(true);
        }
      };
      const onComplete = (err) => {
        if (err) {
          cleanup();
          failOutput(messageError('NETWORK', 'output write failed'));
          resolve(false);
          return;
        }
        cleanup();
        resolve(true);
      };
      let wrote = false;
      try {
        wrote = output.write(line, onComplete);
      } catch {
        cleanup();
        failOutput(messageError('NETWORK', 'output write threw'));
        resolve(false);
        return;
      }
      // Single deadline for the whole write (acceptance + flush).
      timer = setTimeout(() => {
        if (!settled) {
          cleanup();
          failOutput(messageError('NETWORK', 'output write deadline'));
          resolve(false);
        }
      }, DRAIN_TIMEOUT_MS);
      const onOk = safeOn(output, 'error', onFail);
      const onCloseOk = safeOn(output, 'close', onFail);
      let onDrainOk = true;
      if (!wrote) onDrainOk = safeOn(output, 'drain', onDrain);
      if (!onOk || !onCloseOk || !onDrainOk) {
        // Listeners unavailable on this stream: cannot observe failure/drain.
        cleanup();
        failOutput(messageError('NETWORK', 'output stream listeners unavailable'));
        resolve(false);
      }
    });
    const done = previousWrite.then(() => task()).finally(() => {
      queuedBytes -= bytes;
    });
    previousWrite = done.catch(() => {});
    return done;
  }

  async function sendFrameObject(object, maxBytes, label) {
    if (!outputWritable || outputFatal) return false;
    let line;
    try {
      line = buildLine(object, maxBytes, label);
    } catch (err) {
      if (err && err.code === 'REQUEST_TOO_LARGE') throw new OversizeError(label);
      return false;
    }
    return enqueueLine(line);
  }

  function sendResult(id, result) {
    return sendFrameObject(encodeResultFrame(id, result), BRIDGE_MAX_CONTROL_BYTES, RESULT_LABEL);
  }

  // Oversized results are never silently lost: report RESPONSE_TOO_LARGE.
  async function sendResultChecked(id, result) {
    try {
      return await sendResult(id, result);
    } catch (err) {
      if (err instanceof OversizeError) {
        await sendError(id, messageError('RESPONSE_TOO_LARGE', 'result frame exceeds 40MiB'));
        return false;
      }
      throw err;
    }
  }

  function sendError(id, err) {
    let frame;
    try {
      frame = commandErrorFrame(id, err);
    } catch {
      frame = encodeErrorFrame(id, 'INTERNAL', 'responded');
    }
    return sendFrameObject(frame, BRIDGE_MAX_CONTROL_BYTES, 'error frame');
  }

  function sendObserverFrame(id, frame) {
    return sendFrameObject(encodeFrameFrame(id, frame), BRIDGE_MAX_CONTROL_BYTES, FRAME_LABEL);
  }

  function sendNativeCancel(id) {
    return sendFrameObject(encodeNativeCancelFrame(id), BRIDGE_MAX_FRAME_BYTES, 'native_cancel frame');
  }

  // ---- credentials (this file owns application to the dedicated process.env) ----

  function applyCredentials(init) {
    if (!init.credentials) return;
    const entries = Object.entries(init.credentials);
    // Complete validation first, then apply atomically; assignment failures are
    // never swallowed (they surface as a startup failure).
    for (const [name] of entries) {
      if (Object.prototype.hasOwnProperty.call(process.env, name)) {
        throw messageError('INVALID_ARGUMENT', `credential would replace an existing host environment variable: ${name}`);
      }
    }
    for (const [name, value] of entries) {
      process.env[name] = value;
      appliedCredentialNames.push(name);
    }
  }

  function unapplyCredentials() {
    if (appliedCredentialNames.length === 0) return;
    const names = appliedCredentialNames.splice(0);
    for (const name of names) {
      try {
        delete process.env[name];
      } catch {
        /* best effort */
      }
    }
  }

  // ---- shared shutdown ----

  function clearNativeRec(id, rec) {
    nativePending.delete(id);
    clearTimeout(rec.timer);
    if (rec.onAbort) rec.signal.removeEventListener('abort', rec.onAbort);
  }

  // Cancelled/timed-out/write-failed calls: late replies are ignored (the id
  // is simply removed and never matched again).
  function settleCancelledNative(id, rec, fn) {
    if (!nativePending.has(id)) return;
    clearNativeRec(id, rec);
    fn();
  }

  function requestShutdown(code, sendClosedForId, livePeer, opts = {}) {
    if (shutdownPromise) return shutdownPromise;
    const awaitStartup = opts.awaitStartup !== false;
    shutdownPromise = (async () => {
      phase = 'closing';
      admitting = false;
      // Cancel control fetches and observers (skip the shutdown command itself).
      for (const [id, rec] of calls) {
        if (id === opts.excludeId) continue;
        rec.controller.abort();
      }
      for (const rec of observers.values()) rec.controller.abort();
      // Best-effort native_cancel to a live Java peer for sent calls only.
      if (livePeer) {
        for (const [nid, rec] of nativePending) {
          if (rec.state === 'sent') fire(sendNativeCancel(nid));
        }
      }
      for (const [nid, rec] of [...nativePending]) {
        settleCancelledNative(nid, rec, () => rec.reject(
          rec.state === 'sent'
            ? nativeError('ANDROID_NATIVE_UNCONFIRMED', 'unconfirmed', 'host closed before native reply')
            : nativeError('ANDROID_NATIVE_UNAVAILABLE', 'not-sent', 'host closed before native dispatch'),
        ));
      }
      if (startupOp && awaitStartup) {
        try {
          await startupOp; // join any service that resolves after closure
        } catch {
          /* startup already recorded */
        }
      }
      await Promise.allSettled(
        [...calls.entries()]
          .filter(([id]) => id !== opts.excludeId)
          .map(([, r]) => r.op),
      );
      await Promise.allSettled([...observers.values()].map((r) => r.op));
      const errors = [];
      if (service) {
        try {
          await service.close();
        } catch (err) {
          errors.push(err);
        }
        service = null;
      }
      if (settingsStore) {
        try {
          settingsStore.close();
        } catch (err) {
          errors.push(err);
        }
        settingsStore = null;
      }
      if (settingsHost) {
        try {
          settingsHost.close();
        } catch (err) {
          errors.push(err);
        }
        settingsHost = null;
      }
      if (broker) {
        // Client mode: close the broker (aborts client transports and
        // observations only; never stops a Host or Agent).
        try {
          await broker.close();
        } catch (err) {
          errors.push(err);
        }
        broker = null;
      }
      unapplyCredentials();
      phase = 'closed';
      // Only a successfully written closed frame can be called graceful; any
      // output failure keeps a failure exit code.
      let closedOk = true;
      if (sendClosedForId) {
        try {
          closedOk = await writeClosedFrame(sendClosedForId);
        } catch {
          closedOk = false;
        }
      }
      outputWritable = false;
      try {
        input.destroy?.();
      } catch {
        /* best effort */
      }
      const finalCode = errors.length > 0 || !closedOk || outputFatal ? 1 : code;
      return finalCode;
    })();
    return shutdownPromise;
  }

  function writeClosedFrame(id) {
    return enqueueLine(buildLine(encodeClosedFrame(id), BRIDGE_MAX_CONTROL_BYTES, CLOSED_LABEL));
  }

  function terminate(code) {
    if (terminated) return;
    terminated = true;
    if (exitOnClose) {
      void previousWrite.then(() => onExit(code));
    }
  }

  // ---- native bridge ----

  function flushQueuedNative() {
    for (const [id, rec] of [...nativePending]) {
      if (rec.state !== 'queued') continue;
      if (rec.signal && rec.signal.aborted) continue; // abort handler will settle
      let line;
      // Outbound native_call args are small; reject oversized dispatch before
      // sent-state (not unconfirmed).
      try {
        line = buildLine(
          encodeNativeCallFrame(id, rec.context, rec.tool, rec.args),
          BRIDGE_MAX_CONTROL_BYTES,
          NATIVE_LABEL,
        );
      } catch {
        settleCancelledNative(id, rec, () => rec.reject(nativeError('ANDROID_NATIVE_UNAVAILABLE', 'not-sent', 'android native call frame exceeds limit')));
        continue;
      }
      fire(enqueueLine(line, {
        beforeWrite: () => {
          const cur = nativePending.get(id);
          if (!cur || cur !== rec) return false; // cancelled/removed: never send stale
          if (rec.signal && rec.signal.aborted) return false;
          rec.state = 'sent'; // possible-sent immediately before actual write
          return true;
        },
      }).then((ok) => {
        if (!ok) {
          settleCancelledNative(id, rec, () => rec.reject(nativeError('ANDROID_NATIVE_UNCONFIRMED', 'unconfirmed', 'android native call write failed')));
        }
      }));
    }
  }

  function requestNativeBridge(request, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (mode !== 'host' || phase === 'closed' || phase === 'closing' || terminated) {
        reject(nativeError('ANDROID_NATIVE_UNAVAILABLE', 'not-sent', 'android native bridge is not ready'));
        return;
      }
      // Capacity includes ready-gated (queued) calls.
      if (nativePending.size >= BRIDGE_MAX_NATIVE_CALLS) {
        reject(nativeError('ANDROID_NATIVE_BUSY', 'not-sent', 'android native call capacity reached'));
        return;
      }
      let normalized;
      try {
        normalized = normalizeNativeRequest(request);
      } catch {
        reject(nativeError('ANDROID_NATIVE_UNAVAILABLE', 'not-sent', 'invalid android native request'));
        return;
      }
      if (signal && signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const id = randomUUID();
      const rec = {
        resolve,
        reject,
        timer: null,
        onAbort: null,
        signal: signal ?? null,
        state: 'queued', // never emit native_call before ready
        context: normalized.context,
        tool: normalized.tool,
        args: normalized.arguments,
      };
      rec.timer = setTimeout(() => {
        if (rec.state === 'sent') fire(sendNativeCancel(id));
        settleCancelledNative(id, rec, () => reject(nativeError(
          rec.state === 'sent' ? 'ANDROID_NATIVE_UNCONFIRMED' : 'ANDROID_NATIVE_UNAVAILABLE',
          rec.state === 'sent' ? 'unconfirmed' : 'not-sent',
          rec.state === 'sent' ? 'android native call timed out' : 'android native call timed out before ready',
        )));
      }, BRIDGE_NATIVE_TIMEOUT_MS);
      if (signal) {
        rec.onAbort = () => {
          if (rec.state === 'sent') fire(sendNativeCancel(id));
          settleCancelledNative(id, rec, () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        };
        signal.addEventListener('abort', rec.onAbort, { once: true });
      }
      nativePending.set(id, rec);
      if (phase === 'ready') flushQueuedNative();
    });
  }

  function handleNativeResult(parsed) {
    const frame = normalizeNativeResultFrame(parsed); // invalid frame shapes still fail connection
    const rec = nativePending.get(frame.id);
    // Queued (not yet sent), unmatched or late replies are ignored. A matched
    // sent call resolves exactly once.
    if (!rec || rec.state !== 'sent') return;
    clearNativeRec(frame.id, rec);
    if (frame.error) {
      rec.reject(nativeError(frame.error.code, 'responded', frame.error.message));
    } else {
      rec.resolve(frame.result);
    }
  }

  // ---- command dispatch (shared bounded ID tracking) ----

  function assertFreshId(id) {
    if (calls.has(id) || observers.has(id)) {
      throw messageError('BAD_FRAME', 'duplicate in-flight id');
    }
  }

  function busyError(id) {
    return fire(sendError(id, messageError('RPC_BUSY', 'bridge capacity reached')));
  }

  function runCall(cmd) {
    assertFreshId(cmd.id);
    const clientCall = mode === 'client';
    if (calls.size >= BRIDGE_MAX_CONTROL_CALLS || (clientCall ? !broker : !adapter)) {
      void busyError(cmd.id);
      return;
    }
    const controller = new AbortController();
    const rec = { controller, op: null };
    calls.set(cmd.id, rec);
    rec.op = (async () => {
      try {
        let result;
        if (clientCall) {
          // The call frame's method is a fixed broker operation; results are
          // wrapped once as {value} so null/array results survive IPC.
          if (!BRIDGE_CLIENT_OPERATIONS.has(cmd.method)) {
            throw messageError('INVALID_ARGUMENT', 'unsupported client operation');
          }
          const value = await broker.request(cmd.method, cmd.params);
          if (controller.signal.aborted) return; // cancelled: never answer late
          result = { value: value === undefined ? null : value };
        } else {
          result = await adapter(deviceId, cmd.method, cmd.params, { signal: controller.signal });
        }
        await sendResultChecked(cmd.id, result);
      } catch (err) {
        if (clientCall && controller.signal.aborted) return;
        await sendError(cmd.id, err);
      } finally {
        calls.delete(cmd.id);
      }
    })();
    rec.op.catch(() => {});
  }

  function finishObserver(id, err) {
    const rec = observers.get(id);
    if (!rec || rec.done) return;
    rec.done = true;
    rec.terminal = fire(sendError(id, err));
  }

  function runObserve(cmd) {
    assertFreshId(cmd.id);
    if (observers.size >= BRIDGE_MAX_OBSERVERS || !adapter) {
      void busyError(cmd.id);
      return;
    }
    const controller = new AbortController();
    const rec = { controller, done: false, op: null, terminal: null };
    observers.set(cmd.id, rec);
    rec.op = (async () => {
      let iter;
      try {
        iter = adapter.live(deviceId, cmd.target, { signal: controller.signal });
      } catch (err) {
        finishObserver(cmd.id, err);
        try {
          await rec.terminal;
        } catch {
          /* already failed */
        }
        observers.delete(cmd.id);
        return;
      }
      try {
        for await (const frame of iter) {
          if (rec.done) return;
          if (frame.type === 'end') {
            try {
              await sendObserverFrame(cmd.id, frame);
            } catch (err) {
              if (err instanceof OversizeError) {
                finishObserver(cmd.id, messageError('RESPONSE_TOO_LARGE', 'live frame exceeds 40MiB'));
                return;
              }
              throw err;
            }
            rec.done = true;
            return;
          }
          let ok;
          try {
            ok = await sendObserverFrame(cmd.id, frame);
          } catch (err) {
            if (err instanceof OversizeError) {
              finishObserver(cmd.id, messageError('RESPONSE_TOO_LARGE', 'live frame exceeds 40MiB'));
              return;
            }
            throw err;
          }
          if (!ok) {
            finishObserver(cmd.id, messageError('BACKPRESSURE', 'observer frame was not written'));
            return;
          }
        }
        if (!rec.done) finishObserver(cmd.id, messageError('BAD_RESPONSE', 'live stream ended without an end frame'));
      } catch (err) {
        if (!rec.done) {
          if (controller.signal.aborted || (err && err.name === 'AbortError')) {
            finishObserver(cmd.id, messageError('CANCELLED', 'observation cancelled'));
          } else {
            finishObserver(cmd.id, err);
          }
        }
      } finally {
        try {
          await iter.return?.();
        } catch {
          /* teardown is best effort */
        }
        // Await the terminal write before releasing the record so shutdown joins
        // both the teardown and the final frame.
        if (rec.terminal) {
          try {
            await rec.terminal;
          } catch {
            /* already failed */
          }
        }
        observers.delete(cmd.id);
      }
    })();
    rec.op.catch(() => {});
  }

  function runCancel(cmd) {
    const call = calls.get(cmd.id);
    if (call) {
      call.controller.abort(); // only aborts the fetch/broker wait; never the Agent
      return;
    }
    const observer = observers.get(cmd.id);
    if (observer) {
      if (mode === 'client') detachClientObservation(cmd.id, observer);
      else observer.controller.abort();
    }
    // Unknown ids are ignored (cancel is idempotent, fire-and-forget).
  }

  // ---- client mode: broker observations (reuses the observe/cancel frames) ----

  // The observe frame's target in client mode is {targetDeviceId, target}.
  function runClientObserve(cmd) {
    const target = cmd.target;
    const targetDeviceId = isPlainObject(target) ? target.targetDeviceId : null;
    const liveTarget = isPlainObject(target) ? target.target : null;
    if (typeof targetDeviceId !== 'string' || targetDeviceId === '' || !isPlainObject(liveTarget)) {
      void fire(sendError(cmd.id, messageError('INVALID_ARGUMENT', 'client observe target must be {targetDeviceId, target}')));
      return;
    }
    const connection = liveTarget.kind === 'connection';
    if (!broker || (connection ? [...observers.values()].some((rec) => rec.connection)
      : [...observers.values()].filter((rec) => !rec.connection).length >= BRIDGE_MAX_OBSERVERS)) {
      void busyError(cmd.id);
      return;
    }
    const controller = new AbortController();
    const rec = { controller, done: false, op: null, terminal: null, connection };
    // Register before dispatch so an immediate snapshot cannot arrive unrouted.
    observers.set(cmd.id, rec);
    rec.op = (async () => {
      try {
        await broker.request('observe', { observationId: cmd.id, targetDeviceId, target: liveTarget });
        if (rec.done || controller.signal.aborted) {
          // cancel/close raced the dispatch: drop only this observation, no replay.
          rec.done = true;
          releaseClientObservation(cmd.id, rec);
        }
      } catch (err) {
        finishObserver(cmd.id, err);
        if (rec.terminal) {
          try {
            await rec.terminal;
          } catch {
            /* already failed */
          }
        }
        dropObserver(cmd.id, rec);
      }
    })();
    rec.op.catch(() => {});
  }

  // Broker events are DesktopObservationEvents; forward them unchanged and
  // release the slot on a terminal (error or inner end) event. A local delivery
  // failure still goes through the real unobserve path: the subscription must
  // not keep running once the bridge record is gone.
  function handleClientEvent(event) {
    if (!isPlainObject(event) || event.type !== 'event' || typeof event.observationId !== 'string') return;
    const id = event.observationId;
    const rec = observers.get(id);
    if (!rec || rec.done) return;
    const terminal = event.error !== undefined
      || (isPlainObject(event.frame) && event.frame.type === 'end');
    fire(sendObserverFrame(id, event).then((ok) => {
      if (!ok) {
        finishObserver(id, messageError('BACKPRESSURE', 'client frame was not written'));
        releaseClientObservation(id, rec);
        return;
      }
      if (terminal) {
        // 终态事件：broker 侧已自行结束该观察，只需丢本地记录。
        rec.done = true;
        dropObserver(id, rec);
      }
    }).catch((err) => {
      finishObserver(id, err instanceof OversizeError
        ? messageError('RESPONSE_TOO_LARGE', 'client frame exceeds 40MiB')
        : messageError('INTERNAL', 'client frame was not written'));
      releaseClientObservation(id, rec);
    }));
  }

  // Remove only this record: a later observation may legitimately reuse the id.
  function dropObserver(id, rec) {
    if (observers.get(id) === rec) observers.delete(id);
  }

  // Drop the local record and run the broker's local unobserve directly (it is exempt from
  // the in-flight and switching gates). A genuine failure closes the current client session:
  // never swallow it, and never await our own close from inside a broker callback.
  function releaseClientObservation(id, rec) {
    dropObserver(id, rec);
    if (!broker) return;
    fire(broker.request('unobserve', { observationId: id }).catch((err) => {
      failClientSession(err);
    }));
  }

  function detachClientObservation(id, rec) {
    if (!rec || rec.done) return;
    rec.done = true;
    releaseClientObservation(id, rec);
  }

  // Client-mode 会话收尾：只有真正失败才走这里（已在关闭流程中则不重入），交给 shutdown
  // 流程异步完成，不在回调里同步等待自身关闭。
  function failClientSession(err) {
    diag(`android client observation cleanup failed: ${fixedCode(err)}`);
    if (phase === 'closing' || phase === 'closed' || terminated) return;
    void requestShutdown(1, null, false, { awaitStartup: false }).then((code) => terminate(code));
  }

  function runStatus(cmd) {
    assertFreshId(cmd.id);
    if (calls.size >= BRIDGE_MAX_CONTROL_CALLS) {
      void busyError(cmd.id);
      return;
    }
    const controller = new AbortController();
    const rec = { controller, op: null };
    calls.set(cmd.id, rec);
    rec.op = (async () => {
      try {
        let result;
        if (mode === 'host' && service) {
          result = service.getStatus();
        } else if (mode === 'settings' && settingsStore) {
          const snapshot = settingsStore.get();
          result = {
            deviceId,
            mode: 'settings',
            phase: phase === 'closed' ? 'closed' : 'offline',
            offline: true,
            control: null,
            relay: null,
            activeSettingsRevision: null,
            settingsRevision: snapshot.revision,
            restartRequired: false,
          };
        } else {
          throw messageError('NOT_CONNECTED', 'host is not running');
        }
        await sendResultChecked(cmd.id, result);
      } catch (err) {
        await sendError(cmd.id, err);
      } finally {
        calls.delete(cmd.id);
      }
    })();
    rec.op.catch(() => {});
  }

  // Settings commands run under the same bounded request tracking as calls so
  // the input reader never blocks on network and cancel can abort them.
  function runSettingsGet(cmd) {
    assertFreshId(cmd.id);
    if (calls.size >= BRIDGE_MAX_CONTROL_CALLS) {
      void busyError(cmd.id);
      return;
    }
    const controller = new AbortController();
    const rec = { controller, op: null };
    calls.set(cmd.id, rec);
    rec.op = (async () => {
      try {
        let result;
        if (mode === 'host' && controlUrl && token) {
          const client = controlClient ?? (controlClient = createControlClient({ url: controlUrl, token }));
          result = await client.getLocalSettings({ signal: controller.signal });
        } else if (mode === 'settings' && settingsStore) {
          result = settingsStore.get();
        } else {
          throw messageError('NOT_CONNECTED', 'settings are not available');
        }
        await sendResultChecked(cmd.id, result);
      } catch (err) {
        if (controller.signal.aborted || (err && err.name === 'AbortError')) {
          await sendError(cmd.id, messageError('CANCELLED', 'settings request cancelled'));
        } else {
          await sendError(cmd.id, err);
        }
      } finally {
        calls.delete(cmd.id);
      }
    })();
    rec.op.catch(() => {});
  }

  function runSettingsSet(cmd) {
    assertFreshId(cmd.id);
    if (calls.size >= BRIDGE_MAX_CONTROL_CALLS) {
      void busyError(cmd.id);
      return;
    }
    const controller = new AbortController();
    const rec = { controller, op: null };
    calls.set(cmd.id, rec);
    rec.op = (async () => {
      try {
        let result;
        if (mode === 'host' && controlUrl && token) {
          const client = controlClient ?? (controlClient = createControlClient({ url: controlUrl, token }));
          result = await client.replaceLocalSettings(cmd.input, { signal: controller.signal });
        } else if (mode === 'settings' && settingsStore) {
          result = settingsStore.replace(cmd.input);
        } else {
          throw messageError('NOT_CONNECTED', 'settings are not available');
        }
        await sendResultChecked(cmd.id, result);
      } catch (err) {
        if (controller.signal.aborted || (err && err.name === 'AbortError')) {
          await sendError(cmd.id, messageError('CANCELLED', 'settings update cancelled'));
        } else {
          const code = fixedCode(err);
          const outcome = code === 'INVALID_ARGUMENT' || code === 'REQUEST_TOO_LARGE' ? 'not-sent' : 'responded';
          // Fixed safe message; never promote unknown exception text.
          await sendError(cmd.id, errorWithOutcome(messageError(code, 'settings update failed'), outcome));
        }
      } finally {
        calls.delete(cmd.id);
      }
    })();
    rec.op.catch(() => {});
  }

  function runShutdown(cmd) {
    assertFreshId(cmd.id);
    const rec = { controller: new AbortController(), op: null };
    calls.set(cmd.id, rec);
    rec.op = (async () => {
      try {
        const code = await requestShutdown(0, cmd.id, true, { excludeId: cmd.id }); // live Java peer
        terminate(code);
      } finally {
        calls.delete(cmd.id);
      }
    })();
    rec.op.catch(() => {});
  }

  async function dispatch(cmd) {
    if (phase !== 'ready' || !admitting) {
      if (cmd.type === 'shutdown') {
        await runShutdown(cmd);
        return;
      }
      // Pre-ready or post-shutdown commands are refused, not fatal.
      await sendError(cmd.id, messageError('NOT_CONNECTED', 'host is not ready'));
      return;
    }
    switch (cmd.type) {
      case 'call':
        runCall(cmd);
        break;
      case 'observe':
        if (mode === 'client') runClientObserve(cmd);
        else runObserve(cmd);
        break;
      case 'cancel':
        runCancel(cmd);
        break;
      case 'status':
        runStatus(cmd);
        break;
      case 'settings_get':
        runSettingsGet(cmd);
        break;
      case 'settings_set':
        runSettingsSet(cmd);
        break;
      case 'shutdown':
        await runShutdown(cmd);
        break;
      default:
        await sendError(cmd.id, messageError('BAD_FRAME', 'unknown command type'));
    }
  }

  // ---- init ----

  // Fire-and-forget on purpose: failStartup runs inside startupOp, and
  // requestShutdown joins startupOp, so awaiting it here would deadlock.
  function failStartup(err) {
    diag(`android host startup failed: ${fixedCode(err)}`);
    void requestShutdown(1, null, false, { awaitStartup: false }).then((code) => terminate(code));
  }

  async function initialize(init) {
    deviceId = null;
    if (init.mode === 'host') {
      token = init.token;
      try {
        service = await openHostService({
          dataRoot: init.dataRoot,
          token: init.token,
          center: init.center,
          npmPath: init.npmPath,
          port: 0,
          initialSettings: init.initialSettings,
          nativeBridge: requestNativeBridge,
          displayName: init.displayName,
          platform: 'android',
        });
      } catch (err) {
        await failStartup(err);
        return;
      }
      // Shutdown/EOF during startup: close any service that resolved after
      // closure; never turn phase back to ready.
      if (phase === 'closing' || phase === 'closed' || terminated) {
        try {
          await service.close();
        } catch {
          /* best effort */
        }
        service = null;
        return;
      }
      deviceId = service.deviceId;
      controlUrl = service.url;
      adapter = createLocalControlAdapter({ url: controlUrl, token });
      try {
        const ok = await sendFrameObject(
          encodeReadyFrame({
            deviceId,
            url: controlUrl,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
          }),
          BRIDGE_MAX_CONTROL_BYTES,
          READY_LABEL,
        );
        if (!ok) {
          await failStartup(messageError('INTERNAL', 'ready frame was not written'));
          return;
        }
      } catch (err) {
        await failStartup(err);
        return;
      }
      if (phase === 'closing' || phase === 'closed' || terminated) return;
      phase = 'ready';
      flushQueuedNative(); // ready has been written; only now may native_call fly
      return;
    }
    if (init.mode === 'client') {
      // client mode: broker only (ui store + pending ledger + fixed transports).
      // Never opens a Host/Runtime, never reads model credentials, never emits
      // native tool calls. The broker's clientId (not secret) is the ready id.
      try {
        broker = openDesktopClient({ dataRoot: init.dataRoot, onEvent: handleClientEvent, persistCenterCredentials: false });
        const status = await broker.request('status', {});
        deviceId = status && typeof status.clientId === 'string' && status.clientId !== '' ? status.clientId : null;
        if (!deviceId) throw messageError('INTERNAL', 'client broker reported no clientId');
      } catch (err) {
        if (broker) {
          try {
            await broker.close();
          } catch {
            /* best effort */
          }
          broker = null;
        }
        await failStartup(err);
        return;
      }
      if (phase === 'closing' || phase === 'closed' || terminated) {
        try {
          await broker.close();
        } catch {
          /* best effort */
        }
        broker = null;
        return;
      }
      try {
        const ok = await sendFrameObject(
          encodeReadyFrame({
            deviceId,
            url: null,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
          }),
          BRIDGE_MAX_CONTROL_BYTES,
          READY_LABEL,
        );
        if (!ok) {
          await failStartup(messageError('INTERNAL', 'ready frame was not written'));
          return;
        }
      } catch (err) {
        await failStartup(err);
        return;
      }
      if (phase === 'closing' || phase === 'closed' || terminated) return;
      phase = 'ready';
      return;
    }
    // settings mode: offline settings store and host identity only; no Runtime/FGS/model.
    try {
      settingsHost = openHost({ dataRoot: init.dataRoot });
      deviceId = settingsHost.deviceId;
      settingsStore = openHostSettings({ dataRoot: init.dataRoot, deviceId });
    } catch (err) {
      if (settingsHost) {
        try {
          settingsHost.close();
        } catch {
          /* best effort */
        }
        settingsHost = null;
      }
      await failStartup(err);
      return;
    }
    if (phase === 'closing' || phase === 'closed' || terminated) {
      try {
        settingsStore.close();
      } catch {
        /* best effort */
      }
      settingsStore = null;
      try {
        settingsHost.close();
      } catch {
        /* best effort */
      }
      settingsHost = null;
      return;
    }
    try {
      const ok = await sendFrameObject(
        encodeReadyFrame({
          deviceId,
          url: null,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        }),
        BRIDGE_MAX_CONTROL_BYTES,
        READY_LABEL,
      );
      if (!ok) {
        await failStartup(messageError('INTERNAL', 'ready frame was not written'));
        return;
      }
    } catch (err) {
      await failStartup(err);
      return;
    }
    if (phase === 'closing' || phase === 'closed' || terminated) return;
    phase = 'ready';
  }

  async function handleFrame(parsed) {
    if (phase === 'closed' || phase === 'closing') return;
    if (parsed && parsed.type === 'native_result') {
      handleNativeResult(parsed);
      return;
    }
    let cmd;
    try {
      cmd = normalizeBridgeCommandFrame(parsed);
    } catch (err) {
      if (err instanceof BridgeCommandError) {
        // Malformed but recognizable command: answer with an error frame.
        await sendError(parsed?.id, err);
        return;
      }
      throw err; // fatal: fail the connection
    }
    await dispatch(cmd);
  }

  async function run() {
    let first = true;
    let eof = false;
    const iterator = readFrames(input)[Symbol.asyncIterator]();
    try {
      while (!eof) {
        if (phase === 'closed' || terminated) break;
        const next = await iterator.next();
        if (next.done) {
          eof = true;
          break;
        }
        const parsed = next.value;
        if (first) {
          first = false;
          let init;
          try {
            init = normalizeInitFrame(parsed); // single normalization
          } catch (err) {
            throw messageError(fixedCode(err), 'invalid init frame');
          }
          mode = init.mode;
          if (mode === 'host') {
            try {
              applyCredentials(init); // environment check once, before service open
            } catch (err) {
              throw messageError(fixedCode(err), 'invalid host credentials');
            }
          }
          // Run initialization concurrently so shutdown/EOF/native_result frames
          // remain processable during startup.
          startupOp = (async () => {
            try {
              await initialize(init);
            } catch (err) {
              diag(`android host startup failed: ${fixedCode(err)}`);
              if (phase !== 'closing' && phase !== 'closed' && !terminated) {
                void requestShutdown(1, null, false, { awaitStartup: false }).then((code) => terminate(code));
              }
            }
          })();
          continue;
        }
        await handleFrame(parsed);
      }
      if (phase !== 'closed' && !terminated) {
        // Unexpected EOF: close the host and reject pending requests without replay.
        const code = await requestShutdown(1, null, false);
        terminate(code);
      }
    } catch (err) {
      diag(`android bridge protocol failure: ${fixedCode(err)}`);
      const code = await requestShutdown(1, null, false);
      terminate(code);
    }
  }

  safeOn(output, 'error', () => failOutput(messageError('NETWORK', 'output stream error')));
  safeOn(output, 'close', () => failOutput(messageError('NETWORK', 'output stream closed')));

  return {
    run,
    nativeBridge: requestNativeBridge,
  };
}

/**
 * Run the Android host bridge over the process stdio streams (or injected
 * streams). Returns the bridge; the returned promise settles when the bridge
 * closes in non-exit mode.
 */
export async function runAndroidRuntime(options = {}) {
  const bridge = createAndroidBridge(options);
  await bridge.run();
  return bridge;
}

// Strict entrypoint guard: only auto-run when executed directly, never on
// module import. Uses the platform import.meta.main marker (Node >=24.2)
// instead of argv/file normalization. Final catch uses fixed safe text,
// never dumps raw errors.
if (import.meta.main) {
  runAndroidRuntime().catch(() => {
    process.stderr.write('android runtime fatal\n');
    process.exit(1);
  });
}
