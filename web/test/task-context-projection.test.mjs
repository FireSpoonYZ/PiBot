import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTaskContext, TASK_CONTEXT_MAX_CHARS, TASK_CONTEXT_LIMITS } from '../../plugins/tasks/context-projection.js';
import { createPlugin } from '../../plugins/tasks/entry.js';

const identity = { deviceId: 'device-self', botId: 'bot-self' };
const step = (index, patch = {}) => ({
  id: `step-${String(index).padStart(3, '0')}`, text: `步骤 ${index}`, status: 'todo',
  deviceId: identity.deviceId, botId: identity.botId, updatedAt: index, ...patch,
});
const task = (index, patch = {}) => ({
  id: `task-${String(index).padStart(3, '0')}`, title: `任务 ${index}`, status: 'working', revision: 2,
  coordinatorDeviceId: identity.deviceId, coordinatorBotId: identity.botId,
  summary: '', requirement: '', pendingPrompt: null, adoption: null,
  updatedAt: index, steps: [step(index)], ...patch,
});
const bot = (index, patch = {}) => ({
  deviceId: `device-${index}`, botId: `bot-${index}`, name: `Bot ${index}`,
  description: `职责 ${index}`, online: true, capabilities: ['read', 'write'], ...patch,
});

function freeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('task projection bounds large multilingual inputs without dropping gates or splitting Unicode', () => {
  const long = '中文😀🧭'.repeat(2_000) + '\ud800';
  const activeTasks = Array.from({ length: 100 }, (_, index) => task(index, {
    title: long, summary: long, requirement: long,
    pendingPrompt: { kind: 'plan', text: long, options: Array(8).fill(long) },
    adoption: { phase: 'needs_scope', changeText: long, scopeDesc: long },
    steps: Array.from({ length: 100 }, (_, n) => step(n, {
      text: long, resultSummary: long, dependsOnStepIds: Array.from({ length: 32 }, (_, dep) => `dependency-${dep}`),
    })),
  }));
  const output = projectTaskContext({ ...identity, activeTasks,
    directoryBots: Array.from({ length: 100 }, (_, index) => bot(index, { name: long, description: long, capabilities: Array(40).fill(long) })),
    executionContext: { taskId: 'task-099', stepId: 'step-050' },
  });
  assert.ok(output.length <= TASK_CONTEXT_MAX_CHARS);
  assert.equal(output, output.toWellFormed());
  assert.match(output, /本轮可信焦点：taskId=task-099；stepId=step-050/);
  assert.match(output, /计划待用户确认，尚未获批/);
  assert.match(output, /需求范围待用户选择/);
  assert.match(output, /未完成有效步骤=100/);
  assert.match(output, /本轮步骤：\n {2}- stepId=step-050/);
  assert.match(output, /近期结果 stepId=step-099/);
  assert.match(output, /省略 \d+/);
  assert.match(output, /普通执行 Bot 仅可用 `update_step`/);
  assert.match(output, /调用 `complete`（或执行 Bot 完成自身步骤）后，务必在当前对话正文中直接输出面向用户的最终结论，严禁只调工具而不回复正文/);
  assert.match(output, /切勿重复调用 `propose_plan` 要求重新确认/);
  assert.match(output, /未确认前，用户的普通聊天回复不代表批准开工/);
  assert.ok(output.endsWith('Center 的权限、待确认状态与版本校验仍是依据。'));
});

test('missing trusted focus does not select another task or infer authority from the role hint', () => {
  const output = projectTaskContext({ ...identity, activeTasks: [task(1, { coordinatorBotId: 'someone-else' })],
    executionContext: { taskId: 'not-cached', stepId: 'missing-step', role: 'coordinator' },
  });
  assert.match(output, /焦点任务不在当前缓存中/);
  assert.match(output, /不得视为已完成、已批准或改用其他任务/);
  assert.match(output, /我是执行者\/关联者/);
  assert.doesNotMatch(output, /我是协调人/);
  assert.match(output, /关联任务摘要 1\/1/);
});

test('missing focused step is explicit and full unfinished count survives step omission', () => {
  const active = task(1, { steps: Array.from({ length: 30 }, (_, index) => step(index)) });
  const output = projectTaskContext({ ...identity, activeTasks: [active], executionContext: { taskId: active.id, stepId: 'not-cached' } });
  assert.match(output, /指定步骤不在当前缓存中/);
  assert.match(output, /未完成有效步骤=30/);
  assert.match(output, new RegExp(`展示步骤 ${TASK_CONTEXT_LIMITS.focusSteps}/30，省略 ${30 - TASK_CONTEXT_LIMITS.focusSteps}`));
});

test('without a trusted focus, only bounded task summaries are included', () => {
  const activeTasks = Array.from({ length: 30 }, (_, index) => task(index, {
    summary: '不可全量注入摘要', steps: [step(index, { text: '不可全量注入步骤', resultSummary: '不可全量注入结果' })],
  }));
  const output = projectTaskContext({ ...identity, activeTasks });
  assert.match(output, /本轮没有可信任务焦点/);
  assert.doesNotMatch(output, /不可全量注入/);
  assert.ok((output.match(/^- taskId=/gm) ?? []).length <= TASK_CONTEXT_LIMITS.otherTasks);
  assert.match(output, /关联任务摘要 \d+\/30，省略 \d+/);
});

test('focus, dependencies and recent results precede unrelated work', () => {
  const current = task(1, { steps: [
    step(1, { dependsOnStepIds: ['step-010'] }),
    step(2, { status: 'working' }),
    step(10, { botId: 'peer', status: 'blocked', resultSummary: '最近的明确结果', updatedAt: 1_000 }),
    ...Array.from({ length: 20 }, (_, index) => step(index + 20)),
  ] });
  const output = projectTaskContext({ ...identity, activeTasks: [task(2), current],
    executionContext: { taskId: current.id, stepId: 'step-001' },
  });
  assert.ok(output.indexOf('本轮可信焦点') < output.indexOf('其他关联任务摘要'));
  assert.ok(output.indexOf('本轮步骤') < output.indexOf('近期结果'));
  assert.ok(output.indexOf('  - stepId=step-010') < output.indexOf('  - stepId=step-002'));
  assert.match(output, /近期结果 stepId=step-010 \[blocked\]：最近的明确结果/);
});

test('projection is deterministic across source order and never mutates task facts', () => {
  const current = task(1, { steps: [step(5), step(2), step(1)], pendingPrompt: { kind: 'question', text: '需要选择', options: ['甲', '乙'] } });
  const input = freeze({ ...identity, activeTasks: [task(3), current, task(2)], directoryBots: [bot(3), bot(1), bot(2)], executionContext: { taskId: current.id, stepId: 'step-002' } });
  const before = JSON.stringify(input);
  const output = projectTaskContext(input);
  assert.equal(JSON.stringify(input), before);
  const reversed = { ...input, activeTasks: [...input.activeTasks].reverse().map((value) => ({ ...value, steps: [...value.steps].reverse() })), directoryBots: [...input.directoryBots].reverse() };
  assert.equal(projectTaskContext(reversed), output);
});

test('directory is capped and keeps self and focused task participants first', () => {
  const current = task(1, { coordinatorDeviceId: 'device-coordinator', coordinatorBotId: 'bot-coordinator',
    steps: [step(1, { deviceId: 'device-peer', botId: 'bot-peer' })] });
  const directoryBots = [
    ...Array.from({ length: 20 }, (_, index) => bot(index)),
    bot('peer'), bot('coordinator'), bot('self', { ...identity, name: '我' }),
  ];
  const output = projectTaskContext({ ...identity, activeTasks: [current], directoryBots, executionContext: { taskId: current.id } });
  const directory = output.slice(output.indexOf('团队 Bot 目录摘要'));
  assert.ok(directory.indexOf('botId=bot-self') < directory.indexOf('botId=bot-coordinator'));
  assert.ok(directory.indexOf('botId=bot-coordinator') < directory.indexOf('botId=bot-peer'));
  assert.ok((directory.match(/^-.+\(deviceId=/gm) ?? []).length <= TASK_CONTEXT_LIMITS.directoryBots);
  assert.match(directory, /目录展示 \d+\/23，省略 \d+/);
  assert.match(directory, /不按摘要顺序或关键词自动路由/);
});

test('summary rows retain pending gates even when titles consume their field budget', () => {
  const activeTasks = Array.from({ length: 50 }, (_, index) => task(index, {
    title: '很长的任务标题'.repeat(1_000), pendingPrompt: { kind: 'plan', text: '确认计划' },
  }));
  const output = projectTaskContext({ ...identity, activeTasks });
  const rows = output.match(/^- taskId=/gm) ?? [];
  assert.ok(rows.length > 0);
  assert.equal((output.match(/计划待用户确认，尚未获批/g) ?? []).length, rows.length);
});

function pluginHost(tasks) {
  return { tasks, sdk: { defineTool: (definition) => definition, section: (name, render) => ({ name, render }) }, assertCapabilityAllowed() {} };
}

test('plugin reads the Host focus, ignores forged section input, and supports the old facade', async () => {
  const calls = [];
  const shared = { getActiveForBot: () => [task(1), task(2)], listDirectoryBots: () => [] };
  const plugin = createPlugin({ installationId: 'tasks', host: pluginHost({ ...shared,
    getExecutionContext: (botId, conversationId) => { calls.push({ botId, conversationId }); return { taskId: 'task-002' }; },
  }) });
  const instance = await plugin.forBot(identity);
  const output = await instance.durableContributions.sections[0].render({ conversationId: 42, taskId: 'task-001', executionContext: { taskId: 'task-001' } });
  assert.match(output, /本轮可信焦点：taskId=task-002/);
  assert.deepEqual(calls, [{ botId: identity.botId, conversationId: 42 }]);
  await plugin.close();

  const legacy = createPlugin({ installationId: 'tasks', host: pluginHost(shared) });
  const legacyInstance = await legacy.forBot(identity);
  const legacyOutput = await legacyInstance.durableContributions.sections[0].render({ conversationId: 42, taskId: 'task-001' });
  assert.match(legacyOutput, /本轮没有可信任务焦点/);
  await legacy.close();
});

test('task tool reminds Bots to output user-facing final replies on step completion and complete while keeping role boundaries', async () => {
  const api = { conversationId: 7, taskId: 'native-7', async details() {} };
  const partialSnapshot = task(1, {
    coordinatorDeviceId: 'device-coord',
    coordinatorBotId: 'bot-coord',
    steps: [
      step(1, { status: 'working' }),
      step(2, { deviceId: 'device-coord', botId: 'bot-coord', status: 'todo' }),
    ],
  });
  const executorPlugin = createPlugin({
    installationId: 'tasks',
    host: pluginHost({
      listDirectoryBots: () => [],
      invoke: async (_botId, payload) => {
        if (payload.action === 'get') return { task: partialSnapshot };
        return {
          task: {
            ...partialSnapshot,
            revision: partialSnapshot.revision + 1,
            steps: [
              { ...partialSnapshot.steps[0], status: 'done', resultSummary: '步骤已完成' },
              partialSnapshot.steps[1],
            ],
          },
        };
      },
    }),
  });
  const executorInstance = await executorPlugin.forBot(identity);
  const executorTool = executorInstance.durableContributions.tools[0];
  const stepDoneResult = await executorTool.execute(
    { action: 'update_step', taskId: 'task-001', stepId: 'step-001', status: 'done', resultSummary: '步骤已完成' },
    api,
    {},
  );
  assert.match(stepDoneResult.output[0].text, /本步骤已标记完成，请在当前对话回复正文中简要输出本步骤的执行结果/);
  const forbiddenComplete = await executorTool.execute(
    { action: 'complete', taskId: 'task-001', summary: '试图越权收尾' },
    api,
    {},
  );
  assert.equal(forbiddenComplete.isError, true);
  assert.match(forbiddenComplete.output[0].text, /仅任务协调人可以调用 complete/);
  await executorPlugin.close();

  const readyToComplete = task(2, {
    steps: [step(1, { status: 'done', resultSummary: '全部就绪' })],
  });
  const coordPlugin = createPlugin({
    installationId: 'tasks',
    host: pluginHost({
      listDirectoryBots: () => [],
      invoke: async (_botId, payload) => {
        if (payload.action === 'get') return { task: readyToComplete };
        return {
          task: {
            ...readyToComplete,
            revision: readyToComplete.revision + 1,
            status: 'done',
            summary: payload.summary,
          },
        };
      },
    }),
  });
  const coordInstance = await coordPlugin.forBot(identity);
  const coordTool = coordInstance.durableContributions.tools[0];
  const completedResult = await coordTool.execute(
    { action: 'complete', taskId: 'task-002', summary: '最终结论汇总' },
    api,
    {},
  );
  assert.match(completedResult.output[0].text, /任务已标记完成。请立即在当前对话回复正文中向用户清晰完整地呈现最终结论与结果/);
  await coordPlugin.close();
});
