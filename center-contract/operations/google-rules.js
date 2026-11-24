import { defineOperation } from './schema.js';

const GOOGLE_RULE_ID_PATTERN = '^[A-Za-z0-9_-]{1,128}$';
const MAX_FILTER_LENGTH = 200;
const MAX_ADDRESSES = 10;
const MAX_MINUTES_BEFORE = 24 * 60;

const NULLABLE_FILTER_TEXT_SCHEMA = {
  anyOf: [
    { type: 'string', minLength: 1, maxLength: MAX_FILTER_LENGTH },
    { type: 'null' },
  ],
};

const NULLABLE_ADDRESS_LIST_SCHEMA = {
  anyOf: [
    {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: MAX_FILTER_LENGTH },
      maxItems: MAX_ADDRESSES,
    },
    { type: 'null' },
  ],
};

/**
 * Built-in Center operations for already-authorized Google Workspace trigger rules
 * (Gmail `new_email` and Calendar `starting_soon`).
 *
 * Security boundary:
 * - Never initiates Google OAuth sign-in, accepts account tokens/credentials, or modifies
 *   Google account scopes/permissions (owner-only in Center UI).
 * - Never returns unauthorized email or calendar body content (rule metadata and delivery
 *   receipts only).
 * - Bots and authorized OAuth MCP callers may create, update, rebind, pause, resume, and
 *   remove trigger rules on already-authorized Google accounts (scoped OAuth callers remain
 *   restricted to their authorized `botTargets`).
 */
export const googleRuleOperations = Object.freeze([
  defineOperation({
    name: 'automation_google_rule_list',
    description: 'List configured Google Workspace trigger rules (Gmail/Calendar) for already-authorized accounts with safe metadata and runtime delivery status. Never exposes OAuth tokens or email/calendar bodies.',
    properties: {
      deviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Optional filter by target Host device ID.',
      },
      botId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Optional filter by target Bot ID.',
      },
      account: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_FILTER_LENGTH,
        description: 'Optional filter by already-authorized Google account email.',
      },
      enabled: {
        type: 'boolean',
        description: 'Optional filter by rule enabled state.',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_rule_events_list',
    description: 'List recent delivery receipt metadata (up to 200) for an existing Google Workspace trigger rule. Returns delivery status and timestamps only; never returns email/calendar bodies, raw payloads, or tokens.',
    properties: {
      id: {
        type: 'string',
        pattern: GOOGLE_RULE_ID_PATTERN,
        description: 'Google trigger rule ID.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Maximum number of recent delivery events to return (1..200, default 50).',
      },
    },
    required: ['id'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_rule_create',
    description: 'Create a Google Workspace trigger rule (Gmail new_email or Calendar starting_soon) on an already-authorized Google account for a target Bot. For Bot callers, deviceId defaults to the caller device and botId defaults to the caller Bot on the same device; OAuth callers and cross-device calls must specify deviceId and botId. Account may be omitted when exactly one connected Google account exists. Never initiates Google OAuth sign-in, changes Google permissions, or accepts OAuth tokens.',
    properties: {
      deviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target Host device ID. Optional for Bot callers (defaults to caller device); required for OAuth callers.',
      },
      botId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target Bot ID. Optional for Bot callers targeting their own device (defaults to caller Bot); required for OAuth callers or cross-device calls.',
      },
      account: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_FILTER_LENGTH,
        description: 'Optional already-authorized Google account email or ID. May be omitted when exactly one connected Google account exists.',
      },
      source: {
        type: 'string',
        enum: ['gmail', 'calendar'],
        description: 'Trigger source: "gmail" (new_email) or "calendar" (starting_soon).',
      },
      event: {
        type: 'string',
        enum: ['new_email', 'starting_soon'],
        description: 'Optional trigger event name; must match source ("new_email" for gmail, "starting_soon" for calendar).',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Optional display name for the trigger rule (defaults to a source/account label).',
      },
      instruction: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description: 'Instruction delivered to the target Bot when the rule triggers.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the rule starts enabled (default true).',
      },
      from: {
        ...NULLABLE_ADDRESS_LIST_SCHEMA,
        description: 'Gmail rules only: sender addresses or domains (max 10).',
      },
      to: {
        ...NULLABLE_ADDRESS_LIST_SCHEMA,
        description: 'Gmail rules only: recipient addresses (max 10).',
      },
      subjectContains: {
        ...NULLABLE_FILTER_TEXT_SCHEMA,
        description: 'Gmail rules only: case-insensitive subject substring filter.',
      },
      label: {
        ...NULLABLE_FILTER_TEXT_SCHEMA,
        description: 'Gmail rules only: Gmail label name or ID filter.',
      },
      calendar: {
        ...NULLABLE_FILTER_TEXT_SCHEMA,
        description: 'Calendar rules only: calendar ID (defaults to primary).',
      },
      minutesBefore: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_MINUTES_BEFORE,
        description: 'Calendar rules only: minutes before meeting start to trigger (0..1440, default 10).',
      },
    },
    required: ['source', 'instruction'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_rule_set_enabled',
    description: 'Pause or resume an existing Google Workspace trigger rule while preserving its configured account, source, filters, instruction, and target Bot. Pausing cancels pending undelivered events; resuming verifies the target Bot and authorized Google account are still available.',
    properties: {
      id: {
        type: 'string',
        pattern: GOOGLE_RULE_ID_PATTERN,
        description: 'Existing Google trigger rule ID.',
      },
      enabled: {
        type: 'boolean',
        description: 'Target enabled state (false pauses and cancels pending deliveries; true resumes the rule).',
      },
    },
    required: ['id', 'enabled'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_rule_update',
    description: 'Update an existing Google Workspace trigger rule (name, instruction, enabled, target deviceId/botId, authorized account, source/event, and source-matched Gmail/Calendar filters). Never initiates Google OAuth sign-in, changes Google permissions, or accepts OAuth tokens.',
    properties: {
      id: {
        type: 'string',
        pattern: GOOGLE_RULE_ID_PATTERN,
        description: 'Existing Google trigger rule ID.',
      },
      deviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Updated target Host device ID.',
      },
      botId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Updated target Bot ID.',
      },
      account: {
        type: 'string',
        minLength: 1,
        maxLength: MAX_FILTER_LENGTH,
        description: 'Updated already-authorized Google account email or ID.',
      },
      source: {
        type: 'string',
        enum: ['gmail', 'calendar'],
        description: 'Updated trigger source ("gmail" or "calendar").',
      },
      event: {
        type: 'string',
        enum: ['new_email', 'starting_soon'],
        description: 'Optional trigger event name; must match the effective source.',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Updated display name for the trigger rule.',
      },
      instruction: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description: 'Updated instruction delivered to the target Bot when the rule triggers.',
      },
      enabled: {
        type: 'boolean',
        description: 'Enable or pause the rule (pausing cancels pending undelivered events).',
      },
      from: {
        ...NULLABLE_ADDRESS_LIST_SCHEMA,
        description: 'Gmail rules only: sender addresses or domains (max 10; pass null or [] to clear).',
      },
      to: {
        ...NULLABLE_ADDRESS_LIST_SCHEMA,
        description: 'Gmail rules only: recipient addresses (max 10; pass null or [] to clear).',
      },
      subjectContains: {
        ...NULLABLE_FILTER_TEXT_SCHEMA,
        description: 'Gmail rules only: case-insensitive subject substring filter (pass null to clear).',
      },
      label: {
        ...NULLABLE_FILTER_TEXT_SCHEMA,
        description: 'Gmail rules only: Gmail label name or ID filter (pass null to clear).',
      },
      calendar: {
        ...NULLABLE_FILTER_TEXT_SCHEMA,
        description: 'Calendar rules only: calendar ID (pass null to reset to primary).',
      },
      minutesBefore: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_MINUTES_BEFORE,
        description: 'Calendar rules only: minutes before meeting start to trigger (0..1440).',
      },
    },
    required: ['id'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_rule_remove',
    description: 'Remove an existing Google Workspace trigger rule and cancel its pending undelivered events. Does not disconnect or alter the underlying Google account.',
    properties: {
      id: {
        type: 'string',
        pattern: GOOGLE_RULE_ID_PATTERN,
        description: 'Existing Google trigger rule ID to remove.',
      },
    },
    required: ['id'],
    readOnly: false,
    destructive: true,
  }),

  defineOperation({
    name: 'automation_google_assistant_get',
    description: 'Get the current proactive Google Workspace assistant binding configuration and safe runtime status for already-authorized accounts. Never exposes OAuth tokens or email/calendar bodies.',
    properties: {},
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_assistant_configure',
    description: 'Configure or update the proactive Google Workspace assistant binding (enabled state, target Bot, mode, watched authorized accounts, Gmail batch window, daily digest times, and Calendar lead time). Never initiates Google OAuth sign-in, accepts credentials/tokens, or enables private Hindsight memory consent (owner-only in Center UI).',
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable or pause the proactive Google assistant (pausing cancels pending undelivered events).',
      },
      deviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target Host device ID. Optional for Bot callers (defaults to caller device when creating); required for OAuth callers when creating.',
      },
      botId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Target Bot ID. Optional for Bot callers targeting their own device when creating; required for OAuth callers or cross-device calls when creating.',
      },
      mode: {
        type: 'string',
        enum: ['dedicated', 'existing'],
        description: 'Proactive assistant mode: "dedicated" (read+draft-only Bot) or "existing" (background proactive turns only).',
      },
      accounts: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: MAX_FILTER_LENGTH },
        minItems: 1,
        maxItems: 20,
        description: 'Already-authorized Google account emails or IDs to watch.',
      },
      batchWindowMinutes: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_MINUTES_BEFORE,
        description: 'Gmail batching window in minutes before flushing buffered high-priority/batched threads (1..1440, default 10).',
      },
      digestTimes: {
        type: 'array',
        items: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
        maxItems: 6,
        description: 'Optional daily routine digest times in 24-hour HH:mm format (e.g. ["09:00","18:00"]). Pass [] to flush all threads by batchWindowMinutes.',
      },
      calendarEnabled: {
        type: 'boolean',
        description: 'Whether timely pre-meeting Google Calendar alerts are enabled (default true).',
      },
      calendarLeadMinutes: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_MINUTES_BEFORE,
        description: 'Minutes before meeting start to deliver timely pre-meeting alerts (0..1440, default 15).',
      },
    },
    required: [],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_assistant_remove',
    description: 'Remove the proactive Google Workspace assistant binding and cancel its pending undelivered events. Does not disconnect Google accounts or delete any Bot.',
    properties: {},
    required: [],
    readOnly: false,
    destructive: true,
  }),
]);
