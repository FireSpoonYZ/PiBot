import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLiveState } from '../../host-core/runtime-live-projection.js';
import { normalizeLiveSnapshot } from '../../host-core/remote-live-protocol.js';
import {
  formatTurnDuration,
  formatWorkingElapsed,
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
