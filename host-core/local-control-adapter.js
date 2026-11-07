// host-core/local-control-adapter.js
// Module 9: authenticated target-local loopback Host control adapter. Talks
// only to the local control server via createControlClient over a bounded
// fetch; never opens Runtime, files, or other local state. All errors carry a
// fixed .code and .outcome (not-sent / unconfirmed / responded).
import { createControlClient, ControlApiError } from './control-client.js';
import { assertId } from './message-protocol.js';
import {
  MAX_CONTROL_JSON_BYTES,
  normalizeControlCall,
} from './remote-control-protocol.js';
import { normalizeLiveTarget } from './remote-live-protocol.js';
import { SHOWER_ERROR_CODES } from './shower-protocol.js';
import { VAULT_ERROR_CODES } from './vault-protocol.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);

// Local domain codes the control server may return; forwarded unchanged with
// outcome responded. Everything else (transport/protocol) is mapped below.
const LOCAL_DOMAIN_CODES = new Set([
  'CENTER_OFFLINE',
  'INVALID_ARGUMENT',
  'INVALID_CWD',
  'REQUEST_CONFLICT',
  'BOT_NOT_FOUND',
  'BOT_REQUEST_NOT_FOUND',
  'SUBMISSION_NOT_FOUND',
  'MODEL_REQUIRED',
  'MODEL_NOT_FOUND',
  'COMPACTION_FAILED',
  'RUNTIME_BUSY',
  'PRIMARY_BOT_PROTECTED',
  'BOT_ARCHIVED',
  'INVALID_STATE',
  'UNSUPPORTED_SCHEMA',
  'INTERNAL',
  'REQUEST_TOO_LARGE',
  'RESPONSE_TOO_LARGE',
  'INVALID_UTF8',
  'INVALID_JSON',
  'INVALID_BODY',
  'UNSUPPORTED_MEDIA_TYPE',
  'UNAUTHORIZED',
  'ORIGIN_FORBIDDEN',
  'CONTROL_UNAVAILABLE',
  'SCOPE_NOT_FOUND',
  'SCOPE_FORBIDDEN',
  'SCOPE_UNMANAGED',
  'SCOPE_AUTHORITY_REQUIRED',
  'WORK_CONTEXT_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'DELIVERY_NOT_FOUND',
  'STORE_FAILED',
  'STALE_INPUT',
  'WORK_STOPPED',
  'WORK_CONTEXT_INACTIVE',
  'CONTEXT_LIMIT',
  'WORK_GENERATION_FAILED',
  'HINDSIGHT_NOT_CONFIGURED',
  'HINDSIGHT_SHARED_DISABLED',
  'HINDSIGHT_CLOSED',
  'HINDSIGHT_UNAVAILABLE',
  'HINDSIGHT_AUTH_FAILED',
  'HINDSIGHT_NOT_FOUND',
  'HINDSIGHT_CONFLICT',
  'HINDSIGHT_INVALID_REQUEST',
  'HINDSIGHT_PROTOCOL_ERROR',
  'HINDSIGHT_STORE_FAILED',
  'HINDSIGHT_BINDING_MISMATCH',
  'EXTENSION_DISABLED',
  'EXTENSION_READ_ONLY',
  'ATTACHMENT_NOT_FOUND',
  'MODEL_NO_VISION',
  ...SHOWER_ERROR_CODES,
  ...VAULT_ERROR_CODES,
]);

function controlError(code, outcome) {
  const err = new Error(`local host control ${code.toLowerCase().replace(/_/g, ' ')} (${outcome})`);
  err.name = 'LocalControlError';
  err.code = code;
  err.outcome = outcome;
  return err;
}

/**
 * Synchronous config validation only; no network, files, or sockets here.
 * url must be plain loopback http with path exactly /, no userinfo/query/
 * fragment; token must be a URL-safe opaque string of 32-512 characters.
 */
function validateOptions(options) {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('createLocalControlAdapter: options must be an object');
  }
  const hasUrl = Object.prototype.hasOwnProperty.call(options, 'url');
  const hasToken = Object.prototype.hasOwnProperty.call(options, 'token');
  if (Object.keys(options).length !== 2 || !hasUrl || !hasToken) {
    throw new TypeError('createLocalControlAdapter: options must be exactly own { url, token }');
  }
  const { url: rawUrl, token } = options;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new TypeError('createLocalControlAdapter: token must be a URL-safe string of 32-512 characters');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TypeError('createLocalControlAdapter: url must be a valid http URL');
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new TypeError('createLocalControlAdapter: url must be http://127.0.0.1 or http://[::1]');
  }
  if (url.pathname !== '/') {
    throw new TypeError('createLocalControlAdapter: url path must be exactly /');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('createLocalControlAdapter: url must not contain user info');
  }
  if (url.search !== '') {
    throw new TypeError('createLocalControlAdapter: url must not contain a query string');
  }
  if (url.hash !== '') {
    throw new TypeError('createLocalControlAdapter: url must not contain a fragment');
  }
  return { url: rawUrl, token };
}

function abortReason(signal) {
  if (signal && signal.reason !== undefined) return signal.reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Bounded fetch: rejects redirects, and reads the response body with a real
 * <=MAX_CONTROL_JSON_BYTES byte cap. On excess, marks state.tooLarge, cancels the reader, and
 * throws with no partial body, so the caller's state check maps it to
 * RESPONSE_TOO_LARGE (ControlClient would otherwise report NETWORK/BAD_RESPONSE).
 * Normal bounded bodies are returned as a fresh Response built from the bytes.
 */
function boundedFetch(state, options = {}) {
  return async function fetchBounded(input, init = {}) {
    const signal = init.signal;
    const response = await globalThis.fetch(input, { ...init, redirect: 'error' });
    // 仅当请求本身是 SSE（Accept=text/event-stream）且响应 ok+SSE 时透传原始
    // Response 给 SSE parser；JSON preflight 不论 content-type 都按 MAX_CONTROL_JSON_BYTES 读取。
    const acceptHeader = init.headers && (init.headers.Accept ?? init.headers.accept);
    const wantsSse = options.sseOk && acceptHeader === 'text/event-stream';
    if (
      wantsSse &&
      response.ok &&
      (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() ===
        'text/event-stream'
    ) {
      return response;
    }
    if (!response.body) return response; // 204/HEAD: no body to bound
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        if (signal && signal.aborted) throw abortReason(signal);
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_CONTROL_JSON_BYTES) {
          state.tooLarge = true;
          await reader.cancel();
          throw new Error('host control response exceeds size limit');
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
    const body = chunks.length === 0 ? null : concatChunks(chunks, size);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pageOptions(params, signal) {
  const options = { signal };
  if (params.limit != null) options.limit = params.limit;
  if (params.cursor != null) options.cursor = params.cursor;
  return options;
}

// Unified Shower control calls take the Runtime target object plus the HTTP
// options arg last; the flat wire params are split into target/sessionId here.
function showerTarget(params) {
  return params.scopeId === undefined
    ? { botId: params.botId }
    : { botId: params.botId, scopeId: params.scopeId };
}

// Exact mapping to the native ControlClient surface; only method 'abort'
// calls the local abort API. getHostInfo is handled separately after identity
// verification. Map avoids inherited prototype keys being treated as methods.
const METHOD_HANDLERS = new Map([
  ['getServiceStatus', (control, params, signal) => control.getServiceStatus({ signal })],
  ['listBots', (control, params, signal) => control.listBots({ signal })],
  ['createBot', (control, params, signal) => control.createBot(params, { signal })],
  ['updateBotProfile', (control, params, signal) => control.updateBotProfile(params, { signal })],
  ['setPrimaryBot', (control, params, signal) => control.setPrimaryBot(params.botId, { signal })],
  ['archiveBot', (control, params, signal) => control.archiveBot(params.botId, { signal })],
  ['unarchiveBot', (control, params, signal) => control.unarchiveBot(params.botId, { signal })],
  ['deleteBot', (control, params, signal) => control.deleteBot(params.botId, { signal })],
  ['getBot', (control, params, signal) => control.getBot(params.botId, { signal })],
  ['findByRequest', (control, params, signal) => control.findByRequest(params.requestId, { signal })],
  ['submit', (control, params, signal) =>
    control.submit(
      params.botId,
      {
        requestId: params.requestId,
        text: params.text,
        ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
      },
      { signal },
    )],
  ['uploadAttachment', (control, params, signal) =>
    control.uploadAttachment(
      params.botId,
      { name: params.name, mimeType: params.mimeType, data: params.data },
      { signal },
    )],
  ['putBotFileChunk', (control, { botId, ...input }, signal) =>
    control.putBotFileChunk(botId, input, { signal })],
  ['getAttachment', (control, params, signal) =>
    control.getAttachment(params.botId, params.attachmentId, { signal })],
  ['getSubmission', (control, params, signal) =>
    control.getSubmission(params.botId, params.requestId, { signal })],
  ['history', (control, params, signal) => control.history(params.botId, { ...pageOptions(params, signal), chunked: params.chunked })],
  ['abort', (control, params, signal) => control.abort(params.botId, { signal })],
  ['clearHistory', (control, params, signal) => control.clearHistory(params.botId, { signal })],
  ['compact', (control, params, signal) => control.compact(params.botId, { signal })],
  ['contextStatus', (control, params, signal) => control.contextStatus(params.botId, { signal })],
  ['getModelCatalog', (control, params, signal) => control.getModelCatalog({ signal })],
  ['getWorkContext', (control, params, signal) => control.getWorkContext(params.botId, params.scopeId, { signal })],
  ['syncWorkContext', (control, params, signal) =>
    control.syncWorkContext(params.botId, params.scopeId, params.input ?? {}, { signal })],
  ['workHistory', (control, params, signal) =>
    control.workHistory(params.botId, params.scopeId, pageOptions(params, signal))],
  ['workContextStatus', (control, params, signal) => control.workContextStatus(params.botId, params.scopeId, { signal })],
  ['getWorkActivity', (control, params, signal) => control.getWorkActivity(params.botId, params.scopeId, { signal })],
  ['stopWork', (control, params, signal) => control.stopWork(params.botId, params.scopeId, { signal })],
  ['resumeWork', (control, params, signal) => control.resumeWork(params.botId, params.scopeId, { signal })],
  ['listScopeStates', (control, params, signal) => control.listScopeStates(pageOptions(params, signal))],
  ['createScope', (control, params, signal) => control.createScope(params.input, { signal })],
  ['getScopeState', (control, params, signal) => control.getScopeState(params.scopeId, { signal })],
  ['updateScope', (control, params, signal) => control.updateScope(params.scopeId, params.input, { signal })],
  ['deleteScope', (control, params, signal) => control.deleteScope(params.scopeId, params.input, { signal })],
  ['publishUserMessage', (control, params, signal) =>
    control.publishUserMessage(params.scopeId, params.input, { signal })],
  ['listScopeReplicas', (control, params, signal) =>
    control.listScopeReplicas(params.scopeId, pageOptions(params, signal))],
  ['scopeHistory', (control, params, signal) =>
    control.scopeHistory(params.scopeId, {
      ...pageOptions(params, signal),
      ...(params.order !== undefined ? { order: params.order } : {}),
    })],
  ['getScopeMessage', (control, params, signal) => control.getScopeMessage(params.scopeId, params.messageId, { signal })],
  ['getScopeMessageDelivery', (control, params, signal) =>
    control.getScopeMessageDelivery(params.scopeId, params.messageId, { signal })],
  ['memoryStatus', (control, params, signal) => control.memoryStatus(params.botId, params.input ?? {}, { signal })],
  ['recallMemory', (control, params, signal) => control.recallMemory(params.botId, params.input, { signal })],
  ['reflectMemory', (control, params, signal) => control.reflectMemory(params.botId, params.input, { signal })],
  ['retainMemory', (control, params, signal) => control.retainMemory(params.botId, params.input, { signal })],
  ['getMemory', (control, params, signal) => control.getMemory(params.botId, params.input, { signal })],
  ['getMemorySource', (control, params, signal) => control.getMemorySource(params.botId, params.input, { signal })],
  ['correctMemory', (control, params, signal) => control.correctMemory(params.botId, params.input, { signal })],
  ['retryMemory', (control, params, signal) => control.retryMemory(params.botId, params.input, { signal })],
  ['getBotSoul', (control, params, signal) => control.getBotSoul(params.botId, { signal })],
  ['setBotSoul', (control, params, signal) => control.setBotSoul(params.botId, params.input, { signal })],
  ['manageBotLearning', (control, params, signal) => control.manageBotLearning(params.botId, params.input, { signal })],
  ['scheduleTask', (control, params, signal) => control.scheduleTask(params.botId, params.input, { signal })],
  ['discoverProviderModels', (control, params, signal) => control.discoverProviderModels(params.input, { signal })],
  ['validateCenterProvider', (control, params, signal) => control.validateCenterProvider(params, { signal })],
  ['discoverCenterProviderModels', (control, params, signal) => control.discoverCenterProviderModels(params, { signal })],
  ['callCapabilityAction', (control, params, signal) => control.callCapabilityAction(params, { signal })],
  ['vaultControl', (control, params, signal) => control.vaultControl(params, { signal })],
  ['getShowerStatus', (control, params, signal) => control.getShowerStatus(showerTarget(params), { signal })],
  ['createShowerSession', (control, params, signal) =>
    control.createShowerSession(showerTarget(params), params.input ?? {}, { signal })],
  ['getShowerFrame', (control, params, signal) =>
    control.getShowerFrame(showerTarget(params), params.sessionId, params.limits ?? {}, { signal })],
  ['sendShowerInput', (control, params, signal) =>
    control.sendShowerInput(showerTarget(params), params.sessionId, params.input, { signal })],
  ['takeoverShower', (control, params, signal) =>
    control.takeoverShower(showerTarget(params), params.sessionId, { signal })],
  ['releaseShowerSession', (control, params, signal) =>
    control.releaseShowerSession(showerTarget(params), params.sessionId, { signal })],
]);

function requireValidId(value) {
  try {
    assertId(value, 'expectedDeviceId');
  } catch {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
}

// Preflight only verifies identity; nothing requested was dispatched, so every
// preflight failure is not-sent.
function preflightError(err, state, signal) {
  if (signal && signal.aborted) return controlError('CANCELLED', 'not-sent');
  if (state.tooLarge) return controlError('RESPONSE_TOO_LARGE', 'not-sent');
  if (err instanceof ControlApiError) {
    if (err.code === 'UNAUTHORIZED') return controlError('CONTROL_UNAUTHORIZED', 'not-sent');
    if (err.code === 'NETWORK' || err.code === 'BAD_RESPONSE') {
      return controlError('CONTROL_UNAVAILABLE', 'not-sent');
    }
  }
  return controlError('CONTROL_UNAVAILABLE', 'not-sent');
}

// Actual method dispatch has begun: transport failures are unconfirmed, and
// known local domain codes are forwarded as responded. Too-large responses are
// responded once dispatched (the host did answer).
function dispatchError(err, state, signal) {
  if (state.tooLarge) return controlError('RESPONSE_TOO_LARGE', 'responded');
  if (signal && signal.aborted) return controlError('CANCELLED', 'unconfirmed');
  if (err instanceof ControlApiError) {
    if (err.code === 'NETWORK') return controlError('NETWORK', 'unconfirmed');
    if (err.code === 'BAD_RESPONSE') return controlError('BAD_RESPONSE', 'unconfirmed');
    if (LOCAL_DOMAIN_CODES.has(err.code)) return controlError(err.code, 'responded');
  }
  return controlError('INTERNAL', 'unconfirmed');
}

async function executeCall(config, expectedDeviceId, method, params, { signal } = {}) {
  requireValidId(expectedDeviceId);
  // 先按协议表规范化（含方法参数形状/未知键/JSON 字节限制）再映射。
  let normalized;
  try {
    normalized = normalizeControlCall(method, params);
  } catch (err) {
    const code = err && err.code === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_ARGUMENT';
    throw controlError(code, 'not-sent');
  }
  method = normalized.method;
  params = normalized.params;
  const handler = METHOD_HANDLERS.get(method);

  // Per-call state + client: concurrent execute() calls must not share the
  // tooLarge flag. Preflight and dispatch of one call share the same signal.
  const state = { tooLarge: false };
  const control = createControlClient({
    url: config.url,
    token: config.token,
    fetch: boundedFetch(state),
  });

  let info;
  try {
    info = await control.getHostInfo({ signal });
  } catch (err) {
    throw preflightError(err, state, signal);
  }
  if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'not-sent');
  if (info === null || typeof info !== 'object' || info.deviceId !== expectedDeviceId) {
    throw controlError('CONTROL_IDENTITY_MISMATCH', 'not-sent');
  }
  if (method === 'getHostInfo') return info;

  try {
    const result = await handler(control, params, signal);
    if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'responded');
    return result;
  } catch (err) {
    throw dispatchError(err, state, signal);
  }
}

/**
 * 本机 SSE 观察：先 bounded getHostInfo 身份 preflight，再按 target kind 选择
 * control.live / control.workLive。流请求经 boundedFetch(sseOk) 仅在 200 +
 * text/event-stream 时透传原始 Response，其余响应（含 JSON 错误）仍有界读取；
 * 始终 redirect:error。返回 AsyncIterable，帧为 snapshot/update/end。
 */
async function* live(config, expectedDeviceId, target, { signal } = {}) {
  requireValidId(expectedDeviceId);
  let normTarget;
  try {
    normTarget = normalizeLiveTarget(target);
  } catch {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
  const state = { tooLarge: false };
  const control = createControlClient({
    url: config.url,
    token: config.token,
    fetch: boundedFetch(state, { sseOk: true }),
  });
  let info;
  try {
    info = await control.getHostInfo({ signal });
  } catch (err) {
    throw preflightError(err, state, signal);
  }
  if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'not-sent');
  if (info === null || typeof info !== 'object' || info.deviceId !== expectedDeviceId) {
    throw controlError('CONTROL_IDENTITY_MISMATCH', 'not-sent');
  }
  const iter =
    normTarget.kind === 'work'
      ? control.workLive(normTarget.botId, normTarget.scopeId, { signal })
      : control.live(normTarget.botId, { signal });
  try {
    for await (const frame of iter) yield frame;
  } catch (err) {
    throw dispatchError(err, state, signal);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyWellFormedString(value) {
  return typeof value === 'string' && value.isWellFormed() && value.trim() !== '';
}

function validateHostInfo(info) {
  if (
    !isPlainObject(info) ||
    Object.keys(info).length !== 6 ||
    info.protocolVersion !== 1 ||
    !isNonEmptyWellFormedString(info.deviceId) ||
    !isNonEmptyWellFormedString(info.defaultWorkspace) ||
    !isNonEmptyWellFormedString(info.displayName) ||
    !isNonEmptyWellFormedString(info.platform) ||
    !isNonEmptyWellFormedString(info.arch)
  ) {
    throw controlError('BAD_RESPONSE', 'responded');
  }
  try {
    assertId(info.deviceId, 'deviceId');
  } catch {
    throw controlError('BAD_RESPONSE', 'responded');
  }
  return {
    protocolVersion: 1,
    deviceId: info.deviceId,
    defaultWorkspace: info.defaultWorkspace,
    displayName: info.displayName,
    platform: info.platform,
    arch: info.arch,
  };
}

function validateSettingsUpdateInput(input) {
  if (!isPlainObject(input)) {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('expectedRevision') || !keys.includes('settings')) {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
  if (!isPlainObject(input.settings)) {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
  const normalized = { expectedRevision: input.expectedRevision, settings: input.settings };
  let json;
  try {
    json = JSON.stringify(normalized);
  } catch {
    throw controlError('INVALID_ARGUMENT', 'not-sent');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_CONTROL_JSON_BYTES) {
    throw controlError('REQUEST_TOO_LARGE', 'not-sent');
  }
  return normalized;
}

async function fetchHostInfo(config, { signal } = {}) {
  const state = { tooLarge: false };
  const control = createControlClient({
    url: config.url,
    token: config.token,
    fetch: boundedFetch(state),
  });
  let info;
  try {
    info = await control.getHostInfo({ signal });
  } catch (err) {
    throw preflightError(err, state, signal);
  }
  if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'not-sent');
  return validateHostInfo(info);
}

async function executeLocalEndpoint(config, expectedDeviceId, invoke, { signal } = {}) {
  const state = { tooLarge: false };
  const control = createControlClient({
    url: config.url,
    token: config.token,
    fetch: boundedFetch(state),
  });
  let info;
  try {
    info = await control.getHostInfo({ signal });
  } catch (err) {
    throw preflightError(err, state, signal);
  }
  if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'not-sent');
  if (info === null || typeof info !== 'object' || info.deviceId !== expectedDeviceId) {
    throw controlError('CONTROL_IDENTITY_MISMATCH', 'not-sent');
  }
  try {
    const result = await invoke(control, signal);
    if (state.tooLarge) throw controlError('RESPONSE_TOO_LARGE', 'responded');
    return result;
  } catch (err) {
    throw dispatchError(err, state, signal);
  }
}

async function getSettings(config, expectedDeviceId, callOptions = {}) {
  requireValidId(expectedDeviceId);
  return executeLocalEndpoint(
    config,
    expectedDeviceId,
    (control, signal) => control.getLocalSettings({ signal }),
    callOptions,
  );
}

async function setSettings(config, expectedDeviceId, input, callOptions = {}) {
  requireValidId(expectedDeviceId);
  const normalized = validateSettingsUpdateInput(input);
  return executeLocalEndpoint(
    config,
    expectedDeviceId,
    (control, signal) => control.replaceLocalSettings(normalized, { signal }),
    callOptions,
  );
}

async function getServiceStatus(config, expectedDeviceId, callOptions = {}) {
  requireValidId(expectedDeviceId);
  return executeLocalEndpoint(
    config,
    expectedDeviceId,
    (control, signal) => control.getServiceStatus({ signal }),
    callOptions,
  );
}

export function createLocalControlAdapter(options) {
  const config = validateOptions(options);
  const execute = async function execute(expectedDeviceId, method, params, callOptions = {}) {
    return executeCall(config, expectedDeviceId, method, params, callOptions);
  };
  execute.live = (expectedDeviceId, target, liveOptions = {}) =>
    live(config, expectedDeviceId, target, liveOptions);
  execute.getHostInfo = (callOptions = {}) => fetchHostInfo(config, callOptions);
  execute.getSettings = (expectedDeviceId, callOptions = {}) =>
    getSettings(config, expectedDeviceId, callOptions);
  execute.setSettings = (expectedDeviceId, input, callOptions = {}) =>
    setSettings(config, expectedDeviceId, input, callOptions);
  execute.getServiceStatus = (expectedDeviceId, callOptions = {}) =>
    getServiceStatus(config, expectedDeviceId, callOptions);
  return execute;
}
