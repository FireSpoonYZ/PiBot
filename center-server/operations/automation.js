/**
 * Center automation operations handlers:
 * - Host scheduled tasks via fixed Host RPC (`bridge.call(deviceId, 'scheduleTask', ...)`).
 * - Center global tasks via real Bot actor (`store.executeTaskAction`) or non-interactive OAuth owner routes
 *   (`GET /api/tasks`, `POST /api/tasks/action`), with strict CAS and anti-approval-forgery guards.
 * - Center webhooks safe subset (`GET /api/webhooks`, `GET /api/webhooks/:id/events`,
 *   `PUT /api/webhooks/:id` for name/instruction/enabled only, `DELETE /api/webhooks/:id`).
 *
 * Intentionally excluded for security boundaries:
 * - Task human approvals/confirmations: `confirm_plan`, `answer_prompt`, `resolve_adoption_scope`, `dismiss_adoption`,
 *   clearing `pendingPrompt`, or advancing a task/step gated on a pending plan/question/needs_scope.
 * - Webhook secret issuance/rotation and trusted-target redirection: `POST /api/webhooks` (returns Bearer token),
 *   `POST /api/webhooks/:id/rotate-token` (returns Bearer token), and changing `deviceId`/`botId` on existing webhooks.
 * - Interactive Host OS permission prompt: schedule `requestExactAlarm`.
 * - External/Host delivery routes: `POST /api/webhooks/:id/events`, `/api/host/webhook-events/*`, `/api/host/tasks/*`.
 */

import { normalizeScheduleControlParams } from '../../host-core/schedule-protocol.js';

const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const TASK_LIST_STATUS_SET = new Set(['all', 'active', 'triaging', 'working', 'waiting', 'done', 'cancelled']);
const TASK_STATUS_SET = new Set(['triaging', 'working', 'waiting', 'done', 'cancelled']);
const TASK_CREATE_STATUS_SET = new Set(['triaging', 'working']);
const TASK_STEP_STATUS_SET = new Set(['unassigned', 'todo', 'working', 'waiting', 'blocked', 'done', 'cancelled']);
const TASK_ADOPTION_PHASE_SET = new Set(['recorded', 'adjusting', 'needs_scope', 'adopted']);

const SCHEDULE_LIST_FIELDS = new Set(['deviceId', 'botId', 'cursor', 'limit']);
const SCHEDULE_MUTABLE_KEYS = [
  'title',
  'prompt',
  'skills',
  'repeat',
  'time',
  'weekday',
  'weekdays',
  'monthDay',
  'alarmMode',
  'vibrate',
  'deleteAfterRun',
];
const SCHEDULE_CREATE_FIELDS = new Set(['deviceId', 'botId', ...SCHEDULE_MUTABLE_KEYS]);
const SCHEDULE_UPDATE_FIELDS = new Set(['deviceId', 'botId', 'id', 'revision', ...SCHEDULE_MUTABLE_KEYS]);
const SCHEDULE_SET_ENABLED_FIELDS = new Set(['deviceId', 'botId', 'id', 'revision', 'enabled']);
const SCHEDULE_DELETE_FIELDS = new Set(['deviceId', 'botId', 'id', 'revision']);

const TASK_LIST_FIELDS = new Set(['status', 'botDeviceId', 'botId', 'limit', 'cursor']);
const TASK_LIST_CURSOR_FIELDS = new Set(['updatedAt', 'id']);
const TASK_GET_FIELDS = new Set(['taskId']);
const TASK_CREATE_FIELDS = new Set([
  'title',
  'requirement',
  'summary',
  'coordinatorDeviceId',
  'coordinatorBotId',
  'directStart',
  'status',
  'steps',
  'pendingPrompt',
]);
const TASK_ASSIGN_FIELDS = new Set(['taskId', 'expectedRevision', 'coordinatorDeviceId', 'coordinatorBotId']);
const TASK_UPDATE_MUTABLE_KEYS = [
  'title',
  'requirement',
  'summary',
  'status',
  'steps',
  'addSteps',
  'stepPatches',
  'pendingPrompt',
  'adoption',
  'logText',
];
const TASK_UPDATE_FIELDS = new Set(['taskId', 'expectedRevision', ...TASK_UPDATE_MUTABLE_KEYS]);
const TASK_DELETE_FIELDS = new Set(['taskId', 'expectedRevision']);

const TASK_STEP_FIELDS = new Set([
  'id',
  'parentStepId',
  'afterStepId',
  'text',
  'status',
  'deviceId',
  'botId',
  'dependsOnStepIds',
  'preserved',
  'relationNote',
  'resultSummary',
]);
const TASK_STEP_PATCH_FIELDS = new Set([
  'stepId',
  'expectedExecutionRevision',
  'parentStepId',
  'text',
  'status',
  'deviceId',
  'botId',
  'dependsOnStepIds',
  'preserved',
  'relationNote',
  'resultSummary',
]);
const TASK_PENDING_PROMPT_FIELDS = new Set(['kind', 'text', 'options', 'stepId', 'deviceId', 'botId']);
const TASK_ADOPTION_FIELDS = new Set(['phase', 'shortReceipt', 'changeText', 'scopeDesc']);

const WEBHOOK_LIST_FIELDS = new Set();
const WEBHOOK_ID_ONLY_FIELDS = new Set(['id']);
const WEBHOOK_UPDATE_FIELDS = new Set(['id', 'name', 'instruction', 'enabled']);
const WEBHOOK_FORBIDDEN_UPDATE_FIELDS = new Set(['deviceId', 'botId', 'token', 'tokenHash', 'token_hash']);

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
    for (const item of Object.values(value)) assertWellFormedDeep(item);
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

function rejectUnknownFields(obj, allowed, label = 'args') {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail('INVALID_ARGUMENT', `${label} has unknown field: ${key}`);
    }
  }
}

function assertNonEmptyText(value, field, maxLen) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > maxLen) {
    fail('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  return value;
}

function assertTrimmedId(value, field, maxLen = 200) {
  if (typeof value !== 'string' || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > maxLen) {
    fail('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  return trimmed;
}

function assertNullableId(value, field, maxLen = 200) {
  if (value === null) return null;
  return assertTrimmedId(value, field, maxLen);
}

function assertPositiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_ARGUMENT', `${field} must be a positive integer`);
  }
  return value;
}

function assertWebhookId(value) {
  if (typeof value !== 'string' || !WEBHOOK_ID_RE.test(value)) {
    fail('INVALID_ARGUMENT', 'Invalid webhook id');
  }
  return value;
}

function validateActor(actor) {
  if (!isPlainObject(actor)) {
    fail('UNAUTHENTICATED', 'Authenticated actor is required');
  }
  if (actor.kind === 'bot') {
    const deviceId = assertTrimmedId(actor.deviceId, 'actor.deviceId', 128);
    const botId = assertTrimmedId(actor.botId, 'actor.botId', 128);
    return { kind: 'bot', deviceId, botId };
  }
  if (actor.kind === 'oauth') {
    const clientId = assertTrimmedId(actor.clientId, 'actor.clientId', 200);
    return { kind: 'oauth', clientId };
  }
  fail('FORBIDDEN', 'Unsupported actor kind');
}

function requireOwnerAdapter(deps) {
  if (typeof deps?.owner !== 'function') {
    fail('INTERNAL_ERROR', 'Owner adapter is unavailable');
  }
  return deps.owner;
}

function devicesWithMeta(bridge) {
  const listed = typeof bridge?.listDevices === 'function' ? bridge.listDevices() : [];
  const registryDevices = typeof bridge?.registry?.list === 'function' ? bridge.registry.list() : [];
  if (!registryDevices.length) return listed;
  const regById = new Map(registryDevices.map((item) => [item.deviceId, item]));
  return listed.map((device) => {
    const reg = regById.get(device.deviceId);
    if (!reg) return device;
    return {
      ...device,
      ...(typeof reg.platform === 'string' && !device.platform ? { platform: reg.platform } : {}),
      ...(typeof reg.displayName === 'string' && !device.name ? { name: reg.displayName } : {}),
    };
  });
}

function notifyTaskTargets(deps, targetDeviceIds) {
  if (!Array.isArray(targetDeviceIds) || !targetDeviceIds.length) return;
  for (const deviceId of new Set(targetDeviceIds)) {
    if (!deviceId) continue;
    if (typeof deps?.notifyTaskReady === 'function') deps.notifyTaskReady(deviceId);
    else if (typeof deps?.notify === 'function') deps.notify(deviceId, 'task-ready');
  }
}

function resolveScheduleTarget(args, actor, bridge) {
  if (!bridge || typeof bridge.call !== 'function') {
    fail('CENTER_OFFLINE', 'Host bridge is unavailable');
  }
  let deviceId;
  let botId;
  if (actor.kind === 'bot') {
    deviceId = args.deviceId !== undefined
      ? assertTrimmedId(args.deviceId, 'deviceId', 128)
      : actor.deviceId;
    if (args.botId !== undefined) {
      botId = assertTrimmedId(args.botId, 'botId', 128);
    } else if (deviceId === actor.deviceId) {
      botId = actor.botId;
    } else {
      fail('INVALID_ARGUMENT', 'botId is required when targeting a different deviceId');
    }
  } else {
    deviceId = assertTrimmedId(args.deviceId, 'deviceId', 128);
    botId = assertTrimmedId(args.botId, 'botId', 128);
  }
  if (bridge.deviceId && deviceId === bridge.deviceId) {
    fail('NOT_FOUND', 'Device not found');
  }
  if (typeof bridge.registry?.get === 'function') {
    const device = bridge.registry.get(deviceId);
    if (!device || device.revokedAt !== null) {
      fail('NOT_FOUND', 'Device not found');
    }
  }
  return { deviceId, botId };
}

function normalizeTaskStep(raw, label) {
  const obj = requirePlainObject(raw, label);
  rejectUnknownFields(obj, TASK_STEP_FIELDS, label);
  const out = {
    text: assertNonEmptyText(obj.text, `${label}.text`, 1000).trim(),
  };
  if (obj.id !== undefined) out.id = assertTrimmedId(obj.id, `${label}.id`, 200);
  if (obj.parentStepId !== undefined) out.parentStepId = assertNullableId(obj.parentStepId, `${label}.parentStepId`, 200);
  if (obj.afterStepId !== undefined) out.afterStepId = assertNullableId(obj.afterStepId, `${label}.afterStepId`, 200);
  if (obj.status !== undefined) {
    if (typeof obj.status !== 'string' || !TASK_STEP_STATUS_SET.has(obj.status)) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.status`);
    }
    out.status = obj.status;
  }
  if (obj.deviceId !== undefined) out.deviceId = assertNullableId(obj.deviceId, `${label}.deviceId`, 200);
  if (obj.botId !== undefined) out.botId = assertNullableId(obj.botId, `${label}.botId`, 200);
  if (obj.dependsOnStepIds !== undefined) {
    if (!Array.isArray(obj.dependsOnStepIds) || obj.dependsOnStepIds.length > 64) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.dependsOnStepIds`);
    }
    out.dependsOnStepIds = obj.dependsOnStepIds.map((dep, idx) =>
      assertTrimmedId(dep, `${label}.dependsOnStepIds[${idx}]`, 200));
  }
  if (obj.preserved !== undefined) {
    if (typeof obj.preserved !== 'boolean') fail('INVALID_ARGUMENT', `${label}.preserved must be a boolean`);
    out.preserved = obj.preserved;
  }
  if (obj.relationNote !== undefined) {
    if (typeof obj.relationNote !== 'string' || !obj.relationNote.isWellFormed() || obj.relationNote.length > 500) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.relationNote`);
    }
    out.relationNote = obj.relationNote;
  }
  if (obj.resultSummary !== undefined) {
    if (typeof obj.resultSummary !== 'string' || !obj.resultSummary.isWellFormed() || obj.resultSummary.length > 4000) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.resultSummary`);
    }
    out.resultSummary = obj.resultSummary;
  }
  return out;
}

function normalizeTaskStepPatch(raw, label) {
  const obj = requirePlainObject(raw, label);
  rejectUnknownFields(obj, TASK_STEP_PATCH_FIELDS, label);
  const out = {
    stepId: assertTrimmedId(obj.stepId, `${label}.stepId`, 200),
  };
  if (obj.expectedExecutionRevision !== undefined) {
    out.expectedExecutionRevision = assertPositiveInt(
      obj.expectedExecutionRevision,
      `${label}.expectedExecutionRevision`,
    );
  }
  if (obj.parentStepId !== undefined) out.parentStepId = assertNullableId(obj.parentStepId, `${label}.parentStepId`, 200);
  if (obj.text !== undefined) out.text = assertNonEmptyText(obj.text, `${label}.text`, 1000).trim();
  if (obj.status !== undefined) {
    if (typeof obj.status !== 'string' || !TASK_STEP_STATUS_SET.has(obj.status)) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.status`);
    }
    out.status = obj.status;
  }
  if (obj.deviceId !== undefined) out.deviceId = assertNullableId(obj.deviceId, `${label}.deviceId`, 200);
  if (obj.botId !== undefined) out.botId = assertNullableId(obj.botId, `${label}.botId`, 200);
  if (obj.dependsOnStepIds !== undefined) {
    if (!Array.isArray(obj.dependsOnStepIds) || obj.dependsOnStepIds.length > 64) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.dependsOnStepIds`);
    }
    out.dependsOnStepIds = obj.dependsOnStepIds.map((dep, idx) =>
      assertTrimmedId(dep, `${label}.dependsOnStepIds[${idx}]`, 200));
  }
  if (obj.preserved !== undefined) {
    if (typeof obj.preserved !== 'boolean') fail('INVALID_ARGUMENT', `${label}.preserved must be a boolean`);
    out.preserved = obj.preserved;
  }
  if (obj.relationNote !== undefined) {
    if (typeof obj.relationNote !== 'string' || !obj.relationNote.isWellFormed() || obj.relationNote.length > 500) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.relationNote`);
    }
    out.relationNote = obj.relationNote;
  }
  if (obj.resultSummary !== undefined) {
    if (typeof obj.resultSummary !== 'string' || !obj.resultSummary.isWellFormed() || obj.resultSummary.length > 4000) {
      fail('INVALID_ARGUMENT', `Invalid ${label}.resultSummary`);
    }
    out.resultSummary = obj.resultSummary;
  }
  return out;
}

function normalizeTaskPendingPrompt(raw, actor) {
  if (raw === null) {
    fail('FORBIDDEN', 'Cannot clear pending user prompt non-interactively; human confirmation is required');
  }
  const obj = requirePlainObject(raw, 'pendingPrompt');
  rejectUnknownFields(obj, TASK_PENDING_PROMPT_FIELDS, 'pendingPrompt');
  if (obj.kind !== 'plan' && obj.kind !== 'question') {
    fail('INVALID_ARGUMENT', 'pendingPrompt.kind must be plan or question');
  }
  const out = {
    kind: obj.kind,
    text: assertNonEmptyText(obj.text, 'pendingPrompt.text', 4000).trim(),
  };
  if (obj.options !== undefined) {
    if (!Array.isArray(obj.options) || obj.options.length > 12) {
      fail('INVALID_ARGUMENT', 'Invalid pendingPrompt.options');
    }
    out.options = obj.options.map((item, idx) =>
      assertNonEmptyText(item, `pendingPrompt.options[${idx}]`, 300).trim());
  }
  if (obj.stepId !== undefined) {
    out.stepId = assertNullableId(obj.stepId, 'pendingPrompt.stepId', 200);
  }
  if (obj.deviceId !== undefined) {
    out.deviceId = assertTrimmedId(obj.deviceId, 'pendingPrompt.deviceId', 200);
  }
  if (obj.botId !== undefined) {
    out.botId = assertTrimmedId(obj.botId, 'pendingPrompt.botId', 200);
  }
  if (actor.kind === 'bot') {
    if ((out.deviceId && out.deviceId !== actor.deviceId) || (out.botId && out.botId !== actor.botId)) {
      fail('FORBIDDEN', 'Bot cannot submit pendingPrompt on behalf of another Bot');
    }
  }
  return out;
}

function normalizeTaskAdoption(raw) {
  if (raw === null) {
    fail('FORBIDDEN', 'Cannot clear adoption state non-interactively');
  }
  const obj = requirePlainObject(raw, 'adoption');
  rejectUnknownFields(obj, TASK_ADOPTION_FIELDS, 'adoption');
  if (Object.keys(obj).length === 0) {
    fail('INVALID_ARGUMENT', 'adoption must contain at least one field');
  }
  const out = {};
  if (obj.phase !== undefined) {
    if (typeof obj.phase !== 'string' || !TASK_ADOPTION_PHASE_SET.has(obj.phase)) {
      fail('INVALID_ARGUMENT', 'Invalid adoption.phase');
    }
    out.phase = obj.phase;
  }
  if (obj.shortReceipt !== undefined) {
    out.shortReceipt = assertNonEmptyText(obj.shortReceipt, 'adoption.shortReceipt', 500).trim();
  }
  if (obj.changeText !== undefined) {
    out.changeText = assertNonEmptyText(obj.changeText, 'adoption.changeText', 4000).trim();
  }
  if (obj.scopeDesc !== undefined) {
    out.scopeDesc = assertNonEmptyText(obj.scopeDesc, 'adoption.scopeDesc', 1000).trim();
  }
  return out;
}

function assertOAuthApprovalGates(existing, payload) {
  if (existing.adoption?.phase === 'needs_scope' && payload.adoption !== undefined) {
    fail('FORBIDDEN', 'Cannot resolve or clear pending user scope confirmation non-interactively');
  }
  if (payload.pendingPrompt !== undefined && (existing.status === 'done' || existing.status === 'cancelled')) {
    fail('INVALID_STATE', 'Cannot submit a pending prompt on a finished task');
  }
  if (existing.pendingPrompt != null) {
    if (payload.pendingPrompt !== undefined) {
      fail('INVALID_STATE', 'Task already has a pending prompt awaiting human confirmation');
    }
    const prevStepsById = new Map(
      (Array.isArray(existing.steps) ? existing.steps : []).map((step) => [step.id, step]),
    );
    if (existing.pendingPrompt.kind === 'plan') {
      if (payload.status === 'working' || payload.status === 'done') {
        fail('INVALID_STATE', 'Cannot start or complete task before user confirms the pending plan');
      }
      if (Array.isArray(payload.stepPatches)) {
        for (const patch of payload.stepPatches) {
          const prev = prevStepsById.get(patch.stepId);
          if ((patch.status === 'working' || patch.status === 'done') && prev?.status !== patch.status) {
            fail('INVALID_STATE', 'Cannot advance steps before user confirms the pending plan');
          }
        }
      }
      if (Array.isArray(payload.steps)) {
        for (const step of payload.steps) {
          const prev = step.id ? prevStepsById.get(step.id) : null;
          if ((step.status === 'working' || step.status === 'done') && prev?.status !== step.status) {
            fail('INVALID_STATE', 'Cannot advance steps before user confirms the pending plan');
          }
        }
      }
      if (Array.isArray(payload.addSteps)) {
        for (const step of payload.addSteps) {
          if (step.status === 'working' || step.status === 'done') {
            fail('INVALID_STATE', 'Cannot start or complete steps before user confirms the pending plan');
          }
        }
      }
    } else if (existing.pendingPrompt.kind === 'question') {
      if (payload.status === 'working' || payload.status === 'done') {
        fail('INVALID_STATE', 'Cannot advance or complete task before user answers the pending question');
      }
      const promptStepId = existing.pendingPrompt.stepId;
      if (promptStepId) {
        const prevStep = prevStepsById.get(promptStepId);
        if (prevStep?.status === 'waiting') {
          if (Array.isArray(payload.stepPatches)) {
            for (const patch of payload.stepPatches) {
              if (patch.stepId === promptStepId && (patch.status === 'working' || patch.status === 'done')) {
                fail('INVALID_STATE', 'Cannot advance waiting step before user answers the pending question');
              }
            }
          }
          if (Array.isArray(payload.steps)) {
            const replacement = payload.steps.find((step) => step.id === promptStepId);
            if (!replacement) {
              fail('INVALID_STATE', 'Cannot remove waiting step before user answers the pending question');
            }
            if (replacement.status === 'working' || replacement.status === 'done') {
              fail('INVALID_STATE', 'Cannot advance waiting step before user answers the pending question');
            }
          }
        }
      }
    }
  }
}

function sanitizeWebhookRoute(route) {
  if (!isPlainObject(route)) return route;
  return {
    id: route.id,
    name: route.name,
    deviceId: route.deviceId,
    botId: route.botId,
    instruction: route.instruction,
    enabled: Boolean(route.enabled),
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
    ...(typeof route.url === 'string' ? { url: route.url } : {}),
  };
}

function sanitizeWebhookEvent(event) {
  if (!isPlainObject(event)) return event;
  return {
    id: event.id,
    routeId: event.routeId,
    routeName: event.routeName,
    deviceId: event.deviceId,
    botId: event.botId,
    requestId: event.requestId,
    idempotencyKey: event.idempotencyKey,
    status: event.status,
    cancelRequested: Boolean(event.cancelRequested),
    admission: event.admission ?? null,
    receivedAt: event.receivedAt,
    expiresAt: event.expiresAt,
    updatedAt: event.updatedAt,
    ...(event.error !== undefined ? { error: event.error } : {}),
  };
}

async function getExistingWebhook(deps, id) {
  if (typeof deps?.store?.getWebhookRoute === 'function') {
    return deps.store.getWebhookRoute(id);
  }
  const owner = requireOwnerAdapter(deps);
  const listed = await owner('GET', '/api/webhooks', { params: {}, query: {} });
  const existing = Array.isArray(listed?.items)
    ? listed.items.find((item) => item?.id === id)
    : null;
  if (!existing) fail('NOT_FOUND', 'Webhook not found');
  return existing;
}

export function createHandlers(deps = {}) {
  const executeBotTaskMutation = (payload, actor) => {
    if (typeof deps?.store?.executeTaskAction !== 'function') {
      fail('INTERNAL_ERROR', 'Task store is unavailable');
    }
    const { result, targetDeviceIds } = deps.store.executeTaskAction(payload, {
      actor,
      devices: devicesWithMeta(deps.bridge),
    });
    notifyTaskTargets(deps, targetDeviceIds);
    return result;
  };

  return {
    // ---- Host Scheduled Tasks ----
    async automation_schedule_list(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = optionalPlainObject(args);
      rejectUnknownFields(inputArgs, SCHEDULE_LIST_FIELDS);
      const { deviceId, botId } = resolveScheduleTarget(inputArgs, actor, deps.bridge);
      const input = { action: 'list' };
      if (inputArgs.cursor !== undefined) input.cursor = inputArgs.cursor;
      if (inputArgs.limit !== undefined) input.limit = inputArgs.limit;
      const params = normalizeScheduleControlParams({ botId, input });
      return deps.bridge.call(deviceId, 'scheduleTask', params);
    },

    async automation_schedule_create(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, SCHEDULE_CREATE_FIELDS);
      const { deviceId, botId } = resolveScheduleTarget(inputArgs, actor, deps.bridge);
      const input = { action: 'create' };
      for (const key of SCHEDULE_MUTABLE_KEYS) {
        if (inputArgs[key] !== undefined) input[key] = inputArgs[key];
      }
      const params = normalizeScheduleControlParams({ botId, input });
      return deps.bridge.call(deviceId, 'scheduleTask', params);
    },

    async automation_schedule_update(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, SCHEDULE_UPDATE_FIELDS);
      const { deviceId, botId } = resolveScheduleTarget(inputArgs, actor, deps.bridge);
      const input = {
        action: 'update',
        id: inputArgs.id,
        revision: inputArgs.revision,
      };
      let mutableCount = 0;
      for (const key of SCHEDULE_MUTABLE_KEYS) {
        if (inputArgs[key] !== undefined) {
          input[key] = inputArgs[key];
          mutableCount += 1;
        }
      }
      if (mutableCount === 0) {
        fail('INVALID_ARGUMENT', 'At least one schedule field must be provided to update');
      }
      const params = normalizeScheduleControlParams({ botId, input });
      return deps.bridge.call(deviceId, 'scheduleTask', params);
    },

    async automation_schedule_set_enabled(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, SCHEDULE_SET_ENABLED_FIELDS);
      const { deviceId, botId } = resolveScheduleTarget(inputArgs, actor, deps.bridge);
      const params = normalizeScheduleControlParams({
        botId,
        input: {
          action: 'setEnabled',
          id: inputArgs.id,
          revision: inputArgs.revision,
          enabled: inputArgs.enabled,
        },
      });
      return deps.bridge.call(deviceId, 'scheduleTask', params);
    },

    async automation_schedule_delete(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, SCHEDULE_DELETE_FIELDS);
      const { deviceId, botId } = resolveScheduleTarget(inputArgs, actor, deps.bridge);
      const params = normalizeScheduleControlParams({
        botId,
        input: {
          action: 'delete',
          id: inputArgs.id,
          revision: inputArgs.revision,
        },
      });
      return deps.bridge.call(deviceId, 'scheduleTask', params);
    },

    // ---- Center Global Tasks ----
    async automation_task_list(args, rawActor) {
      validateActor(rawActor);
      const inputArgs = optionalPlainObject(args);
      rejectUnknownFields(inputArgs, TASK_LIST_FIELDS);
      const owner = requireOwnerAdapter(deps);
      const query = {};
      if (inputArgs.status !== undefined) {
        if (typeof inputArgs.status !== 'string' || !TASK_LIST_STATUS_SET.has(inputArgs.status)) {
          fail('INVALID_ARGUMENT', 'Invalid status filter');
        }
        query.status = inputArgs.status;
      }
      if (inputArgs.botDeviceId !== undefined) {
        query.botDeviceId = assertTrimmedId(inputArgs.botDeviceId, 'botDeviceId', 200);
      }
      if (inputArgs.botId !== undefined) {
        query.botId = assertTrimmedId(inputArgs.botId, 'botId', 200);
      }
      if (inputArgs.limit !== undefined) {
        const limit = assertPositiveInt(inputArgs.limit, 'limit');
        if (limit > 500) fail('INVALID_ARGUMENT', 'limit must be between 1 and 500');
        query.limit = String(limit);
      }
      if (inputArgs.cursor !== undefined && inputArgs.cursor !== null) {
        const cursor = requirePlainObject(inputArgs.cursor, 'cursor');
        rejectUnknownFields(cursor, TASK_LIST_CURSOR_FIELDS, 'cursor');
        if (typeof cursor.updatedAt !== 'number' || !Number.isFinite(cursor.updatedAt) || cursor.updatedAt < 0) {
          fail('INVALID_ARGUMENT', 'cursor.updatedAt must be a non-negative finite number');
        }
        const cursorId = assertTrimmedId(cursor.id, 'cursor.id', 200);
        query.cursor = JSON.stringify({ updatedAt: cursor.updatedAt, id: cursorId });
      }
      return owner('GET', '/api/tasks', { params: {}, query });
    },

    async automation_task_get(args, rawActor) {
      validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, TASK_GET_FIELDS);
      const owner = requireOwnerAdapter(deps);
      const taskId = assertTrimmedId(inputArgs.taskId, 'taskId', 200);
      return owner('POST', '/api/tasks/action', {
        params: {},
        body: { action: 'get', taskId },
        query: {},
      });
    },

    async automation_task_create(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, TASK_CREATE_FIELDS);

      const payload = {
        action: 'create',
        requirement: assertNonEmptyText(inputArgs.requirement, 'requirement', 8000).trim(),
      };
      if (inputArgs.title !== undefined) {
        payload.title = assertNonEmptyText(inputArgs.title, 'title', 300).trim();
      }
      if (inputArgs.summary !== undefined) {
        payload.summary = assertNonEmptyText(inputArgs.summary, 'summary', 4000).trim();
      }
      if (inputArgs.coordinatorDeviceId !== undefined) {
        payload.coordinatorDeviceId = assertNullableId(inputArgs.coordinatorDeviceId, 'coordinatorDeviceId', 200);
      }
      if (inputArgs.coordinatorBotId !== undefined) {
        payload.coordinatorBotId = assertNullableId(inputArgs.coordinatorBotId, 'coordinatorBotId', 200);
      }
      if (payload.coordinatorDeviceId && !payload.coordinatorBotId) {
        fail('INVALID_ARGUMENT', 'coordinatorBotId is required when coordinatorDeviceId is specified');
      }
      if (inputArgs.directStart !== undefined) {
        if (typeof inputArgs.directStart !== 'boolean') {
          fail('INVALID_ARGUMENT', 'directStart must be a boolean');
        }
        payload.directStart = inputArgs.directStart;
      }
      if (inputArgs.status !== undefined) {
        if (typeof inputArgs.status !== 'string' || !TASK_CREATE_STATUS_SET.has(inputArgs.status)) {
          fail('INVALID_ARGUMENT', 'status must be triaging or working on create');
        }
        payload.status = inputArgs.status;
      }
      if (inputArgs.steps !== undefined) {
        if (!Array.isArray(inputArgs.steps) || inputArgs.steps.length > 100) {
          fail('INVALID_ARGUMENT', 'steps must be an array of at most 100 items');
        }
        payload.steps = inputArgs.steps.map((step, idx) => normalizeTaskStep(step, `steps[${idx}]`));
      }
      if (inputArgs.pendingPrompt !== undefined) {
        payload.pendingPrompt = normalizeTaskPendingPrompt(inputArgs.pendingPrompt, actor);
        if (payload.status === 'working' || payload.directStart === true) {
          fail('INVALID_STATE', 'Cannot start task directly when submitting a pending user prompt');
        }
      }

      if (actor.kind === 'bot') {
        return executeBotTaskMutation(payload, actor);
      }
      const owner = requireOwnerAdapter(deps);
      return owner('POST', '/api/tasks/action', { params: {}, body: payload, query: {} });
    },

    async automation_task_assign(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, TASK_ASSIGN_FIELDS);

      const payload = {
        action: 'assign',
        taskId: assertTrimmedId(inputArgs.taskId, 'taskId', 200),
        expectedRevision: assertPositiveInt(inputArgs.expectedRevision, 'expectedRevision'),
        coordinatorDeviceId: assertTrimmedId(inputArgs.coordinatorDeviceId, 'coordinatorDeviceId', 200),
        coordinatorBotId: assertTrimmedId(inputArgs.coordinatorBotId, 'coordinatorBotId', 200),
      };

      if (actor.kind === 'bot') {
        return executeBotTaskMutation(payload, actor);
      }
      const owner = requireOwnerAdapter(deps);
      return owner('POST', '/api/tasks/action', { params: {}, body: payload, query: {} });
    },

    async automation_task_update(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, TASK_UPDATE_FIELDS);

      const taskId = assertTrimmedId(inputArgs.taskId, 'taskId', 200);
      const expectedRevision = assertPositiveInt(inputArgs.expectedRevision, 'expectedRevision');

      const payload = {
        action: 'update',
        taskId,
        expectedRevision,
      };
      let mutableCount = 0;

      if (inputArgs.title !== undefined) {
        payload.title = assertNonEmptyText(inputArgs.title, 'title', 300).trim();
        mutableCount += 1;
      }
      if (inputArgs.requirement !== undefined) {
        payload.requirement = assertNonEmptyText(inputArgs.requirement, 'requirement', 8000).trim();
        mutableCount += 1;
      }
      if (inputArgs.summary !== undefined) {
        payload.summary = assertNonEmptyText(inputArgs.summary, 'summary', 4000).trim();
        mutableCount += 1;
      }
      if (inputArgs.status !== undefined) {
        if (typeof inputArgs.status !== 'string' || !TASK_STATUS_SET.has(inputArgs.status)) {
          fail('INVALID_ARGUMENT', 'Invalid task status');
        }
        payload.status = inputArgs.status;
        mutableCount += 1;
      }
      if (inputArgs.steps !== undefined) {
        if (!Array.isArray(inputArgs.steps) || inputArgs.steps.length > 100) {
          fail('INVALID_ARGUMENT', 'steps must be an array of at most 100 items');
        }
        payload.steps = inputArgs.steps.map((step, idx) => normalizeTaskStep(step, `steps[${idx}]`));
        mutableCount += 1;
      }
      if (inputArgs.addSteps !== undefined) {
        if (!Array.isArray(inputArgs.addSteps) || inputArgs.addSteps.length === 0 || inputArgs.addSteps.length > 100) {
          fail('INVALID_ARGUMENT', 'addSteps must be a non-empty array of at most 100 items');
        }
        payload.addSteps = inputArgs.addSteps.map((step, idx) => normalizeTaskStep(step, `addSteps[${idx}]`));
        mutableCount += 1;
      }
      if (inputArgs.stepPatches !== undefined) {
        if (!Array.isArray(inputArgs.stepPatches) || inputArgs.stepPatches.length === 0 || inputArgs.stepPatches.length > 100) {
          fail('INVALID_ARGUMENT', 'stepPatches must be a non-empty array of at most 100 items');
        }
        payload.stepPatches = inputArgs.stepPatches.map((patch, idx) =>
          normalizeTaskStepPatch(patch, `stepPatches[${idx}]`));
        mutableCount += 1;
      }
      if (inputArgs.pendingPrompt !== undefined) {
        payload.pendingPrompt = normalizeTaskPendingPrompt(inputArgs.pendingPrompt, actor);
        mutableCount += 1;
      }
      if (inputArgs.adoption !== undefined) {
        payload.adoption = normalizeTaskAdoption(inputArgs.adoption);
        mutableCount += 1;
      }
      if (inputArgs.logText !== undefined) {
        payload.logText = assertNonEmptyText(inputArgs.logText, 'logText', 500).trim();
        mutableCount += 1;
      }

      if (mutableCount === 0) {
        fail('INVALID_ARGUMENT', 'At least one mutable task field must be provided to update');
      }
      if (payload.pendingPrompt?.kind === 'plan' && (payload.status === 'working' || payload.status === 'done')) {
        fail('INVALID_STATE', 'Cannot start or complete task when submitting a plan for user confirmation');
      }

      if (actor.kind === 'bot') {
        if (typeof deps?.store?.executeTaskAction !== 'function') {
          fail('INTERNAL_ERROR', 'Task store is unavailable');
        }
        const existing = deps.store.executeTaskAction({ action: 'get', taskId }).result?.task;
        if (!existing) fail('TASK_NOT_FOUND', `Task not found: ${taskId}`);
        if (existing.revision !== expectedRevision) {
          fail('REQUEST_CONFLICT', 'Task revision conflict');
        }
        if (existing.adoption?.phase === 'needs_scope' && payload.adoption !== undefined) {
          fail('FORBIDDEN', 'Cannot resolve or clear pending user scope confirmation non-interactively');
        }
        return executeBotTaskMutation(payload, actor);
      }

      const owner = requireOwnerAdapter(deps);
      const existingRes = await owner('POST', '/api/tasks/action', {
        params: {},
        body: { action: 'get', taskId },
        query: {},
      });
      const existing = existingRes?.task;
      if (!existing) fail('TASK_NOT_FOUND', `Task not found: ${taskId}`);
      if (existing.revision !== expectedRevision) {
        fail('REQUEST_CONFLICT', 'Task revision conflict');
      }
      assertOAuthApprovalGates(existing, payload);
      return owner('POST', '/api/tasks/action', { params: {}, body: payload, query: {} });
    },

    async automation_task_delete(args, rawActor) {
      const actor = validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, TASK_DELETE_FIELDS);

      const payload = {
        action: 'delete',
        taskId: assertTrimmedId(inputArgs.taskId, 'taskId', 200),
        expectedRevision: assertPositiveInt(inputArgs.expectedRevision, 'expectedRevision'),
      };

      if (actor.kind === 'bot') {
        return executeBotTaskMutation(payload, actor);
      }
      const owner = requireOwnerAdapter(deps);
      return owner('POST', '/api/tasks/action', { params: {}, body: payload, query: {} });
    },

    // ---- Center Webhooks (safe non-secret / non-target-redirect subset) ----
    async automation_webhook_list(args, rawActor) {
      validateActor(rawActor);
      const inputArgs = optionalPlainObject(args);
      rejectUnknownFields(inputArgs, WEBHOOK_LIST_FIELDS);
      const owner = requireOwnerAdapter(deps);
      const res = await owner('GET', '/api/webhooks', { params: {}, query: {} });
      return {
        items: Array.isArray(res?.items) ? res.items.map(sanitizeWebhookRoute) : [],
      };
    },

    async automation_webhook_events_list(args, rawActor) {
      validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, WEBHOOK_ID_ONLY_FIELDS);
      const id = assertWebhookId(inputArgs.id);
      const owner = requireOwnerAdapter(deps);
      const res = await owner('GET', '/api/webhooks/:id/events', { params: { id }, query: {} });
      return {
        items: Array.isArray(res?.items) ? res.items.map(sanitizeWebhookEvent) : [],
      };
    },

    async automation_webhook_update(args, rawActor) {
      validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      for (const key of Object.keys(inputArgs)) {
        if (WEBHOOK_FORBIDDEN_UPDATE_FIELDS.has(key)) {
          fail('FORBIDDEN', `Updating webhook ${key} is forbidden`);
        }
      }
      rejectUnknownFields(inputArgs, WEBHOOK_UPDATE_FIELDS);

      const id = assertWebhookId(inputArgs.id);
      const hasName = inputArgs.name !== undefined;
      const hasInstruction = inputArgs.instruction !== undefined;
      const hasEnabled = inputArgs.enabled !== undefined;
      if (!hasName && !hasInstruction && !hasEnabled) {
        fail('INVALID_ARGUMENT', 'At least one of name, instruction, or enabled must be provided');
      }

      const nextName = hasName ? assertNonEmptyText(inputArgs.name, 'name', 80).trim() : undefined;
      const nextInstruction = hasInstruction ? assertNonEmptyText(inputArgs.instruction, 'instruction', 8000) : undefined;
      if (hasEnabled && typeof inputArgs.enabled !== 'boolean') {
        fail('INVALID_ARGUMENT', 'Invalid enabled');
      }

      const existing = await getExistingWebhook(deps, id);
      const owner = requireOwnerAdapter(deps);
      // Never pass deviceId or botId: PUT /api/webhooks/:id preserves the existing trusted target.
      const updated = await owner('PUT', '/api/webhooks/:id', {
        params: { id },
        body: {
          name: nextName !== undefined ? nextName : existing.name,
          instruction: nextInstruction !== undefined ? nextInstruction : existing.instruction,
          enabled: hasEnabled ? inputArgs.enabled : Boolean(existing.enabled),
        },
        query: {},
      });
      return sanitizeWebhookRoute(updated);
    },

    async automation_webhook_delete(args, rawActor) {
      validateActor(rawActor);
      const inputArgs = requirePlainObject(args);
      rejectUnknownFields(inputArgs, WEBHOOK_ID_ONLY_FIELDS);
      const id = assertWebhookId(inputArgs.id);
      const owner = requireOwnerAdapter(deps);
      await owner('DELETE', '/api/webhooks/:id', { params: { id }, query: {} });
      return { deleted: true, id };
    },
  };
}
