import { defineOperation } from './schema.js';

export const BOT_AVATAR_SHAPES = Object.freeze([
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

export const BOT_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

export const BOT_SESSION_ACTIONS = Object.freeze([
  'stop',
  'clear_history',
  'compact',
]);

const DEVICE_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description: 'Target paired Host device ID (never the reserved center-* internal identity).',
};

const BOT_ID_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  description: 'Target Bot ID on the specified device.',
};

const REVISION_SCHEMA = {
  type: 'integer',
  minimum: 0,
  description: 'Current Center CAS revision from pibot_bot_get; fails with REVISION_CONFLICT if stale.',
};

const SOUL_REVISION_SCHEMA = {
  type: 'string',
  pattern: '^[0-9a-f]{64}$',
  description: 'Current lowercase 64-character hex SHA-256 revision from pibot_bot_soul_get; fails with REQUEST_CONFLICT if stale.',
};

const BOT_AVATAR_OBJECT_SCHEMA = {
  type: 'object',
  required: ['id', 'shape', 'color', 'rotation', 'expressionIndex', 'labelZh', 'labelEn'],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Avatar preset or custom identifier.',
    },
    shape: {
      type: 'string',
      enum: [...BOT_AVATAR_SHAPES],
      description: 'Allowed geometric mascot body shape.',
    },
    color: {
      type: 'string',
      pattern: '^#[0-9a-fA-F]{6}$',
      description: 'Six-digit hex RGB color string, e.g. #2B70F6.',
    },
    rotation: {
      type: 'number',
      minimum: -360,
      maximum: 360,
      description: 'Body rotation angle in degrees (-360 to 360).',
    },
    expressionIndex: {
      type: 'integer',
      minimum: 0,
      maximum: 5,
      description: 'Mascot face expression index (0 to 5).',
    },
    labelZh: {
      type: 'string',
      maxLength: 128,
      description: 'Chinese display label for the avatar.',
    },
    labelEn: {
      type: 'string',
      maxLength: 128,
      description: 'English display label for the avatar.',
    },
  },
};

export const operations = Object.freeze([
  defineOperation({
    name: 'pibot_bots_list',
    description:
      'List Bots in the Center directory across all paired devices or filtered to one deviceId, with online status, primary/archive flags, resolved model summary, and whitelisted avatar metadata.',
    properties: {
      deviceId: {
        ...DEVICE_ID_SCHEMA,
        description: 'Optional paired Host device ID to filter the Bot directory.',
      },
      includeArchived: {
        type: 'boolean',
        description: 'Whether to include archived Bots in results (defaults to true).',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Zero-based pagination offset into the filtered Bot list (defaults to 0).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Maximum number of Bot records to return (1 to 200, defaults to 50).',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_get',
    description:
      'Inspect a single Bot: whitelisted metadata (merged with live Host getBot state when the device is online), Center model configuration and revision, working directory cwd and revision, and structured avatar and revision.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
    },
    required: ['deviceId', 'botId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_soul_get',
    description:
      'Read a Bot\'s SOUL.md persona and responsibility document along with its current lowercase 64-hex SHA-256 revision from the target Host.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
    },
    required: ['deviceId', 'botId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_create',
    description:
      'Create a new user-manageable Bot on the specified online device. Omit cwd to use the Host\'s default workspace, or pass an existing absolute directory path on that Host. Reuse the same requestId on retries for idempotency. Creating a Bot registers it and does not start a turn.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description: 'Display name / role of the new Bot (1 to 120 non-blank characters).',
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'Optional responsibility description (up to 2000 characters).',
      },
      cwd: {
        type: 'string',
        minLength: 1,
        maxLength: 1024,
        description: 'Optional existing absolute directory path on the target Host.',
      },
      makePrimary: {
        type: 'boolean',
        description: 'Optional flag to immediately promote the newly created Bot as the device\'s primary Bot.',
      },
      requestId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Optional idempotency key; retrying with the same requestId and identical parameters returns the original Bot.',
      },
    },
    required: ['deviceId', 'name'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_update_profile',
    description:
      'Update a Bot\'s display name (role) and/or responsibility description on its Host and sync the updated record to Center. Provide at least one of name or description.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 120,
        description: 'New display name (1 to 120 non-blank characters).',
      },
      description: {
        type: 'string',
        maxLength: 2000,
        description: 'New responsibility description (up to 2000 characters).',
      },
    },
    required: ['deviceId', 'botId'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_set_primary',
    description:
      'Promote an existing non-archived Bot to be the primary Bot on its device and demote the previous primary Bot.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
    },
    required: ['deviceId', 'botId'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_set_model',
    description:
      'Update a Bot\'s Center-managed model override settings (modelRef, thinkingLevel, codemode, codemodeOnly) using optimistic CAS (expectedRevision). Pass null for a field to clear that override back to the global default; omitted fields keep their existing overrides.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      modelRef: {
        anyOf: [
          { type: 'string', minLength: 1, maxLength: 512 },
          { type: 'null' },
        ],
        description: 'Provider-qualified model reference (provider/modelId), or null to inherit the global model.',
      },
      thinkingLevel: {
        anyOf: [
          { type: 'string', enum: [...BOT_THINKING_LEVELS] },
          { type: 'null' },
        ],
        description: 'Reasoning effort override, or null to inherit the global setting.',
      },
      codemode: {
        anyOf: [{ type: 'boolean' }, { type: 'null' }],
        description: 'Enable/disable codemode override, or null to inherit the global setting.',
      },
      codemodeOnly: {
        anyOf: [{ type: 'boolean' }, { type: 'null' }],
        description: 'Enable/disable codemodeOnly override, or null to inherit the global setting.',
      },
    },
    required: ['deviceId', 'botId', 'expectedRevision'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_set_soul',
    description:
      'Update an idle Bot\'s SOUL.md document on its Host using SHA-256 CAS (expectedRevision) and UTF-8 text up to 64 KiB. A busy Bot returns RUNTIME_BUSY without modifying the file. Self-targeting by the calling Bot is rejected over Center relay; to edit its own SOUL during an active turn, the Bot must use the local Host set_bot_soul tool which queues self-edits to the next idle boundary.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      expectedRevision: SOUL_REVISION_SCHEMA,
      text: {
        type: 'string',
        maxLength: 65536,
        description: 'Complete replacement UTF-8 SOUL.md content (at most 65536 UTF-8 bytes).',
      },
    },
    required: ['deviceId', 'botId', 'expectedRevision', 'text'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_set_cwd',
    description:
      'Set a Bot\'s Center-authoritative existing working directory (absolute path on the target Host) using CAS (expectedRevision). The Host revalidates directory existence and applies the change at the next idle boundary; running turns keep their pinned directory and no files are moved.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      cwd: {
        type: 'string',
        minLength: 1,
        maxLength: 1024,
        description: 'Existing non-empty absolute directory path on the target Host (POSIX /..., Windows drive, or UNC share).',
      },
    },
    required: ['deviceId', 'botId', 'expectedRevision', 'cwd'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_set_avatar',
    description:
      'Set a Bot\'s structured mascot avatar (exact 7-field BotAvatar object) or clear it to default (null) using CAS (expectedRevision). Arbitrary extra keys are rejected.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      expectedRevision: REVISION_SCHEMA,
      avatar: {
        anyOf: [BOT_AVATAR_OBJECT_SCHEMA, { type: 'null' }],
        description: 'Structured 7-field BotAvatar object, or null to reset to the default avatar.',
      },
    },
    required: ['deviceId', 'botId', 'expectedRevision', 'avatar'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_session_control',
    description:
      'Control another Bot\'s primary conversation on its Host: stop (abort active generation and cancel queued turns), clear_history (reset an idle non-archived Bot\'s context), or compact (manually compact an idle non-archived Bot\'s context). Self-targeting by the calling Bot is forbidden.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
      action: {
        type: 'string',
        enum: [...BOT_SESSION_ACTIONS],
        description: 'Primary conversation control action: stop, clear_history, or compact.',
      },
    },
    required: ['deviceId', 'botId', 'action'],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'pibot_bot_archive',
    description:
      'Archive an idle, non-primary Bot so it becomes read-only, cancels active learning jobs, and pauses scheduled tasks. Self-targeting by the calling Bot is forbidden.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
    },
    required: ['deviceId', 'botId'],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'pibot_bot_unarchive',
    description:
      'Restore an archived Bot so it can accept tasks and messages again.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
    },
    required: ['deviceId', 'botId'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'pibot_bot_delete',
    description:
      'Permanently delete an idle, non-primary Bot from its Host and remove its Center bindings, model overrides, and attachments. Self-targeting by the calling Bot is forbidden.',
    properties: {
      deviceId: DEVICE_ID_SCHEMA,
      botId: BOT_ID_SCHEMA,
    },
    required: ['deviceId', 'botId'],
    readOnly: false,
    destructive: true,
  }),
]);
