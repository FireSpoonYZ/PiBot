import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import deepmerge from 'deepmerge';
import { assertPublicCredentialId } from '../auth.js';
import { webhookStore } from './webhooks.js';
import { pairingStore } from './pairing.js';

function error(code, message, details) {
  const result = new Error(message);
  result.code = code;
  if (details !== undefined) result.details = details;
  return result;
}

const merge = (base, overrides) => deepmerge(base, overrides, { arrayMerge: (_target, source) => source });
const parse = (row) => row ? JSON.parse(row.json) : null;
const json = (value) => JSON.stringify(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pick = (value, fields) => Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
const safeError = (value) => value == null ? null : value.code === 'INTERRUPTED'
  ? { code: 'INTERRUPTED', message: 'Operation interrupted; retry explicitly' }
  : { code: 'INTERNAL_ERROR', message: 'Operation failed' };
const safeReceipt = (receipt) => ({ ...receipt, error: safeError(receipt.error) });
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Target-supplied messages can embed paths or secrets, so only an allowlisted code and a fixed message cross the boundary. */
const safeRuntimeError = (value) => value == null ? null : { code: SAFE_CODE.test(String(value.code)) ? value.code : 'INTERNAL_ERROR', message: 'Runtime application failed' };
const ACTIVATION_STATUSES = ['disabled', 'enabling', 'enabled', 'failed'];
const VISIBILITY_SCOPES = ['private', 'assigned', 'global'];
const isVisibleToBot = (installation, deviceId, botId) => {
  if (!installation?.ownerBot) return true;
  const scope = installation.visibilityScope ?? 'private';
  if (scope === 'private') {
    return installation.ownerBot.deviceId === deviceId && installation.ownerBot.botId === botId;
  }
  return true;
};
/** Activation errors are center-authored: keep the code and a bounded message, drop anything else. */
const safeActivationError = (value, status) => status !== 'failed' || value == null ? null : {
  code: SAFE_CODE.test(String(value.code)) ? value.code : 'INTERNAL_ERROR',
  message: typeof value.message === 'string' ? value.message.slice(0, 300) : 'Global enable failed',
};
const legacyActivation = (enabled) => ({ status: enabled ? 'enabled' : 'disabled', error: null, updatedAt: null });
/** Old rows have no activation; the historical `enabled` value is the last known good state. */
const withActivation = (installation) => installation === null ? null : { ...installation, activation: installation.activation ?? legacyActivation(installation.enabled) };
/** Effective authorization: global intent plus a successful center-side global enable. */
const activeInstallation = (installation) => Boolean(installation?.enabled && installation.activation?.status === 'enabled');

function assertId(value) {
  if (typeof value !== 'string' || !value.trim()) throw error('INVALID_ARGUMENT', 'An identifier is required');
}
function assertObject(value) {
  if (!object(value)) throw error('INVALID_ARGUMENT', 'Expected an object');
}
function assertRevision(expected, actual) {
  if (expected !== actual) throw error('REVISION_CONFLICT', 'Revision does not match');
}
function normalizeBotRef(deviceId, bot) {
  assertObject(bot);
  assertId(bot.botId);
  if (bot.deviceId !== deviceId || typeof bot.name !== 'string') throw error('INVALID_ARGUMENT', 'Invalid bot directory');
  return {
    deviceId,
    botId: bot.botId,
    name: bot.name,
    ...(typeof bot.description === 'string' ? { description: bot.description } : {}),
    ...(typeof bot.cwd === 'string' ? { cwd: bot.cwd } : {}),
    ...(Number.isSafeInteger(bot.cwdRevision) && bot.cwdRevision >= 0 ? { cwdRevision: bot.cwdRevision } : {}),
    ...(bot.modelRef !== undefined ? { modelRef: bot.modelRef } : {}),
    ...(typeof bot.primaryConversationId === 'string' ? { primaryConversationId: bot.primaryConversationId } : {}),
    ...(typeof bot.createdAt === 'string' ? { createdAt: bot.createdAt } : {}),
    ...(typeof bot.isPrimary === 'boolean' ? { isPrimary: bot.isPrimary } : {}),
    ...(bot.lastActivityAt !== undefined ? { lastActivityAt: bot.lastActivityAt } : {}),
    ...(bot.lastPreview !== undefined ? { lastPreview: bot.lastPreview } : {}),
    ...(bot.archivedAt !== undefined ? { archivedAt: bot.archivedAt } : {}),
    ...(typeof bot.deviceName === 'string' ? { deviceName: bot.deviceName } : {}),
    ...(typeof bot.platform === 'string' ? { platform: bot.platform } : {}),
  };
}
function compareBotRefs(a, b) {
  const aArchived = Boolean(a.archivedAt);
  const bArchived = Boolean(b.archivedAt);
  if (aArchived !== bArchived) return aArchived ? 1 : -1;
  const aPrimary = a.isPrimary === true;
  const bPrimary = b.isPrimary === true;
  if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
  const aTime = Date.parse(a.lastActivityAt || a.createdAt || '') || 0;
  const bTime = Date.parse(b.lastActivityAt || b.createdAt || '') || 0;
  if (bTime !== aTime) return bTime - aTime;
  return a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0;
}

function collectCredentialRefs(schema, value, refs) {
  if (!schema || typeof schema !== 'object' || value == null) return;
  if (schema.type === 'string' && schema.format === 'credential-ref' && typeof value === 'string') {
    refs.add(assertPublicCredentialId(value));
    return;
  }
  if (Array.isArray(value) && schema.items) {
    for (const item of value) collectCredentialRefs(schema.items, item, refs);
  } else if (object(value)) {
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key] ?? schema.additionalProperties;
      collectCredentialRefs(child, item, refs);
    }
  }
}

export function openCenterStore({ dataRoot, encryptionKey }) {
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot)) throw error('INVALID_ARGUMENT', 'dataRoot must be absolute');
  if (!(encryptionKey instanceof Uint8Array) || encryptionKey.byteLength !== 32) {
    throw error('INVALID_ARGUMENT', 'encryptionKey must contain 32 bytes');
  }
  const key = Buffer.from(encryptionKey);
  mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(join(dataRoot, 'center.sqlite'));
  // Declared here because the snapshot helpers below run before the store object literal is built.
  let store;
  function createValidatorAjv(useDefaults) {
    const instance = new Ajv({ allErrors: true, strict: false, ...(useDefaults ? { useDefaults: true } : {}) });
    instance.addFormat('credential-ref', { type: 'string', validate: (value) => value.length > 0 });
    return instance;
  }
  let ajv = createValidatorAjv(false);
  let defaultsAjv = createValidatorAjv(true);
  const validatorCache = new Map();
  const defaultsValidatorCache = new Map();
  function compileValidator(schema, defaults) {
    const cache = defaults ? defaultsValidatorCache : validatorCache;
    const cacheKey = json(schema);
    let validator = cache.get(cacheKey);
    if (validator) return validator;
    if (cache.size >= 512) {
      cache.clear();
      if (defaults) defaultsAjv = createValidatorAjv(true);
      else ajv = createValidatorAjv(false);
    }
    validator = (defaults ? defaultsAjv : ajv).compile(schema);
    cache.set(cacheKey, validator);
    return validator;
  }

  function transaction(fn, mode = 'IMMEDIATE') {
    db.exec('BEGIN ' + mode);
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve original error. */ }
      throw err;
    }
  }
  /** Advances the execution-configuration revision used by device snapshots; status-only writes must not call it. */
  function bump() {
    db.prepare('UPDATE metadata SET config_revision = config_revision + 1 WHERE id = 1').run();
  }
  function validate(schema, value, allowMissing = false, defaults = false) {
    let validator;
    try {
      validator = compileValidator(schema, defaults);
    } catch {
      throw error('VALIDATION_FAILED', 'Invalid configuration schema');
    }
    if (!validator(value)) {
      const errors = validator.errors.filter((entry) => !allowMissing || entry.keyword !== 'required');
      if (errors.length) {
        throw error('VALIDATION_FAILED', 'Configuration is invalid', errors.map((entry) => ({
          path: entry.instancePath, keyword: entry.keyword,
        })));
      }
    }
    collectCredentialRefs(schema, value, new Set());
  }
  function get(table, id) {
    return parse(db.prepare('SELECT json FROM ' + table + ' WHERE id = ?').get(id));
  }
  function rows(table) {
    return db.prepare('SELECT json FROM ' + table + ' ORDER BY id').all().map(parse);
  }
  function save(table, id, value) {
    db.prepare('INSERT INTO ' + table + ' (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(id, json(value));
  }
  function createOrUpdate(table, input, idField, expected) {
    assertObject(input);
    const id = input[idField] || randomUUID();
    assertId(id);
    const current = get(table, id);
    if (expected === null) {
      if (current) throw error('REVISION_CONFLICT', 'Resource already exists');
    } else {
      if (!current) throw error('NOT_FOUND', 'Resource not found');
      assertRevision(expected, current.revision);
    }
    const result = { ...input, [idField]: id, revision: current ? current.revision + 1 : 0 };
    save(table, id, result);
    return result;
  }
  function packageFor(installation) {
    const row = db.prepare('SELECT json FROM package_versions WHERE package_id = ? AND version = ?').get(installation.packageId, installation.targetVersion);
    if (!row) throw error('NOT_FOUND', 'Package version not found');
    return parse(row);
  }
  function requireInstallation(id) {
    const installation = withActivation(get('installations', id));
    if (!installation) throw error('NOT_FOUND', 'Installation not found');
    return installation;
  }
  function configFor(id) {
    const installation = requireInstallation(id);
    const pkg = packageFor(installation);
    const row = db.prepare('SELECT json, revision FROM installation_configs WHERE installation_id = ?').get(id);
    return {
      globalConfig: JSON.parse(row.json), configSchema: pkg.configSchema,
      ...(pkg.uiSchema === undefined ? {} : { uiSchema: pkg.uiSchema }), revision: row.revision,
    };
  }
  function publicBinding(binding) {
    if (!binding) return binding;
    const { autoSeeded: _autoSeeded, explicitAssigned: _explicitAssigned, autoRevoked: _autoRevoked, ...clean } = binding;
    return clean;
  }
  function bindingFor(deviceId, botId, id) {
    return parse(db.prepare('SELECT json FROM bindings WHERE device_id = ? AND bot_id = ? AND installation_id = ?').get(deviceId, botId, id))
      ?? { deviceId, botId, installationId: id, enabled: false, overrides: {}, revision: 0 };
  }
  function capabilityFor(deviceId, botId, id) {
    const config = configFor(id);
    const binding = publicBinding(bindingFor(deviceId, botId, id));
    return { ...binding, globalConfig: config.globalConfig, effectiveConfig: merge(config.globalConfig, binding.overrides), configSchema: config.configSchema };
  }
  /** Managed capabilities that get an enabled binding by default; overrides() can supply per-Bot defaults. */
  const DEFAULT_BINDINGS = {
    'e-launcher.hindsight': { overrides: (bot) => ({ projectId: `${bot.name}-${bot.botId}` }) },
    'e-launcher.billion-context': {},
    'e-launcher.ask-user-question': {},
    'e-launcher.todo': {},
    'e-launcher.vault': {},
    'e-launcher.webfox': {},
  };
  function isGlobalAutoSeed(installation) {
    return !(installation.kind === 'plugin' && DEFAULT_BINDINGS[installation.packageId])
      && installation.visibilityScope === 'global';
  }
  function defaultBindingSpec(installation) {
    if (installation.target !== 'host') return null;
    if (installation.kind === 'plugin' && DEFAULT_BINDINGS[installation.packageId]) {
      return DEFAULT_BINDINGS[installation.packageId];
    }
    if (installation.visibilityScope === 'global') return {};
    return null;
  }
  /** Default bindings for a newly registered Bot: Hindsight projectId is name-botId; Billion Context uses the global config; global skills enable automatically. Existing rows (incl. explicit disables) are kept. Caller must hold a transaction. */
  function initializeBotDefaults(bot) {
    let added = false;
    for (const installation of store.listInstallations()) {
      const defaults = defaultBindingSpec(installation);
      if (!defaults || !activeInstallation(installation)) continue;
      const existing = bindingFor(bot.deviceId, bot.botId, installation.installationId);
      if (existing.revision !== 0 && !existing.autoRevoked) continue;
      const overrides = existing.revision !== 0 ? existing.overrides : (defaults.overrides?.(bot) ?? {});
      const config = configFor(installation.installationId);
      validate(config.configSchema, merge(config.globalConfig, overrides));
      const binding = {
        deviceId: bot.deviceId,
        botId: bot.botId,
        installationId: installation.installationId,
        enabled: true,
        overrides,
        revision: existing.revision + 1,
        ...(isGlobalAutoSeed(installation) ? { autoSeeded: true } : {}),
      };
      db.prepare('INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id, installation_id) DO UPDATE SET json = excluded.json').run(bot.deviceId, bot.botId, installation.installationId, json(binding));
      added = true;
    }
    return added;
  }
  /** Backfill default bindings on existing Bots when an installation reaches the active/global state; rows that already exist (incl. explicit disables/overrides) are untouched. Caller must hold a transaction. */
  function seedBotDefaults(installation) {
    const defaults = defaultBindingSpec(installation);
    if (!defaults || !activeInstallation(installation)) return false;
    let added = false;
    const bots = db.prepare('SELECT json FROM device_bots').all().map(parse);
    for (const bot of bots) {
      const existing = bindingFor(bot.deviceId, bot.botId, installation.installationId);
      if (existing.revision !== 0 && !existing.autoRevoked) continue;
      const overrides = existing.revision !== 0 ? existing.overrides : (defaults.overrides?.(bot) ?? {});
      const config = configFor(installation.installationId);
      validate(config.configSchema, merge(config.globalConfig, overrides));
      const binding = {
        deviceId: bot.deviceId,
        botId: bot.botId,
        installationId: installation.installationId,
        enabled: true,
        overrides,
        revision: existing.revision + 1,
        ...(isGlobalAutoSeed(installation) ? { autoSeeded: true } : {}),
      };
      db.prepare('INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id, installation_id) DO UPDATE SET json = excluded.json').run(bot.deviceId, bot.botId, installation.installationId, json(binding));
      added = true;
    }
    return added;
  }
  function checkEnabledBindings(id, config, installation) {
    if (!installation.enabled) return;
    const bindings = db.prepare('SELECT json FROM bindings WHERE installation_id = ?').all(id).map(parse);
    for (const binding of bindings) {
      if (binding.enabled) validate(config.configSchema, merge(config.globalConfig, binding.overrides));
    }
  }
  function credential(id) {
    const row = db.prepare('SELECT revision, ciphertext FROM credentials WHERE id = ?').get(id);
    return row ? { credentialId: id, configured: row.ciphertext !== null, revision: row.revision } : null;
  }
  function resolveCredential(id) {
    const row = db.prepare('SELECT nonce, tag, ciphertext FROM credentials WHERE id = ?').get(id);
    if (!row || row.ciphertext === null) throw error('NOT_FOUND', 'Credential not configured');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(id, 'utf8'));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw error('INTERNAL_ERROR', 'Credential decryption failed');
    }
  }
  function executionProviders() {
    return store.listProviders().map(provider => ({
      ...provider,
      ...(typeof provider.custom?.baseUrl === 'string' ? { baseUrl: provider.custom.baseUrl } : {}),
      ...(typeof provider.custom?.api === 'string' ? { api: provider.custom.api } : {}),
      ...(provider.custom?.headers && typeof provider.custom.headers === 'object' ? { headers: provider.custom.headers } : {}),
      authMode: credential('center-internal-pi-oauth-' + provider.id)?.configured ? 'oauth' : 'api_key',
    }));
  }
  // Snapshot/turn model fields exclude Center-only catalog bookkeeping (`source`) so Host validators see wire fields only.
  const snapshotModelFields = ['id', 'name', 'api', 'baseUrl', 'headers', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'thinkingLevelMap', 'cost', 'compat', 'inputLimits', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel', 'enabled', 'revision'];
  function executionModels(providers) {
    return Object.fromEntries(providers.map((provider) => [
      provider.id,
      provider.enabled ? store.listModels(provider.id).map((model) => pick(model, snapshotModelFields)) : [],
    ]));
  }
  function sanitizeSnapshotModels(models) {
    if (!object(models)) return models;
    return Object.fromEntries(Object.entries(models).map(([id, list]) => [
      id,
      Array.isArray(list) ? list.map((model) => object(model) ? pick(model, snapshotModelFields) : model) : list,
    ]));
  }
  /** Execution-relevant snapshot content for one device: no display names, activity fields or other devices. */
  function executionContent(deviceId) {
    const providers = executionProviders();
    for (const provider of providers) assertPublicCredentialId(provider.credentialRef);
    const models = executionModels(providers);
    const installations = store.listInstallations();
    const refs = new Set();
    const bots = store.listDeviceBots(deviceId).map((bot) => botContent(deviceId, bot, installations, providers, models, refs));
    return { providers, models, bots, refs };
  }
  /** Per-Bot executable content: model selection plus the complete capability list for that Bot. */
  function botContent(deviceId, bot, installations, providers, models, refs) {
    const model = store.getBotModelConfig(deviceId, bot.botId).effective;
    if (typeof model.modelRef === 'string') {
      const slash = model.modelRef.indexOf('/');
      const provider = providers.find((item) => item.id === model.modelRef.slice(0, slash) && item.enabled);
      const selected = provider && models[provider.id].find((item) => item.id === model.modelRef.slice(slash + 1) && item.enabled);
      if (slash > 0 && selected && provider.credentialRef && provider.authMode !== 'oauth') refs.add(provider.credentialRef);
    }
    const capabilities = installations.map((installation) => {
      const config = capabilityFor(deviceId, bot.botId, installation.installationId);
      const visible = isVisibleToBot(installation, deviceId, bot.botId);
      const enabled = visible && activeInstallation(installation) && config.enabled;
      // Authorization is intended global enabled plus Bot binding, independent of transient rollout status.
      const authorized = Boolean(visible && installation.enabled && config.enabled);
      const capabilityRefs = new Set();
      collectCredentialRefs(config.configSchema, config.effectiveConfig, capabilityRefs);
      if (enabled) {
        validate(config.configSchema, config.effectiveConfig);
        if (installation.target === 'host') for (const ref of capabilityRefs) refs.add(ref);
      }
      return {
        installationId: installation.installationId, kind: installation.kind, target: installation.target,
        targetVersion: installation.targetVersion, enabled, authorized, revision: config.revision, effectiveConfig: config.effectiveConfig,
        credentialRefs: [...capabilityRefs],
        credentialRevisions: Object.fromEntries([...capabilityRefs].sort().flatMap((ref) => {
          const record = credential(ref);
          return record ? [[ref, record.revision]] : [];
        })),
      };
    });
    return { botId: bot.botId, cwd: bot.cwd, model, capabilities };
  }
  /** Single-Bot turn context: same content shape as a device snapshot, plus the secret-free set checksum. */
  function turnContent(deviceId, bot) {
    const providers = executionProviders();
    const models = executionModels(providers);
    const installations = store.listInstallations();
    const refs = new Set();
    const entry = botContent(deviceId, bot, installations, providers, models, refs);
    const credentialRevisions = Object.fromEntries([...refs].sort().map((ref) => [ref, credential(ref)?.revision ?? null]));
    const checksum = createHash('sha256').update(json({
      providers: providers.map((provider) => pick(provider, providerFields)),
      models: Object.entries(models).map(([id, list]) => [id, list.map((model) => pick(model, modelFields))]),
      bot: {
        botId: entry.botId, cwd: entry.cwd ?? null, model: entry.model,
        capabilities: entry.capabilities.filter((capability) => capability.enabled).map((capability) => pick(capability, capabilityFields)),
      },
      credentials: Object.entries(credentialRevisions),
    })).digest('hex');
    const credentials = Object.fromEntries([...refs].map((ref) => [ref, resolveCredential(ref)]));
    return {
      providers, models, bot: entry,
      refs: [...refs].sort(), credentialRevisions, credentials, checksum,
    };
  }
  // Display-only fields are excluded so renaming never invalidates a device; only execution content is compared.
  const providerFields = ['id', 'api', 'baseUrl', 'credentialRef', 'enabled', 'native', 'authMode', 'headers'];
  const modelFields = ['id', 'api', 'baseUrl', 'headers', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'thinkingLevelMap', 'cost', 'compat', 'inputLimits', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel', 'enabled'];
  const capabilityFields = ['installationId', 'kind', 'target', 'targetVersion', 'enabled', 'authorized', 'effectiveConfig', 'credentialRefs', 'credentialRevisions'];
  /** Fingerprints secret-free execution content; CAS revisions, Bot ordering and disabled capabilities are ignored. */
  function deviceDesired(deviceId, content) {
    const fingerprint = createHash('sha256').update(json({
      providers: content.providers.map((provider) => pick(provider, providerFields)),
      models: Object.entries(content.models).map(([id, list]) => [id, list.map((model) => pick(model, modelFields))]),
      bots: [...content.bots].sort((a, b) => a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0).map((bot) => ({
        botId: bot.botId, cwd: bot.cwd ?? null, model: bot.model,
        capabilities: bot.capabilities.filter((capability) => capability.enabled).map((capability) => pick(capability, capabilityFields)),
      })),
      credentials: [...content.refs].sort().map((id) => [id, credential(id)?.revision ?? null]),
    })).digest('hex');
    const row = parse(db.prepare('SELECT json FROM device_configs WHERE device_id = ?').get(deviceId));
    if (row && row.fingerprint === fingerprint) return row;
    const configRevision = db.prepare('SELECT config_revision FROM metadata WHERE id = 1').get().config_revision;
    const value = { deviceId, fingerprint, revision: Math.max(configRevision, row ? row.revision + 1 : 0), updatedAt: new Date().toISOString() };
    db.prepare('INSERT INTO device_configs VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET json = excluded.json').run(deviceId, json(value));
    return value;
  }
  function desiredFor(deviceId) { return deviceDesired(deviceId, executionContent(deviceId)); }
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    transaction(() => {
      let version = db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9].includes(version)) throw error('UNSUPPORTED_SCHEMA', 'Unsupported center database schema');
      if (version === 0) {
        db.exec(`
          CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, config_revision INTEGER NOT NULL);
          INSERT INTO metadata VALUES (1, 0, 0);
          CREATE TABLE providers (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE models (provider_id TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(provider_id, id));
          CREATE TABLE model_config (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL, revision INTEGER NOT NULL);
          INSERT INTO model_config VALUES (1, '{}', 0);
          CREATE TABLE bot_models (device_id TEXT NOT NULL, bot_id TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(device_id, bot_id));
          CREATE TABLE sync_meta (id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, seq INTEGER NOT NULL);
          CREATE TABLE device_bots (device_id TEXT NOT NULL, bot_id TEXT NOT NULL, json TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(device_id, bot_id));
          CREATE TABLE bot_events (seq INTEGER PRIMARY KEY, device_id TEXT NOT NULL, bot_id TEXT NOT NULL, op TEXT NOT NULL CHECK(op IN ('upsert', 'delete')), json TEXT, updated_at TEXT NOT NULL);
          CREATE TABLE package_versions (package_id TEXT NOT NULL, version TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(package_id, version));
          CREATE TABLE installations (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE installation_configs (installation_id TEXT PRIMARY KEY REFERENCES installations(id), json TEXT NOT NULL, revision INTEGER NOT NULL);
          CREATE TABLE bindings (device_id TEXT NOT NULL, bot_id TEXT NOT NULL, installation_id TEXT NOT NULL REFERENCES installations(id), json TEXT NOT NULL, PRIMARY KEY(device_id, bot_id, installation_id));
          CREATE TABLE credentials (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, nonce BLOB, tag BLOB, ciphertext BLOB);
          CREATE TABLE operations (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, json TEXT NOT NULL);
          CREATE TABLE deployment_receipts (device_id TEXT NOT NULL, installation_id TEXT NOT NULL, operation_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(device_id, installation_id, operation_id));
          CREATE TABLE deployment_plans (device_id TEXT NOT NULL, installation_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(device_id, installation_id));
          CREATE TABLE runtime_receipts (device_id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE device_configs (device_id TEXT PRIMARY KEY, json TEXT NOT NULL);
          PRAGMA user_version = 3;
        `);
        db.prepare('INSERT INTO sync_meta VALUES (1, ?, 0)').run(randomUUID());
        version = 3;
      } else if (version === 1) {
        db.exec(`
          DROP TABLE IF EXISTS device_bots;
          DROP TABLE IF EXISTS bot_events;
          DROP TABLE IF EXISTS sync_meta;
          DELETE FROM bot_models;
          DELETE FROM bindings;
          CREATE TABLE sync_meta (id INTEGER PRIMARY KEY CHECK(id = 1), epoch TEXT NOT NULL, seq INTEGER NOT NULL);
          CREATE TABLE device_bots (device_id TEXT NOT NULL, bot_id TEXT NOT NULL, json TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(device_id, bot_id));
          CREATE TABLE bot_events (seq INTEGER PRIMARY KEY, device_id TEXT NOT NULL, bot_id TEXT NOT NULL, op TEXT NOT NULL CHECK(op IN ('upsert', 'delete')), json TEXT, updated_at TEXT NOT NULL);
          PRAGMA user_version = 2;
        `);
        db.prepare('INSERT INTO sync_meta VALUES (1, ?, 0)').run(randomUUID());
        version = 2;
      }
      if (version === 2) {
        // config_revision starts at the legacy revision so existing Hosts never see a lower snapshot revision.
        db.exec(`
          ALTER TABLE metadata ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0;
          UPDATE metadata SET config_revision = revision WHERE id = 1;
          CREATE TABLE device_configs (device_id TEXT PRIMARY KEY, json TEXT NOT NULL);
          PRAGMA user_version = 3;
        `);
        version = 3;
      }
      if (version === 3) {
        db.exec(`
          CREATE TABLE turn_sets (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, bot_id TEXT NOT NULL, fingerprint TEXT NOT NULL, json TEXT NOT NULL);
          CREATE TABLE turn_admissions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, bot_id TEXT NOT NULL, scope_key TEXT NOT NULL, request_id TEXT NOT NULL, set_id TEXT NOT NULL, fingerprint TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(device_id, bot_id, scope_key, request_id));
          PRAGMA user_version = 4;
        `);
        version = 4;
      }
      if (version === 4) {
        // Client release artifacts are immutable once recorded; the tuple is the
        // publish identity so a version can never be silently overwritten.
        db.exec(`
          CREATE TABLE client_releases (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            arch TEXT NOT NULL,
            format TEXT NOT NULL,
            version TEXT NOT NULL,
            published INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            json TEXT NOT NULL,
            UNIQUE(platform, arch, format, version)
          );
          PRAGMA user_version = 5;
        `);
        version = 5;
      }
      if (version === 5) {
        db.exec(`
          CREATE TABLE model_stars (model_ref TEXT PRIMARY KEY);
          PRAGMA user_version = 6;
        `);
        version = 6;
      }
      if (version === 6) {
        db.exec(`
          CREATE TABLE webhook_routes (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, device_id TEXT NOT NULL, bot_id TEXT NOT NULL,
            instruction TEXT NOT NULL, enabled INTEGER NOT NULL, token_hash TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
          );
          CREATE TABLE webhook_events (
            id TEXT PRIMARY KEY, route_id TEXT NOT NULL REFERENCES webhook_routes(id), route_name TEXT NOT NULL,
            device_id TEXT NOT NULL, bot_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
            idempotency_key TEXT NOT NULL, body_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'dispatching', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
            received_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            error_json TEXT, instruction TEXT NOT NULL, payload_json TEXT NOT NULL,
            UNIQUE(route_id, idempotency_key)
          );
          CREATE INDEX webhook_events_route_time ON webhook_events(route_id, received_at);
          CREATE INDEX webhook_events_device_active ON webhook_events(device_id, received_at)
            WHERE status IN ('pending', 'dispatching', 'queued', 'running');
          PRAGMA user_version = 7;
        `);
        version = 7;
      }
      if (version === 7) {
        db.exec(`
          ALTER TABLE webhook_events ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1));
          ALTER TABLE webhook_events ADD COLUMN admission_json TEXT;
          CREATE TABLE webhook_stops (
            device_id TEXT NOT NULL, bot_id TEXT NOT NULL,
            stop_epoch INTEGER NOT NULL CHECK(stop_epoch > 0 AND stop_epoch <= 9007199254740991),
            PRIMARY KEY(device_id, bot_id)
          );
          PRAGMA user_version = 8;
        `);
        version = 8;
      }
      if (version === 8) {
        // Pairing codes keep only the SHA-256 of the secret; the CA is the one
        // private root embedded into every code so devices need no manual cert paste.
        db.exec(`
          CREATE TABLE pairing_codes (
            id TEXT PRIMARY KEY,
            code_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            revoked_at TEXT,
            redeemed_at TEXT,
            device_id TEXT,
            token_hash TEXT,
            target_device_id TEXT
          );
          CREATE TABLE pairing_settings (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            ca_pem TEXT,
            updated_at TEXT NOT NULL
          );
          PRAGMA user_version = 9;
        `);
      }
    });

    store = {
      ...webhookStore(db, transaction),
      ...pairingStore(db, transaction),
      listProviders: () => rows('providers'),
      getProvider: (id) => get('providers', id),
      putProvider(provider, expectedRevision) {
        assertObject(provider);
        assertPublicCredentialId(provider.credentialRef);
        let url;
        if (provider.baseUrl) {
          try { url = new URL(provider.baseUrl); } catch { throw error('INVALID_ARGUMENT', 'Invalid provider URL'); }
          if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw error('INVALID_ARGUMENT', 'Invalid provider URL');
        } else if (!provider.native) throw error('INVALID_ARGUMENT', 'A custom provider requires a base URL');
        if (provider.custom !== undefined && !object(provider.custom)) throw error('INVALID_ARGUMENT', 'Provider overrides must be an object');
        if (provider.custom?.apiKey !== undefined) throw error('INVALID_ARGUMENT', 'Store API keys in encrypted credentials, not overrides');
        const input = pick(provider, ['id', 'name', 'api', 'baseUrl', 'credentialRef', 'enabled', 'native', 'custom']);
        return transaction(() => { const value = createOrUpdate('providers', input, 'id', expectedRevision); bump(); return value; });
      },
      listModels(providerId) {
        return db.prepare('SELECT json FROM models WHERE provider_id = ? ORDER BY id').all(providerId).map(parse);
      },
      putModel(providerId, model, expectedRevision) {
        return transaction(() => {
          if (!get('providers', providerId)) throw error('NOT_FOUND', 'Provider not found');
          assertObject(model);
          const id = model.id || randomUUID();
          assertId(id);
          const current = parse(db.prepare('SELECT json FROM models WHERE provider_id = ? AND id = ?').get(providerId, id));
          if (expectedRevision === null) {
            if (current) throw error('REVISION_CONFLICT', 'Model already exists');
          } else {
            if (!current) throw error('NOT_FOUND', 'Model not found');
            assertRevision(expectedRevision, current.revision);
          }
          const result = { ...pick(model, ['name', 'api', 'baseUrl', 'headers', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'thinkingLevelMap', 'cost', 'compat', 'inputLimits', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel', 'source', 'enabled']), id, revision: current ? current.revision + 1 : 0 };
          db.prepare('INSERT INTO models VALUES (?, ?, ?) ON CONFLICT(provider_id, id) DO UPDATE SET json = excluded.json').run(providerId, id, json(result));
          bump();
          return result;
        });
      },
      // Picker availability uses credential metadata, not the secrets granted to a particular Host.
      getModelPicker() {
        const models = store.listProviders().filter(provider =>
          provider.enabled && (provider.credentialRef === null || credential(provider.credentialRef)?.configured || credential('center-internal-pi-oauth-' + provider.id)?.configured)
        ).flatMap(provider => store.listModels(provider.id).filter(model => model.enabled).map(model => ({
          modelRef: provider.id + '/' + model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
        })));
        models.sort((a, b) => Buffer.compare(Buffer.from(a.modelRef), Buffer.from(b.modelRef)));
        return { defaultModel: store.getModelConfig().global.modelRef ?? null, models, starredModels: store.listModelStars() };
      },
      listModelStars() {
        return db.prepare('SELECT model_ref FROM model_stars ORDER BY model_ref').all().map(row => row.model_ref);
      },
      setModelStar(modelRef, starred) {
        if (typeof modelRef !== 'string' || modelRef.length > 512 || !modelRef.isWellFormed() ||
            !/^[^/\s]+\/.+$/u.test(modelRef) || typeof starred !== 'boolean') {
          throw error('INVALID_ARGUMENT', 'Invalid model star');
        }
        if (starred) {
          const slash = modelRef.indexOf('/');
          if (!store.listModels(modelRef.slice(0, slash)).some(model => model.id === modelRef.slice(slash + 1))) {
            throw error('NOT_FOUND', 'Model not found');
          }
          db.prepare('INSERT OR IGNORE INTO model_stars (model_ref) VALUES (?)').run(modelRef);
        } else {
          db.prepare('DELETE FROM model_stars WHERE model_ref = ?').run(modelRef);
        }
        // Stars are owner preferences and never change execution revisions or Bot selections.
        return { starredModels: store.listModelStars() };
      },
      getModelConfig() {
        const row = db.prepare('SELECT json, revision FROM model_config WHERE id = 1').get();
        return { global: JSON.parse(row.json), revision: row.revision };
      },
      putModelConfig(expectedRevision, global) {
        assertObject(global);
        return transaction(() => {
          const current = store.getModelConfig();
          assertRevision(expectedRevision, current.revision);
          db.prepare('UPDATE model_config SET json = ?, revision = ? WHERE id = 1').run(json(global), current.revision + 1);
          bump(); return store.getModelConfig();
        });
      },
      getBotModelConfig(deviceId, botId) {
        const global = store.getModelConfig().global;
        const row = db.prepare('SELECT json, revision FROM bot_models WHERE device_id = ? AND bot_id = ?').get(deviceId, botId);
        const overrides = row ? JSON.parse(row.json) : {};
        return { global, overrides, effective: merge(global, overrides), revision: row?.revision ?? 0 };
      },
      putBotModelConfig(deviceId, botId, expectedRevision, overrides) {
        assertId(deviceId); assertId(botId); assertObject(overrides);
        return transaction(() => {
          const current = store.getBotModelConfig(deviceId, botId);
          assertRevision(expectedRevision, current.revision);
          db.prepare('INSERT INTO bot_models VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id) DO UPDATE SET json = excluded.json, revision = excluded.revision').run(deviceId, botId, json(overrides), current.revision + 1);
          bump(); return store.getBotModelConfig(deviceId, botId);
        });
      },
      replaceDeviceBots(deviceId, bots, { bumpRevision = true } = {}) {
        assertId(deviceId);
        if (!Array.isArray(bots)) throw error('INVALID_ARGUMENT', 'bots must be an array');
        const seen = new Set();
        const normalizedList = [];
        for (const bot of bots) {
          const normalized = normalizeBotRef(deviceId, bot);
          if (seen.has(normalized.botId)) throw error('INVALID_ARGUMENT', 'Invalid bot directory');
          seen.add(normalized.botId);
          normalizedList.push(normalized);
        }
        return transaction(() => {
          const existingRows = db.prepare('SELECT bot_id, json FROM device_bots WHERE device_id = ?').all(deviceId);
          const existingMap = new Map(existingRows.map((row) => [row.bot_id, row.json]));
          const meta = db.prepare('SELECT epoch, seq FROM sync_meta WHERE id = 1').get();
          let seq = meta.seq;
          const nowIso = new Date().toISOString();
          const upsertBotStmt = db.prepare('INSERT INTO device_bots (device_id, bot_id, json, seq) VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id) DO UPDATE SET json = excluded.json, seq = excluded.seq');
          const insertEventStmt = db.prepare('INSERT INTO bot_events (seq, device_id, bot_id, op, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
          let defaultsAdded = false;
          for (const normalized of normalizedList) {
            const oldSerialized = existingMap.get(normalized.botId);
            const previous = oldSerialized ? JSON.parse(oldSerialized) : null;
            // Avatar configuration belongs to the center, never to Host directory reports.
            normalized.avatar = previous?.avatar ?? null;
            normalized.avatarRevision = previous?.avatarRevision ?? 0;
            // cwd belongs to the center, never to Host directory reports: bootstrap
            // and bots-sync only preserve an existing center value; a Host-supplied
            // cwd is dropped even for new records. The Host initializes a missing
            // value once through the cwd CAS API, never through the report itself.
            delete normalized.cwd;
            if (previous?.cwd !== undefined) normalized.cwd = previous.cwd;
            normalized.cwdRevision = previous?.cwdRevision ?? 0;
            const serialized = json(normalized);
            if (oldSerialized !== serialized) {
              seq += 1;
              upsertBotStmt.run(deviceId, normalized.botId, serialized, seq);
              insertEventStmt.run(seq, deviceId, normalized.botId, 'upsert', serialized, nowIso);
            }
            if (oldSerialized === undefined && initializeBotDefaults(normalized)) defaultsAdded = true;
            existingMap.delete(normalized.botId);
          }
          const deleteBotStmt = db.prepare('DELETE FROM device_bots WHERE device_id = ? AND bot_id = ?');
          const deleteModelStmt = db.prepare('DELETE FROM bot_models WHERE device_id = ? AND bot_id = ?');
          const deleteBindingStmt = db.prepare('DELETE FROM bindings WHERE device_id = ? AND bot_id = ?');
          for (const removedBotId of existingMap.keys()) {
            seq += 1;
            deleteBotStmt.run(deviceId, removedBotId);
            store.cancelWebhookEventsForBot(deviceId, removedBotId);
            deleteModelStmt.run(deviceId, removedBotId);
            deleteBindingStmt.run(deviceId, removedBotId);
            insertEventStmt.run(seq, deviceId, removedBotId, 'delete', null, nowIso);
          }
          if (seq !== meta.seq) {
            db.prepare('UPDATE sync_meta SET seq = ? WHERE id = 1').run(seq);
            if (seq > 5000) {
              db.prepare('DELETE FROM bot_events WHERE seq <= ?').run(seq - 5000);
            }
          }
          if ((bumpRevision && seq !== meta.seq) || defaultsAdded) bump();
          return { epoch: meta.epoch, seq };
        });
      },
      getBotAvatar(deviceId, botId) {
        const bot = parse(db.prepare('SELECT json FROM device_bots WHERE device_id = ? AND bot_id = ?').get(deviceId, botId));
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        return { value: bot.avatar ?? null, revision: bot.avatarRevision ?? 0 };
      },
      putBotAvatar(deviceId, botId, expectedRevision, value) {
        const bot = store.upsertDeviceBot(deviceId, { botId }, { value, expectedRevision });
        return { value: bot.avatar, revision: bot.avatarRevision };
      },
      getBotCwd(deviceId, botId) {
        const bot = parse(db.prepare('SELECT json FROM device_bots WHERE device_id = ? AND bot_id = ?').get(deviceId, botId));
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        return { value: bot.cwd ?? null, revision: bot.cwdRevision ?? 0 };
      },
      putBotCwd(deviceId, botId, expectedRevision, value) {
        const bot = store.upsertDeviceBot(deviceId, { botId }, { value, expectedRevision, kind: 'cwd' });
        return { value: bot.cwd ?? null, revision: bot.cwdRevision ?? 0 };
      },
      upsertDeviceBot(deviceId, bot, fieldChange) {
        assertId(deviceId);
        assertObject(bot);
        assertId(bot.botId);
        return transaction(() => {
          const existingRow = db.prepare('SELECT json, seq FROM device_bots WHERE device_id = ? AND bot_id = ?').get(deviceId, bot.botId);
          const existing = existingRow ? JSON.parse(existingRow.json) : null;
          const rawName = typeof bot.name === 'string' ? bot.name : typeof bot.role === 'string' ? bot.role : existing?.name;
          const merged = normalizeBotRef(deviceId, {
            ...(existing || {}),
            ...bot,
            deviceId,
            ...(rawName !== undefined ? { name: rawName } : {}),
          });
          merged.avatar = existing?.avatar ?? null;
          merged.avatarRevision = existing?.avatarRevision ?? 0;
          // cwd belongs to the center: generic upserts (profile/primary/avatar receipts)
          // never seed it from a Host-supplied record; only fieldChange.kind === 'cwd' writes it.
          delete merged.cwd;
          if (existing?.cwd !== undefined) merged.cwd = existing.cwd;
          merged.cwdRevision = existing?.cwdRevision ?? 0;
          let executionChanged = false;
          if (fieldChange) {
            if (!existing) throw error('NOT_FOUND', 'Bot not found');
            if (fieldChange.kind === 'cwd') {
              assertRevision(fieldChange.expectedRevision, merged.cwdRevision);
              merged.cwd = fieldChange.value;
              merged.cwdRevision += 1;
              // cwd is execution content: a change must reach the next device snapshot.
              executionChanged = true;
            } else {
              assertRevision(fieldChange.expectedRevision, merged.avatarRevision);
              merged.avatar = fieldChange.value;
              merged.avatarRevision += 1;
            }
          }
          const meta = db.prepare('SELECT epoch, seq FROM sync_meta WHERE id = 1').get();
          let seq = meta.seq;
          const nowIso = new Date().toISOString();
          const upsertBotStmt = db.prepare('INSERT INTO device_bots (device_id, bot_id, json, seq) VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id) DO UPDATE SET json = excluded.json, seq = excluded.seq');
          const insertEventStmt = db.prepare('INSERT INTO bot_events (seq, device_id, bot_id, op, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
          if (merged.isPrimary === true) {
            const otherRows = db.prepare('SELECT bot_id, json FROM device_bots WHERE device_id = ? AND bot_id != ?').all(deviceId, merged.botId);
            for (const row of otherRows) {
              const other = JSON.parse(row.json);
              if (other.isPrimary === true) {
                const demoted = { ...other, isPrimary: false };
                const demotedJson = json(demoted);
                seq += 1;
                upsertBotStmt.run(deviceId, row.bot_id, demotedJson, seq);
                insertEventStmt.run(seq, deviceId, row.bot_id, 'upsert', demotedJson, nowIso);
              }
            }
          }
          const serialized = json(merged);
          let targetSeq = existingRow?.seq ?? seq;
          if (!existingRow || existingRow.json !== serialized) {
            seq += 1;
            targetSeq = seq;
            upsertBotStmt.run(deviceId, merged.botId, serialized, seq);
            insertEventStmt.run(seq, deviceId, merged.botId, 'upsert', serialized, nowIso);
          }
          if (seq !== meta.seq) {
            db.prepare('UPDATE sync_meta SET seq = ? WHERE id = 1').run(seq);
            if (seq > 5000) {
              db.prepare('DELETE FROM bot_events WHERE seq <= ?').run(seq - 5000);
            }
            // Only a real Bot addition or an execution-field change bumps; profile edits stay display-only.
            if (!existingRow || executionChanged) bump();
          }
          if (!existingRow) initializeBotDefaults(merged);
          return { ...merged, seq: targetSeq };
        });
      },
      removeDeviceBot(deviceId, botId) {
        assertId(deviceId);
        assertId(botId);
        return transaction(() => {
          const meta = db.prepare('SELECT epoch, seq FROM sync_meta WHERE id = 1').get();
          const seq = meta.seq + 1;
          const nowIso = new Date().toISOString();
          db.prepare('DELETE FROM device_bots WHERE device_id = ? AND bot_id = ?').run(deviceId, botId);
          store.cancelWebhookEventsForBot(deviceId, botId);
          db.prepare('DELETE FROM bot_models WHERE device_id = ? AND bot_id = ?').run(deviceId, botId);
          db.prepare('DELETE FROM bindings WHERE device_id = ? AND bot_id = ?').run(deviceId, botId);
          db.prepare('INSERT INTO bot_events (seq, device_id, bot_id, op, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(seq, deviceId, botId, 'delete', null, nowIso);
          db.prepare('UPDATE sync_meta SET seq = ? WHERE id = 1').run(seq);
          if (seq > 5000) {
            db.prepare('DELETE FROM bot_events WHERE seq <= ?').run(seq - 5000);
          }
          bump();
          return { epoch: meta.epoch, seq };
        });
      },
      listDeviceBots(deviceId) {
        return db.prepare('SELECT json FROM device_bots WHERE device_id = ?').all(deviceId).map(parse).sort(compareBotRefs);
      },
      getBotSync({ epoch, sinceSeq, devices = [] } = {}) {
        return transaction(() => {
          const meta = db.prepare('SELECT epoch, seq FROM sync_meta WHERE id = 1').get();
          const curEpoch = meta.epoch;
          const curSeq = meta.seq;
          const minRow = db.prepare('SELECT MIN(seq) AS min_seq FROM bot_events').get();
          const minSeq = minRow?.min_seq ?? null;
          const onlineMap = new Map(
            Array.isArray(devices)
              ? devices.filter((d) => d && typeof d.deviceId === 'string').map((d) => [d.deviceId, Boolean(d.online)])
              : [],
          );
          const deviceMap = new Map(
            Array.isArray(devices)
              ? devices.filter((d) => d && typeof d.deviceId === 'string').map((d) => [d.deviceId, d])
              : [],
          );
          if (
            !epoch ||
            epoch !== curEpoch ||
            !Number.isSafeInteger(sinceSeq) ||
            sinceSeq < 0 ||
            sinceSeq > curSeq ||
            (minSeq !== null && sinceSeq < minSeq - 1)
          ) {
            const bots = db.prepare('SELECT json, seq FROM device_bots').all()
              .map((row) => {
                const parsed = JSON.parse(row.json);
                const devInfo = deviceMap.get(parsed.deviceId);
                return {
                  ...parsed,
                  ...(devInfo ? { deviceName: devInfo.name || devInfo.displayName || parsed.deviceId } : {}),
                  ...(parsed.platform ? {} : devInfo?.platform ? { platform: devInfo.platform } : {}),
                  online: onlineMap.get(parsed.deviceId) ?? false,
                  seq: row.seq,
                };
              })
              .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : compareBotRefs(a, b)));
            return { epoch: curEpoch, seq: curSeq, mode: 'snapshot', devices, bots };
          }
          const events = db.prepare('SELECT seq, device_id, bot_id, op, json, updated_at FROM bot_events WHERE seq > ? ORDER BY seq ASC').all(sinceSeq)
            .map((row) => ({
              seq: row.seq,
              deviceId: row.device_id,
              botId: row.bot_id,
              op: row.op,
              bot: row.json ? {
                ...JSON.parse(row.json),
                ...(deviceMap.has(row.device_id) ? { deviceName: deviceMap.get(row.device_id).name || deviceMap.get(row.device_id).displayName || row.device_id } : {}),
                online: onlineMap.get(row.device_id) ?? false,
                seq: row.seq,
              } : null,
              updatedAt: row.updated_at,
            }));
          return { epoch: curEpoch, seq: curSeq, mode: 'diff', devices, events };
        }, 'DEFERRED');
      },
      listBotBindings(filter = {}) {
        return db.prepare('SELECT json FROM bindings WHERE (? IS NULL OR device_id = ?) AND (? IS NULL OR installation_id = ?) ORDER BY device_id, bot_id, installation_id').all(filter.deviceId ?? null, filter.deviceId ?? null, filter.installationId ?? null, filter.installationId ?? null).map((row) => publicBinding(parse(row)));
      },
      listInstallations: () => rows('installations').map(withActivation),
      getInstallation: (id) => withActivation(get('installations', id)),
      /** Effective authorization used by snapshots, execution and deployment planning. */
      isActive: activeInstallation,
      isVisibleToBot,
      /** Activation-only patch: keeps the CAS revision so a late preparation cannot clobber a newer intent. */
      putInstallationActivation(id, activation) {
        assertObject(activation);
        if (!ACTIVATION_STATUSES.includes(activation.status)) throw error('INVALID_ARGUMENT', 'Invalid activation status');
        return transaction(() => {
          const current = requireInstallation(id);
          const result = { ...current, activation: { status: activation.status, error: safeActivationError(activation.error, activation.status), updatedAt: new Date().toISOString() } };
          // An installation becoming active seeds default bindings for existing Bots that never chose.
          if (!activeInstallation(current) && activeInstallation(result)) seedBotDefaults(result);
          if (activeInstallation(current) !== activeInstallation(result)) bump();
          save('installations', id, result);
          return result;
        });
      },
      /** Seeds missing default bindings for every currently active default plugin or global skill. Explicit disables/overrides and globally inactive installations are untouched. */
      backfillDefaultBindings() {
        return transaction(() => {
          let changed = false;
          for (const installation of store.listInstallations()) {
            if (!defaultBindingSpec(installation)) continue;
            if (seedBotDefaults(installation)) changed = true;
          }
          if (changed) bump();
          return changed;
        });
      },
      getInstallationConfig: configFor,
      putInstallationConfig(id, input) {
        assertObject(input); assertObject(input.globalConfig);
        return transaction(() => {
          const installation = requireInstallation(id);
          const current = configFor(id);
          assertRevision(input.expectedRevision, current.revision);
          validate(current.configSchema, input.globalConfig, true);
          checkEnabledBindings(id, { ...current, globalConfig: input.globalConfig }, installation);
          db.prepare('UPDATE installation_configs SET json = ?, revision = ? WHERE installation_id = ?').run(json(input.globalConfig), current.revision + 1, id);
          bump(); return configFor(id);
        });
      },
      getBotCapability: capabilityFor,
      listBotCapabilities(deviceId, botId) {
        assertId(deviceId); assertId(botId);
        return transaction(() => store.listInstallations()
          .filter((installation) => isVisibleToBot(installation, deviceId, botId))
          .map((installation) => {
            const config = capabilityFor(deviceId, botId, installation.installationId);
            const { uiSchema } = configFor(installation.installationId);
            return { installation, config, ...(uiSchema === undefined ? {} : { uiSchema }) };
          }), 'DEFERRED');
      },
      putBotCapability(deviceId, botId, id, input) {
        assertId(deviceId); assertId(botId); assertObject(input); assertObject(input.overrides);
        if (typeof input.enabled !== 'boolean') throw error('INVALID_ARGUMENT', 'enabled must be boolean');
        return transaction(() => {
          const installation = requireInstallation(id);
          const config = configFor(id);
          const current = bindingFor(deviceId, botId, id);
          assertRevision(input.expectedRevision, current.revision);
          if (input.enabled && !isVisibleToBot(installation, deviceId, botId)) {
            throw error('FORBIDDEN', 'Skill is private to its owner Bot');
          }
          // A new Bot enable requires a successfully enabled global installation; turning one off stays allowed.
          if (input.enabled && !current.enabled && !activeInstallation(installation)) {
            throw error('FORBIDDEN', 'Capability is not globally enabled');
          }
          validate(config.configSchema, merge(config.globalConfig, input.overrides), !input.enabled);
          const binding = { deviceId, botId, installationId: id, enabled: input.enabled, overrides: input.overrides, revision: current.revision + 1, explicitAssigned: true };
          db.prepare('INSERT INTO bindings VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id, installation_id) DO UPDATE SET json = excluded.json').run(deviceId, botId, id, json(binding));
          bump(); return capabilityFor(deviceId, botId, id);
        });
      },
      getCredential: credential,
      putCredential(id, input) {
        assertId(id); assertObject(input);
        if (typeof input.value !== 'string' || !input.value) throw error('INVALID_ARGUMENT', 'Credential value is required');
        return transaction(() => {
          const current = credential(id);
          if (input.expectedRevision === null) {
            if (current) throw error('REVISION_CONFLICT', 'Credential already exists');
          } else {
            if (!current) throw error('NOT_FOUND', 'Credential not found');
            assertRevision(input.expectedRevision, current.revision);
          }
          const nonce = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, nonce);
          cipher.setAAD(Buffer.from(id, 'utf8'));
          const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
          db.prepare('INSERT INTO credentials VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, nonce = excluded.nonce, tag = excluded.tag, ciphertext = excluded.ciphertext').run(id, current ? current.revision + 1 : 0, nonce, cipher.getAuthTag(), ciphertext);
          bump(); return credential(id);
        });
      },
      deleteCredential(id, expectedRevision) {
        return transaction(() => {
          const current = credential(id);
          if (!current || !current.configured) throw error('NOT_FOUND', 'Credential not found');
          assertRevision(expectedRevision, current.revision);
          db.prepare('UPDATE credentials SET revision = ?, nonce = NULL, tag = NULL, ciphertext = NULL WHERE id = ?').run(current.revision + 1, id);
          bump();
        });
      },
      resolveCredential,
      getPackageVersion(packageId, version) {
        return parse(db.prepare('SELECT json FROM package_versions WHERE package_id = ? AND version = ?').get(packageId, version));
      },
      putPackageVersion(version) {
        assertObject(version); assertId(version.packageId); assertId(version.version);
        return transaction(() => {
          const previous = store.getPackageVersion(version.packageId, version.version);
          if (previous && json(previous) !== json(version)) throw error('REQUEST_CONFLICT', 'Package version already exists');
          if (!previous) {
            db.prepare('INSERT INTO package_versions VALUES (?, ?, ?)').run(version.packageId, version.version, json(version));
          }
        });
      },
      putInstallation(installation, expectedRevision) {
        return transaction(() => {
          assertObject(installation);
          const pkg = packageFor(installation);
          if (pkg.kind !== installation.kind) throw error('INVALID_ARGUMENT', 'Package kind does not match installation');
          const current = installation.installationId ? get('installations', installation.installationId) : null;
          const activation = installation.activation ?? legacyActivation(installation.enabled);
          if (!ACTIVATION_STATUSES.includes(activation.status)) throw error('INVALID_ARGUMENT', 'Invalid activation status');
          let ownerBot = installation.ownerBot ?? current?.ownerBot;
          if (ownerBot !== undefined) {
            if (!object(ownerBot)
                || typeof ownerBot.deviceId !== 'string' || !ownerBot.deviceId
                || typeof ownerBot.botId !== 'string' || !ownerBot.botId
                || typeof ownerBot.skillId !== 'string' || !ownerBot.skillId
                || typeof ownerBot.skillName !== 'string' || !ownerBot.skillName) {
              throw error('INVALID_ARGUMENT', 'Invalid ownerBot');
            }
            ownerBot = {
              deviceId: ownerBot.deviceId,
              botId: ownerBot.botId,
              skillId: ownerBot.skillId,
              skillName: ownerBot.skillName,
            };
          }
          if (installation.visibilityScope !== undefined && !ownerBot) {
            throw error('INVALID_ARGUMENT', 'visibilityScope is only supported on Bot-owned skills');
          }
          const visibilityScope = installation.visibilityScope ?? current?.visibilityScope ?? (ownerBot ? 'private' : undefined);
          if (visibilityScope !== undefined && !VISIBILITY_SCOPES.includes(visibilityScope)) {
            throw error('INVALID_ARGUMENT', 'Invalid visibilityScope');
          }
          const input = {
            ...installation,
            ...(ownerBot ? { ownerBot } : {}),
            ...(visibilityScope ? { visibilityScope } : {}),
            activation: { status: activation.status, error: safeActivationError(activation.error, activation.status), updatedAt: activation.updatedAt ?? null },
          };
          const result = createOrUpdate('installations', pick(input, ['installationId', 'packageId', 'displayName', 'kind', 'source', 'target', 'targetVersion', 'enabled', 'activation', 'ownerBot', 'visibilityScope']), 'installationId', expectedRevision);
          if (!current) {
            const globalConfig = {};
            validate(pkg.configSchema, globalConfig, true, true);
            db.prepare('INSERT INTO installation_configs VALUES (?, ?, 0)').run(result.installationId, json(globalConfig));
          } else {
            const config = configFor(result.installationId);
            validate(config.configSchema, config.globalConfig, true);
            checkEnabledBindings(result.installationId, config, result);
          }
          bump(); return result;
        });
      },
      /** Backfill ownerBot + visibilityScope on legacy bot-skill-* rows without bumping user CAS unnecessarily. */
      setInstallationOwnership(id, ownerBot, defaultScope = 'private') {
        assertId(id);
        assertObject(ownerBot);
        if (!VISIBILITY_SCOPES.includes(defaultScope)) throw error('INVALID_ARGUMENT', 'Invalid visibilityScope');
        return transaction(() => {
          const current = get('installations', id);
          if (!current) return null;
          if (current.ownerBot && current.visibilityScope) return withActivation(current);
          const updated = {
            ...current,
            ownerBot: current.ownerBot ?? {
              deviceId: ownerBot.deviceId,
              botId: ownerBot.botId,
              skillId: ownerBot.skillId,
              skillName: ownerBot.skillName,
            },
            visibilityScope: current.visibilityScope ?? defaultScope,
          };
          save('installations', id, updated);
          return withActivation(updated);
        });
      },
      /** Display-name and/or Bot-skill visibility scope update: keeps installationId/packageId. */
      renameInstallation(id, input) {
        assertObject(input);
        const hasDisplayName = input.displayName !== undefined;
        const hasVisibility = input.visibilityScope !== undefined;
        if (!hasDisplayName && !hasVisibility) throw error('INVALID_ARGUMENT', 'Invalid display name');
        let displayName;
        if (hasDisplayName) {
          displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
          if (!displayName || displayName.length > 120) throw error('INVALID_ARGUMENT', 'Invalid display name');
        }
        if (hasVisibility && !VISIBILITY_SCOPES.includes(input.visibilityScope)) {
          throw error('INVALID_ARGUMENT', 'Invalid visibilityScope');
        }
        return transaction(() => {
          const current = requireInstallation(id);
          assertRevision(input.expectedRevision, current.revision);
          if (hasVisibility && !current.ownerBot) {
            throw error('INVALID_ARGUMENT', 'visibilityScope is only supported on Bot-owned skills');
          }
          const nextScope = hasVisibility ? input.visibilityScope : current.visibilityScope;
          const result = {
            ...current,
            ...(hasDisplayName ? { displayName } : {}),
            ...(nextScope !== undefined ? { visibilityScope: nextScope } : {}),
            revision: current.revision + 1,
          };
          save('installations', id, result);
          if (hasVisibility && nextScope !== current.visibilityScope) {
            if (nextScope === 'private' && current.ownerBot) {
              const allBindings = db.prepare('SELECT json FROM bindings WHERE installation_id = ?').all(id).map(parse);
              for (const b of allBindings) {
                if (b.deviceId === current.ownerBot.deviceId && b.botId === current.ownerBot.botId) continue;
                if (!b.enabled) continue;
                const { autoSeeded: _autoSeeded, explicitAssigned: _explicitAssigned, ...rest } = b;
                const disabled = { ...rest, enabled: false, revision: b.revision + 1, autoRevoked: true };
                db.prepare('UPDATE bindings SET json = ? WHERE device_id = ? AND bot_id = ? AND installation_id = ?')
                  .run(json(disabled), b.deviceId, b.botId, id);
              }
            } else if (nextScope === 'assigned' && current.visibilityScope === 'global' && current.ownerBot) {
              const allBindings = db.prepare('SELECT json FROM bindings WHERE installation_id = ?').all(id).map(parse);
              for (const b of allBindings) {
                if (b.deviceId === current.ownerBot.deviceId && b.botId === current.ownerBot.botId) continue;
                if (!b.enabled) continue;
                if (b.autoSeeded === true || !b.explicitAssigned) {
                  const { autoSeeded: _autoSeeded, explicitAssigned: _explicitAssigned, ...rest } = b;
                  const disabled = { ...rest, enabled: false, revision: b.revision + 1, autoRevoked: true };
                  db.prepare('UPDATE bindings SET json = ? WHERE device_id = ? AND bot_id = ? AND installation_id = ?')
                    .run(json(disabled), b.deviceId, b.botId, id);
                }
              }
            } else if (nextScope === 'global' && activeInstallation(result)) {
              seedBotDefaults(result);
            }
            bump();
          }
          return result;
        });
      },
      getOperation(id) {
        return parse(db.prepare('SELECT json FROM operations WHERE id = ?').get(id));
      },
      findOperationByRequestId(requestId) {
        return parse(db.prepare('SELECT json FROM operations WHERE request_id = ?').get(requestId));
      },
      listOperations(filter = {}) {
        assertObject(filter);
        return db.prepare('SELECT json FROM operations ORDER BY id').all().map(parse).filter((operation) =>
          (filter.installationId === undefined || operation.installationId === filter.installationId)
          && (filter.deviceId === undefined || operation.deviceIds.includes(filter.deviceId))
          && (filter.action === undefined || operation.action === filter.action)
          && (filter.phase === undefined || operation.phase === filter.phase));
      },
      putOperation(operation, requestFingerprint) {
        assertObject(operation); assertId(operation.operationId); assertId(operation.requestId); assertId(requestFingerprint);
        return transaction(() => {
          const row = db.prepare('SELECT id, request_id, fingerprint, json FROM operations WHERE request_id = ? OR id = ?').all(operation.requestId, operation.operationId);
          if (row.length) {
            if (row.length !== 1 || row[0].request_id !== operation.requestId || row[0].fingerprint !== requestFingerprint) throw error('REQUEST_CONFLICT', 'Operation request conflicts');
            return parse(row[0]);
          }
          const value = safeReceipt(pick(operation, ['operationId', 'requestId', 'action', 'installationId', 'deviceIds', 'target', 'phase', 'error']));
          db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(value.operationId, value.requestId, requestFingerprint, json(value));
          return value;
        });
      },
      updateOperation(id, update) {
        assertObject(update);
        return transaction(() => {
          const current = store.getOperation(id);
          if (!current) throw error('NOT_FOUND', 'Operation not found');
          const result = { ...current, phase: update.phase, error: safeError(update.error) };
          db.prepare('UPDATE operations SET json = ? WHERE id = ?').run(json(result), id);
          return result;
        });
      },
      listDeploymentReceipts(installationId) {
        return db.prepare(`SELECT r.json, p.json AS plan_json FROM deployment_receipts r
          JOIN deployment_plans p ON p.device_id = r.device_id AND p.installation_id = r.installation_id
          WHERE r.installation_id = ? ORDER BY r.device_id, r.operation_id`).all(installationId)
          .map((row) => ({ receipt: JSON.parse(row.json), plan: JSON.parse(row.plan_json) }))
          .filter(({ receipt, plan }) => typeof plan.planId === 'string' && receipt.planId === plan.planId && receipt.desiredRevision === plan.desiredRevision && receipt.operationId === plan.operationId)
          .map(({ receipt }) => receipt);
      },
      putDeploymentReceipt(receipt) {
        assertObject(receipt); assertId(receipt.planId); assertId(receipt.operationId); assertId(receipt.installationId);
        if (receipt.deviceId !== null) assertId(receipt.deviceId);
        return transaction(() => {
          const plan = parse(db.prepare('SELECT json FROM deployment_plans WHERE device_id = ? AND installation_id = ?').get(receipt.deviceId ?? '', receipt.installationId));
          if (!plan || receipt.planId !== plan.planId || receipt.desiredRevision !== plan.desiredRevision || receipt.operationId !== plan.operationId) {
            throw error('REVISION_CONFLICT', 'Deployment plan has changed');
          }
          const value = safeReceipt(pick(receipt, ['deviceId', 'installationId', 'operationId', 'planId', 'desiredRevision', 'appliedRevision', 'actualVersion', 'phase', 'health', 'error']));
          db.prepare('INSERT INTO deployment_receipts VALUES (?, ?, ?, ?) ON CONFLICT(device_id, installation_id, operation_id) DO UPDATE SET json = excluded.json').run(value.deviceId ?? '', value.installationId, value.operationId, json(value));
        });
      },
      putDeploymentPlan(plan) {
        assertObject(plan); assertId(plan.installationId); assertId(plan.operationId); assertId(plan.planId);
        if (plan.deviceId !== null) assertId(plan.deviceId);
        if (!Number.isSafeInteger(plan.desiredRevision) || plan.desiredRevision < 1) throw error('INVALID_ARGUMENT', 'Invalid deployment revision');
        return transaction(() => {
          const value = JSON.parse(json(plan));
          const current = parse(db.prepare('SELECT json FROM deployment_plans WHERE device_id = ? AND installation_id = ?').get(value.deviceId ?? '', value.installationId));
          if (current && typeof current.planId === 'string' && Number.isSafeInteger(current.desiredRevision)) {
            const { planId: _id, desiredRevision: _revision, operationId: _operation, ...meaning } = value;
            const { planId: _oldId, desiredRevision: _oldRevision, operationId: _oldOperation, ...oldMeaning } = current;
            if (isDeepStrictEqual(meaning, oldMeaning)) {
              if (!isDeepStrictEqual(value, current)) throw error('REVISION_CONFLICT', 'Unchanged deployment must retain its plan');
              return;
            }
            if (value.desiredRevision <= current.desiredRevision || value.planId === current.planId) throw error('REVISION_CONFLICT', 'Deployment revision must advance');
          }
          db.prepare('INSERT INTO deployment_plans VALUES (?, ?, ?) ON CONFLICT(device_id, installation_id) DO UPDATE SET json = excluded.json').run(value.deviceId ?? '', value.installationId, json(value));
        });
      },
      listDeploymentPlans(deviceId) {
        return db.prepare('SELECT json FROM deployment_plans WHERE device_id = ? ORDER BY installation_id').all(deviceId ?? '').map(parse);
      },
      putRuntimeReceipt(receipt) {
        assertObject(receipt); assertId(receipt.deviceId);
        return transaction(() => {
          const desired = desiredFor(receipt.deviceId);
          if (receipt.revision > desired.revision) throw error('REVISION_CONFLICT', 'Runtime receipt is ahead of the desired configuration');
          const previous = store.getRuntimeReceipt(receipt.deviceId);
          if (previous && receipt.revision < previous.revision) return null;
          const now = new Date().toISOString();
          const applied = receipt.status === 'applied';
          const value = {
            deviceId: receipt.deviceId, revision: receipt.revision, status: receipt.status,
            appliedRevision: receipt.appliedRevision ?? (applied ? receipt.revision : null),
            error: safeRuntimeError(receipt.error), updatedAt: now,
            appliedAt: applied ? (previous && previous.revision === receipt.revision && previous.appliedAt ? previous.appliedAt : now) : null,
            bots: (receipt.bots ?? []).map((bot) => ({ botId: bot.botId, desiredRevision: bot.desiredRevision, appliedRevision: bot.appliedRevision ?? null, status: bot.status, error: safeRuntimeError(bot.error) })),
            capabilityErrors: (receipt.capabilityErrors ?? []).map((entry) => ({ botId: entry.botId, installationId: entry.installationId, error: safeRuntimeError(entry.error) })),
          };
          db.prepare('INSERT INTO runtime_receipts VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET json = excluded.json').run(receipt.deviceId, json(value));
          return null;
        });
      },
      getRuntimeReceipt(deviceId) {
        return parse(db.prepare('SELECT json FROM runtime_receipts WHERE device_id = ?').get(deviceId));
      },
      /** Center-saved desired revision versus the target's actual receipt; a stale receipt reads as pending. */
      getDeviceRuntimeStatus(deviceId, online) {
        assertId(deviceId);
        return transaction(() => {
          const desired = desiredFor(deviceId);
          const receipt = store.getRuntimeReceipt(deviceId);
          const current = receipt && receipt.revision === desired.revision ? receipt : null;
          // Receipts stored before the split carry no appliedRevision; an applied status implies its revision.
          const appliedRevision = current ? current.appliedRevision ?? (current.status === 'applied' ? current.revision : null) : null;
          return {
            deviceId, online: Boolean(online), desiredRevision: desired.revision,
            appliedRevision, status: current?.status ?? 'pending',
            updatedAt: desired.updatedAt ?? null, appliedAt: current?.appliedAt ?? null,
            error: current?.error ?? null, bots: current?.bots ?? [], capabilityErrors: current?.capabilityErrors ?? [],
          };
        }, 'DEFERRED');
      },
      /** One DB transaction for a per-Bot turn set comparison; unrelated Bots' changes cannot alter the checksum. */
      getBotTurnContext(deviceId, botId) {
        assertId(deviceId); assertId(botId);
        // Revision bookkeeping writes device_configs; do it inside a write transaction, outside the read one.
        // The revision is display-only: set identity comparisons use the secret-free checksum instead.
        const revision = transaction(() => desiredFor(deviceId).revision);
        return transaction(() => {
          const bot = store.listDeviceBots(deviceId).find((item) => item.botId === botId);
          if (!bot) throw error('NOT_FOUND', 'Bot not found');
          if (bot.archivedAt) throw error('BOT_ARCHIVED', 'Bot is archived');
          return { deviceId, revision, ...turnContent(deviceId, bot) };
        }, 'DEFERRED');
      },
      /** Deduplicated nonsecret set: identical desired state reuses the stored snapshot/plans by setId. */
      putTurnSet(set) {
        assertObject(set); assertId(set.setId); assertId(set.deviceId); assertId(set.botId); assertId(set.fingerprint);
        return transaction(() => {
          const current = get('turn_sets', set.setId);
          if (current) {
            if (current.deviceId !== set.deviceId || current.botId !== set.botId || current.fingerprint !== set.fingerprint) {
              throw error('REQUEST_CONFLICT', 'Turn set identity conflicts');
            }
            return current.snapshot?.models ? { ...current, snapshot: { ...current.snapshot, models: sanitizeSnapshotModels(current.snapshot.models) } } : current;
          }
          const sanitizedSnapshot = set.snapshot?.models ? { ...set.snapshot, models: sanitizeSnapshotModels(set.snapshot.models) } : set.snapshot;
          const value = {
            setId: set.setId, deviceId: set.deviceId, botId: set.botId, fingerprint: set.fingerprint,
            snapshot: sanitizedSnapshot, plans: set.plans, refs: set.refs, credentialRevisions: set.credentialRevisions,
            createdAt: new Date().toISOString(),
          };
          // turn_sets 有 NOT NULL 业务列，不能用只写 (id,json) 的 generic save。
          db.prepare('INSERT INTO turn_sets (id, device_id, bot_id, fingerprint, json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET device_id = excluded.device_id, bot_id = excluded.bot_id, fingerprint = excluded.fingerprint, json = excluded.json')
            .run(set.setId, set.deviceId, set.botId, set.fingerprint, json(value));
          return value;
        });
      },
      getTurnSet(setId) {
        assertId(setId);
        const set = get('turn_sets', setId);
        return set?.snapshot?.models ? { ...set, snapshot: { ...set.snapshot, models: sanitizeSnapshotModels(set.snapshot.models) } } : set;
      },
      getTurnAdmission(admissionId) {
        assertId(admissionId);
        return get('turn_admissions', admissionId);
      },
      findTurnAdmission({ deviceId, botId, scopeKey, requestId }) {
        assertId(deviceId); assertId(botId); assertId(scopeKey); assertId(requestId);
        return parse(db.prepare('SELECT json FROM turn_admissions WHERE device_id = ? AND bot_id = ? AND scope_key = ? AND request_id = ?').get(deviceId, botId, scopeKey, requestId));
      },
      /** Idempotent admission: compares the authoritative set and records the grant in one transaction. */
      confirmTurnAdmission({ deviceId, botId, scopeKey, requestId, setId, checksum, requestFingerprint, planFingerprint }) {
        assertId(deviceId); assertId(botId); assertId(scopeKey); assertId(requestId); assertId(setId); assertId(requestFingerprint);
        return transaction(() => {
          const bot = store.listDeviceBots(deviceId).find((item) => item.botId === botId);
          if (!bot) throw error('NOT_FOUND', 'Bot not found');
          if (bot.archivedAt) throw error('BOT_ARCHIVED', 'Bot is archived');
          const current = turnContent(deviceId, bot);
          if (current.checksum !== checksum) throw error('TURN_SET_CHANGED', 'Desired set changed during admission');
          // Post-await 校验持久化部署计划身份：checksum 不覆盖 plan 的 artifact/digest/lock 身份，
          // 异步 prepare/confirm 间隙内 reconcile 若重建计划（新 planId/移除意图），事务内必须拒绝。
          const set = get('turn_sets', setId);
          const confirmedPlans = set?.plans ?? [];
          if (planFingerprint) {
            const storedFingerprint = createHash('sha256').update(JSON.stringify(confirmedPlans.map((plan) => ({
              installationId: plan.installationId, packageId: plan.packageId, kind: plan.kind,
              targetVersion: plan.targetVersion, artifactRef: plan.artifactRef ?? null,
              digest: plan.digest ?? null, lockfile: plan.lockfile ?? null, manifest: plan.manifest ?? null,
            })))).digest('hex');
            if (storedFingerprint !== planFingerprint) throw error('TURN_SET_CHANGED', 'Desired plans changed during admission');
          }
          for (const plan of confirmedPlans) {
            const persisted = parse(db.prepare('SELECT json FROM deployment_plans WHERE device_id = ? AND installation_id = ?').get(deviceId, plan.installationId));
            if (!persisted) throw error('TURN_SET_CHANGED', 'Desired plan was removed during admission');
            if (persisted.action === 'disable' || persisted.action === 'uninstall') {
              throw error('TURN_SET_CHANGED', 'Desired capability gained a removal plan during admission');
            }
            // 执行内容逐项比对（与 planIdentity 同口径）：planId/desiredRevision 是收据身份，
            // 同一禁用/启用周期可重建新计划而内容不变——不得据此拒绝；
            // 真实内容漂移（version/artifact/digest/lockfile/manifest）仍拒绝。
            if (persisted.targetVersion !== plan.targetVersion ||
                persisted.artifactRef !== plan.artifactRef || persisted.digest !== plan.digest ||
                !isDeepStrictEqual(persisted.lockfile ?? null, plan.lockfile ?? null) ||
                !isDeepStrictEqual(persisted.manifest ?? null, plan.manifest ?? null)) {
              throw error('TURN_SET_CHANGED', 'Desired plan content changed during admission');
            }
          }
          const existing = store.findTurnAdmission({ deviceId, botId, scopeKey, requestId });
          if (existing) {
            if (existing.fingerprint !== requestFingerprint || existing.setId !== setId) throw error('REQUEST_CONFLICT', 'Turn request conflicts');
            return existing;
          }
          const value = {
            admissionId: randomUUID(), deviceId, botId, scopeKey, requestId,
            setId, fingerprint: requestFingerprint, admittedAt: new Date().toISOString(),
          };
          db.prepare('INSERT INTO turn_admissions (id, device_id, bot_id, scope_key, request_id, set_id, fingerprint, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(value.admissionId, deviceId, botId, scopeKey, requestId, setId, requestFingerprint, json(value));
          return value;
        });
      },
      /** Hard revocation check for a stored set: present authorization and referenced credential revisions. */
      assertTurnAuthorization(deviceId, botId, set) {
        assertId(deviceId); assertId(botId); assertObject(set);
        const bots = executionContent(deviceId).bots;
        const current = bots.find((item) => item.botId === botId);
        if (!current) throw error('NOT_FOUND', 'Bot not found');
        const pinned = new Map((set.snapshot?.bots?.find((item) => item.botId === botId)?.capabilities ?? []).map((capability) => [capability.installationId, capability]));
        for (const [installationId, capability] of pinned) {
          if (!capability.authorized) continue;
          const now = current.capabilities.find((item) => item.installationId === installationId);
          if (!(now?.authorized ?? now?.enabled)) throw error('FORBIDDEN', 'Capability authorization was revoked');
        }
        // Adding a capability is an ordinary update: old admitted work may coexist and must NOT
        // invalidate stored pins. Only revoked authorization or rotated referenced credentials fail.
        for (const [ref, revision] of Object.entries(set.credentialRevisions ?? {})) {
          if ((credential(ref)?.revision ?? null) !== revision) throw error('FORBIDDEN', 'Referenced credential changed');
        }
      },
      getDeviceSnapshot(deviceId, linkUrl) {
        assertId(deviceId);
        return transaction(() => {
          const content = executionContent(deviceId);
          const desired = deviceDesired(deviceId, content);
          const credentials = Object.fromEntries([...content.refs].map((id) => [id, resolveCredential(assertPublicCredentialId(id))]));
          return { protocol: 1, deviceId, revision: desired.revision, linkUrl, providers: content.providers, models: content.models, bots: content.bots, credentials };
        }, 'DEFERRED');
      },
      // Client releases are distribution metadata, not execution config: none of
      // these methods call bump(), so device config revisions are unaffected.
      listClientReleases() {
        return db.prepare('SELECT json FROM client_releases ORDER BY created_at DESC, rowid DESC').all().map(parse);
      },
      getClientRelease(id) {
        assertId(id);
        return get('client_releases', id);
      },
      findClientRelease({ platform, arch, format, version }) {
        return parse(db.prepare('SELECT json FROM client_releases WHERE platform = ? AND arch = ? AND format = ? AND version = ?').get(platform, arch, format, version));
      },
      createClientRelease(record) {
        assertObject(record);
        assertId(record.id);
        return transaction(() => {
          if (store.findClientRelease(record)) throw error('REQUEST_CONFLICT', 'Client release already exists');
          db.prepare('INSERT INTO client_releases (id, platform, arch, format, version, published, created_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(record.id, record.platform, record.arch, record.format, record.version, record.published ? 1 : 0, record.createdAt, json(record));
          return record;
        });
      },
      setClientReleasePublished(id, published) {
        assertId(id);
        if (typeof published !== 'boolean') throw error('INVALID_ARGUMENT', 'published must be boolean');
        return transaction(() => {
          const current = store.getClientRelease(id);
          if (!current) throw error('NOT_FOUND', 'Client release not found');
          // The first publish timestamp is kept across later publish/unpublish cycles.
          const result = { ...current, published, publishedAt: published ? (current.publishedAt ?? new Date().toISOString()) : current.publishedAt };
          db.prepare('UPDATE client_releases SET published = ?, json = ? WHERE id = ?').run(result.published ? 1 : 0, json(result), id);
          return result;
        });
      },
      listPublishedClientReleases({ platform, arch, format } = {}) {
        return db.prepare(`SELECT json FROM client_releases WHERE published = 1
          AND (? IS NULL OR platform = ?) AND (? IS NULL OR arch = ?) AND (? IS NULL OR format = ?)
          ORDER BY created_at DESC, rowid DESC`)
          .all(platform ?? null, platform ?? null, arch ?? null, arch ?? null, format ?? null, format ?? null).map(parse);
      },
      close() { db.close(); },
    };
    return store;
  } catch (err) {
    try { db.close(); } catch { /* Preserve original error. */ }
    throw err;
  }
}
