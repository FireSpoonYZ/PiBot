// Center server handlers for slim daily management & observability operations
// merged into the `center` domain:
// 1. `center_set_client_release_published`: toggles only the `published` boolean
//    of an already-signed, already-uploaded client release by reusing the existing
//    handler exported by `center-server/client-releases.js` (via `deps.owner` or
//    direct `deps.setReleasePublished` callback). Never uploads artifacts, edits
//    signatures/metadata, or reads signing keys.
// 2. `center_get_host_info`, `center_get_host_service_status`, `center_get_bot_board`:
//    typed read-only Host queries over the fixed Host Bridge (`getHostInfo`,
//    `getServiceStatus`, `getBotBoard`), stripping credentials/internal environment
//    (such as `defaultWorkspace`, `control.url`, `center.centerUrl`) and never
//    exporting primary conversation history.

import { normalizeControlCall } from '../../host-core/remote-control-protocol.js';

const CENTER_READ_SCOPE = 'pibot:center:read';
const CENTER_WRITE_SCOPE = 'pibot:center:write';
const RESERVED_DEVICE_PREFIX = 'center-';

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const DIAGNOSTIC_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g;
const BOARD_CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const MAX_ID_LEN = 128;
const MAX_BOT_BOARD_IDS = 64;

const FIXED_HOST_METHODS = new Set([
  'getHostInfo',
  'getServiceStatus',
  'getBotBoard',
]);

const SERVICE_PHASES = new Set(['starting', 'running', 'closing', 'closed']);
const RELAY_PHASES = new Set(['connecting', 'online', 'backoff', 'blocked', 'closed']);
const CENTER_STATES = new Set(['disconnected', 'connecting', 'ready']);
const BOT_ACTIVITY_PHASES = new Set([
  'idle',
  'queued',
  'preparing',
  'running',
  'compacting',
  'interrupting',
  'stopping',
  'stopped',
  'failed',
]);
const BOT_ACTIVITY_SOURCES = new Set(['primary', 'room', 'dm', 'background']);

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const FORBIDDEN_INPUT_KEYS = new Set([
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'devicetoken',
  'device_token',
  'authorization',
  'cookie',
  'cookies',
  'password',
  'passphrase',
  'secret',
  'clientsecret',
  'client_secret',
  'apikey',
  'api_key',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'signingkey',
  'signing_key',
  'key',
  'artifact',
  'file',
  'filename',
  'signature',
  'sha256',
  'size',
  'notes',
  'sourcecommit',
  'source_commit',
  'metadata',
  'history',
  'includehistory',
  'include_history',
  'transcript',
  'entries',
  'messages',
  'cursor',
  'env',
  'url',
  'method',
  'path',
]);

const SET_RELEASE_PUBLISHED_KEYS = new Set(['releaseId', 'published']);
const DEVICE_ID_KEYS = new Set(['deviceId']);
const BOT_BOARD_KEYS = new Set(['deviceId', 'botIds']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asInputObject(args) {
  if (!isPlainObject(args)) fail('INVALID_ARGUMENT', 'Arguments must be an object');
  return args;
}

function assertCleanFields(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (PROTOTYPE_KEYS.has(key)) {
      fail('INVALID_ARGUMENT', `Disallowed ${label} field: ${key}`);
    }
    if (FORBIDDEN_INPUT_KEYS.has(key.toLowerCase())) {
      fail('FORBIDDEN', `Sensitive or disallowed ${label} field '${key}' is forbidden`);
    }
    if (!allowed.has(key)) {
      fail('INVALID_ARGUMENT', `Unexpected ${label} field: ${key}`);
    }
  }
}

function assertTrimmedId(value, name, maxLen = MAX_ID_LEN) {
  if (typeof value !== 'string' || !value.isWellFormed() || CONTROL_CHAR_RE.test(value)) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > maxLen) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return trimmed;
}

function assertReleaseId(value) {
  const id = assertTrimmedId(value, 'releaseId', MAX_ID_LEN);
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    fail('INVALID_ARGUMENT', 'Invalid releaseId');
  }
  return id;
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    fail('INVALID_ARGUMENT', `${name} must be a boolean`);
  }
  return value;
}

function isReservedDeviceId(deviceId, bridge) {
  return (typeof bridge?.deviceId === 'string' && deviceId === bridge.deviceId)
    || deviceId.startsWith(RESERVED_DEVICE_PREFIX);
}

function normalizeBotTargets(rawTargets) {
  if (rawTargets === undefined) return null;
  if (!Array.isArray(rawTargets)) {
    fail('FORBIDDEN', 'Invalid actor botTargets');
  }
  if (rawTargets.length === 0) return null;
  const targets = [];
  for (const entry of rawTargets) {
    if (!isPlainObject(entry)) {
      fail('FORBIDDEN', 'Invalid actor botTargets entry');
    }
    const deviceId = assertTrimmedId(entry.deviceId, 'actor.botTargets.deviceId', MAX_ID_LEN);
    const botId = assertTrimmedId(entry.botId, 'actor.botTargets.botId', MAX_ID_LEN);
    targets.push({ deviceId, botId });
  }
  return targets;
}

function assertAuthorizedActor(actor, requiredScope, deps, bridge) {
  if (!isPlainObject(actor)) {
    fail('UNAUTHENTICATED', 'Authenticated actor is required');
  }
  const botTargets = normalizeBotTargets(actor.botTargets);
  if (actor.kind === 'bot') {
    const deviceId = assertTrimmedId(actor.deviceId, 'actor.deviceId', MAX_ID_LEN);
    const botId = assertTrimmedId(actor.botId, 'actor.botId', MAX_ID_LEN);
    if (isReservedDeviceId(deviceId, bridge)) {
      fail('FORBIDDEN', 'Reserved actor deviceId');
    }
    if (typeof deps?.store?.isDeviceOAuthGrantEnabled === 'function'
      && !deps.store.isDeviceOAuthGrantEnabled(deviceId)) {
      fail('FORBIDDEN', 'Device management permission is disabled');
    }
    return { kind: 'bot', deviceId, botId, botTargets };
  }
  if (actor.kind === 'oauth') {
    const clientId = assertTrimmedId(actor.clientId, 'actor.clientId', 200);
    if (!Array.isArray(actor.scopes) || !actor.scopes.includes(requiredScope)) {
      fail('FORBIDDEN', `Operation requires explicit ${requiredScope} authorization`);
    }
    return { kind: 'oauth', clientId, scopes: actor.scopes, botTargets };
  }
  fail('FORBIDDEN', 'Unsupported actor kind');
}

function assertBotTargetsAllowed(caller, deviceId, botIds) {
  if (!caller.botTargets) return;
  for (const botId of botIds) {
    const allowed = caller.botTargets.some(
      (target) => target.deviceId === deviceId && target.botId === botId,
    );
    if (!allowed) {
      fail('FORBIDDEN', 'Target Bot is not authorized for this caller');
    }
  }
}

function assertTargetDevice(bridge, deviceId) {
  if (isReservedDeviceId(deviceId, bridge)) {
    fail('NOT_FOUND', 'Device not found');
  }
  if (!bridge || typeof bridge.call !== 'function') {
    fail('DEVICE_OFFLINE', 'Host bridge is unavailable');
  }
  if (typeof bridge.registry?.get === 'function') {
    const entry = bridge.registry.get(deviceId);
    if (!entry || entry.revokedAt !== null) {
      fail('NOT_FOUND', 'Device not found');
    }
  }
  if (typeof bridge.listDevices === 'function') {
    const device = bridge.listDevices().find((item) => item && item.deviceId === deviceId);
    if (!device) fail('NOT_FOUND', 'Device not found');
    if (device.online === false) fail('DEVICE_OFFLINE', 'Device offline');
  }
}

async function callHost(bridge, deviceId, method, params) {
  if (!FIXED_HOST_METHODS.has(method)) {
    fail('FORBIDDEN', 'Disallowed Host bridge method');
  }
  assertTargetDevice(bridge, deviceId);
  const normalized = normalizeControlCall(method, params);
  return bridge.call(deviceId, normalized.method, normalized.params);
}

function scrubSecrets(text, { redactUrls = false } = {}) {
  let out = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted-key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/:\/\/[^/\s@]+:[^/\s@]+@/g, '://[redacted]@')
    .replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[redacted-token]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted-token]')
    .replace(
      /\b(access_token|refresh_token|id_token|api_key|apikey|client_secret|device_token|token|secret|password|passphrase|authorization|cookie)\s*([=:])\s*([^\s,;'"`]+)/gi,
      '$1$2[redacted]',
    );
  if (redactUrls) {
    out = out.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[redacted-url]');
  }
  return out;
}

function sanitizeNullableString(value, maxLen) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(DIAGNOSTIC_CONTROL_CHAR_RE, '').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen).toWellFormed();
}

function sanitizeDiagnosticText(value, maxLen) {
  if (typeof value !== 'string') return null;
  const cleaned = scrubSecrets(value, { redactUrls: true })
    .replace(DIAGNOSTIC_CONTROL_CHAR_RE, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen).toWellFormed();
}

function sanitizeBoardText(value, maxLen) {
  if (typeof value !== 'string') return null;
  const cleaned = scrubSecrets(value, { redactUrls: false })
    .replace(BOARD_CONTROL_CHAR_RE, '');
  return cleaned.slice(0, maxLen).toWellFormed();
}

function nonNegativeInt(value, fallback = null) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function sanitizeClientRelease(record) {
  if (!isPlainObject(record)) {
    fail('INTERNAL_ERROR', 'Unexpected client release payload');
  }
  return {
    id: record.id,
    platform: record.platform,
    arch: record.arch,
    format: record.format,
    version: record.version,
    ...(record.versionCode != null ? { versionCode: record.versionCode } : {}),
    size: record.size,
    sha256: record.sha256,
    ...(record.signature != null ? { signature: record.signature } : {}),
    notes: typeof record.notes === 'string' ? record.notes : '',
    sourceCommit: record.sourceCommit,
    filename: record.filename,
    published: record.published === true,
    publishedAt: record.publishedAt ?? null,
    createdAt: record.createdAt,
    downloadUrl: record.downloadUrl,
  };
}

function sanitizeHostInfo(deviceId, raw) {
  if (!isPlainObject(raw)) {
    fail('INTERNAL_ERROR', 'Unexpected host info payload');
  }
  return {
    deviceId,
    displayName: sanitizeNullableString(raw.displayName, 200),
    platform: sanitizeNullableString(raw.platform, 64),
    arch: sanitizeNullableString(raw.arch, 64),
    protocolVersion: Number.isSafeInteger(raw.protocolVersion) && raw.protocolVersion >= 1
      ? raw.protocolVersion
      : null,
  };
}

function sanitizeDeliveryPumpStatus(raw) {
  if (!isPlainObject(raw)) return null;
  const problem = isPlainObject(raw.lastProblem)
    ? {
        code: sanitizeDiagnosticText(raw.lastProblem.code, 64),
        targetDeviceId: sanitizeNullableString(raw.lastProblem.targetDeviceId, MAX_ID_LEN),
        messageId: sanitizeNullableString(raw.lastProblem.messageId, MAX_ID_LEN),
        at: sanitizeNullableString(raw.lastProblem.at, 64),
      }
    : null;
  return {
    inFlight: nonNegativeInt(raw.inFlight, 0),
    lastProblem: problem,
  };
}

function sanitizeScopeDeliveryStatus(raw) {
  if (!isPlainObject(raw)) return null;
  const problem = isPlainObject(raw.lastProblem)
    ? {
        scopeId: sanitizeNullableString(raw.lastProblem.scopeId, MAX_ID_LEN),
        targetDeviceId: sanitizeNullableString(raw.lastProblem.targetDeviceId, MAX_ID_LEN),
        code: sanitizeDiagnosticText(raw.lastProblem.code, 64),
      }
    : null;
  return {
    online: Boolean(raw.online),
    inFlight: nonNegativeInt(raw.inFlight, 0),
    lastProblem: problem,
  };
}

function sanitizeReplicaSyncStatus(raw) {
  if (!isPlainObject(raw)) return null;
  const problem = isPlainObject(raw.lastProblem)
    ? {
        scopeId: sanitizeNullableString(raw.lastProblem.scopeId, MAX_ID_LEN),
        peerDeviceId: sanitizeNullableString(raw.lastProblem.peerDeviceId, MAX_ID_LEN),
        code: sanitizeDiagnosticText(raw.lastProblem.code, 64),
      }
    : null;
  return {
    online: Boolean(raw.online),
    inFlight: nonNegativeInt(raw.inFlight, 0),
    activePairs: nonNegativeInt(raw.activePairs, 0),
    lastProblem: problem,
  };
}

function sanitizeServiceError(raw) {
  if (!isPlainObject(raw)) return null;
  const code = sanitizeDiagnosticText(raw.code, 64);
  const message = sanitizeDiagnosticText(raw.message, 200);
  if (!code && !message) return null;
  return {
    code: code ?? 'UNKNOWN_ERROR',
    message: message ?? 'Service error',
  };
}

function sanitizeServiceStatus(deviceId, raw) {
  if (!isPlainObject(raw)) {
    fail('INTERNAL_ERROR', 'Unexpected host service status payload');
  }
  const relay = isPlainObject(raw.relay)
    ? {
        phase: RELAY_PHASES.has(raw.relay.phase) ? raw.relay.phase : null,
        attempt: nonNegativeInt(raw.relay.attempt, null),
        lastError: sanitizeDiagnosticText(raw.relay.lastError, 128),
        delivery: sanitizeDeliveryPumpStatus(raw.relay.delivery),
        scopeDelivery: sanitizeScopeDeliveryStatus(raw.relay.scopeDelivery),
        replicaSync: sanitizeReplicaSyncStatus(raw.relay.replicaSync),
      }
    : null;
  const center = isPlainObject(raw.center)
    ? {
        state: CENTER_STATES.has(raw.center.state) ? raw.center.state : null,
        appliedRevision: nonNegativeInt(raw.center.appliedRevision, null),
        error: sanitizeServiceError(raw.center.error),
      }
    : null;
  return {
    deviceId,
    phase: SERVICE_PHASES.has(raw.phase) ? raw.phase : null,
    control: isPlainObject(raw.control)
      ? { listening: Boolean(raw.control.listening) }
      : null,
    relay,
    activeSettingsRevision: nonNegativeInt(raw.activeSettingsRevision, null),
    settingsRevision: nonNegativeInt(raw.settingsRevision, null),
    restartRequired: Boolean(raw.restartRequired),
    center,
  };
}

function sanitizeBotActivity(raw) {
  if (!isPlainObject(raw)) {
    return {
      phase: 'idle',
      source: null,
      scopeId: null,
      requestId: null,
      startedAt: null,
    };
  }
  const phase = BOT_ACTIVITY_PHASES.has(raw.phase) ? raw.phase : 'idle';
  const source = BOT_ACTIVITY_SOURCES.has(raw.source) ? raw.source : null;
  const error = phase === 'failed' && isPlainObject(raw.error)
    ? {
        code: sanitizeDiagnosticText(raw.error.code, 64) ?? 'RUN_FAILED',
        message: sanitizeDiagnosticText(raw.error.message, 200) ?? 'Bot activity failed',
      }
    : undefined;
  return {
    phase,
    source,
    scopeId: sanitizeNullableString(raw.scopeId, MAX_ID_LEN),
    requestId: sanitizeNullableString(raw.requestId, MAX_ID_LEN),
    ...(typeof raw.webhookStopPending === 'boolean' ? { webhookStopPending: raw.webhookStopPending } : {}),
    startedAt: sanitizeNullableString(raw.startedAt, 64),
    ...(error ? { error } : {}),
  };
}

function sanitizeBoardAttention(raw) {
  if (!isPlainObject(raw) || raw.kind !== 'questionnaire') return null;
  const requestId = sanitizeNullableString(raw.requestId, MAX_ID_LEN);
  if (!requestId) return null;
  return {
    kind: 'questionnaire',
    requestId,
    summary: sanitizeBoardText(raw.summary, 200) ?? '',
    count: Number.isSafeInteger(raw.count) && raw.count >= 1 ? raw.count : 1,
  };
}

function sanitizeBoardProgress(raw) {
  if (!isPlainObject(raw)) return null;
  const completed = nonNegativeInt(raw.completed, null);
  const total = nonNegativeInt(raw.total, null);
  if (completed === null || total === null) return null;
  return {
    completed,
    total,
    current: raw.current === null || raw.current === undefined
      ? null
      : sanitizeBoardText(raw.current, 200),
  };
}

function sanitizeBoardLastResult(raw) {
  if (!isPlainObject(raw)) return null;
  const id = sanitizeNullableString(raw.id, MAX_ID_LEN);
  const completedAt = sanitizeNullableString(raw.completedAt, 64);
  if (!id || !completedAt) return null;
  return {
    id,
    completedAt,
    summary: sanitizeBoardText(raw.summary, 500) ?? '',
  };
}

function sanitizeBotBoardItem(raw) {
  if (!isPlainObject(raw)) return null;
  const botId = sanitizeNullableString(raw.botId, MAX_ID_LEN);
  if (!botId) return null;
  return {
    botId,
    conversationId: sanitizeNullableString(raw.conversationId, MAX_ID_LEN),
    activity: sanitizeBotActivity(raw.activity),
    queuedCount: nonNegativeInt(raw.queuedCount, 0),
    attention: sanitizeBoardAttention(raw.attention),
    progress: sanitizeBoardProgress(raw.progress),
    lastResult: sanitizeBoardLastResult(raw.lastResult),
    ...(raw.taskId !== undefined ? { taskId: sanitizeNullableString(raw.taskId, MAX_ID_LEN) } : {}),
    ...(raw.taskTitle !== undefined ? { taskTitle: raw.taskTitle === null ? null : sanitizeBoardText(raw.taskTitle, 200) } : {}),
    ...(raw.taskStatusLine !== undefined ? { taskStatusLine: raw.taskStatusLine === null ? null : sanitizeBoardText(raw.taskStatusLine, 200) } : {}),
  };
}

function sanitizeBotBoard(deviceId, requestedBotIds, raw) {
  if (!isPlainObject(raw)) {
    fail('INTERNAL_ERROR', 'Unexpected bot board payload');
  }
  const requestedSet = new Set(requestedBotIds);
  const items = Array.isArray(raw.items)
    ? raw.items
        .map(sanitizeBotBoardItem)
        .filter((item) => item !== null && requestedSet.has(item.botId))
    : [];
  const errors = Array.isArray(raw.errors)
    ? raw.errors
        .filter((entry) => isPlainObject(entry) && typeof entry.botId === 'string' && requestedSet.has(entry.botId))
        .map((entry) => {
          const missing = entry.code === 'BOT_NOT_FOUND';
          return {
            botId: entry.botId,
            code: missing ? 'BOT_NOT_FOUND' : 'BOARD_UNAVAILABLE',
            message: missing ? 'bot not found' : 'bot board snapshot is unavailable',
          };
        })
    : [];
  return {
    deviceId,
    updatedAt: sanitizeNullableString(raw.updatedAt, 64),
    items,
    errors,
  };
}

export function createHandlers(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createHandlers requires deps');
  }

  return {
    async center_set_client_release_published(args, actor) {
      assertAuthorizedActor(actor, CENTER_WRITE_SCOPE, deps, deps.bridge);
      const input = asInputObject(args);
      assertCleanFields(input, SET_RELEASE_PUBLISHED_KEYS, 'center_set_client_release_published');
      const releaseId = assertReleaseId(input.releaseId);
      const published = assertBoolean(input.published, 'published');

      let updated;
      if (typeof deps.owner === 'function') {
        updated = await deps.owner('POST', '/api/client-releases/:id/publish', {
          params: { id: releaseId },
          body: { published },
        });
      } else if (typeof deps.setReleasePublished === 'function') {
        updated = await deps.setReleasePublished({
          params: { id: releaseId },
          body: { published },
        });
      } else {
        fail('INTERNAL_ERROR', 'Client release publish handler is unavailable');
      }
      return sanitizeClientRelease(updated);
    },

    async center_get_host_info(args, actor) {
      assertAuthorizedActor(actor, CENTER_READ_SCOPE, deps, deps.bridge);
      const input = asInputObject(args);
      assertCleanFields(input, DEVICE_ID_KEYS, 'center_get_host_info');
      const deviceId = assertTrimmedId(input.deviceId, 'deviceId');
      const raw = await callHost(deps.bridge, deviceId, 'getHostInfo', {});
      return sanitizeHostInfo(deviceId, raw);
    },

    async center_get_host_service_status(args, actor) {
      assertAuthorizedActor(actor, CENTER_READ_SCOPE, deps, deps.bridge);
      const input = asInputObject(args);
      assertCleanFields(input, DEVICE_ID_KEYS, 'center_get_host_service_status');
      const deviceId = assertTrimmedId(input.deviceId, 'deviceId');
      const raw = await callHost(deps.bridge, deviceId, 'getServiceStatus', {});
      return sanitizeServiceStatus(deviceId, raw);
    },

    async center_get_bot_board(args, actor) {
      const caller = assertAuthorizedActor(actor, CENTER_READ_SCOPE, deps, deps.bridge);
      const input = asInputObject(args);
      assertCleanFields(input, BOT_BOARD_KEYS, 'center_get_bot_board');
      const deviceId = assertTrimmedId(input.deviceId, 'deviceId');
      if (!Array.isArray(input.botIds) || input.botIds.length < 1 || input.botIds.length > MAX_BOT_BOARD_IDS) {
        fail('INVALID_ARGUMENT', `botIds must be an array of 1 to ${MAX_BOT_BOARD_IDS} Bot IDs`);
      }
      const validatedBotIds = input.botIds.map((botId) => assertTrimmedId(botId, 'botIds[]'));
      const uniqueBotIds = [...new Set(validatedBotIds)];
      assertBotTargetsAllowed(caller, deviceId, uniqueBotIds);

      const raw = await callHost(deps.bridge, deviceId, 'getBotBoard', { botIds: uniqueBotIds });
      return sanitizeBotBoard(deviceId, uniqueBotIds, raw);
    },
  };
}
