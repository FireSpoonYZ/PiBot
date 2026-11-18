import { randomUUID } from 'node:crypto';

const TASK_STATUSES = new Set(['triaging', 'working', 'waiting', 'done', 'cancelled']);
const STEP_STATUSES = new Set(['unassigned', 'todo', 'working', 'waiting', 'blocked', 'done', 'cancelled']);
const ORIGIN_KINDS = new Set(['ui', 'chat', 'voice']);
const DISPATCH_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const DISPATCH_PROGRESS_ORDER = { dispatching: 0, queued: 1, running: 2 };
const DISPATCH_CLAIM_TTL_MS = 120_000;
const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 500;
const DEFAULT_POLL_LIMIT = 50;
const MAX_POLL_LIMIT = 50;
const MAX_LOGS = 200;
const DISPATCHER_BOT_NAME = '任务分派';

function isUserActor(actor) {
  return actor?.kind === 'owner' || actor?.kind === 'host';
}

function error(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function nowMs() {
  return Date.now();
}

function parseJson(row) {
  return row ? JSON.parse(row.json) : null;
}

function normalizeOptionalText(value, maxLen = 4000) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function normalizeRequiredText(value, field, maxLen = 4000) {
  const normalized = normalizeOptionalText(value, maxLen);
  if (!normalized) throw error('INVALID_ARGUMENT', `${field} is required`);
  return normalized;
}

function deriveTitleFromText(text) {
  const firstLine = String(text || '').split(/\r?\n/)[0]?.trim() || '新任务';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

function assertRevision(expected, actual, { required = false, field = 'expectedRevision' } = {}) {
  if (expected === undefined || expected === null) {
    if (required) throw error('REQUEST_CONFLICT', `${field} is required`);
    return;
  }
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 1) {
    throw error('INVALID_ARGUMENT', `Invalid ${field}`);
  }
  if (expected !== actual) {
    throw error('REQUEST_CONFLICT', 'Task revision conflict');
  }
}

function resolveStepExecutionRevision(value, fallback = 1) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function botKey(deviceId, botId) {
  return `${deviceId}::${botId}`;
}

function botDisplayName(bot) {
  if (!bot) return 'Bot';
  return normalizeOptionalText(bot.name, 120)
    || normalizeOptionalText(bot.role, 120)
    || bot.botId
    || 'Bot';
}

function normalizeOrigin(raw, actor, bots) {
  const botByKey = new Map(bots.map((b) => [botKey(b.deviceId, b.botId), b]));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const kind = ORIGIN_KINDS.has(raw.kind) ? raw.kind : (actor?.kind === 'bot' ? 'chat' : 'ui');
    const deviceId = normalizeOptionalText(raw.deviceId, 200) ?? (actor?.kind === 'bot' ? actor.deviceId : null);
    const botId = normalizeOptionalText(raw.botId, 200) ?? (actor?.kind === 'bot' ? actor.botId : null);
    const matched = deviceId && botId ? botByKey.get(botKey(deviceId, botId)) : null;
    const botName = normalizeOptionalText(raw.botName, 120) ?? (matched ? botDisplayName(matched) : null);
    const conversationId = normalizeOptionalText(raw.conversationId, 200) ?? null;
    const label = typeof raw.label === 'string'
      ? raw.label.trim().slice(0, 200)
      : (kind === 'ui' ? '' : (botName ? `来自与 ${botName} 的对话` : '来自对话'));
    return {
      kind,
      ...(deviceId ? { deviceId } : {}),
      ...(botId ? { botId } : {}),
      ...(botName ? { botName } : {}),
      ...(conversationId ? { conversationId } : {}),
      label,
    };
  }
  if (actor?.kind === 'bot') {
    const matched = botByKey.get(botKey(actor.deviceId, actor.botId));
    const botName = matched ? botDisplayName(matched) : actor.botId;
    return {
      kind: 'chat',
      deviceId: actor.deviceId,
      botId: actor.botId,
      botName,
      label: `来自与 ${botName} 的对话`,
    };
  }
  return { kind: 'ui', label: '' };
}

function normalizePendingPrompt(raw, { actor, coordinator, bots, now }) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw error('INVALID_ARGUMENT', 'pendingPrompt must be an object or null');
  }
  const kind = raw.kind === 'plan' || raw.kind === 'question' ? raw.kind : null;
  if (!kind) throw error('INVALID_ARGUMENT', 'pendingPrompt.kind must be plan or question');
  const text = normalizeRequiredText(raw.text ?? raw.title, 'pendingPrompt.text', 4000);
  const deviceId = normalizeOptionalText(raw.deviceId, 200)
    || (actor?.kind === 'bot' ? actor.deviceId : coordinator?.deviceId)
    || '';
  const botId = normalizeOptionalText(raw.botId, 200)
    || (actor?.kind === 'bot' ? actor.botId : coordinator?.botId)
    || '';
  const bot = deviceId && botId ? bots.find((b) => b.deviceId === deviceId && b.botId === botId) : null;
  const botName = normalizeOptionalText(raw.botName, 120) || (bot ? botDisplayName(bot) : undefined);
  const options = Array.isArray(raw.options)
    ? raw.options.map((item) => normalizeOptionalText(item, 300)).filter(Boolean).slice(0, 12)
    : undefined;
  if (raw.stepId !== undefined && raw.stepId !== null && typeof raw.stepId !== 'string') {
    throw error('INVALID_ARGUMENT', 'pendingPrompt.stepId must be a string or null');
  }
  const stepId = kind === 'question' ? (normalizeOptionalText(raw.stepId, 200) ?? null) : null;
  return {
    kind,
    deviceId,
    botId,
    ...(botName ? { botName } : {}),
    ...(kind === 'question' ? { stepId } : {}),
    text,
    ...(options?.length ? { options } : {}),
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
  };
}

function normalizeDependsOn(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw error('INVALID_ARGUMENT', 'dependsOnStepIds must be an array');
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const id = normalizeOptionalText(item, 200);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result.length ? result : undefined;
}

function makeLogEntry(text, time = nowMs(), extra = null) {
  return {
    id: `log-${randomUUID()}`,
    time,
    text: text.length > 1000 ? text.slice(0, 1000) : text,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
}

function appendLog(logs, text, time = nowMs(), extra = null) {
  const entry = makeLogEntry(text, time, extra);
  const next = Array.isArray(logs) ? [...logs, entry] : [entry];
  return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
}

function summarizeAvailableBots(bots, devices = [], getBotCapabilities = null) {
  const deviceById = new Map();
  for (const device of devices || []) {
    if (device && typeof device.deviceId === 'string' && device.deviceId) {
      deviceById.set(device.deviceId, device);
    }
  }
  const capLookup = typeof getBotCapabilities === 'function' ? getBotCapabilities() : null;
  return bots
    .filter((bot) => !bot.archivedAt)
    .map((bot) => {
      const device = deviceById.get(bot.deviceId);
      const deviceName = normalizeOptionalText(device?.name || bot.deviceName, 120);
      const platform = normalizeOptionalText(device?.platform || bot.platform, 60);
      const capabilities = capLookup ? capLookup(bot.deviceId, bot.botId) : [];
      const description = normalizeOptionalText(bot.description, 400);
      const cwd = normalizeOptionalText(bot.cwd, 400);
      return {
        deviceId: bot.deviceId,
        botId: bot.botId,
        name: botDisplayName(bot),
        isPrimary: Boolean(bot.isPrimary),
        online: Boolean(device?.online),
        ...(deviceName ? { deviceName } : {}),
        ...(platform ? { platform } : {}),
        ...(capabilities.length ? { capabilities } : {}),
        ...(description ? { description } : {}),
        ...(cwd ? { cwd } : {}),
      };
    });
}

function buildBotRefs({ coordinator, steps, origin, prevRefs = [], bots }) {
  const byKey = new Map();
  const botByKey = new Map(bots.map((bot) => [botKey(bot.deviceId, bot.botId), bot]));
  const addRef = (deviceId, botId, nameHint) => {
    if (!deviceId || !botId) return;
    const key = botKey(deviceId, botId);
    const bot = botByKey.get(key);
    const prev = byKey.get(key);
    const botName = bot ? botDisplayName(bot) : (nameHint || prev?.botName || botId);
    byKey.set(key, {
      deviceId,
      botId,
      ...(botName ? { botName } : {}),
    });
  };

  for (const ref of prevRefs || []) {
    if (ref?.deviceId && ref?.botId) {
      addRef(ref.deviceId, ref.botId, ref.botName);
    }
  }
  if (coordinator?.deviceId && coordinator?.botId) {
    addRef(coordinator.deviceId, coordinator.botId, coordinator.botName);
  }
  if (origin?.deviceId && origin?.botId) {
    addRef(origin.deviceId, origin.botId, origin.botName || undefined);
  }
  for (const step of steps || []) {
    if (step.deviceId && step.botId) {
      addRef(step.deviceId, step.botId, step.botName || undefined);
    }
  }
  return [...byKey.values()];
}

function normalizeStepRecord(raw, { bots, prevStep = null, now, forceExecutionRevision = null, preserveExistingResult = true }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw error('INVALID_ARGUMENT', 'Each step must be an object');
  }
  const id = normalizeOptionalText(raw.id, 200) || prevStep?.id || `step-${randomUUID()}`;
  const text = normalizeRequiredText(raw.text ?? prevStep?.text, 'step.text', 1000);
  const parentStepId = raw.parentStepId === undefined
    ? (prevStep?.parentStepId ?? null)
    : (normalizeOptionalText(raw.parentStepId, 200) ?? null);
  const deviceId = raw.deviceId === undefined
    ? (prevStep?.deviceId ?? null)
    : (normalizeOptionalText(raw.deviceId, 200) ?? null);
  const botId = raw.botId === undefined
    ? (prevStep?.botId ?? null)
    : (normalizeOptionalText(raw.botId, 200) ?? null);
  if (Boolean(deviceId) !== Boolean(botId)) {
    throw error('INVALID_ARGUMENT', '步骤的 deviceId 和 botId 必须成对提供');
  }

  let status;
  if (raw.status !== undefined) {
    if (!STEP_STATUSES.has(raw.status)) {
      throw error('INVALID_ARGUMENT', `Invalid step status: ${raw.status}`);
    }
    status = raw.status;
  } else if (prevStep) {
    status = prevStep.status;
  } else {
    status = deviceId && botId ? 'todo' : 'unassigned';
  }

  const bot = deviceId && botId ? bots.find((item) => item.deviceId === deviceId && item.botId === botId) : null;
  const botName = bot
    ? botDisplayName(bot)
    : (normalizeOptionalText(raw.botName, 120) ?? prevStep?.botName ?? null);

  let dependsOnStepIds = raw.dependsOnStepIds === undefined
    ? prevStep?.dependsOnStepIds
    : normalizeDependsOn(raw.dependsOnStepIds);
  const afterStepId = normalizeOptionalText(raw.afterStepId, 200);
  if (afterStepId && (!dependsOnStepIds || !dependsOnStepIds.includes(afterStepId))) {
    dependsOnStepIds = [...(dependsOnStepIds || []), afterStepId];
  }

  const preserved = raw.preserved !== undefined ? Boolean(raw.preserved) : (prevStep?.preserved ? true : undefined);
  const relationNote = raw.relationNote === undefined
    ? prevStep?.relationNote
    : normalizeOptionalText(raw.relationNote, 500);
  const incomingResult = raw.resultSummary === undefined
    ? undefined
    : normalizeOptionalText(raw.resultSummary, 4000);
  const resultSummary = incomingResult !== undefined
    ? incomingResult
    : (preserveExistingResult ? prevStep?.resultSummary : undefined);
  const previousResultSummary = normalizeOptionalText(raw.previousResultSummary, 4000)
    ?? prevStep?.previousResultSummary;

  let executionRevision = forceExecutionRevision
    ?? resolveStepExecutionRevision(raw.executionRevision, resolveStepExecutionRevision(prevStep?.executionRevision, 1));
  let claimedExecutionRevision = prevStep?.claimedExecutionRevision;
  let nextPreviousResultSummary = previousResultSummary;

  if (prevStep && forceExecutionRevision === null) {
    const assigneeChanged = (prevStep.deviceId ?? null) !== deviceId || (prevStep.botId ?? null) !== botId;
    const reopened = (prevStep.status === 'done' || prevStep.status === 'cancelled' || prevStep.status === 'blocked')
      && (status === 'todo' || status === 'working' || status === 'unassigned');
    const resetText = prevStep.text !== text && status === 'todo';
    if (assigneeChanged || reopened || resetText) {
      executionRevision = resolveStepExecutionRevision(prevStep.executionRevision, 1) + 1;
      claimedExecutionRevision = undefined;
      if (prevStep.resultSummary) {
        nextPreviousResultSummary = prevStep.resultSummary;
      }
    }
  }

  return {
    id,
    parentStepId,
    text,
    status,
    deviceId,
    botId,
    ...(botName ? { botName } : {}),
    ...(dependsOnStepIds?.length ? { dependsOnStepIds } : {}),
    ...(preserved ? { preserved: true } : {}),
    ...(relationNote ? { relationNote } : {}),
    ...(resultSummary ? { resultSummary } : {}),
    ...(nextPreviousResultSummary ? { previousResultSummary: nextPreviousResultSummary } : {}),
    executionRevision,
    ...(claimedExecutionRevision !== undefined ? { claimedExecutionRevision } : {}),
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

function validateStepGraph(steps, { bots, prevSteps = [] } = {}) {
  const stepById = new Map();
  const prevById = new Map(prevSteps.map((s) => [s.id, s]));
  const botByKey = new Map(bots.map((bot) => [botKey(bot.deviceId, bot.botId), bot]));

  for (const step of steps) {
    if (!step.id) throw error('INVALID_ARGUMENT', '步骤 id 不能为空');
    if (stepById.has(step.id)) throw error('INVALID_ARGUMENT', `步骤 id 重复: ${step.id}`);
    stepById.set(step.id, step);
  }

  // Validate parentStepId references & parent cycles
  const parentState = new Map();
  for (const step of steps) {
    if (step.parentStepId != null) {
      if (step.parentStepId === step.id) {
        throw error('INVALID_ARGUMENT', `步骤 ${step.id} 的 parentStepId 不能指向自己`);
      }
      if (!stepById.has(step.parentStepId)) {
        throw error('INVALID_ARGUMENT', `步骤 ${step.id} 的 parentStepId 引用不存在: ${step.parentStepId}`);
      }
    }
    let cur = step;
    const chain = [];
    while (cur && cur.parentStepId != null) {
      const state = parentState.get(cur.id) || 0;
      if (state === 2) break;
      if (state === 1) {
        throw error('INVALID_ARGUMENT', `步骤存在 parentStepId 循环引用: ${cur.id}`);
      }
      parentState.set(cur.id, 1);
      chain.push(cur.id);
      cur = stepById.get(cur.parentStepId) || null;
    }
    for (const id of chain) parentState.set(id, 2);
  }

  // Validate dependsOnStepIds references & DAG cycles
  const depState = new Map();
  const visitDeps = (stepId) => {
    const state = depState.get(stepId) || 0;
    if (state === 2) return;
    if (state === 1) {
      throw error('INVALID_ARGUMENT', `步骤存在 dependsOnStepIds 依赖环: ${stepId}`);
    }
    depState.set(stepId, 1);
    const step = stepById.get(stepId);
    for (const depId of step?.dependsOnStepIds || []) {
      if (depId === stepId) {
        throw error('INVALID_ARGUMENT', `步骤 ${stepId} 不能依赖自身`);
      }
      if (!stepById.has(depId)) {
        throw error('INVALID_ARGUMENT', `步骤 ${stepId} 的 dependsOnStepIds 引用不存在: ${depId}`);
      }
      visitDeps(depId);
    }
    depState.set(stepId, 2);
  };
  for (const step of steps) {
    visitDeps(step.id);
  }

  // Validate target Bot existence & active status
  for (const step of steps) {
    if (Boolean(step.deviceId) !== Boolean(step.botId)) {
      throw error('INVALID_ARGUMENT', `步骤 ${step.id} 的 deviceId 和 botId 必须成对提供`);
    }
    if (!step.deviceId || !step.botId) continue;
    const prev = prevById.get(step.id);
    const assigneeChanged = !prev || prev.deviceId !== step.deviceId || prev.botId !== step.botId;
    const isActive = step.status !== 'done' && step.status !== 'cancelled';
    if (!prev || assigneeChanged || isActive) {
      const bot = botByKey.get(botKey(step.deviceId, step.botId));
      if (!bot) {
        throw error('BOT_NOT_FOUND', `步骤 ${step.id} 指定的 Bot 不存在`);
      }
      if (bot.archivedAt) {
        throw error('INVALID_STATE', `步骤 ${step.id} 指定的 Bot 已归档`);
      }
    }
  }
}

function areDependenciesDone(step, allSteps) {
  if (!step.dependsOnStepIds?.length) return true;
  const byId = new Map(allSteps.map((item) => [item.id, item]));
  return step.dependsOnStepIds.every((depId) => {
    const dep = byId.get(depId);
    return !dep || dep.status === 'done' || dep.status === 'cancelled';
  });
}

function allActiveStepsDone(steps) {
  const active = (steps || []).filter((step) => step.status !== 'cancelled');
  return active.every((step) => step.status === 'done');
}

function buildDispatchInstruction({ kind, task, step = null, bots = [], devices = [], getBotCapabilities = null, isDispatcher = false }) {
  const available = summarizeAvailableBots(bots, devices, getBotCapabilities);
  const botSummary = available
    .map((b) => {
      const attrs = [
        `deviceId=${b.deviceId}`,
        `botId=${b.botId}`,
        b.deviceName ? `device=${b.deviceName}` : '',
        b.platform ? `platform=${b.platform}` : '',
        b.online ? 'online' : 'offline',
        b.isPrimary ? 'primary' : '',
        b.cwd ? `cwd="${b.cwd}"` : '',
        b.capabilities?.length ? `capabilities=[${b.capabilities.join(', ')}]` : '',
        b.description ? `desc="${b.description}"` : '',
      ].filter(Boolean).join(', ');
      return `- ${b.name} (${attrs})`;
    })
    .join('\n');

  if (kind === 'triage' && isDispatcher) {
    return [
      `你是全局「${DISPATCHER_BOT_NAME}」协调 Bot，只负责根据任务需求与可用 Bot 能力/职责/在线状态决定由哪位 Bot 作为负责人（coordinator）。`,
      `taskId: ${task.id}`,
      `revision: ${task.revision}`,
      `标题: ${task.title}`,
      `需求: ${task.requirement}`,
      `当前可用 Bot 目录:\n${botSummary || '(暂无可用 Bot)'}`,
      `请决定最合适的 coordinator Bot，并调用 task 工具的 action="assign"，传入 { action: "assign", taskId: "${task.id}", coordinatorDeviceId: "...", coordinatorBotId: "..." }。`,
      `不要自行拆分步骤、不要执行业务工作、也不要调用 action="complete" 结束任务。如果需求本身信息严重不足无法决定负责人，可调用 action="ask_clarification"，传入 { action: "ask_clarification", taskId: "${task.id}", question: "...", options: [...] } 向用户澄清。`,
    ].join('\n\n');
  }

  if (kind === 'triage') {
    return [
      `你被指派为全局任务「${task.title}」的协调人 (taskId=${task.id}, revision=${task.revision})。`,
      `需求: ${task.requirement}`,
      `当前可用 Bot:\n${botSummary || '(暂无)'}`,
      `请评估任务：`,
      `1. 若需要用户确认方案，请调用 task 工具 action="propose_plan"，传入 { action: "propose_plan", taskId: "${task.id}", planText: "...", steps: [...] }，等待用户明确确认，严禁绕过确认直接执行。`,
      `2. 若需要向用户澄清问题，请调用 task 工具 action="ask_clarification"，传入 { action: "ask_clarification", taskId: "${task.id}", question: "...", options: [...], stepId?: "..." }。`,
      `3. 若可直接执行，请调用 task 工具 action="update"，传入 { action: "update", taskId: "${task.id}", status: "working", steps: [...] }；你自己的步骤请随推进更新，其它 Bot 的步骤将由中心派发。`,
      `4. 当全部有效步骤完成后，必须由你显式调用 task 工具 action="complete"，传入 { action: "complete", taskId: "${task.id}", summary: "..." } 完成任务。`,
    ].join('\n\n');
  }

  if (kind === 'execute') {
    return [
      `你现在是任务「${task.title}」的协调人 (taskId=${task.id}, revision=${task.revision})。`,
      `需求: ${task.requirement}`,
      `请检查当前步骤与执行进度，通过 task 工具 action="update" 推进你负责的步骤，并在所有有效步骤完成后显式调用 action="complete" 传入 { action: "complete", taskId: "${task.id}", summary: "..." } 完成任务。`,
    ].join('\n\n');
  }

  if (kind === 'confirm_plan') {
    return [
      `用户已确认任务「${task.title}」的计划 (taskId=${task.id}, revision=${task.revision})。`,
      `需求: ${task.requirement}`,
      `你自己的待办步骤已认领到本轮执行，其它 Bot 的就绪子步骤已进入派发。请开始推进你负责的工作，并在全部有效步骤完成后显式调用 task 工具 action="complete"，传入 { action: "complete", taskId: "${task.id}", summary: "..." } 完成任务。`,
    ].join('\n\n');
  }

  if (kind === 'answer_prompt') {
    const execRev = step ? resolveStepExecutionRevision(step.executionRevision, 1) : null;
    return [
      step
        ? `用户已回复任务「${task.title}」步骤 ${step.id} 的追问 (taskId=${task.id}, stepId=${step.id}, executionRevision=${execRev}, revision=${task.revision})，最新进展见任务日志。`
        : `用户已回复任务「${task.title}」的追问 (taskId=${task.id}, revision=${task.revision})，最新进展见任务日志。`,
      step ? `步骤内容: ${step.text}` : '',
      step
        ? `请结合用户答复继续推进步骤 ${step.id}，并通过 task 工具 action="update" 的 stepPatches 更新该步骤状态与 resultSummary。`
        : `请结合用户答复继续推进任务，必要时使用 task 工具 action="update" 调整步骤，并在全部完成后调用 action="complete" 传入 { action: "complete", taskId: "${task.id}", summary: "..." }。`,
    ].filter(Boolean).join('\n\n');
  }

  if (kind === 'adopt_change') {
    return [
      `任务「${task.title}」的需求或变更策略已更新 (taskId=${task.id}, revision=${task.revision})。`,
      `最新需求: ${task.requirement}`,
      task.adoption?.changeText ? `变更内容: ${task.adoption.changeText}` : '',
      `请按最新需求通过 task 工具 action="update"（如传入 { action: "update", taskId: "${task.id}", status: "working", steps: [...] } 或 stepPatches，保留已完成且标记 preserved 的步骤）调整后续步骤并继续执行；若变更影响重大无法自行决定，可调用 action="ask_clarification" 向用户确认。`,
    ].filter(Boolean).join('\n\n');
  }

  if (kind === 'subtask' && step) {
    const execRev = resolveStepExecutionRevision(step.executionRevision, 1);
    const deps = (step.dependsOnStepIds || [])
      .map((depId) => task.steps.find((s) => s.id === depId))
      .filter(Boolean)
      .map((s) => `- ${s.id}: ${s.text} => ${s.resultSummary || s.status}`)
      .join('\n');
    return [
      `请执行任务「${task.title}」分配给你的子步骤 (taskId=${task.id}, stepId=${step.id}, executionRevision=${execRev})。`,
      `步骤内容: ${step.text}`,
      step.previousResultSummary ? `上一代执行成果参考:\n${step.previousResultSummary}` : '',
      deps ? `前置依赖结果:\n${deps}` : '',
      `执行过程中请使用 task 工具 action="update" 的 stepPatches（只允许更新你自己的步骤 ${step.id}）反馈 working/done/blocked 与 resultSummary；若需向用户澄清，请调用 action="ask_clarification" 传入 { action: "ask_clarification", taskId: "${task.id}", stepId: "${step.id}", question: "...", options: [...] }。不要修改其他 Bot 的步骤，也不要调用 action="complete"。`,
    ].filter(Boolean).join('\n\n');
  }

  if (kind === 'subtask_completed') {
    const stepResults = (task.steps || [])
      .filter((s) => s.status !== 'cancelled')
      .map((s) => `- [${s.status}] ${s.text}${s.resultSummary ? `: ${s.resultSummary}` : ''}`)
      .join('\n');
    return [
      `任务「${task.title}」的所有子步骤均已完成 (taskId=${task.id}, revision=${task.revision})。`,
      `步骤成果汇总:\n${stepResults || '(无步骤)'}`,
      `请审核并整理最终 summary，然后显式调用 task 工具 action="complete"，传入 { action: "complete", taskId: "${task.id}", summary: "..." } 正式结束任务。`,
    ].join('\n\n');
  }

  return `请处理任务「${task.title}」(taskId=${task.id}, kind=${kind})。`;
}

export function createTaskStore({ db, transaction, listBotsSnapshot, listBotCapabilityDirectory = null }) {
  const selectTaskStmt = db.prepare('SELECT json FROM tasks WHERE id = ?');
  const upsertTaskStmt = db.prepare(`
    INSERT INTO tasks (id, status, coordinator_device_id, coordinator_bot_id, revision, created_at, updated_at, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      coordinator_device_id = excluded.coordinator_device_id,
      coordinator_bot_id = excluded.coordinator_bot_id,
      revision = excluded.revision,
      updated_at = excluded.updated_at,
      json = excluded.json
  `);
  const deleteTaskStmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  const selectDispatcherStmt = db.prepare('SELECT device_id, bot_id, updated_at FROM task_dispatcher WHERE id = 1');
  const upsertDispatcherStmt = db.prepare(`
    INSERT INTO task_dispatcher (id, device_id, bot_id, updated_at)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      device_id = excluded.device_id,
      bot_id = excluded.bot_id,
      updated_at = excluded.updated_at
  `);
  const insertDispatchStmt = db.prepare(`
    INSERT INTO task_dispatches (
      id, task_id, step_id, kind, device_id, bot_id, request_id, task_title,
      status, cancel_requested, execution_revision, instruction, payload_json, error,
      created_at, expires_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, ?, ?, ?)
  `);

  function getActiveTaskDispatcher(bots = listBotsSnapshot()) {
    const row = selectDispatcherStmt.get();
    if (!row?.device_id || !row?.bot_id) return null;
    const bot = bots.find((item) => item.deviceId === row.device_id && item.botId === row.bot_id);
    if (!bot || bot.archivedAt) return null;
    return {
      deviceId: row.device_id,
      botId: row.bot_id,
      updatedAt: row.updated_at,
    };
  }

  function findExistingDispatcherBot(onlineDeviceIds = []) {
    const bots = listBotsSnapshot();
    const candidates = bots.filter((item) => !item.archivedAt && !item.isPrimary && botDisplayName(item) === DISPATCHER_BOT_NAME);
    if (!candidates.length) return null;
    const onlineSet = new Set(onlineDeviceIds || []);
    const chosen = candidates.find((item) => onlineSet.has(item.deviceId)) || candidates[0];
    return { deviceId: chosen.deviceId, botId: chosen.botId };
  }

  function setTaskDispatcher({ deviceId, botId }) {
    const dev = normalizeRequiredText(deviceId, 'deviceId', 200);
    const bot = normalizeRequiredText(botId, 'botId', 200);
    const now = nowMs();
    return transaction(() => {
      upsertDispatcherStmt.run(dev, bot, now);
      return { deviceId: dev, botId: bot, updatedAt: now };
    });
  }

  function hasUnassignedTasks() {
    const row = db.prepare(`
      SELECT 1 FROM tasks
      WHERE status IN ('triaging', 'working', 'waiting')
        AND (coordinator_device_id IS NULL OR coordinator_bot_id IS NULL)
      LIMIT 1
    `).get();
    return Boolean(row);
  }

  function hasPendingDispatches(deviceId) {
    if (!deviceId) return false;
    const row = db.prepare(`
      SELECT 1 FROM task_dispatches
      WHERE device_id = ? AND status = 'pending'
      LIMIT 1
    `).get(deviceId);
    return Boolean(row);
  }

  function saveTask(task) {
    upsertTaskStmt.run(
      task.id,
      task.status,
      task.coordinatorDeviceId ?? null,
      task.coordinatorBotId ?? null,
      task.revision,
      task.createdAt,
      task.updatedAt,
      JSON.stringify(task),
    );
  }

  function invalidateTaskDispatches(taskId, predicate, now, targetDeviceIds) {
    const rows = db.prepare(`
      SELECT id, device_id, bot_id, step_id, kind, status, execution_revision
      FROM task_dispatches
      WHERE task_id = ? AND status IN ('pending', 'dispatching', 'queued', 'running')
    `).all(taskId);
    const cancelPendingStmt = db.prepare("UPDATE task_dispatches SET status = 'cancelled', updated_at = ? WHERE id = ?");
    const markCancelReqStmt = db.prepare('UPDATE task_dispatches SET cancel_requested = 1, updated_at = ? WHERE id = ?');
    for (const row of rows) {
      if (predicate && !predicate(row)) continue;
      if (row.status === 'pending') {
        cancelPendingStmt.run(now, row.id);
      } else {
        markCancelReqStmt.run(now, row.id);
        if (targetDeviceIds && row.device_id) targetDeviceIds.push(row.device_id);
      }
    }
  }

  function enqueueDispatch({ task, step = null, kind, deviceId, botId, bots, devices = [], now, targetDeviceIds, replacePendingCoordinator = false }) {
    if (!deviceId || !botId) return false;
    const bot = bots.find((item) => item.deviceId === deviceId && item.botId === botId);
    if (!bot || bot.archivedAt) return false;

    const executionRevision = step ? resolveStepExecutionRevision(step.executionRevision, 1) : 1;

    if (step && kind === 'subtask') {
      if (step.claimedExecutionRevision === executionRevision) {
        return false;
      }
      const existing = db.prepare(`
        SELECT 1 FROM task_dispatches
        WHERE task_id = ? AND step_id = ? AND kind = 'subtask'
          AND device_id = ? AND bot_id = ? AND execution_revision = ?
          AND status IN ('pending', 'dispatching', 'queued', 'running', 'succeeded')
        LIMIT 1
      `).get(task.id, step.id, deviceId, botId, executionRevision);
      if (existing) return false;
    } else if (replacePendingCoordinator) {
      invalidateTaskDispatches(
        task.id,
        (row) => row.step_id === null && row.kind === kind && row.device_id === deviceId && row.bot_id === botId,
        now,
        targetDeviceIds,
      );
    }

    const dispatcher = getActiveTaskDispatcher(bots);
    const isDispatcher = Boolean(dispatcher && dispatcher.deviceId === deviceId && dispatcher.botId === botId);
    const instruction = buildDispatchInstruction({
      kind,
      task,
      step,
      bots,
      devices,
      getBotCapabilities: listBotCapabilityDirectory,
      isDispatcher,
    });
    const id = `dispatch-${randomUUID()}`;
    const requestId = `task-req-${randomUUID()}`;
    const payload = {
      taskId: task.id,
      stepId: step ? step.id : null,
      kind,
      revision: task.revision,
      executionRevision,
      task,
      ...(step ? { step } : {}),
      availableBots: summarizeAvailableBots(bots, devices, listBotCapabilityDirectory),
    };

    insertDispatchStmt.run(
      id,
      task.id,
      step ? step.id : null,
      kind,
      deviceId,
      botId,
      requestId,
      task.title,
      executionRevision,
      instruction,
      JSON.stringify(payload),
      now,
      now + DISPATCH_CLAIM_TTL_MS,
      now,
    );
    targetDeviceIds.push(deviceId);
    return true;
  }

  function dispatchReadySubtasks({ task, bots, devices = [], now, targetDeviceIds, skipCoordinatorSteps = false, excludeStepId = null }) {
    if (task.pendingPrompt?.kind === 'plan') return;
    if (task.status !== 'working' && !(task.status === 'waiting' && task.pendingPrompt?.kind === 'question')) return;
    for (const step of task.steps) {
      if (excludeStepId && step.id === excludeStepId) continue;
      if (step.status !== 'todo' && step.status !== 'working') continue;
      if (!step.deviceId || !step.botId) continue;
      if (!areDependenciesDone(step, task.steps)) continue;
      const isCoordStep = step.deviceId === task.coordinatorDeviceId && step.botId === task.coordinatorBotId;
      if (skipCoordinatorSteps && isCoordStep) continue;
      const execRev = resolveStepExecutionRevision(step.executionRevision, 1);
      if (isCoordStep && step.claimedExecutionRevision === execRev) continue;
      enqueueDispatch({
        task,
        step,
        kind: 'subtask',
        deviceId: step.deviceId,
        botId: step.botId,
        bots,
        devices,
        now,
        targetDeviceIds,
      });
    }
  }

  function resolveBot(bots, deviceId, botId) {
    if (!deviceId || !botId) return null;
    return bots.find((item) => item.deviceId === deviceId && item.botId === botId) || null;
  }

  function getActorRole(actor, task, dispatcher) {
    if (isUserActor(actor)) return 'owner';
    if (actor?.kind !== 'bot') return 'worker';
    if (task.coordinatorDeviceId === actor.deviceId && task.coordinatorBotId === actor.botId) {
      return 'coordinator';
    }
    if (dispatcher && dispatcher.deviceId === actor.deviceId && dispatcher.botId === actor.botId) {
      return 'dispatcher';
    }
    return 'worker';
  }

  function claimCoordinatorSteps(steps, coordinatorDeviceId, coordinatorBotId, allSteps = steps) {
    if (!coordinatorDeviceId || !coordinatorBotId) return steps;
    return steps.map((step) => {
      if (step.deviceId !== coordinatorDeviceId || step.botId !== coordinatorBotId) return step;
      if (step.status === 'working' || step.status === 'done' || (step.status === 'todo' && areDependenciesDone(step, allSteps))) {
        return {
          ...step,
          claimedExecutionRevision: resolveStepExecutionRevision(step.executionRevision, 1),
        };
      }
      return step;
    });
  }

  function getTaskRecord(taskId) {
    const id = normalizeRequiredText(taskId, 'taskId', 200);
    const task = parseJson(selectTaskStmt.get(id));
    if (!task) throw error('TASK_NOT_FOUND', `Task not found: ${id}`);
    return task;
  }

  function normalizeListCursor(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw error('INVALID_ARGUMENT', 'cursor must be an object with updatedAt and id');
    }
    const { updatedAt, id } = raw;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt < 0) {
      throw error('INVALID_ARGUMENT', 'cursor.updatedAt must be a non-negative finite number');
    }
    const cursorId = normalizeRequiredText(id, 'cursor.id', 200);
    return { updatedAt, id: cursorId };
  }

  function handleList(input) {
    const statusFilter = normalizeOptionalText(input.status, 40);
    const cursor = normalizeListCursor(input.cursor);
    let limit = DEFAULT_LIST_LIMIT;
    if (input.limit !== undefined && input.limit !== null) {
      const parsed = Number(input.limit);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw error('INVALID_ARGUMENT', 'Invalid limit');
      }
      limit = Math.min(MAX_LIST_LIMIT, parsed);
    }

    const rows = db.prepare('SELECT json FROM tasks ORDER BY updated_at DESC, id DESC').all();
    let tasks = rows.map(parseJson).filter(Boolean);

    if (statusFilter && statusFilter !== 'all') {
      if (statusFilter === 'active') {
        tasks = tasks.filter((t) => t.status === 'triaging' || t.status === 'working' || t.status === 'waiting');
      } else if (statusFilter === 'waiting') {
        tasks = tasks.filter((t) => t.status === 'waiting' || Boolean(t.pendingPrompt));
      } else if (statusFilter === 'done') {
        tasks = tasks.filter((t) => t.status === 'done' || t.status === 'cancelled');
      } else if (TASK_STATUSES.has(statusFilter)) {
        tasks = tasks.filter((t) => t.status === statusFilter);
      } else {
        throw error('INVALID_ARGUMENT', `Invalid status filter: ${statusFilter}`);
      }
    }

    const botDeviceId = normalizeOptionalText(input.botDeviceId, 200);
    const botId = normalizeOptionalText(input.botId, 200);
    if (botId || botDeviceId) {
      tasks = tasks.filter((t) => {
        const matchesPair = (dev, id) => (botDeviceId ? dev === botDeviceId : true) && (botId ? id === botId : true);
        if (matchesPair(t.coordinatorDeviceId, t.coordinatorBotId)) return true;
        if ((t.botRefs || []).some((ref) => matchesPair(ref.deviceId, ref.botId))) return true;
        if ((t.steps || []).some((s) => matchesPair(s.deviceId, s.botId))) return true;
        return false;
      });
    }

    if (cursor) {
      tasks = tasks.filter((t) => t.updatedAt < cursor.updatedAt || (t.updatedAt === cursor.updatedAt && t.id < cursor.id));
    }

    const hasMore = tasks.length > limit;
    const page = tasks.slice(0, limit);
    const nextCursor = hasMore && page.length
      ? { updatedAt: page[page.length - 1].updatedAt, id: page[page.length - 1].id }
      : null;

    return { tasks: page, serverTime: nowMs(), nextCursor };
  }

  function handleGet(input) {
    return { task: getTaskRecord(input.taskId) };
  }

  function handleCreate(input, { actor, bots, devices = [], now, targetDeviceIds }) {
    const rawText = normalizeOptionalText(input.text, 8000);
    const requirement = normalizeRequiredText(input.requirement ?? rawText, 'requirement', 8000);
    const title = normalizeOptionalText(input.title, 300) || deriveTitleFromText(rawText ?? requirement);
    const origin = normalizeOrigin(input.origin, actor, bots);
    const dispatcher = getActiveTaskDispatcher(bots);

    let coordinator = null;
    if (input.coordinatorBotId !== undefined || input.coordinatorDeviceId !== undefined) {
      if (input.coordinatorBotId !== null) {
        const coordBotId = normalizeRequiredText(input.coordinatorBotId, 'coordinatorBotId', 200);
        const matched = input.coordinatorDeviceId
          ? resolveBot(bots, normalizeRequiredText(input.coordinatorDeviceId, 'coordinatorDeviceId', 200), coordBotId)
          : bots.find((b) => b.botId === coordBotId && !b.archivedAt) || bots.find((b) => b.botId === coordBotId);
        if (!matched) throw error('BOT_NOT_FOUND', '指定的协调 Bot 不存在');
        if (matched.archivedAt) throw error('INVALID_STATE', '指定的协调 Bot 已归档');
        coordinator = matched;
      }
    } else if (actor?.kind === 'bot') {
      const creatorBot = resolveBot(bots, actor.deviceId, actor.botId);
      if (!creatorBot) throw error('BOT_NOT_FOUND', '发起任务的 Bot 不存在');
      if (creatorBot.archivedAt) throw error('INVALID_STATE', '发起任务的 Bot 已归档');
      coordinator = creatorBot;
    } else if (dispatcher) {
      coordinator = resolveBot(bots, dispatcher.deviceId, dispatcher.botId);
    }

    const pendingPrompt = input.pendingPrompt !== undefined
      ? normalizePendingPrompt(input.pendingPrompt, { actor, coordinator, bots, now })
      : null;
    const rawSteps = Array.isArray(input.steps) ? input.steps : [];
    let steps = rawSteps.map((rawStep) => normalizeStepRecord(rawStep, { bots, now }));
    validateStepGraph(steps, { bots });
    if (pendingPrompt?.kind === 'question' && pendingPrompt.stepId) {
      const targetStep = steps.find((s) => s.id === pendingPrompt.stepId);
      if (!targetStep || targetStep.deviceId !== pendingPrompt.deviceId || targetStep.botId !== pendingPrompt.botId) {
        throw error('INVALID_ARGUMENT', 'pendingPrompt.stepId 必须指向同 Bot 的有效步骤');
      }
    }

    const coordinatorIsDispatcher = Boolean(coordinator && dispatcher && coordinator.deviceId === dispatcher.deviceId && coordinator.botId === dispatcher.botId);

    let status = 'triaging';
    if (pendingPrompt) {
      status = 'waiting';
    } else if (!coordinator || coordinatorIsDispatcher) {
      status = 'triaging';
    } else if (input.directStart === true || input.status === 'working' || (actor?.kind === 'bot' && steps.length > 0 && input.status !== 'triaging')) {
      status = 'working';
    }

    if (actor?.kind === 'bot' && coordinator && coordinator.deviceId === actor.deviceId && coordinator.botId === actor.botId && status === 'working' && !pendingPrompt) {
      steps = claimCoordinatorSteps(steps, coordinator.deviceId, coordinator.botId);
    }

    const summary = normalizeOptionalText(input.summary, 4000) || (
      pendingPrompt
        ? (pendingPrompt.kind === 'plan' ? '计划已提交，等待用户确认' : '等待用户补充信息')
        : (!coordinator
          ? '等待「任务分派」Bot 就绪后分派'
          : (coordinatorIsDispatcher
            ? '已交由「任务分派」Bot 评估并指派负责人'
            : (status === 'working' ? `由 ${botDisplayName(coordinator)} 协调执行中` : `已分配给 ${botDisplayName(coordinator)} 评估`)))
    );

    const task = {
      id: normalizeOptionalText(input.taskId, 200) || `task-${randomUUID()}`,
      title,
      requirement,
      sourceText: requirement,
      status,
      summary,
      origin,
      coordinatorDeviceId: coordinator?.deviceId ?? null,
      coordinatorBotId: coordinator?.botId ?? null,
      botRefs: buildBotRefs({ coordinator, steps, origin, bots }),
      pendingPrompt,
      adoption: null,
      steps,
      logs: [makeLogEntry(
        coordinator
          ? `创建任务，负责人：${botDisplayName(coordinator)}`
          : '创建任务，等待「任务分派」Bot 接手',
        now,
      )],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };

    if (selectTaskStmt.get(task.id)) {
      throw error('REQUEST_CONFLICT', `Task already exists: ${task.id}`);
    }
    saveTask(task);

    if (!pendingPrompt && coordinator) {
      if (coordinatorIsDispatcher || status === 'triaging') {
        enqueueDispatch({
          task,
          kind: 'triage',
          deviceId: coordinator.deviceId,
          botId: coordinator.botId,
          bots,
          devices,
          now,
          targetDeviceIds,
        });
      } else if (status === 'working') {
        if (actor?.kind !== 'bot') {
          const claimedSteps = claimCoordinatorSteps(task.steps, coordinator.deviceId, coordinator.botId);
          const updatedTask = { ...task, steps: claimedSteps };
          saveTask(updatedTask);
          enqueueDispatch({
            task: updatedTask,
            kind: 'execute',
            deviceId: coordinator.deviceId,
            botId: coordinator.botId,
            bots,
            devices,
            now,
            targetDeviceIds,
          });
          dispatchReadySubtasks({
            task: updatedTask,
            bots,
            devices,
            now,
            targetDeviceIds,
            skipCoordinatorSteps: true,
          });
          return { task: updatedTask };
        }
        dispatchReadySubtasks({
          task,
          bots,
          devices,
          now,
          targetDeviceIds,
          skipCoordinatorSteps: true,
        });
      }
    }

    return { task };
  }

  function handleAssign(input, { actor, bots, devices = [], now, targetDeviceIds }) {
    const task = getTaskRecord(input.taskId);
    if (task.status === 'done' || task.status === 'cancelled') {
      throw error('INVALID_STATE', '已结束任务不能重新指派负责人');
    }
    assertRevision(input.expectedRevision, task.revision, { required: true });

    const dispatcher = getActiveTaskDispatcher(bots);
    const role = getActorRole(actor, task, dispatcher);
    if (role !== 'owner' && role !== 'coordinator' && role !== 'dispatcher') {
      throw error('FORBIDDEN', '只有当前协调人、任务分派 Bot 或主人可以指派负责人');
    }

    const coordinatorDeviceId = normalizeRequiredText(input.coordinatorDeviceId, 'coordinatorDeviceId', 200);
    const coordinatorBotId = normalizeRequiredText(input.coordinatorBotId, 'coordinatorBotId', 200);
    const targetBot = resolveBot(bots, coordinatorDeviceId, coordinatorBotId);
    if (!targetBot) throw error('BOT_NOT_FOUND', '指定的协调 Bot 不存在');
    if (targetBot.archivedAt) throw error('INVALID_STATE', '指定的协调 Bot 已归档');

    const prevCoordDev = task.coordinatorDeviceId;
    const prevCoordBot = task.coordinatorBotId;

    // Clean up all old coordinator dispatches (keep worker subtasks intact unless reassigned separately)
    invalidateTaskDispatches(
      task.id,
      (row) => row.step_id === null || (prevCoordDev && prevCoordBot && row.device_id === prevCoordDev && row.bot_id === prevCoordBot && row.kind !== 'subtask'),
      now,
      targetDeviceIds,
    );

    const nextSteps = task.steps.map((step) => {
      if (step.deviceId === coordinatorDeviceId && step.botId === coordinatorBotId && step.claimedExecutionRevision !== undefined) {
        const next = { ...step };
        delete next.claimedExecutionRevision;
        return next;
      }
      return step;
    });

    const targetName = botDisplayName(targetBot);
    const claimedNextSteps = !task.pendingPrompt && task.status === 'working'
      ? claimCoordinatorSteps(nextSteps, coordinatorDeviceId, coordinatorBotId)
      : nextSteps;

    const nextTask = {
      ...task,
      coordinatorDeviceId,
      coordinatorBotId,
      botRefs: buildBotRefs({ coordinator: targetBot, steps: claimedNextSteps, origin: task.origin, prevRefs: task.botRefs, bots }),
      steps: claimedNextSteps,
      summary: task.pendingPrompt
        ? task.summary
        : (task.status === 'working' ? `已改派给 ${targetName} 协调执行` : `已指派给 ${targetName} 负责`),
      logs: appendLog(task.logs, `指派负责人为 ${targetName}`, now),
      revision: task.revision + 1,
      updatedAt: now,
    };

    saveTask(nextTask);

    // Strictly respect pendingPrompt plan/question gates — never bypass confirmation!
    if (!nextTask.pendingPrompt) {
      const dispatchKind = nextTask.status === 'working' ? 'execute' : 'triage';
      enqueueDispatch({
        task: nextTask,
        kind: dispatchKind,
        deviceId: coordinatorDeviceId,
        botId: coordinatorBotId,
        bots,
        devices,
        now,
        targetDeviceIds,
        replacePendingCoordinator: true,
      });
      if (nextTask.status === 'working') {
        dispatchReadySubtasks({
          task: nextTask,
          bots,
          devices,
          now,
          targetDeviceIds,
          skipCoordinatorSteps: true,
        });
      }
    }

    return { task: nextTask };
  }

  function handleUpdate(input, { actor, bots, devices = [], now, targetDeviceIds }) {
    const task = getTaskRecord(input.taskId);
    assertRevision(input.expectedRevision, task.revision, {
      required: input.steps !== undefined,
    });

    const dispatcher = getActiveTaskDispatcher(bots);
    const role = getActorRole(actor, task, dispatcher);
    const isActorBot = actor?.kind === 'bot';

    if (role === 'worker') {
      const forbiddenKeys = ['steps', 'addSteps', 'title', 'requirement', 'summary', 'coordinatorDeviceId', 'coordinatorBotId', 'adoption', 'status'];
      for (const key of forbiddenKeys) {
        if (input[key] !== undefined) {
          throw error('FORBIDDEN', `普通执行 Bot 无权修改 ${key}，仅可更新分配给自己的 stepPatches`);
        }
      }
      if (input.pendingPrompt !== undefined) {
        if (input.pendingPrompt === null) {
          throw error('FORBIDDEN', 'Bot 不能自行清除待用户处理提示');
        }
        if (typeof input.pendingPrompt !== 'object' || Array.isArray(input.pendingPrompt)) {
          throw error('INVALID_ARGUMENT', 'pendingPrompt must be an object or null');
        }
        if (input.pendingPrompt.kind !== 'question') {
          throw error('FORBIDDEN', '普通执行 Bot 仅可提交 question 类型的待确认问题');
        }
        if (task.status === 'done' || task.status === 'cancelled') {
          throw error('INVALID_STATE', '已结束任务不能提交问题');
        }
        if (task.pendingPrompt) {
          throw error('INVALID_STATE', '当前已有待用户处理的提示');
        }
        const reqDev = normalizeOptionalText(input.pendingPrompt.deviceId, 200);
        const reqBot = normalizeOptionalText(input.pendingPrompt.botId, 200);
        if ((reqDev && reqDev !== actor.deviceId) || (reqBot && reqBot !== actor.botId)) {
          throw error('FORBIDDEN', '普通执行 Bot 只能以自身身份提交问题');
        }
      }
      if (!Array.isArray(input.stepPatches) || input.stepPatches.length === 0) {
        throw error('INVALID_ARGUMENT', 'stepPatches is required for worker updates');
      }
    }

    if (role === 'dispatcher' && task.coordinatorBotId !== actor.botId) {
      throw error('FORBIDDEN', '任务已指派给其他协调人，任务分派 Bot 仅可通过 assign 重新分派');
    }

    // Plan gate protection against any Bot bypass
    if (isActorBot && task.pendingPrompt?.kind === 'plan') {
      if (input.pendingPrompt === null) {
        throw error('FORBIDDEN', 'Bot 不能清除待确认计划，必须由用户通过 confirm_plan 确认');
      }
      if (input.status === 'working' || input.status === 'done') {
        throw error('INVALID_STATE', '计划尚未经用户确认，不能开始执行或完成任务');
      }
    }
    if (isActorBot && input.pendingPrompt === null && task.pendingPrompt) {
      throw error('FORBIDDEN', 'Bot 不能自行清除待用户处理提示');
    }

    if (input.coordinatorDeviceId !== undefined || input.coordinatorBotId !== undefined) {
      throw error('INVALID_ARGUMENT', '变更协调负责人请使用 assign 动作');
    }

    const oldSteps = Array.isArray(task.steps) ? task.steps : [];
    const oldStepById = new Map(oldSteps.map((s) => [s.id, s]));
    let nextSteps = oldSteps.map((s) => ({ ...s }));
    let didSubtaskCompleteByNonCoordinator = false;
    const stepIdsNeedingInvalidation = new Set();
    const patchedStepsById = new Map();

    const assertQuestionStepNotAdvanced = (stepId, prevStatus, nextStatusVal) => {
      if (
        isActorBot
        && task.pendingPrompt?.kind === 'question'
        && task.pendingPrompt.stepId
        && stepId === task.pendingPrompt.stepId
        && prevStatus === 'waiting'
        && (nextStatusVal === 'working' || nextStatusVal === 'done')
      ) {
        throw error('INVALID_STATE', '当前步骤存在待用户回答的问题，在用户回答前不能推进步骤状态');
      }
    };

    // 1. Full steps replace (owner or coordinator only; expectedRevision enforced above)
    if (input.steps !== undefined) {
      if (role !== 'owner' && role !== 'coordinator') {
        throw error('FORBIDDEN', '只有协调人或主人可以全量替换步骤');
      }
      if (!Array.isArray(input.steps)) {
        throw error('INVALID_ARGUMENT', 'steps must be an array');
      }
      const mapped = input.steps.map((raw) => {
        const prev = typeof raw?.id === 'string' ? oldStepById.get(raw.id.trim()) : null;
        const normalized = normalizeStepRecord(raw, { bots, prevStep: prev, now });
        assertQuestionStepNotAdvanced(normalized.id, prev?.status, normalized.status);
        return normalized;
      });
      const mappedIds = new Set(mapped.map((s) => s.id));
      // Retain omitted 'done' steps so completed achievements can never be deleted by omission
      for (const oldStep of oldSteps) {
        if (oldStep.status === 'done' && !mappedIds.has(oldStep.id)) {
          const retainedDeps = (oldStep.dependsOnStepIds || []).filter((depId) => mappedIds.has(depId) || oldStepById.get(depId)?.status === 'done');
          const retainedParent = oldStep.parentStepId && (mappedIds.has(oldStep.parentStepId) || oldStepById.get(oldStep.parentStepId)?.status === 'done')
            ? oldStep.parentStepId
            : null;
          mapped.push({
            ...oldStep,
            parentStepId: retainedParent,
            ...(retainedDeps.length ? { dependsOnStepIds: retainedDeps } : {}),
            preserved: true,
          });
          mappedIds.add(oldStep.id);
        }
      }
      for (const oldStep of oldSteps) {
        const nextStep = mapped.find((s) => s.id === oldStep.id);
        if (!nextStep || nextStep.status === 'cancelled' || nextStep.deviceId !== oldStep.deviceId || nextStep.botId !== oldStep.botId || resolveStepExecutionRevision(nextStep.executionRevision, 1) !== resolveStepExecutionRevision(oldStep.executionRevision, 1)) {
          stepIdsNeedingInvalidation.add(oldStep.id);
        }
      }
      nextSteps = mapped;
    }

    // 2. addSteps (owner or coordinator only)
    if (input.addSteps !== undefined) {
      if (role !== 'owner' && role !== 'coordinator') {
        throw error('FORBIDDEN', '只有协调人或主人可以追加步骤');
      }
      if (!Array.isArray(input.addSteps)) {
        throw error('INVALID_ARGUMENT', 'addSteps must be an array');
      }
      for (const raw of input.addSteps) {
        const step = normalizeStepRecord(raw, { bots, now });
        if (nextSteps.some((s) => s.id === step.id)) {
          throw error('INVALID_ARGUMENT', `步骤 id 重复: ${step.id}`);
        }
        nextSteps.push(step);
      }
    }

    // 3. stepPatches
    if (input.stepPatches !== undefined) {
      if (!Array.isArray(input.stepPatches)) {
        throw error('INVALID_ARGUMENT', 'stepPatches must be an array');
      }
      const nextByIndex = new Map(nextSteps.map((s, idx) => [s.id, idx]));
      for (const patch of input.stepPatches) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw error('INVALID_ARGUMENT', 'Each stepPatch must be an object');
        }
        const stepId = normalizeRequiredText(patch.stepId ?? patch.id, 'stepPatches[].stepId', 200);
        const idx = nextByIndex.get(stepId);
        if (idx === undefined) {
          throw error('INVALID_ARGUMENT', `stepPatch 目标步骤不存在: ${stepId}`);
        }
        const current = nextSteps[idx];
        const currentExecRev = resolveStepExecutionRevision(current.executionRevision, 1);

        if (patch.expectedExecutionRevision !== undefined) {
          assertRevision(patch.expectedExecutionRevision, currentExecRev, { field: 'expectedExecutionRevision' });
        }

        if (role === 'worker') {
          if (current.deviceId !== actor.deviceId || current.botId !== actor.botId) {
            throw error('FORBIDDEN', `只能更新分配给自己的步骤 (${stepId})`);
          }
          if (patch.deviceId !== undefined || patch.botId !== undefined) {
            throw error('FORBIDDEN', '普通执行 Bot 不能改派步骤归属');
          }
          if (patch.parentStepId !== undefined || patch.dependsOnStepIds !== undefined || patch.preserved !== undefined) {
            throw error('FORBIDDEN', '普通执行 Bot 不能修改步骤结构依赖');
          }
        }

        const nextStepStatus = patch.status !== undefined
          ? (STEP_STATUSES.has(patch.status) ? patch.status : (() => { throw error('INVALID_ARGUMENT', `Invalid step status: ${patch.status}`); })())
          : current.status;

        if (isActorBot && task.pendingPrompt?.kind === 'plan' && (nextStepStatus === 'working' || nextStepStatus === 'done')) {
          throw error('INVALID_STATE', '计划尚未经用户确认，不能推进步骤状态');
        }
        assertQuestionStepNotAdvanced(stepId, current.status, nextStepStatus);

        const merged = normalizeStepRecord({
          ...current,
          ...(patch.text !== undefined ? { text: patch.text } : {}),
          ...(patch.status !== undefined ? { status: nextStepStatus } : {}),
          ...(patch.deviceId !== undefined ? { deviceId: patch.deviceId } : {}),
          ...(patch.botId !== undefined ? { botId: patch.botId } : {}),
          ...(patch.parentStepId !== undefined ? { parentStepId: patch.parentStepId } : {}),
          ...(patch.dependsOnStepIds !== undefined ? { dependsOnStepIds: patch.dependsOnStepIds } : {}),
          ...(patch.preserved !== undefined ? { preserved: patch.preserved } : {}),
          ...(patch.relationNote !== undefined ? { relationNote: patch.relationNote } : {}),
          ...(patch.resultSummary !== undefined ? { resultSummary: patch.resultSummary } : {}),
          updatedAt: now,
        }, { bots, prevStep: current, now });

        if (merged.status === 'cancelled' || merged.deviceId !== current.deviceId || merged.botId !== current.botId || merged.executionRevision !== currentExecRev) {
          stepIdsNeedingInvalidation.add(stepId);
        }

        if (merged.status === 'done' && current.status !== 'done') {
          const stepBelongsToCoord = merged.deviceId === task.coordinatorDeviceId && merged.botId === task.coordinatorBotId;
          if (!stepBelongsToCoord) {
            didSubtaskCompleteByNonCoordinator = true;
          }
        }

        nextSteps[idx] = merged;
        patchedStepsById.set(stepId, merged);
      }
    }

    validateStepGraph(nextSteps, { bots, prevSteps: oldSteps });

    let nextTitle = task.title;
    if (input.title !== undefined) {
      if (role !== 'owner' && role !== 'coordinator') throw error('FORBIDDEN', '无权修改标题');
      nextTitle = normalizeRequiredText(input.title, 'title', 300);
    }

    let nextRequirement = task.requirement;
    let requirementChanged = false;
    if (input.requirement !== undefined) {
      if (role !== 'owner' && role !== 'coordinator') throw error('FORBIDDEN', '无权修改需求');
      const reqText = normalizeRequiredText(input.requirement, 'requirement', 8000);
      if (reqText !== task.requirement) {
        nextRequirement = reqText;
        requirementChanged = true;
      }
    }

    const coordinator = resolveBot(bots, task.coordinatorDeviceId, task.coordinatorBotId);
    let nextPendingPrompt = task.pendingPrompt;
    if (input.pendingPrompt !== undefined) {
      if (role !== 'owner' && role !== 'coordinator' && role !== 'worker') {
        throw error('FORBIDDEN', '无权设置待确认提示');
      }
      nextPendingPrompt = normalizePendingPrompt(input.pendingPrompt, { actor, coordinator, bots, now });
      if (nextPendingPrompt?.kind === 'question') {
        const patchedWaitingSteps = [...patchedStepsById.values()].filter(
          (step) => step.status === 'waiting'
            && step.deviceId === nextPendingPrompt.deviceId
            && step.botId === nextPendingPrompt.botId,
        );
        if (patchedWaitingSteps.length > 1) {
          throw error('INVALID_ARGUMENT', '一次提问只能关联本次 stepPatches 中的一个 status=waiting 本人步骤');
        }
        if (patchedWaitingSteps.length === 1) {
          const waitingStep = patchedWaitingSteps[0];
          if (nextPendingPrompt.stepId && nextPendingPrompt.stepId !== waitingStep.id) {
            throw error('INVALID_ARGUMENT', 'pendingPrompt.stepId 与本次 stepPatches 中 waiting 的步骤不一致');
          }
          nextPendingPrompt = { ...nextPendingPrompt, stepId: waitingStep.id };
        } else {
          if (role === 'worker') {
            throw error('INVALID_ARGUMENT', '执行 Bot 提交问题时必须在本次 stepPatches 中将对应本人步骤设为 waiting');
          }
          if (nextPendingPrompt.stepId) {
            const targetStep = nextSteps.find((s) => s.id === nextPendingPrompt.stepId);
            if (!targetStep) {
              throw error('INVALID_ARGUMENT', `pendingPrompt.stepId 目标步骤不存在: ${nextPendingPrompt.stepId}`);
            }
            if (targetStep.deviceId !== nextPendingPrompt.deviceId || targetStep.botId !== nextPendingPrompt.botId) {
              throw error('INVALID_ARGUMENT', 'pendingPrompt.stepId 必须属于提问 Bot 自己的步骤');
            }
          }
        }
      }
    }

    let nextStatus = task.status;
    if (input.status !== undefined) {
      if (!TASK_STATUSES.has(input.status)) {
        throw error('INVALID_ARGUMENT', `Invalid status: ${input.status}`);
      }
      if (input.status === 'done' || input.status === 'cancelled') {
        if (role !== 'owner' && role !== 'coordinator') {
          throw error('FORBIDDEN', '只有协调人或主人可以完成或取消任务');
        }
      }
      if (input.status === 'done') {
        if (nextPendingPrompt) {
          throw error('INVALID_STATE', '存在待确认计划或追问，不能标记任务完成');
        }
        if (!allActiveStepsDone(nextSteps)) {
          throw error('INVALID_STATE', '仍有未完成步骤，不能将全局任务标记为已完成');
        }
      }
      if (input.status === 'working' && nextPendingPrompt?.kind === 'plan' && isActorBot) {
        throw error('INVALID_STATE', '计划尚未经用户确认，不能开始执行');
      }
      nextStatus = input.status;
    } else if (nextPendingPrompt && nextStatus !== 'cancelled' && nextStatus !== 'done') {
      nextStatus = 'waiting';
    } else if (input.pendingPrompt === null && task.pendingPrompt && nextStatus === 'waiting') {
      nextStatus = 'working';
    }

    let nextAdoption = task.adoption;
    let triggerAdoptDispatch = false;
    if (requirementChanged) {
      nextSteps = nextSteps.map((step) => (
        step.status === 'done' && !step.preserved
          ? { ...step, preserved: true }
          : step
      ));
      const hasAssignedCoordinator = Boolean(
        coordinator
        && !coordinator.archivedAt
        && (!dispatcher || coordinator.deviceId !== dispatcher.deviceId || coordinator.botId !== dispatcher.botId),
      );
      if (hasAssignedCoordinator) {
        const alreadyExecutingOrDone = task.status === 'working' || task.status === 'done' || oldSteps.some((s) => s.status === 'working' || s.status === 'done');
        if (alreadyExecutingOrDone) {
          if (nextStatus === 'done') nextStatus = 'working';
          triggerAdoptDispatch = true;
        }
        nextAdoption = {
          phase: 'adjusting',
          shortReceipt: '修改已保存，负责人正在调整…',
          changeText: nextRequirement,
          updatedAt: now,
        };
      } else {
        nextAdoption = {
          phase: 'recorded',
          shortReceipt: '修改已保存，等待分派负责人',
          changeText: nextRequirement,
          updatedAt: now,
        };
      }
    }
    if (input.adoption !== undefined) {
      if (role !== 'owner' && role !== 'coordinator') throw error('FORBIDDEN', '无权更新变更决策状态');
      if (input.adoption === null) {
        nextAdoption = null;
      } else {
        if (!input.adoption || typeof input.adoption !== 'object' || Array.isArray(input.adoption)) {
          throw error('INVALID_ARGUMENT', 'adoption must be an object or null');
        }
        const allowedAdoptionPhases = new Set(['recorded', 'adjusting', 'needs_scope', 'adopted']);
        if (input.adoption.phase !== undefined && !allowedAdoptionPhases.has(input.adoption.phase)) {
          throw error('INVALID_ARGUMENT', `Invalid adoption phase: ${input.adoption.phase}`);
        }
        if (input.adoption.phase === 'needs_scope' && !(role === 'coordinator' && isActorBot)) {
          throw error('FORBIDDEN', '只有协调 Bot 可以显式将变更状态设为 needs_scope');
        }
        nextAdoption = { ...(nextAdoption || {}), ...input.adoption, updatedAt: now };
      }
    }

    // Durably claim coordinator's own ready/working/done steps when coordinator itself updates while working
    if (isActorBot && role === 'coordinator' && nextStatus === 'working' && !nextPendingPrompt) {
      nextSteps = claimCoordinatorSteps(nextSteps, task.coordinatorDeviceId, task.coordinatorBotId);
    }

    let nextSummary = task.summary;
    if (input.summary !== undefined) {
      if (role !== 'owner' && role !== 'coordinator') throw error('FORBIDDEN', '只有协调人或主人可以更新任务总结');
      nextSummary = normalizeOptionalText(input.summary, 4000) || task.summary;
    } else if (nextPendingPrompt && nextPendingPrompt.kind === 'plan') {
      nextSummary = '计划已提交，等待用户确认';
    } else if (nextPendingPrompt && nextPendingPrompt.kind === 'question') {
      nextSummary = '等待用户补充信息';
    } else if (nextStatus === 'cancelled') {
      nextSummary = '任务已取消';
    } else if (nextStatus === 'done' && task.status !== 'done') {
      nextSummary = '任务已完成';
    }

    const logText = normalizeOptionalText(input.logText, 500)
      || (requirementChanged ? '更新了任务需求'
        : nextStatus === 'done' && task.status !== 'done' ? '协调人显式标记任务完成'
        : nextStatus === 'cancelled' && task.status !== 'cancelled' ? '任务已取消'
        : nextPendingPrompt && !task.pendingPrompt ? `提交待确认${nextPendingPrompt.kind === 'plan' ? '计划' : '问题'}: ${nextPendingPrompt.text.slice(0, 80)}`
        : input.stepPatches ? '更新了步骤状态'
        : input.steps ? '更新了步骤规划'
        : '更新了任务信息');
    const logExtra = requirementChanged
      ? { previousRequirement: task.requirement, requirement: nextRequirement }
      : null;

    const nextTask = {
      ...task,
      title: nextTitle,
      requirement: nextRequirement,
      sourceText: task.sourceText ?? task.requirement,
      status: nextStatus,
      summary: nextSummary,
      botRefs: buildBotRefs({ coordinator, steps: nextSteps, origin: task.origin, prevRefs: task.botRefs, bots }),
      pendingPrompt: nextPendingPrompt,
      adoption: nextAdoption,
      steps: nextSteps,
      logs: appendLog(task.logs, logText, now, logExtra),
      revision: task.revision + 1,
      updatedAt: now,
    };

    saveTask(nextTask);

    // Invalidate stale dispatches on terminal status, prompt gate, requirement edit, or changed steps
    if (nextStatus === 'done' || nextStatus === 'cancelled') {
      invalidateTaskDispatches(nextTask.id, () => true, now, targetDeviceIds);
    } else {
      if (nextPendingPrompt?.kind === 'plan') {
        invalidateTaskDispatches(nextTask.id, () => true, now, targetDeviceIds);
      } else if (triggerAdoptDispatch) {
        invalidateTaskDispatches(nextTask.id, (row) => row.step_id === null, now, targetDeviceIds);
      }
      if (stepIdsNeedingInvalidation.size > 0) {
        invalidateTaskDispatches(
          nextTask.id,
          (row) => row.step_id && stepIdsNeedingInvalidation.has(row.step_id),
          now,
          targetDeviceIds,
        );
      }
    }

    const canScheduleExecution = nextPendingPrompt?.kind !== 'plan'
      && (nextStatus === 'working' || (nextStatus === 'waiting' && nextPendingPrompt?.kind === 'question'));
    if (canScheduleExecution) {
      if (triggerAdoptDispatch && nextTask.coordinatorDeviceId && nextTask.coordinatorBotId) {
        enqueueDispatch({
          task: nextTask,
          kind: 'adopt_change',
          deviceId: nextTask.coordinatorDeviceId,
          botId: nextTask.coordinatorBotId,
          bots,
          devices,
          now,
          targetDeviceIds,
          replacePendingCoordinator: true,
        });
      }
      dispatchReadySubtasks({
        task: nextTask,
        bots,
        devices,
        now,
        targetDeviceIds,
        skipCoordinatorSteps: role === 'coordinator',
      });
      if (!nextPendingPrompt && didSubtaskCompleteByNonCoordinator && allActiveStepsDone(nextSteps) && nextTask.coordinatorDeviceId && nextTask.coordinatorBotId) {
        enqueueDispatch({
          task: nextTask,
          kind: 'subtask_completed',
          deviceId: nextTask.coordinatorDeviceId,
          botId: nextTask.coordinatorBotId,
          bots,
          devices,
          now,
          targetDeviceIds,
          replacePendingCoordinator: true,
        });
      }
    }

    return { task: nextTask };
  }

  function handleConfirmPlan(input, { actor, bots, devices = [], now, targetDeviceIds }) {
    if (!isUserActor(actor)) {
      throw error('FORBIDDEN', '只有用户可以确认计划');
    }
    const task = getTaskRecord(input.taskId);
    if (task.status === 'done' || task.status === 'cancelled') {
      throw error('INVALID_STATE', '已结束任务不能确认计划');
    }
    if (task.pendingPrompt?.kind !== 'plan') {
      throw error('INVALID_STATE', '当前任务没有待确认的计划');
    }
    assertRevision(input.expectedRevision, task.revision, { required: true });

    // Promote assigned ready 'todo' steps -> 'working' per shared contract, and durably claim coordinator steps
    const promotedSteps = task.steps.map((step) => {
      if (step.status === 'todo' && step.deviceId && step.botId && areDependenciesDone(step, task.steps)) {
        return { ...step, status: 'working', updatedAt: now };
      }
      return step;
    });
    const nextSteps = claimCoordinatorSteps(promotedSteps, task.coordinatorDeviceId, task.coordinatorBotId);
    const coordinator = resolveBot(bots, task.coordinatorDeviceId, task.coordinatorBotId);
    const nextTask = {
      ...task,
      status: 'working',
      pendingPrompt: null,
      steps: nextSteps,
      summary: `计划已确认，由 ${botDisplayName(coordinator)} 推进执行`,
      logs: appendLog(task.logs, `用户确认了计划: ${task.pendingPrompt.text.slice(0, 80)}`, now),
      revision: task.revision + 1,
      updatedAt: now,
    };
    saveTask(nextTask);

    invalidateTaskDispatches(nextTask.id, (row) => row.step_id === null, now, targetDeviceIds);
    if (nextTask.coordinatorDeviceId && nextTask.coordinatorBotId) {
      enqueueDispatch({
        task: nextTask,
        kind: 'confirm_plan',
        deviceId: nextTask.coordinatorDeviceId,
        botId: nextTask.coordinatorBotId,
        bots,
        devices,
        now,
        targetDeviceIds,
        replacePendingCoordinator: true,
      });
    }
    dispatchReadySubtasks({
      task: nextTask,
      bots,
      devices,
      now,
      targetDeviceIds,
      skipCoordinatorSteps: true,
    });
    return { task: nextTask };
  }

  function handleAnswerPrompt(input, { actor, bots, devices = [], now, targetDeviceIds }) {
    if (!isUserActor(actor)) {
      throw error('FORBIDDEN', '只有用户可以回答待确认问题');
    }
    const task = getTaskRecord(input.taskId);
    if (task.status === 'done' || task.status === 'cancelled') {
      throw error('INVALID_STATE', '已结束任务不能回答提示');
    }
    if (!task.pendingPrompt) {
      throw error('INVALID_STATE', '当前任务没有待回答的提示');
    }
    if (task.pendingPrompt.kind === 'plan') {
      throw error('INVALID_ARGUMENT', '待确认计划请使用 confirm_plan 动作');
    }
    assertRevision(input.expectedRevision, task.revision, { required: true });
    const answer = normalizeRequiredText(input.answer, 'answer', 4000);

    const promptDev = task.pendingPrompt.deviceId || task.coordinatorDeviceId;
    const promptBot = task.pendingPrompt.botId || task.coordinatorBotId;
    const promptStepId = normalizeOptionalText(task.pendingPrompt.stepId, 200) ?? null;

    let targetStep = null;
    const nextSteps = task.steps.map((step) => {
      if (promptStepId && step.id === promptStepId) {
        if (step.status === 'waiting') {
          const restored = {
            ...step,
            status: areDependenciesDone(step, task.steps) ? 'working' : 'todo',
            updatedAt: now,
          };
          targetStep = restored;
          return restored;
        }
        targetStep = step;
      }
      return step;
    });

    const nextTask = {
      ...task,
      status: 'working',
      pendingPrompt: null,
      steps: nextSteps,
      summary: '用户已补充答复，继续推进中',
      logs: appendLog(task.logs, `用户回答问题「${task.pendingPrompt.text.slice(0, 60)}」: ${answer}`, now),
      revision: task.revision + 1,
      updatedAt: now,
    };
    saveTask(nextTask);

    const dispatchDev = targetStep ? targetStep.deviceId : promptDev;
    const dispatchBot = targetStep ? targetStep.botId : promptBot;
    const shouldEnqueueAnswerPrompt = promptStepId
      ? Boolean(targetStep && dispatchDev && dispatchBot && (targetStep.status === 'todo' || targetStep.status === 'working') && areDependenciesDone(targetStep, nextTask.steps))
      : Boolean(dispatchDev && dispatchBot);

    if (promptStepId) {
      invalidateTaskDispatches(
        nextTask.id,
        (row) => row.step_id === promptStepId,
        now,
        targetDeviceIds,
      );
    }

    if (shouldEnqueueAnswerPrompt) {
      enqueueDispatch({
        task: nextTask,
        ...(targetStep ? { step: targetStep } : {}),
        kind: 'answer_prompt',
        deviceId: dispatchDev,
        botId: dispatchBot,
        bots,
        devices,
        now,
        targetDeviceIds,
        replacePendingCoordinator: !targetStep,
      });
    }
    dispatchReadySubtasks({
      task: nextTask,
      bots,
      devices,
      now,
      targetDeviceIds,
      skipCoordinatorSteps: promptDev === nextTask.coordinatorDeviceId && promptBot === nextTask.coordinatorBotId,
      excludeStepId: shouldEnqueueAnswerPrompt && targetStep ? targetStep.id : null,
    });
    return { task: nextTask };
  }

  function handleResolveAdoptionScope(input, { actor, bots, devices = [], now, targetDeviceIds }) {
    const task = getTaskRecord(input.taskId);
    if (task.status === 'cancelled') {
      throw error('INVALID_STATE', '已取消任务不能处理变更范围');
    }
    const dispatcher = getActiveTaskDispatcher(bots);
    const role = getActorRole(actor, task, dispatcher);
    if (role !== 'owner' && role !== 'coordinator') {
      throw error('FORBIDDEN', '只有协调人或主人可以决定变更影响范围');
    }
    assertRevision(input.expectedRevision, task.revision, { required: true });

    const rawScope = input.scope === 'forward_only' ? 'keep' : input.scope;
    const scope = rawScope === 'redo' || rawScope === 'keep' ? rawScope : null;
    if (!scope) throw error('INVALID_ARGUMENT', 'scope must be keep or redo');

    let nextSteps = task.steps;
    const preservedSummaries = [];
    if (scope === 'redo') {
      invalidateTaskDispatches(task.id, () => true, now, targetDeviceIds);
      nextSteps = task.steps.map((step) => {
        if (step.status === 'cancelled') return step;
        const nextExecRev = resolveStepExecutionRevision(step.executionRevision, 1) + 1;
        const oldResult = step.resultSummary || step.previousResultSummary;
        if (oldResult) {
          preservedSummaries.push(`${step.text}: ${oldResult}`);
        }
        const nextStep = {
          ...step,
          status: step.deviceId && step.botId ? 'todo' : 'unassigned',
          executionRevision: nextExecRev,
          ...(oldResult ? { previousResultSummary: oldResult } : {}),
          updatedAt: now,
        };
        delete nextStep.claimedExecutionRevision;
        return nextStep;
      });
      if (!task.pendingPrompt) {
        nextSteps = claimCoordinatorSteps(nextSteps, task.coordinatorDeviceId, task.coordinatorBotId);
      }
    }

    const nextAdoption = {
      ...(task.adoption || { shortReceipt: '需求变更处理', changeText: task.requirement }),
      phase: 'adopted',
      scopeDesc: scope === 'redo' ? '从头重做（保留历史结果）' : '仅对后续步骤生效',
      updatedAt: now,
    };
    const nextStatus = task.pendingPrompt ? task.status : 'working';

    const nextTask = {
      ...task,
      status: nextStatus,
      adoption: nextAdoption,
      steps: nextSteps,
      summary: scope === 'redo' ? '按新需求重做并保留历史结果' : '按新需求继续推进后续步骤',
      logs: appendLog(
        task.logs,
        scope === 'redo'
          ? `按新需求从头重做（保留旧结果记录${preservedSummaries.length ? ` ${preservedSummaries.length} 项` : ''}）`
          : '按新需求仅对后续步骤生效',
        now,
      ),
      revision: task.revision + 1,
      updatedAt: now,
    };
    saveTask(nextTask);

    if (!nextTask.pendingPrompt && nextTask.coordinatorDeviceId && nextTask.coordinatorBotId) {
      enqueueDispatch({
        task: nextTask,
        kind: 'adopt_change',
        deviceId: nextTask.coordinatorDeviceId,
        botId: nextTask.coordinatorBotId,
        bots,
        devices,
        now,
        targetDeviceIds,
        replacePendingCoordinator: true,
      });
      if (scope === 'redo') {
        dispatchReadySubtasks({
          task: nextTask,
          bots,
          devices,
          now,
          targetDeviceIds,
          skipCoordinatorSteps: true,
        });
      }
    }
    return { task: nextTask };
  }

  function handleDismissAdoption(input, { actor, bots, now }) {
    const task = getTaskRecord(input.taskId);
    const dispatcher = getActiveTaskDispatcher(bots);
    const role = getActorRole(actor, task, dispatcher);
    if (role !== 'owner' && role !== 'coordinator') {
      throw error('FORBIDDEN', '只有协调人或主人可以忽略变更提示');
    }
    assertRevision(input.expectedRevision, task.revision);

    const nextTask = {
      ...task,
      adoption: task.adoption ? { ...task.adoption, phase: 'adopted', updatedAt: now } : null,
      logs: appendLog(task.logs, '已忽略变更范围确认提示', now),
      revision: task.revision + 1,
      updatedAt: now,
    };
    saveTask(nextTask);
    return { task: nextTask };
  }

  function handleDelete(input, { actor, bots, now, targetDeviceIds }) {
    const task = getTaskRecord(input.taskId);
    const dispatcher = getActiveTaskDispatcher(bots);
    const role = getActorRole(actor, task, dispatcher);
    if (role !== 'owner' && role !== 'coordinator') {
      throw error('FORBIDDEN', '只有协调人或主人可以删除任务');
    }
    assertRevision(input.expectedRevision, task.revision);

    invalidateTaskDispatches(task.id, () => true, now, targetDeviceIds);
    deleteTaskStmt.run(task.id);
    return { deleted: true, taskId: task.id };
  }

  function normalizePollCursor(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw error('INVALID_ARGUMENT', 'cursor must be an object with createdAt and rowid');
    }
    if (Object.keys(raw).some((key) => key !== 'createdAt' && key !== 'rowid')) {
      throw error('INVALID_ARGUMENT', 'Unknown cursor field');
    }
    const { createdAt, rowid } = raw;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
      throw error('INVALID_ARGUMENT', 'cursor.createdAt must be a non-negative finite number');
    }
    if (typeof rowid !== 'number' || !Number.isSafeInteger(rowid) || rowid <= 0) {
      throw error('INVALID_ARGUMENT', 'cursor.rowid must be a positive integer');
    }
    return { createdAt, rowid };
  }

  function pollTaskDispatches(arg1, arg2 = null, arg3 = {}) {
    const opts = arg1 && typeof arg1 === 'object' ? arg1 : { deviceId: arg1, cursor: arg2, ...(arg3 || {}) };
    const targetDevice = normalizeRequiredText(opts.deviceId, 'deviceId', 200);
    const after = normalizePollCursor(opts.cursor);
    const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : nowMs();
    const rawLimit = opts.maxItems !== undefined ? opts.maxItems : opts.limit;
    const limit = Math.max(1, Math.min(MAX_POLL_LIMIT, Number.isInteger(rawLimit) ? rawLimit : DEFAULT_POLL_LIMIT));
    const bots = listBotsSnapshot();
    const devices = Array.isArray(opts.devices) ? opts.devices : [];
    const dispatcher = getActiveTaskDispatcher(bots);

    return transaction(() => {
      // 1. Fail expired claimed rows and mark matching active steps as blocked
      const expiredRows = db.prepare(`
        SELECT id, task_id, step_id, kind, device_id, bot_id, execution_revision, cancel_requested
        FROM task_dispatches
        WHERE status IN ('dispatching', 'queued', 'running') AND expires_at <= ?
      `).all(now);
      const failExpiredStmt = db.prepare("UPDATE task_dispatches SET status = 'failed', error = '执行超时（已过期）', updated_at = ? WHERE id = ?");

      for (const exp of expiredRows) {
        failExpiredStmt.run(now, exp.id);
        const task = parseJson(selectTaskStmt.get(exp.task_id));
        if (!task || task.status === 'done' || task.status === 'cancelled') continue;
        if (!exp.cancel_requested && exp.step_id) {
          const idx = (task.steps || []).findIndex((s) => s.id === exp.step_id);
          if (idx >= 0) {
            const step = task.steps[idx];
            const execRev = resolveStepExecutionRevision(step.executionRevision, 1);
            if (execRev === (exp.execution_revision || 1) && (step.status === 'todo' || step.status === 'working' || step.status === 'waiting')) {
              const nextSteps = [...task.steps];
              nextSteps[idx] = {
                ...step,
                status: 'blocked',
                relationNote: '执行超时（已过期）',
                updatedAt: now,
              };
              saveTask({
                ...task,
                steps: nextSteps,
                logs: appendLog(task.logs, `步骤「${step.text}」执行超时（已过期），已标记为阻塞`, now),
                revision: task.revision + 1,
                updatedAt: now,
              });
            }
          }
        } else if (!exp.cancel_requested && task.coordinatorDeviceId === exp.device_id && task.coordinatorBotId === exp.bot_id) {
          saveTask({
            ...task,
            logs: appendLog(task.logs, `协调派发 (${exp.kind}) 执行超时（已过期）`, now),
            revision: task.revision + 1,
            updatedAt: now,
          });
        }
      }

      // 2. Paginate non-terminal dispatches by (created_at, rowid), claiming pending rows and preserving claimed ones
      const cancelPendingStmt = db.prepare("UPDATE task_dispatches SET status = 'cancelled', updated_at = ? WHERE id = ?");
      const markCancelReqStmt = db.prepare('UPDATE task_dispatches SET cancel_requested = 1, updated_at = ? WHERE id = ? AND cancel_requested = 0');
      const claimStmt = db.prepare(`
        UPDATE task_dispatches
        SET status = 'dispatching', task_title = ?, expires_at = ?, updated_at = ?, instruction = ?, payload_json = ?
        WHERE id = ? AND status = 'pending'
      `);

      const items = [];
      let hasMore = false;
      let lastRowMeta = null;
      let scanAfter = after ? [after.createdAt, after.rowid] : null;
      const batchSize = limit + 1;

      while (!hasMore) {
        const candidates = db.prepare(`
          SELECT rowid AS cursor_rowid, * FROM task_dispatches
          WHERE device_id = ?
            AND status IN ('pending', 'dispatching', 'queued', 'running')
            ${scanAfter ? 'AND (created_at, rowid) > (?, ?)' : ''}
          ORDER BY created_at ASC, rowid ASC
          LIMIT ?
        `).all(targetDevice, ...(scanAfter ?? []), batchSize);

        if (candidates.length === 0) break;

        for (const row of candidates) {
          const task = parseJson(selectTaskStmt.get(row.task_id));
          const bot = resolveBot(bots, row.device_id, row.bot_id);
          let valid = Boolean(task && bot && !bot.archivedAt && task.status !== 'done' && task.status !== 'cancelled');

          if (valid && task.pendingPrompt?.kind === 'plan') {
            valid = false;
          }

          let matchedStep = null;
          if (valid && row.step_id) {
            matchedStep = (task.steps || []).find((s) => s.id === row.step_id) || null;
            if (!matchedStep
              || matchedStep.deviceId !== row.device_id
              || matchedStep.botId !== row.bot_id
              || (matchedStep.status !== 'todo' && matchedStep.status !== 'working')
              || resolveStepExecutionRevision(matchedStep.executionRevision, 1) !== (row.execution_revision || 1)
              || !areDependenciesDone(matchedStep, task.steps)) {
              valid = false;
            }
          } else if (valid) {
            if (task.coordinatorDeviceId !== row.device_id || task.coordinatorBotId !== row.bot_id) {
              valid = false;
            }
          }

          if (row.status === 'pending' && (!valid || row.cancel_requested)) {
            cancelPendingStmt.run(now, row.id);
            continue;
          }

          if (items.length >= limit) {
            hasMore = true;
            break;
          }

          if (row.status === 'pending') {
            const isDispatcher = Boolean(dispatcher && dispatcher.deviceId === row.device_id && dispatcher.botId === row.bot_id);
            const freshInstruction = buildDispatchInstruction({
              kind: row.kind,
              task,
              step: matchedStep,
              bots,
              devices,
              getBotCapabilities: listBotCapabilityDirectory,
              isDispatcher,
            });
            const freshPayload = {
              taskId: task.id,
              stepId: row.step_id ?? null,
              kind: row.kind,
              revision: task.revision,
              executionRevision: row.execution_revision || 1,
              task,
              ...(matchedStep ? { step: matchedStep } : {}),
              availableBots: summarizeAvailableBots(bots, devices, listBotCapabilityDirectory),
            };
            const expiresAt = now + DISPATCH_CLAIM_TTL_MS;
            claimStmt.run(task.title, expiresAt, now, freshInstruction, JSON.stringify(freshPayload), row.id);

            items.push({
              id: row.id,
              taskId: row.task_id,
              stepId: row.step_id ?? null,
              kind: row.kind,
              deviceId: row.device_id,
              botId: row.bot_id,
              requestId: row.request_id,
              taskTitle: task.title,
              status: 'dispatching',
              cancelRequested: false,
              executionRevision: row.execution_revision || 1,
              instruction: freshInstruction,
              payload: freshPayload,
              createdAt: row.created_at,
              expiresAt,
              updatedAt: now,
            });
          } else {
            let cancelRequested = Boolean(row.cancel_requested);
            let updatedAt = row.updated_at;
            if (!valid && !cancelRequested) {
              markCancelReqStmt.run(now, row.id);
              cancelRequested = true;
              updatedAt = now;
            }

            items.push({
              id: row.id,
              taskId: row.task_id,
              stepId: row.step_id ?? null,
              kind: row.kind,
              deviceId: row.device_id,
              botId: row.bot_id,
              requestId: row.request_id,
              taskTitle: row.task_title,
              status: row.status,
              cancelRequested,
              executionRevision: row.execution_revision || 1,
              instruction: row.instruction,
              payload: JSON.parse(row.payload_json),
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              updatedAt,
            });
          }

          lastRowMeta = { createdAt: row.created_at, rowid: row.cursor_rowid };
        }

        if (candidates.length < batchSize) break;
        const lastCandidate = candidates[candidates.length - 1];
        scanAfter = [lastCandidate.created_at, lastCandidate.cursor_rowid];
      }

      return {
        items,
        nextCursor: hasMore && lastRowMeta ? lastRowMeta : null,
      };
    });
  }

  function reportTaskDispatch(arg1, arg2, arg3) {
    const opts = arg1 && typeof arg1 === 'object'
      ? arg1
      : { deviceId: arg1, dispatchId: arg2, ...(arg3 || {}) };
    const dev = normalizeRequiredText(opts.deviceId, 'deviceId', 200);
    const id = normalizeRequiredText(opts.dispatchId, 'dispatchId', 200);
    const status = opts.status;
    const allowed = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    if (!allowed.has(status)) throw error('INVALID_ARGUMENT', `Invalid dispatch receipt status: ${status}`);
    const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : nowMs();

    return transaction(() => {
      const row = db.prepare('SELECT * FROM task_dispatches WHERE id = ? AND device_id = ?').get(id, dev);
      if (!row) throw error('NOT_FOUND', `Task dispatch not found: ${id}`);

      if (DISPATCH_TERMINAL_STATUSES.has(row.status)) {
        return {
          id,
          status: row.status,
          cancelRequested: Boolean(row.cancel_requested),
        };
      }
      if (row.status === 'pending') {
        throw error('INVALID_STATE', `Task dispatch has not been dispatched: ${id}`);
      }

      const isTerminalInput = DISPATCH_TERMINAL_STATUSES.has(status);
      if (row.cancel_requested && !isTerminalInput) {
        return {
          id,
          status: row.status,
          cancelRequested: true,
        };
      }

      if (!isTerminalInput && DISPATCH_PROGRESS_ORDER[status] < DISPATCH_PROGRESS_ORDER[row.status]) {
        return {
          id,
          status: row.status,
          cancelRequested: Boolean(row.cancel_requested),
        };
      }

      const normalizedError = normalizeOptionalText(opts.error, 1000) ?? null;
      if (row.status === status && (normalizedError === null || normalizedError === row.error)) {
        if (!isTerminalInput) {
          db.prepare('UPDATE task_dispatches SET expires_at = ?, updated_at = ? WHERE id = ?')
            .run(now + DISPATCH_CLAIM_TTL_MS, now, id);
        }
        return {
          id,
          status: row.status,
          cancelRequested: Boolean(row.cancel_requested),
        };
      }

      const expiresAt = status === 'queued' || status === 'running' ? now + DISPATCH_CLAIM_TTL_MS : row.expires_at;

      db.prepare(`
        UPDATE task_dispatches
        SET status = ?, error = COALESCE(?, error), expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(status, normalizedError, expiresAt, now, id);

      if (status === 'failed' && !row.cancel_requested && row.step_id) {
        const task = parseJson(selectTaskStmt.get(row.task_id));
        if (task && task.status !== 'done' && task.status !== 'cancelled') {
          const idx = (task.steps || []).findIndex((s) => s.id === row.step_id);
          if (idx >= 0) {
            const step = task.steps[idx];
            const execRev = resolveStepExecutionRevision(step.executionRevision, 1);
            if (execRev === (row.execution_revision || 1) && (step.status === 'todo' || step.status === 'working' || step.status === 'waiting')) {
              const nextSteps = [...task.steps];
              nextSteps[idx] = {
                ...step,
                status: 'blocked',
                relationNote: normalizedError || '派发执行失败',
                updatedAt: now,
              };
              saveTask({
                ...task,
                steps: nextSteps,
                logs: appendLog(task.logs, `步骤「${step.text}」执行失败: ${normalizedError || '未知错误'}`, now),
                revision: task.revision + 1,
                updatedAt: now,
              });
            }
          }
        }
      }

      return {
        id,
        status,
        cancelRequested: Boolean(row.cancel_requested),
      };
    });
  }

  return {
    getActiveTaskDispatcher,
    findExistingDispatcherBot,
    setTaskDispatcher,
    hasUnassignedTasks,
    hasPendingDispatches,

    executeTaskAction(input, context = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw error('INVALID_ARGUMENT', 'Action payload must be an object');
      }
      const action = normalizeRequiredText(input.action, 'action', 60);
      if (action === 'list') {
        return { result: handleList(input), targetDeviceIds: [] };
      }
      if (action === 'get') {
        return { result: handleGet(input), targetDeviceIds: [] };
      }

      const actor = context.actor || { kind: 'owner' };
      const devices = Array.isArray(context.devices) ? context.devices : [];
      const bots = listBotsSnapshot();
      const now = nowMs();
      const targetDeviceIds = [];

      const result = transaction(() => {
        switch (action) {
          case 'create':
            return handleCreate(input, { actor, bots, devices, now, targetDeviceIds });
          case 'assign':
            return handleAssign(input, { actor, bots, devices, now, targetDeviceIds });
          case 'update':
            return handleUpdate(input, { actor, bots, devices, now, targetDeviceIds });
          case 'confirm_plan':
            return handleConfirmPlan(input, { actor, bots, devices, now, targetDeviceIds });
          case 'answer_prompt':
            return handleAnswerPrompt(input, { actor, bots, devices, now, targetDeviceIds });
          case 'resolve_adoption_scope':
            return handleResolveAdoptionScope(input, { actor, bots, devices, now, targetDeviceIds });
          case 'dismiss_adoption':
            return handleDismissAdoption(input, { actor, bots, now });
          case 'delete':
            return handleDelete(input, { actor, bots, now, targetDeviceIds });
          default:
            throw error('INVALID_ARGUMENT', `Unknown task action: ${action}`);
        }
      });

      return {
        result,
        targetDeviceIds: [...new Set(targetDeviceIds)],
      };
    },

    claimUnassignedTasks({ devices = [] } = {}) {
      const bots = listBotsSnapshot();
      const dispatcher = getActiveTaskDispatcher(bots);
      if (!dispatcher) return [];
      const dispatcherBot = resolveBot(bots, dispatcher.deviceId, dispatcher.botId);
      if (!dispatcherBot || dispatcherBot.archivedAt) return [];

      const now = nowMs();
      const targetDeviceIds = [];

      transaction(() => {
        const rows = db.prepare(`
          SELECT json FROM tasks
          WHERE status IN ('triaging', 'working', 'waiting')
            AND (coordinator_device_id IS NULL OR coordinator_bot_id IS NULL)
          ORDER BY created_at ASC
        `).all();

        for (const row of rows) {
          const task = JSON.parse(row.json);
          const nextTask = {
            ...task,
            status: task.pendingPrompt ? task.status : 'triaging',
            coordinatorDeviceId: dispatcher.deviceId,
            coordinatorBotId: dispatcher.botId,
            botRefs: buildBotRefs({ coordinator: dispatcherBot, steps: task.steps, origin: task.origin, prevRefs: task.botRefs, bots }),
            summary: task.pendingPrompt ? task.summary : '已交由「任务分派」Bot 评估并指派负责人',
            logs: appendLog(task.logs, `已交由「${botDisplayName(dispatcherBot)}」接手分派`, now),
            revision: task.revision + 1,
            updatedAt: now,
          };
          saveTask(nextTask);
          if (!nextTask.pendingPrompt) {
            enqueueDispatch({
              task: nextTask,
              kind: 'triage',
              deviceId: dispatcher.deviceId,
              botId: dispatcher.botId,
              bots,
              devices,
              now,
              targetDeviceIds,
              replacePendingCoordinator: true,
            });
          }
        }
      });

      return [...new Set(targetDeviceIds)];
    },

    pollTaskDispatches,
    reportTaskDispatch,
    dispatchTaskReceipt: reportTaskDispatch,

    cancelTaskDispatchesForBot(deviceId, botId) {
      if (!deviceId || !botId) return;
      const now = nowMs();
      transaction(() => {
        db.prepare(`
          UPDATE task_dispatches
          SET status = 'cancelled', updated_at = ?
          WHERE device_id = ? AND bot_id = ? AND status = 'pending'
        `).run(now, deviceId, botId);
        db.prepare(`
          UPDATE task_dispatches
          SET cancel_requested = 1, updated_at = ?
          WHERE device_id = ? AND bot_id = ? AND status IN ('dispatching', 'queued', 'running')
        `).run(now, deviceId, botId);
      });
    },
  };
}
