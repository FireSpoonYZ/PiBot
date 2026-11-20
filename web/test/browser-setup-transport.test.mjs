import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BROWSER_CONTROL_ACTIONS,
  BROWSER_ERROR_CODES,
  BROWSER_SETUP_ERROR_CODES,
  GOOGLE_SETUP_ACTIONS,
  GOOGLE_SETUP_ERROR_CODES,
  normalizeBrowserControl,
  normalizeGoogleSetupControl,
  safeBrowserControlError,
  safeGoogleSetupError,
} from '../../host-core/browser-setup-protocol.js';
import {
  CONTROL_ERROR_CODES,
  CONTROL_MEMORY_BROKER_DEADLINE_MS,
  CONTROL_MEMORY_CLIENT_DEADLINE_MS,
  CONTROL_MEMORY_DEADLINE_MS,
  CONTROL_METHODS,
  controlBrokerTimeoutMs,
  controlClientTimeoutMs,
  controlMethodTimeoutMs,
  controlMethodVersion,
  normalizeControlCall,
} from '../../host-core/remote-control-protocol.js';
import { INTENT_METHODS } from '../../host-core/desktop-client.js';
import { normalizeDesktopUiState } from '../../host-core/desktop-ui-store.js';
import { BRIDGE_CLIENT_OPERATIONS, BRIDGE_ERROR_CODES } from '../../host-core/android-bridge-protocol.js';
import { openControlServer } from '../../host-core/control-server.js';
import { createControlClient } from '../../host-core/control-client.js';
import { createLocalControlAdapter } from '../../host-core/local-control-adapter.js';
import { openRuntimeBrowserSetup } from '../../host-core/runtime-browser-setup.js';
import { openHost } from '../../host-core/host.js';
import { PrimaryIndex } from '../../host-core/runtime-docs.js';
import { WorkContextState } from '../../host-core/work-context-docs.js';

test('browserControl and googleSetupControl normalizers enforce strict schemas and reject authority/secret spoofing', () => {
  for (const action of BROWSER_CONTROL_ACTIONS) {
    const base = { action, botId: 'bot-1' };
    if (action === 'navigate') base.url = 'https://console.cloud.google.com/';
    if (action === 'input') base.event = { kind: 'click', x: 0.5, y: 0.25 };
    const normalized = normalizeBrowserControl(base);
    assert.equal(normalized.action, action);
    assert.equal(normalized.botId, 'bot-1');
  }

  for (const action of GOOGLE_SETUP_ACTIONS) {
    const normalized = normalizeGoogleSetupControl({ action, botId: 'bot-1' });
    assert.equal(normalized.action, action);
    assert.equal(normalized.botId, 'bot-1');
  }

  // Reject authority/actor/eval/cookie/CDP spoofing on browserControl
  for (const forbidden of [
    { action: 'status', botId: 'bot-1', authority: { kind: 'owner' } },
    { action: 'status', botId: 'bot-1', actor: { botId: 'bot-2' } },
    { action: 'open', botId: 'bot-1', eval: 'alert(1)' },
    { action: 'open', botId: 'bot-1', cookies: [] },
    { action: 'input', botId: 'bot-1', event: { kind: 'click', x: 1.5, y: 0.2 } },
    { action: 'input', botId: 'bot-1', event: { kind: 'wheel', deltaX: 0, deltaY: 0 } },
    { action: 'navigate', botId: 'bot-1' },
  ]) {
    assert.throws(() => normalizeBrowserControl(forbidden), (err) => err?.code === 'INVALID_ARGUMENT');
  }

  // Reject secrets and authority spoofing on googleSetupControl (including nested payloads)
  for (const forbidden of [
    { action: 'start', botId: 'bot-1', authority: { role: 'owner' } },
    { action: 'answer', botId: 'bot-1', clientSecret: 'GOCSPX-secret' },
    { action: 'answer', botId: 'bot-1', answer: { client_secret: 'GOCSPX-secret' } },
    { action: 'advance', botId: 'bot-1', input: { refreshToken: '1//secret' } },
    { action: 'answer', botId: 'bot-1', value: { nested: { clientFile: '{}' } } },
  ]) {
    assert.throws(() => normalizeGoogleSetupControl(forbidden), (err) => err?.code === 'INVALID_ARGUMENT');
  }

  // Error sanitization never echoes sensitive values
  const secretErr = Object.assign(new Error('raw leak: super-secret-password'), { code: 'BROWSER_INPUT_FAILED' });
  const sanitizedBrowser = safeBrowserControlError(secretErr);
  assert.equal(sanitizedBrowser.code, 'BROWSER_INPUT_FAILED');
  assert.doesNotMatch(sanitizedBrowser.message, /super-secret-password/);

  const unknownSetupErr = Object.assign(new Error('raw leak: GOCSPX-12345'), { code: 'UNKNOWN_INTERNAL' });
  const sanitizedSetup = safeGoogleSetupError(unknownSetupErr);
  assert.equal(sanitizedSetup.code, 'GOOGLE_SETUP_UNAVAILABLE');
  assert.doesNotMatch(sanitizedSetup.message, /GOCSPX-12345/);
});

test('volatile RPC registration, slow timeout budgets, error codes, and outbox exclusion across protocol and bridge allowlists', () => {
  assert.equal(CONTROL_METHODS.includes('browserControl'), true);
  assert.equal(CONTROL_METHODS.includes('googleSetupControl'), true);
  assert.equal(controlMethodVersion('browserControl'), 2);
  assert.equal(controlMethodVersion('googleSetupControl'), 2);

  // Slow timeout chain covers browserControl & googleSetupControl
  for (const method of ['browserControl', 'googleSetupControl']) {
    assert.equal(controlMethodTimeoutMs(method), CONTROL_MEMORY_DEADLINE_MS);
    assert.equal(controlClientTimeoutMs(method), CONTROL_MEMORY_CLIENT_DEADLINE_MS);
    assert.equal(controlBrokerTimeoutMs(method), CONTROL_MEMORY_BROKER_DEADLINE_MS);
  }

  // Wire & Android bridge error codes include all browser/setup domain codes
  for (const code of BROWSER_SETUP_ERROR_CODES) {
    assert.equal(CONTROL_ERROR_CODES.has(code), true, `CONTROL_ERROR_CODES missing ${code}`);
    assert.equal(BRIDGE_ERROR_CODES.has(code), true, `BRIDGE_ERROR_CODES missing ${code}`);
  }
  assert.equal(BROWSER_ERROR_CODES.includes('BROWSER_PAUSED_FOR_HUMAN'), true);
  assert.equal(GOOGLE_SETUP_ERROR_CODES.includes('GOOGLE_SETUP_SENSITIVE_BLOCKED'), true);

  // normalizeControlCall accepts valid browserControl & googleSetupControl calls
  const browserCall = normalizeControlCall('browserControl', {
    action: 'input',
    botId: 'bot-1',
    pageId: 'page-1',
    lease: 'lease-token-1',
    revision: 3,
    event: { kind: 'text', text: 'hello' },
  });
  assert.equal(browserCall.method, 'browserControl');
  assert.equal(browserCall.params.event.kind, 'text');

  const setupCall = normalizeControlCall('googleSetupControl', {
    action: 'start',
    botId: 'bot-1',
    mode: 'guide-me-here',
    choices: ['gmail', 'calendar'],
  });
  assert.equal(setupCall.method, 'googleSetupControl');
  assert.deepEqual(setupCall.params.choices, ['gmail', 'calendar']);

  // Volatile RPCs must NEVER enter persistent desktop intent/outbox stores
  assert.equal(INTENT_METHODS.has('browserControl'), false);
  assert.equal(INTENT_METHODS.has('googleSetupControl'), false);
  assert.throws(
    () =>
      normalizeDesktopUiState({
        version: 1,
        profiles: [],
        drafts: [],
        intents: [
          {
            id: 'intent-1',
            profileId: 'prof-1',
            targetDeviceId: 'dev-1',
            method: 'browserControl',
            params: { action: 'status', botId: 'bot-1' },
            outcome: 'unconfirmed',
          },
        ],
      }),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  // Android & Desktop broker allowlists expose call + center_admin_request + slow timeouts
  assert.equal(BRIDGE_CLIENT_OPERATIONS.has('call'), true);
  assert.equal(BRIDGE_CLIENT_OPERATIONS.has('center_admin_request'), true);
  const bridgeRs = fs.readFileSync(new URL('../../desktop/src-tauri/src/bridge.rs', import.meta.url), 'utf8');
  assert.match(bridgeRs, /"call"/);
  assert.match(bridgeRs, /"center_admin_request"/);
  assert.match(bridgeRs, /"browserControl"/);
  assert.match(bridgeRs, /"googleSetupControl"/);
});

test('runtime-browser-setup binds per-bot agent tools with persisted conversation verification and refuses owner-control tool names', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-browser-setup-tools-'));
  const host = openHost({ dataRoot: join(rootDir, 'host') });
  const installed = [];
  const registry = { install: (ext) => installed.push(ext) };
  const botA = host.createBot({ requestId: 'req-bot-a', role: 'Bot A', cwd: rootDir });
  const botB = host.createBot({ requestId: 'req-bot-b', role: 'Bot B', cwd: rootDir });

  let currentConvOwner = botA.botId;
  const recordedExecutions = [];
  let browserClosed = false;
  let setupClosed = false;

  const coord = await openRuntimeBrowserSetup({
    host,
    registry,
    getHarness: () => ({
      snapshot: async (doc) => {
        if (doc === WorkContextState) return null;
        if (doc === PrimaryIndex) {
          return {
            byPrimary: {
              [botA.primaryConversationId]: 1,
              [botB.primaryConversationId]: 2,
            },
          };
        }
        return null;
      },
    }),
    getWorkContexts: () => null,
    resolveConversationBot: async () => currentConvOwner,
    nativeBridge: null,
    isOnline: () => true,
    isMaintenance: () => false,
    getCenterUrl: () => 'https://center.example.test',
    abortBotTurn: async () => {},
    context: {},
    createBotBrowserService: () => ({
      async control(input, authority) {
        return { ok: true, input, authority };
      },
      toolsForBot(ctx) {
        return [
          {
            name: 'browser_snapshot',
            description: 'Read current page snapshot',
            inputSchema: { type: 'object', properties: {} },
            async run(args, agentCtx) {
              recordedExecutions.push({ boundBotId: ctx.botId, agentCtx });
              return { ok: true, botId: agentCtx.botId };
            },
          },
        ];
      },
      async close() {
        browserClosed = true;
      },
    }),
    createGoogleSetupService: () => ({
      async control(input, authority) {
        return { id: 'setup-1', revision: 1, state: 'idle', steps: [], authority };
      },
      toolsForBot() {
        return [];
      },
      async close() {
        setupClosed = true;
      },
    }),
  });

  try {
    const extsA = coord.extensionsForBot(botA.botId);
    assert.equal(extsA.length, 1);
    assert.equal(extsA[0].name, `host.bot-browser:${botA.botId}`);
    assert.equal(installed.includes(extsA[0]), true);

    // Owner control always injects trusted owner authority for verified local bot
    const controlRes = await coord.browserControl({ action: 'status', botId: botA.botId });
    assert.equal(controlRes.authority.kind, 'owner');
    assert.equal(controlRes.authority.trusted, true);
    assert.equal(controlRes.authority.deviceId, host.deviceId);
    assert.equal(controlRes.authority.botId, botA.botId);

    // Unknown bot is rejected with BOT_NOT_FOUND
    await assert.rejects(
      () => coord.browserControl({ action: 'status', botId: 'non-existent-bot' }),
      (err) => err?.code === 'BOT_NOT_FOUND',
    );

    const toolA = extsA[0].tools[0];
    // Verified matching conversation owner executes with non-owner agent authority
    currentConvOwner = botA.botId;
    const okResult = await toolA.execute({}, { conversationId: 1, taskId: 't-0', callId: 'c-0' }, {});
    assert.equal(okResult.isError, undefined);
    assert.equal(recordedExecutions.length, 1);
    assert.equal(recordedExecutions[0].agentCtx.kind, 'bot');
    assert.equal(recordedExecutions[0].agentCtx.trusted, false);
    assert.equal(recordedExecutions[0].agentCtx.botId, botA.botId);

    // Executing botA's tool with mismatched conversation owner rejects BOT_CONTEXT_REQUIRED
    currentConvOwner = botB.botId;
    await assert.rejects(
      () => toolA.execute({}, { conversationId: 1, taskId: 't-1', callId: 'c-1' }, {}),
      (err) => err?.code === 'BOT_CONTEXT_REQUIRED',
    );
    assert.equal(recordedExecutions.length, 1);
  } finally {
    await coord.close();
    assert.equal(browserClosed, true);
    assert.equal(setupClosed, true);
    host.close();
    rmSync(rootDir, { recursive: true, force: true });
  }

  // Registering an owner-control tool name as an agent tool must be rejected
  const rootDir2 = mkdtempSync(join(tmpdir(), 'pibot-browser-setup-forbid-'));
  const host2 = openHost({ dataRoot: join(rootDir2, 'host') });
  const registry2 = { install: () => {} };
  const bot2 = host2.createBot({ requestId: 'req-bot-2', role: 'Bot 2', cwd: rootDir2 });
  const coord2 = await openRuntimeBrowserSetup({
    host: host2,
    registry: registry2,
    getHarness: () => null,
    getWorkContexts: () => null,
    resolveConversationBot: async () => bot2.botId,
    nativeBridge: null,
    isOnline: () => true,
    isMaintenance: () => false,
    context: {},
    createBotBrowserService: () => ({
      async control() { return {}; },
      toolsForBot() {
        return [{ name: 'browserControl', description: 'forbidden', run: async () => ({}) }];
      },
      async close() {},
    }),
    createGoogleSetupService: () => ({
      async control() { return {}; },
      toolsForBot() { return []; },
      async close() {},
    }),
  });
  try {
    assert.throws(
      () => coord2.extensionsForBot(bot2.botId),
      (err) => err?.code === 'FORBIDDEN',
    );
  } finally {
    await coord2.close();
    host2.close();
    rmSync(rootDir2, { recursive: true, force: true });
  }
});

test('openControlServer + control-client + local-control-adapter route browserControl and googleSetupControl end-to-end and close services cleanly', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-browser-setup-http-'));
  const token = 'test_control_token_0123456789abcdef0123456789';
  const browserCalls = [];
  const setupCalls = [];
  let browserClosed = false;
  let setupClosed = false;

  const centerRuntime = {
    snapshot: { protocol: 1 },
    centerUrl: 'https://center.example.test',
    installer: {},
    getClient: () => ({
      providerAuth: async () => ({ auth: { apiKey: 'mock' }, source: 'center' }),
    }),
  };

  let server = null;
  try {
    server = await openControlServer({
      port: 0,
      token,
      deferResume: true,
      dataRoot: join(rootDir, 'host-data'),
      centerRuntime,
      createBotBrowserService: (opts) => {
        assert.equal(typeof opts.deviceId, 'string');
        assert.equal(typeof opts.isLocalBot, 'function');
        return {
          async control(input, authority) {
            browserCalls.push({ input, authority });
            return {
              available: true,
              canStreamInteract: true,
              phase: input.action === 'takeover' ? 'human' : 'bot',
              revision: 1,
              tabs: [],
            };
          },
          toolsForBot() { return []; },
          async close() { browserClosed = true; },
        };
      },
      createGoogleSetupService: (opts) => {
        assert.equal(opts.getCenterUrl(), 'https://center.example.test');
        return {
          async control(input, authority) {
            setupCalls.push({ input, authority });
            return {
              id: 'setup-1',
              revision: 2,
              state: input.action === 'start' ? 'running' : 'idle',
              steps: [],
            };
          },
          toolsForBot() { return []; },
          async close() { setupClosed = true; },
        };
      },
    });

    await server.applyCenterSnapshot({
      protocol: 1,
      deviceId: server.deviceId,
      revision: 1,
      providers: [],
      models: {},
      bots: [],
    });
    await server.setCenterOnline(true);
    await server.restoreTurns();
    server.resume();

    const client = createControlClient({ url: server.url, token });
    const adapter = createLocalControlAdapter({ url: server.url, token });
    const createdBot = await client.createBot({
      requestId: 'req-browser-setup-http-bot',
      role: 'BrowserSetupTestBot',
      cwd: rootDir,
      makePrimary: true,
    });
    const botId = createdBot.botId;

    const browserStatus = await client.browserControl({ action: 'status', botId });
    assert.equal(browserStatus.available, true);
    assert.equal(browserStatus.phase, 'bot');

    const takeover = await adapter(server.deviceId, 'browserControl', {
      action: 'takeover',
      botId,
      holderLabel: 'MacBook-Pro',
    });
    assert.equal(takeover.phase, 'human');
    assert.equal(browserCalls.at(-1).authority.kind, 'owner');
    assert.equal(browserCalls.at(-1).authority.trusted, true);
    assert.equal(browserCalls.at(-1).authority.deviceId, server.deviceId);
    assert.equal(browserCalls.at(-1).authority.botId, botId);

    const setupStarted = await adapter(server.deviceId, 'googleSetupControl', {
      action: 'start',
      botId,
      mode: 'guide-me-here',
      choices: ['gmail', 'calendar'],
    });
    assert.equal(setupStarted.state, 'running');
    assert.equal(setupCalls.at(-1).authority.kind, 'owner');
    assert.equal(setupCalls.at(-1).authority.botId, botId);

    // Unknown bot rejected across HTTP + local-control-adapter
    await assert.rejects(
      () => adapter(server.deviceId, 'browserControl', { action: 'status', botId: 'unknown-bot-id' }),
      (err) => err?.code === 'BOT_NOT_FOUND' && err?.outcome === 'responded',
    );
  } finally {
    if (server) await server.close();
    assert.equal(browserClosed, true);
    assert.equal(setupClosed, true);
    rmSync(rootDir, { recursive: true, force: true });
  }
});
