import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeNativeRequest,
  normalizeNativeResultFrame,
  ANDROID_BROWSER_ERROR_CODES,
} from '../../host-core/android-bridge-protocol.js';
import {
  createAndroidBrowserProvider,
  classifyAndroidBrowserUrl,
  normalizeAndroidBrowserInputEvent,
  normalizeAndroidBrowserAct,
} from '../../host-core/bot-browser/android-provider.js';

test('android-bridge-protocol accepts valid bot_browser frames and rejects unknown fields or agent input', () => {
  const normalized = normalizeNativeRequest({
    tool: 'bot_browser',
    actor: {
      deviceId: 'dev-1',
      botId: 'bot-alpha',
      conversationId: 'browser:bot-alpha',
      scopeId: null,
      kind: 'primary',
    },
    taskId: 'human:11111111-2222-3333-4444-555555555555',
    arguments: {
      action: 'input',
      source: 'human',
      pageId: 'p-1',
      revision: 3,
      event: { kind: 'click', x: 0.25, y: 0.75 },
    },
  });
  assert.equal(normalized.tool, 'bot_browser');
  assert.equal(normalized.context.botId, 'bot-alpha');
  assert.equal(normalized.arguments.action, 'input');

  assert.throws(() => normalizeNativeRequest({
    tool: 'bot_browser',
    actor: {
      deviceId: 'dev-1',
      botId: 'bot-alpha',
      conversationId: 'browser:bot-alpha',
      scopeId: null,
      kind: 'primary',
    },
    taskId: 'agent:11111111-2222-3333-4444-555555555555',
    arguments: {
      action: 'input',
      source: 'agent',
      event: { kind: 'click', x: 0.5, y: 0.5 },
    },
  }), /source 'human'/);

  assert.throws(() => normalizeNativeRequest({
    tool: 'bot_browser',
    actor: {
      deviceId: 'dev-1',
      botId: 'bot-alpha',
      conversationId: 'browser:bot-alpha',
      scopeId: null,
      kind: 'primary',
    },
    taskId: 'human:11111111-2222-3333-4444-555555555555',
    arguments: {
      action: 'status',
      source: 'human',
      eval: 'document.cookie',
    },
  }), /unknown field/);

  for (const code of ANDROID_BROWSER_ERROR_CODES) {
    const parsed = normalizeNativeResultFrame({
      type: 'native_result',
      id: 'call-1',
      error: { code, message: 'classified error' },
    });
    assert.equal(parsed.error.code, code);
  }
});

test('createAndroidBrowserProvider honestly reports unavailable when nativeBridge is absent', async () => {
  const provider = await createAndroidBrowserProvider({ botId: 'bot-1', deviceId: 'dev-1' });
  const status = await provider.perform({ action: 'status', botId: 'bot-1' });
  assert.equal(status.available, false);
  assert.equal(status.canStreamInteract, false);
  assert.equal(status.platform, 'android');
  assert.equal(status.fallbackMode, 'guide-browser');
  assert.equal(status.externalBrowserRecommendedForSetup, true);
  assert.deepEqual(status.tabs, []);

  await assert.rejects(
    () => provider.perform({ action: 'open', botId: 'bot-1', url: 'https://example.com' }),
    (err) => err.code === 'BROWSER_UNAVAILABLE' && err.requiresSystemBrowser === true,
  );
  await provider.close();
});

test('createAndroidBrowserProvider enforces per-bot ownership, blocks Google OAuth, and proxies real actions', async () => {
  const calls = [];
  const nativeBridge = async (request) => {
    const validated = normalizeNativeRequest(request);
    calls.push(validated);
    const { action } = validated.arguments;
    if (action === 'status') {
      return {
        available: true,
        canStreamInteract: true,
        profileIsolation: 'webview-multi-profile',
        sessionId: 'sess-1',
        pageId: 'p-1',
        revision: 2,
        tabs: [{ id: 'p-1', title: 'Example', url: 'https://example.com' }],
        sensitive: false,
      };
    }
    if (action === 'open' || action === 'navigate' || action === 'input' || action === 'act') {
      return {
        ok: true,
        available: true,
        canStreamInteract: true,
        profileIsolation: 'webview-multi-profile',
        sessionId: 'sess-1',
        pageId: 'p-1',
        revision: 3,
        tabs: [{ id: 'p-1', title: 'Console', url: 'https://console.cloud.google.com/apis/enableflow' }],
        sensitive: false,
      };
    }
    if (action === 'frame') {
      return {
        seq: 1,
        mimeType: 'image/jpeg',
        data: 'AAAA',
        width: 960,
        height: 640,
        imageWidth: 960,
        imageHeight: 640,
        revision: 3,
        pageId: 'p-1',
        sensitive: false,
      };
    }
    if (action === 'release') {
      return {
        available: true,
        canStreamInteract: true,
        profileIsolation: 'webview-multi-profile',
        sessionId: null,
        pageId: null,
        revision: 4,
        tabs: [],
        sensitive: false,
      };
    }
    throw new Error(`unexpected action ${action}`);
  };

  const provider = await createAndroidBrowserProvider({
    botId: 'bot-a',
    deviceId: 'dev-1',
    nativeBridge,
  });

  // Cross-bot mismatch rejected before hitting bridge.
  await assert.rejects(
    () => provider.perform({ action: 'status', botId: 'bot-b' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.equal(calls.length, 0);

  // Google OAuth and unsafe schemes blocked before hitting bridge.
  await assert.rejects(
    () => provider.perform({
      action: 'open',
      botId: 'bot-a',
      url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc',
    }),
    (err) => err.code === 'BROWSER_SENSITIVE_BLOCKED' && err.requiresSystemBrowser === true,
  );
  await assert.rejects(
    () => provider.perform({ action: 'navigate', botId: 'bot-a', url: 'file:///etc/hosts' }),
    (err) => err.code === 'BROWSER_NAVIGATION_BLOCKED',
  );
  assert.equal(calls.length, 0);

  // Normal open, frame, act, and human takeover input succeed with validated protocol frames.
  const opened = await provider.perform({
    action: 'open',
    botId: 'bot-a',
    url: 'https://console.cloud.google.com/apis/enableflow',
  });
  assert.equal(opened.available, true);
  assert.equal(opened.pageId, 'p-1');

  const frame = await provider.perform({
    action: 'frame',
    botId: 'bot-a',
    pageId: 'p-1',
    source: 'human',
  });
  assert.equal(frame.seq, 1);
  assert.equal(frame.mimeType, 'image/jpeg');
  assert.equal(frame.data, 'AAAA');

  const acted = await provider.perform({
    action: 'act',
    botId: 'bot-a',
    pageId: 'p-1',
    revision: 3,
    act: { kind: 'click', ref: 'e1' },
  });
  assert.equal(acted.ok, true);

  await assert.rejects(
    () => provider.perform({
      action: 'input',
      botId: 'bot-a',
      source: 'agent',
      pageId: 'p-1',
      event: { kind: 'click', x: 0.5, y: 0.5 },
    }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );

  const tapped = await provider.perform({
    action: 'input',
    botId: 'bot-a',
    pageId: 'p-1',
    revision: 3,
    event: { kind: 'click', x: 0.4, y: 0.6 },
  });
  assert.equal(tapped.ok, true);

  await provider.close();
  assert.equal(calls.at(-1).arguments.action, 'release');
});

test('URL classifier and input/act normalizers enforce strict bounds', () => {
  assert.equal(
    classifyAndroidBrowserUrl('https://center.example.com/api/oauth/google/callback?code=1').sensitivity,
    'blocked_external_auth',
  );
  assert.equal(
    classifyAndroidBrowserUrl('https://myaccount.google.com/connections').sensitivity,
    'secret_shield',
  );
  assert.deepEqual(
    normalizeAndroidBrowserInputEvent({ kind: 'click', x: 0.1, y: 0.9 }),
    { kind: 'click', x: 0.1, y: 0.9 },
  );
  assert.throws(
    () => normalizeAndroidBrowserInputEvent({ kind: 'click', x: 1.2, y: 0.5 }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'eval', code: 'alert(1)' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
});
