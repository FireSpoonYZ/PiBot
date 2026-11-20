import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHistoryEntries, visibleAssistantTextEntryIds } from '../src/chatTurnModel.ts';
import { resolveBotChatTaskContext } from '../src/tasks/types.ts';

function makeTask(overrides) {
  return {
    id: overrides.id,
    title: overrides.title,
    requirement: overrides.requirement ?? overrides.title,
    sourceText: overrides.sourceText ?? overrides.title,
    status: overrides.status ?? 'working',
    summary: overrides.summary ?? '',
    origin: overrides.origin ?? { kind: 'ui', label: '' },
    coordinatorDeviceId: overrides.coordinatorDeviceId ?? 'dev-linux',
    coordinatorBotId: overrides.coordinatorBotId ?? 'bot-ops',
    botRefs: overrides.botRefs ?? [{ deviceId: 'dev-linux', botId: 'bot-ops', botName: 'linux运维助手' }],
    pendingPrompt: overrides.pendingPrompt ?? null,
    adoption: overrides.adoption ?? null,
    steps: overrides.steps ?? [],
    logs: overrides.logs ?? [],
    revision: overrides.revision ?? 1,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
  };
}

test('resolveBotChatTaskContext stays completely silent during normal chat even with active or completed tasks', () => {
  const tasks = [
    makeTask({
      id: 'task-working',
      title: '核查幻视最新剧集',
      status: 'working',
      steps: [
        {
          id: 'step-1',
          parentStepId: null,
          text: '只读核查 Linux /data',
          status: 'working',
          deviceId: 'dev-linux',
          botId: 'bot-ops',
          updatedAt: 1_700_000_000_000,
        },
      ],
    }),
    makeTask({
      id: 'task-done',
      title: '历史已完成任务',
      status: 'done',
      summary: '已完成',
    }),
  ];

  const ctx = resolveBotChatTaskContext({
    tasks,
    botDeviceId: 'dev-linux',
    botId: 'bot-ops',
    jumpedTaskId: null,
    jumpedStepId: null,
  });

  assert.equal(ctx.linkedTask, null);
  assert.equal(ctx.promptTask, null);
  assert.equal(ctx.showQuoteStrip, false);
  assert.equal(ctx.taskPrefix, '');
});

test('resolveBotChatTaskContext auto-binds waiting prompt and only shows quote strip for explicit active jumps', () => {
  const waitingTask = makeTask({
    id: 'task-wait',
    title: '待确认部署计划',
    status: 'waiting',
    pendingPrompt: {
      kind: 'plan',
      deviceId: 'dev-linux',
      botId: 'bot-ops',
      text: '确认后执行只读检查',
      createdAt: 1_700_000_000_000,
    },
  });
  const runningTask = makeTask({
    id: 'task-run',
    title: '正在执行的巡检',
    status: 'working',
    steps: [
      {
        id: 'step-a',
        parentStepId: null,
        text: '检查磁盘空间',
        status: 'working',
        deviceId: 'dev-linux',
        botId: 'bot-ops',
        updatedAt: 1_700_000_000_000,
      },
    ],
  });
  const doneTask = makeTask({
    id: 'task-finished',
    title: '已归档完成事项',
    status: 'done',
  });

  // Normal entry with a waiting prompt: directly surfaces promptTask without duplicate quote strip
  const normalWithPrompt = resolveBotChatTaskContext({
    tasks: [waitingTask, runningTask, doneTask],
    botDeviceId: 'dev-linux',
    botId: 'bot-ops',
    jumpedTaskId: null,
    jumpedStepId: null,
  });
  assert.equal(normalWithPrompt.promptTask?.id, 'task-wait');
  assert.equal(normalWithPrompt.showQuoteStrip, false);
  assert.equal(normalWithPrompt.taskPrefix, '[关联任务「待确认部署计划」(task-wait)]\n');

  // Explicit jump into an active running step: shows single-line quote strip with step focus
  const jumpedRunning = resolveBotChatTaskContext({
    tasks: [waitingTask, runningTask, doneTask],
    botDeviceId: 'dev-linux',
    botId: 'bot-ops',
    jumpedTaskId: 'task-run',
    jumpedStepId: 'step-a',
  });
  assert.equal(jumpedRunning.promptTask, null);
  assert.equal(jumpedRunning.showQuoteStrip, true);
  assert.equal(jumpedRunning.focusedStep?.id, 'step-a');
  assert.equal(
    jumpedRunning.taskPrefix,
    '[关联任务「正在执行的巡检」(task-run) · 子项「检查磁盘空间」(step-a)]\n',
  );

  // Explicit jump into an already-done task: never attaches stale quote strip
  const jumpedDone = resolveBotChatTaskContext({
    tasks: [doneTask],
    botDeviceId: 'dev-linux',
    botId: 'bot-ops',
    jumpedTaskId: 'task-finished',
    jumpedStepId: null,
  });
  assert.equal(jumpedDone.linkedTask, null);
  assert.equal(jumpedDone.showQuoteStrip, false);
  assert.equal(jumpedDone.taskPrefix, '');
});

test('parseHistoryEntries surfaces task completion summary in bot chat when model omits final assistant text', () => {
  const finalSummary =
    '《幻视任务》（VisionQuest, 2026）第一季第 1-8 集均已落盘。最新一集 S01E08 已下载完成。';
  const entries = [
    {
      id: 1,
      kind: 'host.user-message',
      data: {
        attribution: {
          kind: 'host',
          channel: 'primary',
          name: '任务 · 我想看一下我的幻视最新剧集是否下载完了',
          sourceType: 'webhook',
        },
      },
      model: [
        {
          role: 'user',
          content: '请执行任务核查',
          timestamp: 1_700_000_010_000,
        },
      ],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '核查已完成，调用 complete 收尾' },
            {
              type: 'toolCall',
              id: 'call_complete',
              name: 'task',
              arguments: {
                action: 'complete',
                taskId: 'task-vision',
                summary: finalSummary,
              },
            },
          ],
          timestamp: 1_700_000_011_000,
          durationMs: 500,
        },
      ],
    },
    {
      id: 3,
      kind: 'pi.tool_result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call_complete',
          toolName: 'task',
          content: [{ type: 'text', text: `taskId: task-vision\n状态: done\n摘要: ${finalSummary}` }],
          details: {
            presentation: {
              kind: 'task',
              version: 1,
              installationId: 'inst_tasks',
              taskId: 'task-vision',
              title: '我想看一下我的幻视最新剧集是否下载完了',
              status: 'done',
              cardLabel: '任务已完成',
              summary: finalSummary,
              stepCount: { done: 1, total: 1 },
              pendingPrompt: null,
            },
          },
          isError: false,
          timestamp: 1_700_000_011_500,
          durationMs: 50,
        },
      ],
    },
  ];

  const turns = parseHistoryEntries(entries, 0, {
    isBusy: false,
    trackAssistantTextEntries: true,
  });

  assert.equal(turns.length, 2);
  const assistantTurn = turns[1];
  assert.equal(assistantTurn.role, 'assistant');
  assert.equal(assistantTurn.text, finalSummary);
  assert.equal(assistantTurn.blocks?.at(-1)?.kind, 'text');
  if (assistantTurn.blocks?.at(-1)?.kind === 'text') {
    assert.equal(assistantTurn.blocks.at(-1)?.text, finalSummary);
  }
  assert.deepEqual(visibleAssistantTextEntryIds(turns), ['3']);
});

test('parseHistoryEntries does not duplicate task summary when model already wrote full assistant reply', () => {
  const finalSummary =
    '《幻视任务》（VisionQuest, 2026）第一季第 1-8 集均已落盘。最新一集 S01E08 已下载完成。';
  const spokenReply = `我已经帮你核查完毕：${finalSummary}`;
  const entries = [
    {
      id: 10,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_complete_2',
              name: 'task',
              arguments: {
                action: 'complete',
                taskId: 'task-vision',
                summary: finalSummary,
              },
            },
          ],
          timestamp: 1_700_000_020_000,
        },
      ],
    },
    {
      id: 11,
      kind: 'pi.tool_result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call_complete_2',
          toolName: 'task',
          content: [{ type: 'text', text: `摘要: ${finalSummary}` }],
          details: {
            presentation: {
              kind: 'task',
              version: 1,
              installationId: 'inst_tasks',
              taskId: 'task-vision',
              title: '核查幻视',
              status: 'done',
              cardLabel: '任务已完成',
              summary: finalSummary,
              stepCount: { done: 1, total: 1 },
              pendingPrompt: null,
            },
          },
          isError: false,
          timestamp: 1_700_000_020_100,
        },
      ],
    },
    {
      id: 12,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: spokenReply }],
          timestamp: 1_700_000_020_500,
        },
      ],
    },
  ];

  const turns = parseHistoryEntries(entries, 0, { isBusy: false });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, spokenReply);
  const textBlocks = (turns[0].blocks ?? []).filter(b => b.kind === 'text');
  assert.equal(textBlocks.length, 1);
});
