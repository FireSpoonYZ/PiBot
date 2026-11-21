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
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';

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
  INTERNAL_DOCUMENT_HANDLE_EXPRESSION,
  INTERNAL_WAIT_CONDITION_FUNCTION,
  normalizeHumanInputEvent,
  normalizeNavigationUrl,
  resolveCdpKeyDescriptor,
} from '../../host-core/bot-browser/desktop-policy.js';
import { createDesktopBrowserProvider } from '../../host-core/bot-browser/desktop-provider.js';

/**
 * In-memory fake CDP transport + browser simulator for deterministic provider tests.
 */
function createMockBrowserHarness(options = {}) {
  const sentCommands = [];
  const messageHandlers = new Set();
  const closeHandlers = new Set();
  const failAttachTargetIds = new Set();
  const defaultBrowserContextId = options.browserContextId ?? 'ctx-bot-default';
  let onCreateTarget = typeof options.onCreateTarget === 'function' ? options.onCreateTarget : null;
  let nextTargetNum = 1;
  let nextSessionNum = 1;
  let closed = false;
  let browserClosedCalls = 0;

  const targets = new Map();
  const sessions = new Map();

  function buildTargetInfo(t) {
    return {
      targetId: t.targetId,
      type: t.type,
      url: t.url,
      title: t.title,
      ...(t.openerId ? { openerId: t.openerId } : {}),
      ...(t.browserContextId ? { browserContextId: t.browserContextId } : {}),
    };
  }

  function createTargetState(url = 'about:blank', targetOpts = {}) {
    const targetId = `target-${nextTargetNum++}`;
    const resolvedTitle = targetOpts.title !== undefined
      ? targetOpts.title
      : (url === 'about:blank' || !url ? '' : 'Mock Page');
    const state = {
      targetId,
      type: targetOpts.type ?? 'page',
      openerId: targetOpts.openerId ?? null,
      browserContextId:
        targetOpts.browserContextId !== undefined ? targetOpts.browserContextId : defaultBrowserContextId,
      sessionId: null,
      frameId: `frame-${targetId}`,
      loaderId: `loader-1-${targetId}`,
      url,
      title: resolvedTitle,
      history: [{ id: 1, url }],
      historyIndex: 0,
      domSignals: {
        title: resolvedTitle,
        url,
        readyState: 'complete',
        passwordFocused: false,
        hasVisiblePasswordInput: false,
        hasClientSecretModal: false,
        hasOAuthConsentPrompt: false,
        hasPaymentInput: false,
      },
      readyState: 'complete',
      visibleText: '',
      selectors: {},
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
            targetInfos: Array.from(targets.values()).map(buildTargetInfo),
          });
          return;
        }
        if (method === 'Target.createTarget') {
          const t = createTargetState(params.url || 'about:blank');
          if (options.emitTargetCreatedBeforeCreateReply) {
            emitEvent('Target.targetCreated', { targetInfo: buildTargetInfo(t) });
          }
          if (typeof onCreateTarget === 'function') {
            onCreateTarget(t);
          }
          reply({ targetId: t.targetId });
          return;
        }
        if (method === 'Target.attachToTarget') {
          const t = targets.get(params.targetId);
          if (!t || failAttachTargetIds.has(params.targetId)) {
            fail('Target closed');
            return;
          }
          const sid = `session-${nextSessionNum++}`;
          t.sessionId = sid;
          sessions.set(sid, t);
          reply({ sessionId: sid });
          return;
        }
        if (method === 'Target.detachFromTarget') {
          if (params.sessionId) {
            const t = sessions.get(params.sessionId);
            if (t && t.sessionId === params.sessionId) {
              t.sessionId = null;
            }
            sessions.delete(params.sessionId);
          }
          reply({});
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
          if (params.expression === INTERNAL_DOCUMENT_HANDLE_EXPRESSION && params.returnByValue === false) {
            reply({
              result: {
                type: 'object',
                subtype: 'node',
                objectId: `doc-${page.targetId}`,
              },
            });
            return;
          }
          reply({
            result: {
              value: {
                ...page.domSignals,
                url: page.url,
                title: page.title,
                readyState: page.readyState ?? page.domSignals.readyState ?? 'complete',
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
          if (options.onCaptureScreenshot) options.onCaptureScreenshot(() => reply({ data }));
          else reply({ data });
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
          if (String(params.objectId).startsWith('doc-')) {
            const opts = params.arguments?.[0]?.value ?? {};
            let selectorInvalid = false;
            let selectorMatched = true;
            if (typeof opts.selector === 'string' && opts.selector.length > 0) {
              const entry = page.selectors[opts.selector];
              if (entry === 'invalid') {
                selectorInvalid = true;
                selectorMatched = false;
              } else {
                const anyVisible = entry === 'visible';
                selectorMatched = opts.state === 'hidden' ? !anyVisible : anyVisible;
              }
            }
            let textMatched = true;
            if (typeof opts.text === 'string' && opts.text.length > 0) {
              textMatched = String(page.visibleText || '').includes(opts.text);
            }
            reply({
              result: {
                value: {
                  readyState: page.readyState ?? 'complete',
                  selectorInvalid,
                  urlMatched: !opts.url || page.url === opts.url,
                  selectorMatched,
                  textMatched,
                },
              },
            });
            return;
          }
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

  function spawnTarget(url = 'about:blank', targetOpts = {}) {
    const t = createTargetState(url, targetOpts);
    if (targetOpts.emit !== false) {
      emitEvent('Target.targetCreated', { targetInfo: buildTargetInfo(t) });
    }
    return t;
  }

  return {
    sentCommands,
    targets,
    sessions,
    failAttachTargetIds,
    buildTargetInfo,
    spawnTarget,
    setOnCreateTarget(fn) {
      onCreateTarget = typeof fn === 'function' ? fn : null;
    },
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

  const login = classifySensitivePage({
    url: 'https://accounts.google.com/v3/signin/identifier?service=cloudconsole',
  });
  assert.equal(login.sensitive, true);
  assert.equal(login.authUseSystemBrowser, false);
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

test('INTERNAL_WAIT_CONDITION_FUNCTION checks visibility, absent hidden, invalid selector, and visible text without returning page text', () => {
  const probeFn = new Function(`return (${INTERNAL_WAIT_CONDITION_FUNCTION});`)();
  const makeEl = (style, rect = { width: 100, height: 24 }, { isConnected = true, parentElement = null } = {}) => ({
    isConnected,
    parentElement,
    _style: { display: 'block', visibility: 'visible', opacity: '1', contentVisibility: 'visible', ...style },
    getClientRects: () => (rect.width > 0 && rect.height > 0 ? [rect] : []),
    getBoundingClientRect: () => rect,
  });

  const visibleEl = makeEl({});
  const displayNoneEl = makeEl({ display: 'none' });
  const visibilityHiddenEl = makeEl({ visibility: 'hidden' });
  const opacityZeroEl = makeEl({ opacity: '0' });
  const zeroRectEl = makeEl({}, { width: 0, height: 0 });
  const hiddenParent = makeEl({ opacity: '0' });
  const childOfHiddenParent = makeEl({}, { width: 40, height: 20 }, { parentElement: hiddenParent });

  const selectorMap = {
    '#visible': [visibleEl],
    '#display-none': [displayNoneEl],
    '#vis-hidden': [visibilityHiddenEl],
    '#opacity-zero': [opacityZeroEl],
    '#zero-rect': [zeroRectEl],
    '#child-hidden-parent': [childOfHiddenParent],
    '.mixed': [displayNoneEl, visibleEl],
  };

  const fakeDoc = {
    readyState: 'interactive',
    defaultView: {
      getComputedStyle: (el) => el._style,
    },
    body: {
      innerText: 'Order #42 confirmed — private body copy',
    },
    querySelectorAll(sel) {
      if (sel === 'div[broken') {
        throw new SyntaxError('invalid selector');
      }
      return selectorMap[sel] ?? [];
    },
  };

  assert.deepEqual(probeFn.call(fakeDoc, { selector: '#visible', state: 'visible' }), {
    readyState: 'interactive',
    selectorInvalid: false,
    urlMatched: true,
    selectorMatched: true,
    textMatched: true,
  });
  assert.equal(probeFn.call(fakeDoc, { selector: '#display-none', state: 'visible' }).selectorMatched, false);
  assert.equal(probeFn.call(fakeDoc, { selector: '#vis-hidden', state: 'visible' }).selectorMatched, false);
  assert.equal(probeFn.call(fakeDoc, { selector: '#opacity-zero', state: 'visible' }).selectorMatched, false);
  assert.equal(probeFn.call(fakeDoc, { selector: '#zero-rect', state: 'visible' }).selectorMatched, false);
  assert.equal(probeFn.call(fakeDoc, { selector: '#child-hidden-parent', state: 'visible' }).selectorMatched, false);
  assert.equal(probeFn.call(fakeDoc, { selector: '.mixed', state: 'visible' }).selectorMatched, true);

  // Hidden matches absent elements as well as CSS-hidden elements, and fails when visible.
  assert.equal(probeFn.call(fakeDoc, { selector: '#does-not-exist', state: 'hidden' }).selectorMatched, true);
  assert.equal(probeFn.call(fakeDoc, { selector: '#display-none', state: 'hidden' }).selectorMatched, true);
  assert.equal(probeFn.call(fakeDoc, { selector: '#opacity-zero', state: 'hidden' }).selectorMatched, true);
  assert.equal(probeFn.call(fakeDoc, { selector: '#visible', state: 'hidden' }).selectorMatched, false);

  // Invalid CSS selector reports selectorInvalid rather than timing out.
  assert.equal(probeFn.call(fakeDoc, { selector: 'div[broken', state: 'visible' }).selectorInvalid, true);

  // Visible text substring check returns only booleans and never leaks page text.
  const textOk = probeFn.call(fakeDoc, { text: 'Order #42 confirmed' });
  assert.equal(textOk.textMatched, true);
  assert.deepEqual(Object.keys(textOk).sort(), ['readyState', 'selectorInvalid', 'selectorMatched', 'textMatched', 'urlMatched']);
  assert.equal(JSON.stringify(textOk).includes('private body copy'), false);
  assert.equal(probeFn.call(fakeDoc, { text: 'Missing phrase' }).textMatched, false);
});

test('desktop provider act.wait enforces conditions, lifecycle, validation, sensitive guard, cancellation, and safe CDP arguments', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'pibot-desktop-wait-'));
  const harness = createMockBrowserHarness();

  try {
    const provider = await createDesktopBrowserProvider({
      botId: 'bot-wait',
      profileDir: path.join(tmpDir, 'bot-wait-profile'),
      discoverBrowser: async () => ({
        available: true,
        reason: null,
        detail: null,
        executablePath: '/usr/bin/chromium',
        kind: 'chromium',
        transport: 'pipe',
      }),
      launchBrowser: async () => harness.getHandle(),
    });

    const opened = await provider.perform({
      action: 'open',
      url: 'https://example.com/start',
    });
    const pageId = opened.pageId;
    const targetState = Array.from(harness.targets.values())[0];

    // Validation: state without selector rejected; networkidle rejected as BROWSER_UNSUPPORTED; invalid selector rejected.
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', state: 'hidden' } }),
      { code: 'INVALID_ARGUMENT' }
    );
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', load: 'networkidle' } }),
      { code: 'BROWSER_UNSUPPORTED' }
    );
    targetState.selectors['div[broken'] = 'invalid';
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', selector: 'div[broken', timeoutMs: 200 } }),
      { code: 'INVALID_ARGUMENT' }
    );

    // Unconditional wait preserves timed sleep behavior.
    const timed = await provider.perform({ action: 'act', pageId, command: { kind: 'wait', timeoutMs: 60 } });
    assert.equal(timed.ok, true);
    assert.equal(timed.waitedMs, 60);

    // Selector visible: false times out with BROWSER_TIMEOUT (never returns ok); true succeeds when it appears.
    targetState.selectors['#ready'] = 'hidden';
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', selector: '#ready', timeoutMs: 80 } }),
      { code: 'BROWSER_TIMEOUT' }
    );
    setTimeout(() => {
      targetState.selectors['#ready'] = 'visible';
    }, 30);
    const visRes = await provider.perform({
      action: 'act',
      pageId,
      command: { kind: 'wait', selector: '#ready', state: 'visible', timeoutMs: 1000 },
    });
    assert.equal(visRes.ok, true);

    // Selector hidden: absent succeeds immediately; visible times out; transitioning to hidden succeeds.
    const absentHidden = await provider.perform({
      action: 'act',
      pageId,
      command: { kind: 'wait', selector: '#not-in-dom', state: 'hidden', timeoutMs: 200 },
    });
    assert.equal(absentHidden.ok, true);

    targetState.selectors['#spinner'] = 'visible';
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', selector: '#spinner', state: 'hidden', timeoutMs: 80 } }),
      { code: 'BROWSER_TIMEOUT' }
    );
    setTimeout(() => {
      targetState.selectors['#spinner'] = 'hidden';
    }, 30);
    const hiddenRes = await provider.perform({
      action: 'act',
      pageId,
      command: { kind: 'wait', selector: '#spinner', state: 'hidden', timeoutMs: 1000 },
    });
    assert.equal(hiddenRes.ok, true);

    // Visible text substring: false times out; true succeeds and response never includes page body text.
    targetState.visibleText = 'Dashboard ready — secret-adjacent body text';
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', text: 'Not here', timeoutMs: 80 } }),
      { code: 'BROWSER_TIMEOUT' }
    );
    const textRes = await provider.perform({
      action: 'act',
      pageId,
      command: { kind: 'wait', text: 'Dashboard ready', timeoutMs: 500 },
    });
    assert.equal(textRes.ok, true);
    assert.equal(JSON.stringify(textRes).includes('secret-adjacent body text'), false);

    // Exact URL: prefix/query mismatch times out; exact URL match succeeds.
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', url: 'https://example.com', timeoutMs: 80 } }),
      { code: 'BROWSER_TIMEOUT' }
    );
    setTimeout(() => {
      targetState.url = 'https://example.com/done?step=2';
      harness.emitEvent(
        'Page.navigatedWithinDocument',
        { frameId: targetState.frameId, url: targetState.url },
        targetState.sessionId
      );
    }, 30);
    const urlRes = await provider.perform({
      action: 'act',
      pageId,
      command: { kind: 'wait', url: 'https://example.com/done?step=2', timeoutMs: 1000 },
    });
    assert.equal(urlRes.ok, true);
    assert.equal(urlRes.url, 'https://example.com/done?step=2');

    const userText = 'continued by user';
    const waitingForUser = provider.perform({
      action: 'act', actor: 'bot', pageId,
      command: { kind: 'wait', text: userText, timeoutMs: 1000 },
    });
    const [afterWait, afterInput] = await Promise.all([
      waitingForUser,
      provider.perform({
        action: 'input', actor: 'human', pageId,
        event: { kind: 'text', text: userText },
        beforeInput() { targetState.visibleText = userText; },
      }),
    ]);
    assert.equal(afterInput.ok, true);
    assert.equal(afterWait.ok, true);

    // Lifecycle load / domcontentloaded: domcontentloaded resolves on DOMContentLoaded while load still waits for loadEventFired.
    targetState.readyState = 'loading';
    harness.emitEvent('Page.frameStartedLoading', { frameId: targetState.frameId }, targetState.sessionId);
    setTimeout(() => {
      targetState.readyState = 'interactive';
      harness.emitEvent('Page.domContentEventFired', { timestamp: 10 }, targetState.sessionId);
    }, 30);
    const dclRes = await provider.perform({
      action: 'act',
      pageId,
      command: { kind: 'wait', load: 'domcontentloaded', timeoutMs: 1000 },
    });
    assert.equal(dclRes.ok, true);

    // Still interactive (not loaded): load:'load' must time out until Page.loadEventFired fires.
    await assert.rejects(
      () => provider.perform({ action: 'act', pageId, command: { kind: 'wait', load: 'load', timeoutMs: 80 } }),
      { code: 'BROWSER_TIMEOUT' }
    );
    setTimeout(() => {
      targetState.readyState = 'complete';
      harness.emitEvent('Page.loadEventFired', { timestamp: 11 }, targetState.sessionId);
    }, 30);
    const loadRes = await provider.perform({
      action: 'act',
      pageId,
      command: { kind: 'wait', load: 'load', timeoutMs: 1000 },
    });
    assert.equal(loadRes.ok, true);

    // Multi-condition AND + safe structured argument passing (quotes/special chars never interpolated into JS).
    const quotedSelector = `button[data-label="save's"]`;
    targetState.selectors[quotedSelector] = 'hidden';
    targetState.visibleText = 'Saving...';
    targetState.url = 'https://example.com/saving';
    const cmdStartIdx = harness.sentCommands.length;

    setTimeout(() => {
      targetState.selectors[quotedSelector] = 'visible';
      targetState.visibleText = 'Saved cleanly';
    }, 25);
    setTimeout(() => {
      targetState.url = 'https://example.com/saved';
      harness.emitEvent(
        'Page.navigatedWithinDocument',
        { frameId: targetState.frameId, url: targetState.url },
        targetState.sessionId
      );
    }, 60);

    const multiRes = await provider.perform({
      action: 'act',
      pageId,
      command: {
        kind: 'wait',
        selector: quotedSelector,
        state: 'visible',
        text: 'Saved cleanly',
        url: 'https://example.com/saved',
        load: 'load',
        timeoutMs: 1500,
      },
    });
    assert.equal(multiRes.ok, true);
    assert.equal(multiRes.url, 'https://example.com/saved');

    // Multi-condition AND must fail with BROWSER_TIMEOUT when any single condition remains unmet.
    await assert.rejects(
      () =>
        provider.perform({
          action: 'act',
          pageId,
          command: {
            kind: 'wait',
            selector: quotedSelector,
            state: 'visible',
            text: 'Saved cleanly',
            url: 'https://example.com/other',
            load: 'load',
            timeoutMs: 80,
          },
        }),
      { code: 'BROWSER_TIMEOUT' }
    );

    const waitCallCmds = harness.sentCommands
      .slice(cmdStartIdx)
      .filter((c) => c.method === 'Runtime.callFunctionOn' && String(c.params.objectId).startsWith('doc-'));
    assert.ok(waitCallCmds.length >= 1);
    for (const c of waitCallCmds) {
      assert.equal(c.params.functionDeclaration, INTERNAL_WAIT_CONDITION_FUNCTION);
      assert.equal(c.params.functionDeclaration.includes(quotedSelector), false);
      const [arg] = c.params.arguments;
      assert.ok(['https://example.com/saved', 'https://example.com/other'].includes(arg.value.url));
      assert.deepEqual(arg.value, { selector: quotedSelector, state: 'visible', text: 'Saved cleanly', url: arg.value.url });
    }

    // Cancellation via AbortSignal interrupts wait promptly with CANCELLED.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(
      () =>
        provider.perform({
          action: 'act',
          pageId,
          command: { kind: 'wait', selector: '#never-appears', timeoutMs: 5000 },
          signal: ac.signal,
        }),
      { code: 'CANCELLED' }
    );

    // Sensitive transition mid-wait immediately aborts with BROWSER_SENSITIVE_PAGE without probing sensitive DOM.
    let sensitiveAtCmdIdx = -1;
    setTimeout(() => {
      sensitiveAtCmdIdx = harness.sentCommands.length;
      targetState.url = 'https://accounts.google.com/signin';
      harness.emitEvent(
        'Page.frameNavigated',
        { frame: { id: targetState.frameId, loaderId: 'loader-sensitive', url: targetState.url } },
        targetState.sessionId
      );
    }, 30);
    await assert.rejects(
      () =>
        provider.perform({
          action: 'act',
          pageId,
          command: { kind: 'wait', text: 'Never matches', timeoutMs: 1500 },
        }),
      { code: 'BROWSER_SENSITIVE_PAGE' }
    );
    assert.ok(sensitiveAtCmdIdx >= 0);
    const probesAfterSensitive = harness.sentCommands
      .slice(sensitiveAtCmdIdx)
      .filter((c) => c.method === 'Runtime.callFunctionOn' && String(c.params.objectId).startsWith('doc-'));
    assert.equal(probesAfterSensitive.length, 0);

    await provider.close();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('desktop provider tracks web-opened popups within cap without stealing active tab, enforces security guards, and ignores unmanaged targets', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'pibot-desktop-popup-'));
  const harness = createMockBrowserHarness();

  try {
    const provider = await createDesktopBrowserProvider({
      botId: 'bot-popup-1',
      profileDir: path.join(tmpDir, 'bot-popup-1-profile'),
      maxTabs: 3,
      discoverBrowser: async () => ({
        available: true,
        reason: null,
        detail: null,
        executablePath: '/usr/bin/chromium',
        kind: 'chromium',
        transport: 'pipe',
      }),
      launchBrowser: async () => harness.getHandle(),
    });

    const opened = await provider.perform({
      action: 'open',
      url: 'https://example.com/main',
    });
    const mainPageId = opened.pageId;
    const mainTarget = Array.from(harness.targets.values())[0];

    // Normal web-opened blank popup within cap: tracked, does not steal active page,
    // supports screenshot, security guards, select, and close.
    const popupTarget = harness.spawnTarget('about:blank', {
      openerId: mainTarget.targetId,
    });
    const afterPopup = await provider.perform({ action: 'status' });
    assert.equal(afterPopup.tabs.length, 2);
    assert.equal(afterPopup.pageId, mainPageId);
    const popupTab = afterPopup.tabs.find((t) => t.id !== mainPageId);
    assert.ok(popupTab);
    assert.equal(popupTab.active, false);
    assert.equal(popupTab.url, 'about:blank');

    const popupFrame = await provider.perform({
      action: 'frame',
      pageId: popupTab.id,
      viewer: 'human',
    });
    assert.equal(popupFrame.pageId, popupTab.id);
    assert.equal(popupFrame.mimeType, 'image/jpeg');
    assert.ok(popupFrame.data.length > 0);

    // Same security checks apply once the popup navigates to a sensitive page.
    popupTarget.url = 'https://accounts.google.com/signin';
    popupTarget.title = 'Sign in - Google Accounts';
    harness.emitEvent(
      'Page.frameNavigated',
      { frame: { id: popupTarget.frameId, loaderId: 'loader-signin', url: popupTarget.url } },
      popupTarget.sessionId
    );
    await assert.rejects(() => provider.perform({ action: 'snapshot', pageId: popupTab.id }), {
      code: 'BROWSER_SENSITIVE_PAGE',
    });
    await assert.rejects(
      () => provider.perform({ action: 'frame', pageId: popupTab.id, viewer: 'bot' }),
      { code: 'BROWSER_SENSITIVE_BLOCKED' }
    );

    const selected = await provider.perform({ action: 'select', pageId: popupTab.id });
    assert.equal(selected.pageId, popupTab.id);
    assert.equal(selected.sensitive, true);

    const closedPopup = await provider.perform({ action: 'closeTab', pageId: popupTab.id });
    assert.equal(closedPopup.closed, true);
    assert.equal(closedPopup.tabs.length, 1);
    assert.equal(closedPopup.pageId, mainPageId);

    // Same-context noopener blank popup is tracked and released on targetDestroyed.
    const noopenerTarget = harness.spawnTarget('', { openerId: null });
    const afterNoopener = await provider.perform({ action: 'status' });
    assert.equal(afterNoopener.tabs.length, 2);
    assert.equal(afterNoopener.pageId, mainPageId);

    harness.targets.delete(noopenerTarget.targetId);
    harness.emitEvent('Target.targetDestroyed', { targetId: noopenerTarget.targetId });
    const afterDestroy = await provider.perform({ action: 'status' });
    assert.equal(afterDestroy.tabs.length, 1);
    assert.equal(afterDestroy.pageId, mainPageId);

    // Disallowed popup schemes in the managed context must not run invisibly outside the cap.
    const blocked = harness.spawnTarget('data:text/plain,not-a-web-tab', { openerId: null });
    await provider.perform({ action: 'status' });
    assert.equal(harness.targets.has(blocked.targetId), false);

    // Non-page targets and unmanaged sources are ignored without being closed.
    const closeBeforeIgnored = harness.sentCommands.filter((c) => c.method === 'Target.closeTarget').length;
    harness.spawnTarget('https://example.com/sw.js', { type: 'service_worker' });
    harness.spawnTarget('https://example.com/frame', { type: 'iframe', openerId: mainTarget.targetId });
    harness.spawnTarget('https://example.com/foreign-ctx', { browserContextId: 'ctx-other' });
    harness.spawnTarget('https://example.com/foreign-opener', { openerId: 'target-unmanaged' });
    harness.spawnTarget('devtools://devtools/bundled/inspector.html', { openerId: null });

    const afterIgnored = await provider.perform({ action: 'status' });
    assert.equal(afterIgnored.tabs.length, 1);
    assert.equal(afterIgnored.pageId, mainPageId);
    const closeAfterIgnored = harness.sentCommands.filter((c) => c.method === 'Target.closeTarget').length;
    assert.equal(closeAfterIgnored, closeBeforeIgnored);

    await provider.close();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('desktop provider closes over-cap popups and handles parallel popups, explicit open race, and attach failure cleanly', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'pibot-desktop-popup-cap-'));
  const harness = createMockBrowserHarness({ emitTargetCreatedBeforeCreateReply: true });

  try {
    const provider = await createDesktopBrowserProvider({
      botId: 'bot-popup-2',
      profileDir: path.join(tmpDir, 'bot-popup-2-profile'),
      maxTabs: 2,
      discoverBrowser: async () => ({
        available: true,
        reason: null,
        detail: null,
        executablePath: '/usr/bin/chromium',
        kind: 'chromium',
        transport: 'pipe',
      }),
      launchBrowser: async () => harness.getHandle(),
    });

    const opened = await provider.perform({
      action: 'open',
      url: 'https://example.com/main',
    });
    const mainPageId = opened.pageId;
    const mainTarget = Array.from(harness.targets.values())[0];

    // Attach failure releases its reserved slot without leaving a ghost tab.
    const failTarget = harness.spawnTarget('https://example.com/fail-attach', {
      openerId: mainTarget.targetId,
      emit: false,
    });
    harness.failAttachTargetIds.add(failTarget.targetId);
    harness.emitEvent('Target.targetCreated', {
      targetInfo: harness.buildTargetInfo(failTarget),
    });
    const afterFail = await provider.perform({ action: 'status' });
    assert.equal(afterFail.tabs.length, 1);
    assert.equal(harness.targets.has(failTarget.targetId), false);
    assert.equal(afterFail.pageId, mainPageId);

    // Parallel popups when 1 slot remains: first attaches, second is genuinely closed via Target.closeTarget.
    const keepTarget = harness.spawnTarget('https://example.com/popup-keep', {
      openerId: mainTarget.targetId,
    });
    const overTarget = harness.spawnTarget('https://example.com/popup-over', {
      openerId: mainTarget.targetId,
    });

    const afterParallel = await provider.perform({ action: 'status' });
    assert.equal(afterParallel.tabs.length, 2);
    assert.equal(afterParallel.pageId, mainPageId);
    assert.equal(harness.targets.has(keepTarget.targetId), true);
    assert.equal(harness.targets.has(overTarget.targetId), false);
    assert.ok(
      harness.sentCommands.some(
        (c) => c.method === 'Target.closeTarget' && c.params?.targetId === overTarget.targetId
      )
    );

    // Additional popup while already at cap is also closed.
    const overTarget2 = harness.spawnTarget('https://example.com/popup-over-2', {
      openerId: mainTarget.targetId,
    });
    const afterOver2 = await provider.perform({ action: 'status' });
    assert.equal(afterOver2.tabs.length, 2);
    assert.equal(harness.targets.has(overTarget2.targetId), false);
    assert.ok(
      harness.sentCommands.some(
        (c) => c.method === 'Target.closeTarget' && c.params?.targetId === overTarget2.targetId
      )
    );

    // Explicit open racing with Target.targetCreated (own target + concurrent noopener popup)
    // neither double-counts nor misses closing the over-cap popup.
    const keepTab = afterOver2.tabs.find((t) => t.id !== mainPageId);
    await provider.perform({ action: 'closeTab', pageId: keepTab.id });

    let concurrentNoopener = null;
    harness.setOnCreateTarget(() => {
      harness.setOnCreateTarget(null);
      concurrentNoopener = harness.spawnTarget('https://example.com/concurrent-noopener', {
        openerId: null,
      });
    });

    const explicitOpened = await provider.perform({
      action: 'open',
      url: 'https://example.com/explicit',
    });
    const finalStatus = await provider.perform({ action: 'status' });
    assert.equal(finalStatus.tabs.length, 2);
    assert.equal(finalStatus.pageId, explicitOpened.pageId);
    assert.equal(finalStatus.url, 'https://example.com/explicit');
    assert.ok(concurrentNoopener);
    assert.equal(harness.targets.has(concurrentNoopener.targetId), false);
    assert.ok(
      harness.sentCommands.some(
        (c) => c.method === 'Target.closeTarget' && c.params?.targetId === concurrentNoopener.targetId
      )
    );

    await provider.close();
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('desktop provider retains retry capability after transient startup failure and preserves hard profile failure', async () => {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'pibot-desktop-retry-'));
  try {
    for (const failureCode of ['BROWSER_START_FAILED', 'BROWSER_PROFILE_UNWRITABLE']) {
      const harness = createMockBrowserHarness();
      let launches = 0;
      const provider = await createDesktopBrowserProvider({
        botId: 'bot-retry', profileDir: path.join(tmpDir, failureCode),
        discoverBrowser: async () => ({ available: true, executablePath: '/usr/bin/chromium', kind: 'chromium', transport: 'pipe' }),
        launchBrowser: async () => {
          if (++launches === 1) throw Object.assign(new Error('Original startup diagnostic'), { code: failureCode });
          return harness.getHandle();
        },
      });
      try {
        await assert.rejects(provider.perform({ action: 'open' }), { code: failureCode });
        const status = await provider.perform({ action: 'status' });
        assert.equal(status.backend.running, false);
        assert.equal(status.detail, 'Original startup diagnostic');
        assert.equal(status.canStreamInteract, failureCode === 'BROWSER_START_FAILED');
        assert.equal(status.available, failureCode === 'BROWSER_START_FAILED');
        assert.equal(launches, 1);
        if (failureCode === 'BROWSER_START_FAILED') {
          await provider.perform({ action: 'open' });
          assert.equal(launches, 2);
          assert.equal((await provider.perform({ action: 'status' })).reason, undefined);
        }
      } finally {
        await provider.close();
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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

    // The final paint is often the second CDP frame after a click, with no later repaint.
    fakeNow += 100;
    const prevData = Buffer.from('paint-before-click').toString('base64');
    harness.emitEvent(
      'Page.screencastFrame',
      { data: prevData, sessionId: 77, metadata: { deviceWidth: 1280, deviceHeight: 800 } },
      targetState.sessionId
    );
    const prevFrame = await provider.perform({ action: 'frame', pageId, viewer: 'human', afterSeq: frame.seq });
    assert.equal(prevFrame.data, prevData);
    fakeNow += 13;
    const liveData = Buffer.from('paint-after-click').toString('base64');
    harness.emitEvent(
      'Page.screencastFrame',
      { data: liveData, sessionId: 78, metadata: { deviceWidth: 1280, deviceHeight: 800 } },
      targetState.sessionId
    );
    const liveFrame = await provider.perform({
      action: 'frame',
      pageId,
      viewer: 'human',
      afterSeq: prevFrame.seq,
    });
    assert.equal(liveFrame.data, liveData);
    assert.ok(liveFrame.seq > prevFrame.seq);
    assert.ok(targetState.screencastAcks.includes(77));
    assert.ok(targetState.screencastAcks.includes(78));

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

async function openFrameTestBrowser(t, harness) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'pibot-desktop-frame-'));
  let provider;
  t.after(async () => {
    try {
      await provider?.close();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
  provider = await createDesktopBrowserProvider({
    botId: 'bot-frame',
    profileDir: path.join(tmpDir, 'profile'),
    discoverBrowser: async () => ({
      available: true, executablePath: '/usr/bin/chromium', kind: 'chromium', transport: 'pipe',
    }),
    launchBrowser: async () => harness.getHandle(),
  });
  const opened = await provider.perform({ action: 'open', url: 'https://example.com' });
  const target = [...harness.targets.values()].find((page) => page.url === opened.url);
  assert.ok(target?.sessionId);
  return { provider, opened, cdpSessionId: target.sessionId };
}

test('desktop provider dispatches human input during fallback capture and keeps the stream usable', async (t) => {
  let replyToScreenshot;
  const harness = createMockBrowserHarness({
    onCaptureScreenshot(reply) { replyToScreenshot = reply; },
  });
  const { provider, opened, cdpSessionId } = await openFrameTestBrowser(t, harness);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const frameRequest = {
    action: 'frame', pageId: opened.pageId, viewer: 'human', stream: true, afterSeq: 0, waitMs: 10,
  };
  const capture = provider.perform(frameRequest);
  await nextEventLoopTurn();
  t.mock.timers.tick(frameRequest.waitMs);
  const waiting = Symbol('waiting');
  assert.equal(await Promise.race([capture, nextEventLoopTurn(waiting)]), waiting);
  assert.equal(typeof replyToScreenshot, 'function', 'the fallback screenshot is in flight');

  const input = await Promise.race([
    provider.perform({
      action: 'input', pageId: opened.pageId, revision: opened.revision,
      event: { kind: 'click', x: 0.5, y: 0.5 },
    }),
    nextEventLoopTurn(waiting),
  ]);
  assert.equal(input?.ok, true, 'the click completes with the screenshot reply still held');
  assert.ok(harness.sentCommands.some((command) =>
    command.sessionId === cdpSessionId && command.method === 'Input.dispatchMouseEvent' &&
    command.params.type === 'mousePressed'
  ));

  replyToScreenshot();
  assert.deepEqual(await capture, { frameUnchanged: true, pageId: opened.pageId });

  const nextFrame = provider.perform(frameRequest);
  assert.equal(await Promise.race([nextFrame, nextEventLoopTurn(waiting)]), waiting);
  const data = Buffer.from('paint-after-manual-input').toString('base64');
  harness.emitEvent('Page.screencastFrame', { data, sessionId: 81 }, cdpSessionId);
  assert.equal((await Promise.race([nextFrame, nextEventLoopTurn(waiting)]))?.data, data);
});

test('desktop provider wakes a stream cursor on a repaint before the bounded wait expires', async (t) => {
  const harness = createMockBrowserHarness();
  const { provider, opened, cdpSessionId } = await openFrameTestBrowser(t, harness);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });

  const frameRequest = {
    action: 'frame', pageId: opened.pageId, viewer: 'human', stream: true, waitMs: 1000,
  };
  const waiting = Symbol('waiting');
  const first = provider.perform({ ...frameRequest, afterSeq: 0 });
  assert.equal(await Promise.race([first, nextEventLoopTurn(waiting)]), waiting);
  const oldData = Buffer.from('previous-screencast-paint').toString('base64');
  harness.emitEvent('Page.screencastFrame', { data: oldData, sessionId: 91 }, cdpSessionId);
  const previous = await Promise.race([first, nextEventLoopTurn(waiting)]);
  assert.equal(previous?.data, oldData);
  assert.ok(previous.captureSeq > 0);

  const nextFrame = provider.perform({ ...frameRequest, afterSeq: previous.captureSeq });
  assert.equal(await Promise.race([nextFrame, nextEventLoopTurn(waiting)]), waiting);
  t.mock.timers.tick(250);
  assert.equal(await Promise.race([nextFrame, nextEventLoopTurn(waiting)]), waiting);

  const newData = Buffer.from('new-screencast-paint').toString('base64');
  harness.emitEvent('Page.screencastFrame', { data: newData, sessionId: 92 }, cdpSessionId);
  const updated = await Promise.race([nextFrame, nextEventLoopTurn(waiting)]);
  assert.equal(updated?.data, newData, 'the CDP repaint resolves the pending request without advancing the clock');
  assert.ok(updated.captureSeq > previous.captureSeq);
  assert.equal(harness.sentCommands.some((command) => command.method === 'Page.captureScreenshot'), false);
});
