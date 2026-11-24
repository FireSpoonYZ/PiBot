import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
  GOOGLE_WORKSPACE_DATA_BOUNDARY,
  GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
  GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
  GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
  GoogleWorkspacePrivacyState,
  PRIVATE_HINDSIGHT_WRITE_OPERATIONS,
  TRUSTED_HOST_SOURCE_TYPES,
  createGoogleWorkspacePrivacy,
  isPrivateHindsightWriteAllowed,
  isTrustedGoogleWorkspaceRuleEntry,
  isTrustedHostSourceType,
} from '../../host-core/google-workspace-privacy.js';
import { createPlugin as createHindsightPlugin } from '../../plugins/hindsight/entry.js';
import { hindsightBankId } from '../../plugins/hindsight/hindsight-format.js';
import { isMutatingCatalogCall } from '../../plugins/hindsight/hindsight-tools.js';
import { createRuntimeHindsight } from '../../plugins/hindsight/runtime-hindsight.js';

const PrimaryIndexDoc = { kind: 'host.primary-index', scope: 'session' };
const WorkContextStateDoc = { kind: 'host.work-context', scope: 'conversation' };
const WorkDecisionStateDoc = { kind: 'host.work-decision', scope: 'conversation' };
const RequestKeysDoc = { kind: 'host.request-keys', scope: 'conversation' };
const ContextStateDoc = { kind: 'host.context-state', scope: 'conversation' };

const TEST_DOCS = {
  PrimaryIndex: PrimaryIndexDoc,
  WorkContextState: WorkContextStateDoc,
  WorkDecisionState: WorkDecisionStateDoc,
  RequestKeys: RequestKeysDoc,
  ContextState: ContextStateDoc,
  GoogleWorkspacePrivacyState,
};

function createMemoryDurableStore() {
  const docs = new Map();
  const conversations = new Map();

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
      subscribeCommits() {
        return () => {};
      },
      async snapshot(def, conversationId) {
        const key = docKey(def, conversationId);
        return docs.has(key) ? structuredClone(docs.get(key)) : null;
      },
      async commit(fn) {
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
        };
      },
    };
  }

  return { appendEntry, createHarness };
}

async function startMockHindsightServer({ onGetOperation = null } = {}) {
  const banks = new Set();
  const operations = new Map();
  const requests = [];
  const retainCalls = [];
  const correctCalls = [];
  const retryCalls = [];

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : null;
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    requests.push({ method: req.method, path, body });

    const sendJson = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && path === '/v1/default/banks') {
      const q = url.searchParams.get('q') ?? '';
      const matched = [...banks].filter((id) => !q || id.includes(q)).map((bank_id) => ({ bank_id }));
      return sendJson(200, { banks: matched, total: matched.length });
    }

    let match;
    if (req.method === 'PUT' && (match = /^\/v1\/default\/banks\/([^/]+)$/.exec(path))) {
      const bankId = decodeURIComponent(match[1]);
      banks.add(bankId);
      return sendJson(200, { bank_id: bankId });
    }

    if (req.method === 'POST' && (match = /^\/v1\/default\/banks\/([^/]+)\/memories$/.exec(path))) {
      const bankId = decodeURIComponent(match[1]);
      banks.add(bankId);
      retainCalls.push({ bankId, body });
      operations.set(`${bankId}:${body.operation_id}`, { status: 'completed' });
      return sendJson(200, {
        success: true,
        bank_id: bankId,
        async: true,
        operation_id: body.operation_id,
      });
    }

    if (req.method === 'GET' && (match = /^\/v1\/default\/banks\/([^/]+)\/operations\/([^/]+)$/.exec(path))) {
      const bankId = decodeURIComponent(match[1]);
      const operationId = decodeURIComponent(match[2]);
      if (typeof onGetOperation === 'function') {
        await onGetOperation({ bankId, operationId });
      }
      const op = operations.get(`${bankId}:${operationId}`);
      if (!op) return sendJson(404, { detail: 'operation not found' });
      return sendJson(200, { operation_id: operationId, status: op.status });
    }

    if (req.method === 'POST' && (match = /^\/v1\/default\/banks\/([^/]+)\/operations\/([^/]+)\/retry$/.exec(path))) {
      const bankId = decodeURIComponent(match[1]);
      const operationId = decodeURIComponent(match[2]);
      retryCalls.push({ bankId, operationId });
      return sendJson(200, { success: true, message: 'retrying', operation_id: operationId });
    }

    if (req.method === 'GET' && (match = /^\/v1\/default\/banks\/([^/]+)\/memories\/([^/]+)$/.exec(path))) {
      const memoryId = decodeURIComponent(match[2]);
      return sendJson(200, { id: memoryId, text: 'Old preference', state: 'valid' });
    }

    if (req.method === 'PATCH' && (match = /^\/v1\/default\/banks\/([^/]+)\/memories\/([^/]+)$/.exec(path))) {
      const bankId = decodeURIComponent(match[1]);
      const memoryId = decodeURIComponent(match[2]);
      correctCalls.push({ bankId, memoryId, body });
      return sendJson(200, {
        id: memoryId,
        text: body?.text ?? 'Old preference',
        state: body?.state ?? 'valid',
      });
    }

    return sendJson(404, { detail: `unhandled ${req.method} ${path}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    banks,
    operations,
    requests,
    retainCalls,
    correctCalls,
    retryCalls,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function waitUntil(predicate, { timeoutMs = 4000, intervalMs = 15, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test('google-workspace-assistant sourceType is trusted on host entries and properly taints conversations', async () => {
  assert.equal(GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, 'google-workspace-assistant');
  assert.ok(TRUSTED_HOST_SOURCE_TYPES.includes(GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE));
  assert.equal(isTrustedHostSourceType(GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE), true);
  assert.equal(isTrustedHostSourceType(GOOGLE_WORKSPACE_RULE_SOURCE_TYPE), true);
  assert.equal(isTrustedHostSourceType('webhook'), true);
  assert.equal(isTrustedHostSourceType('spoofed-assistant'), false);

  const hostAssistantEntry = {
    kind: 'host.user-message',
    data: {
      source: 'host',
      attribution: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
    },
    model: [{ role: 'user', content: 'Batch digest prompt' }],
  };
  const hostTurnSenderEntry = {
    kind: 'host.work-trigger',
    data: {
      turn: { sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
    },
  };
  const spoofedUserEntry = {
    kind: 'host.user-message',
    data: {
      attribution: { kind: 'user', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
    },
  };
  const spoofedBotEntry = {
    kind: 'host.user-message',
    data: {
      turn: { sender: { kind: 'bot', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
    },
  };

  assert.equal(isTrustedGoogleWorkspaceRuleEntry(hostAssistantEntry), true);
  assert.equal(isTrustedGoogleWorkspaceRuleEntry(hostTurnSenderEntry), true);
  assert.equal(isTrustedGoogleWorkspaceRuleEntry(spoofedUserEntry), false);
  assert.equal(isTrustedGoogleWorkspaceRuleEntry(spoofedBotEntry), false);

  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const privacy = createGoogleWorkspacePrivacy({ getHarness: () => harness, context: {} });

  const entry = store.appendEntry(1, hostAssistantEntry);
  const synced = await privacy.syncTrustedRuleEntries(1, [entry]);
  assert.equal(synced.marked, true);
  assert.equal(await privacy.isConversationTainted(1), true);

  await assert.rejects(
    () => privacy.assertExportAllowed(1, { operation: 'bot-learning' }),
    (err) => err?.code === GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
  );
  await assert.rejects(
    () => privacy.assertExportAllowed(1, { operation: 'skill:create' }),
    (err) => err?.code === GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
  );
});

test('isPrivateHindsightWriteAllowed and assertExportAllowed strictly limit exception to bound Bot own primary bank with sharedMemory=false', async () => {
  assert.deepEqual(
    [...PRIVATE_HINDSIGHT_WRITE_OPERATIONS].sort(),
    ['hindsight:correctMemory', 'hindsight:retainMemory', 'hindsight:retryMemory'],
  );

  const boundOnly = (id) => id === 'bot-bound';
  const throwingPredicate = () => {
    throw new Error('policy unavailable');
  };

  for (const op of ['hindsight:retainMemory', 'hindsight:correctMemory', 'hindsight:retryMemory']) {
    assert.equal(
      isPrivateHindsightWriteAllowed({
        operation: op,
        botId: 'bot-bound',
        targetKind: 'primary',
        sharedMemory: false,
        canUsePrivateHindsightBank: boundOnly,
      }),
      true,
    );
  }

  // Every deviation MUST fail closed (return false).
  assert.equal(
    isPrivateHindsightWriteAllowed({
      operation: 'hindsight:retainMemory',
      botId: 'bot-unbound',
      targetKind: 'primary',
      sharedMemory: false,
      canUsePrivateHindsightBank: boundOnly,
    }),
    false,
  );
  assert.equal(
    isPrivateHindsightWriteAllowed({
      operation: 'hindsight:retainMemory',
      botId: 'bot-bound',
      targetKind: 'primary',
      sharedMemory: true,
      canUsePrivateHindsightBank: boundOnly,
    }),
    false,
  );
  for (const badTarget of ['shared', 'scope', null, undefined, '']) {
    assert.equal(
      isPrivateHindsightWriteAllowed({
        operation: 'hindsight:retainMemory',
        botId: 'bot-bound',
        targetKind: badTarget,
        sharedMemory: false,
        canUsePrivateHindsightBank: boundOnly,
      }),
      false,
    );
  }
  for (const blockedOp of ['hindsight:catalog-write', 'skill:create', 'bot-learning', 'automation_google_rule_create', 'export']) {
    assert.equal(
      isPrivateHindsightWriteAllowed({
        operation: blockedOp,
        botId: 'bot-bound',
        targetKind: 'primary',
        sharedMemory: false,
        canUsePrivateHindsightBank: boundOnly,
      }),
      false,
    );
  }
  for (const badBot of [null, undefined, '', '   ']) {
    assert.equal(
      isPrivateHindsightWriteAllowed({
        operation: 'hindsight:retainMemory',
        botId: badBot,
        targetKind: 'primary',
        sharedMemory: false,
        canUsePrivateHindsightBank: boundOnly,
      }),
      false,
    );
  }
  assert.equal(
    isPrivateHindsightWriteAllowed({
      operation: 'hindsight:retainMemory',
      botId: 'bot-bound',
      targetKind: 'primary',
      sharedMemory: false,
      canUsePrivateHindsightBank: null,
    }),
    false,
  );
  assert.equal(
    isPrivateHindsightWriteAllowed({
      operation: 'hindsight:retainMemory',
      botId: 'bot-bound',
      targetKind: 'primary',
      sharedMemory: false,
      canUsePrivateHindsightBank: () => 'yes',
    }),
    false,
  );
  assert.equal(
    isPrivateHindsightWriteAllowed({
      operation: 'hindsight:retainMemory',
      botId: 'bot-bound',
      targetKind: 'primary',
      sharedMemory: false,
      canUsePrivateHindsightBank: throwingPredicate,
    }),
    false,
  );

  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const privacy = createGoogleWorkspacePrivacy({
    getHarness: () => harness,
    context: {},
    canUsePrivateHindsightBank: boundOnly,
  });

  assert.equal(privacy.canUsePrivateHindsightBank('bot-bound'), true);
  assert.equal(privacy.canUsePrivateHindsightBank('bot-unbound'), false);
  assert.equal(privacy.canUsePrivateHindsightBank(''), false);

  const failClosedPrivacy = createGoogleWorkspacePrivacy({
    getHarness: () => harness,
    context: {},
    canUsePrivateHindsightBank: throwingPredicate,
  });
  assert.equal(failClosedPrivacy.canUsePrivateHindsightBank('bot-bound'), false);

  // Taint conversation 10 via real Google Workspace MCP call provenance.
  store.appendEntry(10, {
    kind: 'host.user-message',
    data: { attribution: { kind: 'user' } },
    model: [{ role: 'user', content: 'Check inbox' }],
  });
  await privacy.recordGoogleWorkspaceCallStart({
    installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
    target: 'center',
    conversationId: 10,
    callId: 'mcp-1',
    taskId: 1,
    botId: 'bot-bound',
  });

  // Allowed: bound Bot writing to its own primary bank with sharedMemory=false.
  for (const op of ['hindsight:retainMemory', 'hindsight:correctMemory', 'hindsight:retryMemory']) {
    const decision = await privacy.assertExportAllowed(10, {
      operation: op,
      botId: 'bot-bound',
      targetKind: 'primary',
      sharedMemory: false,
    });
    assert.deepEqual(decision, { allowed: true, exception: 'proactive-private-hindsight' });
  }

  // Blocked: sharedMemory=true, targetKind=shared/scope, catalog-write, skill/learning, unbound Bot.
  const blockedCases = [
    { operation: 'hindsight:retainMemory', botId: 'bot-bound', targetKind: 'primary', sharedMemory: true },
    { operation: 'hindsight:retainMemory', botId: 'bot-bound', targetKind: 'shared', sharedMemory: false },
    { operation: 'hindsight:retainMemory', botId: 'bot-bound', targetKind: 'scope', sharedMemory: false },
    { operation: 'hindsight:catalog-write', botId: 'bot-bound', targetKind: 'primary', sharedMemory: false },
    { operation: 'skill:create', botId: 'bot-bound', targetKind: 'primary', sharedMemory: false },
    { operation: 'bot-learning', botId: 'bot-bound', targetKind: 'primary', sharedMemory: false },
    { operation: 'hindsight:retainMemory', botId: 'bot-unbound', targetKind: 'primary', sharedMemory: false },
  ];
  for (const opts of blockedCases) {
    await assert.rejects(
      () => privacy.assertExportAllowed(10, opts),
      (err) => err?.code === GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
      `Expected GOOGLE_WORKSPACE_PRIVACY_BLOCKED for ${JSON.stringify(opts)}`,
    );
  }
});

test('Hindsight plugin allows bound Bot own-primary-bank tool writes after Google assistant taint while blocking shared, scope, catalog writes, and unbound Bots', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-proactive-hindsight-plugin-'));
  const server = await startMockHindsightServer();
  const pluginsToClose = [];
  t.after(async () => {
    for (const plugin of pluginsToClose) {
      await plugin.close();
    }
    await server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const bots = [
    { botId: 'bot-bound', deviceId: 'dev-1', primaryConversationId: 'conv-bound' },
    { botId: 'bot-unbound', deviceId: 'dev-1', primaryConversationId: 'conv-unbound' },
  ];

  await harness.commit(async (tx) => {
    const idx = await tx.doc(PrimaryIndexDoc);
    idx.byPrimary = {
      'conv-bound': 101,
      'conv-unbound': 103,
    };
    const scopeMeta = await tx.doc(WorkContextStateDoc, 102);
    scopeMeta.deviceId = 'dev-1';
    scopeMeta.botId = 'bot-bound';
    scopeMeta.scopeId = 'room-1';
    scopeMeta.kind = 'room';
    scopeMeta.conversationId = 'work-room-1';
  });

  const privacy = createGoogleWorkspacePrivacy({
    getHarness: () => harness,
    context: {},
    canUsePrivateHindsightBank: (botId) => botId === 'bot-bound',
  });

  // Taint all three conversations (101 bound primary, 102 bound scope, 103 unbound primary).
  for (const nativeId of [101, 102, 103]) {
    const entry = store.appendEntry(nativeId, {
      kind: 'host.user-message',
      data: {
        source: 'host',
        dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
        attribution: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
      },
      model: [{ role: 'user', content: 'Proactive Gmail/Calendar batch update' }],
    });
    await privacy.syncTrustedRuleEntries(nativeId, [entry]);
    assert.equal(await privacy.isConversationTainted(nativeId), true);
  }

  const makeHost = () => ({
    host: {
      deviceId: 'dev-1',
      dataRoot: dir,
      getBot: (id) => bots.find((b) => b.botId === id) ?? null,
      listBots: () => bots,
      getBotExtensions: () => ({ retentionFloor: 0 }),
    },
    getHarness: () => harness,
    getWorkContexts: () => ({ resolveWorkContext: async () => ({}) }),
    getWorkActivity: async () => ({ status: 'active' }),
    context: {},
    documents: TEST_DOCS,
    countMessageTokens: () => 10,
    tryRunBackgroundTask: async (_botId, fn) => await fn(),
    dataPrivacy: privacy,
    assertCapabilityAllowed: () => {},
    resolveConversationBot: async (convId) => (convId === 103 ? 'bot-unbound' : 'bot-bound'),
    getBotEntryWatermark: async () => 0,
    sdk: { defineTool: (spec) => spec },
  });

  // 1. Bound Bot with sharedMemory=false
  const pluginBound = createHindsightPlugin({
    installationId: 'inst-hs-bound',
    version: '1.2.1',
    dataDir: join(dir, 'bound-private'),
    host: makeHost(),
  });
  pluginsToClose.push(pluginBound);
  const boundBinding = await pluginBound.forBot({
    deviceId: 'dev-1',
    botId: 'bot-bound',
    effectiveConfig: { baseUrl: server.baseUrl, mode: 'read-write', sharedMemory: false },
    credentials: {},
  });
  await boundBinding.activate();

  const boundTools = boundBinding.durableContributions.tools;
  const retainTool = boundTools.find((tool) => tool.name.endsWith('_retain'));
  const correctTool = boundTools.find((tool) => tool.name.endsWith('_correct'));
  const retryTool = boundTools.find((tool) => tool.name.endsWith('_retry'));
  const retainGlobalTool = boundTools.find((tool) => tool.name.endsWith('_retain_global'));
  const configTool = boundTools.find((tool) => tool.name.endsWith('_config'));
  const bankTool = boundTools.find((tool) => tool.name.endsWith('_bank'));

  // Primary bank retain SUCCEEDS and uploads to bot-bound's primary bank.
  const retainRes = await retainTool.execute(
    { text: 'User prefers concise morning Gmail triage.' },
    { conversationId: 101, taskId: 1, callId: 'c-retain-1' },
    {},
  );
  assert.equal(retainRes.isError, undefined);
  const retainReceipt = JSON.parse(retainRes.output[0].text);
  assert.equal(retainReceipt.target.kind, 'primary');
  const expectedPrimaryBankId = hindsightBankId('dev-1', 'bot-bound', { kind: 'primary' });
  assert.equal(retainReceipt.bankId, expectedPrimaryBankId);
  const opId = retainReceipt.jobs[0].operationId;

  await waitUntil(() => server.retainCalls.length === 1, { label: 'primary bank retain upload' });
  assert.equal(server.retainCalls[0].bankId, expectedPrimaryBankId);

  // Primary bank correctMemory SUCCEEDS.
  const correctRes = await correctTool.execute(
    { memoryId: 'mem-1', text: 'User prefers 09:00 and 18:00 digests.' },
    { conversationId: 101, taskId: 2, callId: 'c-correct-1' },
    {},
  );
  assert.equal(correctRes.isError, undefined);
  assert.equal(server.correctCalls.length, 1);
  assert.equal(server.correctCalls[0].bankId, expectedPrimaryBankId);

  // Primary bank retryMemory SUCCEEDS.
  const retryRes = await retryTool.execute(
    { operationId: opId },
    { conversationId: 101, taskId: 3, callId: 'c-retry-1' },
    {},
  );
  assert.equal(retryRes.isError, undefined);
  assert.equal(server.retryCalls.length, 1);
  assert.equal(server.retryCalls[0].operationId, opId);

  // shared=true MUST be blocked even on the bound Bot!
  const sharedArgRes = await retainTool.execute(
    { text: 'Should not go to shared bank', shared: true },
    { conversationId: 101, taskId: 4, callId: 'c-shared-arg' },
    {},
  );
  assert.equal(sharedArgRes.isError, true);
  assert.equal(JSON.parse(sharedArgRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);

  // Scope conversation (targetKind='scope') MUST be blocked even on the bound Bot!
  const scopeRes = await retainTool.execute(
    { text: 'Should not leak from scope conversation' },
    { conversationId: 102, taskId: 5, callId: 'c-scope' },
    {},
  );
  assert.equal(scopeRes.isError, true);
  assert.equal(JSON.parse(scopeRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);

  // Pi catalog mutating tools MUST remain blocked on tainted conversations!
  const retainGlobalRes = await retainGlobalTool.execute(
    { content: 'Global leak', context: 'email' },
    { conversationId: 101, taskId: 6, callId: 'c-global', toolCallId: 'tc-global' },
    {},
  );
  assert.equal(retainGlobalRes.isError, true);
  assert.equal(JSON.parse(retainGlobalRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);

  const configPatchRes = await configTool.execute(
    { action: 'patch', patch: { recallEnabled: false }, dryRun: false },
    { conversationId: 101, taskId: 7, callId: 'c-cfg-patch', toolCallId: 'tc-cfg-patch' },
    {},
  );
  assert.equal(configPatchRes.isError, true);
  assert.equal(JSON.parse(configPatchRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);

  const bankMissionRes = await bankTool.execute(
    { action: 'update_mission', retainMission: 'hijacked', dryRun: false },
    { conversationId: 101, taskId: 8, callId: 'c-bank-mission', toolCallId: 'tc-bank-mission' },
    {},
  );
  assert.equal(bankMissionRes.isError, true);
  assert.equal(JSON.parse(bankMissionRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);

  // 2. Bound Bot with sharedMemory=true MUST be blocked on primary retain too!
  const pluginSharedEnabled = createHindsightPlugin({
    installationId: 'inst-hs-shared',
    version: '1.2.1',
    dataDir: join(dir, 'bound-shared'),
    host: makeHost(),
  });
  pluginsToClose.push(pluginSharedEnabled);
  const sharedBinding = await pluginSharedEnabled.forBot({
    deviceId: 'dev-1',
    botId: 'bot-bound',
    effectiveConfig: { baseUrl: server.baseUrl, mode: 'read-write', sharedMemory: true },
    credentials: {},
  });
  await sharedBinding.activate();
  const sharedRetainTool = sharedBinding.durableContributions.tools.find((tool) => tool.name.endsWith('_retain'));
  const sharedCfgRes = await sharedRetainTool.execute(
    { text: 'Blocked because sharedMemory is enabled' },
    { conversationId: 101, taskId: 9, callId: 'c-shared-cfg' },
    {},
  );
  assert.equal(sharedCfgRes.isError, true);
  assert.equal(JSON.parse(sharedCfgRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);

  // 3. Unbound Bot with sharedMemory=false MUST remain blocked!
  const pluginUnbound = createHindsightPlugin({
    installationId: 'inst-hs-unbound',
    version: '1.2.1',
    dataDir: join(dir, 'unbound-private'),
    host: makeHost(),
  });
  pluginsToClose.push(pluginUnbound);
  const unboundBinding = await pluginUnbound.forBot({
    deviceId: 'dev-1',
    botId: 'bot-unbound',
    effectiveConfig: { baseUrl: server.baseUrl, mode: 'read-write', sharedMemory: false },
    credentials: {},
  });
  await unboundBinding.activate();
  const unboundRetainTool = unboundBinding.durableContributions.tools.find((tool) => tool.name.endsWith('_retain'));
  const unboundRes = await unboundRetainTool.execute(
    { text: 'Blocked because bot is not bound' },
    { conversationId: 103, taskId: 10, callId: 'c-unbound' },
    {},
  );
  assert.equal(unboundRes.isError, true);
  assert.equal(JSON.parse(unboundRes.output[0].text).code, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);
});

test('Outbox processOneJob re-checks privacy and drops a queued tainted tool-note if proactive binding is revoked before dispatch', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-proactive-hindsight-outbox-'));
  const server = await startMockHindsightServer();
  let runtime = null;
  t.after(async () => {
    await runtime?.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const bot = { botId: 'bot-bound', deviceId: 'dev-1', primaryConversationId: 'conv-bound' };

  await harness.commit(async (tx) => {
    const idx = await tx.doc(PrimaryIndexDoc);
    idx.byPrimary = { 'conv-bound': 201 };
  });

  let bound = true;
  const privacy = createGoogleWorkspacePrivacy({
    getHarness: () => harness,
    context: {},
    canUsePrivateHindsightBank: (botId) => bound && botId === 'bot-bound',
  });

  const assistantEntry = store.appendEntry(201, {
    kind: 'host.user-message',
    data: {
      source: 'host',
      dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
      attribution: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
    },
    model: [{ role: 'user', content: 'Proactive Gmail update' }],
  });
  await privacy.syncTrustedRuleEntries(201, [assistantEntry]);

  // Gate background pump tasks so we can deterministically revoke binding before dispatch.
  let releaseGate;
  const pumpGate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let taskQueued = false;
  let taskFinished = false;

  runtime = createRuntimeHindsight({
    host: {
      deviceId: 'dev-1',
      dataRoot: dir,
      getBot: (id) => (id === 'bot-bound' ? bot : null),
      listBots: () => [bot],
    },
    getHarness: () => harness,
    getWorkContexts: () => ({ resolveWorkContext: async () => ({}) }),
    getWorkActivity: async () => ({ status: 'active' }),
    config: {
      baseUrl: server.baseUrl,
      sharedMemory: false,
      timeoutMs: 10000,
      reflectTimeoutMs: 10000,
    },
    context: {},
    getBotPolicy: () => ({ enabled: true, canRead: true, canWrite: true, mode: 'read-write', retentionFloor: 0 }),
    documents: TEST_DOCS,
    countMessageTokens: () => 10,
    tryRunBackgroundTask: async (_botId, fn) => {
      taskQueued = true;
      await pumpGate;
      await fn();
      taskFinished = true;
    },
    dataPrivacy: privacy,
  });

  // Enqueue while bound=true (passes fromTool admission, sits pending in outbox).
  const receipt = await runtime.fromTool(
    { conversationId: 201, taskId: 100, callId: 'call-queued-1' },
    {},
    'retainMemory',
    { text: 'User wants CFO emails flagged urgently.' },
  );
  assert.equal(receipt.jobs.length, 1);
  assert.equal(receipt.jobs[0].state, 'pending');

  await waitUntil(() => taskQueued, { label: 'outbox task queued at pump gate' });
  assert.equal(server.retainCalls.length, 0);

  // Revoke proactive assistant binding BEFORE outbox job dispatches!
  bound = false;
  releaseGate();

  await waitUntil(() => taskFinished, { label: 'outbox task completed after revocation' });

  // Zero outbound retain or bank calls: job must be terminally rejected locally.
  assert.equal(server.retainCalls.length, 0);
  assert.equal(server.requests.length, 0);

  const status = await runtime.memoryStatus('bot-bound', {});
  assert.equal(status.pending, 0);
  assert.equal(status.accepted, 0);
  assert.equal(status.completed, 0);
  assert.equal(status.failed, 1);
  assert.equal(status.lastErrorCode, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);
  assert.equal(status.jobs[0].operationId, receipt.jobs[0].operationId);
  assert.equal(status.jobs[0].state, 'failed');
  assert.equal(status.jobs[0].lastErrorCode, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);

  // Re-enabling binding later must NOT resurrect the terminally dropped job.
  bound = true;
  runtime.resume();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(server.retainCalls.length, 0);
});

test('Outbox processOneJob also blocks upload if proactive binding is revoked mid-flight before ensureBank/retain', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-proactive-hindsight-inflight-'));
  let bound = true;
  const server = await startMockHindsightServer({
    onGetOperation: () => {
      // Simulate revocation occurring while getOperation is in flight (crash-recovery / retry path).
      bound = false;
    },
  });
  let runtime = null;
  t.after(async () => {
    await runtime?.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const store = createMemoryDurableStore();
  const harness = store.createHarness();
  const bot = { botId: 'bot-bound', deviceId: 'dev-1', primaryConversationId: 'conv-bound' };
  await harness.commit(async (tx) => {
    const idx = await tx.doc(PrimaryIndexDoc);
    idx.byPrimary = { 'conv-bound': 202 };
  });

  const privacy = createGoogleWorkspacePrivacy({
    getHarness: () => harness,
    context: {},
    canUsePrivateHindsightBank: (botId) => bound && botId === 'bot-bound',
  });
  const entry = store.appendEntry(202, {
    kind: 'host.user-message',
    data: {
      source: 'host',
      dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
      attribution: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
    },
    model: [{ role: 'user', content: 'Proactive Calendar update' }],
  });
  await privacy.syncTrustedRuleEntries(202, [entry]);

  runtime = createRuntimeHindsight({
    host: {
      deviceId: 'dev-1',
      dataRoot: dir,
      getBot: (id) => (id === 'bot-bound' ? bot : null),
      listBots: () => [bot],
    },
    getHarness: () => harness,
    getWorkContexts: () => ({ resolveWorkContext: async () => ({}) }),
    getWorkActivity: async () => ({ status: 'active' }),
    config: {
      baseUrl: server.baseUrl,
      sharedMemory: false,
      timeoutMs: 10000,
      reflectTimeoutMs: 10000,
    },
    context: {},
    getBotPolicy: () => ({ enabled: true, canRead: true, canWrite: true, mode: 'read-write', retentionFloor: 0 }),
    documents: TEST_DOCS,
    countMessageTokens: () => 10,
    tryRunBackgroundTask: async (_botId, fn) => await fn(),
    dataPrivacy: privacy,
  });

  await runtime.fromTool(
    { conversationId: 202, taskId: 200, callId: 'call-inflight-1' },
    {},
    'retainMemory',
    { text: 'User skips Friday afternoon meetings.' },
  );

  await waitUntil(async () => {
    const status = await runtime.memoryStatus('bot-bound', {});
    return status.failed === 1;
  }, { label: 'in-flight revoked job marked failed' });

  assert.equal(server.retainCalls.length, 0);
  const status = await runtime.memoryStatus('bot-bound', {});
  assert.equal(status.lastErrorCode, GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE);
});

test('isMutatingCatalogCall uses fail-closed untrimmed read-only allowlists for catalog tools', () => {
  // hindsight_config: only exact 'get' is non-mutating
  assert.equal(isMutatingCatalogCall('hindsight_config', { action: 'get' }), false);
  for (const action of ['patch', 'set', 'unset', 'init', ' get ', 'get ', ' get', '', 'unknown']) {
    assert.equal(isMutatingCatalogCall('hindsight_config', { action }), true, `hindsight_config action=${JSON.stringify(action)}`);
  }
  assert.equal(isMutatingCatalogCall('hindsight_config', {}), true);

  // hindsight_bank: only exact 'get' is non-mutating
  assert.equal(isMutatingCatalogCall('hindsight_bank', { action: 'get' }), false);
  for (const action of ['update_mission', 'import_template', 'set_config', 'reset_config', 'apply_strategy', ' get ', '', 'unknown']) {
    assert.equal(isMutatingCatalogCall('hindsight_bank', { action }), true, `hindsight_bank action=${JSON.stringify(action)}`);
  }
  assert.equal(isMutatingCatalogCall('hindsight_bank', {}), true);

  // hindsight_mental_model: only exact 'list' | 'get' are non-mutating
  assert.equal(isMutatingCatalogCall('hindsight_mental_model', { action: 'list' }), false);
  assert.equal(isMutatingCatalogCall('hindsight_mental_model', { action: 'get' }), false);
  for (const action of ['create', 'update', 'refresh', 'delete', ' get ', ' list ', '', 'unknown']) {
    assert.equal(isMutatingCatalogCall('hindsight_mental_model', { action }), true, `hindsight_mental_model action=${JSON.stringify(action)}`);
  }
  assert.equal(isMutatingCatalogCall('hindsight_mental_model', {}), true);

  // hindsight_knowledge: only exact 'tree' | 'search' | 'get' | 'export' are non-mutating
  for (const readAction of ['tree', 'search', 'get', 'export']) {
    assert.equal(isMutatingCatalogCall('hindsight_knowledge', { action: readAction }), false);
  }
  for (const action of ['create_folder', 'create_page', 'update', 'delete', 'seed_taxonomy', ' get ', ' tree ', '', 'unknown']) {
    assert.equal(isMutatingCatalogCall('hindsight_knowledge', { action }), true, `hindsight_knowledge action=${JSON.stringify(action)}`);
  }
  assert.equal(isMutatingCatalogCall('hindsight_knowledge', {}), true);

  // Always-mutating, unknown (fail-closed), and read-only catalog tools
  assert.equal(isMutatingCatalogCall('hindsight_retain_global', {}), true);
  assert.equal(isMutatingCatalogCall('hindsight_seed_git', {}), true);
  assert.equal(isMutatingCatalogCall('hindsight_scope_migrate', {}), true);
  assert.equal(isMutatingCatalogCall('hindsight_unknown_future_tool', {}), true);
  assert.equal(isMutatingCatalogCall('hindsight_scope', {}), false);
  assert.equal(isMutatingCatalogCall('hindsight_status', {}), false);
});
