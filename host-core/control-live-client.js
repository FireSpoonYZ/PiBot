// SSE parser for the Host control live endpoint (web-standard only; no Node/Host imports).
// Protocol failures throw plain Error with code 'LIVE_PROTOCOL'; client.live maps them to ControlApiError.
// readControlLive: Bot 主私聊流（无 scopeId，conversationId 恒非空）。
// readWorkLive: 远端工作上下文流（每帧校验 scopeId；conversationId 绑定前可为 null，
// 绑定后过渡为非空 UUID，此后不许回退或改换；work 只发完整快照帧）。

// SSE 帧/行上限 = 快照 JSON 上限 8 MiB + SSE 行封套余量 8192（与 MAX_LIVE_JSON_BYTES 对齐）。
const MAX_FRAME_BYTES = 8 * 1024 * 1024 + 8192; // 8 MiB + 8 KiB per SSE frame/event (UTF-8 bytes)
const END_REASONS = new Set([
  'stopped',
  'cancelled',
  'session_closed',
  'retired',
  'listener_error',
  'session_failed'
]);

const ENCODER = new TextEncoder();

function utf8Length(text) {
  return ENCODER.encode(text).length;
}

function protocolError(message) {
  const err = new Error(`Host control live stream protocol error: ${message}`);
  err.code = 'LIVE_PROTOCOL';
  return err;
}

export async function* readControlLive(response, { botId, signal } = {}) {
  yield* readLive(response, { botId, scopeId: null, signal });
}

export async function* readWorkLive(response, { botId, scopeId, signal } = {}) {
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw protocolError('scopeId is required');
  }
  yield* readLive(response, { botId, scopeId, signal });
}

async function* readLive(response, { botId, scopeId, signal }) {
  const isWork = scopeId !== null;
  if (typeof botId !== 'string' || botId.length === 0) {
    throw protocolError('botId is required');
  }
  if (!response || !response.body || typeof response.body.getReader !== 'function') {
    throw protocolError('response body is not a readable stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let dataLines = null;
  let eventBytes = 0;
  let commentBytes = 0;
  let ended = false;
  let frameCount = 0;
  let prevSequence = null;
  let expectedConversationId = null;

  function validateFrame(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      throw protocolError('frame is not an object');
    }
    const { type } = frame;
    if (type !== 'snapshot' && type !== 'update' && type !== 'end') {
      throw protocolError('unknown frame type');
    }
    if (isWork && type === 'update') {
      throw protocolError('work live frames must be full snapshots');
    }
    if (frameCount === 0 && type !== 'snapshot') {
      throw protocolError('first frame must be a snapshot');
    }
    if (frame.botId !== botId) {
      throw protocolError('frame botId does not match requested botId');
    }
    if (isWork) {
      if (frame.scopeId !== scopeId) {
        throw protocolError('frame scopeId does not match requested scopeId');
      }
    } else if (frame.scopeId !== undefined) {
      throw protocolError('frame must not carry scopeId');
    }
    if (isWork) {
      if (frame.conversationId !== null && (typeof frame.conversationId !== 'string' || frame.conversationId.length === 0)) {
        throw protocolError('frame conversationId is missing or empty');
      }
      if (frame.conversationId !== null) {
        if (expectedConversationId === null) {
          expectedConversationId = frame.conversationId;
        } else if (frame.conversationId !== expectedConversationId) {
          throw protocolError('frame conversationId changed mid-stream');
        }
      } else if (expectedConversationId !== null) {
        throw protocolError('frame conversationId reverted to null after binding');
      }
    } else {
      if (typeof frame.conversationId !== 'string' || frame.conversationId.length === 0) {
        throw protocolError('frame conversationId is missing or empty');
      }
      if (frameCount === 0) {
        expectedConversationId = frame.conversationId;
      } else if (frame.conversationId !== expectedConversationId) {
        throw protocolError('frame conversationId changed mid-stream');
      }
    }
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
      throw protocolError('frame sequence is not a safe nonnegative integer');
    }
    if (prevSequence !== null && frame.sequence < prevSequence) {
      throw protocolError('frame sequence went backwards');
    }
    prevSequence = frame.sequence;
    if (type === 'snapshot' && (!frame.state || typeof frame.state !== 'object' || Array.isArray(frame.state))) {
      throw protocolError('snapshot frame state is not an object');
    }
    if (type === 'update' && (!frame.changes || typeof frame.changes !== 'object' || Array.isArray(frame.changes))) {
      throw protocolError('update frame changes is not an object');
    }
    if (type === 'end' && !END_REASONS.has(frame.reason)) {
      throw protocolError('end frame reason is invalid');
    }
    frameCount++;
    return frame;
  }

  function dispatch() {
    eventBytes = 0;
    commentBytes = 0;
    if (!dataLines) return null;
    const data = dataLines.join('\n');
    dataLines = null;
    if (data.length === 0) return null;
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      throw protocolError('frame data is not valid JSON');
    }
    return validateFrame(frame);
  }

  function feed(chunk) {
    buffer += chunk;
    const frames = [];
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const lineBytes = utf8Length(line) + 1; // includes terminating '\n' and any '\r'
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) {
        const frame = dispatch();
        if (frame) frames.push(frame);
        continue;
      }
      if (line.startsWith(':')) {
        commentBytes += lineBytes;
        if (commentBytes > MAX_FRAME_BYTES) {
          throw protocolError('comments exceed frame size limit');
        }
        continue;
      }
      eventBytes += lineBytes;
      if (eventBytes > MAX_FRAME_BYTES) {
        throw protocolError('frame exceeds frame size limit');
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1);
      if (field === 'data') {
        if (!dataLines) dataLines = [];
        dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
      // id/retry/unknown fields are ignored
    }
    if (utf8Length(buffer) > MAX_FRAME_BYTES) {
      throw protocolError('line exceeds frame size limit');
    }
    return frames;
  }

  let abortHandler = null;
  if (signal) {
    abortHandler = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abortHandler, { once: true });
  }
  try {
    if (signal && signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let decoded;
      try {
        decoded = decoder.decode(value, { stream: true });
      } catch {
        throw protocolError('invalid UTF-8 in stream');
      }
      const frames = feed(decoded);
      for (const frame of frames) {
        if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        if (frame.type === 'end') {
          ended = true;
          yield frame;
          return;
        }
        yield frame;
      }
    }
    let tail;
    try {
      tail = decoder.decode();
    } catch {
      throw protocolError('stream ended with incomplete UTF-8');
    }
    if (tail) {
      const frames = feed(tail);
      for (const frame of frames) {
        if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        if (frame.type === 'end') {
          ended = true;
          yield frame;
          return;
        }
        yield frame;
      }
    }
    if (dataLines) {
      throw protocolError('stream ended with an incomplete frame');
    }
    if (!ended) {
      throw protocolError('stream ended without an end frame');
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    if (signal && signal.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    throw err;
  } finally {
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}
