import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLiveState } from '../../host-core/runtime-live-projection.js';
import { normalizeLiveSnapshot } from '../../host-core/remote-live-protocol.js';
import {
  chatTurnsWithoutBotDm,
  chatTurnsWithoutToolOutput,
  formatTurnDuration,
  formatWorkingElapsed,
  isBotDmSendToTool,
  isBotDmTurn,
  latestEntryChannel,
  parseHistoryEntries,
  summarizeToolArgs,
} from '../src/chatTurnModel.ts';

test('projectLiveState projects tool-only assistant entries, empty-text toolResults, and timestamps, and passes normalizeLiveSnapshot', () => {
  const view = {
    entries: [
      {
        id: 1,
        kind: 'pi.user',
        model: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Inspect files' }],
            timestamp: 1_730_000_000_000,
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
              { type: 'thinking', thinking: 'Checking directory' },
              { type: 'toolCall', id: 'call_ls', name: 'ls', arguments: { path: '.' } },
            ],
            timestamp: 1_730_000_000_200,
            durationMs: 1_200,
          },
        ],
      },
      {
        id: 3,
        kind: 'pi.tool_result',
        model: [
          {
            role: 'toolResult',
            toolCallId: 'call_ls',
            toolName: 'ls',
            content: [{ type: 'text', text: '' }],
            isError: false,
            timestamp: 1_730_000_001_600,
            durationMs: 200,
          },
        ],
      },
    ],
    docs: {
      'pi.live': {
        run: { taskId: 10, inputs: [1] },
        tools: [
          {
            callId: 'call_read',
            name: 'read',
            status: 'running',
            output: 'reading...',
          },
        ],
      },
    },
  };

  const state = projectLiveState(view);
  assert.equal(state.busy, true);
  assert.equal(state.history.length, 3);
  assert.equal(state.history[0].messages[0].timestamp, 1_730_000_000_000);
  assert.deepEqual(state.history[1].messages[0].toolCalls, [{ callId: 'call_ls', name: 'ls' }]);
  assert.equal(state.history[1].messages[0].durationMs, 1_200);
  assert.equal(state.history[2].messages[0].role, 'toolResult');
  assert.equal(state.history[2].messages[0].toolCallId, 'call_ls');

  const normalized = normalizeLiveSnapshot(
    {
      type: 'snapshot',
      botId: 'bot_1',
      conversationId: 'conv_1',
      sequence: 1,
      state,
    },
    { kind: 'primary', botId: 'bot_1' },
  );
  assert.equal(normalized.state.history.length, 3);
});

test('parseHistoryEntries shows tool calls immediately on initiation and updates status to done/error upon completion', () => {
  const toolBehavior = ({ id, name, status, outcome, durationMs, output }) =>
    [id, name, status, outcome, durationMs, output];
  const liveHistory = [
    {
      id: 10,
      kind: 'pi.user',
      messages: [
        {
          role: 'user',
          text: 'Run diagnostics',
          truncated: false,
          timestamp: 1_730_000_010_000,
        },
      ],
    },
    {
      id: 11,
      kind: 'pi.assistant',
      messages: [
        {
          role: 'assistant',
          text: '',
          truncated: false,
          timestamp: 1_730_000_010_100,
          durationMs: 900,
          toolCalls: [{ callId: 'call_1', name: 'bash' }],
        },
      ],
    },
  ];

  // Phase 1: Tool call initiated and currently running
  const runningTurns = parseHistoryEntries(liveHistory, 0, {
    isBusy: true,
    liveTools: [{ callId: 'call_1', name: 'bash', status: 'running' }],
  });
  assert.equal(runningTurns.length, 2);
  assert.equal(runningTurns[1].role, 'assistant');
  assert.deepEqual(runningTurns[1].tools.map(toolBehavior), [
    ['call_1', 'bash', 'running', undefined, undefined, undefined],
  ]);
  assert.equal(runningTurns[1].durationMs, undefined);

  // Phase 2: Tool 1 completed (toolResult arrived), Tool 2 initiated in liveTools
  const step2History = [
    ...liveHistory,
    {
      id: 12,
      kind: 'pi.tool_result',
      messages: [
        {
          role: 'toolResult',
          text: 'ok',
          truncated: false,
          toolName: 'bash',
          toolCallId: 'call_1',
          timestamp: 1_730_000_011_500,
          durationMs: 500,
        },
      ],
    },
  ];
  const step2Turns = parseHistoryEntries(step2History, 0, {
    isBusy: true,
    liveTools: [{ callId: 'call_2', name: 'read', status: 'pending' }],
    liveGeneratingText: 'Analyzing output...',
  });
  assert.equal(step2Turns.length, 2);
  assert.deepEqual(step2Turns[1].tools.map(toolBehavior), [
    ['call_1', 'bash', 'done', 'ok', 500, 'ok'],
    ['call_2', 'read', 'running', undefined, undefined, undefined],
  ]);
  assert.equal(step2Turns[1].text, 'Analyzing output...');
  assert.equal(step2Turns[1].isStreaming, true);

  // Phase 3: Turn finishes with final assistant message -> total turn durationMs computed
  const completedHistory = [
    ...step2History,
    {
      id: 13,
      kind: 'pi.assistant',
      messages: [
        {
          role: 'assistant',
          text: '',
          truncated: false,
          timestamp: 1_730_000_011_600,
          durationMs: 600,
          toolCalls: [{ callId: 'call_2', name: 'read' }],
        },
      ],
    },
    {
      id: 14,
      kind: 'pi.tool_result',
      messages: [
        {
          role: 'toolResult',
          text: 'permission denied',
          truncated: false,
          toolName: 'read',
          toolCallId: 'call_2',
          isError: true,
          timestamp: 1_730_000_012_500,
          durationMs: 300,
        },
      ],
    },
    {
      id: 15,
      kind: 'pi.assistant',
      messages: [
        {
          role: 'assistant',
          text: 'Diagnostics complete.',
          truncated: false,
          timestamp: 1_730_000_012_600,
          durationMs: 1_900,
        },
      ],
    },
  ];
  const finalTurns = parseHistoryEntries(completedHistory, 0, { isBusy: false });
  assert.equal(finalTurns.length, 2);
  assert.deepEqual(finalTurns[1].tools.map(toolBehavior), [
    ['call_1', 'bash', 'done', 'ok', 500, 'ok'],
    ['call_2', 'read', 'error', 'error', 300, 'permission denied'],
  ]);
  assert.equal(finalTurns[1].text, 'Diagnostics complete.');
  // Total duration from user timestamp (10_000) to end of last assistant message (12_600 + 1_900 = 14_500) = 4_500ms
  assert.equal(finalTurns[1].durationMs, 4_500);
});

test('tracked desktop text keeps adjacent assistant entry boundaries', () => {
  const entries = [
    {
      id: 10,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'Earlier progress' }] }],
    },
    {
      id: 11,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'Final result' }] }],
    },
  ];

  const merged = parseHistoryEntries(entries);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].blocks, [
    { id: '10-0-b1', kind: 'text', text: 'Earlier progress\nFinal result' },
  ]);

  const tracked = parseHistoryEntries(entries, 0, { trackAssistantTextEntries: true });
  assert.equal(tracked.length, 1);
  assert.deepEqual(tracked[0].blocks, [
    { id: '10-0-b1', kind: 'text', text: 'Earlier progress', entryId: '10' },
    { id: '10-0-b2', kind: 'text', text: 'Final result', entryId: '11' },
  ]);
});

test('formatTurnDuration and formatWorkingElapsed format durations cleanly', () => {
  assert.equal(formatTurnDuration(3_420, (zh) => zh), '耗时 3.4s');
  assert.equal(formatTurnDuration(12_800, (zh) => zh), '耗时 13s');
  assert.equal(formatTurnDuration(65_000, (_zh, en) => en), '1m 05s');
  assert.equal(formatWorkingElapsed(0), '0s');
  assert.equal(formatWorkingElapsed(42), '42s');
  assert.equal(formatWorkingElapsed(125), '2m 05s');
});

test('1v1 DM send_to inbound message, working steps, and outbound send_to render visibly while selfEcho and room turns stay hidden', () => {
  const knownBots = [
    { botId: 'bot_dispatcher', deviceId: 'dev_1', role: '总控助手' },
    { botId: 'bot_worker', deviceId: 'dev_1', role: '数据分析师' },
  ];

  const inboundEnvelope = {
    messageId: 'msg_req_1',
    scopeId: 'scope_dm_1',
    sourceDeviceId: 'dev_1',
    author: { kind: 'bot', botId: 'bot_dispatcher' },
    category: 'request',
    text: '请帮我统计本周活跃用户数并回传结果。',
    createdAt: '2026-06-01T10:00:00.000Z',
  };
  const inboundData = {
    version: 2,
    scopeKind: 'dm',
    localId: 1,
    selfEcho: false,
    message: inboundEnvelope,
    attribution: {
      kind: 'bot',
      botId: 'bot_dispatcher',
      deviceId: 'dev_1',
      channel: 'dm',
      scopeId: 'scope_dm_1',
      messageId: 'msg_req_1',
      category: 'request',
      direction: 'incoming',
      createdAt: '2026-06-01T10:00:00.000Z',
    },
  };

  const dmAssistantAttr = {
    kind: 'bot',
    botId: 'bot_worker',
    deviceId: 'dev_1',
    channel: 'dm',
    scopeId: 'scope_dm_1',
    replyTo: 'msg_req_1',
    direction: 'outgoing',
  };

  const entries = [
    // 1. Raw imported inbound DM scope-message (with EXTERNAL_EVENT_PREFIX wrapper in model[0].content)
    {
      id: 100,
      kind: 'host.scope-message',
      data: inboundData,
      model: [
        {
          role: 'user',
          content: 'External conversation event (actual author in message.author):\n' + JSON.stringify(inboundData),
          timestamp: Date.parse('2026-06-01T10:00:00.000Z'),
        },
      ],
    },
    // 2. Host work-trigger boundary for DM turn
    {
      id: 101,
      kind: 'host.work-trigger',
      data: {
        requestId: 'req_dm_1',
        botId: 'bot_worker',
        scopeId: 'scope_dm_1',
        turn: {
          requestId: 'req_dm_1',
          kind: 'dm',
          scopeId: 'scope_dm_1',
          triggerMessageId: 'msg_req_1',
          responseMessageId: 'msg_req_1',
          replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: 'bot_dispatcher' },
        },
      },
    },
    // 3. Assistant working turn: thinking + 3 adjacent regular tools + send_to + text
    {
      id: 102,
      kind: 'pi.assistant',
      data: { attribution: dmAssistantAttr },
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先读取数据库脚本并查询本周活跃数' },
            { type: 'text', text: '正在执行统计查询…' },
            { type: 'toolCall', id: 'tc_1', name: 'ls', arguments: { path: 'data' } },
            { type: 'toolCall', id: 'tc_2', name: 'read', arguments: { path: 'data/metrics.sql' } },
            { type: 'toolCall', id: 'tc_3', name: 'bash', arguments: { command: 'sqlite3 metrics.db "SELECT count(*) FROM dau"' } },
            {
              type: 'toolCall',
              id: 'tc_send',
              name: 'send_to',
              arguments: {
                scopeId: 'scope_dm_1',
                text: '本周活跃用户数为 12,480 人（环比 +8.2%）。',
              },
            },
          ],
          timestamp: Date.parse('2026-06-01T10:00:02.000Z'),
          durationMs: 1_500,
        },
      ],
    },
    {
      id: 103,
      kind: 'pi.tool_result',
      data: { attribution: dmAssistantAttr },
      model: [
        {
          role: 'toolResult',
          toolCallId: 'tc_send',
          toolName: 'send_to',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                messageId: 'msg_rep_1',
                scopeId: 'scope_dm_1',
                scopeKind: 'dm',
                category: 'reply',
                peerBotId: 'bot_dispatcher',
                status: 'stored',
              }),
            },
          ],
          isError: false,
          timestamp: Date.parse('2026-06-01T10:00:03.800Z'),
          durationMs: 40,
        },
      ],
    },
    // 4. Async selfEcho imported later — must NOT create a duplicate bubble
    {
      id: 104,
      kind: 'host.scope-message',
      data: {
        version: 2,
        scopeKind: 'dm',
        localId: 2,
        selfEcho: true,
        message: {
          messageId: 'msg_rep_1',
          scopeId: 'scope_dm_1',
          sourceDeviceId: 'dev_1',
          author: { kind: 'bot', botId: 'bot_worker' },
          category: 'reply',
          replyTo: 'msg_req_1',
          text: '本周活跃用户数为 12,480 人（环比 +8.2%）。',
          createdAt: '2026-06-01T10:00:03.800Z',
        },
        attribution: {
          kind: 'bot',
          botId: 'bot_worker',
          deviceId: 'dev_1',
          channel: 'dm',
          scopeId: 'scope_dm_1',
          messageId: 'msg_rep_1',
          category: 'reply',
          direction: 'outgoing',
          createdAt: '2026-06-01T10:00:03.800Z',
        },
      },
      model: [{ role: 'user', content: 'External conversation event...' }],
    },
    // 5. Room scope-message + room assistant turn — must stay isolated in Group Chat (hidden from 1v1 chat)
    {
      id: 105,
      kind: 'host.scope-message',
      data: {
        version: 2,
        scopeKind: 'room',
        localId: 3,
        selfEcho: false,
        message: {
          messageId: 'msg_room_1',
          scopeId: 'scope_room_1',
          sourceDeviceId: 'dev_1',
          author: { kind: 'user' },
          category: 'public',
          text: '@数据分析师 群里同步一下',
          createdAt: '2026-06-01T10:01:00.000Z',
        },
      },
      model: [{ role: 'user', content: 'External conversation event...' }],
    },
    {
      id: 106,
      kind: 'host.work-trigger',
      data: {
        requestId: 'req_room_1',
        botId: 'bot_worker',
        scopeId: 'scope_room_1',
        turn: {
          requestId: 'req_room_1',
          kind: 'room',
          scopeId: 'scope_room_1',
          replyTarget: { kind: 'room', scopeId: 'scope_room_1' },
        },
      },
    },
    {
      id: 107,
      kind: 'pi.assistant',
      data: {
        attribution: {
          kind: 'bot',
          botId: 'bot_worker',
          deviceId: 'dev_1',
          channel: 'room',
          scopeId: 'scope_room_1',
          direction: 'outgoing',
        },
      },
      model: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '这段是群聊里的工作文本，不应出现在 1v1 页面' }],
        },
      ],
    },
  ];

  assert.equal(latestEntryChannel(entries.slice(0, 2), 'bot_worker'), 'dm');
  assert.equal(latestEntryChannel(entries, 'bot_worker'), 'room');

  const turns = parseHistoryEntries(entries, 0, {
    selfBotId: 'bot_worker',
    knownBots,
  });

  // Exactly 2 turns in 1v1 chat: [0] inbound peer DM bubble, [1] DM assistant execution turn
  assert.equal(turns.length, 2);

  const peerTurn = turns[0];
  assert.equal(peerTurn.role, 'user');
  // Unwrapped clean text, NOT "External conversation event..."
  assert.equal(peerTurn.text, '请帮我统计本周活跃用户数并回传结果。');
  assert.equal(peerTurn.attribution?.kind, 'bot');
  assert.equal(peerTurn.attribution?.channel, 'dm');
  assert.equal(peerTurn.attribution?.direction, 'incoming');
  assert.equal(peerTurn.attribution?.name, '总控助手');

  const workTurn = turns[1];
  assert.equal(workTurn.role, 'assistant');
  assert.equal(workTurn.collaborative, undefined);
  assert.equal(workTurn.attribution?.channel, 'dm');
  assert.equal(workTurn.attribution?.name, '数据分析师');
  assert.equal(workTurn.thinking, '先读取数据库脚本并查询本周活跃数');
  assert.equal(workTurn.text, '正在执行统计查询…');

  // Blocks: thinking -> text -> 3 grouped regular tools -> standalone 1-item send_to block
  assert.equal(workTurn.blocks?.length, 4);
  assert.equal(workTurn.blocks?.[0].kind, 'thinking');
  assert.equal(workTurn.blocks?.[1].kind, 'text');
  assert.equal(workTurn.blocks?.[2].kind, 'tools');
  assert.deepEqual(
    workTurn.blocks?.[2].tools.map((t) => t.name),
    ['ls', 'read', 'bash'],
  );
  assert.equal(workTurn.blocks?.[3].kind, 'tools');
  assert.equal(workTurn.blocks?.[3].tools.length, 1);

  const sendTool = workTurn.blocks?.[3].tools[0];
  assert.equal(sendTool?.name, 'send_to');
  assert.equal(sendTool?.status, 'done');
  assert.deepEqual(sendTool?.sendTo, {
    text: '本周活跃用户数为 12,480 人（环比 +8.2%）。',
    silentPass: false,
    scopeKind: 'dm',
    category: 'reply',
    targetName: '总控助手',
  });
  assert.ok(sendTool?.argSummary?.startsWith('→ 总控助手:'));
  assert.equal(summarizeToolArgs('send_to', { scopeId: 'scope_dm_1', text: ' (pass) ' }), '(pass)');
});

test('hiding tool output keeps reply order, failures, and only live prompts that need input', () => {
  const user = { id: 'user', role: 'user', entryId: 1, text: 'Check status' };
  const logTool = { id: 'log', name: 'read', status: 'done', output: 'raw output' };
  const onlyTools = { id: 'logs-only', role: 'assistant', entryId: 2, text: '', tools: [logTool] };
  const failure = { ...onlyTools, id: 'failure', entryId: 3, error: 'model_error' };
  const questionnaire = {
    id: 'question', name: 'questionnaire', status: 'running', presentationLive: true,
    presentation: { kind: 'questionnaire', status: 'pending' },
  };
  const vault = {
    id: 'vault', name: 'vault_unlock', status: 'running', presentationLive: true,
    presentation: { kind: 'vault-unlock', status: 'pending' },
  };
  const historicalQuestion = { ...questionnaire, id: 'past-question', presentationLive: false };
  const nestedCall = { id: 'script', name: 'codemode', status: 'running', children: [logTool, vault] };
  const settledCall = { ...nestedCall, id: 'settled-script', status: 'done', children: [questionnaire] };
  const firstText = { id: 'first', kind: 'text', text: 'Checking', entryId: '4' };
  const lastText = { id: 'last', kind: 'text', text: 'Status is good', entryId: '5' };
  const tools = [logTool, questionnaire, nestedCall, historicalQuestion, settledCall];
  const reply = {
    id: 'reply', role: 'assistant', entryId: 5, text: 'Checking\n\nStatus is good',
    thinking: 'internal reasoning', tools, toolSummary: tools.map(tool => tool.name),
    blocks: [
      { id: 'thinking', kind: 'thinking', text: 'internal reasoning' },
      firstText,
      { id: 'calls', kind: 'tools', tools },
      lastText,
    ],
  };

  const visible = chatTurnsWithoutToolOutput([user, onlyTools, failure, reply]);
  assert.deepEqual(visible.map(turn => turn.id), ['user', 'failure', 'reply']);
  assert.equal(visible[0], user);
  assert.equal(visible[1].error, 'model_error');
  assert.equal(visible[1].tools, undefined);
  assert.equal(visible[2].thinking, undefined);
  assert.equal(visible[2].toolSummary, undefined);
  assert.deepEqual(visible[2].blocks, [firstText, { id: 'calls', kind: 'tools', tools: [questionnaire, vault] }, lastText]);
  assert.deepEqual(visible[2].tools, [questionnaire, vault]);
  assert.equal(reply.blocks[2].tools, tools);
  assert.equal(logTool.output, 'raw output');
});

test('hiding tool output keeps a finished tool\'s authoritative pending questionnaire until revoked', () => {
  const tool = {
    id: 'question', name: 'ask_user_question', status: 'done',
    durableWait: true, presentationLive: true,
    presentation: { kind: 'questionnaire', version: 1, installationId: 'ask',
      conversationId: 11, requestId: '42', status: 'pending' },
  };
  const turn = { id: 'reply', role: 'assistant', entryId: 5, text: '', tools: [tool] };
  assert.deepEqual(chatTurnsWithoutToolOutput([turn])[0].tools, [tool]);
  assert.deepEqual(chatTurnsWithoutToolOutput([{ ...turn, tools: [{ ...tool, durableWait: false }] }]), []);
});

test('hiding tool output keeps a running Google setup after its tool call has finished', () => {
  const setup = {
    id: 'setup', name: 'google_setup', status: 'done',
    presentation: { kind: 'google-setup', version: 1, botId: 'bot', runId: 'run', state: 'running', card: 'path' },
  };
  const finished = {
    ...setup, id: 'finished', presentation: { ...setup.presentation, state: 'done', card: 'connected' },
  };
  const nestedSetup = { ...setup, id: 'nested-setup', parentCallId: 'script' };
  const nestedPrompt = {
    id: 'vault', name: 'vault_unlock', status: 'running', presentationLive: true, parentCallId: 'script',
    presentation: { kind: 'vault-unlock', status: 'pending' },
  };
  const script = { id: 'script', name: 'codemode', status: 'done', children: [nestedPrompt, nestedSetup] };
  const tools = [setup, finished, script];
  const turn = { id: 'reply', role: 'assistant', entryId: 5, text: '', tools };
  const calls = { id: 'calls', kind: 'tools', tools };

  assert.deepEqual(chatTurnsWithoutToolOutput([turn])[0]?.tools, [setup, nestedSetup]);
  const [visible] = chatTurnsWithoutToolOutput([{ ...turn, blocks: [calls] }]);
  assert.deepEqual(visible?.blocks, [{ ...calls, tools: [setup, nestedSetup] }]);
});

test('projectLiveState preserves pi.reset marker across empty, windowed, compacted, and pre-reset failure states', () => {
  const mkUser = (id, text) => ({
    id,
    kind: 'pi.user',
    model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: 1_730_000_000_000 + id }],
  });

  // 1) Empty post-reset view + pre-reset runFailure filtered by reset boundary
  const emptyAfterClear = projectLiveState(
    {
      entries: [mkUser(1, 'old prompt'), { id: 2, kind: 'pi.reset' }],
      docs: {
        'pi.live': {
          runFailure: { taskId: 10, inputs: [1], reason: 'model_error', first: 1 },
        },
      },
    },
    { clearedThroughEntryId: 2 },
  );
  assert.deepEqual(emptyAfterClear.history, [{ id: 2, kind: 'pi.reset', messages: [] }]);
  assert.equal(emptyAfterClear.lastEntryId, 2);
  assert.equal(emptyAfterClear.activity.phase, 'idle');

  // 2) Window trimming (> 50 entries) + compaction hiding pi.reset from view.entries still retains reset marker
  const postResetEntries = Array.from({ length: 55 }, (_, idx) => mkUser(10 + idx, `msg-${idx}`));
  const windowedAfterCompaction = projectLiveState(
    {
      entries: [{ id: 9, kind: 'pi.compaction' }, ...postResetEntries],
      docs: {
        'pi.live': {
          runFailure: { taskId: 11, inputs: [2], reason: 'model_error', first: 10 },
        },
      },
    },
    { clearedThroughEntryId: 5 },
  );
  assert.equal(windowedAfterCompaction.historyTruncated, true);
  assert.deepEqual(windowedAfterCompaction.history[0], { id: 5, kind: 'pi.reset', messages: [] });
  assert.equal(windowedAfterCompaction.history.length, 51);
  assert.equal(windowedAfterCompaction.lastEntryId, 64);
  assert.equal(windowedAfterCompaction.activity.phase, 'failed');

  // Compatible with normalizeLiveSnapshot and yields zero rendered turns in parseHistoryEntries
  const normalized = normalizeLiveSnapshot(
    {
      type: 'snapshot',
      botId: 'bot_1',
      conversationId: 'conv_1',
      sequence: 1,
      state: windowedAfterCompaction,
    },
    { kind: 'primary', botId: 'bot_1' },
  );
  assert.deepEqual(normalized.state.history[0], { id: 5, kind: 'pi.reset', messages: [] });
  assert.equal(parseHistoryEntries(emptyAfterClear.history, 0).length, 0);
});

test('C7 block IDs stay stable when earlier empty/whitespace blocks transition between empty and non-empty', () => {
  // Persisted assistant content: whitespace-only leading text and thinking blocks still advance
  // their per-kind counters so trailing blocks keep identical IDs once populated.
  const withEmptyLeading = [
    {
      id: 20,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '   ' },
            { type: 'text', text: '   ' },
            { type: 'toolCall', id: 'tc_read', name: 'read', arguments: { path: 'index.ts' } },
            { type: 'thinking', thinking: 'Second thought' },
            { type: 'text', text: 'Final summary' },
          ],
        },
      ],
    },
  ];
  const withPopulatedLeading = [
    {
      id: 20,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'First thought' },
            { type: 'text', text: 'Opening note' },
            { type: 'toolCall', id: 'tc_read', name: 'read', arguments: { path: 'index.ts' } },
            { type: 'thinking', thinking: 'Second thought' },
            { type: 'text', text: 'Final summary' },
          ],
        },
      ],
    },
  ];

  const turnsEmpty = parseHistoryEntries(withEmptyLeading);
  const turnsPopulated = parseHistoryEntries(withPopulatedLeading);
  assert.equal(turnsEmpty.length, 1);
  assert.equal(turnsPopulated.length, 1);

  assert.deepEqual(
    turnsEmpty[0].blocks?.map((b) => [b.kind, b.id]),
    [
      ['tools', '20-0-tools-tc_read'],
      ['thinking', '20-0-thinking-2'],
      ['text', '20-0-b2'],
    ],
  );
  assert.deepEqual(
    turnsPopulated[0].blocks?.map((b) => [b.kind, b.id]),
    [
      ['thinking', '20-0-thinking-1'],
      ['text', '20-0-b1'],
      ['tools', '20-0-tools-tc_read'],
      ['thinking', '20-0-thinking-2'],
      ['text', '20-0-b2'],
    ],
  );

  // Streaming liveGeneratingBlocks transitioning a leading whitespace chunk to real text
  // preserves the trailing text and tool block IDs.
  const streamWhitespace = parseHistoryEntries([], 0, {
    isBusy: true,
    liveGeneratingBlocks: [
      { type: 'text', text: '  \n' },
      { type: 'toolCall', callId: 'tc_stream', name: 'ls' },
      { type: 'text', text: 'Streaming tail' },
    ],
    liveTools: [{ callId: 'tc_stream', name: 'ls', status: 'running' }],
  });
  const streamFilled = parseHistoryEntries([], 0, {
    isBusy: true,
    liveGeneratingBlocks: [
      { type: 'text', text: 'Streaming lead' },
      { type: 'toolCall', callId: 'tc_stream', name: 'ls' },
      { type: 'text', text: 'Streaming tail' },
    ],
    liveTools: [{ callId: 'tc_stream', name: 'ls', status: 'running' }],
  });

  assert.deepEqual(
    streamWhitespace[0].blocks?.map((b) => [b.kind, b.id]),
    [
      ['tools', 'live-assistant-tools-tc_stream'],
      ['text', 'live-assistant-b2'],
    ],
  );
  assert.deepEqual(
    streamFilled[0].blocks?.map((b) => [b.kind, b.id]),
    [
      ['text', 'live-assistant-b1'],
      ['tools', 'live-assistant-tools-tc_stream'],
      ['text', 'live-assistant-b2'],
    ],
  );
});

test('C7 inserting raw-history thinking blocks does not shift text or tool block IDs', () => {
  // Live-projected history entry without thinking blocks.
  const projectedWithoutThinking = [
    {
      id: 40,
      kind: 'pi.assistant',
      messages: [
        {
          role: 'assistant',
          text: 'Step 1\nStep 2',
          blocks: [
            { type: 'text', text: 'Step 1' },
            { type: 'toolCall', callId: 'tc_check', name: 'read' },
            { type: 'text', text: 'Step 2' },
          ],
        },
      ],
    },
  ];
  // Raw history overlay for the same entry with thinking blocks interleaved before and between text.
  const rawWithThinking = [
    {
      id: 40,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Planning step 1' },
            { type: 'text', text: 'Step 1' },
            { type: 'toolCall', id: 'tc_check', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'thinking', thinking: 'Reviewing tool output' },
            { type: 'text', text: 'Step 2' },
          ],
        },
      ],
    },
  ];

  const beforeTurns = parseHistoryEntries(projectedWithoutThinking);
  const afterTurns = parseHistoryEntries(rawWithThinking);
  assert.equal(beforeTurns.length, 1);
  assert.equal(afterTurns.length, 1);

  assert.deepEqual(
    beforeTurns[0].blocks?.map((b) => [b.kind, b.id]),
    [
      ['text', '40-0-b1'],
      ['tools', '40-0-tools-tc_check'],
      ['text', '40-0-b2'],
    ],
  );
  assert.deepEqual(
    afterTurns[0].blocks?.map((b) => [b.kind, b.id]),
    [
      ['thinking', '40-0-thinking-1'],
      ['text', '40-0-b1'],
      ['tools', '40-0-tools-tc_check'],
      ['thinking', '40-0-thinking-2'],
      ['text', '40-0-b2'],
    ],
  );
});

test('C7 tool call block ID stays anchored on first tool ID across 1 -> 2 -> 3 tool additions', () => {
  // 1) Live streaming growth across 1 -> 2 -> 3 consecutive tools in a single group.
  const stream1 = parseHistoryEntries([], 0, {
    isBusy: true,
    liveGeneratingBlocks: [{ type: 'toolCall', callId: 'call_first', name: 'ls' }],
    liveTools: [{ callId: 'call_first', name: 'ls', status: 'running' }],
  });
  const stream2 = parseHistoryEntries([], 0, {
    isBusy: true,
    liveGeneratingBlocks: [
      { type: 'toolCall', callId: 'call_first', name: 'ls' },
      { type: 'toolCall', callId: 'call_second', name: 'read' },
    ],
    liveTools: [
      { callId: 'call_first', name: 'ls', status: 'done' },
      { callId: 'call_second', name: 'read', status: 'running' },
    ],
  });
  const stream3 = parseHistoryEntries([], 0, {
    isBusy: true,
    liveGeneratingBlocks: [
      { type: 'toolCall', callId: 'call_first', name: 'ls' },
      { type: 'toolCall', callId: 'call_second', name: 'read' },
      { type: 'toolCall', callId: 'call_third', name: 'grep' },
    ],
    liveTools: [
      { callId: 'call_first', name: 'ls', status: 'done' },
      { callId: 'call_second', name: 'read', status: 'done' },
      { callId: 'call_third', name: 'grep', status: 'running' },
    ],
  });

  for (const [turns, expectedCount] of [
    [stream1, 1],
    [stream2, 2],
    [stream3, 3],
  ]) {
    assert.equal(turns.length, 1);
    assert.equal(turns[0].blocks?.length, 1);
    assert.equal(turns[0].blocks?.[0].kind, 'tools');
    assert.equal(turns[0].blocks?.[0].id, 'live-assistant-tools-call_first');
    assert.equal(turns[0].blocks?.[0].tools.length, expectedCount);
  }

  // 2) Persisted entry growing from 1 -> 2 -> 3 tools via live overlay and final settled history.
  const baseEntry = {
    id: 50,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_anchor', name: 'ls', arguments: { path: '.' } }],
      },
    ],
  };

  const persisted1 = parseHistoryEntries([baseEntry], 0, {
    isBusy: true,
    liveTools: [{ callId: 'tc_anchor', name: 'ls', status: 'running' }],
  });
  const persisted2 = parseHistoryEntries([baseEntry], 0, {
    isBusy: true,
    liveTools: [
      { callId: 'tc_anchor', name: 'ls', status: 'done' },
      { callId: 'tc_two', name: 'read', status: 'running' },
    ],
  });
  const persisted3Live = parseHistoryEntries([baseEntry], 0, {
    isBusy: true,
    liveTools: [
      { callId: 'tc_anchor', name: 'ls', status: 'done' },
      { callId: 'tc_two', name: 'read', status: 'done' },
      { callId: 'tc_three', name: 'grep', status: 'running' },
    ],
  });
  const persisted3Settled = parseHistoryEntries([
    {
      id: 50,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc_anchor', name: 'ls', arguments: { path: '.' } },
            { type: 'toolCall', id: 'tc_two', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'tc_three', name: 'grep', arguments: { pattern: 'foo' } },
          ],
        },
      ],
    },
  ]);

  for (const [turns, expectedCount] of [
    [persisted1, 1],
    [persisted2, 2],
    [persisted3Live, 3],
    [persisted3Settled, 3],
  ]) {
    assert.equal(turns.length, 1);
    assert.equal(turns[0].blocks?.length, 1);
    assert.equal(turns[0].blocks?.[0].kind, 'tools');
    assert.equal(turns[0].blocks?.[0].id, '50-0-tools-tc_anchor');
    assert.equal(turns[0].blocks?.[0].tools.length, expectedCount);
  }
});

test('chatTurnsWithoutBotDm hides incoming DM turns, DM assistant turns, and outbound DM send_to while preserving primary replies and room send_to', () => {
  const knownBots = [
    { botId: 'bot_a', deviceId: 'dev_1', role: '总控助手' },
    { botId: 'bot_b', deviceId: 'dev_1', role: '研究助手' },
  ];

  const entries = [
    // 1. Primary user turn
    {
      id: 1,
      kind: 'pi.user',
      model: [{ role: 'user', content: [{ type: 'text', text: '让研究助手查一下 Q2 营收' }] }],
    },
    // 2. Primary assistant turn calling ensure_dm + send_to (DM, still running/no toolResult yet) + reply to user
    {
      id: 2,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc_ensure', name: 'ensure_dm', arguments: { deviceId: 'dev_1', botId: 'bot_b' } },
          ],
        },
      ],
    },
    {
      id: 3,
      kind: 'pi.tool_result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'tc_ensure',
          toolName: 'ensure_dm',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                scopeId: 'scope_dm_ab',
                kind: 'dm',
                members: [
                  { deviceId: 'dev_1', botId: 'bot_a' },
                  { deviceId: 'dev_1', botId: 'bot_b' },
                ],
              }),
            },
          ],
          isError: false,
        },
      ],
    },
    {
      id: 4,
      kind: 'pi.assistant',
      model: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc_send_dm',
              name: 'send_to',
              arguments: { scopeId: 'scope_dm_ab', text: '请帮我核实 Q2 营收数据' },
            },
            {
              type: 'toolCall',
              id: 'tc_send_room',
              name: 'send_to',
              arguments: { scopeId: 'scope_room_1', text: '已在群里同步进度' },
            },
            { type: 'text', text: '已派发给研究助手核实，请稍候。' },
          ],
        },
      ],
    },
    {
      id: 5,
      kind: 'pi.tool_result',
      model: [
        {
          role: 'toolResult',
          toolCallId: 'tc_send_room',
          toolName: 'send_to',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                scopeId: 'scope_room_1',
                scopeKind: 'room',
                category: 'public',
                targetName: '研发群',
                status: 'stored',
              }),
            },
          ],
          isError: false,
        },
      ],
    },
    // 3. Inbound DM from Bot B
    {
      id: 6,
      kind: 'host.scope-message',
      data: {
        version: 2,
        scopeKind: 'dm',
        selfEcho: false,
        message: {
          messageId: 'msg_from_b',
          scopeId: 'scope_dm_ab',
          sourceDeviceId: 'dev_1',
          author: { kind: 'bot', botId: 'bot_b' },
          category: 'reply',
          text: 'Q2 营收为 380 万。',
          createdAt: '2026-06-01T10:02:00.000Z',
        },
      },
      model: [{ role: 'user', content: 'External conversation event...' }],
    },
    // 4. DM-triggered assistant turn (even without data.attribution!)
    {
      id: 7,
      kind: 'host.work-trigger',
      data: {
        requestId: 'req_dm_reply',
        botId: 'bot_a',
        scopeId: 'scope_dm_ab',
        turn: {
          requestId: 'req_dm_reply',
          kind: 'dm',
          scopeId: 'scope_dm_ab',
          replyTarget: { kind: 'dm', scopeId: 'scope_dm_ab', botId: 'bot_b' },
        },
      },
    },
    {
      id: 8,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '收到，感谢研究助手！' }] }],
    },
    // 5. Resumed primary turn answering the human user
    {
      id: 9,
      kind: 'host.work-trigger',
      data: {
        requestId: 'req_primary_resume',
        botId: 'bot_a',
        scopeId: 'primary',
        turn: {
          requestId: 'req_primary_resume',
          kind: 'primary',
          replyTarget: { kind: 'primary' },
        },
      },
    },
    {
      id: 10,
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: '研究助手已核实：Q2 营收为 380 万。' }] }],
    },
  ];

  const allTurns = parseHistoryEntries(entries, 0, {
    selfBotId: 'bot_a',
    knownBots,
  });

  // All 5 turns exist before DM filtering
  assert.equal(allTurns.length, 5);
  const dispatchTurn = allTurns[1];
  const dmSendTool = dispatchTurn.tools?.find((tool) => tool.id === 'tc_send_dm');
  const roomSendTool = dispatchTurn.tools?.find((tool) => tool.id === 'tc_send_room');
  assert.ok(dmSendTool);
  assert.ok(roomSendTool);
  // ensure_dm result taught parser that scope_dm_ab is a DM with 研究助手 even before send_to toolResult
  assert.equal(dmSendTool.sendTo?.scopeKind, 'dm');
  assert.equal(dmSendTool.sendTo?.targetName, '研究助手');
  assert.equal(isBotDmSendToTool(dmSendTool, dispatchTurn), true);
  assert.equal(isBotDmSendToTool(roomSendTool, dispatchTurn), false);
  assert.equal(isBotDmTurn(allTurns[2]), true);
  assert.equal(isBotDmTurn(allTurns[3]), true);
  assert.equal(isBotDmTurn(allTurns[4]), false);

  // When hideBotDm = true: inbound DM, DM assistant turn, and outbound DM send_to are removed;
  // primary user turn, primary assistant reply, room send_to, and resumed primary answer stay intact.
  const withoutDm = chatTurnsWithoutBotDm(allTurns);
  assert.equal(withoutDm.length, 3);
  assert.equal(withoutDm[0].text, '让研究助手查一下 Q2 营收');
  assert.equal(withoutDm[1].text, '已派发给研究助手核实，请稍候。');
  assert.deepEqual(
    withoutDm[1].tools?.map((tool) => tool.id),
    ['tc_ensure', 'tc_send_room'],
  );
  assert.equal(withoutDm[2].text, '研究助手已核实：Q2 营收为 380 万。');

  // Primary assistant turn containing ONLY an outbound DM send_to is dropped cleanly when hideBotDm = true
  const dmOnlyPrimaryTurn = {
    id: 'dm-only-primary',
    role: 'assistant',
    entryId: 20,
    text: '',
    tools: [dmSendTool],
    blocks: [{ id: 'b-dm', kind: 'tools', tools: [dmSendTool] }],
  };
  assert.deepEqual(chatTurnsWithoutBotDm([dmOnlyPrimaryTurn]), []);

  // When hideToolOutput = true AND hideBotDm = false (preserveBotDmSendTo: true):
  // regular tools and room send_to are hidden, while outbound DM send_to stays visible alongside primary text.
  const hiddenToolsKeepDm = chatTurnsWithoutToolOutput(allTurns, { preserveBotDmSendTo: true });
  const dispatchAfterHideTools = hiddenToolsKeepDm.find((turn) => turn.id === dispatchTurn.id);
  assert.ok(dispatchAfterHideTools);
  assert.equal(dispatchAfterHideTools.text, '已派发给研究助手核实，请稍候。');
  assert.deepEqual(
    dispatchAfterHideTools.tools?.map((tool) => tool.id),
    ['tc_send_dm'],
  );
  assert.equal(
    chatTurnsWithoutToolOutput([dmOnlyPrimaryTurn], { preserveBotDmSendTo: true }).length,
    1,
  );
  // Default chatTurnsWithoutToolOutput (preserveBotDmSendTo omitted/false) preserves existing behavior.
  assert.deepEqual(chatTurnsWithoutToolOutput([dmOnlyPrimaryTurn]), []);
});
