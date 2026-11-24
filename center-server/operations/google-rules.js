/**
 * Center automation operation handlers for already-authorized Google Workspace trigger rules
 * (Gmail `new_email` and Calendar `starting_soon`).
 *
 * Uses the existing Google rules service (`openGoogleRules`) through the fixed owner callbacks:
 * - `GET /api/google/rules`
 * - `POST /api/google/rules/save`
 * - `POST /api/google/rules/remove`
 * - `GET /api/google/rules/:id/events`
 * (with direct `deps.googleRules` / `deps.google.rules` fallback when `deps.owner` is absent).
 *
 * Security boundaries:
 * - Never invokes or exposes Google OAuth sign-in, client configuration, callback, account check,
 *   account removal, or scope/permission mutation routes (`/api/google/status`, `/configure`,
 *   `/authorize`, `/flow`, `/cancel`, `/check`, `/remove`, `/api/oauth/google/callback`).
 * - Rejects any caller-supplied OAuth credentials, tokens, codes, or scope/permission fields
 *   with `FORBIDDEN`.
 * - Never returns unauthorized email/calendar body content: event listings return sanitized
 *   delivery receipt metadata only (never `payload`, `text`, `body`, `snippet`, `subject`,
 *   `google`, or `instruction`), and error/diagnostic strings are secret-scrubbed.
 * - Bots and authorized OAuth MCP callers may create, update, rebind (`deviceId`, `botId`,
 *   `account`, `source`, `event`), pause, resume, and remove trigger rules on already-authorized
 *   Google accounts through `POST /api/google/rules/save`, which enforces device registry, active
 *   non-archived Bot, and connected account checks. Scoped OAuth callers remain restricted to
 *   their authorized `botTargets` for both existing and updated targets.
 */

const GOOGLE_RULE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FILTER_LENGTH = 200;
const MAX_ADDRESSES = 10;
const MAX_MINUTES_BEFORE = 24 * 60;

const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const FORBIDDEN_AUTH_FIELD_SET = new Set([
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'tokenhash',
  'token_hash',
  'clientsecret',
  'client_secret',
  'clientid',
  'client_id',
  'clientjson',
  'credentials',
  'credential',
  'oauth',
  'authcode',
  'auth_code',
  'code',
  'state',
  'pkce',
  'codeverifier',
  'code_verifier',
  'redirecturi',
  'redirect_uri',
  'scopes',
  'scope',
  'permissions',
  'permission',
  'grants',
  'grant',
  'choices',
  'authorization',
  'cookie',
  'cookies',
  'bearer',
  'password',
  'secret',
  'apikey',
  'api_key',
]);

const FORBIDDEN_BODY_KEYS = new Set([
  'payload',
  'payloadjson',
  'payload_json',
  'text',
  'body',
  'snippet',
  'html',
  'raw',
  'google',
  'subject',
  'actor',
  'instruction',
]);

const LIST_FIELDS = new Set(['deviceId', 'botId', 'account', 'enabled']);
const EVENTS_FIELDS = new Set(['id', 'limit']);
const SET_ENABLED_FIELDS = new Set(['id', 'enabled']);
const CREATE_FIELDS = new Set([
  'deviceId',
  'botId',
  'account',
  'source',
  'event',
  'name',
  'instruction',
  'enabled',
  'from',
  'to',
  'subjectContains',
  'label',
  'calendar',
  'minutesBefore',
]);
const UPDATE_MUTABLE_KEYS = [
  'deviceId',
  'botId',
  'account',
  'source',
  'event',
  'name',
  'instruction',
  'enabled',
  'from',
  'to',
  'subjectContains',
  'label',
  'calendar',
  'minutesBefore',
];
const UPDATE_FIELDS = new Set(['id', ...UPDATE_MUTABLE_KEYS]);
const REMOVE_FIELDS = new Set(['id']);

const ASSISTANT_EMPTY_FIELDS = new Set();
const ASSISTANT_CONFIGURE_MUTABLE_KEYS = [
  'enabled',
  'deviceId',
  'botId',
  'mode',
  'accounts',
  'batchWindowMinutes',
  'digestTimes',
  'calendarEnabled',
  'calendarLeadMinutes',
];
const ASSISTANT_CONFIGURE_FIELDS = new Set(ASSISTANT_CONFIGURE_MUTABLE_KEYS);
const FORBIDDEN_ASSISTANT_CONSENT_FIELDS = new Set([
  'hindsightprivatememory',
  'hindsight_private_memory',
]);
const ASSISTANT_DIGEST_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_ASSISTANT_ACCOUNTS = 20;
const MAX_ASSISTANT_DIGEST_TIMES = 6;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertWellFormedDeep(value) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) {
      fail('INVALID_ARGUMENT', 'String argument contains unpaired UTF-16 surrogates');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormedDeep(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (PROTOTYPE_KEYS.has(key)) {
        fail('INVALID_ARGUMENT', `Disallowed key: ${key}`);
      }
      assertWellFormedDeep(item);
    }
  }
}

function requirePlainObject(value, label = 'args') {
  if (!isPlainObject(value)) fail('INVALID_ARGUMENT', `${label} must be an object`);
  assertWellFormedDeep(value);
  return value;
}

function optionalPlainObject(value, label = 'args') {
  if (value === undefined) return {};
  return requirePlainObject(value, label);
}

function assertCleanFields(obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (PROTOTYPE_KEYS.has(key)) {
      fail('INVALID_ARGUMENT', `Disallowed field: ${key}`);
    }
    if (FORBIDDEN_AUTH_FIELD_SET.has(key.toLowerCase())) {
      fail('FORBIDDEN', `OAuth, credential, token, and permission field '${key}' is forbidden`);
    }
    if (!allowed.has(key)) {
      fail('INVALID_ARGUMENT', `Unknown field: ${key}`);
    }
  }
}

function assertNonEmptyText(value, field, maxLen) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > maxLen) {
    fail('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  return value;
}

function assertTrimmedId(value, field, maxLen = 128) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > maxLen) {
    fail('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  return trimmed;
}

function assertGoogleRuleId(value) {
  if (typeof value !== 'string' || !GOOGLE_RULE_ID_RE.test(value)) {
    fail('INVALID_ARGUMENT', 'Invalid Google rule id');
  }
  return value;
}

function normalizeOptionalFilterText(value, field) {
  if (value === null) return null;
  const raw = assertNonEmptyText(value, field, MAX_FILTER_LENGTH);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_FILTER_LENGTH) {
    fail('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  return trimmed;
}

function normalizeAddressListInput(value, field) {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    fail('INVALID_ARGUMENT', `${field} must be an array of strings or null`);
  }
  if (value.length > MAX_ADDRESSES) {
    fail('INVALID_ARGUMENT', `Too many ${field} entries`);
  }
  const cleaned = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry !== 'string' || !entry.isWellFormed()) {
      fail('INVALID_ARGUMENT', `Invalid ${field}[${i}]`);
    }
    const normalized = entry.trim().toLowerCase();
    if (!normalized || normalized.length > MAX_FILTER_LENGTH) {
      fail('INVALID_ARGUMENT', `Invalid ${field}[${i}]`);
    }
    cleaned.push(normalized);
  }
  const unique = [...new Set(cleaned)].sort();
  if (unique.length > MAX_ADDRESSES) {
    fail('INVALID_ARGUMENT', `Too many ${field} entries`);
  }
  return unique.length > 0 ? unique : null;
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
    const deviceId = assertTrimmedId(entry.deviceId, 'actor.botTargets.deviceId', 128);
    const botId = assertTrimmedId(entry.botId, 'actor.botTargets.botId', 128);
    targets.push({ deviceId, botId });
  }
  return targets;
}

function validateActor(actor) {
  if (!isPlainObject(actor)) {
    fail('UNAUTHENTICATED', 'Authenticated actor is required');
  }
  const botTargets = normalizeBotTargets(actor.botTargets);
  if (actor.kind === 'bot') {
    const deviceId = assertTrimmedId(actor.deviceId, 'actor.deviceId', 128);
    const botId = assertTrimmedId(actor.botId, 'actor.botId', 128);
    return { kind: 'bot', deviceId, botId, botTargets };
  }
  if (actor.kind === 'oauth') {
    const clientId = assertTrimmedId(actor.clientId, 'actor.clientId', 200);
    return { kind: 'oauth', clientId, botTargets };
  }
  fail('FORBIDDEN', 'Unsupported actor kind');
}

function isTargetAllowedByActor(actor, deviceId, botId) {
  if (!actor.botTargets) return true;
  return actor.botTargets.some(
    (target) => target.deviceId === deviceId && target.botId === botId,
  );
}

function assertActorRuleTargetAllowed(actor, rule) {
  if (!isTargetAllowedByActor(actor, rule.deviceId, rule.botId)) {
    fail('FORBIDDEN', 'Target Bot is not authorized for this caller');
  }
}

function scrubGoogleSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/\b1\/\/[A-Za-z0-9._-]{10,}/g, '[redacted-token]')
    .replace(/\bGOCSPX-[A-Za-z0-9._-]{6,}/g, '[redacted-secret]')
    .replace(
      /(["']?(?:client_secret|clientSecret|refresh_token|refreshToken|access_token|accessToken|id_token|idToken)["']?\s*[:=]\s*["']?)([^"'\s,&}]+)/gi,
      '$1[redacted]',
    );
}

function sanitizeGoogleRuleError(err) {
  if (err === null || err === undefined) return null;
  if (!isPlainObject(err)) return null;
  const out = {};
  if (typeof err.code === 'string' && err.code) out.code = err.code;
  if (typeof err.message === 'string' && err.message) {
    out.message = scrubGoogleSecrets(err.message).slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeLastDelivery(lastDelivery) {
  if (!isPlainObject(lastDelivery)) return null;
  return {
    eventId: typeof lastDelivery.eventId === 'string' ? lastDelivery.eventId : null,
    eventKey: typeof lastDelivery.eventKey === 'string' ? lastDelivery.eventKey : null,
    status: typeof lastDelivery.status === 'string' ? lastDelivery.status : null,
    occurredAt: typeof lastDelivery.occurredAt === 'string' ? lastDelivery.occurredAt : null,
    receivedAt: typeof lastDelivery.receivedAt === 'string' ? lastDelivery.receivedAt : null,
    updatedAt: typeof lastDelivery.updatedAt === 'string' ? lastDelivery.updatedAt : null,
    error: sanitizeGoogleRuleError(lastDelivery.error),
  };
}

function sanitizeGoogleRuleRuntime(runtime) {
  if (!isPlainObject(runtime)) return null;
  const enableUrl = typeof runtime.enableUrl === 'string' && runtime.enableUrl.startsWith('https://')
    ? runtime.enableUrl
    : null;
  return {
    status: typeof runtime.status === 'string' ? runtime.status : null,
    reason: typeof runtime.reason === 'string' ? runtime.reason : null,
    detail: typeof runtime.detail === 'string' ? scrubGoogleSecrets(runtime.detail).slice(0, 400) : null,
    enableUrl,
    lastCheckedAt: typeof runtime.lastCheckedAt === 'string' ? runtime.lastCheckedAt : null,
    lastEventAt: typeof runtime.lastEventAt === 'string' ? runtime.lastEventAt : null,
    backoffUntil: typeof runtime.backoffUntil === 'string' ? runtime.backoffUntil : null,
    rateLimited: Boolean(runtime.rateLimited),
    targetOnline: typeof runtime.targetOnline === 'boolean' ? runtime.targetOnline : null,
    pendingCount: Number.isInteger(runtime.pendingCount) ? runtime.pendingCount : 0,
    missedCount: Number.isInteger(runtime.missedCount) ? runtime.missedCount : 0,
    lastDelivery: sanitizeLastDelivery(runtime.lastDelivery),
  };
}

function sanitizeGoogleRule(rule) {
  if (!isPlainObject(rule)) return rule;
  const source = rule.source === 'gmail' || rule.source === 'calendar' ? rule.source : null;
  return {
    id: rule.id,
    name: rule.name,
    deviceId: rule.deviceId,
    botId: rule.botId,
    account: rule.account,
    source,
    event: source === 'gmail' ? 'new_email' : (source === 'calendar' ? 'starting_soon' : rule.event),
    enabled: Boolean(rule.enabled),
    ...(source === 'gmail' ? {
      ...(Array.isArray(rule.from) && rule.from.length ? { from: [...rule.from] } : {}),
      ...(Array.isArray(rule.to) && rule.to.length ? { to: [...rule.to] } : {}),
      ...(typeof rule.subjectContains === 'string' && rule.subjectContains ? { subjectContains: rule.subjectContains } : {}),
      ...(typeof rule.label === 'string' && rule.label ? { label: rule.label } : {}),
    } : source === 'calendar' ? {
      calendar: typeof rule.calendar === 'string' && rule.calendar ? rule.calendar : 'primary',
      minutesBefore: Number.isInteger(rule.minutesBefore) ? rule.minutesBefore : 10,
    } : {}),
    instruction: rule.instruction,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    listeningSince: typeof rule.listeningSince === 'string' ? rule.listeningSince : null,
    ...(rule.runtime !== undefined ? { runtime: sanitizeGoogleRuleRuntime(rule.runtime) } : {}),
  };
}

function sanitizeEventAdmission(admission) {
  if (admission === null || admission === undefined) return null;
  if (!isPlainObject(admission)) return null;
  const out = {};
  for (const [key, value] of Object.entries(admission)) {
    const lower = key.toLowerCase();
    if (PROTOTYPE_KEYS.has(key) || FORBIDDEN_AUTH_FIELD_SET.has(lower) || FORBIDDEN_BODY_KEYS.has(lower)) {
      continue;
    }
    if (typeof value === 'string') {
      out[key] = scrubGoogleSecrets(value).slice(0, 200);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean' || value === null) {
      out[key] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeGoogleRuleEvent(event) {
  if (!isPlainObject(event)) return event;
  return {
    id: event.id,
    ruleId: event.ruleId,
    ruleName: event.ruleName,
    deviceId: event.deviceId,
    botId: event.botId,
    account: event.account,
    source: event.source,
    requestId: event.requestId,
    eventKey: event.eventKey,
    status: event.status,
    cancelRequested: Boolean(event.cancelRequested),
    admission: sanitizeEventAdmission(event.admission),
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    expiresAt: event.expiresAt,
    updatedAt: event.updatedAt,
    error: sanitizeGoogleRuleError(event.error),
  };
}

function resolveRulesService(deps) {
  if (typeof deps?.googleRules?.manage === 'function') return deps.googleRules;
  if (typeof deps?.google?.rules?.manage === 'function') return deps.google.rules;
  return null;
}

async function invokeGoogleRules(deps, action, payload = {}) {
  if (typeof deps?.owner === 'function') {
    if (action === 'list') {
      return deps.owner('GET', '/api/google/rules', { params: {}, query: payload });
    }
    if (action === 'save') {
      return deps.owner('POST', '/api/google/rules/save', { params: {}, body: payload, query: {} });
    }
    if (action === 'remove') {
      return deps.owner('POST', '/api/google/rules/remove', { params: {}, body: { id: payload.id }, query: {} });
    }
    if (action === 'events') {
      const query = payload.limit !== undefined ? { limit: payload.limit } : {};
      return deps.owner('GET', '/api/google/rules/:id/events', { params: { id: payload.ruleId }, query });
    }
    fail('INTERNAL_ERROR', `Unsupported Google rules action: ${String(action)}`);
  }
  const service = resolveRulesService(deps);
  if (service) {
    return service.manage(action, payload);
  }
  fail('INTERNAL_ERROR', 'Google rules service is unavailable');
}

async function invokeGoogleAssistant(deps, action, payload = {}) {
  if (typeof deps?.owner === 'function') {
    if (action === 'get') {
      return deps.owner('GET', '/api/google/assistant', { params: {}, query: {} });
    }
    if (action === 'save') {
      return deps.owner('POST', '/api/google/assistant/save', { params: {}, body: payload, query: {} });
    }
    if (action === 'remove') {
      return deps.owner('POST', '/api/google/assistant/remove', { params: {}, body: {}, query: {} });
    }
    if (action === 'events') {
      const query = payload.limit !== undefined ? { limit: payload.limit } : {};
      return deps.owner('GET', '/api/google/assistant/events', { params: {}, query });
    }
    fail('INTERNAL_ERROR', `Unsupported Google assistant action: ${String(action)}`);
  }
  const service = resolveRulesService(deps);
  if (service && typeof service.assistantManage === 'function') {
    return service.assistantManage(action, payload);
  }
  fail('INTERNAL_ERROR', 'Proactive Google assistant service is unavailable');
}

function sanitizeGoogleAssistant(assistant) {
  if (!isPlainObject(assistant)) return null;
  const mode = assistant.mode === 'existing' ? 'existing' : 'dedicated';
  return {
    enabled: Boolean(assistant.enabled),
    deviceId: typeof assistant.deviceId === 'string' ? assistant.deviceId : '',
    botId: typeof assistant.botId === 'string' ? assistant.botId : '',
    mode,
    accounts: Array.isArray(assistant.accounts)
      ? assistant.accounts.filter((item) => typeof item === 'string' && item.trim())
      : [],
    batchWindowMinutes: Number.isInteger(assistant.batchWindowMinutes) ? assistant.batchWindowMinutes : 10,
    digestTimes: Array.isArray(assistant.digestTimes)
      ? assistant.digestTimes.filter((item) => typeof item === 'string' && ASSISTANT_DIGEST_TIME_RE.test(item))
      : [],
    calendarEnabled: Boolean(assistant.calendarEnabled),
    calendarLeadMinutes: Number.isInteger(assistant.calendarLeadMinutes) ? assistant.calendarLeadMinutes : 15,
    hindsightPrivateMemory: Boolean(assistant.hindsightPrivateMemory),
    revision: Number.isInteger(assistant.revision) ? assistant.revision : 1,
    listeningSince: typeof assistant.listeningSince === 'string' ? assistant.listeningSince : null,
    createdAt: typeof assistant.createdAt === 'string' ? assistant.createdAt : null,
    updatedAt: typeof assistant.updatedAt === 'string' ? assistant.updatedAt : null,
  };
}

function sanitizeGoogleAssistantRuntime(runtime) {
  if (!isPlainObject(runtime)) return null;
  return {
    status: typeof runtime.status === 'string' ? runtime.status : null,
    reason: typeof runtime.reason === 'string' ? runtime.reason : null,
    detail: typeof runtime.detail === 'string' ? scrubGoogleSecrets(runtime.detail).slice(0, 400) : null,
    lastCheckedAt: typeof runtime.lastCheckedAt === 'string' ? runtime.lastCheckedAt : null,
    lastEventAt: typeof runtime.lastEventAt === 'string' ? runtime.lastEventAt : null,
    pendingBucketCount: Number.isInteger(runtime.pendingBucketCount) ? runtime.pendingBucketCount : 0,
    pendingDeliveryCount: Number.isInteger(runtime.pendingDeliveryCount) ? runtime.pendingDeliveryCount : 0,
    missedCount: Number.isInteger(runtime.missedCount) ? runtime.missedCount : 0,
    targetOnline: typeof runtime.targetOnline === 'boolean' ? runtime.targetOnline : null,
    lastDelivery: sanitizeLastDelivery(runtime.lastDelivery),
  };
}

async function getExistingGoogleRule(deps, id) {
  if (typeof deps?.store?.getGoogleRule === 'function') {
    return deps.store.getGoogleRule(id);
  }
  const listed = await invokeGoogleRules(deps, 'list', {});
  const existing = Array.isArray(listed?.items)
    ? listed.items.find((item) => item && item.id === id)
    : null;
  if (!existing) fail('NOT_FOUND', 'Google rule not found');
  return existing;
}

function assertExistingRuleExplicitBinding(existing) {
  if (!isPlainObject(existing)) {
    fail('NOT_FOUND', 'Google rule not found');
  }
  const id = assertGoogleRuleId(existing.id);
  const deviceId = typeof existing.deviceId === 'string' && existing.deviceId.trim() && existing.deviceId.length <= 128
    ? existing.deviceId.trim()
    : fail('INVALID_STATE', 'Existing Google rule is missing an explicit target deviceId');
  const botId = typeof existing.botId === 'string' && existing.botId.trim() && existing.botId.length <= 128
    ? existing.botId.trim()
    : fail('INVALID_STATE', 'Existing Google rule is missing an explicit target botId');
  const account = typeof existing.account === 'string' && existing.account.trim() && existing.account.trim().length <= MAX_FILTER_LENGTH
    ? existing.account.trim().toLowerCase()
    : fail('INVALID_STATE', 'Existing Google rule is missing an explicit Google account');
  const source = existing.source === 'gmail' || existing.source === 'calendar'
    ? existing.source
    : fail('INVALID_STATE', 'Existing Google rule has an unsupported source');
  const instruction = typeof existing.instruction === 'string' && existing.instruction.trim() && existing.instruction.length <= 8000
    ? existing.instruction
    : fail('INVALID_STATE', 'Existing Google rule is missing an instruction');
  const name = typeof existing.name === 'string' && existing.name.trim() && existing.name.trim().length <= 80
    ? existing.name.trim()
    : undefined;

  return {
    id,
    deviceId,
    botId,
    account,
    source,
    event: source === 'gmail' ? 'new_email' : 'starting_soon',
    instruction,
    name,
    enabled: Boolean(existing.enabled),
    from: Array.isArray(existing.from) && existing.from.length ? [...existing.from] : undefined,
    to: Array.isArray(existing.to) && existing.to.length ? [...existing.to] : undefined,
    subjectContains: typeof existing.subjectContains === 'string' && existing.subjectContains ? existing.subjectContains : undefined,
    label: typeof existing.label === 'string' && existing.label ? existing.label : undefined,
    calendar: typeof existing.calendar === 'string' && existing.calendar ? existing.calendar : 'primary',
    minutesBefore: Number.isInteger(existing.minutesBefore) ? existing.minutesBefore : 10,
  };
}

function assertSourceAndEvent(source, event) {
  if (source !== 'gmail' && source !== 'calendar') {
    fail('INVALID_ARGUMENT', 'source must be gmail or calendar');
  }
  const expectedEvent = source === 'gmail' ? 'new_email' : 'starting_soon';
  if (event !== undefined && event !== expectedEvent) {
    fail('INVALID_ARGUMENT', `event must be ${expectedEvent} for ${source}`);
  }
  return { source, event: expectedEvent };
}

function resolveCreateTarget(inputArgs, actor) {
  let deviceId;
  let botId;
  if (actor.kind === 'bot') {
    deviceId = inputArgs.deviceId !== undefined
      ? assertTrimmedId(inputArgs.deviceId, 'deviceId', 128)
      : actor.deviceId;
    if (inputArgs.botId !== undefined) {
      botId = assertTrimmedId(inputArgs.botId, 'botId', 128);
    } else if (deviceId === actor.deviceId) {
      botId = actor.botId;
    } else {
      fail('INVALID_ARGUMENT', 'botId is required when targeting a different deviceId');
    }
  } else {
    deviceId = assertTrimmedId(inputArgs.deviceId, 'deviceId', 128);
    botId = assertTrimmedId(inputArgs.botId, 'botId', 128);
  }
  assertActorRuleTargetAllowed(actor, { deviceId, botId });
  return { deviceId, botId };
}

function extractSourceFilters(inputArgs, source) {
  const hasGmailFields = inputArgs.from !== undefined
    || inputArgs.to !== undefined
    || inputArgs.subjectContains !== undefined
    || inputArgs.label !== undefined;
  const hasCalendarFields = inputArgs.calendar !== undefined
    || inputArgs.minutesBefore !== undefined;

  const filters = {};
  if (source === 'gmail') {
    if (hasCalendarFields) {
      fail('INVALID_ARGUMENT', 'calendar and minutesBefore are not valid for gmail rules');
    }
    if (inputArgs.from !== undefined) {
      filters.from = normalizeAddressListInput(inputArgs.from, 'from');
    }
    if (inputArgs.to !== undefined) {
      filters.to = normalizeAddressListInput(inputArgs.to, 'to');
    }
    if (inputArgs.subjectContains !== undefined) {
      filters.subjectContains = normalizeOptionalFilterText(inputArgs.subjectContains, 'subjectContains');
    }
    if (inputArgs.label !== undefined) {
      filters.label = normalizeOptionalFilterText(inputArgs.label, 'label');
    }
  } else {
    if (hasGmailFields) {
      fail('INVALID_ARGUMENT', 'from, to, subjectContains, and label are not valid for calendar rules');
    }
    if (inputArgs.calendar !== undefined) {
      filters.calendar = normalizeOptionalFilterText(inputArgs.calendar, 'calendar');
    }
    if (inputArgs.minutesBefore !== undefined) {
      if (
        !Number.isSafeInteger(inputArgs.minutesBefore)
        || inputArgs.minutesBefore < 0
        || inputArgs.minutesBefore > MAX_MINUTES_BEFORE
      ) {
        fail('INVALID_ARGUMENT', `minutesBefore must be an integer between 0 and ${MAX_MINUTES_BEFORE}`);
      }
      filters.minutesBefore = inputArgs.minutesBefore;
    }
  }
  return filters;
}

function buildPreservedSaveBody(bound, patch = {}) {
  const nextSource = patch.source !== undefined ? patch.source : bound.source;
  const nextEvent = nextSource === 'gmail' ? 'new_email' : 'starting_soon';
  const sameSource = nextSource === bound.source;
  const body = {
    id: bound.id,
    deviceId: patch.deviceId !== undefined ? patch.deviceId : bound.deviceId,
    botId: patch.botId !== undefined ? patch.botId : bound.botId,
    account: patch.account !== undefined ? patch.account : bound.account,
    source: nextSource,
    event: nextEvent,
    enabled: patch.enabled !== undefined ? patch.enabled : bound.enabled,
    instruction: patch.instruction !== undefined ? patch.instruction : bound.instruction,
  };
  if (patch.name !== undefined) {
    body.name = patch.name;
  } else if (bound.name !== undefined) {
    body.name = bound.name;
  }

  if (nextSource === 'gmail') {
    if (patch.from !== undefined) {
      body.from = patch.from;
    } else if (sameSource && bound.from !== undefined) {
      body.from = bound.from;
    }
    if (patch.to !== undefined) {
      body.to = patch.to;
    } else if (sameSource && bound.to !== undefined) {
      body.to = bound.to;
    }
    if (patch.subjectContains !== undefined) {
      body.subjectContains = patch.subjectContains;
    } else if (sameSource && bound.subjectContains !== undefined) {
      body.subjectContains = bound.subjectContains;
    }
    if (patch.label !== undefined) {
      body.label = patch.label;
    } else if (sameSource && bound.label !== undefined) {
      body.label = bound.label;
    }
  } else {
    body.calendar = patch.calendar !== undefined
      ? (patch.calendar === null ? 'primary' : patch.calendar)
      : (sameSource ? bound.calendar : 'primary');
    body.minutesBefore = patch.minutesBefore !== undefined
      ? patch.minutesBefore
      : (sameSource ? bound.minutesBefore : 10);
  }

  return body;
}

export function createGoogleRuleHandlers(deps = {}) {
  return {
    async automation_google_rule_list(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = optionalPlainObject(args);
      assertCleanFields(inputArgs, LIST_FIELDS);

      const query = {};
      if (inputArgs.deviceId !== undefined) {
        query.deviceId = assertTrimmedId(inputArgs.deviceId, 'deviceId', 128);
      }
      if (inputArgs.botId !== undefined) {
        query.botId = assertTrimmedId(inputArgs.botId, 'botId', 128);
      }
      if (inputArgs.account !== undefined) {
        query.account = assertNonEmptyText(inputArgs.account, 'account', MAX_FILTER_LENGTH).trim().toLowerCase();
      }
      if (inputArgs.enabled !== undefined) {
        if (typeof inputArgs.enabled !== 'boolean') {
          fail('INVALID_ARGUMENT', 'Invalid enabled');
        }
        query.enabled = inputArgs.enabled;
      }

      const res = await invokeGoogleRules(deps, 'list', query);
      const rawItems = Array.isArray(res?.items) ? res.items : [];
      const items = rawItems
        .filter((rule) => isPlainObject(rule) && isTargetAllowedByActor(actor, rule.deviceId, rule.botId))
        .map(sanitizeGoogleRule);
      return { items };
    },

    async automation_google_rule_events_list(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      assertCleanFields(inputArgs, EVENTS_FIELDS);

      const id = assertGoogleRuleId(inputArgs.id);
      let limit;
      if (inputArgs.limit !== undefined) {
        if (!Number.isSafeInteger(inputArgs.limit) || inputArgs.limit < 1 || inputArgs.limit > 200) {
          fail('INVALID_ARGUMENT', 'limit must be an integer between 1 and 200');
        }
        limit = inputArgs.limit;
      }

      if (actor.botTargets) {
        const existing = await getExistingGoogleRule(deps, id);
        assertActorRuleTargetAllowed(actor, existing);
      }

      const res = await invokeGoogleRules(deps, 'events', {
        ruleId: id,
        ...(limit !== undefined ? { limit } : {}),
      });
      return {
        items: Array.isArray(res?.items) ? res.items.map(sanitizeGoogleRuleEvent) : [],
      };
    },

    async automation_google_rule_create(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      assertCleanFields(inputArgs, CREATE_FIELDS);

      const { source, event } = assertSourceAndEvent(inputArgs.source, inputArgs.event);
      const { deviceId, botId } = resolveCreateTarget(inputArgs, actor);
      const instruction = assertNonEmptyText(inputArgs.instruction, 'instruction', 8000);

      let enabled = true;
      if (inputArgs.enabled !== undefined) {
        if (typeof inputArgs.enabled !== 'boolean') {
          fail('INVALID_ARGUMENT', 'enabled must be a boolean');
        }
        enabled = inputArgs.enabled;
      }

      let name;
      if (inputArgs.name !== undefined) {
        name = assertNonEmptyText(inputArgs.name, 'name', 80).trim();
      }

      let account;
      if (inputArgs.account !== undefined) {
        account = assertNonEmptyText(inputArgs.account, 'account', MAX_FILTER_LENGTH).trim().toLowerCase();
      }

      const filters = extractSourceFilters(inputArgs, source);
      const body = {
        deviceId,
        botId,
        source,
        event,
        enabled,
        instruction,
        ...(name !== undefined ? { name } : {}),
        ...(account !== undefined ? { account } : {}),
      };

      if (source === 'gmail') {
        if (filters.from) body.from = filters.from;
        if (filters.to) body.to = filters.to;
        if (filters.subjectContains) body.subjectContains = filters.subjectContains;
        if (filters.label) body.label = filters.label;
      } else {
        body.calendar = filters.calendar === undefined || filters.calendar === null ? 'primary' : filters.calendar;
        body.minutesBefore = filters.minutesBefore !== undefined ? filters.minutesBefore : 10;
      }

      const res = await invokeGoogleRules(deps, 'save', body);
      return {
        rule: sanitizeGoogleRule(res?.rule ?? res),
      };
    },

    async automation_google_rule_set_enabled(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      assertCleanFields(inputArgs, SET_ENABLED_FIELDS);

      const id = assertGoogleRuleId(inputArgs.id);
      if (typeof inputArgs.enabled !== 'boolean') {
        fail('INVALID_ARGUMENT', 'enabled must be a boolean');
      }

      const existing = await getExistingGoogleRule(deps, id);
      const bound = assertExistingRuleExplicitBinding(existing);
      assertActorRuleTargetAllowed(actor, bound);

      const body = buildPreservedSaveBody(bound, { enabled: inputArgs.enabled });
      const res = await invokeGoogleRules(deps, 'save', body);
      return {
        rule: sanitizeGoogleRule(res?.rule ?? res),
      };
    },

    async automation_google_rule_update(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      assertCleanFields(inputArgs, UPDATE_FIELDS);

      const id = assertGoogleRuleId(inputArgs.id);
      if (!UPDATE_MUTABLE_KEYS.some((key) => inputArgs[key] !== undefined)) {
        fail('INVALID_ARGUMENT', 'At least one mutable Google rule field must be provided to update');
      }

      const existing = await getExistingGoogleRule(deps, id);
      const bound = assertExistingRuleExplicitBinding(existing);
      assertActorRuleTargetAllowed(actor, bound);

      const patch = {};

      if (inputArgs.deviceId !== undefined) {
        patch.deviceId = assertTrimmedId(inputArgs.deviceId, 'deviceId', 128);
      }
      if (inputArgs.botId !== undefined) {
        patch.botId = assertTrimmedId(inputArgs.botId, 'botId', 128);
      }
      assertActorRuleTargetAllowed(actor, {
        deviceId: patch.deviceId ?? bound.deviceId,
        botId: patch.botId ?? bound.botId,
      });

      if (inputArgs.account !== undefined) {
        patch.account = assertNonEmptyText(inputArgs.account, 'account', MAX_FILTER_LENGTH).trim().toLowerCase();
      }
      const { source: nextSource } = assertSourceAndEvent(
        inputArgs.source !== undefined ? inputArgs.source : bound.source,
        inputArgs.event,
      );
      if (inputArgs.source !== undefined) {
        patch.source = nextSource;
      }

      if (inputArgs.name !== undefined) {
        patch.name = assertNonEmptyText(inputArgs.name, 'name', 80).trim();
      }
      if (inputArgs.instruction !== undefined) {
        patch.instruction = assertNonEmptyText(inputArgs.instruction, 'instruction', 8000);
      }
      if (inputArgs.enabled !== undefined) {
        if (typeof inputArgs.enabled !== 'boolean') {
          fail('INVALID_ARGUMENT', 'enabled must be a boolean');
        }
        patch.enabled = inputArgs.enabled;
      }

      Object.assign(patch, extractSourceFilters(inputArgs, nextSource));

      const body = buildPreservedSaveBody(bound, patch);
      const res = await invokeGoogleRules(deps, 'save', body);
      return {
        rule: sanitizeGoogleRule(res?.rule ?? res),
      };
    },

    async automation_google_rule_remove(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      assertCleanFields(inputArgs, REMOVE_FIELDS);

      const id = assertGoogleRuleId(inputArgs.id);
      if (actor.botTargets) {
        const existing = await getExistingGoogleRule(deps, id);
        assertActorRuleTargetAllowed(actor, existing);
      }

      const res = await invokeGoogleRules(deps, 'remove', { id });
      return {
        removed: true,
        id,
        ...(res?.rule ? { rule: sanitizeGoogleRule(res.rule) } : {}),
      };
    },

    async automation_google_assistant_get(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = optionalPlainObject(args);
      assertCleanFields(inputArgs, ASSISTANT_EMPTY_FIELDS);

      const res = await invokeGoogleAssistant(deps, 'get');
      const assistant = sanitizeGoogleAssistant(res?.assistant);
      if (!assistant) {
        return { assistant: null, runtime: null };
      }
      if (!isTargetAllowedByActor(actor, assistant.deviceId, assistant.botId)) {
        return { assistant: null, runtime: null };
      }
      return {
        assistant,
        runtime: sanitizeGoogleAssistantRuntime(res?.runtime),
      };
    },

    async automation_google_assistant_configure(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);

      for (const key of Object.keys(inputArgs)) {
        if (PROTOTYPE_KEYS.has(key)) {
          fail('INVALID_ARGUMENT', `Disallowed field: ${key}`);
        }
        const lower = key.toLowerCase();
        if (FORBIDDEN_AUTH_FIELD_SET.has(lower)) {
          fail('FORBIDDEN', `OAuth, credential, token, and permission field '${key}' is forbidden`);
        }
        if (FORBIDDEN_ASSISTANT_CONSENT_FIELDS.has(lower)) {
          fail('FORBIDDEN', 'hindsightPrivateMemory consent can only be configured by the Center owner');
        }
        if (!ASSISTANT_CONFIGURE_FIELDS.has(key)) {
          fail('INVALID_ARGUMENT', `Unknown field: ${key}`);
        }
      }

      if (!ASSISTANT_CONFIGURE_MUTABLE_KEYS.some((key) => inputArgs[key] !== undefined)) {
        fail('INVALID_ARGUMENT', 'At least one mutable assistant field must be provided');
      }

      const currentRes = await invokeGoogleAssistant(deps, 'get');
      const existing = isPlainObject(currentRes?.assistant) ? currentRes.assistant : null;
      if (existing) {
        assertActorRuleTargetAllowed(actor, existing);
      }

      let deviceId;
      let botId;
      if (existing) {
        deviceId = inputArgs.deviceId !== undefined
          ? assertTrimmedId(inputArgs.deviceId, 'deviceId', 128)
          : existing.deviceId;
        botId = inputArgs.botId !== undefined
          ? assertTrimmedId(inputArgs.botId, 'botId', 128)
          : existing.botId;
        assertActorRuleTargetAllowed(actor, { deviceId, botId });
      } else {
        ({ deviceId, botId } = resolveCreateTarget(inputArgs, actor));
      }

      const sameTarget = Boolean(existing && deviceId === existing.deviceId && botId === existing.botId);
      const body = {
        deviceId,
        botId,
        // Preserve owner-granted private memory ONLY when target Bot is unchanged;
        // creating or redirecting to a different Bot always resets hindsightPrivateMemory to false.
        hindsightPrivateMemory: sameTarget ? Boolean(existing.hindsightPrivateMemory) : false,
      };

      if (inputArgs.enabled !== undefined) {
        if (typeof inputArgs.enabled !== 'boolean') {
          fail('INVALID_ARGUMENT', 'enabled must be a boolean');
        }
        body.enabled = inputArgs.enabled;
      }

      if (inputArgs.mode !== undefined) {
        if (inputArgs.mode !== 'dedicated' && inputArgs.mode !== 'existing') {
          fail('INVALID_ARGUMENT', 'mode must be dedicated or existing');
        }
        body.mode = inputArgs.mode;
      }

      if (inputArgs.accounts !== undefined) {
        if (!Array.isArray(inputArgs.accounts) || inputArgs.accounts.length === 0 || inputArgs.accounts.length > MAX_ASSISTANT_ACCOUNTS) {
          fail('INVALID_ARGUMENT', `accounts must contain 1 to ${MAX_ASSISTANT_ACCOUNTS} entries`);
        }
        const cleaned = [];
        for (let i = 0; i < inputArgs.accounts.length; i += 1) {
          const entry = assertNonEmptyText(inputArgs.accounts[i], `accounts[${i}]`, MAX_FILTER_LENGTH).trim().toLowerCase();
          cleaned.push(entry);
        }
        body.accounts = [...new Set(cleaned)].sort();
      }

      if (inputArgs.batchWindowMinutes !== undefined) {
        if (!Number.isSafeInteger(inputArgs.batchWindowMinutes) || inputArgs.batchWindowMinutes < 1 || inputArgs.batchWindowMinutes > MAX_MINUTES_BEFORE) {
          fail('INVALID_ARGUMENT', `batchWindowMinutes must be an integer between 1 and ${MAX_MINUTES_BEFORE}`);
        }
        body.batchWindowMinutes = inputArgs.batchWindowMinutes;
      }

      if (inputArgs.digestTimes !== undefined) {
        if (!Array.isArray(inputArgs.digestTimes) || inputArgs.digestTimes.length > MAX_ASSISTANT_DIGEST_TIMES) {
          fail('INVALID_ARGUMENT', `digestTimes must be an array of at most ${MAX_ASSISTANT_DIGEST_TIMES} HH:mm strings`);
        }
        const times = [];
        for (let i = 0; i < inputArgs.digestTimes.length; i += 1) {
          const entry = inputArgs.digestTimes[i];
          if (typeof entry !== 'string' || !entry.isWellFormed() || !ASSISTANT_DIGEST_TIME_RE.test(entry.trim())) {
            fail('INVALID_ARGUMENT', `Invalid digestTimes[${i}]`);
          }
          times.push(entry.trim());
        }
        body.digestTimes = [...new Set(times)].sort();
      }

      if (inputArgs.calendarEnabled !== undefined) {
        if (typeof inputArgs.calendarEnabled !== 'boolean') {
          fail('INVALID_ARGUMENT', 'calendarEnabled must be a boolean');
        }
        body.calendarEnabled = inputArgs.calendarEnabled;
      }

      if (inputArgs.calendarLeadMinutes !== undefined) {
        if (!Number.isSafeInteger(inputArgs.calendarLeadMinutes) || inputArgs.calendarLeadMinutes < 0 || inputArgs.calendarLeadMinutes > MAX_MINUTES_BEFORE) {
          fail('INVALID_ARGUMENT', `calendarLeadMinutes must be an integer between 0 and ${MAX_MINUTES_BEFORE}`);
        }
        body.calendarLeadMinutes = inputArgs.calendarLeadMinutes;
      }

      const res = await invokeGoogleAssistant(deps, 'save', body);
      return {
        assistant: sanitizeGoogleAssistant(res?.assistant),
        runtime: sanitizeGoogleAssistantRuntime(res?.runtime),
      };
    },

    async automation_google_assistant_remove(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = optionalPlainObject(args);
      assertCleanFields(inputArgs, ASSISTANT_EMPTY_FIELDS);

      if (actor.botTargets) {
        const currentRes = await invokeGoogleAssistant(deps, 'get');
        const existing = isPlainObject(currentRes?.assistant) ? currentRes.assistant : null;
        if (existing) {
          assertActorRuleTargetAllowed(actor, existing);
        }
      }

      const res = await invokeGoogleAssistant(deps, 'remove', {});
      return { removed: Boolean(res?.removed) };
    },
  };
}
