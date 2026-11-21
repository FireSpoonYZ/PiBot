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
  SETUP_ERROR_CODES,
  normalizeBrowserControl,
  normalizeGoogleSetupControl,
  projectGoogleSetupControlForService,
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
import { createHostControlReceiver } from '../../host-core/host-control.js';
import { openRuntimeBrowserSetup } from '../../host-core/runtime-browser-setup.js';
import { createBotManagementSkillSection } from '../../host-core/bot-management-skill.js';
import { openHost } from '../../host-core/host.js';
import { PrimaryIndex } from '../../host-core/runtime-docs.js';
import { WorkContextState } from '../../host-core/work-context-docs.js';
import { projectToolPresentation, normalizeToolPresentation } from '../../host-core/tool-presentation.js';

test('builtin skill catalog includes Google account connection without inlining its workflow', () => {
  const section = createBotManagementSkillSection();
  const catalog = section.render();
  assert.equal(section.key, 'bot-management-skill');
  assert.match(catalog, /<name>bot-management<\/name>/);
  assert.match(catalog, /<name>google-account-connection<\/name>/);
  assert.match(catalog, /连接谷歌账号/);
  assert.match(catalog, /GOOGLE_ACCOUNT_NOT_CONNECTED/);
  assert.match(catalog, /google-account-connection[\\/]SKILL\.md/);
  assert.ok(!catalog.includes('# Google account connection'));
});
/**
 * Minimal deterministic in-memory browser provider for headless runtime tests
 * (exercises the real createBotBrowserService state machine without spawning
 * an OS browser binary).
 */
function createFakeInteractiveProvider(tracker, { shouldFailStatus = () => false } = {}) {
  let tabs = [];
  let activePageId = null;
  let seq = 0;
  let docGen = 1;
  let closed = false;
  tracker.created += 1;

  return {
    async perform(input) {
      if (closed) throw new Error('provider closed');
      tracker.calls.push(input.action);
      if (shouldFailStatus() && input.action === 'status') {
        throw new Error('simulated provider status failure');
      }
      if (input.action === 'status') {
        return {
          available: true,
          canStreamInteract: true,
          sessionId: 'sess-fake-1',
          pageId: activePageId,
          documentGeneration: docGen,
          tabs,
        };
      }
      if (input.action === 'open') {
        seq += 1;
        const pageId = `page-${seq}`;
        const url = input.url || 'https://example.com/';
        tabs = [...tabs, { id: pageId, title: 'Example', url }];
        activePageId = pageId;
        docGen += 1;
        return {
          available: true,
          canStreamInteract: true,
          sessionId: 'sess-fake-1',
          pageId,
          url,
          title: 'Example',
          documentGeneration: docGen,
          tabs,
        };
      }
      if (input.action === 'navigate') {
        const pageId = input.pageId || activePageId || 'page-1';
        const url = input.url || 'https://example.com/';
        tabs = tabs.some((t) => t.id === pageId)
          ? tabs.map((t) => (t.id === pageId ? { ...t, url } : t))
          : [...tabs, { id: pageId, title: 'Nav', url }];
        activePageId = pageId;
        docGen += 1;
        return {
          available: true,
          canStreamInteract: true,
          sessionId: 'sess-fake-1',
          pageId,
          url,
          title: 'Nav',
          documentGeneration: docGen,
          tabs,
        };
      }
      if (input.action === 'closeTab') {
        tabs = tabs.filter((tab) => tab.id !== input.pageId);
        if (activePageId === input.pageId) activePageId = tabs.at(-1)?.id ?? null;
        docGen += 1;
      }
      if (input.action === 'input') {
        return { ok: true, pageId: input.pageId || activePageId };
      }
      if (input.action === 'frame') {
        return {
          pageId: activePageId,
          documentGeneration: docGen,
          mimeType: 'image/jpeg',
          data: '/9j/2Q==',
          width: 1280,
          height: 800,
        };
      }
      if (input.action === 'snapshot') {
        return {
          pageId: activePageId,
          url: tabs.find((t) => t.id === activePageId)?.url ?? 'https://example.com/',
          title: 'Example',
          documentGeneration: docGen,
          snapshot: { text: 'Example heading', refs: {} },
        };
      }
      return {
        available: true,
        canStreamInteract: true,
        sessionId: 'sess-fake-1',
        pageId: activePageId,
        documentGeneration: docGen,
        tabs,
      };
    },
    async close() {
      if (!closed) {
        closed = true;
        tracker.closed += 1;
      }
    },
  };
}

test('browserControl and googleSetupControl normalizers align with real services/UI and reject spoofing or secrets', () => {
  for (const action of BROWSER_CONTROL_ACTIONS) {
    const base = { action, botId: 'bot-1' };
    if (action === 'navigate') base.url = 'https://console.cloud.google.com/';
    if (['input', 'select', 'closeTab'].includes(action)) base.pageId = 'page-1';
    if (action === 'input') Object.assign(base, { lease: 'fixture-lease', revision: 2, event: { kind: 'click', x: 0.5, y: 0.25 } });
    if (action === 'reload') base.ignoreCache = true;
    if (action === 'frame') {
      base.format = 'jpeg';
      base.quality = 80;
      base.revision = 2;
    }
    if (action === 'takeover') {
      base.resume = true;
      base.revision = 2;
    }
    if (action === 'open' || action === 'release') {
      base.pageId = 'page-1';
      base.revision = 2;
    }
    const normalized = normalizeBrowserControl(base);
    assert.equal(normalized.action, action);
    assert.equal(normalized.botId, 'bot-1');
    assert.deepEqual(normalizeBrowserControl(normalized), normalized);
    if (action === 'frame') assert.equal(normalized.quality, 80);
  }

  assert.deepEqual(normalizeBrowserControl({ action: 'takeover', botId: 'bot-1', shared: true }), {
    action: 'takeover', botId: 'bot-1', shared: true,
  });
  assert.throws(() => normalizeBrowserControl({ action: 'takeover', botId: 'bot-1', shared: 'true' }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => normalizeBrowserControl({ action: 'status', botId: 'bot-1', shared: true }), { code: 'INVALID_ARGUMENT' });

  for (const action of GOOGLE_SETUP_ACTIONS) {
    const normalized = normalizeGoogleSetupControl({ action, botId: 'bot-1' });
    assert.equal(normalized.action, action);
    assert.equal(normalized.botId, 'bot-1');
  }

  // UI shorthand answer & revision map cleanly into native google-setup/service.js shape
  const uiAnswer = normalizeGoogleSetupControl({
    action: 'answer',
    botId: 'bot-1',
    field: 'mode',
    value: 'guide-here',
    revision: 3,
  });
  const projectedUiAnswer = projectGoogleSetupControlForService(uiAnswer);
  assert.equal(projectedUiAnswer.card, 'path');
  assert.deepEqual(projectedUiAnswer.values, ['guide-here']);
  assert.equal(projectedUiAnswer.expectedRevision, 3);

  const uiStepAction = normalizeGoogleSetupControl({
    action: 'answer',
    botId: 'bot-1',
    actionId: 'done',
    step: 'project',
    revision: 4,
  });
  const projectedStepAction = projectGoogleSetupControlForService(uiStepAction);
  assert.equal(projectedStepAction.card, 'step');
  assert.deepEqual(projectedStepAction.values, ['done', 'project']);
  assert.equal(projectedStepAction.expectedRevision, 4);

  // Reject clientId/authority/actor/eval/cookie/CDP spoofing on browserControl
  for (const forbidden of [
    { action: 'status', botId: 'bot-1', clientId: 'local:victim' },
    { action: 'status', botId: 'bot-1', authority: { role: 'owner' } },
    { action: 'status', botId: 'bot-1', actor: 'owner' },
    { action: 'open', botId: 'bot-1', eval: 'alert(1)' },
    { action: 'open', botId: 'bot-1', cookies: [] },
    { action: 'input', botId: 'bot-1', event: { kind: 'click', x: 1.5, y: 0.2 } },
    { action: 'input', botId: 'bot-1', event: { kind: 'wheel', deltaX: 0, deltaY: 0 } },
    { action: 'navigate', botId: 'bot-1' },
  ]) {
    assert.throws(() => normalizeBrowserControl(forbidden), (err) => err?.code === 'INVALID_ARGUMENT');
  }

  // Reject secrets, OAuth callbacks, and authority spoofing on googleSetupControl
  for (const forbidden of [
    { action: 'start', botId: 'bot-1', authority: { actor: 'owner' } },
    { action: 'start', botId: 'bot-1', clientId: 'spoofed-client' },
    { action: 'answer', botId: 'bot-1', clientSecret: 'GOCSPX-secret123456' },
    { action: 'answer', botId: 'bot-1', card: 'step', values: ['GOCSPX-secret123456'] },
    { action: 'advance', botId: 'bot-1', note: 'https://center.test/api/oauth/google/callback?code=4/abc&state=xyz' },
  ]) {
    assert.throws(
      () => normalizeGoogleSetupControl(forbidden),
      (err) => err?.code === 'INVALID_ARGUMENT' || err?.code === 'SETUP_SECRET_REJECTED',
    );
  }

  // Error sanitization preserves real codes and never echoes secret text
  const browserErr = Object.assign(new Error('leak: my-secret-keystroke'), { code: 'BROWSER_LEASE_CONFLICT' });
  const safeBrowser = safeBrowserControlError(browserErr);
  assert.equal(safeBrowser.code, 'BROWSER_LEASE_CONFLICT');
  assert.doesNotMatch(safeBrowser.message, /my-secret-keystroke/);

  const setupErr = Object.assign(new Error('leak: GOCSPX-99999999'), { code: 'SETUP_SECRET_REJECTED' });
  const safeSetup = safeGoogleSetupError(setupErr);
  assert.equal(safeSetup.code, 'SETUP_SECRET_REJECTED');
  assert.doesNotMatch(safeSetup.message, /GOCSPX-99999999/);
});

test('volatile RPC registration, slow timeout budgets, real error codes, and outbox exclusion across protocol and bridges', () => {
  assert.equal(CONTROL_METHODS.includes('browserControl'), true);
  assert.equal(CONTROL_METHODS.includes('googleSetupControl'), true);
  assert.equal(controlMethodVersion('browserControl'), 2);
  assert.equal(controlMethodVersion('googleSetupControl'), 2);

  for (const method of ['browserControl', 'googleSetupControl']) {
    assert.equal(controlMethodTimeoutMs(method), CONTROL_MEMORY_DEADLINE_MS);
    assert.equal(controlClientTimeoutMs(method), CONTROL_MEMORY_CLIENT_DEADLINE_MS);
    assert.equal(controlBrokerTimeoutMs(method), CONTROL_MEMORY_BROKER_DEADLINE_MS);
  }

  for (const code of BROWSER_SETUP_ERROR_CODES) {
    assert.equal(CONTROL_ERROR_CODES.has(code), true, `CONTROL_ERROR_CODES missing ${code}`);
    assert.equal(BRIDGE_ERROR_CODES.has(code), true, `BRIDGE_ERROR_CODES missing ${code}`);
  }
  assert.equal(BROWSER_ERROR_CODES.includes('BROWSER_PAUSED_FOR_HUMAN'), true);
  assert.equal(BROWSER_ERROR_CODES.includes('BROWSER_LEASE_CONFLICT'), true);
  assert.equal(SETUP_ERROR_CODES.includes('SETUP_SENSITIVE_LOCKED'), true);
  assert.equal(SETUP_ERROR_CODES.includes('SETUP_SECRET_REJECTED'), true);

  const browserCall = normalizeControlCall('browserControl', {
    action: 'input',
    botId: 'bot-1',
    pageId: 'page-1',
    lease: 'lease-token-1234',
    revision: 3,
    frameSeq: 2,
    event: { kind: 'text', text: 'hello' },
  });
  assert.equal(browserCall.method, 'browserControl');
  assert.equal(browserCall.params.event.kind, 'text');

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

  assert.equal(BRIDGE_CLIENT_OPERATIONS.has('call'), true);
  assert.equal(BRIDGE_CLIENT_OPERATIONS.has('center_admin_request'), true);
  const bridgeRs = fs.readFileSync(new URL('../../desktop/src-tauri/src/bridge.rs', import.meta.url), 'utf8');
  assert.match(bridgeRs, /"call"/);
  assert.match(bridgeRs, /"center_admin_request"/);
  assert.match(bridgeRs, /"browserControl"/);
  assert.match(bridgeRs, /"googleSetupControl"/);
});

test('runtime assembly observes Google project navigation privately and enforces tool identity and sensitive locks', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-real-browser-setup-'));
  const host = openHost({ dataRoot: join(rootDir, 'host') });
  const installed = [];
  const registry = { install: (ext) => installed.push(ext) };
  const botA = host.createBot({ requestId: 'req-real-a', role: 'Bot A', cwd: rootDir });
  const botB = host.createBot({ requestId: 'req-real-b', role: 'Bot B', cwd: rootDir });

  const providerTracker = { created: 0, closed: 0, calls: [] };
  let failProviderStatus = false;
  let currentConvOwner = botA.botId;
  let centerStatusCalls = 0;
  const setupContinuations = [];
  const browserEvents = [];

  let coord = null;
  let coordClosed = false;
  try {
    coord = await openRuntimeBrowserSetup({
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
      getCenterGoogleStatus: async () => {
        centerStatusCalls += 1;
        return {
          client: { configured: false, redirectUri: 'https://center.example.test/api/oauth/google/callback' },
          accounts: [],
        };
      },
      abortBotTurn: async () => {},
      context: {},
      onBrowserEvent: (event) => browserEvents.push(event),
      createBrowserProvider: () => createFakeInteractiveProvider(providerTracker, { shouldFailStatus: () => failProviderStatus }),
    });

    const extsA = coord.extensionsForBot(botA.botId);
    const browserExt = extsA.find((ext) => ext.name === `host.bot-browser:${botA.botId}`);
    const setupExt = extsA.find((ext) => ext.name === `host.google-setup:${botA.botId}`);
    assert.ok(browserExt, 'bot-browser extension must be registered for botA');
    assert.ok(setupExt, 'google-setup extension must be registered for botA');

    // 1. Initial status + start + UI-shorthand answer on real googleSetupService
    const idleStatus = await coord.googleSetupControl(
      { action: 'status', botId: botA.botId },
      { clientId: 'local:desktop-1', transport: 'local' },
    );
    assert.equal(idleStatus.state, 'idle');
    assert.ok(centerStatusCalls >= 1);

    const started = await coord.googleSetupControl(
      { action: 'start', botId: botA.botId, mode: 'do-it-for-me', choices: ['gmail', 'calendar'] },
      { clientId: 'local:desktop-1', transport: 'local' },
    );
    assert.equal(started.state, 'running');
    assert.equal(started.mode, 'do-it-for-me');
    assert.equal(started.applied, true);
    const setupPageId = started.browserPageId;
    assert.ok(setupPageId);
    const ownerBrowser = (input) => coord.browserControl(
      { botId: botA.botId, ...input },
      { clientId: 'local:desktop-1', transport: 'local' },
    );

    const signIn = await ownerBrowser({
      action: 'navigate', pageId: setupPageId,
      url: 'https://accounts.google.com/v3/signin/identifier?service=cloudconsole',
    });
    assert.equal(signIn.sensitive, true);
    const signingIn = await coord.googleSetupControl(
      { action: 'status', botId: botA.botId },
      { clientId: 'local:desktop-1', transport: 'local' },
    );
    assert.equal(signingIn.browserLock, undefined, 'ordinary Google web sign-in stays in the embedded browser');
    await ownerBrowser({
      action: 'navigate', pageId: setupPageId, url: 'https://console.cloud.google.com/',
    });

    // 2. Real google_setup tool publishes whitelisted ToolPresentation & enforces conversation ownership
    const setupTool = setupExt.tools.find((t) => t.name === 'google_setup');
    const browserTool = browserExt.tools.find((t) => t.name === 'bot_browser');
    assert.ok(setupTool);
    assert.ok(browserTool);

    const publishedDetails = [];
    const fakeApi = {
      conversationId: 1,
      taskId: 'task-1',
      callId: 'call-1',
      async details(payload) {
        publishedDetails.push(payload);
      },
    };
    const showRes = await setupTool.execute({ action: 'show' }, fakeApi, {});
    assert.equal(showRes.isError, undefined);
    assert.equal(publishedDetails.length, 1);
    const projectedPresentation = projectToolPresentation(publishedDetails[0]);
    assert.ok(projectedPresentation, 'google-setup tool presentation must pass host-core/tool-presentation whitelist');
    assert.equal(projectedPresentation.kind, 'google-setup');
    assert.equal(projectedPresentation.installationId, 'host.google-setup');
    const wireNormalized = normalizeToolPresentation(projectedPresentation);
    assert.equal(wireNormalized.kind, 'google-setup');

    // Mismatched conversation ownership rejects BOT_CONTEXT_REQUIRED
    currentConvOwner = botB.botId;
    await assert.rejects(
      () => setupTool.execute({ action: 'show' }, fakeApi, {}),
      (err) => err?.code === 'BOT_CONTEXT_REQUIRED',
    );
    currentConvOwner = botA.botId;

    const opened = await browserTool.execute({ action: 'open', url: 'https://example.com/' }, fakeApi, {});
    assert.notEqual(opened.isError, true);
    const { pageId } = JSON.parse(opened.output[0].text);
    const shared = await coord.browserControl(
      { action: 'takeover', botId: botA.botId, pageId, shared: true },
      { clientId: 'local:desktop-1', transport: 'local' },
    );
    assert.equal(shared.sharedInput, true);
    const status = await browserTool.execute({ action: 'status' }, fakeApi, {});
    assert.equal(JSON.parse(status.output[0].text).pausedForHuman, false);
    assert.equal(publishedDetails.length, 1, 'shared input must not open a takeover card');

    const setupControl = (input) => coord.googleSetupControl(
      { botId: botA.botId, ...input },
      { clientId: 'local:desktop-1', transport: 'local' },
      async (request) => {
        setupContinuations.push(request);
        return true;
      },
    );
    const project = await setupControl({ action: 'advance', step: 'account', account: 'owner@example.com' });
    const projectId = 'test-cloud-project';
    const createUrl = `https://console.cloud.google.com/projectcreate?project=${projectId}`;
    const confirm = {
      action: 'advance', step: 'project', runId: started.id, expectedRevision: project.revision,
    };
    const navigate = (pageId, url) => ownerBrowser({ action: 'navigate', pageId, url, lease: shared.lease });
    await navigate(setupPageId, createUrl);
    await assert.rejects(() => setupControl(confirm), { code: 'SETUP_PROJECT_ID_REQUIRED' });

    await navigate(pageId, 'https://console.cloud.google.com/welcome?project=wrong-cloud-project');
    assert.equal((await setupControl({ action: 'status' })).projectId, undefined);
    await ownerBrowser({ action: 'closeTab', pageId: setupPageId, lease: shared.lease });
    await navigate(pageId, 'https://console.cloud.google.com/compute/instances?project=wrong-cloud-project');
    assert.equal((await setupControl({ action: 'status' })).projectId, undefined);

    const replacement = await ownerBrowser({ action: 'open', url: createUrl, lease: shared.lease });
    assert.equal((await setupControl({ action: 'status' })).projectId, undefined);
    await navigate(replacement.pageId, `https://console.cloud.google.com/compute/instances?project=${projectId}`);
    const detected = await setupControl({ action: 'status' });
    assert.equal(detected.projectId, projectId);
    assert.equal(detected.browserPageId, replacement.pageId);
    assert.ok(detected.revision > project.revision);
    assert.ok(browserEvents.length > 0);
    assert.ok(browserEvents.every((event) => !Object.hasOwn(event, 'url')));
    assert.equal((await setupControl(confirm)).step, 'apis');

    const branding = await setupControl({ action: 'advance', step: 'apis' });
    assert.equal(branding.card.card, 'kind');
    const answerKind = {
      action: 'answer', card: 'kind', values: ['personal'], runId: started.id,
      expectedRevision: branding.revision, cardCopy: branding.card.copy,
    };
    const chosen = await setupControl(answerKind);
    assert.equal(chosen.kind, 'personal');
    assert.equal(chosen.resumeQueued, true);
    assert.equal((await setupControl(answerKind)).applied, false);
    assert.deepEqual(setupContinuations, [{
      botId: botA.botId, runId: started.id, revision: chosen.revision,
    }]);

    // 3. Fail-closed safety gate: triggering sensitive `client` step while browser provider fails
    // MUST keep the safety lock engaged and block bot_browser tool with PAUSED_FOR_HUMAN
    failProviderStatus = true;
    const needUserRes = await setupTool.execute(
      { action: 'need_user', step: 'client', note: 'Create Web OAuth Client Secret directly' },
      fakeApi,
      {},
    );
    assert.equal(needUserRes.isError, undefined);

    const blockedBrowserRes = await browserTool.execute(
      { action: 'open', url: 'https://console.cloud.google.com/auth/clients' },
      fakeApi,
      {},
    );
    assert.equal(blockedBrowserRes.isError, true);
    const blockedBody = JSON.parse(blockedBrowserRes.output[0].text);
    assert.equal(blockedBody.status, 'PAUSED_FOR_HUMAN');
    assert.equal(blockedBody.code, 'BROWSER_SENSITIVE_BLOCKED');

    await coord.close();
    coordClosed = true;
    assert.equal(providerTracker.closed, providerTracker.created);
  } finally {
    if (coord && !coordClosed) {
      await coord.close().catch(() => {});
    }
    host.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('real openControlServer + control-client + local-control-adapter + relay host-control isolate client leases, never leak lease on status, and close cleanly without masking errors', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pibot-real-control-http-'));
  const token = 'test_control_token_0123456789abcdef0123456789';
  const providerTracker = { created: 0, closed: 0, calls: [] };
  let googleStatusPollCount = 0;

  const centerRuntime = {
    snapshot: { protocol: 1 },
    centerUrl: 'https://center.example.test',
    installer: {},
    getClient: () => ({
      providerAuth: async () => ({ auth: { apiKey: 'mock' }, source: 'center' }),
      getGoogleStatus: async () => {
        googleStatusPollCount += 1;
        return {
          client: { configured: false, redirectUri: 'https://center.example.test/api/oauth/google/callback' },
          accounts: [],
        };
      },
    }),
  };

  let server = null;
  let serverClosed = false;
  try {
    server = await openControlServer({
      port: 0,
      token,
      deferResume: true,
      dataRoot: join(rootDir, 'host-data'),
      // Skip external CUA desktop binary probe on CI while keeping real browser/setup services.
      nativeBridge: async () => ({}),
      centerRuntime,
      createBrowserProvider: () => createFakeInteractiveProvider(providerTracker),
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

    // Two distinct authenticated local control clients + one local adapter for Relay
    const desktopCaller = { clientId: 'local:desktop-a', transport: 'local' };
    const clientA = createControlClient({
      url: server.url, token, clientId: desktopCaller.clientId, controlTransport: desktopCaller.transport,
    });
    const clientB = createControlClient({ url: server.url, token });
    const relayAdapter = createLocalControlAdapter({ url: server.url, token });

    const createdBot = await clientA.createBot({
      requestId: 'req-real-http-bot',
      role: 'RealTransportBot',
      cwd: rootDir,
      makePrimary: true,
    });
    const botId = createdBot.botId;

    // 1. Real googleSetupControl over HTTP: status -> start -> UI-shorthand answer -> cancel
    const initialSetup = await clientA.googleSetupControl({ action: 'status', botId });
    assert.equal(initialSetup.state, 'idle');
    assert.ok(googleStatusPollCount >= 1);

    const startedSetup = await clientA.googleSetupControl({
      action: 'start',
      botId,
      mode: 'guide-browser',
      choices: ['gmail'],
    });
    assert.equal(startedSetup.state, 'running');
    assert.equal(startedSetup.mode, 'guide-browser');

    const cancelledSetup = await clientA.googleSetupControl({
      action: 'cancel',
      botId,
      revision: startedSetup.revision,
    });
    assert.equal(cancelledSetup.state, 'cancelled');

    // 2. Real browserControl multi-client lease isolation:
    // Client A opens a page and takes over -> receives lease token.
    const opened = await clientA.browserControl({ action: 'open', botId, url: 'https://example.com/' });
    assert.equal(opened.available, true);
    assert.ok(opened.pageId);

    const takenByA = await clientA.browserControl({
      action: 'takeover',
      botId,
      pageId: opened.pageId,
      holderLabel: 'Desktop-A',
    });
    assert.equal(takenByA.phase, 'human');
    assert.equal(takenByA.isLeaseHolder, true);
    assert.equal(typeof takenByA.lease, 'string');
    assert.ok(takenByA.lease.length >= 8);
    const target = { kind: 'browser', botId, pageId: takenByA.pageId, sessionId: takenByA.sessionId, lease: takenByA.lease };
    const localFrames = relayAdapter.live(server.deviceId, target, { caller: desktopCaller });
    try {
      const firstFrame = await localFrames.next();
      assert.equal(firstFrame.value.type, 'browser-frame');
      assert.equal(firstFrame.value.frame.pageId, takenByA.pageId);
    } finally {
      await localFrames.return();
    }
    const staleFrames = relayAdapter.live(server.deviceId, { ...target, sessionId: 'different-session' }, { caller: desktopCaller });
    await assert.rejects(() => staleFrames.next(), { code: 'BROWSER_STALE_PAGE' });

    // Client B queries status -> MUST NOT receive lease token and MUST NOT be lease holder.
    const statusByB = await clientB.browserControl({ action: 'status', botId });
    assert.equal(statusByB.phase, 'human');
    assert.equal(statusByB.isLeaseHolder, false);
    assert.equal(statusByB.lease, undefined);

    // Client B trying to send input (even with Client A's token) MUST fail with BROWSER_LEASE_CONFLICT.
    await assert.rejects(
      () =>
        clientB.browserControl({
          action: 'input',
          botId,
          pageId: takenByA.pageId,
          lease: takenByA.lease,
          revision: takenByA.revision,
          event: { kind: 'click', x: 0.5, y: 0.5 },
        }),
      (err) => err?.code === 'BROWSER_LEASE_CONFLICT',
    );

    // Client B trying non-force takeover MUST fail with BROWSER_LEASE_CONFLICT.
    await assert.rejects(
      () => clientB.browserControl({ action: 'takeover', botId, holderLabel: 'Desktop-B' }),
      (err) => err?.code === 'BROWSER_LEASE_CONFLICT',
    );

    // 3. Remote Relay client C via real createHostControlReceiver carries authenticated fromDeviceId:
    const relayReplies = [];
    const receiver = createHostControlReceiver({
      deviceId: server.deviceId,
      execute: relayAdapter,
      send: (frame) => {
        relayReplies.push(frame);
        return true;
      },
    });
    const waitReply = (routeId) =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const hit = relayReplies.find((f) => f.routeId === routeId);
          if (hit) return resolve(hit);
          if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${routeId}`));
          setTimeout(poll, 10);
        };
        poll();
      });

    receiver.handle({
      type: 'control-request',
      routeId: 'route-status-c',
      fromDeviceId: 'remote-android-client-c',
      method: 'browserControl',
      params: { action: 'status', botId },
    });
    const statusReplyC = await waitReply('route-status-c');
    assert.equal(statusReplyC.ok, true);
    assert.equal(statusReplyC.result.isLeaseHolder, false);
    assert.equal(statusReplyC.result.lease, undefined);

    // Explicit preemption from remote Relay client C transfers lease away from Client A.
    receiver.handle({
      type: 'control-request',
      routeId: 'route-preempt-c',
      fromDeviceId: 'remote-android-client-c',
      method: 'browserControl',
      params: { action: 'takeover', botId, preempt: true, holderLabel: 'Android-C' },
    });
    const preemptReplyC = await waitReply('route-preempt-c');
    assert.equal(preemptReplyC.ok, true);
    assert.equal(preemptReplyC.result.phase, 'human');
    assert.equal(preemptReplyC.result.isLeaseHolder, true);
    assert.equal(typeof preemptReplyC.result.lease, 'string');
    assert.notEqual(preemptReplyC.result.lease, takenByA.lease);

    // Unknown bot rejected cleanly across adapter with BOT_NOT_FOUND + outcome 'responded'.
    await assert.rejects(
      () => relayAdapter(server.deviceId, 'browserControl', { action: 'status', botId: 'unknown-bot-id' }),
      (err) => err?.code === 'BOT_NOT_FOUND' && err?.outcome === 'responded',
    );

    // Explicit close inside try so any failure is never masked by finally.
    await server.close();
    serverClosed = true;
    assert.equal(providerTracker.created >= 1, true);
    assert.equal(providerTracker.closed, providerTracker.created);
  } finally {
    if (server && !serverClosed) {
      await server.close().catch(() => {});
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});
