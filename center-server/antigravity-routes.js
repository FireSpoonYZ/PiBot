import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_CANCEL_PATH,
  ANTIGRAVITY_MAX_FRAME_BYTES,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_STREAM_PATH,
} from '../center-contract/antigravity.js';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const STREAM_BODY_KEYS = new Set(['sessionId', 'modelId', 'messages', 'reasoning']);
const CANCEL_BODY_KEYS = new Set(['sessionId']);
const MAX_ID_LENGTH = 256;
const MAX_MESSAGES = 4096;
const MAX_MESSAGE_PARTS = 512;
const MAX_SYSTEM_TOOLS = 512;
const CATALOG_TIMEOUT_MS = 30_000;
const TOKEN_CHECK_INTERVAL_MS = 15_000;
const OPTIONAL_MODEL_FIELDS = [
  'baseUrl', 'headers', 'thinkingLevelMap', 'cost', 'compat',
  'inputLimits', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel',
];

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertBoundedId(value, name) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_ID_LENGTH ||
    !value.isWellFormed() ||
    value.trim().length === 0 ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value;
}

function assertAllowedKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail('INVALID_ARGUMENT', `Unexpected ${label} field`);
  }
}

function validateContentParts(parts, allowImage) {
  if (!Array.isArray(parts) || parts.length > MAX_MESSAGE_PARTS) {
    fail('INVALID_ARGUMENT', 'Invalid message content');
  }
  for (const part of parts) {
    if (!isPlainObject(part)) fail('INVALID_ARGUMENT', 'Invalid message content part');
    if (part.type === 'text') {
      if (typeof part.text !== 'string') fail('INVALID_ARGUMENT', 'Invalid text part');
    } else if (allowImage && part.type === 'image') {
      if (typeof part.data !== 'string' || part.data.length === 0 || typeof part.mimeType !== 'string' || !part.mimeType.trim()) {
        fail('INVALID_ARGUMENT', 'Invalid image part');
      }
    } else {
      fail('INVALID_ARGUMENT', 'Unsupported content part type');
    }
  }
}

function validateSystemMessage(msg) {
  if (typeof msg.content !== 'string') validateContentParts(msg.content, false);
  if (msg.sections !== undefined) {
    if (!isPlainObject(msg.sections)) fail('INVALID_ARGUMENT', 'Invalid system sections');
    for (const val of Object.values(msg.sections)) {
      if (val !== null && typeof val !== 'string') fail('INVALID_ARGUMENT', 'Invalid system section value');
    }
  }
  if (msg.toolsAdded !== undefined) {
    if (!Array.isArray(msg.toolsAdded) || msg.toolsAdded.length > MAX_SYSTEM_TOOLS) {
      fail('INVALID_ARGUMENT', 'Invalid toolsAdded');
    }
    for (const tool of msg.toolsAdded) {
      if (!isPlainObject(tool)) fail('INVALID_ARGUMENT', 'Invalid tool definition');
      assertBoundedId(tool.name, 'tool.name');
      if (tool.description !== undefined && typeof tool.description !== 'string') {
        fail('INVALID_ARGUMENT', 'Invalid tool.description');
      }
      if (!isPlainObject(tool.parameters)) fail('INVALID_ARGUMENT', 'Invalid tool.parameters');
    }
  }
  if (msg.toolsRemoved !== undefined) {
    if (!Array.isArray(msg.toolsRemoved) || msg.toolsRemoved.length > MAX_SYSTEM_TOOLS) {
      fail('INVALID_ARGUMENT', 'Invalid toolsRemoved');
    }
    for (const ref of msg.toolsRemoved) {
      if (!isPlainObject(ref)) fail('INVALID_ARGUMENT', 'Invalid toolsRemoved entry');
      assertBoundedId(ref.name, 'toolsRemoved.name');
    }
  }
}

function validateMessage(msg) {
  if (!isPlainObject(msg)) fail('INVALID_ARGUMENT', 'Invalid message');
  switch (msg.role) {
    case 'system':
      validateSystemMessage(msg);
      return;
    case 'user':
      if (typeof msg.content !== 'string') validateContentParts(msg.content, true);
      return;
    case 'assistant':
      if (!Array.isArray(msg.content) || msg.content.length > MAX_MESSAGE_PARTS) {
        fail('INVALID_ARGUMENT', 'Invalid assistant content');
      }
      for (const part of msg.content) {
        if (!isPlainObject(part)) fail('INVALID_ARGUMENT', 'Invalid assistant content part');
        if (part.type === 'text') {
          if (typeof part.text !== 'string') fail('INVALID_ARGUMENT', 'Invalid text part');
        } else if (part.type === 'thinking') {
          if (typeof part.thinking !== 'string') fail('INVALID_ARGUMENT', 'Invalid thinking part');
        } else if (part.type === 'toolCall') {
          assertBoundedId(part.id, 'toolCall.id');
          assertBoundedId(part.name, 'toolCall.name');
          if (!isPlainObject(part.arguments)) fail('INVALID_ARGUMENT', 'Invalid toolCall arguments');
        } else {
          fail('INVALID_ARGUMENT', 'Unsupported assistant content part');
        }
      }
      return;
    case 'toolResult':
      assertBoundedId(msg.toolCallId, 'toolCallId');
      assertBoundedId(msg.toolName, 'toolName');
      validateContentParts(msg.content, true);
      if (msg.isError !== undefined && typeof msg.isError !== 'boolean') {
        fail('INVALID_ARGUMENT', 'Invalid toolResult isError');
      }
      return;
    default:
      fail('INVALID_ARGUMENT', 'Unsupported message role');
  }
}

function validateStreamBody(raw) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', 'Expected an object');
  assertAllowedKeys(raw, STREAM_BODY_KEYS, 'request');
  const sessionId = assertBoundedId(raw.sessionId, 'sessionId');
  const modelId = assertBoundedId(raw.modelId, 'modelId');
  if (raw.reasoning !== undefined && (typeof raw.reasoning !== 'string' || !THINKING_LEVELS.has(raw.reasoning))) {
    fail('INVALID_ARGUMENT', 'Invalid reasoning level');
  }
  if (!Array.isArray(raw.messages) || raw.messages.length < 1 || raw.messages.length > MAX_MESSAGES) {
    fail('INVALID_ARGUMENT', 'Invalid messages');
  }
  for (const msg of raw.messages) validateMessage(msg);
  return {
    sessionId,
    modelId,
    messages: raw.messages,
    ...(raw.reasoning !== undefined ? { reasoning: raw.reasoning } : {}),
  };
}

function validateCancelBody(raw) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', 'Expected an object');
  assertAllowedKeys(raw, CANCEL_BODY_KEYS, 'request');
  return { sessionId: assertBoundedId(raw.sessionId, 'sessionId') };
}

function normalizeCatalogModel(item) {
  if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim() || !item.id.isWellFormed()) return null;
  const id = item.id.trim();
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
  const contextWindow = Number.isSafeInteger(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : 128_000;
  const rawMaxTokens = Number.isSafeInteger(item.maxTokens) && item.maxTokens > 0 ? item.maxTokens : 8192;
  const maxTokens = Math.min(rawMaxTokens, contextWindow);
  const rawInput = Array.isArray(item.input) ? item.input.filter(kind => kind === 'text' || kind === 'image') : [];
  const input = rawInput.includes('text') ? [...new Set(rawInput)] : ['text', ...new Set(rawInput)];
  const normalized = {
    id,
    name,
    api: typeof item.api === 'string' && item.api.trim() ? item.api.trim() : ANTIGRAVITY_API,
    contextWindow,
    maxTokens,
    input,
    reasoning: Boolean(item.reasoning),
    enabled: item.enabled !== false,
    source: item.source === 'manual' ? 'manual' : 'catalog',
  };
  for (const field of OPTIONAL_MODEL_FIELDS) {
    const val = item[field];
    if (val === undefined || val === null) continue;
    if (field === 'baseUrl' ? typeof val === 'string' : isPlainObject(val)) {
      normalized[field] = val;
    }
  }
  return normalized;
}

function safeStreamErrorEvent(modelId, error) {
  let errorMessage = 'Upstream stream failed';
  if (error?.name === 'TimeoutError' || error?.code === 'TIMEOUT') errorMessage = 'Stream timed out';
  else if (error?.code === 'UNAUTHENTICATED') errorMessage = 'Antigravity authentication required';
  else if (error?.code === 'INVALID_ARGUMENT') errorMessage = 'Invalid stream request';
  else if (error?.code === 'INVALID_STATE') errorMessage = 'Antigravity service unavailable';
  return {
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [],
      api: ANTIGRAVITY_API,
      provider: ANTIGRAVITY_PROVIDER_ID,
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error',
      errorMessage,
      timestamp: Date.now(),
    },
  };
}

function waitForDrain(res, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted || res.destroyed || res.writableEnded) {
      reject(new Error('Stream closed'));
      return;
    }
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onClose);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Stream closed')); };
    const onAbort = () => { cleanup(); reject(new Error('Stream aborted')); };
    res.on('drain', onDrain);
    res.on('close', onClose);
    res.on('error', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function nextEvent(iterator, signal) {
  if (signal.aborted) return Promise.resolve({ done: true, aborted: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      resolve({ done: true, aborted: true });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(iterator.next()).then(
      res => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(res);
      },
      err => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export function registerAntigravityRoutes({ store, bridge, catalog, host, antigravity, changed }) {
  const activeStreams = new Set();

  function assertDeviceAuthorized(deviceId, modelId) {
    const provider = store.getProvider(ANTIGRAVITY_PROVIDER_ID);
    if (!provider || !provider.enabled) fail('FORBIDDEN', 'Provider is unavailable');
    const assigned = store.listDeviceBots(deviceId).some(bot => {
      const modelRef = store.getBotModelConfig(deviceId, bot.botId).effective.modelRef;
      return modelRef?.startsWith(ANTIGRAVITY_PROVIDER_ID + '/');
    });
    if (!assigned) fail('FORBIDDEN', 'Provider is not assigned to this device');
    const model = store.listModels(ANTIGRAVITY_PROVIDER_ID).find(item => item.id === modelId && item.enabled);
    if (!model) fail('FORBIDDEN', 'Model is unavailable');
  }

  async function loadCatalogModels() {
    if (!store.getProvider(ANTIGRAVITY_PROVIDER_ID)) fail('NOT_FOUND', 'Provider not found');
    if (!antigravity) fail('INVALID_STATE', 'Antigravity service is unavailable');
    let rawModels;
    try {
      rawModels = await antigravity.catalog({ signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'TIMEOUT') {
        fail('TIMEOUT', 'Antigravity catalog timed out');
      }
      if (error?.code === 'UNAUTHENTICATED') fail('UNAUTHENTICATED', 'Antigravity authentication required');
      if (error?.code === 'INVALID_ARGUMENT') fail('INVALID_ARGUMENT', 'Invalid antigravity catalog request');
      fail('INVALID_STATE', 'Antigravity service is unavailable');
    }
    const normalized = Array.isArray(rawModels) ? rawModels.map(normalizeCatalogModel).filter(Boolean) : [];
    if (normalized.length === 0) fail('INVALID_STATE', 'Antigravity returned no models');
    return normalized;
  }

  host('POST', ANTIGRAVITY_STREAM_PATH, async (req, reply) => {
    const { deviceId, token } = req.centerDevice;
    const { sessionId, modelId, messages, reasoning } = validateStreamBody(req.body);
    assertDeviceAuthorized(deviceId, modelId);
    if (!antigravity) fail('INVALID_STATE', 'Antigravity service is unavailable');
    if (req.raw.aborted || req.raw.destroyed || reply.raw.destroyed) {
      fail('INVALID_STATE', 'Request aborted');
    }

    const controller = new AbortController();
    const eventStream = antigravity.stream(
      { deviceId, sessionId, modelId, messages, ...(reasoning !== undefined ? { reasoning } : {}) },
      { signal: controller.signal },
    );
    const iterator = eventStream?.[Symbol.asyncIterator]?.();
    if (!iterator) fail('INTERNAL_ERROR', 'Invalid stream');

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    let terminal = false;
    let clientDisconnected = false;

    const abortDisconnect = () => {
      if (terminal || clientDisconnected) return;
      clientDisconnected = true;
      controller.abort();
      void Promise.resolve(antigravity.cancel({ deviceId, sessionId })).catch(() => {});
      if (!reply.raw.destroyed) reply.raw.destroy();
    };
    const onResponseClose = () => {
      // Normal toolUse/stop completion already moved the stream to terminal; keep waiting ACP alive.
      if (!terminal) abortDisconnect();
    };
    const activeEntry = { abort: abortDisconnect };
    activeStreams.add(activeEntry);

    req.raw.on('aborted', abortDisconnect);
    reply.raw.on('close', onResponseClose);
    reply.raw.on('error', abortDisconnect);

    const authTimer = setInterval(() => {
      if (!bridge.registry.authenticate(deviceId, token)) abortDisconnect();
    }, TOKEN_CHECK_INTERVAL_MS);
    authTimer.unref?.();

    try {
      while (!clientDisconnected) {
        const step = await nextEvent(iterator, controller.signal);
        if (step.aborted || step.done) break;
        const event = step.value;
        if (event?.type === 'done' || event?.type === 'error') terminal = true;
        if (reply.raw.destroyed || reply.raw.writableEnded) break;
        const line = JSON.stringify(event) + '\n';
        if (!reply.raw.write(line) && !clientDisconnected) {
          await waitForDrain(reply.raw, controller.signal);
        }
        if (terminal) break;
      }
      if (!clientDisconnected && !terminal) terminal = true;
    } catch (error) {
      if (!clientDisconnected && !terminal) {
        void Promise.resolve(antigravity.cancel({ deviceId, sessionId })).catch(() => {});
        terminal = true;
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(JSON.stringify(safeStreamErrorEvent(modelId, error)) + '\n');
        }
      }
    } finally {
      clearInterval(authTimer);
      req.raw.off('aborted', abortDisconnect);
      reply.raw.off('close', onResponseClose);
      reply.raw.off('error', abortDisconnect);
      activeStreams.delete(activeEntry);
      if (clientDisconnected && typeof iterator.return === 'function') {
        void Promise.resolve(iterator.return()).catch(() => {});
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  }, ANTIGRAVITY_MAX_FRAME_BYTES);

  host('POST', ANTIGRAVITY_CANCEL_PATH, async req => {
    const { sessionId } = validateCancelBody(req.body);
    if (!antigravity) fail('INVALID_STATE', 'Antigravity service is unavailable');
    await antigravity.cancel({ deviceId: req.centerDevice.deviceId, sessionId });
    return { ok: true };
  });

  return {
    async validateProvider() {
      const models = await loadCatalogModels();
      return { ok: true, message: models[0].id };
    },
    async discoverModels() {
      const normalized = await loadCatalogModels();
      const models = store.putModelsBatch(ANTIGRAVITY_PROVIDER_ID, normalized);
      await catalog.apply();
      return changed({ models });
    },
    close() {
      for (const entry of [...activeStreams]) entry.abort();
      activeStreams.clear();
    },
  };
}
