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
 * - Intentionally excludes creating brand-new Google trigger rules and forbids redirecting
 *   `account`, `deviceId`, `botId`, `source`, or `event` on existing rules: active Google
 *   trigger rules inject live Gmail/Calendar data into a high-privilege Bot without
 *   MCP safe-tool sandboxing, so new account/Bot bindings require explicit human owner
 *   admission in Center UI.
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
    name: 'automation_google_rule_set_enabled',
    description: 'Pause or resume an existing Google Workspace trigger rule while preserving its owner-admitted account, source, filters, instruction, and target Bot. Pausing cancels pending undelivered events; resuming re-verifies original explicit account and target Bot admission.',
    properties: {
      id: {
        type: 'string',
        pattern: GOOGLE_RULE_ID_PATTERN,
        description: 'Existing Google trigger rule ID.',
      },
      enabled: {
        type: 'boolean',
        description: 'Target enabled state (false pauses and cancels pending deliveries; true resumes under existing explicit account/target admission).',
      },
    },
    required: ['id', 'enabled'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_google_rule_update',
    description: 'Update safe non-credential settings (name, instruction, enabled, and source-matched Gmail/Calendar filters) of an existing Google Workspace trigger rule. Preserves the owner-admitted account, target deviceId/botId, and trigger source; never creates new rules, changes Google permissions, or accepts OAuth tokens.',
    properties: {
      id: {
        type: 'string',
        pattern: GOOGLE_RULE_ID_PATTERN,
        description: 'Existing Google trigger rule ID.',
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
        description: 'Updated instruction delivered to the existing target Bot when the rule triggers.',
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
]);
