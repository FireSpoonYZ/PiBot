import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotSessionRuntime } from '../../host-core/runtime-bot-session.js';
import { questionnaireWaitKey } from '../../host-core/bot-session-context.js';
import { overlayHistoryWaits, readPrimaryHistory, stripAttachmentData } from '../../host-core/runtime-history.js';
import { createRuntimeLive } from '../../host-core/runtime-live.js';
import { emptyLiveState, projectLiveState, diffLiveState } from '../../host-core/runtime-live-projection.js';
import { projectBotBoardItem } from '../../host-core/runtime-bot-board.js';
import {
  ALL_LIVE_EXTENSIONS,
  NO_LIVE_EXTENSIONS,
  normalizeLiveSnapshot,
  projectLiveSnapshotForPeer,
} from '../../host-core/remote-live-protocol.js';
import { LEGACY_ATTACHED_IMAGE_PREFIX } from '../../host-core/attachments.js';
import { requestDetails, settledDetails } from '../../plugins/ask-user-question/presentation.js';
import { mergeHistoryWaitProjection, parseHistoryEntries } from '../src/chatTurnModel.ts';

const questions = [{ header: 'Direction', question: 'Which direction?', options: [
  { label: 'A', description: 'First direction' }, { label: 'B', description: 'Second direction' },
] }];
const details = requestDetails('ask-installation', 11, '55', questions);
const identity = { installationId: 'ask-installation', conversationId: 11, requestId: '55' };
const key = questionnaireWaitKey(details, 55, 11);
const terminal = settledDetails(details, 'answered', { answers: [], cancelled: false });
const entry = {
  id: 22, kind: 'pi.tool-result', byTaskId: 55,
  model: [{ role: 'toolResult', toolName: 'ask_user_question', toolCallId: 'q1',
    content: [{ type: 'text', text: 'Waiting for the user.' }], details }],
};
const assistant = { id: 21, kind: 'pi.assistant', model: [{ role: 'assistant',
  content: [{ type: 'toolCall', id: 'q1', name: 'ask_user_question', arguments: { questions } }],
}] };
function view(run = null) {
  return { entries: [assistant, entry], docs: { 'pi.live': { run, tools: [], nestedTools: [] }, 'pi.inbox': { items: [] } } };
}
function extras(value = { details, live: true, status: 'pending' }) {
  return { waitPresentations: new Map([[key, value]]), durableWaits: value.live ? [identity] : [] };
}

test('completed questionnaire tools remain answerable without making the SDK busy', () => {
  const result = projectLiveState(view(), null, extras());
  assert.equal(result.busy, false);
  assert.equal(result.activity.phase, 'idle');
  assert.deepEqual(result.tools, []);
  assert.equal(result.history[1].messages[0].durableWait, true);
  assert.deepEqual(result.durableWaits, [identity]);
  const item = projectBotBoardItem('bot', 'public', result, view(), { waits: [details] });
  assert.equal(item.attention.requestId, '55');
  assert.equal(item.activity.phase, 'idle');
  const running = projectLiveState(view({ taskId: 90, inputs: [9], first: 40 }), null, extras());
  assert.equal(running.busy, true);
  assert.equal(projectBotBoardItem('bot', 'public', running, view({ taskId: 90 }), { waits: [details] }).activity.phase, 'running');
});

test('raw details cannot self-authorize, and task identity cannot borrow another wait', async () => {
  const forged = structuredClone(entry);
  forged.model[0].durableWait = true;
  forged.model[0].details.durableWait = true;
  const untrusted = projectLiveState({ ...view(), entries: [forged] });
  assert.equal(untrusted.history[0].messages[0].durableWait, undefined);
  const cleaned = await overlayHistoryWaits(forged);
  assert.equal(cleaned.model[0].durableWait, undefined);
  assert.equal(cleaned.model[0].details.durableWait, undefined);
  let reads = 0;
  const borrowed = await overlayHistoryWaits({ ...entry, byTaskId: 56 }, {
    botId: 'bot', conversationId: 11,
    waits: { getPresentation() { reads++; return { details, live: true, status: 'pending' }; } },
  });
  assert.equal(reads, 0);
  assert.equal(borrowed.model[0].durableWait, undefined);
  assert.equal(questionnaireWaitKey(details, 55, 12), null);
});

test('answer overlays replace old pending details without rewriting stored history', async () => {
  const original = structuredClone(entry);
  const waits = { async getPresentation() { return { details: terminal, live: false, status: 'answered' }; } };
  const result = await readPrimaryHistory({ id: 11, async entries() { return { items: [entry] }; } }, {}, {}, { botId: 'bot', waits });
  assert.equal(result.items[0].model[0].details.presentation.status, 'answered');
  assert.equal(result.items[0].model[0].durableWait, false);
  assert.deepEqual(entry, original);
  const before = projectLiveState(view(), null, extras());
  const after = projectLiveState(view(), null, extras({ details: terminal, live: false, status: 'answered' }));
  const change = diffLiveState(before, after);
  assert.deepEqual(change.durableWaits, []);
  assert.equal(change.history[1].messages[0].presentation.status, 'answered');
  assert.equal(change.history[1].messages[0].durableWait, undefined);
});

test('client merges fresh wait state into full raw history, including cards outside the live window', () => {
  const before = structuredClone(entry);
  const pending = mergeHistoryWaitProjection(entry, undefined, [identity]);
  const pendingTool = parseHistoryEntries([assistant, pending]).find((turn) => turn.role === 'assistant').tools[0];
  assert.equal(pendingTool.status, 'done');
  assert.equal(pendingTool.durableWait, true);
  assert.equal(pendingTool.presentationLive, true);
  assert.deepEqual(pending.model[0].content, entry.model[0].content);
  const expired = mergeHistoryWaitProjection(pending, undefined, []);
  assert.equal(expired.model[0].durableWait, false);
  const answeredLive = projectLiveState(view(), null, extras({ details: terminal, live: false, status: 'answered' })).history[1];
  const answered = mergeHistoryWaitProjection(pending, answeredLive, []);
  assert.equal(answered.model[0].presentation.status, 'answered');
  assert.equal(answered.model[0].durableWait, false);
  assert.deepEqual(answered.model[0].content, entry.model[0].content);
  assert.deepEqual(entry, before);
  const unrelated = { ...identity, conversationId: 12 };
  assert.equal(mergeHistoryWaitProjection(entry, undefined, [unrelated]).model[0].durableWait, false);
});

test('wire accepts bounded active identities and rejects forged wait fields', () => {
  const frame = (state) => ({ type: 'snapshot', botId: 'bot', conversationId: 'public', sequence: 1, state });
  const state = projectLiveState(view(), null, extras());
  assert.deepEqual(normalizeLiveSnapshot(frame(structuredClone(state))).state.durableWaits, [identity]);
  const tooMany = { ...emptyLiveState(), durableWaits: Array.from({ length: 65 }, (_, i) => ({ ...identity, requestId: String(i + 1) })) };
  assert.throws(() => normalizeLiveSnapshot(frame(tooMany)), /64 identities/);
  assert.throws(() => normalizeLiveSnapshot(frame({ ...emptyLiveState(), durableWaits: [{ ...identity, text: 'secret' }] })), /unknown field/);
  const invalid = structuredClone(state);
  invalid.history[1].messages[0].toolName = 'bash';
  assert.throws(() => normalizeLiveSnapshot(frame(invalid)), /pending questionnaire tool/);
});

test('run contexts retain all input events and use the persisted first entry across handoffs', async () => {
  const bot = { botId: 'bot', deviceId: 'device', primaryConversationId: 'public' };
  let run = { taskId: 40, first: 10, inputs: [1, 2, 3] };
  const submissions = {
    1: { id: 1, type: 'input', conversationId: 11, requestId: 'r1', entry: 10 },
    2: { id: 2, type: 'input', conversationId: 11, requestId: 'r2', entry: 12 },
    3: { id: 3, type: 'input', conversationId: 11, requestId: 'r3', entry: 13 },
  };
  const entries = {
    10: { id: 10, kind: 'host.user-message', data: { requestId: 'r1', turn: { sender: { kind: 'user' }, replyTarget: { kind: 'primary' }, stopEpoch: 3 } } },
    12: { id: 12, kind: 'host.work-trigger', data: { requestId: 'r2', turn: { kind: 'dm', scopeId: 'dm', sender: { kind: 'bot', botId: 'peer' }, replyTarget: { kind: 'dm', scopeId: 'dm', botId: 'peer' }, stopEpoch: 3 } } },
    13: { id: 13, kind: 'host.user-message', data: { requestId: 'r3', turn: {
      sender: { kind: 'host', sourceType: 'google-workspace-rule' }, replyTarget: { kind: 'primary' },
    } } },
  };
  const harness = {
    async snapshot(token) {
      if (token.definition.kind === 'host.primary-index') return { byPrimary: { public: 11 } };
      if (token.definition.kind === 'pi.live') return { run: structuredClone(run) };
      return null;
    },
    async getTask(taskId) { return { id: taskId, conversationId: 11 }; },
    async commit(fn) { return fn({ submission: async (id) => submissions[id], entry: async (id) => entries[id] }); },
  };
  const sessions = createBotSessionRuntime({
    host: { deviceId: 'device', getBot: () => bot, listBots: () => [bot] },
    getHarness: () => harness, getMessageLog: () => ({ getScope: () => ({ kind: 'dm', scopeId: 'dm', members: [] }) }),
    getPrimary: () => null, context: {},
  });
  const dispatchContexts = { r1: { taskId: 'global-task', stepId: 'step', executionRevision: 3 } };
  const first = await sessions.getRunContext({ conversationId: 11, taskId: 40 }, {}, { dispatchContexts });
  assert.deepEqual(first.requestIds, ['r1', 'r2', 'r3']);
  assert.deepEqual(first.submissionIds, [1, 2, 3]);
  assert.equal(first.events[0].dispatchContext.taskId, 'global-task');
  assert.equal(first.events[1].dispatchContext, null);
  assert.equal(first.events[2].source, 'google-workspace-rule');
  assert.equal(first.events[2].sender.sourceType, 'google-workspace-rule');
  assert.equal(first.runId, 'run:["device",11,10]');
  run.taskId = 41;
  const next = await sessions.getRunContext({ conversationId: 11, taskId: 41 }, {});
  assert.equal(next.runId, first.runId);
  assert.notEqual(next.sdkExecutionId, first.sdkExecutionId);
  assert.equal(await sessions.getRunContext({ conversationId: 11, taskId: 40 }, {}), null);
  run.first = undefined;
  assert.equal((await sessions.getRunContext({ conversationId: 11 }, {})).runId, null);
});

test('reset watermarks suppress pre-reset entries and failures while keeping post-reset durable waits and hiding pi.compaction', () => {
  const preResetUser = {
    id: 10, kind: 'host.user-message',
    model: [{ role: 'user', content: [{ type: 'text', text: 'Before reset' }] }],
  };
  const resetMarker = { id: 15, kind: 'pi.reset', model: [] };
  const compaction = {
    id: 18, kind: 'pi.compaction',
    model: [{ role: 'user', content: [{ type: 'text', text: 'Compaction summary' }] }],
  };
  const resetView = {
    entries: [preResetUser, resetMarker, compaction, assistant, entry],
    docs: {
      'pi.live': {
        run: null,
        runFailure: { taskId: 12, first: 10, reason: 'error', message: 'Old failure before reset' },
        tools: [],
        nestedTools: [],
      },
      'pi.inbox': { items: [] },
    },
  };
  const result = projectLiveState(resetView, { clearedThroughEntryId: 15 }, {
    ...extras(),
    failureDoc: { failure: { code: 'PROVIDER_ERROR', message: 'Old failure before reset' } },
  });
  assert.equal(result.history[0].kind, 'pi.reset');
  assert.equal(result.history[0].id, 15);
  assert.deepEqual(result.history.map((item) => item.id), [15, 21, 22]);
  assert.equal(result.activity.phase, 'idle');
  assert.equal(result.history[2].messages[0].durableWait, true);
  assert.deepEqual(result.durableWaits, [identity]);

  const postResetFailure = projectLiveState(
    {
      ...resetView,
      docs: {
        ...resetView.docs,
        'pi.live': {
          ...resetView.docs['pi.live'],
          runFailure: { taskId: 60, first: 21, reason: 'error', message: 'Failure after reset' },
        },
      },
    },
    { clearedThroughEntryId: 15 },
    { ...extras(), failureDoc: { failure: { code: 'PROVIDER_ERROR', message: 'Failure after reset' } } },
  );
  assert.equal(postResetFailure.activity.phase, 'failed');
});

test('local live projection preserves trusted Host sources without dataBoundary and prioritizes Google/browser interactions', () => {
  const hostEntries = [
    {
      id: 30, kind: 'host.user-message',
      data: {
        dataBoundary: 'google-workspace',
        attribution: { kind: 'host', channel: 'primary', name: 'Rule · Gmail', sourceType: 'google-workspace-rule', dataBoundary: 'google-workspace' },
      },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Mail rule' }] }],
    },
    {
      id: 31, kind: 'host.user-message',
      data: { attribution: { kind: 'host', channel: 'primary', name: '定时任务', sourceType: 'schedule' } },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Schedule tick' }] }],
    },
    {
      id: 32, kind: 'host.user-message',
      data: { attribution: { kind: 'host', channel: 'primary', name: '任务 · Deploy', sourceType: 'task_dispatch' } },
      model: [{ role: 'user', content: [{ type: 'text', text: 'Task step' }] }],
    },
  ];
  const fillerTools = Array.from({ length: 34 }, (_, index) => ({
    callId: `bash-${index}`, name: 'bash', status: 'running', output: '',
  }));
  const googleTools = [
    {
      callId: 'g-setup', name: 'google_setup', status: 'running', output: '',
      details: { presentation: { kind: 'google-setup', version: 1, installationId: 'builtin.google-workspace', state: 'running', title: 'Setup' } },
    },
    {
      callId: 'g-takeover', name: 'browser_takeover', status: 'running', output: '',
      details: { presentation: { kind: 'google-browser-takeover', version: 1, installationId: 'builtin.google-workspace', phase: 'user', url: 'https://accounts.google.com' } },
    },
    {
      callId: 'g-select', name: 'google_account_select', status: 'running', output: '',
      details: { presentation: { kind: 'google-account-select', version: 1, installationId: 'builtin.google-workspace', status: 'pending', accounts: [{ email: 'user@example.com' }] } },
    },
  ];
  const projected = projectLiveState({
    entries: hostEntries,
    docs: { 'pi.live': { run: { taskId: 77, inputs: [1] }, tools: [...fillerTools, ...googleTools], nestedTools: [] }, 'pi.inbox': { items: [] } },
  });
  assert.deepEqual(
    projected.history.map((item) => item.attribution?.sourceType),
    ['google-workspace-rule', 'schedule', 'task_dispatch'],
  );
  for (const item of projected.history) {
    assert.equal('dataBoundary' in (item.attribution ?? {}), false);
  }
  assert.equal(projected.toolsTruncated, true);
  assert.deepEqual(projected.tools.slice(0, 3).map((tool) => tool.callId), ['g-setup', 'g-takeover', 'g-select']);
});

test('raw history strips legacy attachment blocks and base64 data, reports clearedThroughEntryId, and keeps chunked wait entries immutable', async () => {
  const attId = 'a'.repeat(64);
  const attEntry = {
    id: 40,
    kind: 'host.user-message',
    data: {
      userText: 'Check this screenshot',
      attachments: [{ id: attId, name: 'shot.png', mimeType: 'image/png', size: 128, width: 10, height: 10 }],
    },
    model: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Check this screenshot' },
        { type: 'text', text: LEGACY_ATTACHED_IMAGE_PREFIX + JSON.stringify({ name: 'shot.png', path: `/tmp/attachments/${attId}` }) },
        { type: 'image', mimeType: 'image/png', data: 'QUJDRA==' },
      ],
    }],
  };
  const stripped = stripAttachmentData(attEntry);
  assert.equal(stripped.model[0].content.length, 2);
  assert.equal(stripped.model[0].content[0].text, 'Check this screenshot');
  assert.equal(stripped.model[0].content[1].type, 'image');
  assert.equal('data' in stripped.model[0].content[1], false);

  // Oversized wait entry whose wait state flips mid-chunked-read must stay immutable across chunks.
  const largeEntry = {
    id: 41,
    kind: 'pi.tool-result',
    byTaskId: 55,
    model: [{
      role: 'toolResult',
      toolName: 'ask_user_question',
      toolCallId: 'q-large',
      content: [{ type: 'text', text: 'x'.repeat(270 * 1024) }],
      details,
    }],
  };
  const stored = [
    { id: 15, kind: 'pi.reset', model: [] },
    attEntry,
    largeEntry,
  ];
  let answeredMidRead = false;
  const waits = {
    async getPresentation() {
      return answeredMidRead
        ? { details: terminal, live: false, status: 'answered' }
        : { details, live: true, status: 'pending' };
    },
  };
  const conversation = {
    id: 11,
    async entries(query, limit, cursor) {
      if (query.order === 'descending') {
        return { items: [...stored].reverse(), next: null };
      }
      const visible = stored.filter((item) => item.id >= (query.minEntryId ?? 0));
      const start = cursor?.index ?? 0;
      const items = visible.slice(start, start + limit);
      const next = start + items.length < visible.length ? { index: start + items.length } : null;
      return { items, next };
    },
  };

  const firstPage = await readPrimaryHistory(conversation, { chunked: true, limit: 10 }, {}, { afterReset: true, botId: 'bot', waits });
  assert.equal(firstPage.clearedThroughEntryId, 15);
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.items[0].id, 40);
  assert.equal(firstPage.items[0].model[0].content.length, 2);
  assert.equal('data' in firstPage.items[0].model[0].content[1], false);

  let chunkCursor = firstPage.nextCursor;
  const pieces = [];
  let chunkCount = 0;
  while (chunkCursor) {
    const page = await readPrimaryHistory(conversation, { chunked: true, limit: 10, cursor: chunkCursor }, {}, { afterReset: true, botId: 'bot', waits });
    assert.equal(page.clearedThroughEntryId, 15);
    assert.ok(page.entryChunk);
    pieces.push(page.entryChunk.json);
    chunkCount++;
    if (chunkCount === 1) answeredMidRead = true;
    chunkCursor = page.nextCursor;
  }
  assert.ok(chunkCount >= 2);
  const reassembled = JSON.parse(pieces.join(''));
  assert.equal(reassembled.id, 41);
  assert.equal(reassembled.model[0].details.presentation.status, 'pending');
  assert.equal(reassembled.model[0].durableWait, undefined);
});

test('wire capability projection downgrades schedule/task_dispatch and omits durableWaits for legacy peers while preserving google-workspace-rule', () => {
  const base = projectLiveState({
    entries: [
      {
        id: 1, kind: 'host.user-message',
        data: { attribution: { kind: 'host', channel: 'primary', name: 'Rule · Mail', sourceType: 'google-workspace-rule' } },
        model: [{ role: 'user', content: [{ type: 'text', text: 'Rule event' }] }],
      },
      {
        id: 2, kind: 'host.user-message',
        data: { attribution: { kind: 'host', channel: 'primary', name: '定时任务', sourceType: 'schedule' } },
        model: [{ role: 'user', content: [{ type: 'text', text: 'Cron event' }] }],
      },
      {
        id: 3, kind: 'host.user-message',
        data: { attribution: { kind: 'host', channel: 'primary', name: '任务 · Build', sourceType: 'task_dispatch' } },
        model: [{ role: 'user', content: [{ type: 'text', text: 'Dispatch event' }] }],
      },
      assistant,
      entry,
    ],
    docs: {
      'pi.live': {
        run: null,
        tools: [{ callId: 'q-live', name: 'ask_user_question', taskId: 55, status: 'running', output: '', details }],
        nestedTools: [],
      },
      'pi.inbox': { items: [] },
    },
  }, null, extras());
  const fullFrame = { type: 'snapshot', botId: 'bot', conversationId: 'public', sequence: 1, state: base };

  // Capable peer keeps everything intact.
  const fullNormalized = normalizeLiveSnapshot(structuredClone(fullFrame), { kind: 'primary', botId: 'bot' }, { liveExtensions: ALL_LIVE_EXTENSIONS });
  assert.deepEqual(fullNormalized.state.durableWaits, [identity]);
  assert.equal(fullNormalized.state.history[4].messages[0].durableWait, true);
  assert.equal(fullNormalized.state.tools[0].durableWait, true);
  assert.deepEqual(fullNormalized.state.history.slice(0, 3).map((item) => item.attribution?.sourceType), [
    'google-workspace-rule', 'schedule', 'task_dispatch',
  ]);

  // Legacy peer rejects un-downgraded frame (even empty durableWaits: []).
  assert.throws(
    () => normalizeLiveSnapshot(structuredClone(fullFrame), { kind: 'primary', botId: 'bot' }, { liveExtensions: NO_LIVE_EXTENSIONS }),
    /unknown field/,
  );
  assert.throws(
    () => normalizeLiveSnapshot(
      { type: 'snapshot', botId: 'bot', conversationId: 'public', sequence: 2, state: emptyLiveState() },
      { kind: 'primary', botId: 'bot' },
      { liveExtensions: NO_LIVE_EXTENSIONS },
    ),
    /unknown field/,
  );

  // Downgraded projection passes strict legacy validation and preserves google-workspace-rule.
  const legacyFrame = projectLiveSnapshotForPeer(fullFrame, NO_LIVE_EXTENSIONS);
  assert.equal('durableWaits' in legacyFrame.state, false);
  assert.equal('durableWait' in legacyFrame.state.history[4].messages[0], false);
  assert.equal('durableWait' in legacyFrame.state.tools[0], false);
  assert.equal(legacyFrame.state.history[0].attribution.sourceType, 'google-workspace-rule');
  assert.equal('sourceType' in legacyFrame.state.history[1].attribution, false);
  assert.equal(legacyFrame.state.history[1].attribution.kind, 'host');
  assert.equal(legacyFrame.state.history[2].attribution.sourceType, 'webhook');
  const legacyNormalized = normalizeLiveSnapshot(structuredClone(legacyFrame), { kind: 'primary', botId: 'bot' }, { liveExtensions: NO_LIVE_EXTENSIONS });
  assert.equal(legacyNormalized.state.durableWaits, undefined);
  assert.equal(legacyNormalized.state.history[0].attribution.sourceType, 'google-workspace-rule');

  // Untrusted dataBoundary on wire is rejected even when all extensions are negotiated.
  const forgedBoundary = structuredClone(fullFrame);
  forgedBoundary.state.history[0].attribution.dataBoundary = 'google-workspace';
  assert.throws(
    () => normalizeLiveSnapshot(forgedBoundary, { kind: 'primary', botId: 'bot' }, { liveExtensions: ALL_LIVE_EXTENSIONS }),
    /unknown field/,
  );
});

test('Google setup revision is a bounded primary-watch field negotiated independently of earlier extensions', () => {
  const target = { kind: 'primary', botId: 'bot' };
  const frame = {
    type: 'snapshot',
    botId: 'bot',
    conversationId: 'public',
    sequence: 1,
    state: { ...emptyLiveState(), googleSetupRevision: 6 },
  };
  const olderExtensions = { durableWaits: true, hostSources: true, browserScreencast: true };
  const older = { liveExtensions: olderExtensions };
  assert.throws(() => normalizeLiveSnapshot(structuredClone(frame), target, older), /googleSetupRevision/);
  const downgraded = projectLiveSnapshotForPeer(frame, olderExtensions);
  assert.equal(downgraded.state.history, frame.state.history);
  assert.equal(projectLiveSnapshotForPeer(downgraded, olderExtensions), downgraded);
  const normalized = normalizeLiveSnapshot(structuredClone(downgraded), target, older);
  assert.equal('googleSetupRevision' in normalized.state, false);
  assert.deepEqual(normalized.state.durableWaits, []);
  assert.equal(frame.state.googleSetupRevision, 6);

  const malformed = { ...frame, state: { ...frame.state, googleSetupRevision: '6' } };
  assert.throws(() => normalizeLiveSnapshot(malformed, target), /googleSetupRevision/);
  const work = { ...frame, scopeId: 'scope' };
  assert.throws(() => normalizeLiveSnapshot(work, { kind: 'work', botId: 'bot', scopeId: 'scope' }), /googleSetupRevision/);
});

test('runtime-live integrates reset watermarks, pre-reset failure gates, pi.compaction exclusion, and notifyWaitsChanged', async () => {
  const preResetWait = {
    id: 9,
    kind: 'pi.tool-result',
    byTaskId: 50,
    model: [{
      role: 'toolResult',
      toolName: 'ask_user_question',
      toolCallId: 'q-old',
      content: [{ type: 'text', text: 'Pre-reset wait' }],
      details: requestDetails('ask-installation', 11, '50', questions),
    }],
  };
  const resetView = {
    entries: [
      preResetWait,
      { id: 15, kind: 'pi.reset', model: [] },
      { id: 18, kind: 'pi.compaction', model: [{ role: 'user', content: [{ type: 'text', text: 'Compacted' }] }] },
      assistant,
      entry,
    ],
    docs: {
      'pi.live': {
        run: null,
        runFailure: { taskId: 12, first: 9, reason: 'error', message: 'Pre-reset failure' },
        tools: [],
        nestedTools: [],
      },
      'pi.inbox': { items: [] },
    },
  };
  let waitLive = true;
  let failureDocReads = 0;
  let preResetWaitReads = 0;
  const waits = {
    async list() {
      return waitLive
        ? [{ installationId: 'ask-installation', conversationId: 11, requestId: '55', toolTaskId: 55, status: 'pending', details }]
        : [];
    },
    async getPresentation(_botId, rawDetails) {
      if (rawDetails?.presentation?.requestId === '50') preResetWaitReads += 1;
      return waitLive
        ? { details, live: true, status: 'pending' }
        : { details: terminal, live: false, status: 'answered' };
    },
  };
  const harness = {
    async snapshot(token) {
      if (token.definition.kind === 'host.primary-index') return { byPrimary: { public: 11 } };
      if (token.definition.kind === 'host.bot-session') return { clearedThroughEntryId: 15 };
      if (token.definition.kind === 'host.generation-failure') {
        failureDocReads += 1;
        return { failure: { code: 'PROVIDER_ERROR', message: 'Pre-reset failure' } };
      }
      return null;
    },
    async conversation() {
      return {
        id: 11,
        async watch() {
          return {
            value: resetView,
            closed: new Promise(() => {}),
            start() {},
            async stop() {},
          };
        },
      };
    },
  };
  const runtimeLive = createRuntimeLive({
    host: { getBot: () => ({ botId: 'bot', primaryConversationId: 'public' }) },
    getHarness: () => harness,
    resolveWorkContext: async () => null,
    getWaits: () => waits,
  });

  let currentState = null;
  let lastFrameType = null;
  const waiters = [];
  const waitUntil = (predicate) => new Promise((resolve, reject) => {
    if (currentState !== null && predicate(currentState, lastFrameType)) return resolve(currentState);
    const timer = setTimeout(() => reject(new Error('timed out waiting for runtime-live state')), 5000);
    waiters.push((state, frameType) => {
      if (predicate(state, frameType)) {
        clearTimeout(timer);
        resolve(state);
        return true;
      }
      return false;
    });
  });
  const watch = await runtimeLive.watch('bot');
  try {
    watch.start((frame) => {
      lastFrameType = frame.type;
      currentState = frame.type === 'snapshot' ? frame.state : { ...currentState, ...frame.changes };
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i](currentState, lastFrameType)) waiters.splice(i, 1);
      }
    });
    const initial = await waitUntil((state) => state.history.length === 3 && state.durableWaits.length === 1);
    assert.equal(failureDocReads, 0);
    assert.equal(preResetWaitReads, 0);
    assert.equal(initial.activity.phase, 'idle');
    assert.deepEqual(initial.history.map((item) => item.id), [15, 21, 22]);
    assert.deepEqual(initial.durableWaits, [identity]);
    assert.equal(initial.history[2].messages[0].durableWait, true);

    waitLive = false;
    const settledPromise = waitUntil((state, frameType) =>
      frameType === 'update' &&
      state.durableWaits.length === 0 &&
      state.history[2]?.messages?.[0]?.presentation?.status === 'answered');
    runtimeLive.notifyWaitsChanged('bot');
    const settled = await settledPromise;
    assert.deepEqual(settled.durableWaits, []);
    assert.equal(settled.history[2].messages[0].presentation.status, 'answered');
    assert.equal(settled.history[2].messages[0].durableWait, undefined);
  } finally {
    await watch.stop();
    await runtimeLive.close();
  }
});
