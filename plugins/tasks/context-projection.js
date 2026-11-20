// A bounded view of Center-owned task facts. This is prompt assembly, not a
// second task store: omission never changes approval, ownership or completion.
export const TASK_CONTEXT_MAX_CHARS = 12_000;
export const TASK_CONTEXT_LIMITS = Object.freeze({ focusSteps: 8, recentResults: 2, otherTasks: 8, directoryBots: 6 });

const RULES = [
  '## 全局任务与协作（task 工具）',
  '使用 `task` 工具记录和管理全局任务及个人步骤（已替代旧 `todo` 清单）。用户在对话或语音中顺口交代需要持续跟进、跨步骤或跨 Bot 协作的事项时，主动调用 `task` 记入全局任务。',
  '协作纪律：',
  '1. **分派负责人（`assign`）**：专用任务分派 Bot 或当前协调人移交统筹权时，结合下方目录中各 Bot 的**职责、能力、所属设备与在线概况**由模型语义判断并选择最合适的负责人（禁止简单关键词路由），调用 `task` (`action="assign"`, `coordinatorDeviceId`, `coordinatorBotId`) 指派。',
  '2. **澄清与需求变更范围（`ask_clarification` / `needs_scope`）**：想法含糊或目标边界不清时，先用 `task` (`action="ask_clarification"`) 提问并等待用户回应；若已批准或新收到的需求变更与已完成步骤存在取舍，使用 `adoptionPhase="needs_scope"` 与具体的 `scopeDesc` 说明影响范围，请用户选择保留成果或重做。',
  '3. **计划确认（`propose_plan`）**：仅任务协调人可提交或调整整体分步安排（`propose_plan`）并等待用户在界面点击「确认安排并开始」；未确认前，用户的普通聊天回复不代表批准开工。',
  '4. **已批准需求变更（`adoption.phase === "adjusting"`）**：尽量保留已完成步骤成果（`preserved: true`），使用 `update_step` 修改受影响的未完成步骤，使用 `add_steps` 新增补做项，再用 `update(adoptionPhase=\'adopted\', shortReceipt=...)` 记录回执；**切勿重复调用 `propose_plan` 要求重新确认**。',
  '5. **角色边界与显式验收（`update_step` vs `complete`）**：普通执行 Bot 仅可用 `update_step` 更新指派给自己的步骤（如标为 `working` / `done` 并附 `resultSummary`），不得修改他人或未指派步骤、不得调用 `propose_plan` / `update` 覆盖全局计划、不得调用 `complete` 结束父任务；仅任务协调人在无待回应提示且所有有效步骤均已 `done` 后，显式调用 `complete` 完成收尾验收。调用 `complete`（或执行 Bot 完成自身步骤）后，务必在当前对话正文中直接输出面向用户的最终结论，严禁只调工具而不回复正文。',
].join('\n');

const FOOTER = '以上是有界快照；… 表示字段删节，省略不代表已完成、已批准或没有依赖。操作前用 task(action="get", taskId=...) 核实完整任务；用 task(action="list") 分页查阅其余任务。Center 的权限、待确认状态与版本校验仍是依据。';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const items = (value) => Array.isArray(value) ? value.filter(object) : [];
const id = (value) => typeof value === 'string' ? value : '';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const timestamp = (value) => Number.isFinite(value) ? value : 0;

// UTF-16 is deliberate: the total bound is cheap and stable on every Host.
// Never split a surrogate pair, and keep caller-controlled fields on one line.
function text(value, limit) {
  const clean = (typeof value === 'string' ? value : '').toWellFormed().replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (clean.length <= limit) return clean;
  let end = Math.max(0, limit - 1);
  if (end > 0 && /[\uD800-\uDBFF]/u.test(clean[end - 1])) end -= 1;
  return clean.slice(0, end) + '…';
}

function writer(limit, reserve = 0) {
  const lines = [];
  let size = 0;
  return {
    add(line) {
      const added = line.length + (lines.length ? 1 : 0);
      if (size + added > limit - reserve) return false;
      lines.push(line);
      size += added;
      return true;
    },
    finish(tail = '') {
      if (tail && size + tail.length + (lines.length ? 1 : 0) <= limit) lines.push(tail);
      return lines.join('\n');
    },
  };
}

function role(task, deviceId, botId) {
  return typeof botId === 'string' && botId.length > 0 && task.coordinatorBotId === botId && (!task.coordinatorDeviceId || task.coordinatorDeviceId === deviceId)
    ? '我是协调人' : '我是执行者/关联者，仅可更新明确指派给自己的步骤';
}

function guards(task) {
  const result = [];
  if (task.pendingPrompt) {
    result.push(task.pendingPrompt.kind === 'plan' ? '计划待用户确认，尚未获批' : '存在待用户回应，尚未解决');
  }
  if (task.adoption?.phase === 'needs_scope') result.push('需求范围待用户选择');
  else if (task.adoption?.phase) result.push(`需求变更=${text(task.adoption.phase, 24)}`);
  if (task.status === 'waiting' && !task.pendingPrompt) result.push('等待原因须查询，不推断为已批准');
  return result.length ? result.join('；') : '未见待回应提示，不据此推断批准';
}

function stepCounts(task) {
  const steps = items(task.steps);
  const unfinished = steps.filter((step) => step.status !== 'done' && step.status !== 'cancelled').length;
  return `步骤总数=${steps.length}，未完成有效步骤=${unfinished}`;
}

function taskLine(task, deviceId, botId) {
  const revision = Number.isSafeInteger(task.revision) && task.revision >= 0 ? task.revision : '未知';
  return `- taskId=${text(task.id, 128)} [${text(task.status, 24) || '状态未知'} | ${role(task, deviceId, botId)} | rev=${revision}] ${text(task.title, 160)}`;
}

function stepLine(step) {
  const dependencies = Array.isArray(step.dependsOnStepIds) ? step.dependsOnStepIds.filter((value) => typeof value === 'string') : [];
  const depText = dependencies.length
    ? `；依赖(${dependencies.length})=${dependencies.slice(0, 4).map((value) => text(value, 64)).join(', ')}${dependencies.length > 4 ? '，其余须查询' : ''}` : '';
  const owner = step.botId ? `${text(step.deviceId, 128) || '设备未指明'}/${text(step.botId, 128)}` : '未指派';
  return `  - stepId=${text(step.id, 128)} [${text(step.status, 24) || '状态未知'}；owner=${owner}${step.preserved ? '；保留成果' : ''}${depText}] ${text(step.text, 180)}`;
}

function focusSection(task, executionContext, deviceId, botId, limit) {
  const out = writer(limit, 180);
  out.add(`本轮可信焦点：taskId=${text(executionContext.taskId, 128)}${executionContext.stepId ? `；stepId=${text(executionContext.stepId, 128)}` : ''}`);
  if (!task) {
    out.add('焦点任务不在当前缓存中；不得视为已完成、已批准或改用其他任务。先用 task get 查询该 taskId。');
    return out.finish();
  }
  out.add(taskLine(task, deviceId, botId));
  out.add(`  门槛：${guards(task)}。${stepCounts(task)}。`);
  const steps = items(task.steps);
  const focusStep = steps.find((step) => id(step.id) === id(executionContext.stepId) && id(step.id));
  if (executionContext.stepId && !focusStep) out.add('  指定步骤不在当前缓存中，先查询完整任务，不替换为其他步骤。');
  // Show the focused step before optional prose, so a very long requirement
  // cannot evict its ownership, status or dependency warnings.
  if (focusStep) out.add(`  本轮步骤：\n${stepLine(focusStep)}`);
  if (task.pendingPrompt) {
    out.add(`  待回应 [${text(task.pendingPrompt.kind, 24)}]：${text(task.pendingPrompt.text, 500)}`);
    if (Array.isArray(task.pendingPrompt.options) && task.pendingPrompt.options.length) {
      out.add(`  选项(${task.pendingPrompt.options.length})：${task.pendingPrompt.options.slice(0, 4).map((value) => text(value, 100)).join(' / ')}${task.pendingPrompt.options.length > 4 ? ' / …（余下选项须查询）' : ''}`);
    }
  }
  if (task.adoption && task.adoption.phase !== 'adopted') {
    out.add(`  需求变更内容：${text(task.adoption.changeText, 300)}；范围：${text(task.adoption.scopeDesc, 300)}`);
  }
  if (task.requirement) out.add(`  目标：${text(task.requirement, 600)}`);
  if (task.summary) out.add(`  摘要：${text(task.summary, 400)}`);

  // Results are ordered by the persisted update time, never wall-clock time.
  // Place this small view before the remaining steps, so a large checklist
  // cannot evict all recent results from the focused task.
  const results = steps.filter((step) => step.resultSummary).sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt) || compare(id(a.id), id(b.id)));
  let shownResults = 0;
  for (const step of results.slice(0, TASK_CONTEXT_LIMITS.recentResults)) {
    if (!out.add(`  近期结果 stepId=${text(step.id, 128)} [${text(step.status, 24)}]：${text(step.resultSummary, 240)}`)) break;
    shownResults += 1;
  }
  const dependencies = new Set(Array.isArray(focusStep?.dependsOnStepIds) ? focusStep.dependsOnStepIds : []);
  const rank = (step) => dependencies.has(step.id) ? 0
    : step.botId === botId && (!step.deviceId || step.deviceId === deviceId) && !['done', 'cancelled'].includes(step.status) ? 1
      : ['waiting', 'blocked', 'working'].includes(step.status) ? 2 : 3;
  const selected = steps.filter((step) => step !== focusStep).sort((a, b) => rank(a) - rank(b) || compare(id(a.id), id(b.id)));
  let shown = focusStep ? 1 : 0;
  for (const step of selected) {
    if (shown >= TASK_CONTEXT_LIMITS.focusSteps || !out.add(stepLine(step))) break;
    shown += 1;
  }
  return out.finish(`  展示步骤 ${shown}/${steps.length}，省略 ${steps.length - shown}；结果摘要 ${shownResults}/${results.length}。未展示的状态、依赖和验收条件仍有效。`);
}

function summarySection(tasks, deviceId, botId, limit) {
  const out = writer(limit, 150);
  out.add('其他关联任务摘要（不自动切换本轮焦点）：');
  const sorted = [...tasks].sort((a, b) => Number(Boolean(b.pendingPrompt)) - Number(Boolean(a.pendingPrompt))
    || timestamp(b.updatedAt) - timestamp(a.updatedAt) || compare(id(a.id), id(b.id)));
  let shown = 0;
  for (const task of sorted.slice(0, TASK_CONTEXT_LIMITS.otherTasks)) {
    // All gates stay attached to the same row. Never append a title and then
    // silently drop its pending approval because the next line did not fit.
    const row = `${taskLine(task, deviceId, botId)}\n  ${guards(task)}；${stepCounts(task)}。`;
    if (!out.add(row)) break;
    shown += 1;
  }
  return out.finish(`关联任务摘要 ${shown}/${tasks.length}，省略 ${tasks.length - shown}；须用 task list/get 查阅完整记录。`);
}

function capabilities(bot) {
  const names = [];
  for (const field of [bot.capabilities, bot.capabilityNames, bot.skills, bot.tools]) {
    for (const value of Array.isArray(field) ? field : []) {
      const name = typeof value === 'string' ? value : object(value) && value.enabled !== false ? value.displayName ?? value.name ?? value.id : '';
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  }
  return text([...new Set(names)].sort(compare).join(', '), 100)
    || (Array.isArray(bot.capabilities) ? '无额外扩展能力（仅基础对话）' : '未单独标注，请结合职责核实');
}

function directorySection(bots, task, deviceId, botId, limit) {
  const out = writer(limit, 160);
  out.add('团队 Bot 目录摘要（职责 / 能力 / 设备 / 在线状态）：');
  const owners = new Set(items(task?.steps).map((step) => `${id(step.deviceId)}\0${id(step.botId)}`));
  const rank = (bot) => bot.deviceId === deviceId && bot.botId === botId ? 0
    : task?.coordinatorBotId === bot.botId && (!task.coordinatorDeviceId || task.coordinatorDeviceId === bot.deviceId) ? 1
      : owners.has(`${bot.deviceId}\0${bot.botId}`) || owners.has(`\0${bot.botId}`) ? 2
        : bot.isDispatcher || bot.dispatcher ? 3 : 4;
  const sorted = [...bots].sort((a, b) => rank(a) - rank(b) || compare(id(a.deviceId), id(b.deviceId)) || compare(id(a.botId), id(b.botId)));
  let shown = 0;
  for (const bot of sorted.slice(0, TASK_CONTEXT_LIMITS.directoryBots)) {
    const name = text(bot.name ?? bot.botName ?? bot.role ?? bot.botId, 60);
    const tags = [bot.botId === botId && bot.deviceId === deviceId ? '当前Bot' : '', bot.isPrimary ? '主Bot' : '', bot.isDispatcher || bot.dispatcher ? '分派Bot' : ''].filter(Boolean);
    const row = `- ${name}${tags.length ? ` [${tags.join(' / ')}]` : ''} (deviceId=${text(bot.deviceId, 128)}, botId=${text(bot.botId, 128)}) | 设备=${text(bot.deviceName, 60) || text(bot.deviceId, 128)}${bot.platform ? `/${text(bot.platform, 24)}` : ''} | 状态=${bot.online === false ? '离线' : bot.online === true ? '在线' : '未确认'} | 职责=${text(bot.description || bot.role, 100) || '未标注'} | 能力=${capabilities(bot)}`;
    if (!out.add(row)) break;
    shown += 1;
  }
  return out.finish(`目录展示 ${shown}/${bots.length}，省略 ${bots.length - shown}；未展示不代表不存在或能力不足。按职责和能力选择，不按摘要顺序或关键词自动路由。`);
}

/** executionContext comes only from the Host's validated frozen turn. */
export function projectTaskContext({ activeTasks = [], directoryBots = [], deviceId, botId, executionContext = null } = {}) {
  const tasks = items(activeTasks).filter((task) => id(task.id));
  const bots = items(directoryBots).filter((bot) => id(bot.botId) && id(bot.deviceId));
  const context = object(executionContext) && id(executionContext.taskId) ? executionContext : null;
  const focus = context ? tasks.find((task) => task.id === context.taskId) : null;
  const sections = [RULES];
  let used = RULES.length + FOOTER.length + 1;
  const append = (render, cap) => {
    const limit = Math.min(cap, TASK_CONTEXT_MAX_CHARS - used - 1);
    if (limit <= 0) return;
    const section = render(limit);
    if (section) { sections.push(section); used += section.length + 1; }
  };
  if (context) append((limit) => focusSection(focus, context, deviceId, botId, limit), 5_800);
  else append(() => '本轮没有可信任务焦点；以下只是关联任务概况，不依据聊天文本猜测 taskId 或批准状态。', 100);
  append((limit) => summarySection(tasks.filter((task) => task !== focus), deviceId, botId, limit), 2_300);
  append((limit) => directorySection(bots, focus, deviceId, botId, limit), 2_200);
  sections.push(FOOTER);
  return sections.join('\n');
}
