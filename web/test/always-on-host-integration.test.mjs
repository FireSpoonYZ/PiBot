import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createControlClient } from '../../host-core/control-client.js';
import { openControlServer } from '../../host-core/control-server.js';
import { normalizeControlCall } from '../../host-core/remote-control-protocol.js';
import { openRuntime } from '../../host-core/runtime.js';
import { openHost } from '../../host-core/host.js';
import { mcpToolName } from '../../host-core/capabilities/mcp.js';
import { PrimaryIndex } from '../../host-core/runtime-docs.js';
import { GoogleWorkspacePrivacyState } from '../../host-core/google-workspace-privacy.js';
import { createTurnAdmission } from '../../host-core/runtime-turns.js';
import { TurnPin, TurnQueue } from '../../host-core/runtime-turns-docs.js';
import { DurableWait, DurableWaitIndex } from '../../host-core/runtime-waits.js';
import { BACKGROUND_CONTEXT as context } from '../../host-core/node_modules/@earendil-works/chord/dist/context/index.js';
import { createModels } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/models.js';
import { registerApiProvider } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/compat.js';
import { createAssistantMessageEventStream } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js';
import { getCurrentTools } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js';
import { Harness, LiveDoc, createRegistry } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/index.js';
import { admitSubmission } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/harness/submissions.js';
import { openNodeSqliteStorage } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js';

const INSTALLATION = 'integration-questionnaire';
const MCP_INSTALLATION = 'integration-mcp';
const PACKAGE_ROOT = fileURLToPath(new URL('../../plugins/ask-user-question/', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'capability.json'), 'utf8'));
const QUESTION = { questions: [{
  header: 'Result', question: 'Which result should be published?',
  options: [{ label: 'Alpha', description: 'Publish the first result' },
    { label: 'Beta', description: 'Publish the second result' }],
}] };
const ask = id => ({ type: 'toolCall', id, name: 'ask_user_question', arguments: QUESTION });
const text = value => [{ type: 'text', text: value }];
function askOnce(id) {
  let issued = false;
  return async () => {
    if (!issued) { issued = true; return [ask(id)]; }
    return text('unexpected extra generation after questionnaire');
  };
}

async function until(read, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function pendingLiveQuestionnaires(liveState) {
  return (liveState?.tools ?? [])
    .map(tool => tool?.presentation)
    .filter(p => p?.kind === 'questionnaire' && p.status === 'pending');
}

// Real Host, control protocol, plugin loader, SDK task scheduler and SQLite. Only
// Center configuration/credentials and the LLM provider are replaced by fixtures.
async function hostFixture(t, { questionnaire = false, codemode = false, codemodeOnly = false, extraBots = 0, googleSetup = false, mcp = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pibot-always-on-e2e-'));
  const dataRoot = join(root, 'host');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const token = 'always_on_test_control_0123456789abcdef0123456789';
  const api = `always-on-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = { calls: [], handler: async () => text('completed'), failPrepare: false, prepareFailures: 0 };
  const stream = (model, request, options) => {
    const events = createAssistantMessageEventStream();
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let finished = false;
    const finish = (content, reason, errorMessage) => {
      if (finished) return;
      finished = true;
      const message = { role: 'assistant', content, api: model.api, provider: model.provider,
        model: model.id, usage, stopReason: reason, timestamp: Date.now(),
        ...(errorMessage ? { errorMessage } : {}) };
      events.push(reason === 'error' || reason === 'aborted'
        ? { type: 'error', reason, error: message } : { type: 'done', reason, message });
      events.end(message);
    };
    const abort = () => finish([], 'aborted', 'Fixture invocation aborted');
    queueMicrotask(async () => {
      if (options?.signal?.aborted) { abort(); return; }
      options?.signal?.addEventListener('abort', abort, { once: true });
      try {
        state.calls.push(structuredClone(request));
        const content = await state.handler(request);
        if (options?.signal?.aborted) abort();
        else finish(content, content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop');
      } catch (error) {
        finish([], 'error', error.message);
      } finally { options?.signal?.removeEventListener('abort', abort); }
    });
    return events;
  };
  registerApiProvider({ api, stream, streamSimple: stream }, api);
  let server;
  let client;
  let bot;
  let snapshot;
  const centerClient = { providerAuth: async () => ({ auth: { apiKey: 'fixture-key' }, source: 'center' }), ...mcp };
  const centerRuntime = {
    snapshot: { protocol: 1 },
    ...(googleSetup ? {
      centerUrl: 'https://center.example.test',
      getGoogleStatus: async () => ({ reachable: true, isAdmin: true, client: { configured: false }, accounts: [] }),
    } : {}),
    installer: {
      async getInstalled(id, selector) {
        assert.equal(id, INSTALLATION);
        if (selector?.version !== undefined) assert.equal(selector.version, MANIFEST.version);
        return { version: MANIFEST.version, packageRoot: PACKAGE_ROOT,
          dataDir: join(root, 'questionnaire-data'), manifest: MANIFEST };
      },
    },
    getClient: () => centerClient,
    prepareTurn: async () => {
      if (state.failPrepare) {
        state.prepareFailures += 1;
        throw Object.assign(new Error('Fixture admission transport unavailable'), { code: 'CENTER_OFFLINE' });
      }
      return { setId: `set-${snapshot.revision}`, snapshot };
    },
    confirmTurn: async ({ requestId, setId }) => ({ admissionId: `admission-${requestId}`, setId }),
    restoreTurn: async () => ({ setId: `set-${snapshot.revision}`, snapshot }),
  };
  const makeSnapshot = (revision, bots) => ({
    protocol: 1, deviceId: server.deviceId, revision,
    providers: [{ id: 'fixture-provider', name: 'Fixture', api, baseUrl: 'http://127.0.0.1:9', enabled: true, credentialRef: null }],
    models: { 'fixture-provider': [{ id: 'fixture-model', name: 'Fixture', api,
      contextWindow: 128000, maxTokens: 4096, input: ['text'], reasoning: false, enabled: true, revision: 1 }] },
    credentials: {}, bots,
  });
  async function start() {
    const opening = await openControlServer({ port: 0, token, deferResume: true, dataRoot,
      nativeBridge: async () => ({}), centerRuntime,
      ...(googleSetup ? { createBrowserProvider: () => {
        let url = null;
        return {
          async perform(input) {
            if (input.action === 'open') url = input.url;
            return {
              available: true, canStreamInteract: true,
              ...(url ? { pageId: 'fixture-google-page', url } : {}),
              tabs: url ? [{ id: 'fixture-google-page', url }] : [],
            };
          },
          async close() {},
        };
      } } : {}),
    });
    server = opening;
    try {
      client = createControlClient({ url: opening.url, token });
      snapshot ??= makeSnapshot(1, []);
      assert.equal(opening.deviceId, snapshot.deviceId);
      const applied = await opening.applyCenterSnapshot(snapshot);
      if (!bot) assert.equal(applied.status, 'applied', JSON.stringify(applied));
      else assert.ok(['applied', 'waiting-idle'].includes(applied.status), JSON.stringify(applied));
      // An abort-marked native task is still live while scheduling is paused.
      // Restore its pinned configuration before activation/resume, even when
      // applying the current snapshot must wait for that task to become idle.
      await opening.restoreTurns();
      await opening.setCenterOnline(true);
      opening.resume();
    } catch (error) {
      server = null;
      client = null;
      try { await opening.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], 'Fixture Host startup and cleanup failed'); }
      throw error;
    }
  }
  t.after(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await start();
  bot = await client.createBot({ requestId: 'fixture-create', role: 'Integration Assistant', cwd, makePrimary: true });
  const peerBots = [];
  for (let i = 0; i < extraBots; i += 1) {
    peerBots.push(await client.createBot({
      requestId: `fixture-create-peer-${i}`, role: `Peer Assistant ${i}`, cwd, makePrimary: false,
    }));
  }
  const botConfigs = [bot, ...peerBots].map(item => ({
    botId: item.botId, cwd,
    model: { modelRef: 'fixture-provider/fixture-model', thinkingLevel: 'off', codemode, codemodeOnly },
    capabilities: [
      ...(questionnaire ? [{ installationId: INSTALLATION, kind: 'plugin', target: 'host',
        targetVersion: MANIFEST.version, enabled: true, authorized: true, effectiveConfig: {}, credentialRefs: [] }] : []),
      ...(mcp ? [{ installationId: MCP_INSTALLATION, kind: 'mcp', target: 'center',
        targetVersion: '1.0.0', enabled: true, authorized: true, effectiveConfig: {}, credentialRefs: [] }] : []),
    ],
  }));
  snapshot = makeSnapshot(2, botConfigs);
  const applied = await server.applyCenterSnapshot(snapshot);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  return {
    bot, peerBots, state,
    get server() { return server; },
    get client() { return client; },
    async restart() { await server.close(); server = null; await start(); },
    watchLive(targetBotId = bot.botId) {
      const controller = new AbortController();
      let current = null;
      const loop = (async () => {
        try {
          for await (const frame of client.live(targetBotId, { signal: controller.signal })) {
            if (frame.type === 'snapshot') current = frame.state;
            else if (frame.type === 'update' && current) current = { ...current, ...frame.changes };
          }
        } catch { /* closed on stop or teardown */ }
      })();
      const stop = async () => {
        if (!controller.signal.aborted) controller.abort();
        await loop;
      };
      t.after(stop);
      return { get state() { return current; }, stop };
    },
    async whileStopped(read) {
      await server.close();
      server = null;
      const storage = await openNodeSqliteStorage(join(dataRoot, 'durable.sqlite'));
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
      try { return await read(harness); }
      finally { await harness.close(context); await start(); }
    },
    async done(requestId) {
      return until(async () => {
        let receipt;
        try { receipt = await client.getSubmission(bot.botId, requestId); }
        catch (error) { if (error.code === 'SUBMISSION_NOT_FOUND') return null; throw error; }
        if (receipt.status === 'unanswered') assert.fail(`Unexpected unanswered submission ${requestId}: ${JSON.stringify(receipt)}`);
        return receipt.status === 'done' ? receipt : null;
      }, `completed submission ${requestId}`);
    },
    async history() { return (await client.history(bot.botId, { limit: 200 })).items; },
    async answer(presentation, requestId, selected = 0) {
      const { result } = await client.callCapabilityAction({ installationId: INSTALLATION, action: 'answerQuestionnaire',
        request: { requestId, deviceId: server.deviceId, botId: bot.botId,
          input: { conversationId: presentation.conversationId, requestId: presentation.requestId,
            cancelled: false, answers: [{ questionIndex: 0, selectedOptions: [selected] }] } } });
      return result;
    },
  };
}

function questionnaires(entries) {
  return entries.flatMap(entry => (entry.model ?? []).filter(message =>
    message.role === 'toolResult' && message.details?.presentation?.kind === 'questionnaire')
    .map(message => ({ entry, message, presentation: message.details.presentation })));
}

function waitId(bot, presentation) {
  return createHash('sha256').update(JSON.stringify([
    bot.primaryConversationId, INSTALLATION, presentation.conversationId, presentation.requestId,
  ])).digest('hex');
}

function resumeRequestId(bot, presentation) {
  return `wait-${waitId(bot, presentation).slice(0, 40)}`;
}

test('managed MCP tools are declared and callable after tool_search, not upfront', async t => {
  const remoteName = 'catalog_probe';
  const calls = [];
  const f = await hostFixture(t, { mcp: {
    async listCapabilityTools() {
      return { tools: [{ name: remoteName, description: 'Look up a catalog item',
        inputSchema: { type: 'object', properties: {} } }] };
    },
    async callCapabilityTool(installationId, botId, name, args) {
      calls.push({ installationId, botId, name, args });
      return { content: text('catalog result') };
    },
  } });
  const toolName = mcpToolName(MCP_INSTALLATION, f.bot.botId, remoteName);
  f.state.handler = () => {
    if (f.state.calls.length === 1) {
      return [{ type: 'toolCall', id: 'find-catalog', name: 'tool_search', arguments: { query: remoteName, limit: 1 } }];
    }
    if (f.state.calls.length === 2) {
      return [{ type: 'toolCall', id: 'use-catalog', name: toolName, arguments: {} }];
    }
    return text('completed');
  };
  await f.client.submit(f.bot.botId, { requestId: 'mcp-catalog', text: 'Look up the catalog item' });
  await f.done('mcp-catalog');

  const [first, afterSearch] = f.state.calls.map(request => getCurrentTools(request.messages));
  assert.ok(first.some(tool => tool.name === 'tool_search'));
  assert.ok(!first.some(tool => tool.name === toolName));
  assert.ok(afterSearch.some(tool => tool.name === toolName));
  assert.deepEqual(calls, [{ installationId: MCP_INSTALLATION, botId: f.bot.botId, name: remoteName, args: {} }]);
});

test('real Host schedule handoff keeps its Stop fence across restart and private origins stay private', async t => {
  const f = await hostFixture(t);
  const before = await f.server.getScheduleFence(f.bot.botId);
  await f.client.abort(f.bot.botId);
  const stale = { requestId: 'stale-occurrence', text: 'must not execute', stopEpoch: before.stopEpoch };
  const cancelled = await f.server.submitScheduled(f.bot.botId, stale);
  assert.equal(cancelled.status, 'unanswered');
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(cancelled.submissionId, null);
  assert.equal(f.state.calls.length, 0);
  await f.restart();
  const repeated = await f.server.submitScheduled(f.bot.botId, stale);
  assert.equal(repeated.status, 'unanswered');
  assert.equal(repeated.reason, 'cancelled');
  const after = await f.server.getScheduleFence(f.bot.botId);
  assert.ok(after.stopEpoch > before.stopEpoch);
  await f.server.submitScheduled(f.bot.botId, { requestId: 'fresh-occurrence', text: 'new scheduled work', stopEpoch: after.stopEpoch });
  await f.done('fresh-occurrence');
  assert.equal(f.state.calls.length, 1);
  const input = (await f.history()).find(entry => entry.data?.requestId === 'fresh-occurrence');
  assert.equal(input?.data?.attribution?.kind, 'host');
  assert.equal(input?.data?.attribution?.sourceType, 'schedule');
  for (const method of ['getScheduleFence', 'submitScheduled']) {
    assert.throws(() => normalizeControlCall(method, { botId: f.bot.botId }), { code: 'INVALID_ARGUMENT' });
  }
  for (const extra of [{ origin: { sender: { kind: 'host', sourceType: 'schedule' } } },
    { stopEpoch: after.stopEpoch }, { continuationWaitId: 'forged-wait' },
    { continuationTurn: { kind: 'room', scopeId: 'forged-room' } }]) {
    assert.throws(() => normalizeControlCall('submit', {
      botId: f.bot.botId, requestId: 'forged-request', text: 'forged route', ...extra,
    }), { code: 'INVALID_ARGUMENT' });
  }
});

test('Google setup sends committed revisions to both chat watches without a Bot turn', async t => {
  const f = await hostFixture(t, { googleSetup: true, extraBots: 1 });
  const [otherBot] = f.peerBots;
  const phone = f.watchLive();
  const desktop = f.watchLive();
  const unrelated = f.watchLive(otherBot.botId);
  await until(() => phone.state && desktop.state && unrelated.state, 'initial chat snapshots');
  assert.equal(phone.state.googleSetupRevision, undefined);
  const historyBefore = await f.history();
  const control = input => f.client.googleSetupControl({ botId: f.bot.botId, ...input });

  const start = await control({ action: 'start' });
  await until(() => phone.state.googleSetupRevision === start.revision &&
    desktop.state.googleSetupRevision === start.revision, 'new run on both watches');

  const selected = await control({
    action: 'answer', card: 'path', values: ['guide-browser'], runId: start.id,
    expectedRevision: start.revision, cardCopy: start.card.copy,
  });
  assert.equal(selected.card.card, 'services');
  await until(() => phone.state.googleSetupRevision === selected.revision &&
    desktop.state.googleSetupRevision === selected.revision, 'next card on both watches');
  assert.equal((await control({ action: 'status' })).revision, selected.revision);

  const reconnected = f.watchLive();
  await until(() => reconnected.state?.googleSetupRevision === selected.revision, 'revision in a new watch snapshot');
  const cancelled = await control({ action: 'cancel', runId: start.id, expectedRevision: selected.revision });
  assert.equal(cancelled.state, 'cancelled');
  await until(() => phone.state.googleSetupRevision === cancelled.revision &&
    desktop.state.googleSetupRevision === cancelled.revision &&
    reconnected.state.googleSetupRevision === cancelled.revision, 'cancellation on all watches');
  assert.equal(unrelated.state.googleSetupRevision, undefined);
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual(await f.history(), historyBefore);
});

test('Google setup waits for services, then resumes the Bot on sign-in confirmation and Continue', async t => {
  const f = await hostFixture(t, { googleSetup: true });
  const control = input => f.client.googleSetupControl({ botId: f.bot.botId, ...input });
  const requestId = (view) => 'google-setup-' +
    createHash('sha256').update(JSON.stringify([view.id, view.revision])).digest('hex');

  const start = await control({ action: 'start' });
  const path = await control({
    action: 'answer', card: 'path', values: ['do-it-for-me'], runId: start.id,
    expectedRevision: start.revision, cardCopy: start.card.copy,
  });
  assert.equal(path.card.card, 'services');
  assert.equal(path.resumeQueued, undefined);
  const account = await control({
    action: 'answer', card: 'services', values: ['gmail'], runId: start.id,
    expectedRevision: path.revision, cardCopy: path.card.copy,
  });
  assert.equal(account.step, 'account');
  assert.equal(account.resumeQueued, true);
  await f.done(requestId(account));

  const confirmation = {
    action: 'advance', step: 'account', runId: start.id, expectedRevision: account.revision,
  };
  const project = await control(confirmation);
  assert.equal(project.id, start.id);
  assert.equal(project.steps.account.status, 'done');
  assert.equal(project.step, 'project');
  assert.equal(project.resumeQueued, true);
  const duplicate = await control(confirmation);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.resumeQueued, undefined);
  const stale = await control({ ...confirmation, runId: 'previous-run' });
  assert.equal(stale.stale, true);
  assert.equal(stale.resumeQueued, undefined);
  await f.done(requestId(project));
  const prompt = f.state.calls[1].messages.find(message =>
    message.role !== 'system' && JSON.stringify(message.content).includes('Card google-setup/step answered: done, account'));
  assert.ok(prompt, 'the Bot receives the saved login confirmation');
  const history = await f.history();
  const entry = history.find(item => item.data?.requestId === requestId(project));
  assert.equal(entry.kind, 'host.work-trigger');
  assert.equal(entry.data.attribution.kind, 'host');
  assert.deepEqual(entry.data.turn.replyTarget, { kind: 'primary' });

  const resume = await control({
    action: 'answer', card: 'step', values: ['resume'], runId: start.id, expectedRevision: project.revision,
  });
  assert.equal(resume.step, 'project');
  assert.equal(resume.resumeQueued, true);
  await f.done(requestId(resume));
  assert.equal(f.state.calls.length, 3);
});

test('choosing the Google audience queues one automatic branding continuation through the real Host', async t => {
  const f = await hostFixture(t, { googleSetup: true });
  const control = input => f.client.googleSetupControl({ botId: f.bot.botId, ...input });
  const run = await control({ action: 'start', mode: 'do-it-for-me', choices: ['gmail'] });
  await control({ action: 'advance', step: 'account', account: 'owner@example.com' });
  await control({ action: 'advance', step: 'project', projectId: 'test-cloud-project' });
  const branding = await control({ action: 'advance', step: 'apis' });
  assert.equal(branding.card.card, 'kind');
  const answer = {
    action: 'answer', card: 'kind', values: ['personal'], runId: run.id,
    expectedRevision: branding.revision, cardCopy: branding.card.copy,
  };

  const chosen = await control(answer);
  assert.equal(chosen.id, run.id);
  assert.equal(chosen.kind, 'personal');
  assert.equal(chosen.resumeQueued, true);
  const retry = await control(answer);
  assert.equal(retry.applied, false);
  const digest = createHash('sha256').update(JSON.stringify([run.id, chosen.revision])).digest('hex');
  await f.done(`google-setup-${digest}`);
  assert.equal(f.state.calls.length, 1);
  assert.ok(f.state.calls[0].messages.some(message =>
    message.role !== 'system' && JSON.stringify(message.content).includes('Card google-setup/kind answered: personal')));
});

test('real questionnaire releases its SDK run, survives restart and resumes its original route exactly once', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  let issue = true;
  f.state.handler = async () => {
    if (issue) { issue = false; return [ask('single-question')]; }
    return text('unexpected extra generation');
  };
  await f.client.submit(f.bot.botId, { requestId: 'original-work', text: 'ask for the publishing choice' });
  await f.done('original-work');
  assert.equal(f.state.calls.length, 1, 'publishing the question must terminate the current SDK run');
  const [question] = questionnaires(await f.history());
  assert.ok(question);
  assert.equal(question.presentation.status, 'pending');
  assert.equal(question.message.durableWait, true);

  f.state.handler = async () => text('unrelated work complete');
  await f.client.submit(f.bot.botId, { requestId: 'unrelated-work', text: 'a separate quick request' });
  await f.done('unrelated-work');
  assert.equal(f.state.calls.length, 2, 'the waiting questionnaire must not occupy the Bot');
  assert.equal(questionnaires(await f.history())[0].presentation.status, 'pending');

  // A completed tool task can no longer own the questionnaire. Opening a fresh
  // Runtime proves that the action is reading the persistent Host wait instead.
  await f.restart();
  const [restored] = questionnaires(await f.history());
  assert.equal(restored.presentation.status, 'pending');
  assert.equal(restored.message.durableWait, true);
  f.state.handler = async () => text('resumed original publishing work');
  const answers = await Promise.all([
    f.answer(restored.presentation, 'answer-first', 0),
    f.answer(restored.presentation, 'answer-retry', 0),
  ]);
  assert.deepEqual(answers.map(answer => answer.status).sort(), ['answered', 'settled']);
  const resumedId = resumeRequestId(f.bot, restored.presentation);
  await f.done(resumedId);
  assert.equal(f.state.calls.length, 3, 'duplicate answers must not cause another run');
  const history = await f.history();
  const continuations = history.filter(entry => entry.data?.requestId === resumedId);
  assert.equal(continuations.length, 1);
  const continuation = continuations[0];
  assert.equal(continuation.data.attribution.kind, 'host');
  assert.equal(continuation.data.attribution.channel, 'primary');
  assert.deepEqual(continuation.data.turn.replyTarget, { kind: 'primary' });
  assert.equal(continuation.data.turn.originRequestId, 'original-work');
  assert.match(JSON.stringify(continuation.model), /Alpha/);
  assert.equal(questionnaires(history)[0].presentation.status, 'answered');
  assert.equal(questionnaires(history)[0].message.durableWait, false);

  await f.restart();
  assert.deepEqual(await f.answer(restored.presentation, 'answer-after-restart', 1), { status: 'settled' });
  await f.done(resumedId);
  assert.equal(f.state.calls.length, 3);
  assert.equal((await f.history()).filter(entry => entry.data?.requestId === resumedId).length, 1);
});

test('an answered questionnaire survives restart while its continuation is waiting for Center admission', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  f.state.handler = askOnce('question-before-admission-failure');
  await f.client.submit(f.bot.botId, { requestId: 'recover-answer-work', text: 'ask before a transient admission failure' });
  await f.done('recover-answer-work');
  const [question] = questionnaires(await f.history());
  f.state.failPrepare = true;
  assert.deepEqual(await f.answer(question.presentation, 'durable-answer'), { status: 'answered' });
  const resumedId = resumeRequestId(f.bot, question.presentation);
  await until(() => f.state.prepareFailures > 0, 'blocked continuation admission');
  const pending = await f.client.getSubmission(f.bot.botId, resumedId);
  assert.equal(pending.status, 'queued');
  assert.equal(pending.submissionId, null);
  assert.equal(questionnaires(await f.history())[0].presentation.status, 'answered');
  assert.equal(f.state.calls.length, 1);

  f.state.failPrepare = false;
  f.state.handler = async () => text('persisted answer recovered');
  await f.restart();
  assert.deepEqual(await f.answer(question.presentation, 'duplicate-durable-answer'), { status: 'settled' });
  await f.done(resumedId);
  assert.equal(f.state.calls.length, 2);
  assert.equal((await f.history()).filter(entry => entry.data?.requestId === resumedId).length, 1);
});

test('real questionnaire multi-tool model round preserves live-task fallback without creating a durable wait', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  let issued = false;
  f.state.handler = async () => {
    if (!issued) { issued = true; return [ask('question-a'), ask('question-b')]; }
    return text('Multi-tool answers received in-band.');
  };
  const live = f.watchLive();
  await f.client.submit(f.bot.botId, { requestId: 'multi-tool-work', text: 'ask two questions in one round' });
  const answeredIds = new Set();
  await until(async () => {
    for (const pending of pendingLiveQuestionnaires(live.state)) {
      if (!answeredIds.has(pending.requestId)) {
        answeredIds.add(pending.requestId);
        const reply = await f.answer(pending, `answer-multi-${pending.requestId}`, 0);
        assert.equal(reply.status, 'answered');
      }
    }
    try {
      const receipt = await f.client.getSubmission(f.bot.botId, 'multi-tool-work');
      return receipt.status === 'done' ? receipt : null;
    } catch (error) {
      if (error.code === 'SUBMISSION_NOT_FOUND') return null;
      throw error;
    }
  }, 'multi-tool live-task questionnaires answered and turn completed');
  await live.stop();
  assert.equal(answeredIds.size, 2);
  assert.equal(f.state.calls.length, 2);
  const history = await f.history();
  const cards = questionnaires(history);
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.equal(card.presentation.status, 'answered');
    assert.notEqual(card.message.isError, true);
    assert.notEqual(card.message.durableWait, true);
    assert.doesNotMatch(JSON.stringify(card.message.content), /execution is paused|Bot is free/i);
  }
  assert.equal(history.some(entry => String(entry.data?.requestId ?? '').startsWith('wait-')), false);
  await f.whileStopped(async harness => {
    const index = await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context);
    assert.deepEqual(Object.keys(index?.active ?? {}), []);
    for (const card of cards) {
      assert.equal(await harness.snapshot(DurableWait, waitId(f.bot, card.presentation), context) ?? null, null);
    }
  });
});

test('real Host Stop cancels a released questionnaire and a late answer stays inert after restart', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  f.state.handler = askOnce('question-to-cancel');
  await f.client.submit(f.bot.botId, { requestId: 'work-to-cancel', text: 'ask then stop' });
  await f.done('work-to-cancel');
  assert.equal(f.state.calls.length, 1);
  const [question] = questionnaires(await f.history());
  assert.equal(question.presentation.status, 'pending');
  await f.client.abort(f.bot.botId);
  assert.equal(questionnaires(await f.history())[0].presentation.status, 'cancelled');
  await f.restart();
  assert.deepEqual(await f.answer(question.presentation, 'late-answer'), { status: 'settled' });
  assert.equal(questionnaires(await f.history())[0].message.durableWait, false);
  f.state.handler = async () => text('new work after Stop');
  await f.client.submit(f.bot.botId, { requestId: 'new-work-after-stop', text: 'fresh work' });
  await f.done('new-work-after-stop');
  assert.equal(f.state.calls.length, 2);
  const resumedId = resumeRequestId(f.bot, question.presentation);
  assert.equal((await f.history()).some(entry => entry.data?.requestId === resumedId), false);
});

test('editing the original message retains prior privacy markers and retires its pending questionnaire atomically', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  // A retained predecessor forces the actual fork path instead of creating an
  // empty conversation when the edited message is the first transcript entry.
  await f.client.submit(f.bot.botId, { requestId: 'before-edit', text: 'retain this earlier exchange' });
  await f.done('before-edit');
  f.state.handler = askOnce('question-before-edit');
  await f.client.submit(f.bot.botId, { requestId: 'question-work-to-edit', text: 'ask for a publishing choice' });
  await f.done('question-work-to-edit');
  const originalHistory = await f.history();
  const originalInput = originalHistory.find(entry => entry.data?.requestId === 'question-work-to-edit');
  const [question] = questionnaires(originalHistory);
  assert.ok(originalInput);
  assert.equal(question.presentation.status, 'pending');
  assert.equal(f.state.calls.length, 2);
  const before = await f.server.getScheduleFence(f.bot.botId);
  const retainedInput = originalHistory.find(entry => entry.data?.requestId === 'before-edit');
  assert.ok(retainedInput);
  await f.whileStopped(harness => harness.commit(async tx => {
    const privacy = await tx.doc(GoogleWorkspacePrivacyState, question.presentation.conversationId);
    privacy.earliestByReset['0'] = {
      turnStartEntryId: retainedInput.id, anchorEntryId: retainedInput.id,
      recordedAt: new Date().toISOString(),
    };
  }, context));

  // A rejected edit must leave the old conversation's live question intact.
  await assert.rejects(f.client.editMessage(f.bot.botId, {
    entryId: question.entry.id, requestId: 'invalid-question-edit', text: 'cannot edit a tool result',
  }), { code: 'INVALID_ARGUMENT' });
  assert.equal(questionnaires(await f.history())[0].presentation.status, 'pending');

  f.state.handler = async () => text('replacement input completed');
  await f.client.editMessage(f.bot.botId, {
    entryId: originalInput.id, requestId: 'replacement-after-edit', text: 'publish without asking the old question',
  });
  await f.done('replacement-after-edit');
  const editedHistory = await f.history();
  assert.ok(editedHistory.some(entry => entry.data?.requestId === 'before-edit'));
  assert.equal(editedHistory.some(entry => entry.data?.requestId === 'question-work-to-edit'), false);
  assert.equal(questionnaires(editedHistory).length, 0, 'the fork must not inherit an answerable wait');
  assert.equal(f.state.calls.length, 3);
  assert.equal((await f.server.getScheduleFence(f.bot.botId)).stopEpoch, before.stopEpoch);

  await f.whileStopped(async harness => {
    const current = await harness.snapshot(PrimaryIndex, context);
    const forkedId = current.byPrimary[f.bot.primaryConversationId];
    assert.notEqual(forkedId, question.presentation.conversationId);
    const privacy = await harness.snapshot(GoogleWorkspacePrivacyState, forkedId, context);
    assert.equal(privacy?.earliestByReset['0']?.turnStartEntryId, retainedInput.id);
    const key = waitId(f.bot, question.presentation);
    const previous = (await harness.snapshot(DurableWait, key, context)).record;
    assert.equal(previous.status, 'cancelled');
    assert.equal(previous.resume.state, 'cancelled');
    assert.equal((await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context)).active[key], undefined);
  });
  // Old cards can be rejected by ownership before reaching the settled wait;
  // neither valid outcome may enqueue an answer into the replacement history.
  try {
    assert.deepEqual(await f.answer(question.presentation, 'late-answer-after-edit'), { status: 'settled' });
  } catch (error) {
    assert.equal(error.code, 'BOT_CONTEXT_REQUIRED');
  }
  f.state.handler = async () => text('new conversation remains usable');
  await f.client.submit(f.bot.botId, { requestId: 'fresh-work-after-edit', text: 'continue in the edited conversation' });
  await f.done('fresh-work-after-edit');
  assert.equal(f.state.calls.length, 4);
  assert.equal((await f.history()).some(entry => entry.data?.requestId === resumeRequestId(f.bot, question.presentation)), false);
});

test('cold Host startup recovers cancellation intent before an already placed SDK continuation can run', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  f.state.handler = askOnce('question-before-cancel-crash');
  await f.client.submit(f.bot.botId, { requestId: 'work-before-cancel-crash', text: 'ask before the cancellation crash point' });
  await f.done('work-before-cancel-crash');
  const [question] = questionnaires(await f.history());
  const key = waitId(f.bot, question.presentation);
  const resumedId = resumeRequestId(f.bot, question.presentation);
  const before = await f.server.getScheduleFence(f.bot.botId);
  f.state.failPrepare = true;
  assert.deepEqual(await f.answer(question.presentation, 'answer-before-cancel-crash'), { status: 'answered' });
  await until(() => f.state.prepareFailures > 0, 'continuation queued before crash seeding');
  assert.equal((await f.client.getSubmission(f.bot.botId, resumedId)).status, 'queued');

  const native = await f.whileStopped(async harness => {
    const pinSnapshot = await harness.snapshot(TurnPin, f.bot.primaryConversationId, context);
    const originalPin = Object.values(pinSnapshot.admissions).find(pin => pin.requestId === 'work-before-cancel-crash');
    assert.ok(originalPin);
    const admitted = await harness.commit(async tx => {
      const doc = await tx.doc(DurableWait, key, {});
      assert.equal(doc.record.status, 'answered');
      const queue = await tx.doc(TurnQueue, f.bot.primaryConversationId, {});
      const queuedIndex = queue.items.findIndex(item => item.requestId === resumedId);
      assert.ok(queuedIndex >= 0);
      // Seed the exact durable boundary after native acceptance but before the
      // persisted cancellation has called back into the SDK. Calling the SDK's
      // transaction implementation avoids submit()'s implicit scheduler resume;
      // it still creates the real submission, generation task and LiveDoc run.
      // This pinned-SDK internal API is only a test crash-state fixture: both
      // public submit overloads resume scheduling. Production uses public APIs.
      const result = await admitSubmission(tx, question.presentation.conversationId, {
        type: 'input', requestId: resumedId, content: doc.record.resume.input.text,
      }, Date.now(), { steeringMode: 'all', followUpMode: 'one' });
      assert.equal(result.status, 'placed');
      queue.items.splice(queuedIndex, 1);
      const admissionId = `admission-${resumedId}`;
      const pins = await tx.doc(TurnPin, f.bot.primaryConversationId, {});
      pins.admissions[admissionId] = { ...originalPin, admissionId,
        requestId: resumedId, submissionId: result.id, admittedAt: new Date().toISOString() };
      const record = doc.record;
      record.status = 'cancelled';
      record.reason = 'stopped';
      record.settledAt = Date.now();
      record.resume = { ...record.resume, state: 'cancelling', acceptedAt: Date.now() };
      record.result = { answers: [], cancelled: true };
      record.details.presentation.status = 'cancelled';
      record.details.presentation.result = { answers: [], cancelled: true };
      const index = await tx.doc(DurableWaitIndex, f.bot.primaryConversationId, {});
      assert.ok(index.active[key], 'the durable cancellation must remain reachable for recovery');
      return result;
    }, context);
    const live = await harness.snapshot(LiveDoc, question.presentation.conversationId, context);
    assert.deepEqual(live.run.inputs, [admitted.id]);
    assert.equal((await harness.inspect(context)).scheduling, 'paused');
    assert.equal(f.state.calls.length, 1);
    f.state.failPrepare = false;
    f.state.handler = async () => text('fresh work after recovered cancellation');
    return { submissionId: admitted.id, taskId: live.run.taskId };
  });
  const cancelled = await until(async () => {
    const receipt = await f.client.getSubmission(f.bot.botId, resumedId);
    assert.notEqual(receipt.status, 'done', 'recovery must cancel before the provider can answer');
    return receipt.status === 'unanswered' ? receipt : null;
  }, 'native continuation cancellation after cold startup');
  assert.equal(cancelled.submissionId, native.submissionId);
  assert.equal(cancelled.reason, 'aborted');
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(await f.answer(question.presentation, 'late-answer-after-cancel-crash'), { status: 'settled' });
  assert.equal((await f.server.getScheduleFence(f.bot.botId)).stopEpoch, before.stopEpoch);

  await f.whileStopped(async harness => {
    const record = (await harness.snapshot(DurableWait, key, context)).record;
    assert.equal(record.status, 'cancelled');
    assert.equal(record.resume.state, 'cancelled');
    assert.equal((await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context)).active[key], undefined);
    const task = await harness.getTask(native.taskId, context);
    assert.equal(task.state.status, 'terminal');
    assert.equal(task.state.outcome.status, 'aborted');
  });
  await f.client.submit(f.bot.botId, { requestId: 'fresh-work-after-cancel-crash', text: 'unrelated work may still run' });
  await f.done('fresh-work-after-cancel-crash');
  assert.equal(f.state.calls.length, 2, 'the cancelled native continuation must never call the provider');
});

test('real TurnQueue transaction rejects a cancelled wait continuation and unsupported experimental task/room waits without consuming the Bot stop epoch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pibot-cancelled-wait-admission-'));
  const dbPath = join(root, 'durable.sqlite');
  let harness;
  let turns;
  t.after(async () => {
    turns?.close();
    await harness?.close(context);
    rmSync(root, { recursive: true, force: true });
  });
  const bot = { botId: 'bot-a', deviceId: 'device-a', primaryConversationId: 'primary-a' };
  const host = { deviceId: bot.deviceId, getBot: id => id === bot.botId ? bot : null, listBots: () => [bot] };
  async function open() {
    const storage = await openNodeSqliteStorage(dbPath);
    harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
    turns = createTurnAdmission({ host, getHarness: () => harness, context,
      initializeBot: async () => {}, canAdmit: () => false });
    await turns.pendingStops();
  }
  await open();
  await harness.commit(async tx => {
    (await tx.doc(DurableWait, 'cancelled-scope-wait', {})).record = {
      botId: bot.botId, stopEpoch: 0, status: 'cancelled', reason: 'stopped',
      resumeRequestId: 'wait-continuation',
      resume: { state: 'cancelled', input: { requestId: 'wait-continuation', text: 'late answer' } },
    };
    (await tx.doc(DurableWait, 'experimental-room-task-wait', {})).record = {
      botId: bot.botId, stopEpoch: 0, status: 'answered', reason: 'user',
      turn: {
        requestId: 'legacy-room-req', kind: 'room', scopeId: 'legacy-room',
        replyTarget: { kind: 'room', scopeId: 'legacy-room' },
        sender: { kind: 'user', deviceId: 'device-a' },
      },
      dispatchContext: { taskId: 'legacy-global-task', stepId: 'step-1', executionRevision: 1 },
      resumeRequestId: 'wait-experimental-room-task',
      resume: { state: 'pending', input: { requestId: 'wait-experimental-room-task', text: 'experimental answer' } },
    };
  }, context);
  const input = { requestId: 'wait-continuation', text: 'late answer', stopEpoch: 0,
    origin: { sender: { kind: 'host' }, replyTo: null }, continuationWaitId: 'cancelled-scope-wait',
    continuationTurn: { kind: 'room', scopeId: 'stopped-room', replyTarget: { kind: 'room', scopeId: 'stopped-room' } } };
  const unsupportedInput = { requestId: 'wait-experimental-room-task', text: 'experimental answer', stopEpoch: 0,
    origin: { sender: { kind: 'host' }, replyTo: null }, continuationWaitId: 'experimental-room-task-wait',
    continuationTurn: { kind: 'room', scopeId: 'legacy-room', replyTarget: { kind: 'room', scopeId: 'legacy-room' } } };
  const rejected = await turns.enqueue(bot.botId, input);
  assert.equal(rejected.status, 'unanswered');
  assert.equal(rejected.reason, 'cancelled');
  const rejectedUnsupported = await turns.enqueue(bot.botId, unsupportedInput);
  assert.equal(rejectedUnsupported.status, 'unanswered');
  assert.equal(rejectedUnsupported.reason, 'cancelled');
  assert.equal(turns.stopEpoch(bot.botId), 0, 'scope/unsupported cancellation must not stop unrelated Bot work');
  assert.equal(await turns.queuedCount(bot), 0);
  turns.close();
  await harness.close(context);
  harness = null;
  await open();
  const retried = await turns.enqueue(bot.botId, input);
  assert.equal(retried.status, 'unanswered');
  assert.equal(retried.reason, 'cancelled');
  const retriedUnsupported = await turns.enqueue(bot.botId, unsupportedInput);
  assert.equal(retriedUnsupported.status, 'unanswered');
  assert.equal(retriedUnsupported.reason, 'cancelled');
  assert.equal(await turns.queuedCount(bot), 0);
  const inspection = await harness.inspect(context);
  assert.equal(inspection.tasks.length, 0);
  assert.equal(inspection.submissions.length, 0);
});

async function runtimeFixture(t, { questionnaire = true, codemode = false, codemodeOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pibot-always-on-rt-'));
  const dataRoot = join(root, 'host');
  const cwd = join(root, 'workspace');
  mkdirSync(cwd, { recursive: true });
  const api = `always-on-rt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = { calls: [], handler: async () => text('completed') };
  const stream = (model, request, options) => {
    const events = createAssistantMessageEventStream();
    const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let finished = false;
    const finish = (content, reason, errorMessage) => {
      if (finished) return;
      finished = true;
      const message = { role: 'assistant', content, api: model.api, provider: model.provider,
        model: model.id, usage, stopReason: reason, timestamp: Date.now(),
        ...(errorMessage ? { errorMessage } : {}) };
      events.push(reason === 'error' || reason === 'aborted'
        ? { type: 'error', reason, error: message } : { type: 'done', reason, message });
      events.end(message);
    };
    const abort = () => finish([], 'aborted', 'Fixture invocation aborted');
    queueMicrotask(async () => {
      if (options?.signal?.aborted) { abort(); return; }
      options?.signal?.addEventListener('abort', abort, { once: true });
      try {
        state.calls.push(structuredClone(request));
        const content = await state.handler(request);
        if (options?.signal?.aborted) abort();
        else finish(content, content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop');
      } catch (error) {
        finish([], 'error', error.message);
      } finally { options?.signal?.removeEventListener('abort', abort); }
    });
    return events;
  };
  registerApiProvider({ api, stream, streamSimple: stream }, api);
  let runtime;
  const storedHost = openHost({ dataRoot });
  const { deviceId } = storedHost;
  storedHost.close();
  let bot;
  let snapshot;
  const centerClient = { providerAuth: async () => ({ auth: { apiKey: 'fixture-key' }, source: 'center' }) };
  const centerRuntime = {
    snapshot: { protocol: 1 },
    installer: {
      async getInstalled(id, selector) {
        assert.equal(id, INSTALLATION);
        if (selector?.version !== undefined) assert.equal(selector.version, MANIFEST.version);
        return { version: MANIFEST.version, packageRoot: PACKAGE_ROOT,
          dataDir: join(root, 'questionnaire-data'), manifest: MANIFEST };
      },
    },
    getClient: () => centerClient,
    prepareTurn: async () => ({ setId: `set-${snapshot.revision}`, snapshot }),
    confirmTurn: async ({ requestId, setId }) => ({ admissionId: `admission-${requestId}`, setId }),
    restoreTurn: async () => ({ setId: `set-${snapshot.revision}`, snapshot }),
  };
  const makeSnapshot = (revision, bots) => ({
    protocol: 1, deviceId, revision,
    providers: [{ id: 'fixture-provider', name: 'Fixture', api, baseUrl: 'http://127.0.0.1:9', enabled: true, credentialRef: null }],
    models: { 'fixture-provider': [{ id: 'fixture-model', name: 'Fixture', api,
      contextWindow: 128000, maxTokens: 4096, input: ['text'], reasoning: false, enabled: true, revision: 1 }] },
    credentials: {}, bots,
  });
  async function start() {
    const opening = await openRuntime({ dataRoot, nativeBridge: async () => ({}), centerRuntime });
    runtime = opening;
    try {
      snapshot ??= makeSnapshot(1, []);
      const applied = await opening.applyCenterSnapshot(snapshot);
      if (!bot) assert.equal(applied.status, 'applied', JSON.stringify(applied));
      else assert.ok(['applied', 'waiting-idle'].includes(applied.status), JSON.stringify(applied));
      await opening.restoreTurns();
      await opening.setCenterOnline(true);
      opening.resume();
    } catch (error) {
      runtime = null;
      try { await opening.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], 'Fixture Runtime startup and cleanup failed'); }
      throw error;
    }
  }
  t.after(async () => {
    await runtime?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await start();
  bot = await runtime.createBot({ requestId: 'fixture-rt-create', role: 'Task Assistant', cwd, makePrimary: true });
  snapshot = makeSnapshot(2, [{ botId: bot.botId, cwd,
    model: { modelRef: 'fixture-provider/fixture-model', thinkingLevel: 'off', codemode, codemodeOnly },
    capabilities: questionnaire ? [{ installationId: INSTALLATION, kind: 'plugin', target: 'host',
      targetVersion: MANIFEST.version, enabled: true, authorized: true, effectiveConfig: {}, credentialRefs: [] }] : [],
  }]);
  const applied = await runtime.applyCenterSnapshot(snapshot);
  assert.equal(applied.status, 'applied', JSON.stringify(applied));
  return {
    bot, state,
    get deviceId() { return deviceId; },
    get runtime() { return runtime; },
    async restart() { await runtime.close(); runtime = null; await start(); },
    async whileStopped(read) {
      await runtime.close();
      runtime = null;
      const storage = await openNodeSqliteStorage(join(dataRoot, 'durable.sqlite'));
      const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
      try { return await read(harness); }
      finally { await harness.close(context); await start(); }
    },
    async watchLive() {
      const handle = await runtime.watch(bot.botId);
      handle.start(() => {});
      const stop = async () => { await handle.stop().catch(() => {}); };
      t.after(stop);
      return { get state() { return handle.value?.state ?? null; }, stop };
    },
    async answer(presentation, requestId, selected = 0) {
      const { result } = await runtime.callCapabilityAction(INSTALLATION, 'answerQuestionnaire', {
        requestId, deviceId, botId: bot.botId,
        input: { conversationId: presentation.conversationId, requestId: presentation.requestId,
          cancelled: false, answers: [{ questionIndex: 0, selectedOptions: [selected] }] },
      });
      return result;
    },
  };
}

test('real nested codemode-only questionnaire preserves live-task fallback without creating a durable wait', async t => {
  const f = await hostFixture(t, { questionnaire: true, codemode: true, codemodeOnly: true });
  let issued = false;
  f.state.handler = async () => {
    if (!issued) {
      issued = true;
      return [{
        type: 'toolCall',
        id: 'codemode-nested-q',
        name: 'codemode',
        arguments: { code: `return await tools.ask_user_question(${JSON.stringify(QUESTION)});` },
      }];
    }
    return text('Codemode nested questionnaire completed in-band.');
  };
  const live = f.watchLive();
  await f.client.submit(f.bot.botId, { requestId: 'codemode-only-work', text: 'ask via nested codemode call' });
  const pending = await until(
    () => pendingLiveQuestionnaires(live.state)[0] ?? null,
    'pending nested questionnaire in codemode-only live state',
  );
  assert.deepEqual(await f.answer(pending, 'answer-codemode-nested', 0), { status: 'answered' });
  await f.done('codemode-only-work');
  await live.stop();
  assert.equal(f.state.calls.length, 2);
  const history = await f.history();
  assert.equal(history.some(entry => String(entry.data?.requestId ?? '').startsWith('wait-')), false);
  await f.whileStopped(async harness => {
    const index = await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context);
    assert.deepEqual(Object.keys(index?.active ?? {}), []);
    assert.equal(await harness.snapshot(DurableWait, waitId(f.bot, pending), context) ?? null, null);
  });
});

test('scoped room turn keeps live-task questionnaire fallback with no detached wait or auto-wake', async t => {
  const f = await hostFixture(t, { questionnaire: true, extraBots: 1 });
  await f.client.submit(f.bot.botId, { requestId: 'room-test-primary', text: 'Initialize primary watch' });
  await f.done('room-test-primary');
  const peer = f.peerBots[0];
  const created = await f.client.createScope({
    requestId: 'create-room-no-detach',
    kind: 'room',
    title: 'Scoped Questionnaire Room',
    members: [
      { deviceId: f.server.deviceId, botId: f.bot.botId },
      { deviceId: f.server.deviceId, botId: peer.botId },
    ],
  });
  const scopeId = created.scope.scopeId;
  await f.client.stopWork(peer.botId, scopeId);

  const callsBeforeRoom = f.state.calls.length;
  let asked1 = false;
  f.state.handler = async () => {
    if (!asked1) { asked1 = true; return [ask('room-question-1')]; }
    return text('Room turn completed with Alpha.');
  };
  const live = f.watchLive();
  await f.client.publishUserMessage(scopeId, {
    messageId: 'room-msg-1',
    text: `@${f.bot.role} Please clarify choice inside this room`,
  });
  const pending1 = await until(
    () => pendingLiveQuestionnaires(live.state)[0] ?? null,
    'live-task room questionnaire 1',
    12000,
  );
  assert.deepEqual(await f.answer(pending1, 'answer-room-1', 0), { status: 'answered' });
  await until(
    () => f.state.calls.length >= callsBeforeRoom + 2 &&
      pendingLiveQuestionnaires(live.state).length === 0 &&
      live.state?.activity?.phase === 'idle',
    'room turn settled in-band after live answer',
    12000,
  );
  await live.stop();
  await f.whileStopped(async harness => {
    const index = await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context);
    assert.deepEqual(Object.keys(index?.active ?? {}), []);
    assert.equal(await harness.snapshot(DurableWait, waitId(f.bot, pending1), context) ?? null, null);
  });

  // A cancelled/aborted room questionnaire must never leave a detached wait or auto-wake after restart.
  let asked2 = false;
  f.state.handler = async () => {
    if (!asked2) { asked2 = true; return [ask('room-question-2')]; }
    return text('unexpected room continuation');
  };
  const live2 = f.watchLive();
  await f.client.publishUserMessage(scopeId, {
    messageId: 'room-msg-2',
    text: `@${f.bot.role} Ask a second room question then abort`,
  });
  const pending2 = await until(
    () => pendingLiveQuestionnaires(live2.state)[0] ?? null,
    'live-task room questionnaire 2',
    12000,
  );
  await f.client.abort(f.bot.botId);
  await live2.stop();
  const callsAfterAbort = f.state.calls.length;
  await f.restart();
  assert.deepEqual(await f.answer(pending2, 'late-room-answer', 1), { status: 'settled' });
  await f.whileStopped(async harness => {
    const index = await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context);
    assert.deepEqual(Object.keys(index?.active ?? {}), []);
    assert.equal(await harness.snapshot(DurableWait, waitId(f.bot, pending2), context) ?? null, null);
  });
  assert.equal(f.state.calls.length, callsAfterAbort);
  assert.equal((await f.history()).some(entry => String(entry.data?.requestId ?? '').startsWith('wait-')), false);
});

test('real task dispatch questionnaire stays live-task with no detached wait or auto-wake across cancellation and revision', async t => {
  const f = await runtimeFixture(t, { questionnaire: true });
  let step = 0;
  f.state.handler = async () => {
    if (step === 0) { step = 1; return [ask('task-rev1-q')]; }
    if (step === 1) { step = 2; return [ask('task-rev2-q')]; }
    return text('Task dispatch revision 2 completed in-band.');
  };
  const live = await f.watchLive();
  await f.runtime.submitTaskDispatch(f.bot.botId, {
    requestId: 'task-dispatch-rev-1',
    text: 'Execute global task step revision 1',
    dispatchContext: { taskId: 'global-task-compat', stepId: 'step-1', executionRevision: 1 },
    origin: { sender: { kind: 'host', name: '任务 · 全局任务', sourceType: 'webhook' }, replyTo: null },
  });
  const pendingRev1 = await until(
    () => pendingLiveQuestionnaires(live.state)[0] ?? null,
    'live-task questionnaire during task dispatch rev 1',
  );
  await f.runtime.cancelTaskDispatch(f.bot.botId, 'task-dispatch-rev-1');
  const cancelledRev1 = await until(async () => {
    const receipt = await f.runtime.getSubmission(f.bot.botId, 'task-dispatch-rev-1');
    return receipt?.status === 'unanswered' ? receipt : null;
  }, 'cancelled task dispatch rev 1 receipt');
  assert.ok(['aborted', 'cancelled'].includes(cancelledRev1.reason));
  await live.stop();
  const callsAfterCancel = f.state.calls.length;
  assert.equal(callsAfterCancel, 1);

  await f.whileStopped(async harness => {
    const index = await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context);
    assert.deepEqual(Object.keys(index?.active ?? {}), []);
    assert.equal(await harness.snapshot(DurableWait, waitId(f.bot, pendingRev1), context) ?? null, null);
  });
  assert.deepEqual(await f.answer(pendingRev1, 'late-answer-cancelled-task', 0), { status: 'settled' });
  assert.equal(f.state.calls.length, callsAfterCancel, 'cancelled task dispatch must never auto-wake');

  // Revised task dispatch executionRevision=2 also stays on live-task path with no detached wait.
  const live2 = await f.watchLive();
  await f.runtime.submitTaskDispatch(f.bot.botId, {
    requestId: 'task-dispatch-rev-2',
    text: 'Execute global task step revision 2',
    dispatchContext: { taskId: 'global-task-compat', stepId: 'step-1', executionRevision: 2 },
    origin: { sender: { kind: 'host', name: '任务 · 全局任务', sourceType: 'webhook' }, replyTo: null },
  });
  const pendingRev2 = await until(
    () => pendingLiveQuestionnaires(live2.state)[0] ?? null,
    'live-task questionnaire during task dispatch rev 2',
  );
  assert.deepEqual(await f.answer(pendingRev2, 'answer-task-rev-2', 1), { status: 'answered' });
  const doneRev2 = await until(async () => {
    const receipt = await f.runtime.getSubmission(f.bot.botId, 'task-dispatch-rev-2');
    return receipt?.status === 'done' ? receipt : null;
  }, 'completed task dispatch rev 2 receipt');
  assert.equal(doneRev2.status, 'done');
  await live2.stop();
  assert.equal(f.state.calls.length, 3);
  await f.whileStopped(async harness => {
    const index = await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context);
    assert.deepEqual(Object.keys(index?.active ?? {}), []);
    assert.equal(await harness.snapshot(DurableWait, waitId(f.bot, pendingRev2), context) ?? null, null);
  });
});

test('cold Host startup cancels an existing experimental unsupported task/room wait and its placed continuation before provider runs', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  await f.client.submit(f.bot.botId, { requestId: 'seed-primary-for-experimental', text: 'initialize primary conversation' });
  await f.done('seed-primary-for-experimental');
  assert.equal(f.state.calls.length, 1);
  const before = await f.server.getScheduleFence(f.bot.botId);
  const deviceId = f.server.deviceId;

  const expReqId = '999';
  let expKey;
  let expResumeId;
  let nativePlaced;
  await f.whileStopped(async harness => {
    const primary = await harness.snapshot(PrimaryIndex, context);
    const nativeId = primary.byPrimary[f.bot.primaryConversationId];
    assert.ok(Number.isSafeInteger(nativeId) && nativeId >= 1);
    const pinSnapshot = await harness.snapshot(TurnPin, f.bot.primaryConversationId, context);
    const originalPin = Object.values(pinSnapshot.admissions).find(pin => pin.requestId === 'seed-primary-for-experimental');
    assert.ok(originalPin);
    const presentation = {
      kind: 'questionnaire', version: 1, installationId: INSTALLATION,
      conversationId: nativeId, requestId: expReqId, status: 'answered', questions: QUESTION.questions,
    };
    expKey = waitId(f.bot, presentation);
    expResumeId = resumeRequestId(f.bot, presentation);
    nativePlaced = await harness.commit(async tx => {
      const admitted = await admitSubmission(tx, nativeId, {
        type: 'input', requestId: expResumeId, content: 'stale experimental room/task answer',
      }, Date.now(), { steeringMode: 'all', followUpMode: 'one' });
      assert.equal(admitted.status, 'placed');
      const admissionId = `admission-${expResumeId}`;
      const pins = await tx.doc(TurnPin, f.bot.primaryConversationId, {});
      pins.admissions[admissionId] = { ...originalPin, admissionId,
        requestId: expResumeId, submissionId: admitted.id, admittedAt: new Date().toISOString() };
      const doc = await tx.doc(DurableWait, expKey, {});
      doc.record = {
        version: 1, kind: 'questionnaire', waitId: expKey, botId: f.bot.botId,
        installationId: INSTALLATION, conversationId: nativeId, requestId: expReqId,
        toolTaskId: Number(expReqId), sourceRequestId: 'legacy-room-task-req',
        stopEpoch: before.stopEpoch,
        turn: {
          requestId: 'legacy-room-task-req', kind: 'room', scopeId: 'legacy-room',
          replyTarget: { kind: 'room', scopeId: 'legacy-room' },
          sender: { kind: 'user', deviceId },
        },
        dispatchContext: { taskId: 'legacy-global-task', stepId: 'step-1', executionRevision: 1 },
        status: 'answered', reason: 'user', params: QUESTION,
        details: { presentation, questions: QUESTION.questions },
        createdAt: Date.now(), settledAt: Date.now(),
        resumeRequestId: expResumeId,
        resume: { state: 'accepted', acceptedAt: Date.now(),
          input: { requestId: expResumeId, text: 'stale experimental room/task answer' } },
      };
      const index = await tx.doc(DurableWaitIndex, f.bot.primaryConversationId, {});
      index.active[expKey] = { installationId: INSTALLATION, conversationId: nativeId, requestId: expReqId };
      return admitted;
    }, context);
    f.state.handler = async () => text('fresh work after unsupported wait cleanup');
  });

  const cancelled = await until(async () => {
    const receipt = await f.client.getSubmission(f.bot.botId, expResumeId);
    assert.notEqual(receipt.status, 'done', 'unsupported experimental continuation must never execute');
    return receipt.status === 'unanswered' ? receipt : null;
  }, 'cancelled unsupported experimental continuation');
  assert.equal(cancelled.submissionId, nativePlaced.id);
  assert.equal(cancelled.reason, 'aborted');
  assert.equal(f.state.calls.length, 1);

  await f.whileStopped(async harness => {
    const record = (await harness.snapshot(DurableWait, expKey, context)).record;
    assert.equal(record.status, 'cancelled');
    assert.equal(record.resume.state, 'cancelled');
    assert.equal((await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context)).active[expKey], undefined);
  });
  await f.client.submit(f.bot.botId, { requestId: 'fresh-work-after-experimental-cleanup', text: 'continue cleanly' });
  await f.done('fresh-work-after-experimental-cleanup');
  assert.equal(f.state.calls.length, 2);
});

test('real /clear revokes pending durable wait atomically, preserves wait on RUNTIME_BUSY rejection, and stays coherent on answer-vs-clear race', async t => {
  const f = await hostFixture(t, { questionnaire: true });
  f.state.handler = askOnce('question-before-clear');
  await f.client.submit(f.bot.botId, { requestId: 'work-before-clear', text: 'ask before /clear' });
  await f.done('work-before-clear');
  const [question] = questionnaires(await f.history());
  assert.equal(question.presentation.status, 'pending');
  const key = waitId(f.bot, question.presentation);
  assert.equal(f.state.calls.length, 1);

  // 1) Rejected /clear (RUNTIME_BUSY due to queued turn) must roll back / leave the pending wait intact.
  f.state.failPrepare = true;
  await f.client.submit(f.bot.botId, { requestId: 'queued-blocks-clear', text: 'queued turn blocks clear' });
  await until(() => f.state.prepareFailures > 0, 'queued turn blocking clearHistory');
  await assert.rejects(f.client.clearHistory(f.bot.botId), { code: 'RUNTIME_BUSY' });
  assert.equal(questionnaires(await f.history())[0].presentation.status, 'pending');
  await f.client.withdrawQueued(f.bot.botId, { requestId: 'queued-blocks-clear' });
  await until(async () => {
    const receipt = await f.client.getSubmission(f.bot.botId, 'queued-blocks-clear');
    return receipt?.status === 'unanswered' ? receipt : null;
  }, 'withdrawn queued turn before clearHistory');
  f.state.failPrepare = false;

  // 2) Successful /clear revokes the pending wait atomically with pi.reset.
  const cleared = await f.client.clearHistory(f.bot.botId);
  assert.ok(Number.isSafeInteger(cleared.clearedThroughEntryId) && cleared.clearedThroughEntryId > 0);
  assert.equal((await f.history()).length, 0);
  await f.whileStopped(async harness => {
    const record = (await harness.snapshot(DurableWait, key, context)).record;
    assert.equal(record.status, 'cancelled');
    assert.equal(record.resume.state, 'cancelled');
    assert.equal((await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context)).active[key], undefined);
  });
  assert.deepEqual(await f.answer(question.presentation, 'late-answer-after-clear', 0), { status: 'settled' });
  assert.equal(f.state.calls.length, 1);

  // 3) Answer-vs-/clear race stays coherent under either commit order.
  f.state.handler = askOnce('question-race-clear');
  await f.client.submit(f.bot.botId, { requestId: 'work-race-clear', text: 'ask before answer-vs-clear race' });
  await f.done('work-race-clear');
  const [q2] = questionnaires(await f.history());
  assert.equal(q2.presentation.status, 'pending');
  const key2 = waitId(f.bot, q2.presentation);
  const resumedId2 = resumeRequestId(f.bot, q2.presentation);
  f.state.handler = async () => text('race continuation completed');

  const [clearOutcome, answerOutcome] = await Promise.allSettled([
    f.client.clearHistory(f.bot.botId),
    f.answer(q2.presentation, 'race-answer', 0),
  ]);
  assert.equal(answerOutcome.status, 'fulfilled');
  if (clearOutcome.status === 'fulfilled') {
    assert.ok(Number.isSafeInteger(clearOutcome.value.clearedThroughEntryId) && clearOutcome.value.clearedThroughEntryId > 0);
    assert.ok(['settled', 'answered'].includes(answerOutcome.value.status));
    await f.whileStopped(async harness => {
      const record = (await harness.snapshot(DurableWait, key2, context)).record;
      assert.equal(record.status, 'cancelled');
      assert.equal(record.resume.state, 'cancelled');
      assert.equal((await harness.snapshot(DurableWaitIndex, f.bot.primaryConversationId, context)).active[key2], undefined);
    });
    assert.deepEqual(await f.answer(q2.presentation, 'late-answer-after-race-clear', 1), { status: 'settled' });
  } else {
    assert.equal(clearOutcome.reason?.code, 'RUNTIME_BUSY');
    assert.equal(answerOutcome.value.status, 'answered');
    await f.done(resumedId2);
    await f.restart();
    assert.deepEqual(await f.answer(q2.presentation, 'late-answer-after-race-answered', 1), { status: 'settled' });
    assert.equal((await f.history()).filter(entry => entry.data?.requestId === resumedId2).length, 1);
  }
});
