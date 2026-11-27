import {
  AGY_HISTORY_CHANGED,
  ANTIGRAVITY_API,
  ANTIGRAVITY_CANCEL_PATH,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_RUN_PATH,
  ANTIGRAVITY_STEER_PATH,
  ANTIGRAVITY_TOOL_RESULT_PATH,
} from '../center-contract/antigravity.js';

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const RUN_BODY_KEYS = new Set([
  'sessionId', 'runId', 'modelId', 'reasoning', 'initialSystemPrompt',
  'tools', 'sections', 'routeNote', 'inputs',
]);
const TOOL_RESULT_BODY_KEYS = new Set(['sessionId', 'runId', 'callId', 'content', 'isError']);
const STEER_BODY_KEYS = new Set(['sessionId', 'runId', 'sections', 'routeNote', 'inputs']);
const CANCEL_BODY_KEYS = new Set(['sessionId', 'runId']);
const SECTION_KEYS = new Set(['key', 'value']);
const INPUT_KEYS = new Set(['text', 'images', 'source']);
const IMAGE_KEYS = new Set(['data', 'mimeType']);
const MAX_ID_LENGTH = 256;
const MAX_MESSAGE_PARTS = 512;
const MAX_TOOLS = 512;
const MAX_SECTIONS = 512;
const MAX_INPUTS = 512;
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

function validateContentParts(parts) {
  if (!Array.isArray(parts) || parts.length > MAX_MESSAGE_PARTS) {
    fail('INVALID_ARGUMENT', 'Invalid tool result content');
  }
  const normalized = [];
  for (const part of parts) {
    if (!isPlainObject(part)) fail('INVALID_ARGUMENT', 'Invalid content part');
    if (part.type === 'text') {
      if (typeof part.text !== 'string') fail('INVALID_ARGUMENT', 'Invalid text part');
      normalized.push({ type: 'text', text: part.text });
    } else if (part.type === 'image') {
      if (
        typeof part.data !== 'string' ||
        part.data.length === 0 ||
        typeof part.mimeType !== 'string' ||
        !part.mimeType.trim()
      ) {
        fail('INVALID_ARGUMENT', 'Invalid image part');
      }
      normalized.push({ type: 'image', data: part.data, mimeType: part.mimeType });
    } else {
      fail('INVALID_ARGUMENT', 'Unsupported content part type');
    }
  }
  return normalized;
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length > MAX_MESSAGE_PARTS) {
    fail('INVALID_ARGUMENT', 'Invalid images');
  }
  const normalized = [];
  for (const image of images) {
    if (!isPlainObject(image)) fail('INVALID_ARGUMENT', 'Invalid image');
    assertAllowedKeys(image, IMAGE_KEYS, 'image');
    if (
      typeof image.data !== 'string' ||
      image.data.length === 0 ||
      typeof image.mimeType !== 'string' ||
      !image.mimeType.trim()
    ) {
      fail('INVALID_ARGUMENT', 'Invalid image');
    }
    normalized.push({ data: image.data, mimeType: image.mimeType });
  }
  return normalized;
}

function validateTools(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    fail('INVALID_ARGUMENT', 'Invalid tools');
  }
  const normalized = [];
  for (const tool of tools) {
    if (!isPlainObject(tool)) fail('INVALID_ARGUMENT', 'Invalid tool definition');
    const name = assertBoundedId(tool.name, 'tool.name');
    if (tool.description !== undefined && typeof tool.description !== 'string') {
      fail('INVALID_ARGUMENT', 'Invalid tool.description');
    }
    if (!isPlainObject(tool.parameters)) fail('INVALID_ARGUMENT', 'Invalid tool.parameters');
    normalized.push({
      name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.parameters,
    });
  }
  return normalized;
}

function validateSections(sections) {
  if (!Array.isArray(sections) || sections.length > MAX_SECTIONS) {
    fail('INVALID_ARGUMENT', 'Invalid sections');
  }
  const normalized = [];
  for (const section of sections) {
    if (!isPlainObject(section)) fail('INVALID_ARGUMENT', 'Invalid section');
    assertAllowedKeys(section, SECTION_KEYS, 'section');
    const key = assertBoundedId(section.key, 'section.key');
    if (section.value !== null && typeof section.value !== 'string') {
      fail('INVALID_ARGUMENT', 'Invalid section.value');
    }
    normalized.push({ key, value: section.value });
  }
  return normalized;
}

function validateInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_INPUTS) {
    fail('INVALID_ARGUMENT', 'Invalid inputs');
  }
  const normalized = [];
  for (const item of inputs) {
    if (!isPlainObject(item)) fail('INVALID_ARGUMENT', 'Invalid input item');
    assertAllowedKeys(item, INPUT_KEYS, 'input');
    if (typeof item.text !== 'string') fail('INVALID_ARGUMENT', 'Invalid input text');
    const images = item.images !== undefined ? validateImages(item.images) : undefined;
    if (item.source !== undefined && typeof item.source !== 'string') {
      fail('INVALID_ARGUMENT', 'Invalid input source');
    }
    normalized.push({
      text: item.text,
      ...(images !== undefined ? { images } : {}),
      ...(item.source !== undefined ? { source: item.source } : {}),
    });
  }
  return normalized;
}

function validateRunBody(raw) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', 'Expected an object');
  assertAllowedKeys(raw, RUN_BODY_KEYS, 'request');
  const sessionId = assertBoundedId(raw.sessionId, 'sessionId');
  const runId = assertBoundedId(raw.runId, 'runId');
  const modelId = assertBoundedId(raw.modelId, 'modelId');
  if (raw.reasoning !== undefined && (typeof raw.reasoning !== 'string' || !THINKING_LEVELS.has(raw.reasoning))) {
    fail('INVALID_ARGUMENT', 'Invalid reasoning level');
  }
  if (raw.initialSystemPrompt !== undefined && typeof raw.initialSystemPrompt !== 'string') {
    fail('INVALID_ARGUMENT', 'Invalid initialSystemPrompt');
  }
  const tools = validateTools(raw.tools);
  const sections = raw.sections !== undefined ? validateSections(raw.sections) : undefined;
  if (raw.routeNote !== undefined && typeof raw.routeNote !== 'string') {
    fail('INVALID_ARGUMENT', 'Invalid routeNote');
  }
  const inputs = validateInputs(raw.inputs);
  return {
    sessionId,
    runId,
    modelId,
    ...(raw.reasoning !== undefined ? { reasoning: raw.reasoning } : {}),
    ...(raw.initialSystemPrompt !== undefined ? { initialSystemPrompt: raw.initialSystemPrompt } : {}),
    tools,
    ...(sections !== undefined ? { sections } : {}),
    ...(raw.routeNote !== undefined ? { routeNote: raw.routeNote } : {}),
    inputs,
  };
}

function validateToolResultBody(raw) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', 'Expected an object');
  assertAllowedKeys(raw, TOOL_RESULT_BODY_KEYS, 'request');
  const sessionId = assertBoundedId(raw.sessionId, 'sessionId');
  const runId = assertBoundedId(raw.runId, 'runId');
  const callId = assertBoundedId(raw.callId, 'callId');
  const content = validateContentParts(raw.content);
  if (raw.isError !== undefined && typeof raw.isError !== 'boolean') {
    fail('INVALID_ARGUMENT', 'Invalid isError');
  }
  return {
    sessionId,
    runId,
    callId,
    content,
    ...(raw.isError !== undefined ? { isError: raw.isError } : {}),
  };
}

function validateSteerBody(raw) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', 'Expected an object');
  assertAllowedKeys(raw, STEER_BODY_KEYS, 'request');
  const sessionId = assertBoundedId(raw.sessionId, 'sessionId');
  const runId = assertBoundedId(raw.runId, 'runId');
  const sections = raw.sections !== undefined ? validateSections(raw.sections) : undefined;
  if (raw.routeNote !== undefined && typeof raw.routeNote !== 'string') {
    fail('INVALID_ARGUMENT', 'Invalid routeNote');
  }
  const inputs = validateInputs(raw.inputs);
  return {
    sessionId,
    runId,
    ...(sections !== undefined ? { sections } : {}),
    ...(raw.routeNote !== undefined ? { routeNote: raw.routeNote } : {}),
    inputs,
  };
}

function validateCancelBody(raw) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', 'Expected an object');
  assertAllowedKeys(raw, CANCEL_BODY_KEYS, 'request');
  return {
    sessionId: assertBoundedId(raw.sessionId, 'sessionId'),
    ...(raw.runId !== undefined ? { runId: assertBoundedId(raw.runId, 'runId') } : {}),
  };
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

function safeRunErrorEvent(error) {
  if (error?.code === AGY_HISTORY_CHANGED) {
    return { type: 'error', code: AGY_HISTORY_CHANGED, message: 'Antigravity session requires /clear before continuing' };
  }
  if (error?.name === 'TimeoutError' || error?.code === 'TIMEOUT') {
    return { type: 'error', code: 'TIMEOUT', message: 'Stream timed out' };
  }
  if (error?.code === 'UNAUTHENTICATED') {
    return { type: 'error', code: 'UNAUTHENTICATED', message: 'Antigravity authentication required' };
  }
  if (error?.code === 'INVALID_ARGUMENT') {
    return { type: 'error', code: 'INVALID_ARGUMENT', message: 'Invalid run request' };
  }
  if (error?.code === 'INVALID_STATE') {
    return { type: 'error', code: 'INVALID_STATE', message: 'Antigravity service unavailable' };
  }
  if (error?.name === 'AbortError') {
    return { type: 'error', message: 'Operation aborted', aborted: true };
  }
  return { type: 'error', message: 'Upstream stream failed' };
}

function rethrowInvalidStateAs409(error, fallbackMessage) {
  if (error?.code === 'INVALID_STATE') {
    throw Object.assign(new Error(fallbackMessage), { code: 'INVALID_STATE', statusCode: 409 });
  }
  throw error;
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

  host('POST', ANTIGRAVITY_RUN_PATH, async (req, reply) => {
    const { deviceId, token } = req.centerDevice;
    const {
      sessionId, runId, modelId, reasoning, initialSystemPrompt,
      tools, sections, routeNote, inputs,
    } = validateRunBody(req.body);
    assertDeviceAuthorized(deviceId, modelId);
    if (!antigravity) fail('INVALID_STATE', 'Antigravity service is unavailable');
    if (req.raw.aborted || req.raw.destroyed || reply.raw.destroyed) {
      fail('INVALID_STATE', 'Request aborted');
    }

    const controller = new AbortController();
    const eventStream = antigravity.run(
      {
        deviceId,
        sessionId,
        runId,
        modelId,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(initialSystemPrompt !== undefined ? { initialSystemPrompt } : {}),
        tools,
        ...(sections !== undefined ? { sections } : {}),
        ...(routeNote !== undefined ? { routeNote } : {}),
        inputs,
      },
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
    const cancelTarget = { deviceId, sessionId, runId };

    const abortDisconnect = () => {
      if (terminal || clientDisconnected) return;
      clientDisconnected = true;
      controller.abort();
      void Promise.resolve(antigravity.cancel?.(cancelTarget)).catch(() => {});
      if (!reply.raw.destroyed) reply.raw.destroy();
    };
    const onResponseClose = () => {
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
        if (event?.type === 'turn_done' || event?.type === 'error') terminal = true;
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
        void Promise.resolve(antigravity.cancel?.(cancelTarget)).catch(() => {});
        terminal = true;
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(JSON.stringify(safeRunErrorEvent(error)) + '\n');
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
  }, Number.MAX_SAFE_INTEGER);

  host('POST', ANTIGRAVITY_TOOL_RESULT_PATH, async req => {
    const { sessionId, runId, callId, content, isError } = validateToolResultBody(req.body);
    if (!antigravity) fail('INVALID_STATE', 'Antigravity service is unavailable');
    try {
      await antigravity.submitToolResult({
        deviceId: req.centerDevice.deviceId,
        sessionId,
        runId,
        callId,
        content,
        ...(isError !== undefined ? { isError } : {}),
      });
    } catch (error) {
      rethrowInvalidStateAs409(error, 'Active Antigravity run or tool call is unavailable');
    }
    return { ok: true };
  }, Number.MAX_SAFE_INTEGER);

  host('POST', ANTIGRAVITY_STEER_PATH, async req => {
    const { sessionId, runId, sections, routeNote, inputs } = validateSteerBody(req.body);
    if (!antigravity) fail('INVALID_STATE', 'Antigravity service is unavailable');
    try {
      await antigravity.steer({
        deviceId: req.centerDevice.deviceId,
        sessionId,
        runId,
        ...(sections !== undefined ? { sections } : {}),
        ...(routeNote !== undefined ? { routeNote } : {}),
        inputs,
      });
    } catch (error) {
      rethrowInvalidStateAs409(error, 'Active Antigravity run has already ended');
    }
    return { ok: true };
  }, Number.MAX_SAFE_INTEGER);

  host('POST', ANTIGRAVITY_CANCEL_PATH, async req => {
    const { sessionId, runId } = validateCancelBody(req.body);
    if (!antigravity) fail('INVALID_STATE', 'Antigravity service is unavailable');
    await antigravity.cancel({
      deviceId: req.centerDevice.deviceId,
      sessionId,
      ...(runId !== undefined ? { runId } : {}),
    });
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
