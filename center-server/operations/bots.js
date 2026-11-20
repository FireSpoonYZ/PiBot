import { randomUUID } from 'node:crypto';

const MAX_SOUL_BYTES = 64 * 1024;
const MAX_ID_BYTES = 256;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const VISIBLE_ASCII_DEVICE_ID_RE = /^[\x21-\x7e]{1,200}$/;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

const AVATAR_SHAPES = new Set([
  'blob',
  'cloud',
  'squircle',
  'gem',
  'bean',
  'arch',
  'crystal',
  'teardrop',
  'pebble',
  'wedge',
  'shield',
  'dome',
  'hex',
  'leaf',
  'egg',
  'tablet',
  'capsule',
  'cylinder',
]);

const AVATAR_KEYS = new Set([
  'id',
  'shape',
  'color',
  'rotation',
  'expressionIndex',
  'labelZh',
  'labelEn',
]);

const THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

const SESSION_ACTIONS = new Set([
  'stop',
  'clear_history',
  'compact',
]);

const OFFLINE_ERROR_CODES = new Set([
  'DEVICE_OFFLINE',
  'OFFLINE',
  'NOT_CONNECTED',
  'DISCONNECTED',
  'CONNECT_FAILED',
  'TIMEOUT',
  'CALL_TIMEOUT',
]);

const LIST_ARGS_KEYS = new Set(['deviceId', 'includeArchived', 'offset', 'limit']);
const TARGET_BOT_ARGS_KEYS = new Set(['deviceId', 'botId']);
const CREATE_BOT_ARGS_KEYS = new Set(['deviceId', 'name', 'description', 'cwd', 'makePrimary', 'requestId']);
const UPDATE_PROFILE_ARGS_KEYS = new Set(['deviceId', 'botId', 'name', 'description']);
const SET_MODEL_ARGS_KEYS = new Set([
  'deviceId',
  'botId',
  'expectedRevision',
  'modelRef',
  'thinkingLevel',
  'codemode',
  'codemodeOnly',
]);
const SET_SOUL_ARGS_KEYS = new Set(['deviceId', 'botId', 'expectedRevision', 'text']);
const SET_CWD_ARGS_KEYS = new Set(['deviceId', 'botId', 'expectedRevision', 'cwd']);
const SET_AVATAR_ARGS_KEYS = new Set(['deviceId', 'botId', 'expectedRevision', 'avatar']);
const SESSION_CONTROL_ARGS_KEYS = new Set(['deviceId', 'botId', 'action']);

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertArgsObject(args, allowedKeys, { allowUndefined = false } = {}) {
  if (args === undefined && allowUndefined) return {};
  if (!isPlainObject(args)) {
    fail('INVALID_ARGUMENT', 'Expected an object of arguments');
  }
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      fail('INVALID_ARGUMENT', `Unknown argument: ${key}`);
    }
  }
  return args;
}

function isInternalDeviceId(deviceId, bridge) {
  if (typeof deviceId !== 'string') return true;
  if (deviceId.startsWith('center-')) return true;
  if (typeof bridge?.deviceId === 'string' && deviceId === bridge.deviceId) return true;
  return false;
}

function assertDeviceTarget(value, bridge) {
  if (
    typeof value !== 'string' ||
    !VISIBLE_ASCII_DEVICE_ID_RE.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    fail('INVALID_ARGUMENT', 'Invalid deviceId');
  }
  if (isInternalDeviceId(value, bridge)) {
    fail('NOT_FOUND', 'Device not found');
  }
  return value;
}

function assertBotId(value) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES ||
    CONTROL_CHARS_RE.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    fail('INVALID_ARGUMENT', 'Invalid botId');
  }
  return value;
}

function assertRequestId(value) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim() === '' ||
    value.length > 128 ||
    CONTROL_CHARS_RE.test(value)
  ) {
    fail('INVALID_ARGUMENT', 'Invalid requestId');
  }
  return value;
}

function assertRevision(value, name = 'expectedRevision') {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_ARGUMENT', `${name} must be a non-negative integer`);
  }
  return value;
}

function assertBotName(value) {
  if (
    typeof value !== 'string' ||
    !value.isWellFormed() ||
    value.trim().length < 1 ||
    value.trim().length > 120 ||
    CONTROL_CHARS_RE.test(value)
  ) {
    fail('INVALID_ARGUMENT', 'name must be 1 to 120 non-blank characters');
  }
  return value;
}

function assertBotDescription(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > 2000) {
    fail('INVALID_ARGUMENT', 'description must be a well-formed string of at most 2000 characters');
  }
  return value;
}

function isAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.isWellFormed() &&
    value.trim() === value &&
    !CONTROL_CHARS_RE.test(value) &&
    (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/]+[^\\/]+/.test(value))
  );
}

function assertAbsoluteCwd(value) {
  if (!isAbsolutePath(value)) {
    fail('INVALID_ARGUMENT', 'cwd must be a non-empty absolute path on the target Host');
  }
  return value;
}

function assertSoulRevision(value) {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    fail('INVALID_ARGUMENT', 'expectedRevision must be a lowercase 64-character hex SHA-256');
  }
  return value;
}

function assertSoulText(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', 'text must be well-formed UTF-8 text');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SOUL_BYTES) {
    fail('INVALID_ARGUMENT', 'text exceeds the 64 KiB SOUL limit');
  }
  return value;
}

function normalizeAvatarInput(raw) {
  if (raw === null) return null;
  if (!isPlainObject(raw)) {
    fail('INVALID_ARGUMENT', 'avatar must be a structured BotAvatar object or null');
  }
  for (const key of Object.keys(raw)) {
    if (!AVATAR_KEYS.has(key)) {
      fail('INVALID_ARGUMENT', `avatar has unknown field: ${key}`);
    }
  }
  if (
    typeof raw.id !== 'string' ||
    !raw.id.isWellFormed() ||
    raw.id.trim().length < 1 ||
    raw.id.length > 128 ||
    CONTROL_CHARS_RE.test(raw.id)
  ) {
    fail('INVALID_ARGUMENT', 'avatar.id must be a non-empty string of at most 128 characters');
  }
  if (typeof raw.shape !== 'string' || !AVATAR_SHAPES.has(raw.shape)) {
    fail('INVALID_ARGUMENT', 'avatar.shape is not a supported shape');
  }
  if (typeof raw.color !== 'string' || !HEX_COLOR_RE.test(raw.color)) {
    fail('INVALID_ARGUMENT', 'avatar.color must be a 6-digit hex color (#RRGGBB)');
  }
  if (typeof raw.rotation !== 'number' || !Number.isFinite(raw.rotation) || raw.rotation < -360 || raw.rotation > 360) {
    fail('INVALID_ARGUMENT', 'avatar.rotation must be a finite number between -360 and 360');
  }
  if (!Number.isSafeInteger(raw.expressionIndex) || raw.expressionIndex < 0 || raw.expressionIndex > 5) {
    fail('INVALID_ARGUMENT', 'avatar.expressionIndex must be an integer between 0 and 5');
  }
  if (
    typeof raw.labelZh !== 'string' ||
    !raw.labelZh.isWellFormed() ||
    raw.labelZh.length > 128 ||
    CONTROL_CHARS_RE.test(raw.labelZh)
  ) {
    fail('INVALID_ARGUMENT', 'avatar.labelZh must be a string of at most 128 characters');
  }
  if (
    typeof raw.labelEn !== 'string' ||
    !raw.labelEn.isWellFormed() ||
    raw.labelEn.length > 128 ||
    CONTROL_CHARS_RE.test(raw.labelEn)
  ) {
    fail('INVALID_ARGUMENT', 'avatar.labelEn must be a string of at most 128 characters');
  }
  return {
    id: raw.id,
    shape: raw.shape,
    color: raw.color,
    rotation: raw.rotation,
    expressionIndex: raw.expressionIndex,
    labelZh: raw.labelZh,
    labelEn: raw.labelEn,
  };
}

function isSelfTarget(actor, deviceId, botId) {
  return Boolean(
    actor &&
      typeof actor === 'object' &&
      actor.kind === 'bot' &&
      typeof actor.deviceId === 'string' &&
      typeof actor.botId === 'string' &&
      actor.deviceId === deviceId &&
      actor.botId === botId,
  );
}

function assertNotSelf(actor, deviceId, botId, actionLabel) {
  if (isSelfTarget(actor, deviceId, botId)) {
    fail('FORBIDDEN', `Calling Bot cannot ${actionLabel} itself during its own turn`);
  }
}

function sanitizeDevice(raw) {
  if (!isPlainObject(raw)) return null;
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : '';
  return {
    deviceId,
    name: typeof raw.name === 'string' && raw.name ? raw.name : deviceId,
    platform: typeof raw.platform === 'string' ? raw.platform : null,
    online: Boolean(raw.online),
  };
}

function sanitizeAvatar(raw) {
  if (!isPlainObject(raw)) return null;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.shape !== 'string' ||
    !AVATAR_SHAPES.has(raw.shape) ||
    typeof raw.color !== 'string' ||
    !HEX_COLOR_RE.test(raw.color) ||
    typeof raw.rotation !== 'number' ||
    !Number.isFinite(raw.rotation) ||
    raw.rotation < -360 ||
    raw.rotation > 360 ||
    !Number.isSafeInteger(raw.expressionIndex) ||
    raw.expressionIndex < 0 ||
    raw.expressionIndex > 5 ||
    typeof raw.labelZh !== 'string' ||
    typeof raw.labelEn !== 'string'
  ) {
    return null;
  }
  return {
    id: raw.id,
    shape: raw.shape,
    color: raw.color,
    rotation: raw.rotation,
    expressionIndex: raw.expressionIndex,
    labelZh: raw.labelZh,
    labelEn: raw.labelEn,
  };
}

function sanitizeResolvedModel(raw) {
  if (!isPlainObject(raw)) return null;
  return {
    effectiveModelRef: typeof raw.effectiveModelRef === 'string' ? raw.effectiveModelRef : null,
    effectiveModelName: typeof raw.effectiveModelName === 'string' ? raw.effectiveModelName : null,
    effectiveProviderName: typeof raw.effectiveProviderName === 'string' ? raw.effectiveProviderName : null,
    source: typeof raw.source === 'string' ? raw.source : null,
    available: Boolean(raw.available),
  };
}

function sanitizeModelSelection(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  if (raw.modelRef === null || (typeof raw.modelRef === 'string' && raw.modelRef.length > 0)) {
    out.modelRef = raw.modelRef;
  }
  if (raw.thinkingLevel === null || (typeof raw.thinkingLevel === 'string' && raw.thinkingLevel.length > 0)) {
    out.thinkingLevel = raw.thinkingLevel;
  }
  if (raw.codemode === null || typeof raw.codemode === 'boolean') out.codemode = raw.codemode;
  if (raw.codemodeOnly === null || typeof raw.codemodeOnly === 'boolean') out.codemodeOnly = raw.codemodeOnly;
  return out;
}

function sanitizeModelConfig(raw) {
  if (!isPlainObject(raw)) {
    return { global: {}, overrides: {}, effective: {}, revision: 0 };
  }
  return {
    global: sanitizeModelSelection(raw.global),
    overrides: sanitizeModelSelection(raw.overrides),
    effective: sanitizeModelSelection(raw.effective),
    revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
  };
}

function sanitizeCwdConfig(raw) {
  return {
    value: typeof raw?.value === 'string' ? raw.value : null,
    revision: Number.isSafeInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0,
  };
}

function sanitizeAvatarConfig(raw) {
  return {
    value: sanitizeAvatar(raw?.value),
    revision: Number.isSafeInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0,
  };
}

function sanitizeBot(raw, deviceInfo = null) {
  if (!isPlainObject(raw)) return null;
  const name = typeof raw.name === 'string'
    ? raw.name
    : typeof raw.role === 'string'
      ? raw.role
      : '';
  return {
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : (deviceInfo?.deviceId ?? ''),
    botId: typeof raw.botId === 'string' ? raw.botId : '',
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    isPrimary: Boolean(raw.isPrimary),
    archivedAt: typeof raw.archivedAt === 'string' ? raw.archivedAt : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
    cwdRevision: Number.isSafeInteger(raw.cwdRevision) && raw.cwdRevision >= 0 ? raw.cwdRevision : 0,
    modelRef: typeof raw.modelRef === 'string' ? raw.modelRef : null,
    resolvedModel: sanitizeResolvedModel(raw.resolvedModel),
    avatar: sanitizeAvatar(raw.avatar),
    avatarRevision: Number.isSafeInteger(raw.avatarRevision) && raw.avatarRevision >= 0 ? raw.avatarRevision : 0,
    primaryConversationId: typeof raw.primaryConversationId === 'string' ? raw.primaryConversationId : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    lastActivityAt: typeof raw.lastActivityAt === 'string' ? raw.lastActivityAt : null,
    lastPreview: typeof raw.lastPreview === 'string' ? raw.lastPreview : null,
    deviceName: typeof raw.deviceName === 'string'
      ? raw.deviceName
      : typeof deviceInfo?.name === 'string'
        ? deviceInfo.name
        : null,
    platform: typeof raw.platform === 'string'
      ? raw.platform
      : typeof deviceInfo?.platform === 'string'
        ? deviceInfo.platform
        : null,
    online: typeof raw.online === 'boolean'
      ? raw.online
      : typeof deviceInfo?.online === 'boolean'
        ? deviceInfo.online
        : null,
  };
}

function sanitizeSoul(deviceId, botId, raw, { includeStatus = false } = {}) {
  const out = {
    deviceId,
    botId: typeof raw?.botId === 'string' ? raw.botId : botId,
    path: typeof raw?.path === 'string' ? raw.path : `bots/${botId}/SOUL.md`,
    revision: typeof raw?.revision === 'string' ? raw.revision : '',
    text: typeof raw?.text === 'string' ? raw.text : '',
  };
  if (includeStatus) {
    out.status = typeof raw?.status === 'string' ? raw.status : 'applied';
  }
  return out;
}

export function createHandlers(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createHandlers requires deps');
  }
  if (typeof deps.owner !== 'function') {
    throw new Error('createHandlers requires deps.owner');
  }
  if (typeof deps.bridge?.call !== 'function') {
    throw new Error('createHandlers requires deps.bridge.call');
  }

  const { owner, bridge } = deps;

  return {
    async pibot_bots_list(args) {
      const input = assertArgsObject(args, LIST_ARGS_KEYS, { allowUndefined: true });
      const includeArchived = input.includeArchived === undefined ? true : input.includeArchived;
      if (typeof includeArchived !== 'boolean') {
        fail('INVALID_ARGUMENT', 'includeArchived must be a boolean');
      }
      const offset = input.offset === undefined ? 0 : input.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        fail('INVALID_ARGUMENT', 'offset must be a non-negative integer');
      }
      const limit = input.limit === undefined ? 50 : input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        fail('INVALID_ARGUMENT', 'limit must be an integer between 1 and 200');
      }

      let rawDevices;
      let rawBots;
      if (input.deviceId !== undefined) {
        const deviceId = assertDeviceTarget(input.deviceId, bridge);
        const [allDevices, deviceBots] = await Promise.all([
          owner('GET', '/api/devices', {}),
          owner('GET', '/api/devices/:deviceId/bots', { params: { deviceId } }),
        ]);
        const deviceList = Array.isArray(allDevices) ? allDevices : [];
        const matchedDevice = deviceList.find((item) => item?.deviceId === deviceId) ?? null;
        const botList = Array.isArray(deviceBots) ? deviceBots : [];
        if (deviceList.length > 0 && !matchedDevice && botList.length === 0) {
          fail('NOT_FOUND', 'Device not found');
        }
        rawDevices = matchedDevice ? [matchedDevice] : [];
        rawBots = botList;
      } else {
        const sync = await owner('GET', '/api/bot-sync', { query: {} });
        rawDevices = Array.isArray(sync?.devices) ? sync.devices : [];
        rawBots = Array.isArray(sync?.bots) ? sync.bots : [];
      }

      const devices = rawDevices
        .filter((item) => item && typeof item.deviceId === 'string' && !isInternalDeviceId(item.deviceId, bridge))
        .map(sanitizeDevice)
        .filter(Boolean);
      const deviceMap = new Map(devices.map((device) => [device.deviceId, device]));

      const filtered = rawBots.filter((item) => {
        if (!isPlainObject(item) || typeof item.deviceId !== 'string' || typeof item.botId !== 'string') {
          return false;
        }
        if (isInternalDeviceId(item.deviceId, bridge)) return false;
        if (!includeArchived && item.archivedAt) return false;
        return true;
      });

      const total = filtered.length;
      const page = filtered
        .slice(offset, offset + limit)
        .map((bot) => sanitizeBot(bot, deviceMap.get(bot.deviceId) ?? null))
        .filter(Boolean);
      const nextOffset = offset + page.length < total ? offset + page.length : null;

      return { devices, bots: page, total, offset, limit, nextOffset };
    },

    async pibot_bot_get(args) {
      const input = assertArgsObject(args, TARGET_BOT_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      const [deviceBots, allDevices] = await Promise.all([
        owner('GET', '/api/devices/:deviceId/bots', { params: { deviceId } }),
        owner('GET', '/api/devices', {}),
      ]);
      const rawDevice = Array.isArray(allDevices)
        ? allDevices.find((item) => item?.deviceId === deviceId) ?? null
        : null;
      const deviceInfo = sanitizeDevice(rawDevice);
      const centerBot = Array.isArray(deviceBots)
        ? deviceBots.find((item) => item?.botId === botId) ?? null
        : null;
      if (!centerBot) {
        fail('NOT_FOUND', 'Bot not found');
      }

      const [modelConfig, cwdConfig, avatarConfig] = await Promise.all([
        owner('GET', '/api/devices/:deviceId/bots/:botId/model-config', { params: { deviceId, botId } }),
        owner('GET', '/api/devices/:deviceId/bots/:botId/cwd', { params: { deviceId, botId } }),
        owner('GET', '/api/devices/:deviceId/bots/:botId/avatar', { params: { deviceId, botId } }),
      ]);

      let hostOnline = false;
      let hostCwd = null;
      let mergedBot = centerBot;
      if (deviceInfo?.online !== false) {
        try {
          const liveBot = await bridge.call(deviceId, 'getBot', { botId });
          hostOnline = true;
          if (isPlainObject(liveBot)) {
            hostCwd = typeof liveBot.cwd === 'string' ? liveBot.cwd : null;
            mergedBot = {
              ...centerBot,
              ...(typeof liveBot.role === 'string' && !centerBot.name ? { name: liveBot.role } : {}),
              ...(typeof liveBot.description === 'string' ? { description: liveBot.description } : {}),
              ...(typeof liveBot.isPrimary === 'boolean' ? { isPrimary: liveBot.isPrimary } : {}),
              ...(liveBot.archivedAt !== undefined ? { archivedAt: liveBot.archivedAt } : {}),
              ...(typeof liveBot.primaryConversationId === 'string'
                ? { primaryConversationId: liveBot.primaryConversationId }
                : {}),
              ...(typeof liveBot.createdAt === 'string' ? { createdAt: liveBot.createdAt } : {}),
              ...(liveBot.lastActivityAt !== undefined ? { lastActivityAt: liveBot.lastActivityAt } : {}),
              ...(liveBot.lastPreview !== undefined ? { lastPreview: liveBot.lastPreview } : {}),
            };
          }
        } catch (err) {
          if (OFFLINE_ERROR_CODES.has(err?.code)) {
            hostOnline = false;
          } else if (err?.code === 'BOT_NOT_FOUND') {
            hostOnline = true;
          } else {
            throw err;
          }
        }
      }

      return {
        deviceId,
        botId,
        hostOnline,
        hostCwd,
        bot: sanitizeBot(mergedBot, deviceInfo),
        modelConfig: sanitizeModelConfig(modelConfig),
        cwd: sanitizeCwdConfig(cwdConfig),
        avatar: sanitizeAvatarConfig(avatarConfig),
      };
    },

    async pibot_bot_soul_get(args) {
      const input = assertArgsObject(args, TARGET_BOT_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      const soul = await bridge.call(deviceId, 'getBotSoul', { botId });
      return sanitizeSoul(deviceId, botId, soul);
    },

    async pibot_bot_create(args) {
      const input = assertArgsObject(args, CREATE_BOT_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const name = assertBotName(input.name);
      const requestId = input.requestId !== undefined ? assertRequestId(input.requestId) : randomUUID();

      const body = { requestId, role: name };
      if (input.description !== undefined) {
        body.description = assertBotDescription(input.description);
      }
      if (input.cwd !== undefined) {
        body.cwd = assertAbsoluteCwd(input.cwd);
      }
      if (input.makePrimary !== undefined) {
        if (typeof input.makePrimary !== 'boolean') {
          fail('INVALID_ARGUMENT', 'makePrimary must be a boolean');
        }
        body.makePrimary = input.makePrimary;
      }

      const created = await owner('POST', '/api/devices/:deviceId/bots', {
        params: { deviceId },
        body,
      });
      return {
        requestId,
        bot: sanitizeBot(created),
      };
    },

    async pibot_bot_update_profile(args) {
      const input = assertArgsObject(args, UPDATE_PROFILE_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      if (input.name === undefined && input.description === undefined) {
        fail('INVALID_ARGUMENT', 'At least one of name or description must be provided');
      }
      const body = {};
      if (input.name !== undefined) {
        body.name = assertBotName(input.name);
      }
      if (input.description !== undefined) {
        body.description = assertBotDescription(input.description);
      }

      const updated = await owner('PATCH', '/api/devices/:deviceId/bots/:botId', {
        params: { deviceId, botId },
        body,
      });
      return { bot: sanitizeBot(updated) };
    },

    async pibot_bot_set_primary(args) {
      const input = assertArgsObject(args, TARGET_BOT_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      const updated = await owner('POST', '/api/devices/:deviceId/bots/:botId/primary', {
        params: { deviceId, botId },
      });
      return { bot: sanitizeBot(updated) };
    },

    async pibot_bot_set_model(args) {
      const input = assertArgsObject(args, SET_MODEL_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);
      const expectedRevision = assertRevision(input.expectedRevision);

      const hasPatch =
        input.modelRef !== undefined ||
        input.thinkingLevel !== undefined ||
        input.codemode !== undefined ||
        input.codemodeOnly !== undefined;
      if (!hasPatch) {
        fail('INVALID_ARGUMENT', 'At least one of modelRef, thinkingLevel, codemode, or codemodeOnly must be provided');
      }

      const patch = {};
      if (input.modelRef !== undefined) {
        if (input.modelRef !== null) {
          if (
            typeof input.modelRef !== 'string' ||
            !input.modelRef.isWellFormed() ||
            input.modelRef.trim().length < 1 ||
            input.modelRef.length > 512 ||
            CONTROL_CHARS_RE.test(input.modelRef)
          ) {
            fail('INVALID_ARGUMENT', 'modelRef must be a non-empty string or null');
          }
        }
        patch.modelRef = input.modelRef;
      }
      if (input.thinkingLevel !== undefined) {
        if (input.thinkingLevel !== null && !THINKING_LEVELS.has(input.thinkingLevel)) {
          fail('INVALID_ARGUMENT', 'Invalid thinkingLevel');
        }
        patch.thinkingLevel = input.thinkingLevel;
      }
      if (input.codemode !== undefined) {
        if (input.codemode !== null && typeof input.codemode !== 'boolean') {
          fail('INVALID_ARGUMENT', 'codemode must be a boolean or null');
        }
        patch.codemode = input.codemode;
      }
      if (input.codemodeOnly !== undefined) {
        if (input.codemodeOnly !== null && typeof input.codemodeOnly !== 'boolean') {
          fail('INVALID_ARGUMENT', 'codemodeOnly must be a boolean or null');
        }
        patch.codemodeOnly = input.codemodeOnly;
      }

      const deviceBots = await owner('GET', '/api/devices/:deviceId/bots', { params: { deviceId } });
      if (!Array.isArray(deviceBots) || !deviceBots.some((item) => item?.botId === botId)) {
        fail('NOT_FOUND', 'Bot not found');
      }

      const current = await owner('GET', '/api/devices/:deviceId/bots/:botId/model-config', {
        params: { deviceId, botId },
      });
      if ((current?.revision ?? 0) !== expectedRevision) {
        fail('REVISION_CONFLICT', 'Revision does not match');
      }

      const mergedOverrides = {
        ...sanitizeModelSelection(current?.overrides),
        ...patch,
      };

      const updated = await owner('PUT', '/api/devices/:deviceId/bots/:botId/model-config', {
        params: { deviceId, botId },
        body: { expectedRevision, value: mergedOverrides },
      });
      return {
        deviceId,
        botId,
        ...sanitizeModelConfig(updated),
      };
    },

    async pibot_bot_set_soul(args, actor) {
      const input = assertArgsObject(args, SET_SOUL_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      if (isSelfTarget(actor, deviceId, botId)) {
        fail(
          'FORBIDDEN',
          "Cannot update the calling Bot's own SOUL over Center relay; use the local Host set_bot_soul tool instead so self-edits are safely queued to the next idle boundary",
        );
      }

      const expectedRevision = assertSoulRevision(input.expectedRevision);
      const text = assertSoulText(input.text);

      // Never pass self:true over Center relay; idle enforcement stays intact on Host.
      const updated = await bridge.call(deviceId, 'setBotSoul', {
        botId,
        input: { expectedRevision, text },
      });
      return sanitizeSoul(deviceId, botId, updated, { includeStatus: true });
    },

    async pibot_bot_set_cwd(args) {
      const input = assertArgsObject(args, SET_CWD_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);
      const expectedRevision = assertRevision(input.expectedRevision);
      const cwd = assertAbsoluteCwd(input.cwd);

      const updated = await owner('PUT', '/api/devices/:deviceId/bots/:botId/cwd', {
        params: { deviceId, botId },
        body: { expectedRevision, value: cwd },
      });
      return {
        deviceId,
        botId,
        ...sanitizeCwdConfig(updated),
        appliesAt: 'next-idle',
      };
    },

    async pibot_bot_set_avatar(args) {
      const input = assertArgsObject(args, SET_AVATAR_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);
      const expectedRevision = assertRevision(input.expectedRevision);
      const avatar = normalizeAvatarInput(input.avatar);

      const updated = await owner('PUT', '/api/devices/:deviceId/bots/:botId/avatar', {
        params: { deviceId, botId },
        body: { expectedRevision, value: avatar },
      });
      return {
        deviceId,
        botId,
        ...sanitizeAvatarConfig(updated),
      };
    },

    async pibot_bot_session_control(args, actor) {
      const input = assertArgsObject(args, SESSION_CONTROL_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);
      const action = input.action;
      if (typeof action !== 'string' || !SESSION_ACTIONS.has(action)) {
        fail('INVALID_ARGUMENT', 'action must be stop, clear_history, or compact');
      }

      assertNotSelf(actor, deviceId, botId, action === 'clear_history' ? 'clear history of' : action);

      if (action === 'stop') {
        const result = await bridge.call(deviceId, 'abort', { botId });
        return {
          action: 'stop',
          deviceId,
          botId,
          stopped: true,
          withdrawn: Array.isArray(result?.withdrawn)
            ? result.withdrawn.filter((id) => typeof id === 'string')
            : [],
        };
      }

      if (action === 'clear_history') {
        const result = await bridge.call(deviceId, 'clearHistory', { botId });
        return {
          action: 'clear_history',
          deviceId,
          botId,
          conversationId: typeof result?.conversationId === 'string' ? result.conversationId : null,
          clearedThroughEntryId:
            Number.isSafeInteger(result?.clearedThroughEntryId) && result.clearedThroughEntryId >= 0
              ? result.clearedThroughEntryId
              : 0,
        };
      }

      const result = await bridge.call(deviceId, 'compact', { botId });
      return {
        action: 'compact',
        deviceId,
        botId,
        conversationId: typeof result?.conversationId === 'string' ? result.conversationId : null,
        compacted: Boolean(result?.compacted),
      };
    },

    async pibot_bot_archive(args, actor) {
      const input = assertArgsObject(args, TARGET_BOT_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      assertNotSelf(actor, deviceId, botId, 'archive');

      const updated = await owner('POST', '/api/devices/:deviceId/bots/:botId/archive', {
        params: { deviceId, botId },
      });
      return { bot: sanitizeBot(updated) };
    },

    async pibot_bot_unarchive(args) {
      const input = assertArgsObject(args, TARGET_BOT_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      const updated = await owner('POST', '/api/devices/:deviceId/bots/:botId/unarchive', {
        params: { deviceId, botId },
      });
      return { bot: sanitizeBot(updated) };
    },

    async pibot_bot_delete(args, actor) {
      const input = assertArgsObject(args, TARGET_BOT_ARGS_KEYS);
      const deviceId = assertDeviceTarget(input.deviceId, bridge);
      const botId = assertBotId(input.botId);

      assertNotSelf(actor, deviceId, botId, 'delete');

      await owner('DELETE', '/api/devices/:deviceId/bots/:botId', {
        params: { deviceId, botId },
      });
      return { deviceId, botId, deleted: true };
    },
  };
}
