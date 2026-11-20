import assert from 'node:assert/strict';
import test from 'node:test';
import { GOOGLE_WORKSPACE_INSTALLATION_ID } from '../../center-contract/google-workspace.js';

import {
  GOOGLE_WORKSPACE_DATA_BOUNDARY,
  GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
  GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
  GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
  GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
  GoogleWorkspacePrivacyState,
  createGoogleWorkspacePrivacy,
  filterCleanEntriesForLearning,
  isGoogleWorkspaceCapability,
  isTrustedGoogleWorkspaceRuleEntry,
} from '../../host-core/google-workspace-privacy.js';
import { createMcpDriver } from '../../host-core/capabilities/mcp.js';
import { createBotLearning } from '../../host-core/bot-learning.js';
import { createCommunicationTools } from '../../host-core/communication-tools.js';
import { PrimaryIndex } from '../../host-core/runtime-docs.js';
import { senderAttribution } from '../../host-core/bot-session-context.js';
import { normalizeLiveSnapshot } from '../../host-core/remote-live-protocol.js';
import { createHindsightSources } from '../../plugins/hindsight/hindsight-sources.js';
import { createHindsightTools } from '../../plugins/hindsight/hindsight-tools.js';

/**
 * 内存 Durable harness 模拟：支持 doc snapshot/commit、conversation entries（升/降序分页）、
 * submissions 与重启重建（共享底层 docs/entries 模拟 durable.sqlite 持久化）。
 */
function createMemoryDurableStore() {
  const docs = new Map(); // `${kind}:${conversationId}` -> plain JSON value
  const conversations = new Map(); // nativeId -> Entry[]
  const submissions = new Map(); // subId -> submission record
  let commitError = null;

  function docKey(def, conversationId) {
    const scope = def?.scope ?? def?.definition?.scope;
    const kind = def?.kind ?? def?.definition?.kind ?? String(def);
    const id = scope === 'session' || typeof conversationId !== 'number' ? 'session' : conversationId;
    return `${kind}:${id}`;
  }

  function initialOf(def) {
    const fn = def?.definition?.initial ?? def?.initial;
    return typeof fn === 'function' ? fn() : {};
  }

  function appendEntry(nativeId, entry) {
    const list = conversations.get(nativeId) ?? [];
    const id = entry.id ?? (list.length ? list[list.length - 1].id + 1 : 1);
    const stored = { conversationId: nativeId, ...entry, id };
    list.push(stored);
    conversations.set(nativeId, list);
    return stored;
  }

  function createHarness() {
    return {
      async snapshot(def, conversationId) {
        const key = docKey(def, conversationId);
        return docs.has(key) ? structuredClone(docs.get(key)) : null;
      },
      async commit(fn) {
        if (commitError) throw commitError;
        const pending = new Map();
        const tx = {
          async doc(def, conversationId) {
            const key = docKey(def, conversationId);
            if (!pending.has(key)) {
              pending.set(key, docs.has(key) ? structuredClone(docs.get(key)) : initialOf(def));
            }
            return pending.get(key);
          },
          async latestEntryId(conversationId) {
            const list = conversations.get(conversationId) ?? [];
            return list.length ? list[list.length - 1].id : 0;
          },
          entry(entryId) {
            for (const list of conversations.values()) {
              const found = list.find((e) => e.id === entryId);
              if (found) return found;
            }
            return null;
          },
        };
        const result = await fn(tx);
        for (const [key, value] of pending.entries()) {
          docs.set(key, structuredClone(value));
        }
        return result;
      },
      async conversation(nativeId) {
        if (!conversations.has(nativeId)) return null;
        return {
          id: nativeId,
          async entries(query = {}, limit = 100, cursor) {
            const list = conversations.get(nativeId) ?? [];
            const minId = query.minEntryId ?? 0;
            const maxId = query.maxEntryId ?? Number.POSITIVE_INFINITY;
            let filtered = list.filter((e) => e.id >= minId && e.id <= maxId);
            if (query.order === 'descending') filtered = [...filtered].reverse();
            const start = typeof cursor?.offset === 'number' ? cursor.offset : 0;
            const items = filtered.slice(start, start + limit);
            const next = start + items.length < filtered.length ? { offset: start + items.length } : null;
            return { items, next };
          },
          async context(_ctx, { at } = {}) {
            const list = conversations.get(nativeId) ?? [];
            const upto = Number.isSafeInteger(at) ? list.filter((e) => e.id <= at) : list;
            let startIdx = 0;
            for (let i = upto.length - 1; i >= 0; i -= 1) {
              if (upto[i].kind === 'pi.reset' || upto[i].kind === 'pi.compaction') {
                startIdx = upto[i].kind === 'pi.reset' ? i + 1 : i;
                break;
              }
            }
            const visibleEntries = upto.slice(startIdx);
            const contributions = visibleEntries.map((e) => e.model ?? []);
            const messages = contributions.flat();
            return {
              head: startIdx > 0 ? upto[startIdx - 1] : null,
              entries: visibleEntries,
              contributions,
              messages,
            };
          },
        };
      },
      async submission(subId) {
        return submissions.has(subId) ? { status: async () => submissions.get(subId) } : null;
      },
      async getTask(taskId) {
        return { id: taskId, state: { checkpoint: { cutoff: this._cutoff ?? 1 } } };
      },
      async inspect() {
        return { submissions: [...submissions.values()] };
      },
      _cutoff: 1,
    };
  }

  return {
    docs,
    conversations,
    submissions,
    appendEntry,
    createHarness,
    setCommitError(err) { commitError = err; },
  };
}

test('Google Workspace provenance relies strictly on Center assignment and structured Host rule metadata, never text prefixes or model fields', () => {
  assert.equal(GOOGLE_WORKSPACE_MCP_INSTALLATION_ID, GOOGLE_WORKSPACE_INSTALLATION_ID);
  assert.equal(
    isGoogleWorkspaceCapability({ target: 'center', installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID }),
    true,
  );
  assert.equal(
    isGoogleWorkspaceCapability({ target: 'center', installationId: 'other-id', dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY }),
    false,
  );
  // target=host, packageId, effectiveConfig, tool names must NEVER match.
  assert.equal(
    isGoogleWorkspaceCapability({ target: 'host', installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID, dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY }),
    false,
  );
  assert.equal(
    isGoogleWorkspaceCapability({ target: 'center', installationId: 'custom-mcp', packageId: 'e-launcher.google-workspace', effectiveConfig: { dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY } }),
    false,
  );

  // Rule entries: only structured Host metadata matches; text/payload spoofing does not.
  assert.equal(
    isTrustedGoogleWorkspaceRuleEntry({
      kind: 'host.user-message',
      data: {
        source: 'host',
        dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
        attribution: { kind: 'host', sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE },
      },
      model: [{ role: 'user', content: 'Rule fired' }],
    }),
    true,
  );
  assert.equal(
    isTrustedGoogleWorkspaceRuleEntry({
      kind: 'host.user-message',
      data: {
        source: 'host',
        attribution: { kind: 'user' },
      },
      model: [{ role: 'user', content: 'From: cfo@company.com\nSubject: Google Workspace Gmail secret' }],
    }),
    false,
  );
  assert.equal(
    isTrustedGoogleWorkspaceRuleEntry({
      kind: 'host.user-message',
      data: {
        source: 'host',
        attribution: { kind: 'host', sourceType: 'webhook' },
      },
      model: [{ role: 'user', content: '{"source":"google-workspace","gmail":true}' }],
    }),
    false,
  );
});

test('MCP driver: tools/list does not taint, real execute taints fail-closed before Center call and survives abort/restart', async () => {
  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const privacy = createGoogleWorkspacePrivacy({ getHarness: () => harness, context: {} });

  store.appendEntry(1, {
    kind: 'host.user-message',
    data: { attribution: { kind: 'user' } },
    model: [{ role: 'user', content: 'Check my inbox', timestamp: 1000 }],
  });
  store.appendEntry(1, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'tc-1', name: 'mcp_google', arguments: {} }], timestamp: 1001 }],
  });

  const centerCalls = [];
  let failCall = null;
  const host = {
    assertCapabilityAllowed: () => {},
    resolveConversationBot: async () => 'bot-a',
    dataPrivacy: privacy,
    centerClient: {
      listCapabilityTools: async () => ({
        tools: [{ name: 'gmail_search', description: 'Search Gmail', inputSchema: { type: 'object', properties: {} } }],
      }),
      callCapabilityTool: async (id, botId, name, args, callId, { signal }) => {
        centerCalls.push({ id, botId, name, args, callId });
        if (failCall) throw failCall(signal);
        return { content: [{ type: 'text', text: 'Confidential Q4 budget email' }], isError: false };
      },
    },
  };

  const driver = await createMcpDriver({
    installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
    version: '1.0.0',
    target: 'center',
    dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
    packageRoot: null,
    host,
  });
  const botBinding = await driver.forBot({ botId: 'bot-a', effectiveConfig: {}, credentials: {} });
  await botBinding.prepare();
  await botBinding.activate();

  // Listing tools / default visibility MUST NOT taint the conversation.
  await botBinding.actions.listTools.execute();
  assert.equal(await privacy.isConversationTainted(1), false);

  // Fail-closed: if durable privacy persistence fails, Center MUST NOT be called.
  store.setCommitError(new Error('sqlite busy'));
  const tool = botBinding.durableContributions.tools[0];
  await assert.rejects(
    () => tool.execute({}, { conversationId: 1, callId: 'call-fail-closed', taskId: 10 }, {}),
    (err) => err?.code === GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
  );
  assert.equal(centerCalls.length, 0, 'Center MCP must never run when durable taint commit fails');
  store.setCommitError(null);

  // Mid-call abort: taint MUST already be persisted before Center runs and survive Host restart.
  const ac = new AbortController();
  failCall = () => {
    ac.abort(new Error('user stopped'));
    return Object.assign(new Error('aborted'), { name: 'AbortError' });
  };
  await assert.rejects(
    () => tool.execute({}, { conversationId: 1, callId: 'call-abort', taskId: 11 }, { abortSignal: ac.signal }),
  );
  assert.equal(centerCalls.length, 1);

  // Simulate Host restart: fresh harness + fresh privacy instance reading the same persisted store.
  const restartedHarness = store.createHarness();
  const restartedPrivacy = createGoogleWorkspacePrivacy({ getHarness: () => restartedHarness, context: {} });
  assert.equal(await restartedPrivacy.isConversationTainted(1), true);
  const state = await restartedHarness.snapshot(GoogleWorkspacePrivacyState, 1);
  assert.equal(state.earliestByReset['0'].turnStartEntryId, 1);

  // Non-Google MCP on a clean conversation (id=2) must NOT taint even if tool is named gmail_search.
  store.appendEntry(2, {
    kind: 'host.user-message',
    data: { attribution: { kind: 'user' } },
    model: [{ role: 'user', content: 'Normal request', timestamp: 2000 }],
  });
  failCall = null;
  const otherDriver = await createMcpDriver({
    installationId: 'third-party-mcp',
    version: '1.0.0',
    target: 'center',
    packageRoot: null,
    host,
  });
  const otherBinding = await otherDriver.forBot({ botId: 'bot-a', effectiveConfig: {}, credentials: {} });
  await otherBinding.prepare();
  await otherBinding.activate();
  await otherBinding.durableContributions.tools[0].execute({}, { conversationId: 2, callId: 'call-other', taskId: 12 }, {});
  assert.equal(await restartedPrivacy.isConversationTainted(2), false);

  await botBinding.close();
  await otherBinding.close();
  await driver.close();
  await otherDriver.close();
});

test('bot-learning: preserves clean pre-taint turns, isolates Google turns + follow-ups + compactions, and recovers after pi.reset', async () => {
  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const privacy = createGoogleWorkspacePrivacy({ getHarness: () => harness, context: {} });

  // Turn 1 (clean)
  store.appendEntry(10, {
    kind: 'host.user-message',
    data: { attribution: { kind: 'user' } },
    model: [{ role: 'user', content: 'How do I format TypeScript imports?', timestamp: 100 }],
  });
  store.appendEntry(10, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'Group external imports before relative ones.' }], timestamp: 101 }],
  });

  // Turn 2 (calls Google Workspace MCP)
  store.appendEntry(10, {
    kind: 'host.user-message',
    data: { attribution: { kind: 'user' } },
    model: [{ role: 'user', content: 'Summarize my CFO Q4 budget email', timestamp: 200 }],
  });
  store.appendEntry(10, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'g1', name: 'mcp_g', arguments: {} }], timestamp: 201 }],
  });
  await privacy.recordGoogleWorkspaceCallStart({
    installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
    target: 'center',
    conversationId: 10,
    callId: 'g1',
    taskId: 20,
    botId: 'bot-a',
  });
  store.appendEntry(10, {
    kind: 'pi.tool',
    model: [{ role: 'toolResult', toolCallId: 'g1', toolName: 'mcp_g', content: [{ type: 'text', text: 'Secret Q4 budget is $50M' }], timestamp: 202 }],
  });
  store.appendEntry(10, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'The CFO email states Q4 budget is $50M.' }], timestamp: 203 }],
  });

  // Turn 3 (follow-up without MCP call) + Context Compaction + Turn 4 (post-compaction)
  store.appendEntry(10, {
    kind: 'host.user-message',
    data: { attribution: { kind: 'user' } },
    model: [{ role: 'user', content: 'Turn that budget into 3 action items', timestamp: 300 }],
  });
  store.appendEntry(10, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '1. Lock $50M Q4 budget.' }], timestamp: 301 }],
  });
  store.appendEntry(10, {
    kind: 'pi.compaction',
    model: [{ role: 'user', content: 'Summary: CFO email said Q4 budget is $50M.', timestamp: 302 }],
  });
  store.appendEntry(10, {
    kind: 'host.user-message',
    data: { attribution: { kind: 'user' } },
    model: [{ role: 'user', content: 'Draft an executive brief from the summary', timestamp: 400 }],
  });
  store.appendEntry(10, {
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'Executive brief: $50M Q4 plan.' }], timestamp: 401 }],
  });

  const centerStarts = [];
  const botObj = {
    botId: 'bot-a',
    deviceId: 'dev-1',
    name: 'Bot A',
    cwd: process.cwd(),
    primaryConversationId: 'conv-10',
    archivedAt: null,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  const learning = createBotLearning({
    host: {
      deviceId: 'dev-1',
      getBot: (id) => (id === 'bot-a' ? botObj : null),
      listBots: () => [botObj],
      getBotSoul: () => ({ text: 'Bot A' }),
    },
    getHarness: () => harness,
    models: { getModel: () => ({ id: 'gpt-test' }) },
    getBotModels: () => ({ 'bot-a': { modelRef: 'openai/gpt-test' } }),
    getCenterClient: () => ({
      botLearning: async (_d, _b, payload) => {
        if (payload.action === 'status') {
          return {
            settings: { reviewModelRef: null, curatorModelRef: null, curator: { minIdleHours: 2 } },
            counters: { reviewCursor: null },
            activeJob: null,
          };
        }
        if (payload.action === 'start') {
          centerStarts.push(payload);
          return { jobId: 'job-ok', status: 'completed' };
        }
        return { status: 'ok' };
      },
    }),
    plugins: {
      actionByName: async () => {
        throw Object.assign(new Error('disabled'), { code: 'EXTENSION_DISABLED' });
      },
    },
    schedules: { listTasks: () => [] },
    getUsableModelRefs: () => new Set(['openai/gpt-test']),
    registry: { install: () => {}, uninstall: () => {} },
    context: {},
    openPrimaryConversation: async () => harness.conversation(10),
    dropEnvFor: () => {},
    isBotIdle: async () => true,
    idleSettleMs: 10,
    dataPrivacy: privacy,
  });

  try {
    // Manual review sees ONLY Turn 1 (2 messages) and zero $50M / CFO content!
    await learning.manageBotLearning('bot-a', { action: 'review' });
    assert.equal(centerStarts.length, 1);
    const snapshotText = JSON.stringify(centerStarts[0].snapshot.messages);
    assert.equal(centerStarts[0].snapshot.messages.length, 2);
    assert.ok(snapshotText.includes('TypeScript imports'));
    assert.ok(!snapshotText.includes('$50M'));
    assert.ok(!snapshotText.includes('CFO'));
    assert.ok(!snapshotText.includes('Executive brief'));

    // After /clear (pi.reset), clean Turn 5 is learnable again!
    store.appendEntry(10, { kind: 'pi.reset', model: [] });
    store.appendEntry(10, {
      kind: 'host.user-message',
      data: { attribution: { kind: 'user' } },
      model: [{ role: 'user', content: 'Explain SQLite WAL mode', timestamp: 500 }],
    });
    store.appendEntry(10, {
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'WAL allows concurrent readers with a writer.' }], timestamp: 501 }],
    });

    await learning.manageBotLearning('bot-a', { action: 'review' });
    assert.equal(centerStarts.length, 2);
    const afterResetText = JSON.stringify(centerStarts[1].snapshot.messages);
    assert.equal(centerStarts[1].snapshot.messages.length, 2);
    assert.ok(afterResetText.includes('SQLite WAL mode'));
    assert.ok(!afterResetText.includes('$50M'));

    // Purely tainted conversation (no clean turns since reset) skips manual review without calling Center start.
    store.appendEntry(10, { kind: 'pi.reset', model: [] });
    store.appendEntry(10, {
      kind: 'host.user-message',
      data: {
        source: 'host',
        dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
        attribution: { kind: 'host', sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE },
      },
      model: [{ role: 'user', content: 'Gmail rule event payload', timestamp: 600 }],
    });
    const skipped = await learning.manageBotLearning('bot-a', { action: 'review' });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, 'google_workspace_isolated');
    assert.equal(centerStarts.length, 2);
  } finally {
    await learning.close();
  }
});

test('Hindsight sources: mid-turn Google MCP call blocks collectRun retention while earlier clean turn is preserved', async () => {
  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const privacy = createGoogleWorkspacePrivacy({ getHarness: () => harness, context: {} });

  const RequestKeysDoc = { kind: 'host.request-keys', scope: 'conversation' };
  const WorkContextStateDoc = { kind: 'host.work-context', scope: 'conversation' };
  const WorkDecisionStateDoc = { kind: 'host.work-decision', scope: 'conversation' };
  const PrimaryIndexDoc = { kind: 'host.primary-index', scope: 'session' };

  await harness.commit(async (tx) => {
    const idx = await tx.doc(PrimaryIndexDoc);
    idx.byPrimary = { 'conv-h': 20 };
  });

  // Clean Turn 1 (entries 1..2)
  store.appendEntry(20, { kind: 'pi.user', model: [{ role: 'user', content: 'I prefer dark mode', timestamp: 1700000001000 }] });
  store.appendEntry(20, { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'Noted dark mode preference.' }], timestamp: 1700000002000 }] });
  store.submissions.set('sub-clean', {
    id: 'sub-clean', type: 'input', conversationId: 20, requestId: 'req-1', status: 'done', entry: 1, answer: 2,
  });

  // Tainted Turn 2 (entries 3..6): beforeRequest captured run before MCP call ran mid-turn!
  store.appendEntry(20, { kind: 'pi.user', model: [{ role: 'user', content: 'Read my salary email', timestamp: 1700000003000 }] });
  store.appendEntry(20, { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'g2', name: 'mcp_g', arguments: {} }], timestamp: 1700000004000 }] });
  await privacy.recordGoogleWorkspaceCallStart({
    installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
    target: 'center',
    conversationId: 20,
    callId: 'g2',
    taskId: 30,
    botId: 'bot-h',
  });
  store.appendEntry(20, { kind: 'pi.tool', model: [{ role: 'toolResult', toolCallId: 'g2', toolName: 'mcp_g', content: [{ type: 'text', text: 'Salary is confidential' }], timestamp: 1700000005000 }] });
  store.appendEntry(20, { kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'Your confidential salary is listed.' }], timestamp: 1700000006000 }] });
  store.submissions.set('sub-tainted', {
    id: 'sub-tainted', type: 'input', conversationId: 20, requestId: 'req-2', status: 'done', entry: 3, answer: 6,
  });

  const sources = createHindsightSources({
    host: {
      deviceId: 'dev-1',
      getBot: (id) => (id === 'bot-h' ? { botId: 'bot-h', deviceId: 'dev-1', primaryConversationId: 'conv-h' } : null),
      listBots: () => [{ botId: 'bot-h', deviceId: 'dev-1', primaryConversationId: 'conv-h' }],
    },
    getHarness: () => harness,
    context: {},
    documents: {
      PrimaryIndex: PrimaryIndexDoc,
      WorkContextState: WorkContextStateDoc,
      WorkDecisionState: WorkDecisionStateDoc,
      RequestKeys: RequestKeysDoc,
      GoogleWorkspacePrivacyState,
    },
    dataPrivacy: privacy,
  });

  // Turn 1 (clean, entries 1..2) MUST still collect normally.
  const cleanResult = await sources.collectRun(
    { submissionId: 'sub-clean', nativeId: 20, requestId: 'req-1', entryId: 1, cutoff: 1, kind: 'primary', botId: 'bot-h', target: { kind: 'primary' } },
    0,
    {},
  );
  assert.equal(cleanResult.status, 'ready');
  assert.equal(cleanResult.items.length, 2);

  // Turn 2 (mid-turn Google MCP call, entries 3..6) MUST yield zero retain items!
  const taintedResult = await sources.collectRun(
    { submissionId: 'sub-tainted', nativeId: 20, requestId: 'req-2', entryId: 3, cutoff: 3, kind: 'primary', botId: 'bot-h', target: { kind: 'primary' } },
    2,
    {},
  );
  assert.equal(taintedResult.status, 'ready');
  assert.equal(taintedResult.items.length, 0);
  assert.equal(taintedResult.done, true);

  // Follow-up Turn 3 captureRequest MUST return null (no retention & no external recall query).
  harness._cutoff = 7;
  store.appendEntry(20, { kind: 'pi.user', model: [{ role: 'user', content: 'Compare that salary to last year', timestamp: 1700000007000 }] });
  const followUpCapture = await sources.captureRequest({ conversationId: 20, taskId: 'task-3' }, {});
  assert.equal(followUpCapture, null);

  // Explicit Hindsight tool error mapping handles GOOGLE_WORKSPACE_PRIVACY_BLOCKED safely.
  const tools = createHindsightTools(
    {
      fromTool: async () => {
        throw Object.assign(new Error('blocked'), { code: GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE });
      },
    },
    (spec) => spec,
    'hs',
  );
  const retainTool = tools.find((t) => t.name === 'hs_retain');
  const blockedRes = await retainTool.execute({ text: 'secret email' }, { conversationId: 20, taskId: 1, callId: 'c1' }, {});
  assert.equal(blockedRes.isError, true);
  assert.equal(JSON.parse(blockedRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);
});

test('Model management tools block skill writes and learning starts from Google-tainted conversations while allowing reads and clean conversations', async () => {
  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const privacy = createGoogleWorkspacePrivacy({ getHarness: () => harness, context: {} });

  await harness.commit(async (tx) => {
    const idx = await tx.doc(PrimaryIndex);
    idx.byPrimary = { 'conv-tainted': 30, 'conv-clean': 31 };
  });
  store.appendEntry(30, { kind: 'host.user-message', data: { attribution: { kind: 'user' } }, model: [{ role: 'user', content: 'Read Drive doc', timestamp: 10 }] });
  await privacy.recordGoogleWorkspaceCallStart({
    installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
    target: 'center',
    conversationId: 30,
    callId: 'g3',
    taskId: 40,
    botId: 'bot-a',
  });
  store.appendEntry(31, { kind: 'host.user-message', data: { attribution: { kind: 'user' } }, model: [{ role: 'user', content: 'Write a git skill', timestamp: 20 }] });

  const skillCalls = [];
  const learningCalls = [];
  const bots = [
    { botId: 'bot-a', deviceId: 'dev-1', primaryConversationId: 'conv-tainted' },
    { botId: 'bot-b', deviceId: 'dev-1', primaryConversationId: 'conv-clean' },
  ];
  const tools = createCommunicationTools({
    host: {
      deviceId: 'dev-1',
      getBot: (id) => bots.find((b) => b.botId === id) ?? null,
      listBots: () => bots,
    },
    getHarness: () => harness,
    getMessageLog: () => ({}),
    publishWork: async () => ({}),
    collaboration: {
      manageBotSkill: async (arg) => { skillCalls.push(arg); return { ok: true }; },
      manageBotLearning: async (arg) => { learningCalls.push(arg); return { ok: true }; },
      manageBotInstallation: async () => ({ ok: true }),
      listBots: async () => ({ devices: [], bots: [] }),
      createBot: async () => ({}),
      updateBotProfile: async () => ({}),
      archiveBot: async () => ({}),
      unarchiveBot: async () => ({}),
      deleteBot: async () => ({}),
    },
    sessions: null,
    dataPrivacy: privacy,
  });

  const manageSkill = tools.find((t) => t.name === 'manage_bot_skill');
  const manageLearning = tools.find((t) => t.name === 'manage_bot_learning');
  const makeApi = (conversationId, taskId, callId) => {
    const memos = new Map();
    return {
      conversationId,
      taskId,
      callId,
      async memo(key, value) {
        if (arguments.length >= 3) {
          memos.set(key, value);
          return value;
        }
        return memos.get(key);
      },
    };
  };
  const apiTainted = makeApi(30, 41, 'c-skill');
  const apiClean = makeApi(31, 42, 'c-skill-ok');

  // Tainted conversation: skill write (even targeting another Bot!) is blocked.
  const skillBlocked = await manageSkill.execute(
    { deviceId: 'dev-1', botId: 'bot-b', action: 'create', name: 'leaked', content: 'secret' },
    apiTainted,
    {},
  );
  assert.equal(skillBlocked.isError, true);
  assert.equal(JSON.parse(skillBlocked.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);
  assert.equal(skillCalls.length, 0);

  // Tainted conversation: read-only skill list is still allowed.
  const skillListed = await manageSkill.execute({ action: 'list' }, apiTainted, {});
  assert.equal(skillListed.isError, undefined);
  assert.equal(skillCalls.length, 1);

  // Tainted conversation: learning start with focus is blocked; status is allowed.
  const learnBlocked = await manageLearning.execute(
    { deviceId: 'dev-1', botId: 'bot-a', action: 'review', focus: 'extract email facts' },
    apiTainted,
    {},
  );
  assert.equal(learnBlocked.isError, true);
  assert.equal(JSON.parse(learnBlocked.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);
  assert.equal(learningCalls.length, 0);

  const learnStatus = await manageLearning.execute(
    { deviceId: 'dev-1', botId: 'bot-a', action: 'status' },
    apiTainted,
    {},
  );
  assert.equal(learnStatus.isError, undefined);
  assert.equal(learningCalls.length, 1);

  // Clean conversation: skill creation and learning start proceed normally.
  const cleanSkill = await manageSkill.execute(
    { deviceId: 'dev-1', botId: 'bot-b', action: 'create', name: 'git-tips', content: 'tips' },
    apiClean,
    {},
  );
  assert.equal(cleanSkill.isError, undefined);
  assert.equal(skillCalls.length, 2);
});

test('Host protocol whitelists accept google-workspace-rule only on host senders and reject it on user/bot senders', () => {
  assert.deepEqual(
    senderAttribution({ kind: 'host', name: 'Gmail Rule', sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE }, 'dev-1'),
    { kind: 'host', deviceId: 'dev-1', name: 'Gmail Rule', sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE },
  );
  assert.deepEqual(
    senderAttribution({ kind: 'user', sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE }, 'dev-1'),
    { kind: 'user', deviceId: 'dev-1' },
  );

  const snapshotFor = (kind) => ({
    type: 'snapshot',
    botId: 'bot-a',
    conversationId: 'conv-1',
    sequence: 1,
    state: {
      busy: false, queuedCount: 0, historyTruncated: false, toolsTruncated: false,
      generation: null, lastEntryId: 1, tools: [],
      history: [{
        id: 1, kind: 'host.user-message',
        attribution: { kind, channel: 'primary', sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE },
        messages: [{ role: 'user', text: 'Rule triggered', truncated: false }],
      }],
    },
  });
  const normalized = normalizeLiveSnapshot(snapshotFor('host'));
  assert.equal(normalized.state.history[0].attribution.sourceType, GOOGLE_WORKSPACE_RULE_SOURCE_TYPE);
  for (const sender of ['user', 'bot']) {
    assert.throws(() => normalizeLiveSnapshot(snapshotFor(sender)), /sourceType/);
  }

  // Pure helper filterCleanEntriesForLearning respects compaction persistence & reset recovery.
  const filtered = filterCleanEntriesForLearning(
    [
      { id: 1, kind: 'host.user-message' },
      { id: 2, kind: 'pi.assistant' },
      { id: 3, kind: 'pi.compaction' },
      { id: 4, kind: 'host.user-message' },
    ],
    {
      privacyState: {
        earliestByReset: { '0': { turnStartEntryId: 2, anchorEntryId: 2 } },
      },
      resetEntryId: 0,
    },
  );
  assert.equal(filtered.tainted, true);
  assert.equal(filtered.isolatedCount, 3);
  assert.deepEqual(filtered.cleanEntries.map((e) => e.id), [1]);
});
