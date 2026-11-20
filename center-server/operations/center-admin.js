const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const MODEL_REF_RE = /^[^/\s]+\/.+$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const OPTIONAL_MODEL_PUBLIC_FIELDS = [
  'thinkingLevelMap',
  'cost',
  'compat',
  'inputLimits',
  'promptCache',
  'samplingParams',
  'samplingParamsByThinkingLevel',
];

const EMPTY_KEYS = new Set();
const DEVICE_ID_KEYS = new Set(['deviceId']);
const RENAME_DEVICE_KEYS = new Set(['deviceId', 'name']);
const BOT_SYNC_KEYS = new Set(['epoch', 'sinceSeq']);
const SET_MODEL_CONFIG_KEYS = new Set(['expectedRevision', 'value']);
const MODEL_SELECTION_KEYS = new Set(['modelRef', 'thinkingLevel', 'codemode', 'codemodeOnly']);
const MODEL_STAR_KEYS = new Set(['modelRef', 'starred']);
const LIST_PROVIDERS_KEYS = new Set(['configuredOnly', 'enabledOnly']);
const PROVIDER_ID_KEYS = new Set(['providerId']);
const UPDATE_PROVIDER_KEYS = new Set(['providerId', 'expectedRevision', 'name', 'enabled']);
const LIST_PROVIDER_MODELS_KEYS = new Set(['providerId', 'includeRemoved']);
const CREATE_MODEL_ITEM_KEYS = new Set([
  'id',
  'name',
  'contextWindow',
  'maxTokens',
  'input',
  'reasoning',
  'enabled',
  ...OPTIONAL_MODEL_PUBLIC_FIELDS,
]);
const CREATE_PROVIDER_MODEL_KEYS = new Set(['providerId', ...CREATE_MODEL_ITEM_KEYS]);
const BATCH_CREATE_MODELS_KEYS = new Set(['providerId', 'models']);
const UPDATE_PROVIDER_MODEL_KEYS = new Set([
  'providerId',
  'modelId',
  'expectedRevision',
  'name',
  'contextWindow',
  'maxTokens',
  'input',
  'reasoning',
  'enabled',
  'removed',
  ...OPTIONAL_MODEL_PUBLIC_FIELDS,
]);
const DELETE_PROVIDER_MODEL_KEYS = new Set(['providerId', 'modelId']);
const CLIENT_RELEASES_KEYS = new Set(['platform', 'arch', 'format', 'publishedOnly']);
const OPERATION_ID_KEYS = new Set(['operationId']);
const INSTALLATION_ID_KEYS = new Set(['installationId']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function asInputObject(args) {
  if (args === undefined) return {};
  if (!isPlainObject(args)) fail('INVALID_ARGUMENT', 'Arguments must be an object');
  return args;
}

function assertAllowedKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail('INVALID_ARGUMENT', `Unexpected ${label} field: ${key}`);
  }
}

function assertBoundedText(value, name, { min = 1, max = 128, trim = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed() || CONTROL_CHAR_RE.test(value)) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  const normalized = trim ? value.trim() : value;
  if (normalized.trim().length === 0 || normalized.length < min || normalized.length > max) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return normalized;
}

function assertOptionalBoundedText(value, name, options) {
  if (value === undefined) return undefined;
  return assertBoundedText(value, name, options);
}

function assertRevision(value, name = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_ARGUMENT', `${name} must be a non-negative integer`);
  }
  return value;
}

function assertPositiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_ARGUMENT', `${name} must be a positive integer`);
  }
  return value;
}

function assertBoolean(value, name) {
  if (typeof value !== 'boolean') {
    fail('INVALID_ARGUMENT', `${name} must be a boolean`);
  }
  return value;
}

function assertOptionalBoolean(value, name) {
  if (value === undefined) return undefined;
  return assertBoolean(value, name);
}

function assertModelRef(value, name = 'modelRef') {
  const text = assertBoundedText(value, name, { min: 3, max: 512 });
  if (!MODEL_REF_RE.test(text)) {
    fail('INVALID_ARGUMENT', `${name} must be in providerId/modelId format`);
  }
  return text;
}

function assertModalities(value, name = 'input') {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail('INVALID_ARGUMENT', `${name} must be a non-empty array of modalities`);
  }
  return value.map((item, index) => assertBoundedText(item, `${name}[${index}]`, { min: 1, max: 64 }));
}

function assertNoForbiddenKeysDeep(value, label, depth = 0) {
  if (depth > 16) fail('INVALID_ARGUMENT', `${label} nesting depth exceeds limit`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoForbiddenKeysDeep(value[i], `${label}[${i}]`, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (!isPlainObject(value)) fail('INVALID_ARGUMENT', `${label} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail('INVALID_ARGUMENT', `Forbidden ${label} key: ${key}`);
    assertNoForbiddenKeysDeep(value[key], `${label}.${key}`, depth + 1);
  }
}

function cloneOptionalPlainObject(value, name) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('INVALID_ARGUMENT', `${name} must be an object`);
  assertNoForbiddenKeysDeep(value, name);
  return structuredClone(value);
}

function assertActor(actor) {
  if (!isPlainObject(actor)) fail('UNAUTHENTICATED', 'Valid actor is required');
  if (actor.kind === 'bot') {
    if (
      typeof actor.deviceId !== 'string' ||
      !actor.deviceId.trim() ||
      actor.deviceId.length > 200 ||
      CONTROL_CHAR_RE.test(actor.deviceId) ||
      typeof actor.botId !== 'string' ||
      !actor.botId.trim() ||
      actor.botId.length > 256 ||
      CONTROL_CHAR_RE.test(actor.botId)
    ) {
      fail('UNAUTHENTICATED', 'Invalid bot actor identity');
    }
    return actor;
  }
  if (actor.kind === 'oauth') {
    if (
      typeof actor.clientId !== 'string' ||
      !actor.clientId.trim() ||
      actor.clientId.length > 128 ||
      CONTROL_CHAR_RE.test(actor.clientId)
    ) {
      fail('UNAUTHENTICATED', 'Invalid oauth actor identity');
    }
    return actor;
  }
  fail('UNAUTHENTICATED', 'Unsupported actor kind');
}

function isInternalDeviceId(deviceId, bridge) {
  if (typeof deviceId !== 'string') return true;
  if (deviceId.startsWith('center-')) return true;
  if (typeof bridge?.deviceId === 'string' && deviceId === bridge.deviceId) return true;
  return false;
}

function assertDeviceTarget(deviceId, bridge) {
  const value = assertBoundedText(deviceId, 'deviceId', { min: 1, max: 128 });
  if (value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    fail('INVALID_ARGUMENT', 'Invalid deviceId');
  }
  if (isInternalDeviceId(value, bridge)) {
    fail('NOT_FOUND', 'Device not found');
  }
  return value;
}

function isVisibleInstallationToActor(store, installation, actor) {
  if (!installation || actor.kind === 'oauth') return true;
  if (typeof store?.isVisibleToBot === 'function') {
    return Boolean(store.isVisibleToBot(installation, actor.deviceId, actor.botId));
  }
  if (!installation.ownerBot) return true;
  if ((installation.visibilityScope ?? 'private') === 'private') {
    return installation.ownerBot.deviceId === actor.deviceId && installation.ownerBot.botId === actor.botId;
  }
  return true;
}

function normalizeModelSelection(value) {
  if (!isPlainObject(value)) fail('INVALID_ARGUMENT', 'value must be an object');
  assertAllowedKeys(value, MODEL_SELECTION_KEYS, 'modelConfig.value');
  const normalized = {};
  if (value.modelRef !== undefined) {
    normalized.modelRef = value.modelRef === null
      ? null
      : assertModelRef(value.modelRef, 'value.modelRef');
  }
  if (value.thinkingLevel !== undefined) {
    if (value.thinkingLevel === null) {
      normalized.thinkingLevel = null;
    } else {
      const level = assertBoundedText(value.thinkingLevel, 'value.thinkingLevel', { min: 1, max: 64 });
      if (!THINKING_LEVELS.has(level)) {
        fail('INVALID_ARGUMENT', 'Invalid value.thinkingLevel');
      }
      normalized.thinkingLevel = level;
    }
  }
  if (value.codemode !== undefined) {
    normalized.codemode = value.codemode === null ? null : assertBoolean(value.codemode, 'value.codemode');
  }
  if (value.codemodeOnly !== undefined) {
    normalized.codemodeOnly = value.codemodeOnly === null ? null : assertBoolean(value.codemodeOnly, 'value.codemodeOnly');
  }
  return normalized;
}

function normalizeCreateModelItem(raw, label) {
  if (!isPlainObject(raw)) fail('INVALID_ARGUMENT', `${label} must be an object`);
  assertAllowedKeys(raw, CREATE_MODEL_ITEM_KEYS, label);
  const contextWindow = assertPositiveInt(raw.contextWindow, `${label}.contextWindow`);
  const maxTokens = assertPositiveInt(raw.maxTokens, `${label}.maxTokens`);
  if (maxTokens > contextWindow) {
    fail('INVALID_ARGUMENT', `${label}.maxTokens must not exceed ${label}.contextWindow`);
  }
  const model = {
    id: assertBoundedText(raw.id, `${label}.id`, { min: 1, max: 256 }),
    name: assertBoundedText(raw.name, `${label}.name`, { min: 1, max: 256, trim: true }),
    contextWindow,
    maxTokens,
    input: assertModalities(raw.input, `${label}.input`),
    reasoning: assertBoolean(raw.reasoning, `${label}.reasoning`),
    enabled: raw.enabled === undefined ? true : assertBoolean(raw.enabled, `${label}.enabled`),
    source: 'manual',
  };
  for (const field of OPTIONAL_MODEL_PUBLIC_FIELDS) {
    const cloned = cloneOptionalPlainObject(raw[field], `${label}.${field}`);
    if (cloned !== undefined) model[field] = cloned;
  }
  return model;
}

function sanitizeDevice(device) {
  if (!isPlainObject(device)) return null;
  const name = typeof device.name === 'string' && device.name
    ? device.name
    : typeof device.displayName === 'string' && device.displayName
      ? device.displayName
      : device.deviceId;
  return {
    deviceId: device.deviceId,
    name,
    online: Boolean(device.online),
    ...(typeof device.platform === 'string' && device.platform ? { platform: device.platform } : {}),
  };
}

function sanitizeRuntimeStatus(status) {
  if (!isPlainObject(status)) return null;
  return {
    deviceId: status.deviceId,
    online: Boolean(status.online),
    desiredRevision: status.desiredRevision,
    appliedRevision: status.appliedRevision ?? null,
    status: status.status,
    updatedAt: status.updatedAt ?? null,
    appliedAt: status.appliedAt ?? null,
    error: status.error ?? null,
    bots: Array.isArray(status.bots) ? structuredClone(status.bots) : [],
    capabilityErrors: Array.isArray(status.capabilityErrors) ? structuredClone(status.capabilityErrors) : [],
  };
}

function sanitizeSyncBot(bot) {
  if (!isPlainObject(bot) || typeof bot.deviceId !== 'string' || typeof bot.botId !== 'string') return null;
  const resolved = isPlainObject(bot.resolvedModel)
    ? {
      effectiveModelRef: typeof bot.resolvedModel.effectiveModelRef === 'string' ? bot.resolvedModel.effectiveModelRef : null,
      effectiveModelName: typeof bot.resolvedModel.effectiveModelName === 'string' ? bot.resolvedModel.effectiveModelName : null,
      effectiveProviderName: typeof bot.resolvedModel.effectiveProviderName === 'string' ? bot.resolvedModel.effectiveProviderName : null,
      source: typeof bot.resolvedModel.source === 'string' ? bot.resolvedModel.source : null,
      available: Boolean(bot.resolvedModel.available),
    }
    : null;
  return {
    deviceId: bot.deviceId,
    botId: bot.botId,
    name: typeof bot.name === 'string' ? bot.name : '',
    ...(typeof bot.description === 'string' ? { description: bot.description } : {}),
    ...(typeof bot.isPrimary === 'boolean' ? { isPrimary: bot.isPrimary } : {}),
    ...(bot.archivedAt !== undefined ? { archivedAt: typeof bot.archivedAt === 'string' ? bot.archivedAt : null } : {}),
    ...(typeof bot.deviceName === 'string' ? { deviceName: bot.deviceName } : {}),
    ...(typeof bot.platform === 'string' ? { platform: bot.platform } : {}),
    online: Boolean(bot.online),
    ...(bot.modelRef !== undefined ? { modelRef: typeof bot.modelRef === 'string' ? bot.modelRef : null } : {}),
    ...(resolved ? { resolvedModel: resolved } : {}),
    ...(Number.isSafeInteger(bot.seq) ? { seq: bot.seq } : {}),
  };
}

function sanitizeBotSync(result, bridge) {
  if (!isPlainObject(result)) return null;
  const devices = Array.isArray(result.devices)
    ? result.devices
      .filter((item) => item && typeof item.deviceId === 'string' && !isInternalDeviceId(item.deviceId, bridge))
      .map(sanitizeDevice)
      .filter(Boolean)
    : [];
  const base = {
    epoch: result.epoch,
    seq: result.seq,
    mode: result.mode,
    devices,
  };
  if (Array.isArray(result.bots)) {
    base.bots = result.bots
      .filter((item) => item && typeof item.deviceId === 'string' && !isInternalDeviceId(item.deviceId, bridge))
      .map(sanitizeSyncBot)
      .filter(Boolean);
  }
  if (Array.isArray(result.events)) {
    base.events = result.events
      .filter((event) => isPlainObject(event) && typeof event.deviceId === 'string' && !isInternalDeviceId(event.deviceId, bridge))
      .map((event) => ({
        seq: event.seq,
        deviceId: event.deviceId,
        botId: event.botId,
        op: event.op,
        bot: event.bot ? sanitizeSyncBot(event.bot) : null,
        updatedAt: event.updatedAt ?? null,
      }));
  }
  return base;
}

function sanitizeModelSelection(selection) {
  if (!isPlainObject(selection)) return {};
  const out = {};
  if (selection.modelRef !== undefined) out.modelRef = selection.modelRef;
  if (selection.thinkingLevel !== undefined) out.thinkingLevel = selection.thinkingLevel;
  if (selection.codemode !== undefined) out.codemode = selection.codemode;
  if (selection.codemodeOnly !== undefined) out.codemodeOnly = selection.codemodeOnly;
  return out;
}

function sanitizeModelConfig(config) {
  if (!isPlainObject(config)) return null;
  return {
    global: sanitizeModelSelection(config.global),
    revision: config.revision,
  };
}

function sanitizeCatalogStatus(status) {
  if (!isPlainObject(status)) return null;
  return {
    source: status.source ?? null,
    syncedAt: status.syncedAt ?? null,
    error: status.error ?? null,
    ...(Number.isSafeInteger(status.modelsAdded) ? { modelsAdded: status.modelsAdded } : {}),
    ...(Number.isSafeInteger(status.modelsUpdated) ? { modelsUpdated: status.modelsUpdated } : {}),
  };
}

function sanitizeModelPicker(picker) {
  if (!isPlainObject(picker)) return null;
  const models = Array.isArray(picker.models)
    ? picker.models.filter(isPlainObject).map((model) => ({
      modelRef: model.modelRef,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: Boolean(model.reasoning),
    }))
    : [];
  return {
    defaultModel: picker.defaultModel ?? null,
    models,
    starredModels: Array.isArray(picker.starredModels) ? [...picker.starredModels] : [],
    sync: sanitizeCatalogStatus(picker.sync),
  };
}

function sanitizeProvider(provider) {
  if (!isPlainObject(provider)) return null;
  return {
    id: provider.id,
    name: provider.name,
    api: provider.api,
    enabled: Boolean(provider.enabled),
    native: Boolean(provider.native),
    configured: Boolean(provider.configured),
    hasCredentialRef: Boolean(provider.credentialRef),
    hasCustomOverrides: Boolean(
      isPlainObject(provider.custom) && Object.keys(provider.custom).length > 0,
    ),
    revision: provider.revision,
  };
}

function sanitizeProviderAuthStatus(status) {
  if (!isPlainObject(status)) return null;
  return {
    providerId: status.providerId,
    method: status.method,
    oauth: Boolean(status.oauth),
    ...(typeof status.apiKey === 'boolean' ? { apiKey: status.apiKey } : {}),
    label: status.label,
    subscription: Boolean(status.subscription),
  };
}

function sanitizeModel(model) {
  if (!isPlainObject(model)) return null;
  const out = {
    id: model.id,
    name: model.name,
    ...(typeof model.api === 'string' ? { api: model.api } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: Array.isArray(model.input) ? [...model.input] : [],
    reasoning: Boolean(model.reasoning),
    enabled: Boolean(model.enabled),
    ...(model.source === 'catalog' || model.source === 'manual' ? { source: model.source } : {}),
    ...(model.removed === true ? { removed: true } : {}),
    hasCustomEndpoint: Boolean(typeof model.baseUrl === 'string' && model.baseUrl.length > 0),
    hasCustomHeaders: Boolean(isPlainObject(model.headers) && Object.keys(model.headers).length > 0),
    ...(Number.isSafeInteger(model.revision) ? { revision: model.revision } : {}),
  };
  for (const field of OPTIONAL_MODEL_PUBLIC_FIELDS) {
    if (model[field] !== undefined) out[field] = structuredClone(model[field]);
  }
  return out;
}

function sanitizeClientRelease(record) {
  if (!isPlainObject(record)) return null;
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

function sanitizeOperation(operation) {
  if (!isPlainObject(operation)) return null;
  return {
    operationId: operation.operationId,
    requestId: operation.requestId,
    action: operation.action,
    installationId: operation.installationId,
    deviceIds: Array.isArray(operation.deviceIds) ? [...operation.deviceIds] : [],
    target: operation.target,
    phase: operation.phase,
    error: operation.error ?? null,
  };
}

function sanitizeDeploymentReceipt(receipt) {
  if (!isPlainObject(receipt)) return null;
  return {
    deviceId: receipt.deviceId ?? null,
    installationId: receipt.installationId,
    operationId: receipt.operationId,
    planId: receipt.planId,
    desiredRevision: receipt.desiredRevision,
    appliedRevision: receipt.appliedRevision ?? null,
    actualVersion: receipt.actualVersion ?? null,
    phase: receipt.phase,
    health: receipt.health,
    error: receipt.error ?? null,
  };
}

function sanitizeValidateProviderResult(result) {
  const ok = Boolean(result?.ok);
  if (!ok) {
    return { ok: false, message: 'Provider validation failed' };
  }
  const rawMessage = typeof result?.message === 'string' ? result.message.trim() : '';
  const safeMessage = rawMessage.length > 0
    && rawMessage.length <= 256
    && rawMessage.isWellFormed()
    && !CONTROL_CHAR_RE.test(rawMessage)
    && !/https?:\/\//i.test(rawMessage)
    && !/\b(?:bearer|token|secret|password|apikey|api_key|authorization)\b/i.test(rawMessage)
    ? rawMessage
    : undefined;
  return {
    ok: true,
    ...(safeMessage !== undefined ? { message: safeMessage } : {}),
  };
}

function rethrowSafeProviderProbeError(err, fallbackMessage) {
  if (err?.code === 'NOT_FOUND') fail('NOT_FOUND', 'Provider not found');
  if (err?.code === 'FORBIDDEN') fail('FORBIDDEN', 'Provider operation forbidden');
  if (err?.code === 'INVALID_STATE') fail('INVALID_STATE', 'Provider is not ready');
  fail('INVALID_ARGUMENT', fallbackMessage);
}

export function createHandlers(deps) {
  if (!deps || typeof deps.owner !== 'function') {
    throw new TypeError('createHandlers requires deps.owner');
  }
  const { owner, store, bridge, catalog, notifyAll, publicUrl } = deps;

  return {
    async center_list_devices(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, EMPTY_KEYS, 'center_list_devices');
      const devices = await owner('GET', '/api/devices', {});
      return {
        devices: Array.isArray(devices)
          ? devices
            .filter((item) => item && typeof item.deviceId === 'string' && !isInternalDeviceId(item.deviceId, bridge))
            .map(sanitizeDevice)
            .filter(Boolean)
          : [],
      };
    },

    async center_rename_device(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, RENAME_DEVICE_KEYS, 'center_rename_device');
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const name = assertBoundedText(input.name, 'name', { min: 1, max: 120, trim: true });
      const renamed = await owner('PATCH', '/api/devices/:deviceId', {
        params: { deviceId },
        body: { name },
      });
      return sanitizeDevice(renamed);
    },

    async center_get_device_runtime_status(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, DEVICE_ID_KEYS, 'center_get_device_runtime_status');
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const status = await owner('GET', '/api/devices/:deviceId/runtime-status', {
        params: { deviceId },
      });
      return sanitizeRuntimeStatus(status);
    },

    async center_get_bot_sync(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, BOT_SYNC_KEYS, 'center_get_bot_sync');
      const epoch = assertOptionalBoundedText(input.epoch, 'epoch', { min: 1, max: 128 });
      const sinceSeq = input.sinceSeq === undefined ? undefined : assertRevision(input.sinceSeq, 'sinceSeq');
      let result;
      if (typeof store?.getBotSync === 'function') {
        const rawDevices = await owner('GET', '/api/devices', {});
        const devices = Array.isArray(rawDevices)
          ? rawDevices.filter((item) => item && typeof item.deviceId === 'string' && !isInternalDeviceId(item.deviceId, bridge))
          : [];
        result = store.getBotSync({ epoch, sinceSeq, devices });
      } else {
        const query = {};
        if (epoch !== undefined) query.epoch = epoch;
        if (sinceSeq !== undefined) query.sinceSeq = String(sinceSeq);
        result = await owner('GET', '/api/bot-sync', { query });
      }
      return sanitizeBotSync(result, bridge);
    },

    async center_get_model_config(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, EMPTY_KEYS, 'center_get_model_config');
      const result = await owner('GET', '/api/model-config', {});
      return sanitizeModelConfig(result);
    },

    async center_set_model_config(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, SET_MODEL_CONFIG_KEYS, 'center_set_model_config');
      const expectedRevision = assertRevision(input.expectedRevision);
      const value = normalizeModelSelection(input.value);
      const updated = await owner('PUT', '/api/model-config', {
        body: { expectedRevision, value },
      });
      return sanitizeModelConfig(updated);
    },

    async center_get_model_picker(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, EMPTY_KEYS, 'center_get_model_picker');
      const result = await owner('GET', '/api/model-picker', {});
      return sanitizeModelPicker(result);
    },

    async center_get_model_catalog_status(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, EMPTY_KEYS, 'center_get_model_catalog_status');
      const result = await owner('GET', '/api/model-catalog', {});
      return sanitizeCatalogStatus(result);
    },

    async center_sync_model_catalog(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, EMPTY_KEYS, 'center_sync_model_catalog');
      const result = await owner('POST', '/api/model-catalog/sync', {});
      return sanitizeCatalogStatus(result);
    },

    async center_set_model_star(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, MODEL_STAR_KEYS, 'center_set_model_star');
      const modelRef = assertModelRef(input.modelRef, 'modelRef');
      const starred = assertBoolean(input.starred, 'starred');
      const result = await owner('PUT', '/api/model-stars', {
        body: { modelRef, starred },
      });
      return {
        starredModels: Array.isArray(result?.starredModels) ? [...result.starredModels] : [],
      };
    },

    async center_list_providers(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, LIST_PROVIDERS_KEYS, 'center_list_providers');
      const configuredOnly = assertOptionalBoolean(input.configuredOnly, 'configuredOnly');
      const enabledOnly = assertOptionalBoolean(input.enabledOnly, 'enabledOnly');
      const raw = await owner('GET', '/api/providers', {});
      let providers = Array.isArray(raw) ? raw.map(sanitizeProvider).filter(Boolean) : [];
      if (configuredOnly === true) providers = providers.filter((p) => p.configured);
      if (enabledOnly === true) providers = providers.filter((p) => p.enabled);
      return { providers };
    },

    async center_get_provider(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, PROVIDER_ID_KEYS, 'center_get_provider');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      const provider = await owner('GET', '/api/providers/:id', {
        params: { id: providerId },
      });
      return sanitizeProvider(provider);
    },

    async center_get_provider_auth_status(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, PROVIDER_ID_KEYS, 'center_get_provider_auth_status');
      const providerId = assertOptionalBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      if (providerId !== undefined) {
        const status = await owner('GET', '/api/providers/:id/auth-status', {
          params: { id: providerId },
        });
        const sanitized = sanitizeProviderAuthStatus(status);
        return { statuses: sanitized ? [sanitized] : [] };
      }
      const raw = await owner('GET', '/api/provider-auth-status', {});
      const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? Object.values(raw) : [];
      const statuses = list.map(sanitizeProviderAuthStatus).filter(Boolean);
      statuses.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));
      return { statuses };
    },

    async center_update_provider(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, UPDATE_PROVIDER_KEYS, 'center_update_provider');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      const expectedRevision = assertRevision(input.expectedRevision);
      const name = assertOptionalBoundedText(input.name, 'name', { min: 1, max: 256, trim: true });
      const enabled = assertOptionalBoolean(input.enabled, 'enabled');
      if (name === undefined && enabled === undefined) {
        fail('INVALID_ARGUMENT', 'At least one of name or enabled is required');
      }
      const existing = await owner('GET', '/api/providers/:id', {
        params: { id: providerId },
      });
      if (!isPlainObject(existing)) fail('NOT_FOUND', 'Provider not found');
      const nextValue = {
        name: name !== undefined ? name : existing.name,
        api: existing.api,
        baseUrl: typeof existing.baseUrl === 'string' ? existing.baseUrl : '',
        credentialRef: existing.credentialRef ?? null,
        enabled: enabled !== undefined ? enabled : Boolean(existing.enabled),
        ...(typeof existing.native === 'boolean' ? { native: existing.native } : {}),
        ...(typeof existing.configured === 'boolean' ? { configured: existing.configured } : {}),
        ...(existing.custom !== undefined ? { custom: structuredClone(existing.custom) } : {}),
      };
      let updated;
      if (typeof store?.putProvider === 'function') {
        updated = store.putProvider({ ...nextValue, id: providerId }, expectedRevision);
        if (typeof catalog?.apply === 'function') await catalog.apply();
        if (typeof notifyAll === 'function') notifyAll();
      } else {
        updated = await owner('PUT', '/api/providers/:id', {
          params: { id: providerId },
          body: { expectedRevision, value: nextValue },
        });
      }
      return sanitizeProvider(updated);
    },

    async center_validate_provider(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, PROVIDER_ID_KEYS, 'center_validate_provider');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      let result;
      try {
        result = await owner('POST', '/api/providers/:id/validate', {
          params: { id: providerId },
          body: {},
        });
      } catch (err) {
        rethrowSafeProviderProbeError(err, 'Provider validation failed');
      }
      return sanitizeValidateProviderResult(result);
    },

    async center_discover_provider_models(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, PROVIDER_ID_KEYS, 'center_discover_provider_models');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      let result;
      try {
        result = await owner('POST', '/api/providers/:id/discover', {
          params: { id: providerId },
          body: {},
        });
      } catch (err) {
        rethrowSafeProviderProbeError(err, 'Provider model discovery failed');
      }
      return {
        providerId,
        models: Array.isArray(result?.models) ? result.models.map(sanitizeModel).filter(Boolean) : [],
      };
    },

    async center_list_provider_models(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, LIST_PROVIDER_MODELS_KEYS, 'center_list_provider_models');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      const includeRemoved = assertOptionalBoolean(input.includeRemoved, 'includeRemoved');
      const query = includeRemoved === true ? { includeRemoved: '1' } : {};
      const models = await owner('GET', '/api/providers/:id/models', {
        params: { id: providerId },
        query,
      });
      return {
        providerId,
        models: Array.isArray(models) ? models.map(sanitizeModel).filter(Boolean) : [],
      };
    },

    async center_create_provider_model(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, CREATE_PROVIDER_MODEL_KEYS, 'center_create_provider_model');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      const { providerId: _providerId, ...modelInput } = input;
      const body = normalizeCreateModelItem(modelInput, 'model');
      const created = await owner('POST', '/api/providers/:id/models', {
        params: { id: providerId },
        body,
      });
      return sanitizeModel(created);
    },

    async center_batch_create_provider_models(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, BATCH_CREATE_MODELS_KEYS, 'center_batch_create_provider_models');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 200) {
        fail('INVALID_ARGUMENT', 'models must be an array of 1-200 items');
      }
      const seen = new Set();
      const models = input.models.map((item, index) => {
        const normalized = normalizeCreateModelItem(item, `models[${index}]`);
        if (seen.has(normalized.id)) {
          fail('INVALID_ARGUMENT', `Duplicate model id in batch: ${normalized.id}`);
        }
        seen.add(normalized.id);
        return normalized;
      });
      const existing = await owner('GET', '/api/providers/:id/models', {
        params: { id: providerId },
        query: { includeRemoved: '1' },
      });
      const existingIds = new Set(
        Array.isArray(existing) ? existing.filter(isPlainObject).map((item) => item.id) : [],
      );
      for (const item of models) {
        if (existingIds.has(item.id)) {
          fail('REVISION_CONFLICT', `Model already exists: ${item.id}`);
        }
      }
      let resultModels;
      if (typeof store?.putModelsBatch === 'function') {
        resultModels = store.putModelsBatch(
          providerId,
          models.map((item) => ({ ...item, source: 'manual', removed: false })),
        );
        if (typeof catalog?.apply === 'function') await catalog.apply();
        if (typeof notifyAll === 'function') notifyAll();
      } else {
        const result = await owner('POST', '/api/providers/:id/models/batch', {
          params: { id: providerId },
          body: { models },
        });
        resultModels = result?.models;
      }
      return {
        providerId,
        models: Array.isArray(resultModels) ? resultModels.map(sanitizeModel).filter(Boolean) : [],
      };
    },

    async center_update_provider_model(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, UPDATE_PROVIDER_MODEL_KEYS, 'center_update_provider_model');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      const modelId = assertBoundedText(input.modelId, 'modelId', { min: 1, max: 256 });
      const expectedRevision = assertRevision(input.expectedRevision);
      const patch = {};
      if (input.name !== undefined) {
        patch.name = assertBoundedText(input.name, 'name', { min: 1, max: 256, trim: true });
      }
      if (input.contextWindow !== undefined) {
        patch.contextWindow = assertPositiveInt(input.contextWindow, 'contextWindow');
      }
      if (input.maxTokens !== undefined) {
        patch.maxTokens = assertPositiveInt(input.maxTokens, 'maxTokens');
      }
      if (input.input !== undefined) {
        patch.input = assertModalities(input.input, 'input');
      }
      if (input.reasoning !== undefined) {
        patch.reasoning = assertBoolean(input.reasoning, 'reasoning');
      }
      if (input.enabled !== undefined) {
        patch.enabled = assertBoolean(input.enabled, 'enabled');
      }
      if (input.removed !== undefined) {
        patch.removed = assertBoolean(input.removed, 'removed');
      }
      for (const field of OPTIONAL_MODEL_PUBLIC_FIELDS) {
        const cloned = cloneOptionalPlainObject(input[field], field);
        if (cloned !== undefined) patch[field] = cloned;
      }
      if (Object.keys(patch).length === 0) {
        fail('INVALID_ARGUMENT', 'At least one updatable model field is required');
      }
      const existingList = await owner('GET', '/api/providers/:id/models', {
        params: { id: providerId },
        query: { includeRemoved: '1' },
      });
      const existing = Array.isArray(existingList)
        ? existingList.find((item) => isPlainObject(item) && item.id === modelId)
        : null;
      if (!existing) fail('NOT_FOUND', 'Model not found');
      const nextValue = {
        id: modelId,
        name: typeof existing.name === 'string' && existing.name.length > 0 ? existing.name : modelId,
        contextWindow: existing.contextWindow,
        maxTokens: existing.maxTokens,
        input: Array.isArray(existing.input) && existing.input.length > 0 ? [...existing.input] : ['text'],
        reasoning: Boolean(existing.reasoning),
        enabled: existing.enabled !== undefined ? Boolean(existing.enabled) : true,
      };
      if (typeof existing.api === 'string' && existing.api.length > 0) {
        nextValue.api = existing.api;
      }
      if (typeof existing.baseUrl === 'string' && existing.baseUrl.length > 0) {
        nextValue.baseUrl = existing.baseUrl;
      }
      if (isPlainObject(existing.headers)) {
        nextValue.headers = structuredClone(existing.headers);
      }
      for (const field of OPTIONAL_MODEL_PUBLIC_FIELDS) {
        if (isPlainObject(existing[field])) {
          nextValue[field] = structuredClone(existing[field]);
        }
      }
      if (existing.source === 'catalog' || existing.source === 'manual') {
        nextValue.source = existing.source;
      }
      if (typeof existing.removed === 'boolean') {
        nextValue.removed = existing.removed;
      }
      Object.assign(nextValue, patch, { id: modelId });
      if (
        Number.isSafeInteger(nextValue.contextWindow) &&
        Number.isSafeInteger(nextValue.maxTokens) &&
        nextValue.maxTokens > nextValue.contextWindow
      ) {
        fail('INVALID_ARGUMENT', 'maxTokens must not exceed contextWindow');
      }
      const updated = await owner('PUT', '/api/providers/:id/models/:modelId', {
        params: { id: providerId, modelId },
        body: { expectedRevision, value: nextValue },
      });
      return sanitizeModel(updated);
    },

    async center_delete_provider_model(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, DELETE_PROVIDER_MODEL_KEYS, 'center_delete_provider_model');
      const providerId = assertBoundedText(input.providerId, 'providerId', { min: 1, max: 128 });
      const modelId = assertBoundedText(input.modelId, 'modelId', { min: 1, max: 256 });
      const result = await owner('DELETE', '/api/providers/:id/models/:modelId', {
        params: { id: providerId, modelId },
      });
      return {
        deleted: Boolean(result?.deleted),
        hiddenFromCatalog: Boolean(result?.hiddenFromCatalog),
        clearedGlobalModel: Boolean(result?.clearedGlobalModel),
        clearedBotModels: Number.isSafeInteger(result?.clearedBotModels) ? result.clearedBotModels : 0,
      };
    },

    async center_list_client_releases(args, actor) {
      assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, CLIENT_RELEASES_KEYS, 'center_list_client_releases');
      const platform = assertOptionalBoundedText(input.platform, 'platform', { min: 1, max: 32, trim: true });
      const arch = assertOptionalBoundedText(input.arch, 'arch', { min: 1, max: 32, trim: true });
      const format = assertOptionalBoundedText(input.format, 'format', { min: 1, max: 32, trim: true });
      const publishedOnly = assertOptionalBoolean(input.publishedOnly, 'publishedOnly');
      let rawReleases;
      if (typeof store?.listClientReleases === 'function') {
        const base = typeof publicUrl === 'string' && publicUrl.trim() ? new URL(publicUrl) : null;
        rawReleases = store.listClientReleases().map((record) => ({
          ...record,
          downloadUrl: base
            ? new URL('/api/client-releases/' + record.id + '/download', base).toString()
            : `/api/client-releases/${record.id}/download`,
        }));
      } else {
        const result = await owner('GET', '/api/client-releases', {});
        rawReleases = result?.releases;
      }
      let releases = Array.isArray(rawReleases)
        ? rawReleases.map(sanitizeClientRelease).filter(Boolean)
        : [];
      if (platform !== undefined) releases = releases.filter((item) => item.platform === platform);
      if (arch !== undefined) releases = releases.filter((item) => item.arch === arch);
      if (format !== undefined) releases = releases.filter((item) => item.format === format);
      if (publishedOnly === true) releases = releases.filter((item) => item.published === true);
      return { releases };
    },

    async center_get_operation(args, actor) {
      const checkedActor = assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, OPERATION_ID_KEYS, 'center_get_operation');
      const operationId = assertBoundedText(input.operationId, 'operationId', { min: 1, max: 128 });
      const operation = await owner('GET', '/api/operations/:id', {
        params: { id: operationId },
      });
      if (checkedActor.kind === 'bot' && operation?.installationId && typeof store?.getInstallation === 'function') {
        const installation = store.getInstallation(operation.installationId);
        if (installation && !isVisibleInstallationToActor(store, installation, checkedActor)) {
          fail('NOT_FOUND', 'Operation not found');
        }
      }
      return sanitizeOperation(operation);
    },

    async center_list_installation_deployments(args, actor) {
      const checkedActor = assertActor(actor);
      const input = asInputObject(args);
      assertAllowedKeys(input, INSTALLATION_ID_KEYS, 'center_list_installation_deployments');
      const installationId = assertBoundedText(input.installationId, 'installationId', { min: 1, max: 128 });
      if (checkedActor.kind === 'bot' && typeof store?.getInstallation === 'function') {
        const installation = store.getInstallation(installationId);
        if (installation && !isVisibleInstallationToActor(store, installation, checkedActor)) {
          fail('NOT_FOUND', 'Installation not found');
        }
      }
      const receipts = await owner('GET', '/api/installations/:id/deployments', {
        params: { id: installationId },
      });
      const visibleReceipts = Array.isArray(receipts)
        ? (checkedActor.kind === 'bot'
          ? receipts.filter((item) => item?.deviceId === checkedActor.deviceId || item?.deviceId === null)
          : receipts)
        : [];
      return {
        installationId,
        deployments: visibleReceipts.map(sanitizeDeploymentReceipt).filter(Boolean),
      };
    },
  };
}
