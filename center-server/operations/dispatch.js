import { stableJson } from '../data/dispatch.js';

const MAX_ID_LEN = 128;
const MAX_REQUEST_ID_LEN = 200;
const MAX_MESSAGE_LEN = 32000;
const MAX_METADATA_BYTES = 16 * 1024;

const SEND_FIELDS = ['deviceId', 'botId', 'requestId', 'message', 'routeId', 'metadata'];
const GET_FIELDS = ['deviceId', 'botId', 'requestId'];
const LIST_TARGETS_FIELDS = [];
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fields(value, allowed) {
  if (!isPlainObject(value)) fail('INVALID_ARGUMENT', 'Expected an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('INVALID_ARGUMENT', `Unknown field: ${key}`);
  }
  return value;
}

function requiredText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value;
}

function requiredId(value, name, max = MAX_ID_LEN) {
  const raw = requiredText(value, name, max);
  if (raw !== raw.trim()) fail('INVALID_ARGUMENT', `Invalid ${name}`);
  return raw;
}

function normalizeMetadata(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('INVALID_ARGUMENT', 'metadata must be a plain JSON object');
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
    fail('INVALID_ARGUMENT', 'metadata exceeds 16 KiB limit');
  }
  return JSON.parse(encoded);
}

function resolveActor(actor) {
  if (!isPlainObject(actor) || (actor.kind !== 'oauth' && actor.kind !== 'bot')) {
    fail('UNAUTHENTICATED', 'Authenticated dispatch actor is required');
  }
  if (actor.kind === 'oauth') {
    if (typeof actor.clientId !== 'string' || !actor.clientId.trim() || actor.clientId.length > MAX_ID_LEN || !actor.clientId.isWellFormed()) {
      fail('UNAUTHENTICATED', 'Invalid OAuth client identity');
    }
    const clientId = actor.clientId.trim();
    return {
      kind: 'oauth',
      callerId: clientId,
      callerKey: `oauth:${clientId}`,
      botTargets: actor.botTargets,
      requireTargets: true,
    };
  }
  if (typeof actor.deviceId !== 'string' || !actor.deviceId.trim() || actor.deviceId.length > MAX_ID_LEN || !actor.deviceId.isWellFormed() ||
      typeof actor.botId !== 'string' || !actor.botId.trim() || actor.botId.length > MAX_ID_LEN || !actor.botId.isWellFormed()) {
    fail('UNAUTHENTICATED', 'Invalid Bot actor identity');
  }
  const deviceId = actor.deviceId.trim();
  const botId = actor.botId.trim();
  return {
    kind: 'bot',
    deviceId,
    botId,
    callerId: `${deviceId}:${botId}`,
    callerKey: `bot:${deviceId}:${botId}`,
    botTargets: actor.botTargets,
    requireTargets: actor.botTargets !== undefined,
  };
}

function findAuthorizedTarget(caller, deviceId, botId) {
  if (!caller.requireTargets) return null;
  if (!Array.isArray(caller.botTargets) || caller.botTargets.length === 0) {
    fail('FORBIDDEN', 'External dispatch is denied: no authorized Bot targets');
  }
  const matched = caller.botTargets.find((target) => (
    isPlainObject(target) &&
    typeof target.deviceId === 'string' &&
    typeof target.botId === 'string' &&
    target.deviceId === deviceId &&
    target.botId === botId
  ));
  if (!matched) {
    fail('FORBIDDEN', 'Target Bot is not authorized for this client');
  }
  return matched;
}

function assertRouteAuthorized(caller, matchedTarget, routeId) {
  if (routeId === null) return;
  // External OAuth callers cannot select arbitrary webhook routes merely by holding a botTarget,
  // because webhook routes carry owner-authored fixed instructions. Reject by default unless
  // an administrator explicitly approved the routeId on the matched target grant.
  if (caller.kind === 'oauth' || caller.requireTargets) {
    const approved = Array.isArray(matchedTarget?.approvedRouteIds)
      ? matchedTarget.approvedRouteIds
      : [];
    if (!approved.some((id) => typeof id === 'string' && id === routeId)) {
      fail('FORBIDDEN', 'External dispatch routeId is not approved for this client');
    }
  }
}

function assertDeviceExists(bridge, deviceId) {
  if (!bridge?.registry) return;
  const device = bridge.registry.get(deviceId);
  if (!device || device.revokedAt !== null || deviceId === bridge.deviceId) {
    fail('NOT_FOUND', 'Target device not found');
  }
}

function isValidTargetId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LEN &&
    value === value.trim() &&
    value.isWellFormed() &&
    !CONTROL_CHAR_RE.test(value)
  );
}

function isActiveRegisteredDevice(bridge, deviceId) {
  if (!isValidTargetId(deviceId) || deviceId.startsWith('center-')) return false;
  if (typeof bridge?.deviceId === 'string' && deviceId === bridge.deviceId) return false;
  if (typeof bridge?.registry?.get !== 'function') return false;
  const device = bridge.registry.get(deviceId);
  return Boolean(device && device.revokedAt === null);
}

function formatTargetBotName(bot, fallbackBotId) {
  if (typeof bot.name === 'string' && bot.name.trim()) return bot.name;
  if (typeof bot.role === 'string' && bot.role.trim()) return bot.role;
  return fallbackBotId;
}

function resolveVisibleTargets(caller, deps) {
  const rawTargets = caller.kind === 'oauth'
    ? (Array.isArray(caller.botTargets) ? caller.botTargets : [])
    : caller.requireTargets
      ? (Array.isArray(caller.botTargets) ? caller.botTargets : [])
      : [{ deviceId: caller.deviceId, botId: caller.botId }];

  if (rawTargets.length === 0 || typeof deps.store.listDeviceBots !== 'function') {
    return [];
  }

  const seen = new Set();
  const activeBotsByDevice = new Map();
  const targets = [];

  for (const entry of rawTargets) {
    if (!isPlainObject(entry)) continue;
    const { deviceId, botId } = entry;
    if (!isValidTargetId(deviceId) || !isValidTargetId(botId)) continue;
    const key = `${deviceId}\0${botId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!activeBotsByDevice.has(deviceId)) {
      if (!isActiveRegisteredDevice(deps.bridge, deviceId)) {
        activeBotsByDevice.set(deviceId, null);
      } else {
        const rawBots = deps.store.listDeviceBots(deviceId);
        const byBotId = new Map();
        if (Array.isArray(rawBots)) {
          for (const bot of rawBots) {
            if (
              isPlainObject(bot) &&
              typeof bot.botId === 'string' &&
              (bot.deviceId === undefined || bot.deviceId === deviceId) &&
              !bot.archivedAt
            ) {
              byBotId.set(bot.botId, bot);
            }
          }
        }
        activeBotsByDevice.set(deviceId, byBotId);
      }
    }

    const deviceBots = activeBotsByDevice.get(deviceId);
    if (!deviceBots) continue;
    const bot = deviceBots.get(botId);
    if (!bot) continue;

    targets.push({
      deviceId,
      botId,
      name: formatTargetBotName(bot, botId),
    });
  }

  return targets;
}

function notifyWebhookReady(deps, deviceId) {
  try {
    if (typeof deps.notifyWebhookReady === 'function') {
      deps.notifyWebhookReady(deviceId);
    } else if (typeof deps.notify === 'function') {
      deps.notify(deviceId, 'webhook-ready');
    }
  } catch {
    // Durable persistence already succeeded; Host periodic poll acts as fallback.
  }
}

function formatDispatchView(event, extra = {}) {
  return {
    requestId: event.clientRequestId,
    dispatchId: event.id,
    deviceId: event.deviceId,
    botId: event.botId,
    ...(event.routeId ? { routeId: event.routeId } : {}),
    status: event.status,
    completed: event.completed,
    acceptedAt: event.receivedAt,
    expiresAt: event.expiresAt,
    updatedAt: event.updatedAt,
    ...(event.admission ? { admission: event.admission } : {}),
    ...(event.error ? { error: event.error } : {}),
    answerText: event.status === 'succeeded' ? (event.answerText ?? '') : null,
    ...extra,
  };
}

export function createHandlers(deps) {
  if (!deps?.store || typeof deps.store.acceptDispatchMessage !== 'function' || typeof deps.store.getDispatchMessage !== 'function') {
    throw new Error('dispatch handlers require Center store with acceptDispatchMessage/getDispatchMessage');
  }

  return {
    async dispatch_send_bot_message(args, actor) {
      const caller = resolveActor(actor);
      const body = fields(args, SEND_FIELDS);
      const deviceId = requiredId(body.deviceId, 'deviceId');
      const botId = requiredId(body.botId, 'botId');
      const requestId = requiredId(body.requestId, 'requestId', MAX_REQUEST_ID_LEN);
      const message = requiredText(body.message, 'message', MAX_MESSAGE_LEN);
      const routeId = body.routeId === undefined ? null : requiredId(body.routeId, 'routeId');
      const metadata = normalizeMetadata(body.metadata);

      const matchedTarget = findAuthorizedTarget(caller, deviceId, botId);
      assertRouteAuthorized(caller, matchedTarget, routeId);
      assertDeviceExists(deps.bridge, deviceId);

      const { event, created } = deps.store.acceptDispatchMessage({
        callerKey: caller.callerKey,
        callerKind: caller.kind,
        callerId: caller.callerId,
        deviceId,
        botId,
        requestId,
        message,
        routeId,
        metadata,
      });

      if (created) notifyWebhookReady(deps, event.deviceId);
      return formatDispatchView(event, { created });
    },

    async dispatch_get_bot_message(args, actor) {
      const caller = resolveActor(actor);
      const body = fields(args, GET_FIELDS);
      const deviceId = requiredId(body.deviceId, 'deviceId');
      const botId = requiredId(body.botId, 'botId');
      const requestId = requiredId(body.requestId, 'requestId', MAX_REQUEST_ID_LEN);

      findAuthorizedTarget(caller, deviceId, botId);

      const event = deps.store.getDispatchMessage({
        callerKey: caller.callerKey,
        deviceId,
        botId,
        requestId,
      });
      if (!event) fail('NOT_FOUND', 'Dispatch message not found');
      return formatDispatchView(event);
    },

    async dispatch_list_targets(args = {}, actor) {
      const caller = resolveActor(actor);
      fields(args, LIST_TARGETS_FIELDS);
      return { targets: resolveVisibleTargets(caller, deps) };
    },
  };
}
