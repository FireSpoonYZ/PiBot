// plugins/tasks/task-tool.js
// Unified `task` tool replacing legacy per-conversation `todo`. Bridges both
// single-Bot step tracking and Center-backed global multi-Bot task coordination,
// enforcing role-based boundaries and expectedRevision CAS on mutations.

const STEP_STATUSES = ['unassigned', 'todo', 'working', 'waiting', 'blocked', 'done', 'cancelled'];
const STEP_STATUS_SET = new Set(STEP_STATUSES);
const TASK_STATUS_SET = new Set(['triaging', 'working', 'waiting', 'done', 'cancelled']);
const LIST_STATUS_SET = new Set(['all', 'active', 'waiting', 'done']);
const ADOPTION_PHASES = ['recorded', 'adjusting', 'needs_scope', 'adopted'];
const ADOPTION_PHASE_SET = new Set(ADOPTION_PHASES);
const ALL_STATUS_ENUM = [
  'all',
  'active',
  'triaging',
  'unassigned',
  'todo',
  'working',
  'waiting',
  'blocked',
  'done',
  'cancelled',
];
const ACTIONS = [
  'create',
  'list',
  'get',
  'assign',
  'propose_plan',
  'ask_clarification',
  'update',
  'add_steps',
  'update_step',
  'complete',
];
const TOOL_ERROR_CODES = new Set([
  'INVALID_ARGUMENT',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'TASK_NOT_FOUND',
  'REQUEST_CONFLICT',
  'REVISION_CONFLICT',
  'CENTER_OFFLINE',
  'EXTENSION_DISABLED',
  'BOT_CONTEXT_REQUIRED',
  'FORBIDDEN',
]);

const STEP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    parentStepId: { type: ['string', 'null'] },
    text: { type: 'string', minLength: 1, maxLength: 500 },
    status: { type: 'string', enum: STEP_STATUSES },
    deviceId: { type: ['string', 'null'] },
    botId: { type: ['string', 'null'] },
    dependsOnStepIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, maxItems: 32 },
    preserved: { type: 'boolean' },
    relationNote: { type: 'string', maxLength: 500 },
    resultSummary: { type: 'string', maxLength: 2000 },
  },
  required: ['text'],
  additionalProperties: false,
};

const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    taskId: { type: 'string', minLength: 1, maxLength: 128 },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    requirement: { type: 'string', maxLength: 8000 },
    summary: { type: 'string', maxLength: 2000 },
    originKind: { type: 'string', enum: ['chat', 'voice'] },
    directStart: { type: 'boolean' },
    coordinatorDeviceId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Target coordinator deviceId for action="assign" (optional when botId uniquely identifies a Bot in the directory).',
    },
    coordinatorBotId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Target coordinator botId for action="assign" when dispatching or transferring task coordination.',
    },
    planText: { type: 'string', minLength: 1, maxLength: 2000 },
    question: { type: 'string', minLength: 1, maxLength: 2000 },
    options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 8 },
    steps: { type: 'array', items: STEP_INPUT_SCHEMA, maxItems: 100 },
    stepId: { type: 'string', minLength: 1, maxLength: 128 },
    text: { type: 'string', minLength: 1, maxLength: 2000 },
    status: {
      type: 'string',
      enum: ALL_STATUS_ENUM,
      description: 'Filter for list (all|active|waiting|done), task status for update (triaging|working|waiting|done|cancelled), or step status for add_steps/update_step.',
    },
    deviceId: { type: 'string', minLength: 1, maxLength: 128 },
    botId: { type: 'string', minLength: 1, maxLength: 128 },
    relationNote: { type: 'string', maxLength: 500 },
    resultSummary: { type: 'string', maxLength: 2000 },
    adoptionPhase: {
      type: 'string',
      enum: ADOPTION_PHASES,
      description: 'Adoption phase for requirement change handling: recorded | adjusting | needs_scope | adopted.',
    },
    shortReceipt: { type: 'string', maxLength: 500 },
    scopeDesc: {
      type: 'string',
      maxLength: 1000,
      description: 'Targeted scope clarification description when adoptionPhase="needs_scope" (explaining what needs keep/redo confirmation).',
    },
    changeText: { type: 'string', maxLength: 2000 },
    cursor: {
      anyOf: [
        {
          type: 'object',
          properties: {
            updatedAt: { type: 'number' },
            id: { type: 'string', minLength: 1, maxLength: 128 },
          },
          required: ['updatedAt', 'id'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
      description: 'Pagination cursor from previous list response nextCursor (allowed only for action="list").',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

const err = (code, message) => Object.assign(new Error(message), { code });

function clipText(value, maxLen) {
  if (typeof value !== 'string') return '';
  const wellFormed = value.toWellFormed().trim();
  if (wellFormed.length <= maxLen) return wellFormed;
  let end = maxLen;
  const code = wellFormed.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return wellFormed.slice(0, end);
}

function cleanOptionalText(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.toWellFormed().trim();
  return trimmed ? trimmed : undefined;
}

function cleanOptions(options) {
  if (!Array.isArray(options)) return undefined;
  const cleaned = options
    .map((item) => clipText(item, 200))
    .filter(Boolean)
    .slice(0, 8);
  return cleaned.length > 0 ? cleaned : undefined;
}

function botDisplayName(bot) {
  return bot?.name ?? bot?.botName ?? bot?.role ?? bot?.botId ?? '';
}

function isCoordinator(task, selfDeviceId, selfBotId) {
  return task?.coordinatorBotId === selfBotId && (!task.coordinatorDeviceId || task.coordinatorDeviceId === selfDeviceId);
}

function resolveBotTarget(inputBotId, inputDeviceId, directoryBots, selfDeviceId, selfBotId, fallbackToSelf, requireUniqueDevice = false) {
  if (inputBotId === null) return { deviceId: null, botId: null };
  const botRef = cleanOptionalText(inputBotId);
  const devRef = cleanOptionalText(inputDeviceId);
  if (botRef) {
    if (devRef) return { deviceId: devRef, botId: botRef };
    const byId = directoryBots.filter((b) => b.botId === botRef);
    if (byId.length === 1) return { deviceId: byId[0].deviceId, botId: byId[0].botId };
    if (byId.length > 1) {
      if (requireUniqueDevice) {
        throw err('INVALID_ARGUMENT', `botId "${botRef}" 在多台设备上存在，请明确传入 deviceId/coordinatorDeviceId。`);
      }
      const local = byId.find((b) => b.deviceId === selfDeviceId);
      return { deviceId: (local ?? byId[0]).deviceId, botId: (local ?? byId[0]).botId };
    }
    const byName = directoryBots.filter((b) => botDisplayName(b) === botRef);
    if (byName.length === 1) return { deviceId: byName[0].deviceId, botId: byName[0].botId };
    if (byName.length > 1) {
      if (requireUniqueDevice) {
        throw err('INVALID_ARGUMENT', `名称 "${botRef}" 匹配到多个 Bot，请明确传入 deviceId 与 botId。`);
      }
      const local = byName.find((b) => b.deviceId === selfDeviceId);
      if (local) return { deviceId: local.deviceId, botId: local.botId };
    }
    return { deviceId: selfDeviceId, botId: botRef };
  }
  if (devRef) return { deviceId: devRef, botId: null };
  if (fallbackToSelf) return { deviceId: selfDeviceId, botId: selfBotId };
  return { deviceId: null, botId: null };
}

function normalizeStepInput(step, directoryBots, selfDeviceId, selfBotId, defaultStatus = 'todo') {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw err('INVALID_ARGUMENT', 'step entry must be an object');
  }
  const text = cleanOptionalText(step.text);
  if (!text) throw err('INVALID_ARGUMENT', 'step text must not be empty');
  if (step.status !== undefined && !STEP_STATUS_SET.has(step.status)) {
    throw err('INVALID_ARGUMENT', `invalid step status: ${String(step.status)}`);
  }
  const explicitUnassigned = step.status === 'unassigned' || step.botId === null;
  const target = resolveBotTarget(
    step.botId,
    step.deviceId,
    directoryBots,
    selfDeviceId,
    selfBotId,
    !explicitUnassigned,
  );
  const status = step.status ?? (target.botId ? defaultStatus : 'unassigned');
  const out = {
    text,
    status,
    deviceId: target.deviceId,
    botId: target.botId,
  };
  if (cleanOptionalText(step.id)) out.id = cleanOptionalText(step.id);
  if (step.parentStepId !== undefined) out.parentStepId = step.parentStepId;
  if (Array.isArray(step.dependsOnStepIds)) {
    out.dependsOnStepIds = step.dependsOnStepIds.map((d) => cleanOptionalText(d)).filter(Boolean);
  }
  if (typeof step.preserved === 'boolean') out.preserved = step.preserved;
  if (cleanOptionalText(step.relationNote)) out.relationNote = cleanOptionalText(step.relationNote);
  if (cleanOptionalText(step.resultSummary)) out.resultSummary = cleanOptionalText(step.resultSummary);
  return out;
}

function buildAdoptionPatch(args) {
  const phase = args.adoptionPhase;
  const shortReceipt = cleanOptionalText(args.shortReceipt);
  const scopeDesc = cleanOptionalText(args.scopeDesc);
  const changeText = cleanOptionalText(args.changeText);
  if (phase !== undefined && !ADOPTION_PHASE_SET.has(phase)) {
    throw err('INVALID_ARGUMENT', 'adoptionPhase must be recorded, adjusting, needs_scope, or adopted');
  }
  if (phase === undefined && !shortReceipt && !scopeDesc && !changeText) {
    return undefined;
  }
  const resolvedPhase = phase ?? (scopeDesc ? 'needs_scope' : 'adopted');
  if (resolvedPhase === 'needs_scope' && !scopeDesc) {
    throw err('INVALID_ARGUMENT', 'adoptionPhase="needs_scope" requires scopeDesc explaining what needs keep/redo clarification');
  }
  const patch = { phase: resolvedPhase };
  if (shortReceipt) patch.shortReceipt = shortReceipt;
  if (scopeDesc) patch.scopeDesc = scopeDesc;
  if (changeText) patch.changeText = changeText;
  return patch;
}

function validateDoneStepsPreserved(existingTask, nextSteps) {
  if (!Array.isArray(nextSteps)) return;
  const existingDone = (existingTask?.steps ?? []).filter((s) => s.status === 'done');
  if (existingDone.length === 0) return;
  const nextById = new Map(nextSteps.filter((s) => s.id).map((s) => [s.id, s]));
  for (const doneStep of existingDone) {
    const kept = nextById.get(doneStep.id);
    if (!kept || kept.status !== 'done') {
      throw err(
        'INVALID_ARGUMENT',
        `已完成步骤 ${doneStep.id}（${doneStep.text}）必须保留为 done，不得覆盖或退回；如需重做请先通过 adoptionPhase="needs_scope" 向用户澄清范围。`,
      );
    }
    if (existingTask.adoption?.phase === 'adjusting' && kept.preserved === undefined) {
      kept.preserved = true;
    }
  }
}

function computeStepCounts(task) {
  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const activeSteps = steps.filter((s) => s.status !== 'cancelled');
  const done = activeSteps.filter((s) => s.status === 'done').length;
  return { done, total: activeSteps.length };
}

function deriveCardLabel(task, stepCount, isCreate) {
  if (isCreate) {
    if (task.pendingPrompt?.kind === 'plan') return '已记入全局任务 · 待确认安排';
    if (task.pendingPrompt?.kind === 'question') return '已记入全局任务 · 待你回应';
    if (task.status === 'working') return '已记入全局任务 · 进行中';
    if (task.status === 'done') return '已记入全局任务 · 已完成';
    return '已记入全局任务';
  }
  if (task.pendingPrompt?.kind === 'plan') return '待确认安排';
  if (task.pendingPrompt?.kind === 'question') return '待你回应 · 思路澄清';
  if (task.adoption?.phase === 'needs_scope') return '待你确认变更范围';
  if (task.status === 'done') return '任务已完成';
  if (task.status === 'cancelled') return '任务已取消';
  if (task.status === 'waiting') return '全局任务 · 等待中';
  if (task.status === 'triaging') return '全局任务 · 梳理中';
  return stepCount.total > 0 ? `全局任务 · 进行中 (${stepCount.done}/${stepCount.total})` : '全局任务 · 进行中';
}

function resolveStepBotName(step, directoryBots) {
  const explicit = cleanOptionalText(step?.botName);
  if (explicit) return explicit;
  if (!step?.botId) return '';
  const match = directoryBots.find((b) => b.botId === step.botId && (!step.deviceId || b.deviceId === step.deviceId))
    ?? directoryBots.find((b) => b.botId === step.botId);
  return cleanOptionalText(botDisplayName(match)) ?? '';
}

function buildTaskPresentation(installationId, task, directoryBots, selfBotId, { isCreate = false, cardLabel } = {}) {
  const stepCount = computeStepCounts(task);
  const label = clipText(cardLabel || deriveCardLabel(task, stepCount, isCreate), 120) || '全局任务';
  const presentation = {
    kind: 'task',
    version: 1,
    installationId,
    taskId: clipText(String(task.id ?? ''), 128),
    title: clipText(String(task.title ?? ''), 300) || '未命名任务',
    status: TASK_STATUS_SET.has(task.status) ? task.status : 'working',
    cardLabel: label,
    stepCount,
    pendingPrompt: null,
  };
  const summary = clipText(task.summary, 500);
  if (summary) presentation.summary = summary;
  if (task.pendingPrompt && typeof task.pendingPrompt === 'object') {
    const prompt = {
      kind: task.pendingPrompt.kind === 'question' ? 'question' : 'plan',
      botId: clipText(String(task.pendingPrompt.botId || selfBotId), 128) || selfBotId,
      text: clipText(String(task.pendingPrompt.text ?? ''), 1000) || '请确认当前安排',
    };
    const opts = cleanOptions(task.pendingPrompt.options);
    if (opts) prompt.options = opts;
    presentation.pendingPrompt = prompt;
  }
  if (Array.isArray(task.steps) && task.steps.length > 0) {
    presentation.stepsPreview = task.steps.slice(0, 20).map((step) => {
      const preview = {
        id: clipText(String(step.id ?? ''), 128) || 'step',
        text: clipText(String(step.text ?? ''), 300) || '(未命名步骤)',
        status: STEP_STATUS_SET.has(step.status) ? step.status : 'todo',
      };
      const botName = clipText(resolveStepBotName(step, directoryBots), 80);
      if (botName) preview.botName = botName;
      return preview;
    });
  }
  return presentation;
}

function formatTaskSummaryText(task, directoryBots, extraNote) {
  const coordOwner = task.coordinatorBotId
    ? (resolveStepBotName({ botId: task.coordinatorBotId, deviceId: task.coordinatorDeviceId }, directoryBots) || task.coordinatorBotId)
    : '未指定';
  const lines = [
    `taskId: ${task.id}`,
    `标题: ${task.title}`,
    `状态: ${task.status} (revision=${task.revision ?? 0}, 协调人=${coordOwner})`,
  ];
  if (task.summary) lines.push(`摘要: ${task.summary}`);
  if (task.pendingPrompt) {
    const opts = task.pendingPrompt.options?.length ? `（选项: ${task.pendingPrompt.options.join(' / ')}）` : '';
    lines.push(`待回应 [${task.pendingPrompt.kind}]: ${task.pendingPrompt.text}${opts}`);
  }
  if (task.adoption && task.adoption.phase !== 'adopted') {
    const scope = task.adoption.scopeDesc ? ` | 范围说明: ${task.adoption.scopeDesc}` : '';
    lines.push(`需求变更 [${task.adoption.phase}]: ${task.adoption.changeText}${scope}`);
  }
  const steps = Array.isArray(task.steps) ? task.steps : [];
  if (steps.length > 0) {
    lines.push('步骤:');
    for (const step of steps) {
      const owner = resolveStepBotName(step, directoryBots) || step.botId;
      const ownerTag = owner ? ` (@${owner})` : '';
      const preservedTag = step.preserved ? ' [保留成果]' : '';
      lines.push(`- [${step.status}] ${step.id}: ${step.text}${ownerTag}${preservedTag}`);
    }
  }
  if (extraNote) lines.push(extraNote);
  return lines.join('\n');
}

function normalizeListCursor(cursor) {
  if (cursor === undefined) return undefined;
  if (cursor === null) return null;
  if (typeof cursor !== 'object' || Array.isArray(cursor)) {
    throw err('INVALID_ARGUMENT', 'cursor must be { updatedAt, id } or null');
  }
  if (typeof cursor.updatedAt !== 'number' || !Number.isFinite(cursor.updatedAt)) {
    throw err('INVALID_ARGUMENT', 'cursor.updatedAt must be a finite number');
  }
  const id = cleanOptionalText(cursor.id);
  if (!id) throw err('INVALID_ARGUMENT', 'cursor.id must be a non-empty string');
  return cursor;
}

function formatTaskListText(tasks, nextCursor = null) {
  if (!tasks.length) {
    return nextCursor
      ? `本页 0 条全局任务（仍有更多，请传入下方 cursor 继续调用 action="list" 翻页）：\nnextCursor: ${JSON.stringify(nextCursor)}`
      : '本页 0 条全局任务（已至末页，无更多任务）。';
  }
  const header = nextCursor
    ? `本页 ${tasks.length} 条全局任务（仍有更多，可传入下方 nextCursor 作为 cursor 继续调用 action="list" 翻页）：`
    : `本页 ${tasks.length} 条全局任务（已至末页，无更多任务）：`;
  const lines = [
    header,
    ...tasks.map((task) => {
      const { done, total } = computeStepCounts(task);
      const pendingTag = task.pendingPrompt ? ` | 待回应:${task.pendingPrompt.kind}` : '';
      return `- ${task.id} [${task.status}] ${task.title} (${done}/${total})${pendingTag}`;
    }),
  ];
  if (nextCursor) lines.push(`nextCursor: ${JSON.stringify(nextCursor)}`);
  return lines.join('\n');
}

function buildOrigin(args, selfDeviceId, selfBotId, conversationId) {
  return {
    kind: args.originKind === 'voice' ? 'voice' : 'chat',
    deviceId: selfDeviceId,
    botId: selfBotId,
    conversationId: conversationId === undefined || conversationId === null ? null : String(conversationId),
  };
}

function errorResult(error) {
  const code = typeof error?.code === 'string' && TOOL_ERROR_CODES.has(error.code) ? error.code : 'INTERNAL';
  const message = typeof error?.message === 'string' ? error.message.slice(0, 300) : 'task operation failed';
  return { output: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true };
}

export function createTaskTool({ defineTool, installationId, host, deviceId: selfDeviceId, botId: selfBotId }) {
  async function listActiveForSelf(conversationId, nativeTaskId) {
    const res = await host.tasks.invoke(
      selfBotId,
      { action: 'list', status: 'active', botDeviceId: selfDeviceId, botId: selfBotId, limit: 50 },
      conversationId,
      nativeTaskId,
    );
    const active = (res?.tasks ?? []).filter((t) => t && t.status !== 'done' && t.status !== 'cancelled');
    return { active, nextCursor: res?.nextCursor ?? null };
  }

  async function requireTaskId(explicitTaskId, conversationId, nativeTaskId) {
    const id = cleanOptionalText(explicitTaskId);
    if (id) return id;
    const { active, nextCursor } = await listActiveForSelf(conversationId, nativeTaskId);
    if (nextCursor) {
      throw err(
        'INVALID_ARGUMENT',
        `当前活跃全局任务超过本页上限（存在 nextCursor=${JSON.stringify(nextCursor)}），无法自动确认唯一任务，请明确传入 taskId（可先使用 action="list" 翻页查找）。`,
      );
    }
    if (active.length === 1) return active[0].id;
    if (active.length === 0) {
      throw err('INVALID_ARGUMENT', '当前没有未完成的活跃全局任务，请传入 taskId 或先创建任务。');
    }
    throw err(
      'INVALID_ARGUMENT',
      `当前有 ${active.length} 个未完成全局任务，请明确传入 taskId：${active.map((t) => `${t.id}(${t.title})`).join('、')}`,
    );
  }

  async function getTaskSnapshot(taskId, conversationId, nativeTaskId) {
    const res = await host.tasks.invoke(selfBotId, { action: 'get', taskId }, conversationId, nativeTaskId);
    if (!res?.task) throw err('TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
    return res.task;
  }

  async function publishTaskResult(task, directoryBots, api, context, { isCreate = false, cardLabel, extraNote } = {}) {
    const presentation = buildTaskPresentation(installationId, task, directoryBots, selfBotId, { isCreate, cardLabel });
    const details = { presentation };
    await api.details(details, context);
    return {
      output: [{ type: 'text', text: formatTaskSummaryText(task, directoryBots, extraNote) }],
      details,
    };
  }

  async function run(args, api, context) {
    if (!host?.tasks?.invoke) {
      throw err('EXTENSION_DISABLED', 'Host tasks service is unavailable.');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw err('INVALID_ARGUMENT', 'arguments must be an object');
    }
    if (args.cursor !== undefined && args.action !== 'list') {
      throw err('INVALID_ARGUMENT', 'cursor is only allowed for action="list"');
    }
    const conversationId = api.conversationId;
    const nativeTaskId = api.taskId;
    const directoryBots = (await Promise.resolve(host.tasks.listDirectoryBots?.(selfBotId, conversationId))) ?? [];
    const adoptionPatch = buildAdoptionPatch(args);

    switch (args.action) {
      case 'list': {
        if (args.status !== undefined && !LIST_STATUS_SET.has(args.status)) {
          throw err('INVALID_ARGUMENT', 'list status must be all, active, waiting, or done');
        }
        const cursor = normalizeListCursor(args.cursor);
        const listStatus = args.status ?? 'all';
        const target = args.botId || args.deviceId
          ? resolveBotTarget(args.botId, args.deviceId, directoryBots, selfDeviceId, selfBotId, false)
          : null;
        const res = await host.tasks.invoke(
          selfBotId,
          {
            action: 'list',
            status: listStatus,
            ...(target?.deviceId ? { botDeviceId: target.deviceId } : {}),
            ...(target?.botId ? { botId: target.botId } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
            limit: 50,
          },
          conversationId,
          nativeTaskId,
        );
        return { output: [{ type: 'text', text: formatTaskListText(res?.tasks ?? [], res?.nextCursor ?? null) }] };
      }

      case 'get': {
        const taskId = await requireTaskId(args.taskId, conversationId, nativeTaskId);
        const task = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
        return publishTaskResult(task, directoryBots, api, context);
      }

      case 'assign': {
        const coordinatorBotRef = cleanOptionalText(args.coordinatorBotId);
        if (!coordinatorBotRef) {
          throw err('INVALID_ARGUMENT', 'assign requires coordinatorBotId');
        }
        const taskId = await requireTaskId(args.taskId, conversationId, nativeTaskId);
        const target = resolveBotTarget(
          coordinatorBotRef,
          args.coordinatorDeviceId,
          directoryBots,
          selfDeviceId,
          selfBotId,
          false,
          true,
        );
        if (!target.botId || !target.deviceId) {
          throw err('INVALID_ARGUMENT', 'assign requires valid coordinatorDeviceId and coordinatorBotId');
        }
        const existing = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
        const selfDirEntry = directoryBots.find((b) => b && b.botId === selfBotId && b.deviceId === selfDeviceId);
        const isDispatcher = Boolean(selfDirEntry?.isDispatcher || selfDirEntry?.dispatcher);
        if (existing.coordinatorBotId && !isCoordinator(existing, selfDeviceId, selfBotId) && !isDispatcher) {
          throw err('FORBIDDEN', '仅当前任务协调人（或授权的任务分派 Bot）可以调用 assign 指派负责人。');
        }
        const res = await host.tasks.invoke(
          selfBotId,
          {
            action: 'assign',
            taskId,
            expectedRevision: existing.revision,
            coordinatorDeviceId: target.deviceId,
            coordinatorBotId: target.botId,
          },
          conversationId,
          nativeTaskId,
        );
        const targetName = resolveStepBotName(
          { botId: target.botId, deviceId: target.deviceId },
          directoryBots,
        ) || target.botId;
        return publishTaskResult(res.task, directoryBots, api, context, {
          cardLabel: '已分派任务负责人',
          extraNote: `已将任务协调人分派给 @${targetName} (${target.deviceId}/${target.botId})，由对方继续推进与统筹。`,
        });
      }

      case 'create': {
        const title = cleanOptionalText(args.title);
        const requirement = cleanOptionalText(args.requirement);
        const text = cleanOptionalText(args.text) ?? requirement ?? title;
        if (!title && !text) {
          throw err('INVALID_ARGUMENT', 'create requires title, requirement, or text');
        }
        const steps = Array.isArray(args.steps)
          ? args.steps.map((s) => normalizeStepInput(s, directoryBots, selfDeviceId, selfBotId, 'todo'))
          : undefined;
        const question = cleanOptionalText(args.question);
        const planText = cleanOptionalText(args.planText);
        const options = cleanOptions(args.options);
        const pendingPrompt = question
          ? { kind: 'question', text: question, ...(options ? { options } : {}) }
          : planText
            ? { kind: 'plan', text: planText }
            : undefined;
        const directStart = args.directStart !== undefined
          ? Boolean(args.directStart)
          : pendingPrompt
            ? false
            : undefined;
        const coordTarget = args.coordinatorBotId || args.coordinatorDeviceId
          ? resolveBotTarget(args.coordinatorBotId, args.coordinatorDeviceId, directoryBots, selfDeviceId, selfBotId, true, true)
          : { deviceId: selfDeviceId, botId: selfBotId };
        const payload = {
          action: 'create',
          ...(title ? { title } : {}),
          ...(requirement ? { requirement } : {}),
          ...(text ? { text } : {}),
          origin: buildOrigin(args, selfDeviceId, selfBotId, conversationId),
          coordinatorDeviceId: coordTarget.deviceId,
          coordinatorBotId: coordTarget.botId,
          ...(directStart !== undefined ? { directStart } : {}),
          ...(pendingPrompt ? { pendingPrompt } : {}),
          ...(steps ? { steps } : {}),
        };
        const res = await host.tasks.invoke(selfBotId, payload, conversationId, nativeTaskId);
        const note = pendingPrompt?.kind === 'plan'
          ? '计划已提交待用户确认：请立即停止后续执行，等待用户在界面点击确认安排并开始。'
          : pendingPrompt?.kind === 'question'
            ? '澄清问题已发出：请暂停依赖该答复的步骤，等待用户回应。'
            : undefined;
        return publishTaskResult(res.task, directoryBots, api, context, { isCreate: true, extraNote: note });
      }

      case 'propose_plan': {
        const explicitId = cleanOptionalText(args.taskId);
        const title = cleanOptionalText(args.title);
        const requirement = cleanOptionalText(args.requirement);
        const text = cleanOptionalText(args.text);
        const summary = cleanOptionalText(args.summary);
        const planText = cleanOptionalText(args.planText) || '已拟好分步安排，请确认后开始推进。';
        const steps = Array.isArray(args.steps)
          ? args.steps.map((s) => normalizeStepInput(s, directoryBots, selfDeviceId, selfBotId, 'todo'))
          : undefined;
        let taskId = explicitId;
        if (!taskId && !title && !requirement && !text) {
          const { active, nextCursor } = await listActiveForSelf(conversationId, nativeTaskId);
          if (nextCursor) {
            throw err(
              'INVALID_ARGUMENT',
              `当前活跃全局任务超过本页上限（存在 nextCursor=${JSON.stringify(nextCursor)}），无法自动定位唯一任务，请明确传入 taskId 或提供 title/requirement 以新建任务。`,
            );
          }
          if (active.length === 1) {
            taskId = active[0].id;
          } else if (active.length > 1) {
            throw err(
              'INVALID_ARGUMENT',
              `当前有 ${active.length} 个未完成全局任务，请传入 taskId 或提供 title/requirement 新建任务：${active.map((t) => `${t.id}(${t.title})`).join('、')}`,
            );
          } else if (!steps?.length) {
            throw err('INVALID_ARGUMENT', 'propose_plan 需要传入 taskId，或提供 title/requirement/steps 以创建任务。');
          }
        }
        const pendingPrompt = { kind: 'plan', text: planText };
        let res;
        let isCreate = false;
        if (taskId) {
          const existing = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
          if (!isCoordinator(existing, selfDeviceId, selfBotId)) {
            throw err(
              'FORBIDDEN',
              '仅任务协调人可以调用 propose_plan 提交或替换整份计划；普通执行 Bot 请使用 update_step 更新本人负责的步骤。',
            );
          }
          if (existing.adoption?.phase === 'adjusting') {
            throw err(
              'INVALID_ARGUMENT',
              '当前任务处于已批准的需求变更调整阶段，请保留已完成步骤成果，使用 update（stepPatches/addSteps）或 add_steps 仅调整未完成步骤或新增补做项并附 shortReceipt，不要调用 propose_plan 重新提交确认。',
            );
          }
          if (existing.adoption?.phase === 'needs_scope') {
            throw err(
              'INVALID_ARGUMENT',
              '当前任务正在等待用户确认变更处理范围（保留成果或重做），请先等待用户选择，不要调用 propose_plan 覆盖。',
            );
          }
          validateDoneStepsPreserved(existing, steps);
          res = await host.tasks.invoke(
            selfBotId,
            {
              action: 'update',
              taskId,
              expectedRevision: existing.revision,
              ...(title ? { title } : {}),
              ...(requirement ? { requirement } : {}),
              ...(summary ? { summary } : {}),
              ...(steps ? { steps } : {}),
              ...(adoptionPatch ? { adoption: adoptionPatch } : {}),
              pendingPrompt,
            },
            conversationId,
            nativeTaskId,
          );
        } else {
          isCreate = true;
          const fallbackText = text ?? requirement ?? title ?? steps?.[0]?.text ?? planText;
          res = await host.tasks.invoke(
            selfBotId,
            {
              action: 'create',
              ...(title ? { title } : {}),
              ...(requirement ? { requirement } : {}),
              text: fallbackText,
              origin: buildOrigin(args, selfDeviceId, selfBotId, conversationId),
              coordinatorDeviceId: selfDeviceId,
              coordinatorBotId: selfBotId,
              directStart: false,
              ...(steps ? { steps } : {}),
              pendingPrompt,
            },
            conversationId,
            nativeTaskId,
          );
        }
        return publishTaskResult(res.task, directoryBots, api, context, {
          isCreate,
          cardLabel: isCreate ? '已记入全局任务 · 待确认安排' : '待确认安排',
          extraNote: '已提交分步计划等待用户确认：请停止实际执行与派发，等待用户在界面点击「确认安排并开始」（普通聊天回复不代表批准开工）。',
        });
      }

      case 'ask_clarification': {
        const question = cleanOptionalText(args.question) ?? cleanOptionalText(args.text);
        if (!question) throw err('INVALID_ARGUMENT', 'ask_clarification requires question');
        const options = cleanOptions(args.options);
        const pendingPrompt = { kind: 'question', text: question, ...(options ? { options } : {}) };
        const explicitId = cleanOptionalText(args.taskId);
        const title = cleanOptionalText(args.title);
        const requirement = cleanOptionalText(args.requirement);
        const summary = cleanOptionalText(args.summary);
        let stepId = cleanOptionalText(args.stepId);
        let taskId = explicitId;
        if (!taskId && !title && !requirement) {
          taskId = await requireTaskId(undefined, conversationId, nativeTaskId);
        }
        let res;
        let isCreate = false;
        if (taskId) {
          const existing = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
          const coord = isCoordinator(existing, selfDeviceId, selfBotId);
          if (!coord) {
            if (summary || adoptionPatch) {
              throw err('FORBIDDEN', '仅任务协调人可以修改任务摘要或需求变更状态（adoption）。');
            }
            if (existing.pendingPrompt) {
              throw err('REQUEST_CONFLICT', '当前任务已有待回应提示，普通执行 Bot 不得覆盖现有待确认/待回应提示。');
            }
            const ownActiveSteps = (existing.steps ?? []).filter(
              (s) => s.botId === selfBotId && (!s.deviceId || s.deviceId === selfDeviceId) && s.status !== 'done' && s.status !== 'cancelled',
            );
            if (stepId) {
              const targetStep = (existing.steps ?? []).find((s) => s.id === stepId);
              if (!targetStep || targetStep.botId !== selfBotId || (targetStep.deviceId && targetStep.deviceId !== selfDeviceId)) {
                throw err('FORBIDDEN', '普通执行 Bot 仅可对指派给自己的步骤发起澄清问题。');
              }
            } else if (ownActiveSteps.length === 1) {
              stepId = ownActiveSteps[0].id;
            } else {
              throw err('FORBIDDEN', '普通执行 Bot 发起澄清需指定本人负责的 stepId。');
            }
          }
          res = await host.tasks.invoke(
            selfBotId,
            {
              action: 'update',
              taskId,
              expectedRevision: existing.revision,
              status: 'waiting',
              ...(coord && summary ? { summary } : {}),
              pendingPrompt,
              ...(stepId ? { stepPatches: [{ stepId, status: 'waiting' }] } : {}),
              ...(coord && adoptionPatch ? { adoption: adoptionPatch } : {}),
            },
            conversationId,
            nativeTaskId,
          );
        } else {
          isCreate = true;
          const steps = Array.isArray(args.steps)
            ? args.steps.map((s) => normalizeStepInput(s, directoryBots, selfDeviceId, selfBotId, 'todo'))
            : undefined;
          res = await host.tasks.invoke(
            selfBotId,
            {
              action: 'create',
              ...(title ? { title } : {}),
              ...(requirement ? { requirement } : {}),
              text: requirement ?? title ?? question,
              origin: buildOrigin(args, selfDeviceId, selfBotId, conversationId),
              coordinatorDeviceId: selfDeviceId,
              coordinatorBotId: selfBotId,
              directStart: false,
              ...(steps ? { steps } : {}),
              pendingPrompt,
            },
            conversationId,
            nativeTaskId,
          );
        }
        return publishTaskResult(res.task, directoryBots, api, context, {
          isCreate,
          cardLabel: '待你回应 · 思路澄清',
          extraNote: '澄清问题已提交并等待用户回应，请暂停受阻工作直到收到答复。',
        });
      }

      case 'add_steps': {
        const explicitId = cleanOptionalText(args.taskId);
        const title = cleanOptionalText(args.title);
        const requirement = cleanOptionalText(args.requirement);
        const singleText = cleanOptionalText(args.text);
        if (args.status !== undefined && !STEP_STATUS_SET.has(args.status)) {
          throw err('INVALID_ARGUMENT', `invalid step status for add_steps: ${String(args.status)}`);
        }
        const rawSteps = Array.isArray(args.steps) && args.steps.length > 0
          ? args.steps
          : singleText
            ? [{
                text: singleText,
                ...(args.status ? { status: args.status } : {}),
                ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
                ...(args.botId !== undefined ? { botId: args.botId } : {}),
                ...(args.relationNote ? { relationNote: args.relationNote } : {}),
              }]
            : [];
        if (rawSteps.length === 0) {
          throw err('INVALID_ARGUMENT', 'add_steps requires steps or text');
        }
        const normalizedSteps = rawSteps.map((s) =>
          normalizeStepInput(s, directoryBots, selfDeviceId, selfBotId, 'todo'),
        );
        let taskId = explicitId;
        if (!taskId && !title) {
          const { active, nextCursor } = await listActiveForSelf(conversationId, nativeTaskId);
          if (nextCursor) {
            throw err(
              'INVALID_ARGUMENT',
              `当前活跃全局任务超过本页上限（存在 nextCursor=${JSON.stringify(nextCursor)}），无法自动定位唯一任务或判断是否无活跃任务，请明确传入 taskId 或提供 title 以新建任务。`,
            );
          }
          if (active.length === 1) {
            taskId = active[0].id;
          } else if (active.length > 1) {
            throw err(
              'INVALID_ARGUMENT',
              `当前有 ${active.length} 个未完成全局任务，请传入 taskId 或提供 title 以新建任务：${active.map((t) => `${t.id}(${t.title})`).join('、')}`,
            );
          }
        }
        if (taskId) {
          const existing = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
          if (!isCoordinator(existing, selfDeviceId, selfBotId)) {
            throw err(
              'FORBIDDEN',
              '仅任务协调人可以调用 add_steps 向全局任务追加步骤；普通执行 Bot 请使用 update_step 更新本人负责的步骤。',
            );
          }
          const res = await host.tasks.invoke(
            selfBotId,
            {
              action: 'update',
              taskId,
              expectedRevision: existing.revision,
              ...(cleanOptionalText(args.summary) ? { summary: cleanOptionalText(args.summary) } : {}),
              addSteps: normalizedSteps,
              ...(adoptionPatch ? { adoption: adoptionPatch } : {}),
            },
            conversationId,
            nativeTaskId,
          );
          return publishTaskResult(res.task, directoryBots, api, context, { cardLabel: '全局任务 · 已追加步骤' });
        }
        const autoTitle = title ?? clipText(normalizedSteps[0].text, 80);
        const res = await host.tasks.invoke(
          selfBotId,
          {
            action: 'create',
            title: autoTitle,
            ...(requirement ? { requirement } : {}),
            text: requirement ?? singleText ?? normalizedSteps.map((s) => s.text).join('；'),
            origin: buildOrigin(args, selfDeviceId, selfBotId, conversationId),
            coordinatorDeviceId: selfDeviceId,
            coordinatorBotId: selfBotId,
            directStart: args.directStart ?? true,
            steps: normalizedSteps,
          },
          conversationId,
          nativeTaskId,
        );
        return publishTaskResult(res.task, directoryBots, api, context, { isCreate: true });
      }

      case 'update_step': {
        const stepId = cleanOptionalText(args.stepId);
        if (!stepId) throw err('INVALID_ARGUMENT', 'update_step requires stepId');
        if (args.status !== undefined && !STEP_STATUS_SET.has(args.status)) {
          throw err('INVALID_ARGUMENT', `invalid step status for update_step: ${String(args.status)}`);
        }
        const taskId = await requireTaskId(args.taskId, conversationId, nativeTaskId);
        const existing = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
        const targetStep = (existing.steps ?? []).find((s) => s.id === stepId);
        if (!targetStep) {
          throw err('NOT_FOUND', `步骤 ${stepId} 不存在`);
        }
        const coord = isCoordinator(existing, selfDeviceId, selfBotId);
        const isOwnStep = targetStep.botId === selfBotId && (!targetStep.deviceId || targetStep.deviceId === selfDeviceId);
        const summary = cleanOptionalText(args.summary);

        if (!coord) {
          if (!isOwnStep) {
            throw err('FORBIDDEN', '普通执行 Bot 仅可更新指派给自己的步骤，不得修改他人或未指派步骤。');
          }
          if (summary || adoptionPatch) {
            throw err('FORBIDDEN', '普通执行 Bot 不得修改父任务摘要或需求变更状态（adoption）。');
          }
        }

        const patch = { stepId };
        if (cleanOptionalText(args.text)) patch.text = cleanOptionalText(args.text);
        if (args.status !== undefined) patch.status = args.status;
        if (args.botId !== undefined || args.deviceId !== undefined) {
          const target = resolveBotTarget(args.botId, args.deviceId, directoryBots, selfDeviceId, selfBotId, false);
          if (!coord && (target.botId !== selfBotId || target.deviceId !== selfDeviceId)) {
            throw err('FORBIDDEN', '仅任务协调人可以改派步骤负责人。');
          }
          patch.deviceId = target.deviceId;
          patch.botId = target.botId;
        }
        if (cleanOptionalText(args.relationNote)) patch.relationNote = cleanOptionalText(args.relationNote);
        if (cleanOptionalText(args.resultSummary)) patch.resultSummary = cleanOptionalText(args.resultSummary);
        if (Object.keys(patch).length <= 1) {
          throw err('INVALID_ARGUMENT', 'update_step requires at least one field to update');
        }
        if (existing.pendingPrompt?.kind === 'plan' && (patch.status === 'working' || patch.status === 'done')) {
          throw err('INVALID_ARGUMENT', '当前计划尚未经用户确认，确认前不得将步骤推进为 working 或 done。');
        }

        const res = await host.tasks.invoke(
          selfBotId,
          {
            action: 'update',
            taskId,
            expectedRevision: existing.revision,
            stepPatches: [patch],
            ...(coord && summary ? { summary } : {}),
            ...(coord && adoptionPatch ? { adoption: adoptionPatch } : {}),
          },
          conversationId,
          nativeTaskId,
        );
        const task = res.task;
        const activeSteps = (task.steps ?? []).filter((s) => s.status !== 'cancelled');
        const allStepsDone =
          !task.pendingPrompt &&
          activeSteps.length > 0 &&
          activeSteps.every((s) => s.status === 'done');
        const extraNote = allStepsDone
          ? coord
            ? '所有有效步骤均已完成，请验收后显式调用 action="complete" 完成任务。'
            : '所有有效步骤均已完成，等待任务协调人显式验收并调用 complete 收尾。'
          : undefined;
        return publishTaskResult(task, directoryBots, api, context, { extraNote });
      }

      case 'update': {
        const taskId = await requireTaskId(args.taskId, conversationId, nativeTaskId);
        const existing = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
        if (!isCoordinator(existing, selfDeviceId, selfBotId)) {
          throw err(
            'FORBIDDEN',
            '仅任务协调人可以调用 update 修改全局任务信息或步骤清单；普通执行 Bot 请使用 update_step 更新本人负责的步骤。',
          );
        }
        const title = cleanOptionalText(args.title);
        const requirement = cleanOptionalText(args.requirement);
        const summary = cleanOptionalText(args.summary);
        if (args.status !== undefined && !TASK_STATUS_SET.has(args.status)) {
          throw err('INVALID_ARGUMENT', 'update status must be triaging, working, waiting, done, or cancelled');
        }
        const steps = Array.isArray(args.steps)
          ? args.steps.map((s) => normalizeStepInput(s, directoryBots, selfDeviceId, selfBotId, 'todo'))
          : undefined;
        validateDoneStepsPreserved(existing, steps);
        if (args.status === 'done') {
          if (existing.pendingPrompt) {
            throw err('INVALID_ARGUMENT', '当前任务仍有待回应提示（plan/question），不得直接标为 done。');
          }
          const effectiveSteps = (steps ?? existing.steps ?? []).filter((s) => s.status !== 'cancelled');
          const unfinished = effectiveSteps.filter((s) => s.status !== 'done');
          if (unfinished.length > 0) {
            throw err('INVALID_ARGUMENT', `仍有 ${unfinished.length} 个未完成的有效步骤，不得直接将任务标为 done。`);
          }
        }
        const payload = {
          action: 'update',
          taskId,
          expectedRevision: existing.revision,
          ...(title ? { title } : {}),
          ...(requirement ? { requirement } : {}),
          ...(summary ? { summary } : {}),
          ...(args.status !== undefined ? { status: args.status } : {}),
          ...(steps ? { steps } : {}),
          ...(adoptionPatch ? { adoption: adoptionPatch } : {}),
        };
        if (Object.keys(payload).length <= 3) {
          throw err('INVALID_ARGUMENT', 'update requires at least one field to change');
        }
        const res = await host.tasks.invoke(selfBotId, payload, conversationId, nativeTaskId);
        const extraNote = adoptionPatch?.phase === 'needs_scope'
          ? '已提交变更影响范围澄清（needs_scope），请等待用户选择保留已完成成果或重做。'
          : undefined;
        return publishTaskResult(res.task, directoryBots, api, context, { extraNote });
      }

      case 'complete': {
        const taskId = await requireTaskId(args.taskId, conversationId, nativeTaskId);
        const existing = await getTaskSnapshot(taskId, conversationId, nativeTaskId);
        if (!isCoordinator(existing, selfDeviceId, selfBotId)) {
          throw err(
            'FORBIDDEN',
            '仅任务协调人可以调用 complete 显式验收结束父任务；子任务 Bot 请用 update_step 将自己负责的步骤标为 done。',
          );
        }
        if (existing.pendingPrompt) {
          throw err('INVALID_ARGUMENT', '当前任务仍有待用户回应的计划确认或澄清问题，暂不能 complete。');
        }
        if (
          existing.adoption &&
          (existing.adoption.phase === 'adjusting' || existing.adoption.phase === 'needs_scope') &&
          !adoptionPatch
        ) {
          throw err('INVALID_ARGUMENT', '当前任务仍有未处理完的需求变更（adoption），请先处理或附 shortReceipt 后再 complete。');
        }
        const activeSteps = (existing.steps ?? []).filter((s) => s.status !== 'cancelled');
        const unfinished = activeSteps.filter((s) => s.status !== 'done');
        if (unfinished.length > 0) {
          throw err(
            'INVALID_ARGUMENT',
            `仍有 ${unfinished.length} 个未完成的有效步骤（${unfinished.map((s) => `${s.id}[${s.status}]`).join('、')}），请先完成所有有效步骤后再调用 complete 验收。`,
          );
        }
        const summary = cleanOptionalText(args.summary);
        const res = await host.tasks.invoke(
          selfBotId,
          {
            action: 'update',
            taskId,
            expectedRevision: existing.revision,
            status: 'done',
            ...(summary ? { summary } : {}),
            ...(adoptionPatch ? { adoption: adoptionPatch } : {}),
          },
          conversationId,
          nativeTaskId,
        );
        return publishTaskResult(res.task, directoryBots, api, context, { cardLabel: '任务已完成' });
      }

      default:
        throw err('INVALID_ARGUMENT', `unsupported task action: ${String(args.action)}`);
    }
  }

  return defineTool({
    name: 'task',
    description:
      'Manage global tasks and step checklists (replaces legacy todo). ' +
      'Actions: create, list, get, assign (transfer/assign coordinatorDeviceId & coordinatorBotId via Center after reading task), ' +
      'propose_plan (coordinator only), ask_clarification, update (coordinator only, supports adoptionPhase/scopeDesc/shortReceipt/changeText), ' +
      'add_steps (coordinator only on existing tasks; auto-creates single-Bot task when none active), ' +
      'update_step (own step only for non-coordinators; never auto-completes parent task), complete (coordinator final acceptance only when all effective steps are done and no pending prompt).',
    parameters: PARAMETERS,
    replay: 'unsafe',
    async execute(args, api, context) {
      try {
        return await run(args, api, context);
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
