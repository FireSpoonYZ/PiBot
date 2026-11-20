// web/test/bot-browser-desktop-provider.test.mjs
//
// Regression unit tests for the desktop Chromium Bot browser provider,
// discovery/profile isolation, CDP pipe & loopback transports, sensitive page
// boundaries, human-only ToS/OAuth/secret guards, same-page input revalidation,
// and bounded screencast frames.
//
// Linux strict-snap relocation cases adapted from Orca v1.4.265
// (commit e64e561738d8d465ab459e7e3f9e46d08b6396ea):
//   src/main/orcad/browser-providers/chromium/external-chromium-profile-path.test.ts
// MIT License — Copyright (c) 2026 Lovecast Inc.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  CdpClient,
  parseDevToolsListeningUrl,
  parseLoopbackDevToolsUrl,
  PipeCdpTransport,
} from '../../host-core/bot-browser/desktop-cdp.js';
import {
  buildChromiumLaunchArgs,
  discoverDesktopBrowser,
  isPersonalBrowserProfilePath,
  isolateChildBrowserEnvironment,
  resolveExternalChromiumProfilePath,
} from '../../host-core/bot-browser/desktop-discovery.js';
import {
  checkBotHumanOnlyTarget,
  classifySensitivePage,
  DESKTOP_BROWSER_MAX_FRAME_BASE64_BYTES,
  normalizeHumanInputEvent,
  normalizeNavigationUrl,
  resolveCdpKeyDescriptor,
} from '../../host-core/bot-browser/desktop-policy.js';
import { createDesktopBrowserProvider } from '../../host-core/bot-browser/desktop-provider.js';

/**
 * In-memory fake CDP transport + browser simulator for deterministic provider tests.
 */
function createMockBrowserHarness() {
  const sentCommands = [];
  const messageHandlers = new Set();
  const closeHandlers = new Set();
  let nextTargetNum = 1;
  let nextSessionNum = 1;
  let closed = false;
  let browserClosedCalls = 0;

  const targets = new Map();
  const sessions = new Map();

  function createTargetState(url = 'about:blank') {
    const targetId = `target-${nextTargetNum++}`;
    const state = {
      targetId,
      sessionId: null,
      frameId: `frame-${targetId}`,
      loaderId: `loader-1-${targetId}`,
      url,
      title: url === 'about:blank' ? '' : 'Mock Page',
      history: [{ id: 1, url }],
      historyIndex: 0,
      domSignals: {
        title: url === 'about:blank' ? '' : 'Mock Page',
        url,
        passwordFocused: false,
        hasVisiblePasswordInput: false,
        hasClientSecretModal: false,
        hasOAuthConsentPrompt: false,
        hasPaymentInput: false,
      },
      axNodes: [
        {
          nodeId: '1',
          role: { value: 'textbox' },
          name: { value: 'Application name' },
          value: { value: 'PiBot Workspace' },
          backendDOMNodeId: 101,
        },
        {
          nodeId: '2',
          role: { value: 'textbox' },
          name: { value: 'Password' },
          value: { value: 'super-secret-value' },
          backendDOMNodeId: 102,
          properties: [{ name: 'autocomplete', value: { value: 'current-password' } }],
        },
        {
          nodeId: '3',
          role: { value: 'checkbox' },
          name: { value: 'I agree to the Google API Services: User Data Policy' },
          backendDOMNodeId: 103,
          properties: [{ name: 'checked', value: { value: 'false' } }],
        },
        {
          nodeId: '4',
          role: { value: 'button' },
          name: { value: 'Create' },
          backendDOMNodeId: 104,
        },
        {
          nodeId: '5',
          role: { value: 'button' },
          name: { value: 'Save draft' },
          backendDOMNodeId: 105,
        },
      ],
      elementMetaByNodeId: {
        101: { tag: 'input', type: 'text', checked: false, disabled: false },
        102: { tag: 'input', type: 'password', checked: false, disabled: false },
        103: { tag: 'input', type: 'checkbox', checked: false, disabled: false },
        104: { tag: 'button', type: 'submit', checked: false, disabled: false },
        105: { tag: 'button', type: 'button', checked: false, disabled: false },
      },
      screenshotDataByQuality: {},
      screencastStarted: false,
      screencastAcks: [],
    };
    targets.set(targetId, state);
    return state;
  }

  // Initial about:blank target like real Chromium startup.
  createTargetState('about:blank');

  function emitEvent(method, params = {}, sessionId = null) {
    const payload = { method, params, ...(sessionId ? { sessionId } : {}) };
    for (const handler of messageHandlers) {
      handler(payload);
    }
  }

  const transport = {
    kind: 'pipe',
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    send(payload) {
      if (closed) {
        throw new Error('transport closed');
      }
      sentCommands.push(payload);
      const { id, method, params = {}, sessionId = null } = payload;
      queueMicrotask(() => {
        if (closed) return;
        const reply = (result) => {
          for (const handler of messageHandlers) {
            handler({ id, result });
          }
        };
        const fail = (message) => {
          for (const handler of messageHandlers) {
            handler({ id, error: { code: -32000, message } });
          }
        };

        if (method === 'Browser.getVersion') {
          reply({ product: 'Chrome/136.0.0.0', protocolVersion: '1.3' });
          return;
        }
        if (method === 'Browser.close') {
          browserClosedCalls += 1;
          reply({});
          return;
        }
        if (method === 'Target.setDiscoverTargets' || method === 'Browser.setDownloadBehavior') {
          reply({});
          return;
        }
        if (method === 'Target.getTargets') {
          reply({
            targetInfos: Array.from(targets.values()).map((t) => ({
              targetId: t.targetId,
              type: 'page',
              url: t.url,
              title: t.title,
            })),
          });
          return;
        }
        if (method === 'Target.createTarget') {
          const t = createTargetState(params.url || 'about:blank');
          reply({ targetId: t.targetId });
          return;
        }
        if (method === 'Target.attachToTarget') {
          const t = targets.get(params.targetId);
          if (!t) {
            fail('Target closed');
            return;
          }
          const sid = `session-${nextSessionNum++}`;
          t.sessionId = sid;
          sessions.set(sid, t);
          reply({ sessionId: sid });
          return;
        }
        if (method === 'Target.activateTarget') {
          reply({});
          return;
        }
        if (method === 'Target.closeTarget') {
          const t = targets.get(params.targetId);
          if (t) {
            targets.delete(t.targetId);
            if (t.sessionId) sessions.delete(t.sessionId);
          }
          reply({ success: true });
          return;
        }

        const page = sessionId ? sessions.get(sessionId) : null;
        if (!page) {
          fail('Session with given id not found');
          return;
        }

        if (
          method === 'Page.enable' ||
          method === 'DOM.enable' ||
          method === 'Accessibility.enable' ||
          method === 'Emulation.setDeviceMetricsOverride' ||
          method === 'DOM.scrollIntoViewIfNeeded' ||
          method === 'DOM.focus' ||
          method === 'Runtime.releaseObject' ||
          method === 'Input.dispatchMouseEvent' ||
          method === 'Input.insertText' ||
          method === 'Input.dispatchKeyEvent'
        ) {
          reply({});
          return;
        }
        if (method === 'Page.getFrameTree') {
          reply({
            frameTree: {
              frame: {
                id: page.frameId,
                loaderId: page.loaderId,
                url: page.url,
              },
            },
          });
          return;
        }
        if (method === 'Runtime.evaluate') {
          reply({
            result: {
              value: {
                ...page.domSignals,
                url: page.url,
                title: page.title,
              },
            },
          });
          return;
        }
        if (method === 'Page.navigate') {
          page.url = params.url;
          page.title = `Title for ${params.url}`;
          page.loaderId = `loader-${Date.now()}-${Math.random()}`;
          page.history = page.history.slice(0, page.historyIndex + 1);
          page.history.push({ id: page.history.length + 1, url: params.url });
          page.historyIndex = page.history.length - 1;
          reply({ frameId: page.frameId, loaderId: page.loaderId });
          emitEvent('Page.loadEventFired', { timestamp: 1 }, sessionId);
          return;
        }
        if (method === 'Page.reload') {
          page.loaderId = `loader-reload-${Math.random()}`;
          reply({});
          emitEvent('Page.loadEventFired', { timestamp: 2 }, sessionId);
          return;
        }
        if (method === 'Page.getNavigationHistory') {
          reply({ currentIndex: page.historyIndex, entries: page.history });
          return;
        }
        if (method === 'Page.navigateToHistoryEntry') {
          const idx = page.history.findIndex((e) => e.id === params.entryId);
          if (idx === -1) {
            fail('History entry not found');
            return;
          }
          page.historyIndex = idx;
          page.url = page.history[idx].url;
          page.loaderId = `loader-hist-${idx}`;
          reply({});
          emitEvent('Page.loadEventFired', { timestamp: 3 }, sessionId);
          return;
        }
        if (method === 'Page.startScreencast') {
          page.screencastStarted = true;
          reply({});
          return;
        }
        if (method === 'Page.stopScreencast') {
          page.screencastStarted = false;
          reply({});
          return;
        }
        if (method === 'Page.screencastFrameAck') {
          page.screencastAcks.push(params.sessionId);
          reply({});
          return;
        }
        if (method === 'Page.captureScreenshot') {
          const data = page.screenshotDataByQuality[params.quality] ?? Buffer.from('mock-jpeg').toString('base64');
          reply({ data });
          return;
        }
        if (method === 'Accessibility.getFullAXTree') {
          reply({ nodes: page.axNodes });
          return;
        }
        if (method === 'DOM.getContentQuads') {
          reply({ quads: [[100, 200, 200, 200, 200, 240, 100, 240]] });
          return;
        }
        if (method === 'DOM.resolveNode') {
          reply({ object: { objectId: `obj-${params.backendNodeId}` } });
          return;
        }
        if (method === 'Runtime.callFunctionOn') {
          const nodeId = Number(String(params.objectId).replace('obj-', ''));
          if (String(params.functionDeclaration).includes('aria-checked')) {
            reply({ result: { value: page.elementMetaByNodeId[nodeId] ?? null } });
          } else {
            reply({ result: { value: null } });
          }
          return;
        }

        fail(`Unhandled mock CDP method: ${method}`);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const handler of closeHandlers) {
        handler(null);
      }
    },
  };

  const client = new CdpClient(transport, { defaultTimeoutMs: 5_000 });

  return {
    sentCommands,
    targets,
    sessions,
    emitEvent,
    get browserClosedCalls() {
      return browserClosedCalls;
    },
    getHandle() {
      return {
        client,
        transport: 'pipe',
        pid: 42424,
        browserVersion: { product: 'Chrome/136.0.0.0', protocolVersion: '1.3' },
        async close() {
          browserClosedCalls += 1;
          client.close();
        },
      };
    },
  };
}

test('discovery reports honest unavailable reasons on unsupported platform and missing browser', async () => {
  const androidRes = await discoverDesktopBrowser({ platform: 'android' });
  assert.equal(androidRes.available, false);
  assert.equal(androidRes.reason, 'desktop_platform_unsupported');

  const missingRes = await discoverDesktopBrowser({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    homePath: '/home/tester',
    probeExecutable: async () => 'missing',
  });
  assert.equal(missingRes.available, false);
  assert.equal(missingRes.reason, 'browser_executable_not_found');

  const winEdge = await discoverDesktopBrowser({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    homePath: 'C:\\Users\\tester',
    probeExecutable: async (p) => (p.endsWith('msedge.exe') ? 'ok' : 'missing'),
  });
  assert.equal(winEdge.available, true);
  assert.equal(winEdge.kind, 'edge');
  assert.equal(winEdge.transport, 'loopback');

  const macChrome = await discoverDesktopBrowser({
    platform: 'darwin',
    env: {},
    homePath: '/Users/tester',
    probeExecutable: async (p) =>
      p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ? 'ok' : 'missing',
  });
  assert.equal(macChrome.available, true);
  assert.equal(macChrome.kind, 'chrome');
  assert.equal(macChrome.transport, 'pipe');
});

test('personal browser profile guard blocks user Chrome/Edge/Chromium directories and HOME', () => {
  assert.equal(
    isPersonalBrowserProfilePath('C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data', {
      platform: 'win32',
      homePath: 'C:\\Users\\alice',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    }),
    true
  );
  assert.equal(
    isPersonalBrowserProfilePath('C:\\Users\\alice\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default', {
      platform: 'win32',
      homePath: 'C:\\Users\\alice',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    }),
    true
  );
  assert.equal(
    isPersonalBrowserProfilePath('/home/alice/.config/google-chrome', {
      platform: 'linux',
      homePath: '/home/alice',
      env: {},
    }),
    true
  );
  assert.equal(
    isPersonalBrowserProfilePath('/home/alice', {
      platform: 'linux',
      homePath: '/home/alice',
      env: {},
    }),
    true
  );
  assert.equal(
    isPersonalBrowserProfilePath('/home/alice/.pibot/bot-browser/profiles/bot-1', {
      platform: 'linux',
      homePath: '/home/alice',
      env: {},
    }),
    false
  );
});

test('child environment isolation strips AGENT_BROWSER_* and Google/Vault secrets; launch flags stay hardened', () => {
  const clean = isolateChildBrowserEnvironment({
    PATH: '/usr/bin',
    AGENT_BROWSER_HEADED: 'true',
    agent_browser_auto_connect: '1',
    GOOGLE_DEFAULT_CLIENT_SECRET: 'super-secret',
    PIBOT_VAULT_TOKEN: 'vault-token',
    HOME: '/home/alice',
  });
  assert.equal(clean.PATH, '/usr/bin');
  assert.equal(clean.HOME, '/home/alice');
  assert.equal('AGENT_BROWSER_HEADED' in clean, false);
  assert.equal('agent_browser_auto_connect' in clean, false);
  assert.equal('GOOGLE_DEFAULT_CLIENT_SECRET' in clean, false);
  assert.equal('PIBOT_VAULT_TOKEN' in clean, false);

  const pipeArgs = buildChromiumLaunchArgs({
    profilePath: '/tmp/bot-profile',
    transport: 'pipe',
    platform: 'linux',
  });
  assert.ok(pipeArgs.includes('--remote-debugging-pipe'));
  assert.ok(!pipeArgs.some((a) => a.startsWith('--remote-debugging-port')));
  assert.ok(!pipeArgs.some((a) => a.includes('--remote-allow-origins')));
  assert.ok(!pipeArgs.some((a) => a.includes('--disable-web-security')));
  assert.ok(!pipeArgs.some((a) => a.includes('--ignore-certificate-errors')));
  assert.ok(!pipeArgs.some((a) => a.includes('--no-sandbox')));

  const winArgs = buildChromiumLaunchArgs({
    profilePath: 'C:\\pibot\\bot-1',
    transport: 'loopback',
    platform: 'win32',
  });
  assert.ok(winArgs.includes('--remote-debugging-port=0'));
  assert.ok(!winArgs.some((a) => a.includes('0.0.0.0')));
});

test('strict snap profile relocation preserves Orca MIT confinement handling', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pibot-chromium-snap-'));
  try {
    const snapRoot = path.join(root, 'snap');
    await mkdir(path.join(root, 'usr', 'bin'), { recursive: true });
    await writeFile(path.join(root, 'usr', 'bin', 'snap'), '');
    await mkdir(path.join(snapRoot, 'bin'), { recursive: true });
    const launcher = path.join(snapRoot, 'bin', 'chromium');
    await symlink(path.join(root, 'usr', 'bin', 'snap'), launcher);
    await mkdir(path.join(snapRoot, 'chromium', 'current', 'meta'), { recursive: true });
    await writeFile(
      path.join(snapRoot, 'chromium', 'current', 'meta', 'snap.yaml'),
      'name: chromium\nconfinement: strict\n'
    );

    const relocated = await resolveExternalChromiumProfilePath(
      launcher,
      path.join(root, 'state', 'bot-1'),
      '0123456789abcdef',
      {
        platform: 'linux',
        snapRoots: [snapRoot],
        homePath: () => path.join(root, 'home'),
      }
    );
    assert.equal(
      relocated,
      path.join(root, 'home', 'snap', 'chromium', 'common', 'pibot-browser-0123456789abcdef')
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PipeCdpTransport frames split UTF-8 messages cleanly and loopback URL parser rejects non-127.0.0.1', () => {
  const writeStream = new PassThrough();
  const readStream = new PassThrough();
  const transport = new PipeCdpTransport(writeStream, readStream);
  const received = [];
  transport.onMessage((msg) => received.push(msg));

  const utf8Msg = Buffer.from(`${JSON.stringify({ id: 1, result: { title: '你好世界' } })}\0`, 'utf8');
  // Split right inside a multi-byte UTF-8 sequence.
  readStream.write(utf8Msg.subarray(0, 28));
  readStream.write(utf8Msg.subarray(28));
  assert.equal(received.length, 1);
  assert.equal(received[0].result.title, '你好世界');
  transport.close();

  assert.equal(
    parseLoopbackDevToolsUrl('ws://127.0.0.1:41234/devtools/browser/abc-123_XYZ'),
    'ws://127.0.0.1:41234/devtools/browser/abc-123_XYZ'
  );
  assert.equal(
    parseDevToolsListeningUrl('DevTools listening on ws://127.0.0.1:9222/devtools/browser/test_1\n'),
    'ws://127.0.0.1:9222/devtools/browser/test_1'
  );
  assert.throws(() => parseLoopbackDevToolsUrl('ws://0.0.0.0:9222/devtools/browser/abc'), {
    code: 'BROWSER_UNSAFE_ENDPOINT',
  });
  assert.throws(() => parseLoopbackDevToolsUrl('ws://192.168.1.5:9222/devtools/browser/abc'), {
    code: 'BROWSER_UNSAFE_ENDPOINT',
  });
  assert.throws(() => parseLoopbackDevToolsUrl('wss://127.0.0.1:9222/devtools/browser/abc'), {
    code: 'BROWSER_UNSAFE_ENDPOINT',
  });
});

test('URL policy, sensitive classification, and human-only guards enforce hard boundaries', () => {
  assert.equal(normalizeNavigationUrl('https://console.cloud.google.com/auth/overview'), 'https://console.cloud.google.com/auth/overview');
  assert.equal(normalizeNavigationUrl('about:blank'), 'about:blank');
  assert.equal(normalizeNavigationUrl('file:///etc/passwd'), null);
  assert.equal(normalizeNavigationUrl('javascript:alert(1)'), null);
  assert.equal(normalizeNavigationUrl('data:text/html,<h1>x</h1>'), null);
  assert.equal(normalizeNavigationUrl('chrome://settings'), null);
  assert.equal(normalizeNavigationUrl('https://user:pass@example.com/'), null);

  assert.equal(classifySensitivePage({ url: 'https://accounts.google.com/signin' }).sensitive, true);
  assert.equal(classifySensitivePage({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }).authUseSystemBrowser, true);
  assert.equal(
    classifySensitivePage({
      url: 'https://console.cloud.google.com/apis/credentials',
      domSignals: { hasClientSecretModal: true },
    }).secretExposureRisk,
    true
  );

  assert.equal(
    checkBotHumanOnlyTarget({
      url: 'https://console.cloud.google.com/auth/overview',
      role: 'checkbox',
      name: 'I agree to the Google API Services: User Data Policy',
      actionKind: 'check',
    }).blocked,
    true
  );
  assert.equal(
    checkBotHumanOnlyTarget({
      url: 'https://console.cloud.google.com/apis/credentials/oauthclient',
      role: 'button',
      name: 'Create',
      actionKind: 'click',
    }).blocked,
    true
  );
  assert.throws(() => resolveCdpKeyDescriptor('Control+Shift+I'), { code: 'BROWSER_INPUT_BLOCKED' });
  assert.throws(() => resolveCdpKeyDescriptor('F12'), { code: 'BROWSER_INPUT_BLOCKED' });
  assert.equal(DESKTOP_BROWSER_MAX_FRAME_BASE64_BYTES, 737_280);
  assert.throws(() => normalizeHumanInputEvent({ kind: 'click', x: 1.2, y: 0.5 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => normalizeHumanInputEvent({ kind: 'text', text: 'hello\nworld' }), { code: 'INVALID_ARGUMENT' });
});

test('desktop provider supports same-page navigation, bounded frames, input revalidation, and blocks forbidden/sensitive bot actions', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'pibot-desktop-provider-'));
  const harness = createMockBrowserHarness();
  let launchCount = 0;
  let fakeNow = 1_700_000_000_000;

  try {
    const provider = await createDesktopBrowserProvider({
      botId: 'bot-alpha',
      profileDir: path.join(tmpDir, 'bot-alpha-profile'),
      maxTabs: 2,
      maxFrameBase64Bytes: 64_000,
      minFrameIntervalMs: 50,
      now: () => fakeNow,
      discoverBrowser: async () => ({
        available: true,
        reason: null,
        detail: null,
        executablePath: '/usr/bin/chromium',
        kind: 'chromium',
        transport: 'pipe',
      }),
      launchBrowser: async () => {
        launchCount += 1;
        return harness.getHandle();
      },
    });

    // Status before open must NOT launch Chromium.
    const idleStatus = await provider.perform({ action: 'status', botId: 'bot-alpha' });
    assert.equal(idleStatus.available, true);
    assert.equal(idleStatus.canStreamInteract, true);
    assert.equal(idleStatus.backend.running, false);
    assert.equal(launchCount, 0);

    // Open a non-sensitive Cloud Console setup page.
    const opened = await provider.perform({
      action: 'open',
      url: 'https://console.cloud.google.com/apis/credentials/oauthclient',
    });
    assert.equal(launchCount, 1);
    assert.equal(opened.tabs.length, 1);
    assert.ok(opened.pageId);
    const pageId = opened.pageId;
    const rev = opened.revision;
    const docGen = opened.documentGeneration;

    // Snapshot redacts password values and marks human-only ToS/Create targets.
    const snap = await provider.perform({ action: 'snapshot', pageId });
    assert.equal(snap.sensitive, false);
    const pwRef = snap.refs.find((r) => r.name === 'Password');
    assert.equal(pwRef.value, '[REDACTED]');
    assert.equal(pwRef.humanOnly, true);
    const tosRef = snap.refs.find((r) => r.name.includes('User Data Policy'));
    assert.equal(tosRef.humanOnly, true);
    const createRef = snap.refs.find((r) => r.name === 'Create');
    assert.equal(createRef.humanOnly, true);

    // Bot is blocked from eval/cookies/CDP, checking ToS, clicking Create, or filling passwords.
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'eval', value: '1+1' } }),
      { code: 'BROWSER_ACTION_FORBIDDEN' }
    );
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'check', ref: tosRef.ref } }),
      { code: 'BROWSER_HUMAN_REQUIRED' }
    );
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'click', ref: createRef.ref } }),
      { code: 'BROWSER_HUMAN_REQUIRED' }
    );
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'fill', ref: pwRef.ref, value: 'abc' } }),
      { code: 'BROWSER_HUMAN_REQUIRED' }
    );
    // Bot is blocked from directly navigating into Google API OAuth consent.
    await assert.rejects(
      () =>
        provider.perform({
          action: 'navigate',
          actor: 'bot',
          pageId,
          url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
        }),
      { code: 'BROWSER_AUTH_USE_SYSTEM_BROWSER' }
    );

    // Human takeover input works on the exact same pageId with normalized coordinates.
    const beforeCmdCount = harness.sentCommands.length;
    await assert.rejects(
      () =>
        provider.perform({
          action: 'input',
          pageId,
          revision: rev + 99,
          event: { kind: 'click', x: 0.5, y: 0.5 },
        }),
      { code: 'BROWSER_STALE_REVISION', outcome: 'not-sent' }
    );
    const inputSentAfterStale = harness.sentCommands
      .slice(beforeCmdCount)
      .filter((c) => c.method.startsWith('Input.'));
    assert.equal(inputSentAfterStale.length, 0);

    const clickRes = await provider.perform({
      action: 'input',
      pageId,
      revision: rev,
      documentGeneration: docGen,
      event: { kind: 'click', x: 0.5, y: 0.25 },
    });
    assert.equal(clickRes.ok, true);
    assert.equal(clickRes.pageId, pageId);
    const dispatchedMouse = harness.sentCommands.find(
      (c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed'
    );
    assert.equal(dispatchedMouse.params.x, 640);
    assert.equal(dispatchedMouse.params.y, 200);

    // Frame uses screencast/bounded capture and enforces byte budget via adaptive quality.
    const targetState = Array.from(harness.targets.values())[0];
    targetState.screenshotDataByQuality[65] = 'A'.repeat(70_000); // oversized for 64_000 cap
    targetState.screenshotDataByQuality[50] = 'B'.repeat(1_024); // fits cap
    const frame = await provider.perform({ action: 'frame', pageId, viewer: 'human' });
    assert.equal(frame.pageId, pageId);
    assert.equal(frame.mimeType, 'image/jpeg');
    assert.equal(frame.data.length, 1_024);

    // Live CDP screencast frame is acked and served directly once past minFrameIntervalMs.
    fakeNow += 100;
    const liveData = Buffer.from('live-screencast-frame').toString('base64');
    harness.emitEvent(
      'Page.screencastFrame',
      { data: liveData, sessionId: 77, metadata: { deviceWidth: 1280, deviceHeight: 800 } },
      targetState.sessionId
    );
    const liveFrame = await provider.perform({
      action: 'frame',
      pageId,
      viewer: 'human',
      afterSeq: frame.seq,
    });
    assert.equal(liveFrame.data, liveData);
    assert.ok(liveFrame.seq > frame.seq);
    assert.ok(targetState.screencastAcks.includes(77));

    // Secret dialog blocks ordinary frame streaming and input.
    targetState.domSignals.hasClientSecretModal = true;
    await assert.rejects(() => provider.perform({ action: 'frame', pageId, viewer: 'human' }), {
      code: 'BROWSER_SECRET_FRAME_BLOCKED',
    });
    await assert.rejects(
      () => provider.perform({ action: 'input', pageId, event: { kind: 'key', key: 'Enter' } }),
      { code: 'BROWSER_SECRET_INPUT_BLOCKED' }
    );
    targetState.domSignals.hasClientSecretModal = false;

    // Max tab ceiling is enforced.
    await provider.perform({ action: 'open', url: 'https://example.com' });
    await assert.rejects(() => provider.perform({ action: 'open', url: 'https://example.org' }), {
      code: 'BROWSER_TAB_LIMIT_REACHED',
    });

    await provider.close();
    assert.ok(harness.browserClosedCalls >= 1);
    await assert.rejects(() => provider.perform({ action: 'status' }), { code: 'BROWSER_CLOSED' });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
