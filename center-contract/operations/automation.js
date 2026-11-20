import { defineOperation } from './schema.js';
import { googleRuleOperations } from './google-rules.js';

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
const SKILL_NAME_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';
const WEBHOOK_ID_PATTERN = '^[A-Za-z0-9_-]{1,128}$';

const SCHEDULE_REPEATS = [
  'once',
  'daily',
  'weekly',
  'monthly',
  'statutoryWorkday',
  'statutoryHoliday',
];

const TASK_STATUSES = ['triaging', 'working', 'waiting', 'done', 'cancelled'];
const TASK_LIST_STATUSES = ['all', 'active', 'triaging', 'working', 'waiting', 'done', 'cancelled'];
const TASK_STEP_STATUSES = ['unassigned', 'todo', 'working', 'waiting', 'blocked', 'done', 'cancelled'];
const TASK_ADOPTION_PHASES = ['recorded', 'adjusting', 'needs_scope', 'adopted'];

const SCHEDULE_TARGET_PROPERTIES = {
  deviceId: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    description: 'Target Host device ID. Optional for bot actor (defaults to caller device); required for OAuth callers.',
  },
  botId: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    description: 'Target Bot ID. Optional for bot actor targeting its own device (defaults to caller bot); required for OAuth callers or cross-device calls.',
  },
};

const SCHEDULE_MUTABLE_PROPERTIES = {
  title: {
    type: 'string',
    minLength: 1,
    maxLength: 80,
    description: 'Short display title of the scheduled task.',
  },
  prompt: {
    type: 'string',
    minLength: 1,
    maxLength: 8000,
    description: 'Prompt submitted to the target Bot primary conversation when triggered.',
  },
  skills: {
    type: 'array',
    items: { type: 'string', pattern: SKILL_NAME_PATTERN },
    uniqueItems: true,
    maxItems: 100,
    description: 'Explicit skill names to load before running the scheduled prompt.',
  },
  repeat: {
    type: 'string',
    enum: SCHEDULE_REPEATS,
    description: 'Recurrence rule.',
  },
  time: {
    type: 'string',
    pattern: TIME_PATTERN,
    description: 'Wall-clock trigger time in 24-hour HH:mm format.',
  },
  weekday: {
    type: 'integer',
    minimum: 1,
    maximum: 7,
    description: 'ISO weekday (1=Monday .. 7=Sunday) for weekly recurrence.',
  },
  weekdays: {
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 7 },
    uniqueItems: true,
    maxItems: 7,
    description: 'Multiple ISO weekdays (1..7) for weekly recurrence.',
  },
  monthDay: {
    type: 'integer',
    minimum: 1,
    maximum: 31,
    description: 'Day of month (1..31) for monthly recurrence.',
  },
  alarmMode: {
    type: 'string',
    enum: ['exact', 'alarmClock'],
    description: 'Android alarm delivery mode (default alarmClock).',
  },
  vibrate: {
    type: 'boolean',
    description: 'Whether to vibrate when the schedule triggers on mobile devices.',
  },
  deleteAfterRun: {
    type: 'boolean',
    description: 'Whether a one-shot schedule should delete itself after firing.',
  },
};

const NULLABLE_ID_SCHEMA = {
  anyOf: [
    { type: 'string', minLength: 1, maxLength: 200 },
    { type: 'null' },
  ],
};

const TASK_STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    parentStepId: NULLABLE_ID_SCHEMA,
    afterStepId: NULLABLE_ID_SCHEMA,
    text: { type: 'string', minLength: 1, maxLength: 1000 },
    status: { type: 'string', enum: TASK_STEP_STATUSES },
    deviceId: NULLABLE_ID_SCHEMA,
    botId: NULLABLE_ID_SCHEMA,
    dependsOnStepIds: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 200 },
      maxItems: 64,
    },
    preserved: { type: 'boolean' },
    relationNote: { type: 'string', maxLength: 500 },
    resultSummary: { type: 'string', maxLength: 4000 },
  },
  required: ['text'],
  additionalProperties: false,
};

const TASK_STEP_PATCH_SCHEMA = {
  type: 'object',
  properties: {
    stepId: { type: 'string', minLength: 1, maxLength: 200 },
    expectedExecutionRevision: { type: 'integer', minimum: 1 },
    parentStepId: NULLABLE_ID_SCHEMA,
    text: { type: 'string', minLength: 1, maxLength: 1000 },
    status: { type: 'string', enum: TASK_STEP_STATUSES },
    deviceId: NULLABLE_ID_SCHEMA,
    botId: NULLABLE_ID_SCHEMA,
    dependsOnStepIds: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 200 },
      maxItems: 64,
    },
    preserved: { type: 'boolean' },
    relationNote: { type: 'string', maxLength: 500 },
    resultSummary: { type: 'string', maxLength: 4000 },
  },
  required: ['stepId'],
  additionalProperties: false,
};

const TASK_PENDING_PROMPT_SCHEMA = {
  type: 'object',
  description: 'Submit a plan confirmation or clarification question for the human user. Cannot be null and cannot clear or bypass an existing user prompt.',
  properties: {
    kind: { type: 'string', enum: ['plan', 'question'] },
    text: { type: 'string', minLength: 1, maxLength: 4000 },
    options: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 300 },
      maxItems: 12,
    },
    stepId: NULLABLE_ID_SCHEMA,
    deviceId: { type: 'string', minLength: 1, maxLength: 200 },
    botId: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['kind', 'text'],
  additionalProperties: false,
};

const TASK_ADOPTION_SCHEMA = {
  type: 'object',
  description: 'Update requirement-change adoption metadata. Cannot clear or resolve an active needs_scope user confirmation.',
  properties: {
    phase: { type: 'string', enum: TASK_ADOPTION_PHASES },
    shortReceipt: { type: 'string', minLength: 1, maxLength: 500 },
    changeText: { type: 'string', minLength: 1, maxLength: 4000 },
    scopeDesc: { type: 'string', minLength: 1, maxLength: 1000 },
  },
  additionalProperties: false,
};

export const operations = [
  // ---- Host Scheduled Tasks (fixed Host RPC: scheduleTask) ----
  defineOperation({
    name: 'automation_schedule_list',
    description: 'List scheduled tasks for a target Bot on an online Host device via fixed scheduleTask RPC.',
    properties: {
      ...SCHEDULE_TARGET_PROPERTIES,
      cursor: {
        anyOf: [
          { type: 'string', pattern: UUID_PATTERN },
          { type: 'null' },
        ],
        description: 'Optional pagination cursor (scheduled task UUID) from the previous response.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of scheduled tasks to return (1..50).',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_schedule_create',
    description: 'Create a new scheduled task for a target Bot on an online Host device via fixed scheduleTask RPC. The Host allocates task id and revision.',
    properties: {
      ...SCHEDULE_TARGET_PROPERTIES,
      ...SCHEDULE_MUTABLE_PROPERTIES,
    },
    required: ['title', 'prompt', 'repeat', 'time'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_schedule_update',
    description: 'Update fields of an existing scheduled task on a Host device with strict revision CAS (fetch latest id and revision via automation_schedule_list first).',
    properties: {
      ...SCHEDULE_TARGET_PROPERTIES,
      id: {
        type: 'string',
        pattern: UUID_PATTERN,
        description: 'Canonical UUID of the scheduled task to update.',
      },
      revision: {
        type: 'integer',
        minimum: 1,
        description: 'Expected positive integer revision for strict CAS.',
      },
      ...SCHEDULE_MUTABLE_PROPERTIES,
    },
    required: ['id', 'revision'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_schedule_set_enabled',
    description: 'Enable or disable an existing scheduled task on a Host device with strict revision CAS.',
    properties: {
      ...SCHEDULE_TARGET_PROPERTIES,
      id: {
        type: 'string',
        pattern: UUID_PATTERN,
        description: 'Canonical UUID of the scheduled task.',
      },
      revision: {
        type: 'integer',
        minimum: 1,
        description: 'Expected positive integer revision for strict CAS.',
      },
      enabled: {
        type: 'boolean',
        description: 'Target enabled state.',
      },
    },
    required: ['id', 'revision', 'enabled'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_schedule_delete',
    description: 'Delete an existing scheduled task on a Host device with strict revision CAS.',
    properties: {
      ...SCHEDULE_TARGET_PROPERTIES,
      id: {
        type: 'string',
        pattern: UUID_PATTERN,
        description: 'Canonical UUID of the scheduled task to delete.',
      },
      revision: {
        type: 'integer',
        minimum: 1,
        description: 'Expected positive integer revision for strict CAS.',
      },
    },
    required: ['id', 'revision'],
    readOnly: false,
    destructive: true,
  }),

  // ---- Center Global Tasks (plan & state read/write; user approvals excluded) ----
  defineOperation({
    name: 'automation_task_list',
    description: 'List Center global tasks with optional status, Bot filter, limit, and cursor pagination.',
    properties: {
      status: {
        type: 'string',
        enum: TASK_LIST_STATUSES,
        description: 'Optional status filter (all, active, triaging, working, waiting, done, cancelled).',
      },
      botDeviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Filter tasks associated with this device ID.',
      },
      botId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Filter tasks associated with this Bot ID.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: 'Maximum number of tasks to return (1..500).',
      },
      cursor: {
        anyOf: [
          {
            type: 'object',
            properties: {
              updatedAt: { type: 'number', minimum: 0 },
              id: { type: 'string', minLength: 1, maxLength: 200 },
            },
            required: ['updatedAt', 'id'],
            additionalProperties: false,
          },
          { type: 'null' },
        ],
        description: 'Pagination cursor from previous automation_task_list nextCursor.',
      },
    },
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_task_get',
    description: 'Get full details, plan steps, pending prompt, adoption state, logs, and revision of a single Center global task.',
    properties: {
      taskId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Global task ID.',
      },
    },
    required: ['taskId'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_task_create',
    description: 'Create a Center global task. Bot actors execute with their real Bot identity; OAuth callers use non-interactive Center task creation.',
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 300,
        description: 'Optional task title (derived from requirement when omitted).',
      },
      requirement: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description: 'Task requirement description.',
      },
      summary: {
        type: 'string',
        minLength: 1,
        maxLength: 4000,
        description: 'Optional initial status summary.',
      },
      coordinatorDeviceId: {
        ...NULLABLE_ID_SCHEMA,
        description: 'Optional coordinator device ID (must be paired with coordinatorBotId).',
      },
      coordinatorBotId: {
        ...NULLABLE_ID_SCHEMA,
        description: 'Optional coordinator Bot ID (set null to leave unassigned for dispatcher triage).',
      },
      directStart: {
        type: 'boolean',
        description: 'When true and a non-dispatcher coordinator is set without pendingPrompt, starts immediately in working status.',
      },
      status: {
        type: 'string',
        enum: ['triaging', 'working'],
        description: 'Optional initial task status (triaging or working; overridden to waiting when pendingPrompt is supplied).',
      },
      steps: {
        type: 'array',
        maxItems: 100,
        items: TASK_STEP_SCHEMA,
        description: 'Optional initial task plan steps.',
      },
      pendingPrompt: TASK_PENDING_PROMPT_SCHEMA,
    },
    required: ['requirement'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_task_assign',
    description: 'Assign or transfer the coordinator Bot of a Center global task with strict expectedRevision CAS. Respects pending user confirmation gates.',
    properties: {
      taskId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Global task ID.',
      },
      expectedRevision: {
        type: 'integer',
        minimum: 1,
        description: 'Expected task revision for strict CAS.',
      },
      coordinatorDeviceId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Target coordinator device ID.',
      },
      coordinatorBotId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Target coordinator Bot ID.',
      },
    },
    required: ['taskId', 'expectedRevision', 'coordinatorDeviceId', 'coordinatorBotId'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_task_update',
    description: 'Update plan steps, stepPatches, status, metadata, or submit a pendingPrompt on a Center global task with strict expectedRevision CAS. Enforces real Bot role permissions and never clears or bypasses pending user approvals (confirm_plan, answer_prompt, needs_scope).',
    properties: {
      taskId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Global task ID.',
      },
      expectedRevision: {
        type: 'integer',
        minimum: 1,
        description: 'Expected task revision for strict CAS.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 300,
        description: 'Updated task title (coordinator/OAuth only).',
      },
      requirement: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description: 'Updated task requirement (coordinator/OAuth only).',
      },
      summary: {
        type: 'string',
        minLength: 1,
        maxLength: 4000,
        description: 'Updated task summary (coordinator/OAuth only).',
      },
      status: {
        type: 'string',
        enum: TASK_STATUSES,
        description: 'Updated task status (cannot start or complete while user confirmation is pending).',
      },
      steps: {
        type: 'array',
        maxItems: 100,
        items: TASK_STEP_SCHEMA,
        description: 'Full replacement of task steps (completed steps are preserved automatically by Center).',
      },
      addSteps: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: TASK_STEP_SCHEMA,
        description: 'Append new steps to the task plan.',
      },
      stepPatches: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: TASK_STEP_PATCH_SCHEMA,
        description: 'Targeted patches to existing steps (worker Bots may only patch their own assigned steps).',
      },
      pendingPrompt: TASK_PENDING_PROMPT_SCHEMA,
      adoption: TASK_ADOPTION_SCHEMA,
      logText: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
        description: 'Optional human-readable log note for this update.',
      },
    },
    required: ['taskId', 'expectedRevision'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_task_delete',
    description: 'Delete a Center global task with strict expectedRevision CAS (coordinator Bot or OAuth caller).',
    properties: {
      taskId: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Global task ID to delete.',
      },
      expectedRevision: {
        type: 'integer',
        minimum: 1,
        description: 'Expected task revision for strict CAS.',
      },
    },
    required: ['taskId', 'expectedRevision'],
    readOnly: false,
    destructive: true,
  }),

  // ---- Center Webhooks (safe metadata/events read + non-secret/non-target-redirect update/delete) ----
  defineOperation({
    name: 'automation_webhook_list',
    description: 'List configured Center webhook routes without exposing any Bearer tokens or token hashes.',
    properties: {},
    required: [],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_webhook_events_list',
    description: 'List recent delivery events (up to 100, status and receipt metadata only; no raw payloads or tokens) for a Center webhook route.',
    properties: {
      id: {
        type: 'string',
        pattern: WEBHOOK_ID_PATTERN,
        description: 'Webhook route ID.',
      },
    },
    required: ['id'],
    readOnly: true,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_webhook_update',
    description: 'Update safe non-secret configuration (name, instruction, enabled) of an existing Center webhook route. Preserves the trusted target deviceId/botId and never issues or rotates Bearer tokens.',
    properties: {
      id: {
        type: 'string',
        pattern: WEBHOOK_ID_PATTERN,
        description: 'Webhook route ID.',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description: 'Updated display name for the webhook route.',
      },
      instruction: {
        type: 'string',
        minLength: 1,
        maxLength: 8000,
        description: 'Updated instruction delivered to the existing target Bot.',
      },
      enabled: {
        type: 'boolean',
        description: 'Enable or disable delivery (disabling cancels pending undelivered events).',
      },
    },
    required: ['id'],
    readOnly: false,
    destructive: false,
  }),

  defineOperation({
    name: 'automation_webhook_delete',
    description: 'Delete an existing Center webhook route and cancel its pending undelivered events.',
    properties: {
      id: {
        type: 'string',
        pattern: WEBHOOK_ID_PATTERN,
        description: 'Webhook route ID to delete.',
      },
    },
    required: ['id'],
    readOnly: false,
    destructive: true,
  }),

  // ---- Google Workspace Trigger Rules (authorized accounts; safe read/events/edit/remove) ----
  ...googleRuleOperations,
];
