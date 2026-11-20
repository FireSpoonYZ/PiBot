import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeNativeRequest,
  normalizeNativeResultFrame,
  ANDROID_BROWSER_ERROR_CODES,
} from '../../host-core/android-bridge-protocol.js';
import {
  ANDROID_BROWSER_MAX_SNAPSHOT_REFS,
  ANDROID_BROWSER_MAX_SNAPSHOT_TEXT_BYTES,
  ANDROID_BROWSER_MAX_TEXT_SUMMARY_CHARS,
  createAndroidBrowserProvider,
  classifyAndroidBrowserUrl,
  normalizeAndroidBrowserInputEvent,
  normalizeAndroidBrowserAct,
} from '../../host-core/bot-browser/android-provider.js';
import {
  classifyPageSensitivity,
  mergeProviderHints,
  sanitizeSnapshotForBot,
} from '../../host-core/bot-browser/policy.js';
import { createBotBrowserService } from '../../host-core/bot-browser/service.js';

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

test('a sent native call with no confirmed outcome stays distinguishable from a rejected input', async () => {
  const provider = createAndroidBrowserProvider({
    botId: 'bot', deviceId: 'device',
    nativeBridge: async () => { throw Object.assign(new Error('Native call not confirmed'), { code: 'ANDROID_NATIVE_UNCONFIRMED' }); },
  });
  await assert.rejects(provider.perform({ action: 'input', event: { kind: 'text', text: 'example' } }),
    { code: 'BROWSER_ACTION_UNCONFIRMED', outcome: 'unconfirmed' });
  await provider.close();
});

test('normalizeAndroidBrowserAct preserves wait conditions, rejects networkidle/eval/invalid state, and keeps delay-only compatibility', () => {
  // Multi-condition public contract (including service.js formatProviderAct dual timeoutMs/ms).
  assert.deepEqual(
    normalizeAndroidBrowserAct({
      kind: 'wait',
      selector: '#spinner',
      state: 'hidden',
      text: 'Loaded',
      url: 'https://example.com/done',
      load: 'domcontentloaded',
      timeoutMs: 8000,
      ms: 8000,
    }),
    {
      kind: 'wait',
      selector: '#spinner',
      state: 'hidden',
      text: 'Loaded',
      url: 'https://example.com/done',
      load: 'domcontentloaded',
      timeoutMs: 8000,
    },
  );

  assert.deepEqual(
    normalizeAndroidBrowserAct({ kind: 'wait', selector: '#ready', load: 'load' }),
    { kind: 'wait', selector: '#ready', load: 'load' },
  );

  // networkidle cannot be reliably supported on Android WebView -> explicit BROWSER_UNSUPPORTED.
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', load: 'networkidle', timeoutMs: 2000 }),
    (err) => err.code === 'BROWSER_UNSUPPORTED',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', selector: '#ok', load: 'networkidle' }),
    (err) => err.code === 'BROWSER_UNSUPPORTED',
  );

  // state without selector, eval/fn fields, and invalid bounds are rejected.
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', state: 'hidden' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', fn: '() => true' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', eval: 'document.title' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', ref: 'e1' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', selector: '#ok', timeoutMs: 10 }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'wait', selector: '#ok', timeoutMs: 20000 }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );

  // Delay-only compatibility.
  assert.deepEqual(normalizeAndroidBrowserAct({ kind: 'wait' }), { kind: 'wait', ms: 300 });
  assert.deepEqual(normalizeAndroidBrowserAct({ kind: 'wait', ms: 250 }), { kind: 'wait', ms: 250 });
  assert.deepEqual(normalizeAndroidBrowserAct({ kind: 'wait', ms: 0 }), { kind: 'wait', ms: 0 });
  assert.deepEqual(
    normalizeAndroidBrowserAct({ kind: 'wait', timeoutMs: 600, ms: 600 }),
    { kind: 'wait', timeoutMs: 600 },
  );
});

test('normalizeAndroidBrowserAct and provider support ref-less public type and forward wait conditions without borrowing human input', async () => {
  assert.deepEqual(
    normalizeAndroidBrowserAct({ kind: 'type', text: 'hello world' }),
    { kind: 'type', text: 'hello world' },
  );
  assert.deepEqual(
    normalizeAndroidBrowserAct({ kind: 'type', ref: 'e2', text: 'abc' }),
    { kind: 'type', ref: 'e2', text: 'abc' },
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'type', text: '' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'type' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'type', text: 'bad\0text' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(
    () => normalizeAndroidBrowserAct({ kind: 'type', ref: 'bad', text: 'abc' }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );

  const calls = [];
  const provider = await createAndroidBrowserProvider({
    botId: 'bot-a',
    deviceId: 'dev-1',
    nativeBridge: async (request) => {
      const validated = normalizeNativeRequest(request);
      calls.push(validated);
      return {
        ok: true,
        available: true,
        canStreamInteract: true,
        profileIsolation: 'webview-multi-profile',
        sessionId: 'sess-1',
        pageId: 'p-1',
        revision: 4,
        tabs: [{ id: 'p-1', title: 'Form', url: 'https://example.com/form' }],
        sensitive: false,
      };
    },
  });

  const typed = await provider.perform({
    action: 'act',
    botId: 'bot-a',
    pageId: 'p-1',
    act: { kind: 'type', text: 'PiBot-App' },
  });
  assert.equal(typed.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.action, 'act');
  assert.equal(calls[0].arguments.source, 'agent');
  assert.deepEqual(calls[0].arguments.act, { kind: 'type', text: 'PiBot-App' });

  const waited = await provider.perform({
    action: 'act',
    botId: 'bot-a',
    pageId: 'p-1',
    act: {
      kind: 'wait',
      selector: '#done',
      state: 'visible',
      text: 'Saved',
      url: 'https://example.com/done',
      load: 'load',
      timeoutMs: 4000,
      ms: 4000,
    },
  });
  assert.equal(waited.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].arguments.action, 'act');
  assert.equal(calls[1].arguments.source, 'agent');
  assert.deepEqual(calls[1].arguments.act, {
    kind: 'wait',
    selector: '#done',
    state: 'visible',
    text: 'Saved',
    url: 'https://example.com/done',
    load: 'load',
    timeoutMs: 4000,
  });

  await assert.rejects(
    () => provider.perform({
      action: 'act',
      botId: 'bot-a',
      pageId: 'p-1',
      act: { kind: 'wait', load: 'networkidle', timeoutMs: 2000 },
    }),
    (err) => err.code === 'BROWSER_UNSUPPORTED',
  );
  assert.equal(calls.length, 2);

  await provider.close();
});

test('android snapshot normalization emits compact ref/role/label snapshot + structured refs, redacts form values and link secrets, and feeds shared sanitizer', async () => {
  const nativeBridge = async (request) => {
    const validated = normalizeNativeRequest(request);
    const { action } = validated.arguments;
    if (action === 'snapshot') {
      return {
        pageId: 'p-1',
        revision: 5,
        url: 'https://example.com/setup?project=demo&access_token=top-secret-url-tok&tab=1#id_token=frag-jwt',
        title: 'Setup Console https://user:secretpass@example.com/t?token=title-tok',
        loading: false,
        canGoBack: true,
        canGoForward: false,
        sensitive: false,
        requiresHumanTakeover: false,
        requiresSystemBrowser: false,
        interactive: [
          {
            ref: 'e1',
            tag: 'input',
            role: '',
            type: 'text',
            autocomplete: '',
            name: 'app_name',
            ariaLabel: 'App name',
            text: '',
            value: 'private-form-draft-value',
            placeholder: 'Enter app name',
            checked: false,
            disabled: false,
            href: '',
            rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.08 },
          },
          {
            ref: 'e2',
            tag: 'input',
            role: '',
            type: 'checkbox',
            autocomplete: '',
            name: 'newsletter',
            ariaLabel: 'Enable status emails',
            text: '',
            value: 'on',
            placeholder: '',
            checked: true,
            disabled: false,
            href: '',
            rect: { x: 0.1, y: 0.35, width: 0.05, height: 0.05 },
          },
          {
            ref: 'e3',
            tag: 'a',
            role: '',
            type: '',
            autocomplete: '',
            name: '',
            ariaLabel: '',
            text: 'Callback Docs',
            value: '',
            placeholder: '',
            checked: false,
            disabled: false,
            href: 'https://docs.example.com/cb?code=auth-code-99&api_key=key-88&lang=en#refresh_token=ref-77',
            rect: { x: 0.1, y: 0.5, width: 0.2, height: 0.05 },
          },
          {
            ref: 'e4',
            tag: 'a',
            role: '',
            type: '',
            autocomplete: '',
            name: '',
            ariaLabel: '',
            text: 'Unsafe Link',
            value: '',
            placeholder: '',
            checked: false,
            disabled: false,
            href: 'javascript:alert(1)',
            rect: { x: 0.1, y: 0.6, width: 0.2, height: 0.05 },
          },
          {
            ref: 'e5',
            tag: 'button',
            role: '',
            type: 'submit',
            autocomplete: '',
            name: '',
            ariaLabel: '',
            text: 'Save',
            value: '',
            placeholder: '',
            checked: false,
            disabled: true,
            href: '',
            rect: { x: 0.1, y: 0.7, width: 0.2, height: 0.08 },
          },
          { ref: 'e1', tag: 'button', text: 'Duplicate Ref' },
          { ref: 'bad-ref', tag: 'button', text: 'Invalid Ref' },
        ],
        textSummary: 'Welcome to setup. Callback link: https://alice:hunter2@example.com/done?client_secret=cs-55&page=2#token=frag-66.',
        truncated: false,
      };
    }
    if (action === 'release') {
      return { available: true, canStreamInteract: true, tabs: [], revision: 6 };
    }
    throw new Error(`unexpected action ${action}`);
  };

  const provider = await createAndroidBrowserProvider({
    botId: 'bot-a',
    deviceId: 'dev-1',
    nativeBridge,
  });

  const snap = await provider.perform({ action: 'snapshot', botId: 'bot-a', pageId: 'p-1' });
  assert.equal(snap.pageId, 'p-1');
  assert.equal(snap.revision, 5);
  assert.equal(snap.loading, false);
  assert.equal(snap.canGoBack, true);
  assert.equal(snap.canGoForward, false);
  assert.equal(snap.sensitive, false);
  assert.equal(snap.truncated, false);
  assert.equal(snap.url, 'https://example.com/setup?project=demo&access_token=%5Bredacted%5D&tab=1');

  // Snapshot uses compact shared line format rather than raw JSON.stringify.
  assert.equal(typeof snap.snapshot, 'string');
  assert.equal(snap.snapshot.trim().startsWith('{'), false);
  assert.equal(snap.snapshot.includes('"interactive"'), false);
  assert.equal(snap.snapshot.includes('"rect"'), false);
  assert.match(snap.snapshot, /\[e1\] textbox "App name"/);
  assert.match(snap.snapshot, /\[e2\] checkbox "Enable status emails" \[checked\]/);
  assert.match(snap.snapshot, /\[e3\] link "Callback Docs"/);
  assert.match(snap.snapshot, /\[e5\] button "Save" \[disabled\]/);
  assert.match(snap.snapshot, /text "Welcome to setup\. Callback link: https:\/\/example\.com\/done\?client_secret=%5Bredacted%5D&page=2\."/);

  // Structured refs are populated without raw form values.
  assert.equal(snap.refs.length, 5);
  assert.deepEqual(snap.refs[0], {
    ref: 'e1',
    role: 'textbox',
    name: 'app_name',
    label: 'App name',
    ariaLabel: 'App name',
    placeholder: 'Enter app name',
    inputType: 'text',
  });
  assert.equal('value' in snap.refs[0], false);
  assert.equal(snap.refs[1].checked, true);
  assert.equal(snap.refs[4].disabled, true);

  // Backward-compatible non-sensitive fields remain available, pre-sanitized.
  assert.equal(snap.interactive.length, 5);
  assert.equal(snap.interactive[0].tag, 'input');
  assert.equal('value' in snap.interactive[0], false);
  assert.equal(snap.interactive[0].rect.x, 0.1);
  assert.equal(
    snap.interactive[2].href,
    'https://docs.example.com/cb?code=%5Bredacted%5D&api_key=%5Bredacted%5D&lang=en',
  );
  assert.equal(snap.interactive[3].href, '');
  assert.equal(
    snap.textSummary,
    'Welcome to setup. Callback link: https://example.com/done?client_secret=%5Bredacted%5D&page=2.',
  );

  // Raw form values, embedded URL credentials, link secrets, and javascript: never leak.
  const serialized = JSON.stringify(snap);
  for (const forbidden of [
    'private-form-draft-value',
    'top-secret-url-tok',
    'frag-jwt',
    'secretpass',
    'title-tok',
    'auth-code-99',
    'key-88',
    'ref-77',
    'javascript:alert',
    'hunter2',
    'cs-55',
    'frag-66',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `snapshot must not leak ${forbidden}`);
  }

  // Shared sanitizer consumes snapshot + refs cleanly.
  const sensitivity = classifyPageSensitivity({
    url: snap.url,
    title: snap.title,
    hints: mergeProviderHints(snap),
    providerSensitive: snap.sensitive,
  });
  const sanitized = sanitizeSnapshotForBot(snap, sensitivity);
  assert.equal(sanitized.blocked, false);
  assert.equal(sanitized.truncated, false);
  assert.match(sanitized.text, /\[e1\] textbox "App name"/);
  assert.match(sanitized.text, /Welcome to setup\./);
  assert.equal(sanitized.refMap.size, 5);
  assert.equal(sanitized.refMap.get('e1')?.role, 'textbox');
  assert.equal(sanitized.refMap.get('e1')?.ariaLabel, 'App name');
  assert.equal(sanitized.refMap.get('e5')?.role, 'button');

  // interactive: true omits summary text; urls: true appends only sanitized http(s) hrefs.
  const interactiveSnap = await provider.perform({
    action: 'snapshot',
    botId: 'bot-a',
    pageId: 'p-1',
    interactive: true,
    urls: true,
  });
  assert.equal(interactiveSnap.snapshot.includes('Welcome to setup.'), false);
  assert.match(
    interactiveSnap.snapshot,
    /\[e3\] link "Callback Docs" url="https:\/\/docs\.example\.com\/cb\?code=%5Bredacted%5D&api_key=%5Bredacted%5D&lang=en"/,
  );
  assert.equal(interactiveSnap.snapshot.includes('javascript:'), false);
  assert.equal(interactiveSnap.snapshot.includes('auth-code-99'), false);

  await provider.close();
});

test('android snapshot normalization enforces ref and UTF-8 byte bounds with truncated flag', async () => {
  const manyInteractive = Array.from({ length: 100 }, (_, i) => ({
    ref: `e${i + 1}`,
    tag: 'button',
    text: `Action Button ${i + 1}`,
    value: `draft-${i + 1}`,
  }));
  const hugeSummary = 'Page content segment. '.repeat(600);

  const nativeBridge = async (request) => {
    const validated = normalizeNativeRequest(request);
    if (validated.arguments.action === 'snapshot') {
      return {
        pageId: 'p-bound',
        revision: 1,
        url: 'https://example.com/long',
        title: 'Long Page',
        sensitive: false,
        interactive: manyInteractive,
        textSummary: hugeSummary,
        truncated: false,
      };
    }
    throw new Error(`unexpected action ${validated.arguments.action}`);
  };

  const provider = await createAndroidBrowserProvider({
    botId: 'bot-a',
    deviceId: 'dev-1',
    nativeBridge,
  });

  const snap = await provider.perform({ action: 'snapshot', botId: 'bot-a', pageId: 'p-bound' });
  assert.equal(snap.truncated, true);
  assert.ok(snap.refs.length <= ANDROID_BROWSER_MAX_SNAPSHOT_REFS);
  assert.equal(snap.refs.length, ANDROID_BROWSER_MAX_SNAPSHOT_REFS);
  assert.equal(snap.interactive.length, snap.refs.length);
  assert.ok(Buffer.byteLength(snap.snapshot, 'utf8') <= ANDROID_BROWSER_MAX_SNAPSHOT_TEXT_BYTES);
  assert.ok(snap.textSummary.length <= ANDROID_BROWSER_MAX_TEXT_SUMMARY_CHARS);
  assert.equal(JSON.stringify(snap).includes('draft-1'), false);

  const sanitized = sanitizeSnapshotForBot(
    snap,
    classifyPageSensitivity({ url: snap.url, title: snap.title, providerSensitive: snap.sensitive }),
  );
  assert.equal(sanitized.blocked, false);
  assert.equal(sanitized.truncated, true);
  assert.equal(sanitized.refMap.size, snap.refs.length);

  await provider.close();
});

test('android snapshot normalization pre-redacts and withholds secret leaks and sensitive native pages', async () => {
  let reply;
  const nativeBridge = async (request) => {
    const validated = normalizeNativeRequest(request);
    if (validated.arguments.action === 'snapshot') return reply;
    throw new Error(`unexpected action ${validated.arguments.action}`);
  };

  const provider = await createAndroidBrowserProvider({
    botId: 'bot-a',
    deviceId: 'dev-1',
    nativeBridge,
  });

  // 1. Secret leak in textSummary even when native claims sensitive: false.
  reply = {
    pageId: 'p-1',
    revision: 2,
    url: 'https://example.com/credentials-view?tab=1&token=url-tok',
    title: 'Credentials',
    sensitive: false,
    interactive: [{ ref: 'e1', tag: 'button', text: 'Copy' }],
    textSummary: 'Your client secret is GOCSPX-1234567890abcdef',
    truncated: false,
  };
  const leakedTextSnap = await provider.perform({ action: 'snapshot', botId: 'bot-a', pageId: 'p-1' });
  assert.equal(leakedTextSnap.sensitive, true);
  assert.equal(leakedTextSnap.snapshot, '');
  assert.deepEqual(leakedTextSnap.refs, []);
  assert.deepEqual(leakedTextSnap.interactive, []);
  assert.equal(leakedTextSnap.textSummary, '');
  assert.equal(leakedTextSnap.title, '');
  assert.equal(leakedTextSnap.url, 'https://example.com/credentials-view');
  assert.equal(JSON.stringify(leakedTextSnap).includes('GOCSPX-1234567890abcdef'), false);
  assert.equal(JSON.stringify(leakedTextSnap).includes('url-tok'), false);

  const leakedTextSanitized = sanitizeSnapshotForBot(
    leakedTextSnap,
    classifyPageSensitivity({
      url: leakedTextSnap.url,
      title: leakedTextSnap.title,
      hints: mergeProviderHints(leakedTextSnap),
      providerSensitive: leakedTextSnap.sensitive,
    }),
  );
  assert.equal(leakedTextSanitized.blocked, true);
  assert.equal(leakedTextSanitized.code, 'BROWSER_SECRET_STEP_BLOCKED');
  assert.equal(leakedTextSanitized.fallbackToSystemBrowser, true);

  // 2. Secret credential sitting inside an input raw form value.
  reply = {
    pageId: 'p-1',
    revision: 3,
    url: 'https://example.com/token-form',
    title: 'Token form',
    sensitive: false,
    interactive: [
      {
        ref: 'e1',
        tag: 'input',
        type: 'text',
        ariaLabel: 'Access token',
        value: 'ya29.a0AfH6SM1234567890abcdef123456',
      },
    ],
    textSummary: 'Token configuration form.',
    truncated: false,
  };
  const leakedValueSnap = await provider.perform({ action: 'snapshot', botId: 'bot-a', pageId: 'p-1' });
  assert.equal(leakedValueSnap.sensitive, true);
  assert.equal(leakedValueSnap.snapshot, '');
  assert.deepEqual(leakedValueSnap.refs, []);
  assert.equal(JSON.stringify(leakedValueSnap).includes('ya29.a0AfH6SM1234567890abcdef123456'), false);

  const leakedValueSanitized = sanitizeSnapshotForBot(
    leakedValueSnap,
    classifyPageSensitivity({
      url: leakedValueSnap.url,
      title: leakedValueSnap.title,
      hints: mergeProviderHints(leakedValueSnap),
      providerSensitive: leakedValueSnap.sensitive,
    }),
  );
  assert.equal(leakedValueSanitized.blocked, true);
  assert.equal(leakedValueSanitized.code, 'BROWSER_SECRET_STEP_BLOCKED');

  // 3. Sensitive page flagged by native provider (password boundary).
  reply = {
    pageId: 'p-1',
    revision: 4,
    url: 'https://example.com/login?next=dashboard&token=secret-login-tok',
    title: 'Sign in',
    sensitive: true,
    sensitiveReason: 'password_input_detected',
    requiresHumanTakeover: false,
    requiresSystemBrowser: false,
    interactive: [
      { ref: 'e1', tag: 'input', type: 'password', ariaLabel: 'Password', value: 'hunter2' },
    ],
    textSummary: 'Enter your password to continue.',
    truncated: false,
  };
  const sensitiveSnap = await provider.perform({ action: 'snapshot', botId: 'bot-a', pageId: 'p-1' });
  assert.equal(sensitiveSnap.sensitive, true);
  assert.equal(sensitiveSnap.snapshot, '');
  assert.deepEqual(sensitiveSnap.refs, []);
  assert.deepEqual(sensitiveSnap.interactive, []);
  assert.equal(sensitiveSnap.textSummary, '');
  assert.equal(sensitiveSnap.title, '');
  assert.equal(sensitiveSnap.url, 'https://example.com/login');
  assert.equal(JSON.stringify(sensitiveSnap).includes('hunter2'), false);
  assert.equal(JSON.stringify(sensitiveSnap).includes('secret-login-tok'), false);

  const sensitiveSanitized = sanitizeSnapshotForBot(
    sensitiveSnap,
    classifyPageSensitivity({
      url: sensitiveSnap.url,
      title: sensitiveSnap.title,
      hints: mergeProviderHints(sensitiveSnap),
      providerSensitive: sensitiveSnap.sensitive,
    }),
  );
  assert.equal(sensitiveSanitized.blocked, true);
  assert.equal(sensitiveSanitized.code, 'BROWSER_SENSITIVE_BLOCKED');

  await provider.close();
});

test('createBotBrowserService + real android provider: Bot receives snapshot/refs and Privacy Shield intercepts sensitive refs and secret pages', async () => {
  const calls = [];
  let currentSnapshot = {
    pageId: 'p-1',
    revision: 1,
    url: 'https://console.cloud.google.com/auth/branding',
    title: 'OAuth branding',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sensitive: false,
    requiresHumanTakeover: false,
    requiresSystemBrowser: false,
    interactive: [
      {
        ref: 'e1',
        tag: 'input',
        type: 'text',
        name: 'app_name',
        ariaLabel: 'App name',
        placeholder: 'Enter app name',
        value: 'draft-secret-app-name',
        checked: false,
        disabled: false,
        href: '',
      },
      {
        ref: 'e2',
        tag: 'input',
        type: 'checkbox',
        name: 'policy',
        ariaLabel: 'I agree to the Google API Services: User Data Policy',
        value: 'on',
        checked: false,
        disabled: false,
        href: '',
      },
      {
        ref: 'e3',
        tag: 'button',
        type: 'button',
        text: 'Create OAuth client',
        value: '',
        checked: false,
        disabled: false,
        href: '',
      },
      {
        ref: 'e4',
        tag: 'input',
        type: 'password',
        name: 'pwd',
        placeholder: 'Account password',
        value: 'raw-pass-123',
        checked: false,
        disabled: false,
        href: '',
      },
      {
        ref: 'e5',
        tag: 'input',
        type: 'text',
        autocomplete: 'one-time-code',
        placeholder: '6-digit code',
        value: '987654',
        checked: false,
        disabled: false,
        href: '',
      },
    ],
    textSummary: 'Configure your OAuth consent screen branding.',
    truncated: false,
  };

  const nativeBridge = async (request) => {
    const validated = normalizeNativeRequest(request);
    calls.push(validated);
    const { action } = validated.arguments;
    if (action === 'open' || action === 'status' || action === 'act') {
      return {
        ok: true,
        available: true,
        canStreamInteract: true,
        profileIsolation: 'webview-multi-profile',
        sessionId: 'sess-1',
        pageId: 'p-1',
        revision: action === 'act' ? 2 : 1,
        tabs: [
          {
            id: 'p-1',
            title: 'OAuth branding',
            url: 'https://console.cloud.google.com/auth/branding',
          },
        ],
        sensitive: false,
      };
    }
    if (action === 'snapshot') {
      return currentSnapshot;
    }
    if (action === 'release') {
      return {
        available: true,
        canStreamInteract: true,
        profileIsolation: 'webview-multi-profile',
        sessionId: null,
        pageId: null,
        revision: 3,
        tabs: [],
        sensitive: false,
      };
    }
    throw new Error(`unexpected action ${action}`);
  };

  const host = {
    deviceId: 'dev-android-1',
    dataRoot: '/tmp/pibot-android-browser-test',
    getBot(botId) {
      return botId === 'bot-a'
        ? { botId: 'bot-a', deviceId: 'dev-android-1', primaryConversationId: 'conv-bot-a' }
        : null;
    },
  };

  const service = createBotBrowserService({
    host,
    nativeBridge,
    resolveConversationBot: async () => 'bot-a',
  });
  const [tool] = service.toolsForBot();
  const owner = { role: 'owner', clientId: 'phone-1', holderLabel: 'Android Phone', authenticated: true };
  const parseToolJson = (res) => JSON.parse(res.output[0].text);

  const opened = await tool.execute(
    { action: 'open', url: 'https://console.cloud.google.com/auth/branding' },
    { conversationId: 1 },
    {},
  );
  assert.notEqual(opened.isError, true);

  // Bot receives readable snapshot with refs + summary and no raw form values.
  const snapRes = await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  assert.notEqual(snapRes.isError, true);
  const snapBody = parseToolJson(snapRes);
  assert.match(snapBody.snapshot, /\[e1\] textbox "App name"/);
  assert.match(snapBody.snapshot, /\[e2\] checkbox "I agree to the Google API Services: User Data Policy" \[unchecked\] \[human-only\]/);
  assert.match(snapBody.snapshot, /\[e3\] button "Create OAuth client" \[human-only\]/);
  assert.match(snapBody.snapshot, /Configure your OAuth consent screen branding\./);
  assert.equal(snapBody.snapshot.includes('draft-secret-app-name'), false);
  assert.equal(snapBody.snapshot.includes('raw-pass-123'), false);
  assert.equal(snapBody.snapshot.includes('987654'), false);

  // Non-sensitive ref action proceeds through provider.
  const okClick = await tool.execute({ action: 'act', act: { kind: 'click', ref: 'e1' } }, { conversationId: 1 }, {});
  assert.notEqual(okClick.isError, true);
  assert.equal(calls.some((c) => c.arguments.action === 'act' && c.arguments.act?.ref === 'e1'), true);

  // Policy consent checkbox is blocked BEFORE nativeBridge using structured refs.
  const policyRes = await tool.execute({ action: 'act', act: { kind: 'click', ref: 'e2' } }, { conversationId: 1 }, {});
  assert.equal(policyRes.isError, true);
  assert.equal(parseToolJson(policyRes).code, 'BROWSER_SENSITIVE_BLOCKED');
  assert.equal(calls.some((c) => c.arguments.action === 'act' && c.arguments.act?.ref === 'e2'), false);

  // Create OAuth client button on Cloud Console is blocked BEFORE nativeBridge.
  await service.control({ action: 'handback', botId: 'bot-a' }, owner);
  await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  const createRes = await tool.execute({ action: 'act', act: { kind: 'click', ref: 'e3' } }, { conversationId: 1 }, {});
  assert.equal(createRes.isError, true);
  const createBody = parseToolJson(createRes);
  assert.equal(createBody.code, 'BROWSER_SECRET_STEP_BLOCKED');
  assert.equal(createBody.fallbackToSystemBrowser, true);
  assert.equal(calls.some((c) => c.arguments.action === 'act' && c.arguments.act?.ref === 'e3'), false);

  // Password field is blocked BEFORE nativeBridge.
  await service.control({ action: 'handback', botId: 'bot-a' }, owner);
  await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  const pwdRes = await tool.execute({ action: 'act', act: { kind: 'fill', ref: 'e4', value: 'abc' } }, { conversationId: 1 }, {});
  assert.equal(pwdRes.isError, true);
  assert.equal(parseToolJson(pwdRes).code, 'BROWSER_SENSITIVE_BLOCKED');
  assert.equal(calls.some((c) => c.arguments.action === 'act' && c.arguments.act?.ref === 'e4'), false);

  // OTP field (via autocomplete="one-time-code") is blocked BEFORE nativeBridge.
  await service.control({ action: 'handback', botId: 'bot-a' }, owner);
  await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  const otpRes = await tool.execute({ action: 'act', act: { kind: 'fill', ref: 'e5', value: '123456' } }, { conversationId: 1 }, {});
  assert.equal(otpRes.isError, true);
  assert.equal(parseToolJson(otpRes).code, 'BROWSER_SENSITIVE_BLOCKED');
  assert.equal(calls.some((c) => c.arguments.action === 'act' && c.arguments.act?.ref === 'e5'), false);

  // Secret leak appearing in native textSummary blocks Bot snapshot with BROWSER_SECRET_STEP_BLOCKED.
  await service.control({ action: 'handback', botId: 'bot-a' }, owner);
  currentSnapshot = {
    pageId: 'p-1',
    revision: 3,
    url: 'https://console.cloud.google.com/auth/branding',
    title: 'OAuth branding',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sensitive: false,
    requiresHumanTakeover: false,
    requiresSystemBrowser: false,
    interactive: [{ ref: 'e1', tag: 'button', text: 'Done' }],
    textSummary: 'Your client secret is GOCSPX-abcdef1234567890',
    truncated: false,
  };
  const leakedRes = await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  assert.equal(leakedRes.isError, true);
  const leakedBody = parseToolJson(leakedRes);
  assert.equal(leakedBody.code, 'BROWSER_SECRET_STEP_BLOCKED');
  assert.equal(leakedBody.fallbackToSystemBrowser, true);
  assert.equal(leakedRes.output[0].text.includes('GOCSPX-abcdef1234567890'), false);

  await service.close();
});
