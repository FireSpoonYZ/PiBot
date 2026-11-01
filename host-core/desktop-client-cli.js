// host-core/desktop-client-cli.js
// Module 17: UTF-8 JSONL stdio sidecar CLI for the desktop Tauri client.
// Inert on import; calls openDesktopClient({dataRoot,onEvent}) only after
// receiving the initial init request. Strict UTF-8/JSON, 40 MiB line cap,
// 8 in-flight requests and 8 observations, stdout protocol only, stderr fixed
// non-sensitive stage messages, serialized backpressure-aware stdout writer.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertId, messageError } from './message-protocol.js';
import {
  openDesktopClient,
  normalizeDesktopError,
  DESKTOP_MAX_IN_FLIGHT_REQUESTS,
} from './desktop-client.js';

export const DESKTOP_WIRE_MAX_LINE_BYTES = 41943040; // 40 MiB
const MAX_QUEUED_OUTPUT_BYTES = 80 * 1024 * 1024; // 80 MiB
const DRAIN_TIMEOUT_MS = 5000;

const STAGE_MESSAGES = Object.freeze({
  starting: 'desktop client cli starting\n',
  initialized: 'desktop client cli initialized\n',
  closing: 'desktop client cli closing\n',
  closed: 'desktop client cli closed\n',
  protocolError: 'desktop client cli protocol error\n',
  outputError: 'desktop client cli output error\n',
  fatal: 'desktop client cli fatal\n',
});

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw messageError('INVALID_ARGUMENT', `${label} has unknown field: ${key}`);
    }
  }
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

/**
 * Read strict UTF-8 JSONL lines from a byte stream with a hard 40 MiB line cap.
 * Trailing partial line at EOF, invalid UTF-8, or invalid JSON are fatal
 * protocol errors.
 */
async function* readWireLines(input) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let chunks = [];
  let headPos = 0;
  let size = 0;

  function recalcSize() {
    size = 0;
    for (const c of chunks) size += c.length;
    size -= headPos;
  }

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
    return null;
  }

  for await (const chunk of input) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
    for (;;) {
      const found = takeLine();
      if (!found) break;
      if (found.bytes > DESKTOP_WIRE_MAX_LINE_BYTES) {
        throw messageError('REQUEST_TOO_LARGE', 'input line exceeds 40 MiB limit');
      }
      let text;
      try {
        text = decoder.decode(found.line);
      } catch {
        throw messageError('INVALID_UTF8', 'input line is not valid UTF-8');
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw messageError('INVALID_JSON', 'input line is not valid JSON');
      }
      yield parsed;
    }
    if (size > DESKTOP_WIRE_MAX_LINE_BYTES) {
      throw messageError('REQUEST_TOO_LARGE', 'input line exceeds 40 MiB limit');
    }
  }
  if (size > 0) {
    throw messageError('BAD_FRAME', 'stream ended with an incomplete line');
  }
}

function normalizeRequestEnvelope(parsed) {
  if (!isPlainObject(parsed)) {
    throw messageError('BAD_FRAME', 'wire frame must be a JSON object');
  }
  rejectUnknownFields(parsed, new Set(['type', 'id', 'op', 'params']), 'request frame');
  if (parsed.type !== 'request') {
    throw messageError('BAD_FRAME', "wire frame type must be 'request'");
  }
  assertId(parsed.id, 'id');
  if (typeof parsed.op !== 'string' || !parsed.op.isWellFormed() || parsed.op.trim() === '') {
    throw messageError('INVALID_ARGUMENT', 'request op must be a non-empty string');
  }
  const params = parsed.params === undefined ? {} : parsed.params;
  if (!isPlainObject(params)) {
    throw messageError('INVALID_ARGUMENT', 'request params must be a JSON object');
  }
  return { id: parsed.id, op: parsed.op, params };
}

export function createDesktopClientCli(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const exitOnClose = options.exitOnClose ?? (input === process.stdin && output === process.stdout);
  const onExit = options.onExit ?? ((code) => process.exit(code));

  let client = null;
  let initialized = false;
  let closing = false;
  let closed = false;
  let terminated = false;
  let outputWritable = true;
  let outputFatal = false;
  let queuedBytes = 0;
  let previousWrite = Promise.resolve();
  let shutdownPromise = null;

  const activeIds = new Set();
  const activeOps = new Set();

  function stage(msg) {
    try {
      diagnostics.write(msg);
    } catch {
      /* diagnostics are best effort */
    }
  }

  function failOutput() {
    if (outputFatal) return;
    outputFatal = true;
    stage(STAGE_MESSAGES.outputError);
    void requestShutdown(1, null).then((code) => terminate(code));
  }

  function enqueueLine(line) {
    const bytes = Buffer.byteLength(line, 'utf8');
    if (!outputWritable || outputFatal) return Promise.resolve(false);
    if (queuedBytes + bytes > MAX_QUEUED_OUTPUT_BYTES) {
      failOutput();
      return Promise.resolve(false);
    }
    queuedBytes += bytes;
    const task = () =>
      new Promise((resolve) => {
        if (!outputWritable || outputFatal) {
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
          failOutput();
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
            failOutput();
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
          failOutput();
          resolve(false);
          return;
        }
        timer = setTimeout(() => {
          if (!settled) {
            cleanup();
            failOutput();
            resolve(false);
          }
        }, DRAIN_TIMEOUT_MS);
        const onOk = safeOn(output, 'error', onFail);
        const onCloseOk = safeOn(output, 'close', onFail);
        let onDrainOk = true;
        if (!wrote) onDrainOk = safeOn(output, 'drain', onDrain);
        if (!onOk || !onCloseOk || !onDrainOk) {
          cleanup();
          failOutput();
          resolve(false);
        }
      });

    const done = previousWrite.then(() => task()).finally(() => {
      queuedBytes -= bytes;
    });
    previousWrite = done.catch(() => {});
    return done;
  }

  async function writeWireObject(obj) {
    if (!outputWritable || outputFatal) return false;
    let json;
    try {
      json = JSON.stringify(obj);
    } catch {
      return false;
    }
    const bytes = Buffer.byteLength(json, 'utf8') + 1;
    if (bytes > DESKTOP_WIRE_MAX_LINE_BYTES) {
      if (obj.type === 'response' && obj.ok === true) {
        const errFrame = {
          type: 'response',
          id: obj.id,
          ok: false,
          error: {
            code: 'RESPONSE_TOO_LARGE',
            message: 'response exceeds 40 MiB wire limit',
            outcome: 'responded',
          },
        };
        return enqueueLine(JSON.stringify(errFrame) + '\n');
      }
      if (obj.type === 'event' && obj.frame !== undefined) {
        const errEvent = {
          type: 'event',
          observationId: obj.observationId,
          error: {
            code: 'RESPONSE_TOO_LARGE',
            message: 'live frame exceeds 40 MiB wire limit',
            outcome: 'responded',
          },
        };
        return enqueueLine(JSON.stringify(errEvent) + '\n');
      }
      return false;
    }
    return enqueueLine(json + '\n');
  }

  function sendOkResponse(id, result) {
    return writeWireObject({
      type: 'response',
      id,
      ok: true,
      result,
    });
  }

  function sendErrorResponse(id, err, fallbackOutcome = 'not-sent') {
    const error = normalizeDesktopError(err, fallbackOutcome);
    return writeWireObject({
      type: 'response',
      id,
      ok: false,
      error,
    });
  }

  async function handleEvent(event) {
    if (closing || closed) return;
    await writeWireObject(event);
  }

  function requestShutdown(exitCode, closeRequestId) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      closing = true;
      stage(STAGE_MESSAGES.closing);

      let clientCloseError = null;
      if (client) {
        const c = client;
        client = null;
        try {
          await c.close();
        } catch (err) {
          clientCloseError = err;
        }
      }

      // Join all remaining in-flight operations. The close request itself is
      // never registered in activeOps, so shutdown never waits on itself.
      if (activeOps.size > 0) {
        await Promise.allSettled([...activeOps]);
      }

      let closeRespOk = true;
      if (closeRequestId !== null && closeRequestId !== undefined) {
        if (clientCloseError) {
          closeRespOk = await sendErrorResponse(closeRequestId, clientCloseError, 'responded');
        } else {
          closeRespOk = await sendOkResponse(closeRequestId, { closed: true });
        }
      }

      closed = true;
      outputWritable = false;
      try {
        input.destroy?.();
      } catch {
        /* best effort */
      }
      stage(STAGE_MESSAGES.closed);
      return clientCloseError || !closeRespOk || outputFatal ? 1 : exitCode;
    })();
    return shutdownPromise;
  }

  function terminate(code) {
    if (terminated) return;
    terminated = true;
    if (exitOnClose) {
      void previousWrite.then(() => onExit(code));
    }
  }

  function dispatchRequest(req) {
    if (closing || closed) {
      void sendErrorResponse(req.id, messageError('NOT_CONNECTED', 'desktop client is closing'), 'not-sent');
      return;
    }
    if (activeIds.has(req.id)) {
      throw messageError('BAD_FRAME', `duplicate in-flight request id: ${req.id}`);
    }

    if (!initialized) {
      if (req.op === 'close') {
        if (Object.keys(req.params).length > 0) {
          void sendErrorResponse(req.id, messageError('INVALID_ARGUMENT', 'close params must be empty'), 'not-sent');
          return;
        }
        activeIds.add(req.id);
        void (async () => {
          try {
            const code = await requestShutdown(0, req.id);
            terminate(code);
          } finally {
            activeIds.delete(req.id);
          }
        })();
        return;
      }
      if (req.op !== 'init') {
        void sendErrorResponse(req.id, messageError('NOT_CONNECTED', 'init must be the first operation'), 'not-sent');
        return;
      }
      activeIds.add(req.id);
      let initOp;
      initOp = (async () => {
        try {
          rejectUnknownFields(req.params, new Set(['dataRoot']), 'init params');
          const { dataRoot } = req.params;
          if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
            throw messageError('INVALID_ARGUMENT', 'init dataRoot must be a non-empty absolute path');
          }
          client = openDesktopClient({
            dataRoot: path.resolve(dataRoot),
            onEvent: handleEvent,
          });
          initialized = true;
          stage(STAGE_MESSAGES.initialized);
          const status = await client.request('center_status', {});
          await sendOkResponse(req.id, { clientId: status.clientId });
        } catch (err) {
          await sendErrorResponse(req.id, err, 'not-sent');
        } finally {
          activeIds.delete(req.id);
          activeOps.delete(initOp);
        }
      })();
      activeOps.add(initOp);
      return;
    }

    if (req.op === 'init') {
      void sendErrorResponse(req.id, messageError('INVALID_ARGUMENT', 'desktop client is already initialized'), 'not-sent');
      return;
    }

    if (req.op === 'close') {
      if (Object.keys(req.params).length > 0) {
        void sendErrorResponse(req.id, messageError('INVALID_ARGUMENT', 'close params must be empty'), 'not-sent');
        return;
      }
      activeIds.add(req.id);
      void (async () => {
        try {
          const code = await requestShutdown(0, req.id);
          terminate(code);
        } finally {
          activeIds.delete(req.id);
        }
      })();
      return;
    }

    if (activeIds.size >= DESKTOP_MAX_IN_FLIGHT_REQUESTS) {
      void sendErrorResponse(req.id, messageError('RPC_BUSY', 'maximum in-flight requests reached'), 'not-sent');
      return;
    }

    activeIds.add(req.id);
    let opPromise;
    opPromise = (async () => {
      try {
        if (!client) {
          throw messageError('NOT_CONNECTED', 'desktop client is closed');
        }
        const result = await client.request(req.op, req.params);
        await sendOkResponse(req.id, result);
      } catch (err) {
        await sendErrorResponse(req.id, err, 'unconfirmed');
      } finally {
        activeIds.delete(req.id);
        activeOps.delete(opPromise);
      }
    })();
    activeOps.add(opPromise);
  }

  async function run() {
    stage(STAGE_MESSAGES.starting);
    try {
      for await (const parsed of readWireLines(input)) {
        if (closed || terminated) break;
        let req;
        try {
          req = normalizeRequestEnvelope(parsed);
        } catch (err) {
          // If it is a recognizable request envelope with a valid id, answer with error response;
          // otherwise treat as fatal wire violation.
          if (
            isPlainObject(parsed) &&
            parsed.type === 'request' &&
            typeof parsed.id === 'string' &&
            parsed.id.isWellFormed() &&
            parsed.id.trim() !== '' &&
            Buffer.byteLength(parsed.id, 'utf8') <= 256 &&
            err?.code === 'INVALID_ARGUMENT'
          ) {
            await sendErrorResponse(parsed.id, err, 'not-sent');
            continue;
          }
          throw err;
        }
        dispatchRequest(req);
      }
      if (!closed && !terminated) {
        // EOF: abort transports/observations and close client stores cleanly
        const code = await requestShutdown(0, null);
        terminate(code);
      }
    } catch {
      stage(STAGE_MESSAGES.protocolError);
      const code = await requestShutdown(1, null);
      terminate(code);
    }
  }

  safeOn(output, 'error', failOutput);
  safeOn(output, 'close', failOutput);

  return { run };
}

export async function runDesktopClientCli(options = {}) {
  const cli = createDesktopClientCli(options);
  await cli.run();
  return cli;
}

function isDirectEntry() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectEntry()) {
  runDesktopClientCli().catch(() => {
    try {
      process.stderr.write(STAGE_MESSAGES.fatal);
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
