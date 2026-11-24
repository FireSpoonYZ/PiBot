import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LiveDoc, ResetEntry } from '@earendil-works/pi-durable';
import {
  BASE_BEHAVIOR_PROMPT,
  DEFAULT_GOOGLE_ASSISTANT_SOUL,
} from '../../host-core/bot-prompt.js';
import {
  BotSessionState,
  GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
  USER_MESSAGE_KIND,
  deriveEntryAttribution,
  isAllowedHostSourceType,
} from '../../host-core/bot-session-context.js';
import { createMcpDriver } from '../../host-core/capabilities/mcp.js';
import { connectCenter } from '../../host-core/center-client.js';
import {
  GOOGLE_WORKSPACE_DATA_BOUNDARY,
  GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
  GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
} from '../../host-core/google-workspace-privacy.js';
import {
  createWebhookConsumer,
  isTrustedGoogleAssistantEvent,
  isTrustedGoogleRuleEvent,
} from '../../host-core/host-webhooks.js';
import {
  ALL_LIVE_EXTENSIONS,
  NO_LIVE_EXTENSIONS,
  normalizeLiveSnapshot,
  projectLiveSnapshotForPeer,
} from '../../host-core/remote-live-protocol.js';
import {
  BotBoardResult,
  GOOGLE_ASSISTANT_BOARD_RESULT_KIND,
  GOOGLE_ASSISTANT_DESENSITIZED_BOARD_SUMMARY,
  GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW,
  botBoardResultHooks,
  isSilentAssistantReply,
  projectBotBoardItem,
} from '../../host-core/runtime-bot-board.js';
import { createBotSessionRuntime } from '../../host-core/runtime-bot-session.js';
import { PrimaryIndex, agentProfileChange } from '../../host-core/runtime-docs.js';
import {
  createExecutionEvent,
  createRunContext,
} from '../../host-core/runtime-execution-context.js';
import { projectLiveState } from '../../host-core/runtime-live-projection.js';
import {
  computeCompletedLastPreview,
  extractProactiveAssistantConfigFromCapabilities,
  normalizeProactiveAssistantConfig,
  selectBotExtensions,
  tightenProactiveAssistantPrivacy,
} from '../../host-core/runtime.js';
import {
  normalizeAttribution,
  parseHistoryEntries,
} from '../src/chatTurnModel.ts';

function makeAssistantWebhookEvent(overrides = {}) {
  return {
    id: 'evt-assistant-1',
    deviceId: 'dev-1',
    botId: 'bot-assistant',
    requestId: 'req-assistant-1',
    status: 'dispatching',
    routeName: 'Google 主动助手',
    instruction: 'Review batched emails and calendar updates.',
    payload: {
      batchKind: 'mail',
      account: 'alice@example.com',
      threads: [{ threadId: 't-1', subject: 'Invoice overdue' }],
    },
    trustedSource: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
    dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
    ...overrides,
  };
}

function waitMicrotasks(turns = 8) {
  let chain = Promise.resolve();
  for (let i = 0; i < turns; i++) {
    chain = chain.then(() => new Promise((resolve) => setImmediate(resolve)));
  }
  return chain;
}

test('isTrustedGoogleAssistantEvent validates strict envelope fields and rejects partial or spoofed markers', () => {
  assert.equal(isTrustedGoogleAssistantEvent(makeAssistantWebhookEvent()), true);
  assert.equal(isTrustedGoogleRuleEvent(makeAssistantWebhookEvent()), false);

  // Missing or mismatched dataBoundary must fail closed.
  assert.equal(isTrustedGoogleAssistantEvent(makeAssistantWebhookEvent({ dataBoundary: undefined })), false);
  assert.equal(isTrustedGoogleAssistantEvent(makeAssistantWebhookEvent({ dataBoundary: 'other' })), false);

  // Unexpected toolPolicy or sessionIsolation must fail closed.
  assert.equal(isTrustedGoogleAssistantEvent(makeAssistantWebhookEvent({ toolPolicy: 'readonly' })), false);
  assert.equal(isTrustedGoogleAssistantEvent(makeAssistantWebhookEvent({ sessionIsolation: 'isolated' })), false);

  // Spoofed markers inside untrusted payload must NEVER promote a plain webhook.
  assert.equal(
    isTrustedGoogleAssistantEvent({
      id: 'evt-plain',
      deviceId: 'dev-1',
      botId: 'bot-assistant',
      requestId: 'req-plain',
      status: 'dispatching',
      routeName: 'Plain Hook',
      instruction: 'Handle webhook',
      payload: {
        trustedSource: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
        dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
      },
    }),
    false,
  );
});

test('createWebhookConsumer routes trusted google-workspace-assistant events strictly to submitGoogleAssistant and fails closed when unavailable', async () => {
  const assistantEvent = makeAssistantWebhookEvent();
  const submittedAssistant = [];
  const submittedWebhooks = [];
  const submittedGoogleRules = [];
  const reportedReceipts = [];

  let polledOnce = false;
  const fakeClient = {
    async pollWebhookEvents() {
      if (polledOnce) return { items: [], nextCursor: null };
      polledOnce = true;
      return { items: [assistantEvent], nextCursor: null };
    },
    async reportWebhookEvent(eventId, receipt) {
      reportedReceipts.push({ eventId, receipt });
      return { ok: true };
    },
  };

  const consumer = createWebhookConsumer({
    deviceId: 'dev-1',
    getClient: () => fakeClient,
    getRuntime: () => ({ getSubmission: async () => null }),
    isReady: () => true,
    getStopStates: async () => [{ botId: 'bot-assistant', stopEpoch: 3, pendingStopEpoch: null }],
    acknowledgeStop: async () => {},
    submitWebhook: async (...args) => {
      submittedWebhooks.push(args);
      return { status: 'queued' };
    },
    submitGoogleRule: async (...args) => {
      submittedGoogleRules.push(args);
      return { status: 'queued' };
    },
    submitGoogleAssistant: async (botId, input, stopEpoch) => {
      submittedAssistant.push({ botId, input, stopEpoch });
      return { status: 'queued' };
    },
  });

  consumer.wake();
  await waitMicrotasks(12);
  await consumer.close();

  assert.equal(submittedWebhooks.length, 0);
  assert.equal(submittedGoogleRules.length, 0);
  assert.equal(submittedAssistant.length, 1);
  assert.equal(submittedAssistant[0].botId, 'bot-assistant');
  assert.equal(submittedAssistant[0].stopEpoch, 3);
  assert.equal(submittedAssistant[0].input.requestId, 'req-assistant-1');
  assert.equal(submittedAssistant[0].input.origin.sender.kind, 'host');
  assert.equal(submittedAssistant[0].input.origin.sender.sourceType, GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE);
  assert.equal(submittedAssistant[0].input.origin.dataBoundary, GOOGLE_WORKSPACE_DATA_BOUNDARY);
  assert.match(submittedAssistant[0].input.text, /Google 主动助手/);
  assert.match(submittedAssistant[0].input.text, /Review batched emails and calendar updates\./);
  assert.match(submittedAssistant[0].input.text, /untrusted JSON task data/);
  assert.equal(reportedReceipts.length, 1);
  assert.equal(reportedReceipts[0].receipt.status, 'queued');

  // Fail closed when submitGoogleAssistant is not wired — never fall back to submitWebhook.
  const failClosedWebhooks = [];
  const failClosedReceipts = [];
  let polledFailClosed = false;
  const consumerNoHandler = createWebhookConsumer({
    deviceId: 'dev-1',
    getClient: () => ({
      async pollWebhookEvents() {
        if (polledFailClosed) return { items: [], nextCursor: null };
        polledFailClosed = true;
        return { items: [makeAssistantWebhookEvent({ id: 'evt-assistant-2', requestId: 'req-assistant-2' })], nextCursor: null };
      },
      async reportWebhookEvent(eventId, receipt) {
        failClosedReceipts.push({ eventId, receipt });
        return { ok: true };
      },
    }),
    getRuntime: () => ({ getSubmission: async () => null }),
    isReady: () => true,
    getStopStates: async () => [{ botId: 'bot-assistant', stopEpoch: 1, pendingStopEpoch: null }],
    acknowledgeStop: async () => {},
    submitWebhook: async (...args) => {
      failClosedWebhooks.push(args);
      return { status: 'queued' };
    },
    submitGoogleRule: async (...args) => {
      failClosedWebhooks.push(args);
      return { status: 'queued' };
    },
  });

  consumerNoHandler.wake();
  await waitMicrotasks(12);
  await consumerNoHandler.close();

  assert.equal(failClosedWebhooks.length, 0);
  assert.equal(failClosedReceipts.length, 1);
  assert.equal(failClosedReceipts[0].receipt.status, 'failed');
  assert.equal(failClosedReceipts[0].receipt.error.code, GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE);

  // Partial marker envelope (missing dataBoundary) must be rejected and never routed to submitWebhook.
  const partialWebhooks = [];
  let polledPartial = false;
  const consumerPartial = createWebhookConsumer({
    deviceId: 'dev-1',
    getClient: () => ({
      async pollWebhookEvents() {
        if (polledPartial) return { items: [], nextCursor: null };
        polledPartial = true;
        return {
          items: [makeAssistantWebhookEvent({ id: 'evt-partial', requestId: 'req-partial', dataBoundary: undefined })],
          nextCursor: null,
        };
      },
      async reportWebhookEvent() {
        return { ok: true };
      },
    }),
    getRuntime: () => ({ getSubmission: async () => null }),
    isReady: () => true,
    getStopStates: async () => [{ botId: 'bot-assistant', stopEpoch: 1, pendingStopEpoch: null }],
    acknowledgeStop: async () => {},
    submitWebhook: async (...args) => {
      partialWebhooks.push(args);
      return { status: 'queued' };
    },
    submitGoogleAssistant: async (...args) => {
      partialWebhooks.push(args);
      return { status: 'queued' };
    },
  });

  consumerPartial.wake();
  await waitMicrotasks(12);
  await consumerPartial.close();
  assert.equal(partialWebhooks.length, 0);
});

test('connectCenter sends x-pibot-google-assistant poll header and forwards optional backgroundProactive flag', async () => {
  const captured = [];
  const sseResponses = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/api/host/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseResponses.add(res);
      req.on('close', () => sseResponses.delete(res));
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      captured.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [], nextCursor: null, tools: [], content: [] }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let client = null;
  try {
    client = await connectCenter({
      centerUrl: `http://127.0.0.1:${port}`,
      deviceId: 'dev-1',
      deviceToken: 'a'.repeat(40),
    });

    await client.pollWebhookEvents({ cursor: 'c-1' });
    await client.listCapabilityTools('builtin.google-workspace', 'bot-1', { backgroundProactive: true });
    await client.listCapabilityTools('builtin.google-workspace', 'bot-1');
    await client.callCapabilityTool('builtin.google-workspace', 'bot-1', 'gmail_search', { q: 'is:unread' }, 'call-1', { backgroundProactive: true });
    await client.callCapabilityTool('builtin.google-workspace', 'bot-1', 'gmail_search', { q: 'is:unread' }, 'call-2');

    assert.equal(captured.length, 5);
    assert.equal(captured[0].url, '/api/host/webhook-events/poll');
    assert.equal(captured[0].headers['x-pibot-mcp-dispatch'], 'isolated');
    assert.equal(captured[0].headers['x-pibot-google-assistant'], 'batch-v1');

    assert.equal(captured[1].body.backgroundProactive, true);
    assert.equal(Object.hasOwn(captured[2].body, 'backgroundProactive'), false);
    assert.equal(captured[3].body.backgroundProactive, true);
    assert.equal(Object.hasOwn(captured[4].body, 'backgroundProactive'), false);
  } finally {
    await client?.close();
    for (const res of sseResponses) res.end();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('isSilentAssistantReply recognizes empty and (pass) variants while preserving real replies', () => {
  for (const silent of ['', '   ', '\n\t ', '(pass)', 'pass', 'PASS', '( pass )', '(PASS).', 'pass.', null, undefined]) {
    assert.equal(isSilentAssistantReply(silent), true, `expected silent for ${JSON.stringify(silent)}`);
  }
  for (const nonSilent of ['有新的重要邮件', 'pass the report to Alice', '(pass) also check invoice', 'Meeting in 10 minutes']) {
    assert.equal(isSilentAssistantReply(nonSilent), false, `expected non-silent for ${JSON.stringify(nonSilent)}`);
  }
});

test('dedicated proactive assistant Bot toolset lock excludes local/admin/browser/other plugins and prunes stale tools', () => {
  assert.equal(normalizeProactiveAssistantConfig(null), null);
  assert.equal(normalizeProactiveAssistantConfig({ role: 'admin' }), null);
  assert.deepEqual(
    normalizeProactiveAssistantConfig({
      role: 'dedicated',
      accounts: [' alice@example.com ', '', 'bob@example.com'],
      hindsightPrivateMemory: true,
    }),
    { role: 'dedicated', accounts: ['alice@example.com', 'bob@example.com'], hindsightPrivateMemory: true },
  );

  const extracted = extractProactiveAssistantConfigFromCapabilities([
    {
      installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
      target: 'center',
      enabled: true,
      authorized: true,
      effectiveConfig: {
        proactiveAssistant: { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: true },
      },
    },
  ]);
  assert.deepEqual(extracted, { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: true });
  assert.equal(
    extractProactiveAssistantConfigFromCapabilities([
      {
        installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
        target: 'center',
        enabled: false,
        authorized: true,
        effectiveConfig: { proactiveAssistant: { role: 'dedicated', accounts: [] } },
      },
    ]),
    null,
  );

  const ext = (name, tools = []) => ({ name, tools: tools.map((toolName) => ({ name: toolName })) });
  const toolSearchExt = ext('custom.tool-search', ['tool_search']);
  const coreExtensions = [
    ext('host.base-behavior'),
    ext('pi.coding-tools', ['bash', 'read', 'write', 'edit']),
    ext('host.bot-board'),
    toolSearchExt,
    ext('host.tools', ['grep', 'find', 'ls', 'session_search']),
    ext('host.communication', ['send_to', 'list_bots']),
    ext('host.schedule', ['schedule_task']),
    ext('host.operations', ['automation_google_rule_list']),
    ext('host.bot-management-skill'),
    ext('host.android-tools', ['android_apps']),
    ext('host.shower', ['shower']),
    ext('host.cua', ['cua_click']),
    ext('host.request-context'),
  ];
  const botHostExtensions = [
    ext('host.bot-browser', ['browser_open']),
    ext('host.google-setup', ['google_setup']),
  ];
  const googleExt = ext('cap-google-hash', ['mcp_gmail_search', 'mcp_gmail_read', 'mcp_gmail_draft']);
  const hindsightExt = ext('cap-hindsight-hash', ['hindsight_retain', 'hindsight_recall']);
  const webfoxExt = ext('cap-webfox-hash', ['web_search']);
  const vaultExt = ext('cap-vault-hash', ['vault_find']);
  const pluginExtensions = [googleExt, hindsightExt, webfoxExt, vaultExt];
  const codemodeExt = ext('pi.codemode', ['codemode']);
  const finalBudgetExt = ext('cap-final-budget');

  const dedicatedSelection = selectBotExtensions({
    coreExtensions,
    botHostExtensions,
    pluginExtensions,
    codemodeEnabled: true,
    codemodeExtension: codemodeExt,
    finalBudgetExtension: finalBudgetExt,
    toolSearchExtension: toolSearchExt,
    proactiveAssistant: extracted,
    allowedDedicatedPluginExtensionNames: new Set(['cap-google-hash', 'cap-hindsight-hash']),
  });

  assert.equal(dedicatedSelection.isDedicated, true);
  const dedicatedNames = dedicatedSelection.selectedExtensions.map((item) => item.name);
  assert.deepEqual(dedicatedNames, [
    'host.base-behavior',
    'host.bot-board',
    'custom.tool-search',
    'host.request-context',
    'pi.codemode',
    'cap-google-hash',
    'cap-hindsight-hash',
    'cap-final-budget',
  ]);
  for (const forbidden of [
    'pi.coding-tools',
    'host.tools',
    'host.communication',
    'host.schedule',
    'host.operations',
    'host.bot-management-skill',
    'host.android-tools',
    'host.shower',
    'host.cua',
    'host.bot-browser',
    'host.google-setup',
    'cap-webfox-hash',
    'cap-vault-hash',
  ]) {
    assert.equal(dedicatedNames.includes(forbidden), false, `dedicated Bot must exclude ${forbidden}`);
  }

  // agentProfileChange with strictTools=true prunes stale excluded tools from persisted array state.tools.
  const change = agentProfileChange(
    {
      extensions: ['pi.coding-tools', 'host.communication', 'cap-google-hash'],
      tools: ['bash', 'read', 'send_to', 'mcp_gmail_search', 'web_search'],
    },
    {
      selectedExtensions: dedicatedSelection.selectedExtensions,
      pluginTools: dedicatedSelection.selectedPluginExtensions.flatMap((item) => item.tools ?? []),
      strictTools: true,
    },
  );
  assert.ok(change);
  assert.deepEqual(
    change.tools.map((tool) => tool.name),
    ['mcp_gmail_search', 'mcp_gmail_read', 'mcp_gmail_draft', 'hindsight_retain', 'hindsight_recall'],
  );

  // Existing proactive assistant Bots and normal Bots retain ALL extensions untouched.
  for (const policy of [{ role: 'existing', accounts: ['alice@example.com'], hindsightPrivateMemory: false }, null]) {
    const selection = selectBotExtensions({
      coreExtensions,
      botHostExtensions,
      pluginExtensions,
      codemodeEnabled: false,
      codemodeExtension: codemodeExt,
      finalBudgetExtension: finalBudgetExt,
      toolSearchExtension: toolSearchExt,
      proactiveAssistant: policy,
      allowedDedicatedPluginExtensionNames: new Set(['cap-google-hash']),
    });
    assert.equal(selection.isDedicated, false);
    const names = selection.selectedExtensions.map((item) => item.name);
    assert.equal(names.includes('pi.coding-tools'), true);
    assert.equal(names.includes('host.communication'), true);
    assert.equal(names.includes('host.bot-browser'), true);
    assert.equal(names.includes('cap-webfox-hash'), true);
  }
});

test('capabilities/mcp.js blocks gmail_read downloads and drive_download for dedicated Bots and background proactive turns, and forwards backgroundProactive', async () => {
  async function createHarnessDriver({ role, runContext, turn }) {
    const centerCalls = [];
    const prepareCalls = [];
    const privacyStarts = [];

    const host = {
      assertCapabilityAllowed() {},
      resolveConversationBot: async () => 'bot-1',
      getProactiveAssistantConfig: () => (role ? { role, accounts: ['alice@example.com'], hindsightPrivateMemory: false } : null),
      getRunContext: async () => runContext,
      getTurn: async () => turn,
      host: { getBot: () => ({ botId: 'bot-1', cwd: '/tmp/workspace' }) },
      dataPrivacy: {
        async recordGoogleWorkspaceCallStart(info) {
          privacyStarts.push(info);
          return { markId: 'm-1' };
        },
        async recordGoogleWorkspaceCallOutcome() {},
      },
      centerClient: {
        async listCapabilityTools() {
          return {
            tools: [
              { name: 'gmail_read', description: 'Read email', inputSchema: { type: 'object', properties: {} } },
              { name: 'gmail_draft', description: 'Draft reply', inputSchema: { type: 'object', properties: {} } },
              { name: 'gmail_attachment', description: 'Download attachment', inputSchema: { type: 'object', properties: {} } },
              { name: 'gmail_send', description: 'Send email', inputSchema: { type: 'object', properties: {} } },
              { name: 'drive_download', description: 'Download Drive file', inputSchema: { type: 'object', properties: {} } },
              { name: 'drive_upload', description: 'Upload Drive file', inputSchema: { type: 'object', properties: {} } },
              { name: 'docs_create', description: 'Create Google Doc', inputSchema: { type: 'object', properties: {} } },
            ],
          };
        },
        async callCapabilityTool(id, botId, name, args, callId, options) {
          centerCalls.push({ id, botId, name, args, callId, options });
          return { content: [{ type: 'text', text: 'ok' }], isError: false };
        },
      },
    };

    const driver = await createMcpDriver({
      installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
      version: 'builtin',
      target: 'center',
      dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
      packageRoot: null,
      host,
      googleFileTransfer: {
        async prepareGoogleFileCall(toolName, rawArgs) {
          prepareCalls.push({ toolName, rawArgs });
          return rawArgs;
        },
        async finishGoogleFileCall(_toolName, result) {
          return result;
        },
      },
    });
    const bot = await driver.forBot({
      botId: 'bot-1',
      effectiveConfig: role ? { proactiveAssistant: { role, accounts: ['alice@example.com'], hindsightPrivateMemory: false } } : {},
      credentials: {},
    });
    await bot.prepare();
    await bot.activate();
    const byRemote = Object.fromEntries(
      bot.durableContributions.tools.map((tool) => {
        const match = /^MCP tool ([^:]+):/.exec(tool.description);
        return [match[1], tool];
      }),
    );
    return { bot, byRemote, centerCalls, prepareCalls, privacyStarts };
  }

  const api = { conversationId: 11, callId: 'call-1', taskId: 99 };
  const invocation = {};

  // 1. Existing Bot during background google-workspace-assistant turn (via getRunContext):
  //    blocks download/out, gmail_draft bodyFile/attach/attachments, and disallowed tools (drive_download,
  //    drive_upload, gmail_attachment, gmail_send, docs_create) BEFORE prepareTransfer/Center call;
  //    forwards backgroundProactive=true on allowed read/draft.
  {
    const ctx = await createHarnessDriver({
      role: 'existing',
      runContext: { events: [{ source: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } }] },
      turn: null,
    });
    await assert.rejects(
      () => ctx.byRemote.gmail_read.execute({ id: 'msg-1', download: 'att-1' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_read.execute({ id: 'msg-1', out: 'invoice.pdf' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_draft.execute({ replyTo: 'msg-1', bodyFile: 'secret.txt' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_draft.execute({ replyTo: 'msg-1', body: 'hi', attach: 'secret.pdf' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_draft.execute({ replyTo: 'msg-1', body: 'hi', attachments: ['secret.pdf'] }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.drive_download.execute({ fileId: 'f-1' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.drive_upload.execute({ path: 'secret.txt' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_attachment.execute({ messageId: 'm-1', attachmentId: 'a-1' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_send.execute({ to: 'x@example.com', subject: 'hi', body: 'hi' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.docs_create.execute({ title: 'Exfil', bodyFile: 'secret.txt' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    assert.equal(ctx.prepareCalls.length, 0);
    assert.equal(ctx.centerCalls.length, 0);
    assert.equal(ctx.privacyStarts.length, 0);

    await ctx.byRemote.gmail_read.execute({ id: 'msg-1' }, api, invocation);
    await ctx.byRemote.gmail_draft.execute({ replyTo: 'msg-1', body: 'Thanks, noted.' }, api, invocation);
    assert.equal(ctx.centerCalls.length, 2);
    assert.equal(ctx.centerCalls[0].options.backgroundProactive, true);
    assert.equal(ctx.centerCalls[1].options.backgroundProactive, true);
    await ctx.bot.close();
  }

  // 2. Fallback via host.getTurn when getRunContext returns null: still detects backgroundProactive.
  {
    const ctx = await createHarnessDriver({
      role: 'existing',
      runContext: null,
      turn: { sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
    });
    await ctx.byRemote.gmail_read.execute({ id: 'msg-2' }, api, invocation);
    assert.equal(ctx.centerCalls.length, 1);
    assert.equal(ctx.centerCalls[0].options.backgroundProactive, true);
    await ctx.bot.close();
  }

  // 3. Dedicated Bot on ordinary human turn: still blocks downloads, local file staging, and disallowed tools; does NOT pass backgroundProactive=true.
  {
    const ctx = await createHarnessDriver({
      role: 'dedicated',
      runContext: { events: [{ source: 'user', sender: { kind: 'user' } }] },
      turn: { sender: { kind: 'user' } },
    });
    await assert.rejects(
      () => ctx.byRemote.gmail_read.execute({ id: 'msg-1', download: true }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_draft.execute({ replyTo: 'msg-1', bodyFile: 'secret.txt' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.drive_download.execute({ fileId: 'f-1' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.drive_upload.execute({ path: 'secret.txt' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ctx.byRemote.gmail_attachment.execute({ messageId: 'm-1', attachmentId: 'a-1' }, api, invocation),
      (err) => err.code === 'FORBIDDEN',
    );
    assert.equal(ctx.prepareCalls.length, 0);
    assert.equal(ctx.centerCalls.length, 0);

    await ctx.byRemote.gmail_read.execute({ id: 'msg-1' }, api, invocation);
    assert.equal(ctx.centerCalls.length, 1);
    assert.equal(Object.hasOwn(ctx.centerCalls[0].options, 'backgroundProactive'), false);
    await ctx.bot.close();
  }

  // 4. Existing Bot on ordinary human turn: allows gmail_read download, gmail_draft bodyFile, and drive_download without backgroundProactive.
  {
    const ctx = await createHarnessDriver({
      role: 'existing',
      runContext: { events: [{ source: 'user', sender: { kind: 'user' } }] },
      turn: { sender: { kind: 'user' } },
    });
    await ctx.byRemote.gmail_read.execute({ id: 'msg-1', download: 'att-1' }, api, invocation);
    await ctx.byRemote.gmail_draft.execute({ replyTo: 'msg-1', bodyFile: 'reply.txt' }, api, invocation);
    await ctx.byRemote.drive_download.execute({ fileId: 'f-1' }, api, invocation);
    assert.equal(ctx.prepareCalls.length, 3);
    assert.equal(ctx.centerCalls.length, 3);
    assert.equal(Object.hasOwn(ctx.centerCalls[0].options, 'backgroundProactive'), false);
    assert.equal(Object.hasOwn(ctx.centerCalls[1].options, 'backgroundProactive'), false);
    assert.equal(Object.hasOwn(ctx.centerCalls[2].options, 'backgroundProactive'), false);
    await ctx.bot.close();
  }
});

test('tightenProactiveAssistantPrivacy immediately revokes hindsightPrivateMemory on busy/revoked snapshots without granting early or loosening dedicated lock', () => {
  const dedicatedPrivate = { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: true };
  const dedicatedNoPrivate = { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: false };

  // Snapshot keeps hindsightPrivateMemory=true -> unchanged reference.
  assert.equal(
    tightenProactiveAssistantPrivacy(dedicatedPrivate, [
      {
        installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
        target: 'center',
        enabled: true,
        authorized: true,
        effectiveConfig: { proactiveAssistant: { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: true } },
      },
    ]),
    dedicatedPrivate,
  );

  // Snapshot flips hindsightPrivateMemory=false while builtin.google-workspace stays enabled/authorized -> immediately tightened, role stays dedicated.
  assert.deepEqual(
    tightenProactiveAssistantPrivacy(dedicatedPrivate, [
      {
        installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
        target: 'center',
        enabled: true,
        authorized: true,
        effectiveConfig: { proactiveAssistant: { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: false } },
      },
    ]),
    { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: false },
  );

  // Snapshot pauses/removes proactiveAssistant (effectiveConfig: {}) -> immediately tightened, role stays dedicated until idle apply.
  assert.deepEqual(
    tightenProactiveAssistantPrivacy(dedicatedPrivate, [
      {
        installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
        target: 'center',
        enabled: true,
        authorized: true,
        effectiveConfig: {},
      },
    ]),
    { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: false },
  );

  // Tighten-only: never grants hindsightPrivateMemory=true early before idle applyBot.
  assert.equal(
    tightenProactiveAssistantPrivacy(dedicatedNoPrivate, [
      {
        installationId: GOOGLE_WORKSPACE_MCP_INSTALLATION_ID,
        target: 'center',
        enabled: true,
        authorized: true,
        effectiveConfig: { proactiveAssistant: { role: 'dedicated', accounts: ['alice@example.com'], hindsightPrivateMemory: true } },
      },
    ]),
    dedicatedNoPrivate,
  );
  assert.equal(tightenProactiveAssistantPrivacy(null, []), null);
});

test('BotBoardResult preserves positive proactive alert across silent (pass) sweeps and desensitizes summaries & lastPreview', async () => {
  const boardDocs = new Map();
  const sessionDocs = new Map();
  const liveDocs = new Map();
  const submissions = new Map();
  const entries = new Map();

  const harness = {
    async snapshot(docDef, convId) {
      if (docDef === BotBoardResult) return boardDocs.get(convId) ?? docDef.initial();
      if (docDef === BotSessionState) return sessionDocs.get(convId) ?? null;
      if (docDef === LiveDoc) return liveDocs.get(convId) ?? null;
      return null;
    },
    async commit(fn) {
      const tx = {
        async doc(docDef, convId) {
          if (docDef === BotBoardResult) {
            if (!boardDocs.has(convId)) boardDocs.set(convId, docDef.initial());
            return boardDocs.get(convId);
          }
          throw new Error(`unexpected doc ${docDef?.kind}`);
        },
        async submission(subId) {
          return submissions.get(subId) ?? null;
        },
        async entry(entryId) {
          return entries.get(entryId) ?? null;
        },
      };
      return await fn(tx);
    },
  };

  let dedicatedFlag = false;
  const hooks = botBoardResultHooks(() => harness, {
    isDedicatedAssistantBot: () => dedicatedFlag,
  });

  const makeApi = (taskId) => ({
    conversationId: 7,
    taskId,
    async entry(entryId) {
      return entries.get(entryId) ?? null;
    },
  });

  // Turn 1: Positive proactive assistant alert (identified via LiveDoc.run.inputs BEFORE BotSessionState is set!).
  entries.set(10, {
    id: 10,
    kind: USER_MESSAGE_KIND,
    data: {
      requestId: 'req-p1',
      attribution: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, channel: 'primary' },
    },
  });
  submissions.set(100, { id: 100, type: 'input', entry: 10 });
  liveDocs.set(7, { run: { taskId: 1, inputs: [100] } });
  await hooks.beforeRequest({}, makeApi(1), {});

  sessionDocs.set(7, {
    turnByTask: { '1': 'req-p1' },
    completedTurns: {
      'req-p1': { requestId: 'req-p1', sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
    },
    activeTurn: null,
  });
  entries.set(11, {
    id: 11,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'Secret invoice $42,000 from Acme Corp is overdue.' }] }],
  });
  await hooks.afterRun({ answer: 11 }, makeApi(1), {});

  const afterPositive = boardDocs.get(7).lastResult;
  assert.equal(afterPositive.id, '11');
  assert.equal(afterPositive.summary, GOOGLE_ASSISTANT_DESENSITIZED_BOARD_SUMMARY);
  assert.equal(afterPositive.kind, GOOGLE_ASSISTANT_BOARD_RESULT_KIND);
  assert.equal(afterPositive.summary.includes('42,000'), false);

  // projectBotBoardItem preserves kind when idle and hides while busy.
  const projectedIdle = projectBotBoardItem(
    'bot-1',
    'pub-1',
    { activity: { phase: 'idle' }, queuedCount: 0 },
    { docs: { 'pi.live': {} } },
    { lastResult: afterPositive },
  );
  assert.deepEqual(projectedIdle.lastResult, afterPositive);

  // Turn 2: Subsequent silent "(pass)" proactive sweep — beforeRequest runs BEFORE BotSessionState has task 2!
  entries.set(12, {
    id: 12,
    kind: USER_MESSAGE_KIND,
    data: {
      requestId: 'req-p2',
      turn: { sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
    },
  });
  submissions.set(101, { id: 101, type: 'input', entry: 12 });
  liveDocs.set(7, { run: { taskId: 2, inputs: [101] } });
  await hooks.beforeRequest({}, makeApi(2), {});
  // Prior positive alert MUST still be intact during and after the silent sweep!
  assert.deepEqual(boardDocs.get(7).lastResult, afterPositive);

  sessionDocs.get(7).turnByTask['2'] = 'req-p2';
  sessionDocs.get(7).completedTurns['req-p2'] = {
    requestId: 'req-p2',
    sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
  };
  entries.set(13, {
    id: 13,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: '(pass)' }] }],
  });
  await hooks.afterRun({ answer: 13 }, makeApi(2), {});
  assert.deepEqual(boardDocs.get(7).lastResult, afterPositive);

  // Turn 3: Human turn starts -> clears prior alert; dedicated Bot keeps manual reply summary desensitized.
  dedicatedFlag = true;
  entries.set(14, {
    id: 14,
    kind: USER_MESSAGE_KIND,
    data: { requestId: 'req-u1', attribution: { kind: 'user', channel: 'primary' } },
  });
  submissions.set(102, { id: 102, type: 'input', entry: 14 });
  liveDocs.set(7, { run: { taskId: 3, inputs: [102] } });
  await hooks.beforeRequest({}, makeApi(3), {});
  assert.equal(boardDocs.get(7).lastResult, null);

  sessionDocs.get(7).turnByTask['3'] = 'req-u1';
  sessionDocs.get(7).completedTurns['req-u1'] = { requestId: 'req-u1', sender: { kind: 'user' } };
  entries.set(15, {
    id: 15,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'Private salary discussion with HR' }] }],
  });
  await hooks.afterRun({ answer: 15 }, makeApi(3), {});
  assert.equal(boardDocs.get(7).lastResult.id, '15');
  assert.equal(boardDocs.get(7).lastResult.summary, GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW);
  assert.equal(boardDocs.get(7).lastResult.kind, undefined);
  assert.equal(boardDocs.get(7).lastResult.summary.includes('salary'), false);

  // computeCompletedLastPreview matrix.
  assert.deepEqual(
    computeCompletedLastPreview({ isProactiveAssistantTurn: true, isDedicatedAssistantBot: false, answerText: '(pass)' }),
    { skip: true, lastPreview: null },
  );
  assert.deepEqual(
    computeCompletedLastPreview({ isProactiveAssistantTurn: true, isDedicatedAssistantBot: true, answerText: '   ' }),
    { skip: true, lastPreview: null },
  );
  assert.deepEqual(
    computeCompletedLastPreview({ isProactiveAssistantTurn: true, isDedicatedAssistantBot: false, answerText: 'Urgent email from CEO' }),
    { skip: false, lastPreview: GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW },
  );
  assert.deepEqual(
    computeCompletedLastPreview({ isProactiveAssistantTurn: false, isDedicatedAssistantBot: true, answerText: 'Private reply' }),
    { skip: false, lastPreview: GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW },
  );
  assert.deepEqual(
    computeCompletedLastPreview({ isProactiveAssistantTurn: false, isDedicatedAssistantBot: false, answerText: 'Normal code answer' }),
    { skip: false, lastPreview: 'Normal code answer' },
  );
});

test('google-workspace-assistant source propagates through execution context, remote live downgrade, routing note, and prompts', async () => {
  assert.equal(isAllowedHostSourceType(GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE), true);
  assert.equal(
    deriveEntryAttribution(
      {
        id: 1,
        kind: USER_MESSAGE_KIND,
        data: {
          requestId: 'req-a1',
          attribution: { kind: 'host', channel: 'primary', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, name: 'Google 主动助手' },
        },
      },
      null,
    )?.sourceType,
    GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
  );

  // Execution context accepts google-workspace-assistant.
  const execEvent = createExecutionEvent({
    turn: {
      requestId: 'req-a1',
      kind: 'primary',
      sender: { kind: 'host', deviceId: 'dev-1', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
      replyTarget: { kind: 'primary' },
    },
    submissionId: 5,
  });
  assert.equal(execEvent.source, GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE);
  assert.equal(execEvent.sender.sourceType, GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE);
  const runCtx = createRunContext({
    identity: { deviceId: 'dev-1', botId: 'bot-1', conversationId: 'pub-1', nativeConversationId: 7 },
    nativeRun: { taskId: 42, inputs: [5] },
    events: [execEvent],
    status: 'running',
  });
  assert.equal(runCtx.events[0].source, GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE);

  // Remote live protocol: accepted with ALL_LIVE_EXTENSIONS, rejected with NO_LIVE_EXTENSIONS, downgraded for legacy peers.
  const snapshotFrame = {
    type: 'snapshot',
    botId: 'bot-1',
    conversationId: 'pub-1',
    sequence: 1,
    state: {
      history: [
        {
          id: 10,
          kind: USER_MESSAGE_KIND,
          messages: [{ role: 'user', text: 'Batch payload', truncated: false }],
          attribution: {
            kind: 'host',
            channel: 'primary',
            sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
            name: 'Google 主动助手',
          },
        },
      ],
      historyTruncated: false,
      lastEntryId: 10,
      generation: null,
      tools: [],
      toolsTruncated: false,
      busy: false,
      queuedCount: 0,
      activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
    },
  };
  const normalizedModern = normalizeLiveSnapshot(snapshotFrame, undefined, { liveExtensions: ALL_LIVE_EXTENSIONS });
  assert.equal(normalizedModern.state.history[0].attribution.sourceType, GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE);
  assert.throws(() => normalizeLiveSnapshot(snapshotFrame, undefined, { liveExtensions: NO_LIVE_EXTENSIONS }));

  const downgraded = projectLiveSnapshotForPeer(normalizedModern, NO_LIVE_EXTENSIONS);
  assert.equal(downgraded.state.history[0].attribution.sourceType, 'google-workspace-rule');
  assert.equal(
    normalizeLiveSnapshot(downgraded, undefined, { liveExtensions: NO_LIVE_EXTENSIONS }).state.history[0].attribution.sourceType,
    'google-workspace-rule',
  );

  // Bot session routing note for google-workspace-assistant.
  const entry = {
    id: 20,
    kind: USER_MESSAGE_KIND,
    data: {
      requestId: 'req-batch-1',
      turn: {
        requestId: 'req-batch-1',
        kind: 'primary',
        sender: { kind: 'host', name: 'Google 主动助手', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE },
        replyTarget: { kind: 'primary' },
      },
    },
  };
  const sessionState = BotSessionState.initial();
  const fakeHarness = {
    async snapshot(docDef) {
      if (docDef === PrimaryIndex) return { byPrimary: { 'pub-1': 7 } };
      if (docDef === BotSessionState) return sessionState;
      if (docDef === LiveDoc) return { run: { taskId: 50, inputs: [200] } };
      return null;
    },
    async getTask() {
      return { id: 50, conversationId: 7, state: { checkpoint: { cutoff: 20 } } };
    },
    async conversation() {
      return {
        async context() {
          return { entries: [entry], messages: [{ role: 'user', content: 'batch' }], contributions: [[{ role: 'user', content: 'batch' }]] };
        },
      };
    },
    async submission() {
      return { async status() { return { id: 200, type: 'input', requestId: 'req-batch-1', entry: 20 }; } };
    },
    async commit(fn) {
      return await fn({
        async doc(docDef) {
          if (docDef === BotSessionState) return sessionState;
          throw new Error(`unexpected doc ${docDef?.kind}`);
        },
        async entry() {
          return entry;
        },
      });
    },
  };
  const sessions = createBotSessionRuntime({
    host: {
      deviceId: 'dev-1',
      listBots: () => [{ botId: 'bot-1', deviceId: 'dev-1', primaryConversationId: 'pub-1' }],
      getBot: () => ({ botId: 'bot-1', deviceId: 'dev-1', primaryConversationId: 'pub-1' }),
    },
    getHarness: () => fakeHarness,
    getMessageLog: () => null,
    context: {},
    getPrimary: async () => null,
  });
  const routed = await sessions.beforeRequest(
    { messages: [{ role: 'user', content: 'batch' }] },
    { conversationId: 7, taskId: 50, memo: async (_k, value) => value },
    {},
  );
  assert.equal(routed.messages.length, 2);
  const routingText = routed.messages[0].sections['host-turn-routing'];
  assert.match(routingText, /untrusted data/i);
  assert.match(routingText, /gmail_draft/);
  assert.match(routingText, /never send external emails/i);
  assert.match(routingText, /\(pass\)/);

  // Prompts: BASE_BEHAVIOR_PROMPT includes the 3 proactive rules and DEFAULT_GOOGLE_ASSISTANT_SOUL is exported.
  assert.match(BASE_BEHAVIOR_PROMPT, /Check before answering/i);
  assert.match(BASE_BEHAVIOR_PROMPT, /gmail_draft/);
  assert.match(BASE_BEHAVIOR_PROMPT, /google-workspace-assistant/);
  assert.match(BASE_BEHAVIOR_PROMPT, /\(pass\)/);
  assert.equal(typeof DEFAULT_GOOGLE_ASSISTANT_SOUL, 'string');
  assert.match(DEFAULT_GOOGLE_ASSISTANT_SOUL, /gmail_draft/);
  assert.match(DEFAULT_GOOGLE_ASSISTANT_SOUL, /\(pass\)/);
});

test('runtime-live-projection and chatTurnModel suppress settled silent (pass) proactive turns while keeping positive, error, in-flight, and human turns', () => {
  assert.equal(
    normalizeAttribution({ kind: 'host', channel: 'primary', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE })?.sourceType,
    GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
  );

  const sessionState = {
    clearedThroughEntryId: 0,
    turnByTask: { '101': 'req-silent', '102': 'req-positive', '103': 'req-error' },
    completedTurns: {
      'req-silent': { requestId: 'req-silent', sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
      'req-positive': { requestId: 'req-positive', sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
      'req-error': { requestId: 'req-error', sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE } },
    },
    activeTurn: null,
  };

  const silentTrigger = {
    id: 1,
    kind: USER_MESSAGE_KIND,
    data: {
      requestId: 'req-silent',
      attribution: { kind: 'host', channel: 'primary', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, messageId: 'req-silent', name: 'Google 主动助手' },
    },
    model: [{ role: 'user', content: [{ type: 'text', text: 'Batch 1' }] }],
  };
  const silentToolCall = {
    id: 2,
    kind: 'pi.assistant',
    byTaskId: 101,
    data: { attribution: { kind: 'bot', channel: 'primary', replyTo: 'req-silent' } },
    model: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Checking inbox...' }, { type: 'toolCall', id: 'tc-1', name: 'gmail_search', arguments: { q: 'is:unread' } }] }],
  };
  const silentToolResult = {
    id: 3,
    kind: 'pi.tool-result',
    byTaskId: 101,
    model: [{ role: 'toolResult', toolCallId: 'tc-1', toolName: 'gmail_search', content: [{ type: 'text', text: '[]' }] }],
  };
  const silentAnswer = {
    id: 4,
    kind: 'pi.assistant',
    byTaskId: 101,
    data: { attribution: { kind: 'bot', channel: 'primary', replyTo: 'req-silent' } },
    model: [{ role: 'assistant', content: [{ type: 'text', text: '(pass)' }] }],
  };
  const positiveTrigger = {
    id: 5,
    kind: USER_MESSAGE_KIND,
    data: {
      requestId: 'req-positive',
      attribution: { kind: 'host', channel: 'primary', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, messageId: 'req-positive', name: 'Google 主动助手' },
    },
    model: [{ role: 'user', content: [{ type: 'text', text: 'Batch 2' }] }],
  };
  const positiveAnswer = {
    id: 6,
    kind: 'pi.assistant',
    byTaskId: 102,
    data: { attribution: { kind: 'bot', channel: 'primary', replyTo: 'req-positive' } },
    model: [{ role: 'assistant', content: [{ type: 'text', text: 'You have a meeting with Alice in 15 minutes.' }] }],
  };
  const errorTrigger = {
    id: 7,
    kind: USER_MESSAGE_KIND,
    data: {
      requestId: 'req-error',
      attribution: { kind: 'host', channel: 'primary', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, messageId: 'req-error', name: 'Google 主动助手' },
    },
    model: [{ role: 'user', content: [{ type: 'text', text: 'Batch 3' }] }],
  };
  const errorAnswer = {
    id: 8,
    kind: 'pi.assistant',
    byTaskId: 103,
    data: { attribution: { kind: 'bot', channel: 'primary', replyTo: 'req-error' } },
    model: [{ role: 'assistant', stopReason: 'error', errorMessage: 'provider timeout', content: [] }],
  };
  const humanTrigger = {
    id: 9,
    kind: USER_MESSAGE_KIND,
    data: { requestId: 'req-human', attribution: { kind: 'user', channel: 'primary', messageId: 'req-human' } },
    model: [{ role: 'user', content: [{ type: 'text', text: 'Say (pass)' }] }],
  };
  const humanPassReply = {
    id: 10,
    kind: 'pi.assistant',
    data: { attribution: { kind: 'bot', channel: 'primary', replyTo: 'req-human' } },
    model: [{ role: 'assistant', content: [{ type: 'text', text: '(pass)' }] }],
  };

  // Live projection suppresses entries 1..4 (silent proactive sweep), keeps 5..10.
  const settledEntries = [
    silentTrigger, silentToolCall, silentToolResult, silentAnswer,
    positiveTrigger, positiveAnswer, errorTrigger, errorAnswer, humanTrigger, humanPassReply,
  ];
  const liveProjected = projectLiveState(
    { entries: settledEntries, docs: { 'pi.live': { run: null, tools: [], nestedTools: [] }, 'pi.inbox': { items: [] } } },
    sessionState,
  );
  assert.deepEqual(liveProjected.history.map((item) => item.id), [5, 6, 7, 8, 9, 10]);

  // While task 101 is still running (in-flight), live projection MUST NOT suppress entries 1..4 yet.
  const inflightProjected = projectLiveState(
    { entries: [silentTrigger, silentToolCall, silentToolResult], docs: { 'pi.live': { run: { taskId: 101 }, tools: [], nestedTools: [] }, 'pi.inbox': { items: [] } } },
    sessionState,
  );
  assert.deepEqual(inflightProjected.history.map((item) => item.id), [1, 2, 3]);

  // chatTurnModel parseHistoryEntries on raw durable history suppresses silent (pass) AND empty proactive turns,
  // while keeping positive alerts, errors, human "(pass)" turns, and in-flight proactive turns.
  const emptyTrigger = {
    id: 11,
    kind: USER_MESSAGE_KIND,
    data: {
      requestId: 'req-empty',
      attribution: { kind: 'host', channel: 'primary', sourceType: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, messageId: 'req-empty', name: 'Google 主动助手' },
    },
    model: [{ role: 'user', content: [{ type: 'text', text: 'Batch 4' }] }],
  };
  const emptyAnswer = {
    id: 12,
    kind: 'pi.assistant',
    data: { attribution: { kind: 'bot', channel: 'primary', replyTo: 'req-empty' } },
    model: [{ role: 'assistant', content: [] }],
  };

  const parsedSettled = parseHistoryEntries([...settledEntries, emptyTrigger, emptyAnswer], 0, { isBusy: false });
  assert.deepEqual(
    parsedSettled.map((turn) => ({ role: turn.role, text: turn.text, error: turn.error ?? null })),
    [
      { role: 'user', text: 'Batch 2', error: null },
      { role: 'assistant', text: 'You have a meeting with Alice in 15 minutes.', error: null },
      { role: 'user', text: 'Batch 3', error: null },
      { role: 'assistant', text: '', error: 'provider timeout' },
      { role: 'user', text: 'Say (pass)', error: null },
      { role: 'assistant', text: '(pass)', error: null },
    ],
  );

  // In-flight proactive turn (isBusy=true) with tool call and no text yet MUST remain visible.
  const parsedBusy = parseHistoryEntries([silentTrigger, silentToolCall], 0, { isBusy: true });
  assert.equal(parsedBusy.length, 2);
  assert.equal(parsedBusy[0].text, 'Batch 1');
  assert.equal(parsedBusy[1].role, 'assistant');

  // Sanity check ResetEntry import doesn't drift.
  assert.equal(typeof ResetEntry.kind, 'string');
});
