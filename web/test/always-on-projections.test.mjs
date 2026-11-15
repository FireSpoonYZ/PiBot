import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotSessionRuntime } from '../../host-core/runtime-bot-session.js';
import { questionnaireWaitKey } from '../../host-core/bot-session-context.js';
import { overlayHistoryWaits, readPrimaryHistory } from '../../host-core/runtime-history.js';
import { emptyLiveState, projectLiveState, diffLiveState } from '../../host-core/runtime-live-projection.js';
import { projectBotBoardItem } from '../../host-core/runtime-bot-board.js';
import { normalizeLiveSnapshot } from '../../host-core/remote-live-protocol.js';
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
  let run = { taskId: 40, first: 10, inputs: [1, 2] };
  const submissions = {
    1: { id: 1, type: 'input', conversationId: 11, requestId: 'r1', entry: 10 },
    2: { id: 2, type: 'input', conversationId: 11, requestId: 'r2', entry: 12 },
  };
  const entries = {
    10: { id: 10, kind: 'host.user-message', data: { requestId: 'r1', turn: { sender: { kind: 'user' }, replyTarget: { kind: 'primary' }, stopEpoch: 3 } } },
    12: { id: 12, kind: 'host.work-trigger', data: { requestId: 'r2', turn: { kind: 'dm', scopeId: 'dm', sender: { kind: 'bot', botId: 'peer' }, replyTarget: { kind: 'dm', scopeId: 'dm', botId: 'peer' }, stopEpoch: 3 } } },
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
  assert.deepEqual(first.requestIds, ['r1', 'r2']);
  assert.deepEqual(first.submissionIds, [1, 2]);
  assert.equal(first.events[0].dispatchContext.taskId, 'global-task');
  assert.equal(first.events[1].dispatchContext, null);
  assert.equal(first.runId, 'run:["device",11,10]');
  run.taskId = 41;
  const next = await sessions.getRunContext({ conversationId: 11, taskId: 41 }, {});
  assert.equal(next.runId, first.runId);
  assert.notEqual(next.sdkExecutionId, first.sdkExecutionId);
  assert.equal(await sessions.getRunContext({ conversationId: 11, taskId: 40 }, {}), null);
  run.first = undefined;
  assert.equal((await sessions.getRunContext({ conversationId: 11 }, {})).runId, null);
});
