import assert from 'node:assert/strict';
import test from 'node:test';
import { projectLiveState } from '../../host-core/runtime-live-projection.js';
import { normalizeLiveSnapshot } from '../../host-core/remote-live-protocol.js';
import {
  formatTurnDuration,
  formatWorkingElapsed,
  parseHistoryEntries,
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
