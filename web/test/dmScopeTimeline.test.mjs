import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDmScopeTimeline,
  extractMemberDmExecutionTurns,
  mergeDmLedgerAndExecutions,
  resolveMemberLiveForDmScope,
  stripRedundantDmSendTo,
} from '../src/dmScopeTimeline.ts';

const BOT_A = { deviceId: 'dev_a', botId: 'bot_a' };
const BOT_B = { deviceId: 'dev_b', botId: 'bot_b' };
const KNOWN_BOTS = [
  { botId: 'bot_a', deviceId: 'dev_a', role: 'Dispatcher' },
  { botId: 'bot_b', deviceId: 'dev_b', role: 'Analyst' },
  { botId: 'bot_c', deviceId: 'dev_c', role: 'Reviewer' },
];

function makeStoredMessage({
  localId,
  messageId,
  scopeId = 'scope_dm_1',
  sourceDeviceId = BOT_A.deviceId,
  botId = BOT_A.botId,
  category = 'request',
  text,
  replyTo = null,
  rootId,
  createdAt = '2026-06-01T10:00:00.000Z',
  storedAt,
}) {
  return {
    localId,
    digest: `digest_${messageId}`,
    storedAt: storedAt ?? createdAt,
    missingRefs: [],
    message: {
      protocolVersion: 1,
      messageId,
      sourceDeviceId,
      streamId: `stream_${sourceDeviceId}`,
      sequence: localId,
      scopeId,
      revision: 1,
      author: { kind: 'bot', botId },
      category,
      rootId: rootId ?? messageId,
      replyTo,
      text,
      targets: [BOT_A, BOT_B],
      createdAt,
    },
  };
}

function makeWorkTrigger(id, {
  requestId = `req_${id}`,
  botId = BOT_B.botId,
  dataScopeId = 'scope_dm_1',
  turnKind = 'dm',
  turnScopeId = 'scope_dm_1',
  replyTarget = { kind: 'dm', scopeId: 'scope_dm_1', botId: BOT_A.botId },
  triggerMessageId,
  responseMessageId,
}) {
  return {
    id,
    kind: 'host.work-trigger',
    data: {
      requestId,
      botId,
      scopeId: dataScopeId,
      turn: {
        requestId,
        kind: turnKind,
        scopeId: turnScopeId,
        ...(triggerMessageId ? { triggerMessageId } : {}),
        ...(responseMessageId ? { responseMessageId } : {}),
        replyTarget,
      },
    },
  };
}

function makeDmAttr({
  botId = BOT_B.botId,
  deviceId = BOT_B.deviceId,
  scopeId = 'scope_dm_1',
  replyTo,
}) {
  return {
    kind: 'bot',
    botId,
    deviceId,
    channel: 'dm',
    scopeId,
    direction: 'outgoing',
    ...(replyTo ? { replyTo } : {}),
  };
}

function makeLiveState(overrides = {}) {
  return {
    history: [],
    historyTruncated: false,
    lastEntryId: null,
    generation: null,
    tools: [],
    toolsTruncated: false,
    busy: false,
    queuedCount: 0,
    ...overrides,
  };
}

test('strict isolation: excludes primary chat, primary outbound send_to, room chat, primary-resumed replies, incoming scope-messages, and other DM scopes', () => {
  const entries = [
    // 1. Primary user chat + primary assistant turn calling outbound send_to into scope_dm_1
    {
      id: 1,
      kind: 'host.user-message',
      data: {
        userText: 'Ask Analyst for Q2 revenue',
        attribution: { kind: 'user', channel: 'primary' },
      },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Ask Analyst for Q2 revenue' }], timestamp: Date.parse('2026-06-01T09:59:00.000Z') }],
    },
    {
      id: 2,
      kind: 'pi.assistant',
      data: { attribution: { kind: 'bot', botId: BOT_A.botId, deviceId: BOT_A.deviceId, channel: 'primary', direction: 'outgoing' } },
      model: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Secret primary reasoning' },
          { type: 'text', text: 'Dispatching to Analyst from primary chat.' },
          { type: 'toolCall', id: 'tc_primary_send', name: 'send_to', arguments: { scopeId: 'scope_dm_1', text: 'Please check Q2 revenue.' } },
        ],
        timestamp: Date.parse('2026-06-01T09:59:05.000Z'),
      }],
    },
    // 2. Room chat execution
    makeWorkTrigger(3, {
      botId: BOT_A.botId,
      dataScopeId: 'scope_room_1',
      turnKind: 'room',
      turnScopeId: 'scope_room_1',
      replyTarget: { kind: 'room', scopeId: 'scope_room_1' },
      triggerMessageId: 'msg_room_1',
    }),
    {
      id: 4,
      kind: 'pi.assistant',
      data: { attribution: { kind: 'bot', botId: BOT_A.botId, deviceId: BOT_A.deviceId, channel: 'room', scopeId: 'scope_room_1', direction: 'outgoing' } },
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'Room working message' }] }],
    },
    // 3. Another DM scope (scope_dm_other)
    makeWorkTrigger(5, {
      botId: BOT_A.botId,
      dataScopeId: 'scope_dm_other',
      turnKind: 'dm',
      turnScopeId: 'scope_dm_other',
      replyTarget: { kind: 'dm', scopeId: 'scope_dm_other', botId: 'bot_c' },
      triggerMessageId: 'msg_other_1',
    }),
    {
      id: 6,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ botId: BOT_A.botId, deviceId: BOT_A.deviceId, scopeId: 'scope_dm_other', replyTo: 'msg_other_1' }) },
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'Other DM secret trace' }] }],
    },
    // 4. Incoming host.scope-message in scope_dm_1 (already in scopeHistory ledger)
    {
      id: 7,
      kind: 'host.scope-message',
      data: {
        version: 2,
        scopeKind: 'dm',
        selfEcho: false,
        message: {
          messageId: 'msg_from_b',
          scopeId: 'scope_dm_1',
          sourceDeviceId: BOT_B.deviceId,
          author: { kind: 'bot', botId: BOT_B.botId },
          category: 'reply',
          text: 'Q2 revenue is 3.8M.',
          createdAt: '2026-06-01T10:01:00.000Z',
        },
      },
      model: [{ role: 'user', content: 'External conversation event...' }],
    },
    // 5. Primary-resumed reply triggered by Bot B's DM reply (data.scopeId is scope_dm_1, replyTarget is primary!)
    makeWorkTrigger(8, {
      botId: BOT_A.botId,
      dataScopeId: 'scope_dm_1',
      turnKind: 'primary',
      turnScopeId: null,
      replyTarget: { kind: 'primary' },
      triggerMessageId: 'msg_from_b',
    }),
    {
      id: 9,
      kind: 'pi.assistant',
      // Intentionally omit data.attribution to verify host.work-trigger replyTarget.kind === 'primary' blocks leakage too.
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'User-facing resumed primary answer: Q2 is 3.8M.' }] }],
    },
    // 6. Genuine DM execution turn targeting scope_dm_1
    makeWorkTrigger(10, {
      botId: BOT_A.botId,
      dataScopeId: 'scope_dm_1',
      turnKind: 'dm',
      turnScopeId: 'scope_dm_1',
      replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: BOT_B.botId },
      triggerMessageId: 'msg_req_from_b',
    }),
    {
      id: 11,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ botId: BOT_A.botId, deviceId: BOT_A.deviceId, scopeId: 'scope_dm_1', replyTo: 'msg_req_from_b' }) },
      model: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Checking scope_dm_1 follow-up' },
          { type: 'text', text: 'Validating Analyst numbers.' },
        ],
        timestamp: Date.parse('2026-06-01T10:02:00.000Z'),
      }],
    },
  ];

  const turns = extractMemberDmExecutionTurns(
    { member: BOT_A, rawEntries: entries, live: null },
    'scope_dm_1',
    { knownBots: KNOWN_BOTS },
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Validating Analyst numbers.');
  assert.equal(turns[0].thinking, 'Checking scope_dm_1 follow-up');
  assert.equal(turns[0].attribution?.channel, 'dm');
  assert.equal(turns[0].attribution?.scopeId, 'scope_dm_1');
});

test('3-tier leak-proof live gating prevents primary, room, and other-DM live streams/tools from attaching to DM turns', () => {
  const baseDmEntries = [
    makeWorkTrigger(10, {
      botId: BOT_B.botId,
      dataScopeId: 'scope_dm_1',
      turnKind: 'dm',
      turnScopeId: 'scope_dm_1',
      replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: BOT_A.botId },
      triggerMessageId: 'msg_1',
    }),
    {
      id: 11,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_1' }) },
      model: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier DM progress' }],
        timestamp: Date.parse('2026-06-01T10:00:05.000Z'),
      }],
    },
  ];

  // Tier 1 mismatch: generation.attribution says primary -> strictly false even if activity/boundary say scope_dm_1
  const tier1Mismatch = resolveMemberLiveForDmScope(
    {
      member: BOT_B,
      rawEntries: baseDmEntries,
      live: makeLiveState({
        busy: true,
        generation: {
          text: 'Private primary draft',
          truncated: false,
          attribution: { kind: 'bot', botId: BOT_B.botId, channel: 'primary', direction: 'outgoing' },
        },
        tools: [{ callId: 'tc_priv', name: 'bash', status: 'running', output: '', truncated: false, droppedBytes: 0, droppedLines: 0 }],
        activity: { phase: 'running', source: 'dm', scopeId: 'scope_dm_1', requestId: 'r1', startedAt: '2026-06-01T10:01:00.000Z' },
      }),
    },
    'scope_dm_1',
  );
  assert.equal(tier1Mismatch.matched, false);
  assert.equal(tier1Mismatch.isBusy, false);
  assert.equal(tier1Mismatch.isStreaming, false);
  assert.equal(tier1Mismatch.activeToolName, null);
  assert.equal(tier1Mismatch.liveTools, undefined);
  assert.equal(tier1Mismatch.liveGeneratingText, '');
  assert.equal(tier1Mismatch.activity.phase, 'idle');

  // Verify live tools from primary do NOT attach onto earlier DM turn in extractMemberDmExecutionTurns
  const turnsAfterPrimaryLive = extractMemberDmExecutionTurns(
    {
      member: BOT_B,
      rawEntries: baseDmEntries,
      live: makeLiveState({
        busy: true,
        generation: {
          text: 'Private primary draft',
          truncated: false,
          attribution: { kind: 'bot', botId: BOT_B.botId, channel: 'primary', direction: 'outgoing' },
        },
        tools: [{ callId: 'tc_priv', name: 'bash', status: 'running', output: '', truncated: false, droppedBytes: 0, droppedLines: 0 }],
      }),
    },
    'scope_dm_1',
  );
  assert.equal(turnsAfterPrimaryLive.length, 1);
  assert.equal(turnsAfterPrimaryLive[0].text, 'Earlier DM progress');
  assert.equal(turnsAfterPrimaryLive[0].tools, undefined);
  assert.equal(turnsAfterPrimaryLive[0].isStreaming, undefined);

  // Tier 2 mismatch: no generation.attribution, activity.source === 'dm' for OTHER scope
  const tier2OtherDm = resolveMemberLiveForDmScope(
    {
      member: BOT_B,
      rawEntries: baseDmEntries,
      live: makeLiveState({
        busy: true,
        tools: [{ callId: 'tc_other', name: 'grep', status: 'running', output: '', truncated: false, droppedBytes: 0, droppedLines: 0 }],
        activity: { phase: 'running', source: 'dm', scopeId: 'scope_dm_2', requestId: 'r2', startedAt: '2026-06-01T10:01:00.000Z' },
      }),
    },
    'scope_dm_1',
  );
  assert.equal(tier2OtherDm.matched, false);
  assert.equal(tier2OtherDm.isBusy, false);
  assert.equal(tier2OtherDm.activeToolName, null);

  // Tier 2 match: preparing phase for THIS DM (busy: false, activity busy)
  const tier2Preparing = resolveMemberLiveForDmScope(
    {
      member: BOT_B,
      rawEntries: [],
      live: makeLiveState({
        busy: false,
        activity: { phase: 'preparing', source: 'dm', scopeId: 'scope_dm_1', requestId: 'r3', startedAt: '2026-06-01T10:02:00.000Z' },
      }),
    },
    'scope_dm_1',
  );
  assert.equal(tier2Preparing.matched, true);
  assert.equal(tier2Preparing.isBusy, true);
  assert.equal(tier2Preparing.activity.phase, 'preparing');
  assert.equal(tier2Preparing.startedAt, Date.parse('2026-06-01T10:02:00.000Z'));

  // Tier 3 legacy Host fallback: no generation.attribution and no activity.source; latest boundary is scope_dm_1
  // An incoming host.scope-message from another scope must NOT overwrite latestBoundary.
  const legacyEntriesWithScopeNoise = [
    ...baseDmEntries,
    {
      id: 12,
      kind: 'host.scope-message',
      data: {
        scopeKind: 'room',
        message: { messageId: 'm_r', scopeId: 'scope_room_1', author: { kind: 'user' }, text: 'hi room' },
      },
    },
    { id: 13, kind: 'pi.compaction' },
  ];
  const tier3LegacyMatch = resolveMemberLiveForDmScope(
    {
      member: BOT_B,
      rawEntries: legacyEntriesWithScopeNoise,
      live: makeLiveState({
        busy: true,
        generation: { text: 'Streaming legacy DM...', truncated: false },
        tools: [{ callId: 'tc_leg', name: 'read', status: 'running', output: '', truncated: false, droppedBytes: 0, droppedLines: 0 }],
      }),
    },
    'scope_dm_1',
  );
  assert.equal(tier3LegacyMatch.matched, true);
  assert.equal(tier3LegacyMatch.isBusy, true);
  assert.equal(tier3LegacyMatch.isStreaming, true);
  assert.equal(tier3LegacyMatch.activeToolName, 'read');
  assert.equal(tier3LegacyMatch.liveAttribution?.scopeId, 'scope_dm_1');

  // Tier 3 legacy Host: host.user-message resets latestBoundary back to primary -> must NOT match DM!
  const tier3ResetToPrimary = resolveMemberLiveForDmScope(
    {
      member: BOT_B,
      rawEntries: [
        ...baseDmEntries,
        { id: 14, kind: 'host.user-message', data: { userText: 'Hello bot' }, model: [{ role: 'user', content: 'Hello bot' }] },
      ],
      live: makeLiveState({
        busy: true,
        generation: { text: 'Replying to human...', truncated: false },
      }),
    },
    'scope_dm_1',
  );
  assert.equal(tier3ResetToPrimary.matched, false);
  assert.equal(tier3ResetToPrimary.isBusy, false);
});

test('read-only DM contract passes durableWaits: undefined so questionnaires stay non-interactive', () => {
  const questionnairePresentation = {
    kind: 'questionnaire',
    version: 1,
    installationId: 'ask',
    conversationId: 7,
    requestId: '99',
    status: 'pending',
    questions: [{ question: 'Proceed?', header: 'Confirm', options: [{ label: 'Yes', description: 'Continue' }] }],
  };

  const entries = [
    makeWorkTrigger(1, { botId: BOT_B.botId, triggerMessageId: 'msg_1' }),
    {
      id: 2,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_1' }) },
      model: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_q', name: 'ask_user_question', arguments: {} }],
      }],
    },
    {
      id: 3,
      kind: 'pi.tool-result',
      byTaskId: 99,
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_1' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'tc_q',
        toolName: 'ask_user_question',
        content: [{ type: 'text', text: 'waiting' }],
        isError: false,
        durableWait: true,
        details: { presentation: questionnairePresentation, durableWait: true },
      }],
    },
  ];

  const turns = extractMemberDmExecutionTurns(
    {
      member: BOT_B,
      rawEntries: entries,
      live: makeLiveState({
        durableWaits: [{ installationId: 'ask', conversationId: 7, requestId: '99' }],
      }),
    },
    'scope_dm_1',
  );

  assert.equal(turns.length, 1);
  const qTool = turns[0].tools?.[0];
  assert.equal(qTool?.name, 'ask_user_question');
  assert.equal(qTool?.durableWait, false);
  assert.equal(qTool?.presentationLive, false);
});

test('stripRedundantDmSendTo deduplicates matched top-level send_to & identical text while preserving commentary, non-send tools, running/error/cross-scope/not-yet-polled send_to', () => {
  const ledger = [
    makeStoredMessage({
      localId: 1,
      messageId: 'msg_req_1',
      sourceDeviceId: BOT_A.deviceId,
      botId: BOT_A.botId,
      category: 'request',
      text: 'Check metrics',
      createdAt: '2026-06-01T10:00:00.000Z',
    }),
    makeStoredMessage({
      localId: 2,
      messageId: 'msg_rep_1',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'reply',
      replyTo: 'msg_req_1',
      text: 'DAU is 12,480.',
      createdAt: '2026-06-01T10:00:05.000Z',
    }),
  ];

  const entries = [
    // Turn 1: thinking + commentary + read + cross-scope send_to + same-scope succeeded send_to + duplicate text block
    makeWorkTrigger(10, { botId: BOT_B.botId, triggerMessageId: 'msg_req_1', responseMessageId: 'msg_req_1' }),
    {
      id: 11,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_req_1' }) },
      model: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Querying metrics db' },
          { type: 'text', text: 'Running metrics query...' },
          { type: 'toolCall', id: 'tc_read', name: 'read', arguments: { path: 'metrics.sql' } },
          { type: 'toolCall', id: 'tc_cross', name: 'send_to', arguments: { scopeId: 'scope_dm_other', text: 'Cross-scope ping' } },
          { type: 'toolCall', id: 'tc_err', name: 'send_to', arguments: { scopeId: 'scope_dm_1', text: 'Failed attempt' } },
          { type: 'toolCall', id: 'tc_ok', name: 'send_to', arguments: { scopeId: 'scope_dm_1', text: 'DAU is 12,480.' } },
          { type: 'text', text: 'DAU is 12,480.' },
        ],
        timestamp: Date.parse('2026-06-01T10:00:01.000Z'),
      }],
    },
    {
      id: 12,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_req_1' }) },
      model: [
        { role: 'toolResult', toolCallId: 'tc_read', toolName: 'read', content: [{ type: 'text', text: 'SELECT 1' }], isError: false },
        { role: 'toolResult', toolCallId: 'tc_cross', toolName: 'send_to', content: [{ type: 'text', text: JSON.stringify({ messageId: 'msg_other_1', scopeId: 'scope_dm_other', scopeKind: 'dm', status: 'stored' }) }], isError: false },
        { role: 'toolResult', toolCallId: 'tc_err', toolName: 'send_to', content: [{ type: 'text', text: JSON.stringify({ code: 'STALE_INPUT', message: 'stale' }) }], isError: true },
        { role: 'toolResult', toolCallId: 'tc_ok', toolName: 'send_to', content: [{ type: 'text', text: JSON.stringify({ messageId: 'msg_rep_1', scopeId: 'scope_dm_1', scopeKind: 'dm', status: 'stored' }) }], isError: false },
      ],
    },
    // Turn 2: not-yet-polled send_to (explicit messageId msg_rep_2 not in ledger yet) — must NOT be stripped or steal msg_rep_1!
    makeWorkTrigger(20, { botId: BOT_B.botId, triggerMessageId: 'msg_req_1', responseMessageId: 'msg_req_1' }),
    {
      id: 21,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_req_1' }) },
      model: [{
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc_unpolled', name: 'send_to', arguments: { scopeId: 'scope_dm_1', text: 'Follow-up addendum.' } },
        ],
        timestamp: Date.parse('2026-06-01T10:00:10.000Z'),
      }],
    },
    {
      id: 22,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_req_1' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'tc_unpolled',
        toolName: 'send_to',
        content: [{ type: 'text', text: JSON.stringify({ messageId: 'msg_rep_2', scopeId: 'scope_dm_1', scopeKind: 'dm', status: 'stored' }) }],
        isError: false,
      }],
    },
  ];

  // Also test an in-flight running send_to in Turn 3
  const extracted = extractMemberDmExecutionTurns(
    {
      member: BOT_B,
      rawEntries: entries,
      live: makeLiveState({
        busy: true,
        generation: {
          text: '',
          truncated: false,
          attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_req_2' }),
        },
        tools: [{ callId: 'tc_running_send', name: 'send_to', status: 'running', output: '', truncated: false, droppedBytes: 0, droppedLines: 0 }],
      }),
    },
    'scope_dm_1',
    { knownBots: KNOWN_BOTS },
  );

  const stripped = stripRedundantDmSendTo(extracted, BOT_B, 'scope_dm_1', ledger);
  assert.equal(stripped.length, 3);

  // Turn 1: tc_ok stripped, duplicate text block suppressed; read, tc_cross, tc_err, commentary, thinking kept!
  assert.equal(stripped[0].producedMessageId, 'msg_rep_1');
  assert.equal(stripped[0].silentPass, false);
  assert.equal(stripped[0].turn.text, 'Running metrics query...');
  assert.equal(stripped[0].turn.thinking, 'Querying metrics db');
  assert.deepEqual(
    stripped[0].turn.tools?.map((t) => t.id),
    ['tc_read', 'tc_cross', 'tc_err'],
  );

  // Turn 2: not-yet-polled send_to kept intact!
  assert.equal(stripped[1].producedMessageId, undefined);
  assert.deepEqual(stripped[1].turn.tools?.map((t) => t.id), ['tc_unpolled']);

  // Turn 3: in-flight running send_to kept intact!
  assert.equal(stripped[2].producedMessageId, undefined);
  assert.equal(stripped[2].isLive, true);
  assert.deepEqual(stripped[2].turn.tools?.map((t) => t.id), ['tc_running_send']);
});

test('codemode nested send_to works both without child.sendTo (argSummary JSON) and with child.sendTo populated, plus exact output messageId and time-window fallback', () => {
  const ledger = [
    makeStoredMessage({
      localId: 1,
      messageId: 'msg_req_1',
      sourceDeviceId: BOT_A.deviceId,
      botId: BOT_A.botId,
      category: 'request',
      text: 'Run report script',
      createdAt: '2026-06-01T10:00:00.000Z',
    }),
    makeStoredMessage({
      localId: 2,
      messageId: 'msg_cm_raw',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'reply',
      replyTo: 'msg_req_1',
      text: 'Script report ready.',
      createdAt: '2026-06-01T10:00:04.000Z',
    }),
    makeStoredMessage({
      localId: 3,
      messageId: 'msg_cm_populated',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'request',
      replyTo: null,
      text: 'Populated child sendTo message',
      createdAt: '2026-06-01T10:01:05.000Z',
    }),
    makeStoredMessage({
      localId: 4,
      messageId: 'msg_cm_window',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'request',
      replyTo: null,
      text: 'Opaque codemode output text',
      createdAt: '2026-06-01T10:02:10.000Z',
    }),
  ];

  // Case 1: Raw details.calls nested send_to (NO child.sendTo populated yet; argSummary has JSON string)
  const rawEntries = [
    makeWorkTrigger(10, { botId: BOT_B.botId, triggerMessageId: 'msg_req_1' }),
    {
      id: 11,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_req_1' }) },
      model: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'cm_1', name: 'codemode', arguments: { code: 'await read("a"); await send_to({ text: "Script report ready." })' } }],
        timestamp: Date.parse('2026-06-01T10:00:01.000Z'),
      }],
    },
    {
      id: 12,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_req_1' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'cm_1',
        toolName: 'codemode',
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        details: {
          calls: [
            { id: 0, name: 'read', status: 'ok', args: '{"path":"a"}', durationMs: 12 },
            { id: 1, name: 'send_to', status: 'ok', args: '{"scopeId":"scope_dm_1","text":"Script report ready."}', durationMs: 30 },
          ],
        },
        timestamp: Date.parse('2026-06-01T10:00:04.000Z'),
      }],
    },
  ];

  const extractedRaw = extractMemberDmExecutionTurns(
    { member: BOT_B, rawEntries, live: null },
    'scope_dm_1',
    { knownBots: KNOWN_BOTS },
  );

  // Case 2: Synthetic turn where fix-codemode-dm ALREADY populated child.sendTo on both same-scope & cross-scope children
  const prePopulatedTurn = {
    id: '21-0',
    role: 'assistant',
    entryId: 21,
    text: 'Populated child sendTo message',
    startedAt: Date.parse('2026-06-01T10:01:00.000Z'),
    timestamp: Date.parse('2026-06-01T10:01:04.000Z'),
    attribution: makeDmAttr({ scopeId: 'scope_dm_1' }),
    tools: [{
      id: 'cm_2',
      name: 'codemode',
      status: 'done',
      outcome: 'ok',
      children: [
        {
          id: 'cm_2/c0',
          parentCallId: 'cm_2',
          name: 'send_to',
          status: 'done',
          outcome: 'ok',
          argSummary: '→ Dispatcher: Populated child sendTo message',
          sendTo: { scopeKind: 'dm', targetName: 'Dispatcher', text: 'Populated child sendTo message', silentPass: false },
        },
        {
          id: 'cm_2/c1',
          parentCallId: 'cm_2',
          name: 'send_to',
          status: 'done',
          outcome: 'ok',
          args: { scopeId: 'scope_dm_other', text: 'CC reviewer' },
          sendTo: { scopeKind: 'dm', targetName: 'Reviewer', text: 'CC reviewer', silentPass: false },
        },
        {
          id: 'cm_2/c2',
          parentCallId: 'cm_2',
          name: 'send_to',
          status: 'error',
          outcome: 'error',
          error: 'STALE_INPUT',
          sendTo: { scopeKind: 'dm', targetName: 'Dispatcher', text: 'Failed send', silentPass: false },
        },
      ],
    }],
    blocks: [
      { id: '21-0-b1', kind: 'text', text: 'Populated child sendTo message' },
      {
        id: '21-0-tools-cm_2',
        kind: 'tools',
        tools: [],
      },
    ],
  };
  prePopulatedTurn.blocks[1].tools = prePopulatedTurn.tools;

  // Case 3: Codemode with truncated/missing nested args matched via time-window [startedAt - 5s, endAt + 30s]
  const timeWindowTurn = {
    id: '31-0',
    role: 'assistant',
    entryId: 31,
    text: '',
    startedAt: Date.parse('2026-06-01T10:02:00.000Z'),
    timestamp: Date.parse('2026-06-01T10:02:02.000Z'),
    durationMs: 2_000,
    attribution: makeDmAttr({ scopeId: 'scope_dm_1' }),
    tools: [{
      id: 'cm_3',
      name: 'codemode',
      status: 'done',
      outcome: 'ok',
      nestedCallsTruncated: true,
    }],
  };

  const results = stripRedundantDmSendTo(
    [...extractedRaw, prePopulatedTurn, timeWindowTurn],
    BOT_B,
    'scope_dm_1',
    ledger,
  );

  // Case 1: matched msg_cm_raw, codemode card kept with read & send_to children
  assert.equal(results[0].producedMessageId, 'msg_cm_raw');
  assert.equal(results[0].turn.tools?.length, 1);
  assert.equal(results[0].turn.tools?.[0].name, 'codemode');
  assert.deepEqual(results[0].turn.tools?.[0].children?.map((c) => c.name), ['read', 'send_to']);

  // Case 2: matched msg_cm_populated; duplicate plain text suppressed; codemode card kept;
  // matched same-scope child.sendTo neutralized while cross-scope & errored child.sendTo preserved; original turn NOT mutated!
  assert.equal(results[1].producedMessageId, 'msg_cm_populated');
  assert.equal(results[1].turn.text, '');
  const cm2Children = results[1].turn.tools?.[0].children;
  assert.equal(cm2Children?.[0].sendTo, undefined);
  assert.equal(cm2Children?.[1].sendTo?.text, 'CC reviewer');
  assert.equal(cm2Children?.[2].sendTo?.text, 'Failed send');
  assert.equal(prePopulatedTurn.tools[0].children[0].sendTo?.text, 'Populated child sendTo message');

  // Case 3: matched msg_cm_window via time-window fallback
  assert.equal(results[2].producedMessageId, 'msg_cm_window');
});

test('causal merging is immune to cross-device clock skew and handles sub-delegation resumed turns', () => {
  // Device B clock is 10 minutes BEHIND Device A!
  const ledger = [
    makeStoredMessage({
      localId: 1,
      messageId: 'msg_a1',
      sourceDeviceId: BOT_A.deviceId,
      botId: BOT_A.botId,
      category: 'request',
      text: 'Ask Bot C and report back',
      createdAt: '2026-06-01T10:10:00.000Z',
    }),
    makeStoredMessage({
      localId: 2,
      messageId: 'msg_b1',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'reply',
      replyTo: 'msg_a1',
      text: 'Bot C confirmed 42.',
      createdAt: '2026-06-01T10:00:05.000Z',
    }),
  ];

  const botBEntries = [
    // Step 1: Initial turn on msg_a1 delegates to Bot C in scope_dm_bc (clock 10m behind!)
    makeWorkTrigger(10, {
      botId: BOT_B.botId,
      dataScopeId: 'scope_dm_1',
      turnKind: 'dm',
      turnScopeId: 'scope_dm_1',
      replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: BOT_A.botId },
      triggerMessageId: 'msg_a1',
      responseMessageId: 'msg_a1',
    }),
    {
      id: 11,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }) },
      model: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Delegating to Reviewer...' },
          { type: 'toolCall', id: 'tc_sub', name: 'send_to', arguments: { scopeId: 'scope_dm_bc', text: 'Please verify 42' } },
        ],
        timestamp: Date.parse('2026-06-01T10:00:01.000Z'),
      }],
    },
    {
      id: 12,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'tc_sub',
        toolName: 'send_to',
        content: [{ type: 'text', text: JSON.stringify({ messageId: 'msg_bc_1', scopeId: 'scope_dm_bc', scopeKind: 'dm', status: 'stored' }) }],
        isError: false,
      }],
    },
    // Step 2: Resumed turn after Bot C replied msg_bc_2 -> attribution.scopeId === scope_dm_1, replyTo === msg_bc_2!
    makeWorkTrigger(13, {
      botId: BOT_B.botId,
      dataScopeId: 'scope_dm_bc',
      turnKind: 'dm',
      turnScopeId: 'scope_dm_1',
      replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: BOT_A.botId },
      triggerMessageId: 'msg_bc_2',
      responseMessageId: 'msg_a1',
    }),
    {
      id: 14,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_bc_2' }) },
      model: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Synthesizing Reviewer reply' },
          { type: 'toolCall', id: 'tc_reply_a', name: 'send_to', arguments: { scopeId: 'scope_dm_1', text: 'Bot C confirmed 42.' } },
        ],
        timestamp: Date.parse('2026-06-01T10:00:04.000Z'),
      }],
    },
    {
      id: 15,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_bc_2' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'tc_reply_a',
        toolName: 'send_to',
        content: [{ type: 'text', text: JSON.stringify({ messageId: 'msg_b1', scopeId: 'scope_dm_1', scopeKind: 'dm', status: 'stored' }) }],
        isError: false,
      }],
    },
  ];

  const result = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: ledger,
    members: [
      { member: BOT_A, rawEntries: [], live: null },
      { member: BOT_B, rawEntries: botBEntries, live: null },
    ],
    knownBots: KNOWN_BOTS,
    hideToolOutput: false,
  });

  // Exact causal order despite 10-minute backward clock skew on Device B:
  // 0: ledger msg_a1
  // 1: Bot B delegation turn (afterSlot[0], preserving cross-scope send_to to scope_dm_bc)
  // 2: Bot B resumed synthesis turn (beforeSlot[1], top-level send_to stripped, thinking preserved)
  // 3: ledger msg_b1
  assert.deepEqual(
    result.items.map((it) => (it.kind === 'ledger' ? `L:${it.message.message.messageId}` : `E:${it.turn.id}`)),
    ['L:msg_a1', 'E:11-0', 'E:14-0', 'L:msg_b1'],
  );
  assert.equal(result.items[1].kind, 'execution');
  assert.equal(result.items[1].turn.tools?.[0].id, 'tc_sub');
  assert.equal(result.items[2].kind, 'execution');
  assert.equal(result.items[2].producedMessageId, 'msg_b1');
  assert.equal(result.items[2].turn.tools, undefined);
  assert.equal(result.items[2].turn.thinking, 'Synthesizing Reviewer reply');
});

test('hideToolOutput=true hides tools, thinking, silent-pass, and activeToolName while keeping ledger, working commentary, errors, and live streaming text', () => {
  const ledger = [
    makeStoredMessage({ localId: 1, messageId: 'msg_1', text: 'Inspect service', createdAt: '2026-06-01T10:00:00.000Z' }),
    makeStoredMessage({ localId: 2, messageId: 'msg_2', sourceDeviceId: BOT_B.deviceId, botId: BOT_B.botId, category: 'reply', replyTo: 'msg_1', text: 'Service healthy.', createdAt: '2026-06-01T10:00:05.000Z' }),
    makeStoredMessage({ localId: 3, messageId: 'msg_3', text: 'Any further updates?', createdAt: '2026-06-01T10:01:00.000Z' }),
    makeStoredMessage({ localId: 4, messageId: 'msg_4', text: 'Run failing step', createdAt: '2026-06-01T10:02:00.000Z' }),
  ];

  const entries = [
    // Turn 1: thinking + commentary + bash + matched send_to
    makeWorkTrigger(10, { botId: BOT_B.botId, triggerMessageId: 'msg_1' }),
    {
      id: 11,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_1' }) },
      model: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Checking health endpoint' },
          { type: 'text', text: 'Checking service status now...' },
          { type: 'toolCall', id: 'tc_bash', name: 'bash', arguments: { command: 'curl /health' } },
          { type: 'toolCall', id: 'tc_send', name: 'send_to', arguments: { scopeId: 'scope_dm_1', text: 'Service healthy.' } },
        ],
        timestamp: Date.parse('2026-06-01T10:00:01.000Z'),
      }],
    },
    {
      id: 12,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_1' }) },
      model: [
        { role: 'toolResult', toolCallId: 'tc_bash', toolName: 'bash', content: [{ type: 'text', text: '200 OK' }], isError: false },
        { role: 'toolResult', toolCallId: 'tc_send', toolName: 'send_to', content: [{ type: 'text', text: JSON.stringify({ messageId: 'msg_2', scopeId: 'scope_dm_1', scopeKind: 'dm', status: 'stored' }) }], isError: false },
      ],
    },
    // Turn 2: silent pass on msg_3
    makeWorkTrigger(20, { botId: BOT_B.botId, triggerMessageId: 'msg_3' }),
    {
      id: 21,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_3' }) },
      model: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tc_pass', name: 'send_to', arguments: { scopeId: 'scope_dm_1', text: '(pass)' } }],
        timestamp: Date.parse('2026-06-01T10:01:02.000Z'),
      }],
    },
    {
      id: 22,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_3' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'tc_pass',
        toolName: 'send_to',
        content: [{ type: 'text', text: JSON.stringify({ scopeId: 'scope_dm_1', scopeKind: 'dm', status: 'silent_pass' }) }],
        isError: false,
      }],
    },
    // Turn 3: execution failure on msg_4
    makeWorkTrigger(30, { botId: BOT_B.botId, triggerMessageId: 'msg_4' }),
    {
      id: 31,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_4' }) },
      model: [{
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'Retrying upstream' }],
        stopReason: 'error',
        errorMessage: 'upstream_timeout',
        timestamp: Date.parse('2026-06-01T10:02:02.000Z'),
      }],
    },
  ];

  const liveRunning = makeLiveState({
    busy: true,
    generation: {
      text: 'Live streaming commentary...',
      truncated: false,
      attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_5' }),
    },
    tools: [{ callId: 'tc_live_bash', name: 'bash', status: 'running', output: '', truncated: false, droppedBytes: 0, droppedLines: 0 }],
    activity: { phase: 'running', source: 'dm', scopeId: 'scope_dm_1', requestId: 'r_live', startedAt: '2026-06-01T10:03:00.000Z' },
  });

  // hideToolOutput = false
  const shown = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: ledger,
    members: [{ member: BOT_B, rawEntries: entries, live: liveRunning }],
    knownBots: KNOWN_BOTS,
    hideToolOutput: false,
  });
  assert.equal(shown.liveStatuses[0].isBusy, true);
  assert.equal(shown.liveStatuses[0].isStreaming, true);
  assert.equal(shown.liveStatuses[0].activeToolName, 'bash');
  const shownExecs = shown.items.filter((i) => i.kind === 'execution');
  assert.equal(shownExecs.length, 4);
  assert.equal(shownExecs[0].turn.thinking, 'Checking health endpoint');
  assert.deepEqual(shownExecs[0].turn.tools?.map((t) => t.name), ['bash']);
  assert.equal(shownExecs[1].silentPass, true);
  assert.equal(shownExecs[2].turn.error, 'upstream_timeout');
  assert.equal(shownExecs[3].isLive, true);
  assert.equal(shownExecs[3].turn.text, 'Live streaming commentary...');

  // hideToolOutput = true
  const hidden = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: ledger,
    members: [{ member: BOT_B, rawEntries: entries, live: liveRunning }],
    knownBots: KNOWN_BOTS,
    hideToolOutput: true,
  });
  assert.equal(hidden.liveStatuses[0].isBusy, true);
  assert.equal(hidden.liveStatuses[0].isStreaming, true);
  assert.equal(hidden.liveStatuses[0].activeToolName, null);
  assert.equal(hidden.liveStatuses[0].hasThinking, false);
  // All 4 ledger messages preserved!
  assert.equal(hidden.items.filter((i) => i.kind === 'ledger').length, 4);
  const hiddenExecs = hidden.items.filter((i) => i.kind === 'execution');
  // Silent-pass dropped; commentary, error, and live streaming text KEPT with tools & thinking stripped!
  assert.equal(hiddenExecs.length, 3);
  assert.equal(hiddenExecs[0].turn.text, 'Checking service status now...');
  assert.equal(hiddenExecs[0].turn.thinking, undefined);
  assert.equal(hiddenExecs[0].turn.tools, undefined);
  assert.equal(hiddenExecs[1].turn.error, 'upstream_timeout');
  assert.equal(hiddenExecs[1].turn.thinking, undefined);
  assert.equal(hiddenExecs[2].isLive, true);
  assert.equal(hiddenExecs[2].turn.text, 'Live streaming commentary...');
  assert.equal(hiddenExecs[2].turn.tools, undefined);
});

test('/clear (pi.reset / clearedThroughEntryId), legacy Hosts, offline peers, live failure attribution, and hasEarlierLedger cutoff', () => {
  const ledger = [
    makeStoredMessage({ localId: 1, messageId: 'msg_old', text: 'Before clear', createdAt: '2026-06-01T10:00:00.000Z' }),
    makeStoredMessage({ localId: 2, messageId: 'msg_new', text: 'After clear', createdAt: '2026-06-01T12:00:00.000Z' }),
  ];

  // 1. /clear: pre-reset entries & stale pre-clear live snapshot ignored; ledger preserved; post-reset legacy turn works!
  const clearResult = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: ledger,
    members: [
      { member: BOT_A, rawEntries: [], live: null, unavailableReason: 'offline' },
      {
        member: BOT_B,
        clearedThroughEntryId: 50,
        rawEntries: [
          makeWorkTrigger(10, { botId: BOT_B.botId, triggerMessageId: 'msg_old' }),
          {
            id: 11,
            kind: 'pi.assistant',
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Pre-clear trace must hide' }] }],
          },
          { id: 50, kind: 'pi.reset' },
          // Legacy Host post-clear turn: NO data.attribution on pi.assistant, resolved via host.work-trigger side-map!
          makeWorkTrigger(51, { botId: BOT_B.botId, triggerMessageId: 'msg_new' }),
          {
            id: 52,
            kind: 'pi.assistant',
            model: [{ role: 'assistant', content: [{ type: 'text', text: 'Post-clear legacy trace' }], timestamp: Date.parse('2026-06-01T12:00:03.000Z') }],
          },
        ],
        // Stale pre-clear live snapshot (lastEntryId 49 <= 50, no pi.reset >= 50)
        live: makeLiveState({
          lastEntryId: 49,
          busy: true,
          activity: { phase: 'running', source: 'dm', scopeId: 'scope_dm_1', requestId: 'stale', startedAt: '2026-06-01T10:00:01.000Z' },
        }),
      },
    ],
    hideToolOutput: false,
  });

  assert.equal(clearResult.liveStatuses[0].isBusy, false);
  assert.equal(clearResult.liveStatuses[1].isBusy, false);
  assert.deepEqual(
    clearResult.items.map((it) => (it.kind === 'ledger' ? `L:${it.message.message.messageId}` : `E:${it.turn.text}`)),
    ['L:msg_old', 'L:msg_new', 'E:Post-clear legacy trace'],
  );

  // 2. Live failure attribution: source=null matches only when latestBoundary is DM scope AND latest scoped turn has no turn.error
  const failAttributed = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: [ledger[1]],
    members: [{
      member: BOT_B,
      rawEntries: [makeWorkTrigger(60, { botId: BOT_B.botId, triggerMessageId: 'msg_new' })],
      live: makeLiveState({
        busy: false,
        activity: { phase: 'failed', source: null, scopeId: null, requestId: null, startedAt: null, error: { code: 'GENERATION_FAILED', message: 'provider 503' } },
      }),
    }],
    hideToolOutput: false,
  });
  assert.equal(failAttributed.liveStatuses[0].failureDetail, 'provider 503');

  const failSuppressedByTurnError = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: [ledger[1]],
    members: [{
      member: BOT_B,
      rawEntries: [
        makeWorkTrigger(60, { botId: BOT_B.botId, triggerMessageId: 'msg_new' }),
        {
          id: 61,
          kind: 'pi.assistant',
          data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_new' }) },
          model: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'provider 503' }],
        },
      ],
      live: makeLiveState({
        busy: false,
        activity: { phase: 'failed', source: null, scopeId: null, requestId: null, startedAt: null, error: { code: 'GENERATION_FAILED', message: 'provider 503' } },
      }),
    }],
    hideToolOutput: false,
  });
  assert.equal(failSuppressedByTurnError.liveStatuses[0].failureDetail, null);

  const failNotLeakedFromOtherScope = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: [ledger[1]],
    members: [{
      member: BOT_B,
      rawEntries: [makeWorkTrigger(60, { botId: BOT_B.botId, triggerMessageId: 'msg_new' })],
      live: makeLiveState({
        busy: false,
        activity: { phase: 'failed', source: 'dm', scopeId: 'scope_dm_other', requestId: null, startedAt: null, error: { code: 'ERR', message: 'other dm fail' } },
      }),
    }],
    hideToolOutput: false,
  });
  assert.equal(failNotLeakedFromOtherScope.liveStatuses[0].failureDetail, null);

  // 3. hasEarlierLedger pagination cutoff (oldestLedgerMs - 60_000)
  const oldestMs = Date.parse('2026-06-01T12:00:00.000Z');
  const unanchoredOld = {
    kind: 'execution',
    key: 'exec:dev_b:bot_b:old-0',
    member: BOT_B,
    turn: { id: 'old-0', role: 'assistant', entryId: 1, text: 'Way older execution', startedAt: oldestMs - 120_000 },
    silentPass: false,
    isLive: false,
  };
  const unanchoredNear = {
    kind: 'execution',
    key: 'exec:dev_b:bot_b:near-0',
    member: BOT_B,
    turn: { id: 'near-0', role: 'assistant', entryId: 2, text: 'Within 60s skew grace', startedAt: oldestMs - 30_000 },
    silentPass: false,
    isLive: false,
  };

  const paged = mergeDmLedgerAndExecutions([ledger[1]], [unanchoredOld, unanchoredNear], { hasEarlierLedger: true });
  assert.deepEqual(
    paged.map((it) => (it.kind === 'ledger' ? `L:${it.message.message.messageId}` : `E:${it.turn.id}`)),
    ['E:near-0', 'L:msg_new'],
  );

  const unpaged = mergeDmLedgerAndExecutions([ledger[1]], [unanchoredOld, unanchoredNear], { hasEarlierLedger: false });
  assert.deepEqual(
    unpaged.map((it) => (it.kind === 'ledger' ? `L:${it.message.message.messageId}` : `E:${it.turn.id}`)),
    ['E:old-0', 'E:near-0', 'L:msg_new'],
  );
});

test('two-member DM timeline: drops send_to-only empty executions, preserves unique keys across members, handles codemode output messageId & silent-pass, 1-to-1 claim priority, and live pi.reset', () => {
  const ledger = [
    makeStoredMessage({
      localId: 1,
      messageId: 'msg_a1',
      sourceDeviceId: BOT_A.deviceId,
      botId: BOT_A.botId,
      category: 'request',
      text: 'Please analyze sales',
      createdAt: '2026-06-01T11:00:00.000Z',
    }),
    makeStoredMessage({
      localId: 2,
      messageId: 'msg_b1',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'reply',
      replyTo: 'msg_a1',
      text: 'Sales up 15%.',
      createdAt: '2026-06-01T11:00:05.000Z',
    }),
    makeStoredMessage({
      localId: 3,
      messageId: 'msg_b2',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'reply',
      replyTo: 'msg_a1',
      text: 'Final audited sales: +15.2%.',
      createdAt: '2026-06-01T11:00:08.000Z',
    }),
  ];

  // 1-to-1 claim priority: Turn 1 has only replyTo (no messageId), Turn 2 has exact messageId='msg_b2' in codemode output.
  // Exact messageId on Turn 2 MUST claim msg_b2 before Turn 1's replyTo pass runs, so Turn 1 claims msg_b1!
  const turnNoId = {
    id: '10-0',
    role: 'assistant',
    entryId: 10,
    text: '',
    startedAt: Date.parse('2026-06-01T11:00:02.000Z'),
    attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }),
    tools: [{
      id: 'tc_send_legacy',
      name: 'send_to',
      status: 'done',
      outcome: 'ok',
      args: { scopeId: 'scope_dm_1', text: 'Sales up 15%.' },
    }],
  };
  const turnCodemodeOutputId = {
    id: '20-0',
    role: 'assistant',
    entryId: 20,
    text: '',
    startedAt: Date.parse('2026-06-01T11:00:06.000Z'),
    attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }),
    tools: [{
      id: 'cm_out',
      name: 'codemode',
      status: 'done',
      outcome: 'ok',
      output: JSON.stringify({ ok: true, receipt: { messageId: 'msg_b2', scopeId: 'scope_dm_1', status: 'stored' } }),
      children: [{
        id: 'cm_out/c0',
        parentCallId: 'cm_out',
        name: 'send_to',
        status: 'done',
        outcome: 'ok',
        argSummary: '→ Dispatcher: Final audited sales: +15.2%.',
        sendTo: { scopeKind: 'dm', targetName: 'Dispatcher', text: 'Final audited sales: +15.2%.', silentPass: false },
      }, {
        // Cross-scope nested send_to whose argSummary was formatted without scopeId (fix-codemode-dm integration)
        id: 'cm_out/c1',
        parentCallId: 'cm_out',
        name: 'send_to',
        status: 'done',
        outcome: 'ok',
        argSummary: '→ Reviewer: FYI sales +15.2%',
        sendTo: { scopeKind: 'dm', targetName: 'Reviewer', text: 'FYI sales +15.2%', silentPass: false },
      }],
    }],
  };
  const turnCodemodePass = {
    id: '30-0',
    role: 'assistant',
    entryId: 30,
    text: '',
    startedAt: Date.parse('2026-06-01T11:00:12.000Z'),
    attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }),
    tools: [{
      id: 'cm_pass',
      name: 'codemode',
      status: 'done',
      outcome: 'ok',
      children: [{
        id: 'cm_pass/c0',
        parentCallId: 'cm_pass',
        name: 'send_to',
        status: 'done',
        outcome: 'ok',
        argSummary: '{"scopeId":"scope_dm_1","text":"(pass)"}',
      }],
    }],
  };

  const claimed = stripRedundantDmSendTo(
    [turnNoId, turnCodemodeOutputId, turnCodemodePass],
    BOT_B,
    'scope_dm_1',
    ledger,
  );
  assert.equal(claimed[0].producedMessageId, 'msg_b1');
  assert.equal(claimed[0].turn.tools, undefined); // top-level send_to stripped -> empty execution!
  assert.equal(claimed[1].producedMessageId, 'msg_b2');
  assert.equal(claimed[1].turn.tools?.[0].children?.[0].sendTo, undefined); // same-scope matched neutralized
  assert.equal(claimed[1].turn.tools?.[0].children?.[1].sendTo?.text, 'FYI sales +15.2%'); // cross-scope preserved
  assert.equal(claimed[2].producedMessageId, undefined);
  assert.equal(claimed[2].silentPass, true);

  // Merge drops empty execution (claimed[0]), keeps claimed[1] before msg_b2 and claimed[2] after msg_a1
  const merged = mergeDmLedgerAndExecutions(ledger, claimed);
  assert.deepEqual(
    merged.map((it) => (it.kind === 'ledger' ? `L:${it.message.message.messageId}` : `E:${it.turn.id}`)),
    ['L:msg_a1', 'E:30-0', 'L:msg_b1', 'E:20-0', 'L:msg_b2'],
  );

  // Two members both streaming simultaneously (both produce turn.id === 'live-assistant') + live pi.reset overrides stale rawEntries
  const dualLive = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: [ledger[0]],
    members: [
      {
        member: BOT_A,
        rawEntries: [
          makeWorkTrigger(5, { botId: BOT_A.botId, triggerMessageId: 'msg_old' }),
          { id: 6, kind: 'pi.assistant', data: { attribution: makeDmAttr({ botId: BOT_A.botId, deviceId: BOT_A.deviceId, scopeId: 'scope_dm_1' }) }, model: [{ role: 'assistant', content: [{ type: 'text', text: 'Stale pre-reset raw' }] }] },
        ],
        live: makeLiveState({
          lastEntryId: 10,
          history: [{ id: 10, kind: 'pi.reset', messages: [] }],
          busy: true,
          generation: { text: 'Bot A live note', truncated: false, attribution: makeDmAttr({ botId: BOT_A.botId, deviceId: BOT_A.deviceId, scopeId: 'scope_dm_1' }) },
          activity: { phase: 'running', source: 'dm', scopeId: 'scope_dm_1', requestId: 'ra', startedAt: '2026-06-01T11:01:00.000Z' },
        }),
      },
      {
        member: BOT_B,
        rawEntries: [],
        live: makeLiveState({
          busy: true,
          generation: { text: 'Bot B live note', truncated: false, attribution: makeDmAttr({ botId: BOT_B.botId, deviceId: BOT_B.deviceId, scopeId: 'scope_dm_1' }) },
          activity: { phase: 'running', source: 'dm', scopeId: 'scope_dm_1', requestId: 'rb', startedAt: '2026-06-01T11:01:02.000Z' },
        }),
      },
    ],
    hideToolOutput: false,
  });

  const liveExecs = dualLive.items.filter((i) => i.kind === 'execution');
  assert.equal(liveExecs.length, 2);
  // Keys must be distinct even though both have turn.id === 'live-assistant'!
  assert.notEqual(liveExecs[0].key, liveExecs[1].key);
  assert.equal(liveExecs[0].key, 'exec:dev_a:bot_a:live-assistant');
  assert.equal(liveExecs[1].key, 'exec:dev_b:bot_b:live-assistant');
  assert.equal(dualLive.liveStatuses.length, 2);
  assert.equal(dualLive.liveStatuses[0].isStreaming, true);
  assert.equal(dualLive.liveStatuses[1].isStreaming, true);
});

test('regression (#16 integration): codemode cross-scope delegation (ensure_dm + send_to to scope_dm_bc) never steals later codemode reply to scope_dm_1', () => {
  const ledger = [
    makeStoredMessage({
      localId: 1,
      messageId: 'msg_a1',
      sourceDeviceId: BOT_A.deviceId,
      botId: BOT_A.botId,
      category: 'request',
      text: 'Delegate build check to Reviewer and report back',
      createdAt: '2026-06-01T10:00:00.000Z',
    }),
    makeStoredMessage({
      localId: 2,
      messageId: 'msg_b1',
      sourceDeviceId: BOT_B.deviceId,
      botId: BOT_B.botId,
      category: 'reply',
      replyTo: 'msg_a1',
      text: 'Reviewer verified: all clear.',
      createdAt: '2026-06-01T10:00:08.000Z',
    }),
  ];

  // Raw entries: Turn 1 delegates via codemode (ensure_dm + send_to to scope_dm_bc, no messageId in output);
  // Turn 2 replies to scope_dm_1 via codemode (no messageId in output), sharing responseMessageId/replyTo = msg_a1.
  const botBEntries = [
    makeWorkTrigger(10, {
      botId: BOT_B.botId,
      dataScopeId: 'scope_dm_1',
      turnKind: 'dm',
      turnScopeId: 'scope_dm_1',
      replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: BOT_A.botId },
      triggerMessageId: 'msg_a1',
      responseMessageId: 'msg_a1',
    }),
    {
      id: 11,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }) },
      model: [{
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'cm_delegate',
          name: 'codemode',
          arguments: { code: 'const dm = await ensure_dm({ deviceId: "dev_c", botId: "bot_c" }); await send_to({ scopeId: dm.scopeId, text: "Reviewer, please check build" });' },
        }],
        timestamp: Date.parse('2026-06-01T10:00:01.000Z'),
      }],
    },
    {
      id: 12,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'cm_delegate',
        toolName: 'codemode',
        content: [{ type: 'text', text: 'delegated' }],
        isError: false,
        details: {
          calls: [
            { id: 0, name: 'ensure_dm', status: 'ok', args: '{"deviceId":"dev_c","botId":"bot_c"}', durationMs: 15 },
            { id: 1, name: 'send_to', status: 'ok', args: '{"scopeId":"scope_dm_bc","text":"Reviewer, please check build"}', durationMs: 25 },
          ],
        },
        timestamp: Date.parse('2026-06-01T10:00:02.000Z'),
      }],
    },
    makeWorkTrigger(13, {
      botId: BOT_B.botId,
      dataScopeId: 'scope_dm_bc',
      turnKind: 'dm',
      turnScopeId: 'scope_dm_1',
      replyTarget: { kind: 'dm', scopeId: 'scope_dm_1', botId: BOT_A.botId },
      triggerMessageId: 'msg_bc_2',
      responseMessageId: 'msg_a1',
    }),
    {
      id: 14,
      kind: 'pi.assistant',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_bc_2' }) },
      model: [{
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'cm_reply',
          name: 'codemode',
          arguments: { code: 'await send_to({ scopeId: "scope_dm_1", text: "Reviewer verified: all clear." });' },
        }],
        timestamp: Date.parse('2026-06-01T10:00:06.000Z'),
      }],
    },
    {
      id: 15,
      kind: 'pi.tool-result',
      data: { attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_bc_2' }) },
      model: [{
        role: 'toolResult',
        toolCallId: 'cm_reply',
        toolName: 'codemode',
        content: [{ type: 'text', text: 'replied' }],
        isError: false,
        details: {
          calls: [
            { id: 0, name: 'send_to', status: 'ok', args: '{"scopeId":"scope_dm_1","text":"Reviewer verified: all clear."}', durationMs: 20 },
          ],
        },
        timestamp: Date.parse('2026-06-01T10:00:07.000Z'),
      }],
    },
  ];

  const built = buildDmScopeTimeline({
    scopeId: 'scope_dm_1',
    ledgerMessages: ledger,
    members: [
      { member: BOT_A, rawEntries: [], live: null },
      { member: BOT_B, rawEntries: botBEntries, live: null },
    ],
    knownBots: KNOWN_BOTS,
    hideToolOutput: false,
  });

  assert.deepEqual(
    built.items.map((it) => (it.kind === 'ledger' ? `L:${it.message.message.messageId}` : `E:${it.turn.id}`)),
    ['L:msg_a1', 'E:11-0', 'E:14-0', 'L:msg_b1'],
  );
  // Turn 1 (cross-scope delegation) must NOT steal msg_b1!
  assert.equal(built.items[1].kind, 'execution');
  assert.equal(built.items[1].producedMessageId, undefined);
  assert.equal(built.items[1].triggerMessageId, 'msg_a1');
  // Turn 2 (same-scope reply) cleanly claims msg_b1 and neutralizes its duplicate nested child.sendTo.
  assert.equal(built.items[2].kind, 'execution');
  assert.equal(built.items[2].producedMessageId, 'msg_b1');
  assert.equal(built.items[2].turn.tools?.[0].children?.[0].sendTo, undefined);

  // Direct stripRedundantDmSendTo test without extractMemberDmExecutionTurns side-map
  // (simulates #16 having overwritten argSummary to "→ Reviewer: ..." with no scopeId on child):
  const syntheticDelegation = {
    id: 'syn-1',
    role: 'assistant',
    entryId: 101,
    text: '',
    startedAt: Date.parse('2026-06-01T10:00:01.000Z'),
    timestamp: Date.parse('2026-06-01T10:00:02.000Z'),
    attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }),
    tools: [{
      id: 'cm_syn_1',
      name: 'codemode',
      status: 'done',
      outcome: 'ok',
      children: [{
        id: 'cm_syn_1/c0',
        parentCallId: 'cm_syn_1',
        name: 'send_to',
        status: 'done',
        outcome: 'ok',
        argSummary: '→ Reviewer: Reviewer, please check build',
        sendTo: { scopeKind: 'dm', targetName: 'Reviewer', text: 'Reviewer, please check build', silentPass: false },
      }],
    }],
  };
  const syntheticReply = {
    id: 'syn-2',
    role: 'assistant',
    entryId: 102,
    text: '',
    startedAt: Date.parse('2026-06-01T10:00:06.000Z'),
    timestamp: Date.parse('2026-06-01T10:00:07.000Z'),
    attribution: makeDmAttr({ scopeId: 'scope_dm_1', replyTo: 'msg_a1' }),
    tools: [{
      id: 'cm_syn_2',
      name: 'codemode',
      status: 'done',
      outcome: 'ok',
      children: [{
        id: 'cm_syn_2/c0',
        parentCallId: 'cm_syn_2',
        name: 'send_to',
        status: 'done',
        outcome: 'ok',
        argSummary: '→ Dispatcher: Reviewer verified: all clear.',
        sendTo: { scopeKind: 'dm', targetName: 'Dispatcher', text: 'Reviewer verified: all clear.', silentPass: false },
      }],
    }],
  };

  const syntheticClaimed = stripRedundantDmSendTo(
    [syntheticDelegation, syntheticReply],
    BOT_B,
    'scope_dm_1',
    ledger,
  );
  assert.equal(syntheticClaimed[0].producedMessageId, undefined);
  assert.equal(syntheticClaimed[0].turn.tools?.[0].children?.[0].sendTo?.text, 'Reviewer, please check build');
  assert.equal(syntheticClaimed[1].producedMessageId, 'msg_b1');
  assert.equal(syntheticClaimed[1].turn.tools?.[0].children?.[0].sendTo, undefined);
});
