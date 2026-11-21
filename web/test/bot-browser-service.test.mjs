import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotBrowserService } from '../../host-core/bot-browser/service.js';
import { createClientBrowserRenderer } from '../../host-core/bot-browser/client-renderer.js';
import {
  BROWSER_ERROR_CODES,
  botBrowserProfileDirectory,
  normalizeBotActInput,
} from '../../host-core/bot-browser/protocol.js';
import {
  checkBotActionSensitivity,
  classifyPageSensitivity,
  containsSecretLeak,
  sanitizeUrlForModel,
  validateNavigationUrl,
} from '../../host-core/bot-browser/policy.js';

const VALID_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
]).toString('base64');

test('client-rendered pages preserve normalized form input and bounded wait conditions', async (t) => {
  const renderer = createClientBrowserRenderer({
    rendererId: 'fixture-renderer-1', clientId: 'fixture-client', maxTabs: 2, maxFrameBytes: 737280,
  });
  t.after(() => renderer.close());
  const page = { url: 'https://example.org/', title: 'Fixture', documentGeneration: 1 };
  async function reply(operation, result) {
    const { command } = await renderer.next();
    assert.equal(command.operation, operation);
    renderer.reply({ operationId: command.operationId, result });
    return command;
  }
  const opening = renderer.perform({ action: 'open', actor: 'human', url: page.url });
  await reply('create', page);
  const { pageId } = await opening;

  const fill = renderer.perform({
    action: 'act', actor: 'bot', pageId, act: normalizeBotActInput({ kind: 'fill', ref: 'e1', value: 'typed value' }),
  });
  await reply('status', page);
  const fillRequest = await reply('act', { ok: true });
  assert.equal(fillRequest.text, 'typed value');
  assert.equal(fillRequest.elementRef, 1);
  assert.equal(fillRequest.expectedUrl, page.url);
  await reply('status', page);
  assert.equal((await fill).ok, true);

  const wait = renderer.perform({
    action: 'act', actor: 'bot', pageId, act: normalizeBotActInput({ kind: 'wait', selector: '#done' }),
  });
  await reply('status', page);
  const waitRequest = await reply('waitCheck', { ok: true });
  assert.equal(waitRequest.wait.selector, '#done');
  await reply('status', page);
  assert.equal((await wait).ok, true);
});

function createFakeHost(botIds = ['bot-a', 'bot-b']) {
  const bots = new Map();
  for (const botId of botIds) {
    bots.set(botId, {
      botId,
      deviceId: 'dev-local-1',
      primaryConversationId: `conv-${botId}`,
    });
  }
  return {
    deviceId: 'dev-local-1',
    dataRoot: '/tmp/pibot-browser-test-root',
    getBot(botId) {
      return bots.get(botId) ?? null;
    },
    listBots() {
      return [...bots.values()];
    },
  };
}

function createMockProviderFactory(overrides = {}) {
  const created = new Map();
  const calls = [];

  async function factory({ botId, profileDir }) {
    let tabCounter = 0;
    let docGen = 1;
    let tabs = [];
    let activePageId = null;
    let closed = false;
    const state = {
      available: overrides.available ?? true,
      canStreamInteract: overrides.canStreamInteract ?? true,
      reason: overrides.reason,
      hintsByPage: new Map(),
      snapshotByPage: new Map(),
      refsByPage: new Map(),
      onPerform: overrides.onPerform ?? null,
    };

    const provider = {
      botId,
      profileDir,
      state,
      get closed() { return closed; },
      async perform(input) {
        calls.push({ botId, ...input });
        if (state.onPerform) {
          const intercepted = await state.onPerform(input, { tabs, activePageId, state, setPage: (p) => { activePageId = p; } });
          if (intercepted !== undefined) return intercepted;
        }
        if (!state.available) {
          return {
            available: false,
            canStreamInteract: false,
            reason: state.reason ?? 'headless_environment',
            tabs: [],
            pageId: null,
          };
        }
        switch (input.action) {
          case 'status': {
            const cur = tabs.find((t) => t.id === activePageId) ?? tabs[0] ?? null;
            return {
              available: state.available,
              canStreamInteract: state.canStreamInteract,
              sessionId: tabs.length > 0 ? `sess-${botId}` : null,
              pageId: cur?.id ?? null,
              documentGeneration: docGen,
              tabs: tabs.map((t) => ({ ...t })),
              url: cur?.url ?? '',
              title: cur?.title ?? '',
              hints: cur ? state.hintsByPage.get(cur.id) : undefined,
            };
          }
          case 'open': {
            const id = `${botId}-tab-${++tabCounter}`;
            const url = input.url ?? 'about:blank';
            const title = `Title ${tabCounter}`;
            tabs.push({ id, title, url });
            activePageId = id;
            docGen += 1;
            return {
              available: true,
              canStreamInteract: state.canStreamInteract,
              sessionId: `sess-${botId}`,
              pageId: id,
              documentGeneration: docGen,
              tabs: tabs.map((t) => ({ ...t })),
              url,
              title,
            };
          }
          case 'navigate': {
            const target = tabs.find((t) => t.id === (input.pageId ?? activePageId));
            if (!target) throw new Error('missing tab');
            target.url = input.url;
            target.title = `Nav ${input.url}`;
            activePageId = target.id;
            docGen += 1;
            return {
              available: true,
              canStreamInteract: state.canStreamInteract,
              sessionId: `sess-${botId}`,
              pageId: target.id,
              documentGeneration: docGen,
              tabs: tabs.map((t) => ({ ...t })),
              url: target.url,
              title: target.title,
              hints: state.hintsByPage.get(target.id),
            };
          }
          case 'select': {
            activePageId = input.pageId;
            const cur = tabs.find((t) => t.id === activePageId);
            return {
              pageId: cur.id,
              documentGeneration: docGen,
              tabs: tabs.map((t) => ({ ...t })),
              url: cur.url,
              title: cur.title,
            };
          }
          case 'closeTab': {
            tabs = tabs.filter((t) => t.id !== input.pageId);
            activePageId = tabs[0]?.id ?? null;
            docGen += 1;
            return {
              pageId: activePageId,
              documentGeneration: docGen,
              tabs: tabs.map((t) => ({ ...t })),
            };
          }
          case 'frame': {
            const cur = tabs.find((t) => t.id === (input.pageId ?? activePageId));
            return {
              mimeType: 'image/png',
              data: VALID_PNG_BASE64,
              width: 1,
              height: 1,
              pageId: cur.id,
              documentGeneration: docGen,
              url: cur.url,
              title: cur.title,
              hints: state.hintsByPage.get(cur.id),
            };
          }
          case 'snapshot': {
            const cur = tabs.find((t) => t.id === (input.pageId ?? activePageId));
            return {
              pageId: cur.id,
              documentGeneration: docGen,
              url: cur.url,
              title: cur.title,
              snapshot: state.snapshotByPage.get(cur.id) ?? '[button ref=e1 "Continue"]',
              refs: state.refsByPage.get(cur.id) ?? [{ ref: 'e1', role: 'button', name: 'Continue' }],
              hints: state.hintsByPage.get(cur.id),
            };
          }
          case 'act': {
            const cur = tabs.find((t) => t.id === (input.pageId ?? activePageId));
            return {
              ok: true,
              pageId: cur.id,
              documentGeneration: docGen,
              url: cur.url,
              title: cur.title,
              changed: true,
              hints: state.hintsByPage.get(cur.id),
            };
          }
          case 'input': {
            const cur = tabs.find((t) => t.id === (input.pageId ?? activePageId));
            return {
              ok: true,
              pageId: cur.id,
              documentGeneration: docGen,
              url: cur.url,
              title: cur.title,
              hints: state.hintsByPage.get(cur.id),
            };
          }
          case 'release': {
            tabs = [];
            activePageId = null;
            return { ok: true };
          }
          default:
            return { ok: true };
        }
      },
      async close() {
        closed = true;
      },
    };
    created.set(botId, provider);
    return provider;
  }

  return { factory, created, calls };
}

function ownerAuth(clientId = 'desktop-1', holderLabel = 'MacBook-Pro') {
  return { role: 'owner', clientId, holderLabel, authenticated: true };
}

function parseToolJson(res) {
  return JSON.parse(res.output[0].text);
}

test('the same desktop can replace its disconnected renderer with a tab still registered', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const service = createBotBrowserService({ host: createFakeHost(['bot-a']) });
  t.after(() => service.close());
  const desktop = ownerAuth('desktop-1');
  const otherDesktop = ownerAuth('desktop-2');
  const original = 'original-renderer';
  const replacement = 'replacement-renderer';
  const control = (input, authority = desktop) => service.control({ botId: 'bot-a', ...input }, authority);
  const attach = (rendererId, authority) => control({ action: 'rendererAttach', rendererId }, authority);
  const open = async (rendererId) => {
    const url = 'https://example.org/';
    const pending = control({ action: 'open', url });
    const { command } = await control({ action: 'rendererNext', rendererId });
    assert.equal(command.operation, 'create');
    await control({
      action: 'rendererReply', rendererId, operationId: command.operationId,
      result: { url, title: 'Example', documentGeneration: 1 },
    });
    return pending;
  };

  assert.equal((await attach(original)).accepted, true);
  const before = await open(original);
  assert.equal(before.tabs.length, 1);
  assert.equal((await attach(replacement)).accepted, false);
  t.mock.timers.setTime(Date.now() + 12_001);
  const disconnected = await control({ action: 'status' });
  assert.equal(disconnected.available, false);
  assert.equal(disconnected.reason, 'client_browser_disconnected');
  assert.equal(disconnected.pageId, before.pageId);
  assert.equal((await attach(replacement, otherDesktop)).accepted, false);

  assert.equal((await attach(replacement)).accepted, true);
  await assert.rejects(() => control({ action: 'rendererNext', rendererId: original }), { code: 'BROWSER_FORBIDDEN' });
  const after = await open(replacement);
  assert.equal(after.available, true);
  assert.equal(after.tabs.length, 1);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.notEqual(after.pageId, before.pageId);
});

test('policy: URL validation blocks file/javascript/chrome/credentialed/internal/OAuth/secret URLs', () => {
  assert.equal(
    validateNavigationUrl('https://console.cloud.google.com/auth/branding', { actor: 'bot' }),
    'https://console.cloud.google.com/auth/branding'
  );
  assert.throws(
    () => validateNavigationUrl('file:///etc/passwd', { actor: 'bot' }),
    { code: 'BROWSER_URL_BLOCKED' }
  );
  assert.throws(
    () => validateNavigationUrl('javascript:alert(1)', { actor: 'human' }),
    { code: 'BROWSER_URL_BLOCKED' }
  );
  assert.throws(
    () => validateNavigationUrl('chrome://settings/passwords', { actor: 'human' }),
    { code: 'BROWSER_URL_BLOCKED' }
  );
  assert.throws(
    () => validateNavigationUrl('https://user:pass@example.com', { actor: 'human' }),
    { code: 'BROWSER_URL_BLOCKED' }
  );
  assert.throws(
    () => validateNavigationUrl('https://tauri.localhost/index.html', { actor: 'bot' }),
    { code: 'BROWSER_URL_BLOCKED' }
  );
  assert.throws(
    () => validateNavigationUrl('http://169.254.169.254/latest/meta-data/', { actor: 'bot' }),
    { code: 'BROWSER_URL_BLOCKED' }
  );
  assert.throws(
    () => validateNavigationUrl('https://accounts.google.com/o/oauth2/v2/auth', { actor: 'bot' }),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  assert.throws(
    () => validateNavigationUrl('https://console.cloud.google.com/auth/clients', { actor: 'bot' }),
    { code: 'BROWSER_SECRET_STEP_BLOCKED' }
  );

  assert.equal(
    sanitizeUrlForModel('https://example.com/cb?code=secret123&state=xyz&tab=1#frag'),
    'https://example.com/cb?code=%5Bredacted%5D&state=%5Bredacted%5D&tab=1'
  );
  assert.equal(containsSecretLeak('Your secret is GOCSPX-abcDEF1234567890'), true);
  assert.equal(containsSecretLeak('Normal page heading'), false);
});

test('project creation accepts the ordinary Create button and preserves credential protection', () => {
  const projectUrl = 'https://console.cloud.google.com/projectcreate';
  const click = (pageUrl, name) => checkBotActionSensitivity({
    act: { kind: 'click', ref: 'create-button' },
    pageUrl,
    targetRefMeta: { role: 'button', name },
  });
  assert.equal(click(projectUrl, 'Create').allowed, true);
  assert.equal(click(projectUrl, 'Create OAuth client').code, 'BROWSER_SECRET_STEP_BLOCKED');
  assert.equal(click('https://console.cloud.google.com/auth/clients/create', 'Create').code, 'BROWSER_SECRET_STEP_BLOCKED');
  assert.equal(click(projectUrl, 'Accept terms').code, 'BROWSER_SENSITIVE_BLOCKED');
});

test('protocol & tool contract: act.wait validates state/selector/networkidle and preserves BROWSER_TIMEOUT', async () => {
  assert.equal(BROWSER_ERROR_CODES.includes('BROWSER_TIMEOUT'), true);
  assert.throws(
    () => normalizeBotActInput({ kind: 'wait', state: 'hidden' }),
    { code: 'INVALID_ARGUMENT' }
  );
  assert.throws(
    () => normalizeBotActInput({ kind: 'wait', selector: '   ' }),
    { code: 'INVALID_ARGUMENT' }
  );
  assert.throws(
    () => normalizeBotActInput({ kind: 'wait', load: 'networkidle' }),
    { code: 'BROWSER_UNSUPPORTED' }
  );
  assert.deepEqual(
    normalizeBotActInput({
      kind: 'wait',
      selector: '#done',
      state: 'hidden',
      text: 'Saved',
      url: 'https://example.com/done',
      load: 'domcontentloaded',
      timeoutMs: 1200,
    }),
    {
      kind: 'wait',
      selector: '#done',
      state: 'hidden',
      text: 'Saved',
      url: 'https://example.com/done',
      load: 'domcontentloaded',
      timeoutMs: 1200,
    }
  );
  assert.deepEqual(normalizeBotActInput({ kind: 'wait', timeoutMs: 300 }), {
    kind: 'wait',
    timeoutMs: 300,
  });

  const host = createFakeHost(['bot-a']);
  const mock = createMockProviderFactory({
    onPerform: async (input) => {
      if (input.action === 'act' && input.act?.kind === 'wait' && input.act?.selector === '#missing') {
        const err = new Error('Timed out waiting for browser condition(s): selector.');
        err.code = 'BROWSER_TIMEOUT';
        throw err;
      }
      return undefined;
    },
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  try {
    const [tool] = service.toolsForBot();
    const opened = await tool.execute({ action: 'open', url: 'https://example.com/app' }, { conversationId: 101 }, {});
    assert.notEqual(opened.isError, true);
    const pageId = parseToolJson(opened).pageId;

    const badState = await tool.execute(
      { action: 'act', pageId, act: { kind: 'wait', state: 'hidden' } },
      { conversationId: 101 },
      {}
    );
    assert.equal(badState.isError, true);
    assert.equal(parseToolJson(badState).code, 'INVALID_ARGUMENT');

    const badLoad = await tool.execute(
      { action: 'act', pageId, act: { kind: 'wait', load: 'networkidle' } },
      { conversationId: 101 },
      {}
    );
    assert.equal(badLoad.isError, true);
    assert.equal(parseToolJson(badLoad).code, 'BROWSER_UNSUPPORTED');

    const timedOut = await tool.execute(
      { action: 'act', pageId, act: { kind: 'wait', selector: '#missing', timeoutMs: 200 } },
      { conversationId: 101 },
      {}
    );
    assert.equal(timedOut.isError, true);
    assert.equal(parseToolJson(timedOut).code, 'BROWSER_TIMEOUT');
  } finally {
    await service.close();
  }
});

test('per-bot profile isolation and persistent conversation ownership binding', async () => {
  assert.throws(() => botBrowserProfileDirectory('/tmp/root', '../escape'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => botBrowserProfileDirectory('/tmp/root', 'a/b'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => botBrowserProfileDirectory('/tmp/root', 'C:evil'), { code: 'INVALID_ARGUMENT' });

  const host = createFakeHost(['bot-a', 'bot-b']);
  const mock = createMockProviderFactory();
  const service = createBotBrowserService({
    host,
    maxTabsPerBot: 2,
    createProvider: opts => {
      assert.equal(opts.maxTabs, 2);
      return mock.factory(opts);
    },
    resolveConversationBot: async (convId) => {
      if (convId === 101) return 'bot-a';
      if (convId === 202) return 'bot-b';
      throw Object.assign(new Error('not owned'), { code: 'BOT_CONTEXT_REQUIRED' });
    },
  });

  const [tool] = service.toolsForBot();
  const openA = await tool.execute({ action: 'open', url: 'https://example.com/a' }, { conversationId: 101 }, {});
  assert.notEqual(openA.isError, true);
  const openB = await tool.execute({ action: 'open', url: 'https://example.com/b' }, { conversationId: 202 }, {});
  assert.notEqual(openB.isError, true);

  const pageA = parseToolJson(openA).pageId;
  const pageB = parseToolJson(openB).pageId;
  assert.notEqual(mock.created.get('bot-a').profileDir, mock.created.get('bot-b').profileDir);

  // Bot A cannot touch Bot B's pageId.
  const cross = await tool.execute({ action: 'select', pageId: pageB }, { conversationId: 101 }, {});
  assert.equal(cross.isError, true);
  assert.equal(parseToolJson(cross).code, 'BROWSER_PAGE_NOT_FOUND');

  // Foreign conversation is rejected.
  const foreign = await tool.execute({ action: 'status' }, { conversationId: 999 }, {});
  assert.equal(foreign.isError, true);
  assert.equal(parseToolJson(foreign).code, 'BOT_CONTEXT_REQUIRED');

  // Bound tool rejects mismatched conversation ownership.
  const [boundToolA] = service.toolsForBot({ botId: 'bot-a' });
  const mismatch = await boundToolA.execute({ action: 'status' }, { conversationId: 202 }, {});
  assert.equal(mismatch.isError, true);
  assert.equal(parseToolJson(mismatch).code, 'BOT_CONTEXT_REQUIRED');

  // Control rejects bot/collaborator/unauthenticated authority.
  await assert.rejects(
    () => service.control({ action: 'status', botId: 'bot-a' }, { role: 'bot', clientId: 'bot-a' }),
    { code: 'BROWSER_FORBIDDEN' }
  );
  await assert.rejects(
    () => service.control({ action: 'takeover', botId: 'bot-a' }, { role: 'collaborator', clientId: 'peer-1' }),
    { code: 'BROWSER_FORBIDDEN' }
  );
  await assert.rejects(
    () => service.control({ action: 'status', botId: 'bot-a' }, { role: 'owner', clientId: 'x', authenticated: false }),
    { code: 'BROWSER_FORBIDDEN' }
  );
  assert.ok(pageA);

  await service.close();
});

test('real takeover cancels queued bot ops, awaits in-flight settlement, unlocks input, and hands back safely', async () => {
  const host = createFakeHost(['bot-a']);
  let releaseInFlight;
  let markInFlightStarted;
  const inFlightStarted = new Promise((resolve) => { markInFlightStarted = resolve; });
  let inFlightAborted = false;
  let takeoverHookCalls = 0;
  let handbackEvents = [];

  const mock = createMockProviderFactory({
    onPerform: async (input) => {
      if (input.action === 'act' && input.act?.ref === 'slow-ref') {
        return new Promise((resolve, reject) => {
          input.signal?.addEventListener('abort', () => {
            inFlightAborted = true;
          });
          releaseInFlight = () => reject(Object.assign(new Error('aborted'), { code: 'CANCELLED' }));
          markInFlightStarted();
        });
      }
      return undefined;
    },
  });

  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
    onTakeover: async () => { takeoverHookCalls += 1; },
    onHandback: async (summary) => { handbackEvents.push(summary); },
  });

  const [tool] = service.toolsForBot();
  const opened = parseToolJson(await tool.execute({ action: 'open', url: 'https://console.cloud.google.com/auth/branding' }, { conversationId: 1 }, {}));
  const pageId = opened.pageId;

  // Start slow in-flight bot act + enqueue a second bot act behind it.
  const op1Promise = tool.execute({ action: 'act', act: { kind: 'click', ref: 'slow-ref' } }, { conversationId: 1 }, {});
  const op2Promise = tool.execute({ action: 'act', act: { kind: 'click', ref: 'queued-ref' } }, { conversationId: 1 }, {});

  await inFlightStarted;

  // Initiate human takeover while op1 is still in-flight.
  const takeoverPromise = service.control({ action: 'takeover', botId: 'bot-a' }, ownerAuth('desktop-1', 'MacBook-Pro'));

  // Queued op2 is immediately cancelled without ever hitting provider.
  const op2Res = await op2Promise;
  assert.equal(op2Res.isError, true);
  assert.equal(parseToolJson(op2Res).status, 'PAUSED_FOR_HUMAN');
  assert.equal(mock.calls.some((c) => c.action === 'act' && c.act?.ref === 'queued-ref'), false);
  assert.equal(inFlightAborted, true);

  // While op1 is still settling ('taking'), human input MUST be rejected.
  const takingStatus = await service.control({ action: 'status', botId: 'bot-a' }, ownerAuth('desktop-1', 'MacBook-Pro'));
  assert.equal(takingStatus.phase, 'taking');
  await assert.rejects(
    () => service.control({
      action: 'input',
      botId: 'bot-a',
      pageId,
      revision: takingStatus.revision,
      lease: 'fake-token-1234',
      event: { kind: 'click', x: 0.5, y: 0.5 },
    }, ownerAuth('desktop-1', 'MacBook-Pro')),
    { code: 'BROWSER_TAKEOVER_PENDING' }
  );

  // Settle op1 -> takeover now completes with confirmed human lease on the exact same page.
  releaseInFlight();
  const op1Res = await op1Promise;
  assert.equal(op1Res.isError, true);

  const taken = await takeoverPromise;
  assert.equal(taken.phase, 'human');
  assert.equal(taken.pageId, pageId);
  assert.equal(taken.holderLabel, 'MacBook-Pro');
  assert.equal(typeof taken.lease, 'string');
  assert.equal(takeoverHookCalls, 1);

  // Subsequent bot call gets structured PAUSED_FOR_HUMAN.
  const blockedBot = await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  assert.equal(blockedBot.isError, true);
  assert.equal(parseToolJson(blockedBot).status, 'PAUSED_FOR_HUMAN');

  // Capture frame and send human input on same page.
  const frame = await service.control({ action: 'frame', botId: 'bot-a', lease: taken.lease }, ownerAuth('desktop-1', 'MacBook-Pro'));
  assert.equal(frame.pageId, pageId);
  assert.equal(frame.revision, taken.revision);

  const inputRes = await service.control({
    action: 'input',
    botId: 'bot-a',
    pageId,
    revision: taken.revision,
    frameSeq: frame.seq,
    lease: taken.lease,
    event: { kind: 'click', x: 0.25, y: 0.75 },
  }, ownerAuth('desktop-1', 'MacBook-Pro'));
  assert.equal(inputRes.ok, true);

  // Stale revision is rejected.
  await assert.rejects(
    () => service.control({
      action: 'input',
      botId: 'bot-a',
      pageId,
      revision: taken.revision - 1,
      lease: taken.lease,
      event: { kind: 'key', key: 'Enter' },
    }, ownerAuth('desktop-1', 'MacBook-Pro')),
    { code: 'BROWSER_STALE_REVISION' }
  );

  // Hand back on non-sensitive landing page invalidates lease and rejects late inputs.
  const handedBack = await service.control({
    action: 'handback',
    botId: 'bot-a',
    lease: taken.lease,
  }, ownerAuth('desktop-1', 'MacBook-Pro'));
  assert.equal(handedBack.phase, 'bot');
  assert.equal(handedBack.lease, undefined);
  assert.equal(handbackEvents.length, 1);

  await assert.rejects(
    () => service.control({
      action: 'input',
      botId: 'bot-a',
      pageId,
      revision: handedBack.revision,
      lease: taken.lease,
      event: { kind: 'click', x: 0.5, y: 0.5 },
    }, ownerAuth('desktop-1', 'MacBook-Pro')),
    { code: 'BROWSER_TAKEOVER_REQUIRED' }
  );

  await service.close();
});

test('an unconfirmed native mutation cannot grant the pending human takeover', async (t) => {
  const started = Promise.withResolvers();
  const mock = createMockProviderFactory({ async onPerform(input) {
    if (input.action !== 'act') return;
    started.resolve();
    await new Promise(resolve => input.signal.addEventListener('abort', resolve, { once: true }));
    throw Object.assign(new Error('Native action did not confirm completion'), {
      code: 'BROWSER_BACKEND_FAILED', outcome: 'unconfirmed',
    });
  } });
  const service = createBotBrowserService({ host: createFakeHost(['bot-a']), createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a' });
  t.after(() => service.close());
  const context = { conversationId: 1 };
  const owner = ownerAuth('phone', 'Phone');
  const [tool] = service.toolsForBot();
  await tool.execute({ action: 'open', url: 'https://example.com' }, context, {});
  const act = tool.execute({ action: 'act', act: { kind: 'type', text: 'draft' } }, context, {});
  await started.promise;
  await assert.rejects(service.control({ action: 'takeover', botId: 'bot-a' }, owner),
    { code: 'BROWSER_TAKEOVER_UNCONFIRMED' });
  assert.equal(parseToolJson(await act).outcome, 'unconfirmed');
  assert.equal((await service.control({ action: 'status', botId: 'bot-a' }, owner)).phase, 'held');
});

test('unconfirmed in-flight takeover times out fail-closed into held without opening input', async () => {
  const host = createFakeHost(['bot-a']);
  let unblock;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const mock = createMockProviderFactory({
    onPerform: async (input) => {
      if (input.action === 'act') {
        return new Promise((resolve) => {
          unblock = () => resolve({ ok: true });
          markStarted();
        });
      }
      return undefined;
    },
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
    takeoverTimeoutMs: 30,
  });

  const [tool] = service.toolsForBot();
  await tool.execute({ action: 'open', url: 'https://example.com' }, { conversationId: 1 }, {});
  const hanging = tool.execute({ action: 'act', act: { kind: 'click', ref: 'e1' } }, { conversationId: 1 }, {});
  await started;

  await assert.rejects(
    () => service.control({ action: 'takeover', botId: 'bot-a' }, ownerAuth('desktop-1')),
    { code: 'BROWSER_TAKEOVER_UNCONFIRMED' }
  );

  const st = await service.control({ action: 'status', botId: 'bot-a' }, ownerAuth('desktop-1'));
  assert.equal(st.phase, 'held');
  assert.equal(st.reason, 'takeover_unconfirmed');

  // Even after the slow op eventually settles, phase stays 'held' (never auto-returns to 'bot').
  unblock();
  await hanging;
  const stAfter = await service.control({ action: 'status', botId: 'bot-a' }, ownerAuth('desktop-1'));
  assert.equal(stAfter.phase, 'held');

  await service.close();
});

test('concurrent clients: lease token hidden from other client, explicit preemption invalidates old holder', async () => {
  const host = createFakeHost(['bot-a']);
  const mock = createMockProviderFactory();
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const phone = ownerAuth('phone-1', 'Android Phone');

  const opened = await service.control({ action: 'open', botId: 'bot-a', url: 'https://example.com' }, desktop);
  const takenA = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  assert.ok(takenA.lease);

  // Phone sees read-only status with holderLabel and NO lease token.
  const phoneView = await service.control({ action: 'status', botId: 'bot-a' }, phone);
  assert.equal(phoneView.phase, 'human');
  assert.equal(phoneView.holderLabel, 'MacBook-Pro');
  assert.equal(phoneView.isLeaseHolder, false);
  assert.equal(phoneView.lease, undefined);

  // Non-force takeover by Phone fails with BROWSER_LEASE_CONFLICT.
  await assert.rejects(
    () => service.control({ action: 'takeover', botId: 'bot-a' }, phone),
    { code: 'BROWSER_LEASE_CONFLICT' }
  );

  // Explicit preemption transfers control to Phone and invalidates Desktop's lease immediately.
  const takenB = await service.control({ action: 'takeover', botId: 'bot-a', force: true }, phone);
  assert.equal(takenB.phase, 'human');
  assert.equal(takenB.holderLabel, 'Android Phone');
  assert.notEqual(takenB.lease, takenA.lease);
  assert.ok(takenB.revision > takenA.revision);

  await assert.rejects(
    () => service.control({
      action: 'input',
      botId: 'bot-a',
      pageId: opened.pageId,
      revision: takenA.revision,
      lease: takenA.lease,
      event: { kind: 'click', x: 0.5, y: 0.5 },
    }, desktop),
    { code: 'BROWSER_LEASE_CONFLICT' }
  );

  await service.close();
});

test('ordinary browser input is shared with the Bot and still fenced by device and sensitive pages', async (t) => {
  const { promise: started, resolve: markStarted } = Promise.withResolvers();
  const { promise: finish, resolve: finishAction } = Promise.withResolvers();
  let actionAborted = false;
  let exclusiveTakeovers = 0;
  let now = Date.now();
  const mock = createMockProviderFactory({
    async onPerform(input) {
      if (input.action === 'act' && input.act?.ref === 'e1') {
        input.signal.addEventListener('abort', () => { actionAborted = true; }, { once: true });
        markStarted();
        await finish;
      }
    },
  });
  const service = createBotBrowserService({
    host: createFakeHost(['bot-a']),
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
    onTakeover: async () => { exclusiveTakeovers += 1; },
    now: () => now,
    leaseTtlMs: 1000,
  });
  t.after(async () => {
    finishAction();
    await service.close();
  });

  const desktop = ownerAuth('desktop-1');
  const phone = ownerAuth('phone-1', 'Phone');
  const control = (input, authority = desktop) => service.control({ botId: 'bot-a', ...input }, authority);
  const [tool] = service.toolsForBot();
  const bot = (input) => tool.execute(input, { conversationId: 1 }, {});
  const { pageId } = await control({ action: 'open', url: 'https://example.com' });
  await bot({ action: 'snapshot' });

  const act = bot({ action: 'act', act: { kind: 'click', ref: 'e1' } });
  await started;
  const nextBotRead = bot({ action: 'snapshot' });
  const grant = { action: 'takeover', shared: true };
  const shared = await control(grant);
  assert.equal(shared.supportsSharedInput, true);
  assert.equal(shared.sharedInput, true);
  assert.equal(shared.pageId, pageId);
  assert.equal(exclusiveTakeovers, 0);
  assert.equal(actionAborted, false);

  const frame = await control({ action: 'frame', pageId, lease: shared.lease });
  const input = {
    action: 'input', pageId, revision: frame.revision, frameSeq: frame.seq,
    lease: shared.lease, event: { kind: 'click', x: 0.5, y: 0.5 },
  };
  assert.equal((await control(input)).ok, true);
  await assert.rejects(() => control(input, phone), { code: 'BROWSER_LEASE_CONFLICT' });
  await assert.rejects(() => control(grant, phone), { code: 'BROWSER_LEASE_CONFLICT' });

  const reconnected = await control(grant);
  assert.notEqual(reconnected.lease, shared.lease);
  assert.equal((await control({ action: 'status', lease: shared.lease })).isHolder, false);
  assert.equal((await control({ action: 'status', lease: reconnected.lease })).isHolder, true);

  const switched = await control({ ...grant, force: true }, phone);
  assert.equal(switched.sharedInput, true);
  assert.notEqual(switched.lease, reconnected.lease);
  assert.equal(parseToolJson(await bot({ action: 'status' })).pausedForHuman, false);
  finishAction();
  assert.notEqual((await act).isError, true);
  assert.notEqual((await nextBotRead).isError, true);

  now += 1001;
  const expired = await control({ action: 'status' });
  assert.equal(expired.phase, 'bot');
  assert.equal(parseToolJson(await bot({ action: 'status' })).pausedForHuman, false);

  const renewed = await control(grant);
  const exclusive = await control({ action: 'takeover', lease: renewed.lease });
  assert.notEqual(exclusive.sharedInput, true);
  assert.equal(exclusiveTakeovers, 1);
  assert.equal(parseToolJson(await bot({ action: 'status' })).pausedForHuman, true);
  await control({ action: 'handback', lease: exclusive.lease });

  const ordinary = await control(grant);
  const sensitive = await control({
    action: 'navigate', pageId, lease: ordinary.lease, url: 'https://accounts.google.com/signin',
  });
  assert.equal(sensitive.sensitive, true);
  assert.notEqual(sensitive.sharedInput, true);
  assert.equal(parseToolJson(await bot({ action: 'status' })).pausedForHuman, true);
  assert.equal((await bot({ action: 'snapshot' })).isError, true);
  await assert.rejects(() => control(grant), { code: 'BROWSER_TAKEOVER_REQUIRED' });
});

test('disconnect/lease expiry fails closed into held and never auto-hands back to bot', async () => {
  let clock = 1_000_000;
  const host = createFakeHost(['bot-a']);
  const mock = createMockProviderFactory();
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
    now: () => clock,
    leaseTtlMs: 5_000,
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const [tool] = service.toolsForBot();

  const opened = await service.control({ action: 'open', botId: 'bot-a', url: 'https://example.com' }, desktop);
  const taken = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);

  // Advance clock beyond lease TTL -> transitions to 'held', NOT 'bot'.
  clock += 6_000;
  const held = await service.control({ action: 'status', botId: 'bot-a' }, desktop);
  assert.equal(held.phase, 'held');
  assert.equal(held.reason, 'disconnected_hold');

  // Bot remains blocked while held.
  const botTry = await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  assert.equal(botTry.isError, true);
  assert.equal(parseToolJson(botTry).status, 'PAUSED_FOR_HUMAN');

  // Old lease input rejected.
  await assert.rejects(
    () => service.control({
      action: 'input',
      botId: 'bot-a',
      pageId: opened.pageId,
      revision: taken.revision,
      lease: taken.lease,
      event: { kind: 'click', x: 0.5, y: 0.5 },
    }, desktop),
    { code: 'BROWSER_LEASE_EXPIRED' }
  );

  // Explicit resume grants new human lease.
  const resumed = await service.control({ action: 'takeover', botId: 'bot-a', resume: true }, desktop);
  assert.equal(resumed.phase, 'human');
  assert.notEqual(resumed.lease, taken.lease);

  await service.close();
});

test('Privacy Shield: stops before Policy checkbox and Create Secret, blocks secret frames, bystander frames, and sensitive handback', async () => {
  const host = createFakeHost(['bot-a']);
  const mock = createMockProviderFactory();
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const phone = ownerAuth('phone-1', 'Android Phone');
  const [tool] = service.toolsForBot();

  // 1. Legitimate Cloud Console branding page: bot opens and takes snapshot with Policy checkbox ref.
  const opened = parseToolJson(await tool.execute({
    action: 'open',
    url: 'https://console.cloud.google.com/auth/branding',
  }, { conversationId: 1 }, {}));
  const prov = mock.created.get('bot-a');
  prov.state.refsByPage.set(opened.pageId, [
    { ref: 'e-app', role: 'textbox', name: 'App name' },
    { ref: 'e-policy', role: 'checkbox', name: 'I agree to the Google API Services: User Data Policy' },
    { ref: 'e-create', role: 'button', name: 'Create OAuth client' },
  ]);
  const snap = await tool.execute({ action: 'snapshot', snapshot: { interactive: true } }, { conversationId: 1 }, {});
  assert.notEqual(snap.isError, true);

  // 2. Bot tries to click Policy checkbox -> intercepted BEFORE provider.perform('act')!
  const policyClick = await tool.execute({ action: 'act', act: { kind: 'click', ref: 'e-policy' } }, { conversationId: 1 }, {});
  assert.equal(policyClick.isError, true);
  assert.equal(parseToolJson(policyClick).code, 'BROWSER_SENSITIVE_BLOCKED');
  assert.equal(parseToolJson(policyClick).status, 'PAUSED_FOR_HUMAN');
  assert.equal(mock.calls.some((c) => c.action === 'act' && c.act?.ref === 'e-policy'), false);

  // Owner resumes and hands back cleanly on non-sensitive branding page.
  await service.control({ action: 'handback', botId: 'bot-a' }, desktop);

  // 3. Re-snapshot and try clicking Create -> intercepted BEFORE clicking Create!
  await tool.execute({ action: 'snapshot', snapshot: { interactive: true } }, { conversationId: 1 }, {});
  const createClick = await tool.execute({ action: 'act', act: { kind: 'click', ref: 'e-create' } }, { conversationId: 1 }, {});
  assert.equal(createClick.isError, true);
  assert.equal(parseToolJson(createClick).code, 'BROWSER_SECRET_STEP_BLOCKED');
  assert.equal(parseToolJson(createClick).fallbackToSystemBrowser, true);
  assert.equal(mock.calls.some((c) => c.action === 'act' && c.act?.ref === 'e-create'), false);

  // 4. Human takes over and navigates to /auth/clients -> secret step blocks normal frames AND blocks handback!
  const taken = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken.lease,
    url: 'https://console.cloud.google.com/auth/clients',
  }, desktop);

  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a', lease: taken.lease }, desktop),
    { code: 'BROWSER_SECRET_STEP_BLOCKED' }
  );
  await assert.rejects(
    () => service.control({ action: 'handback', botId: 'bot-a', lease: taken.lease }, desktop),
    { code: 'BROWSER_HANDBACK_BLOCKED_SENSITIVE' }
  );

  // 5. On password/login sensitive page (non-secret-dialog), bystander phone cannot view frame while desktop holds lease.
  const login = await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken.lease,
    url: 'https://accounts.google.com/v3/signin/identifier?service=cloudconsole',
  }, desktop);
  assert.equal(login.sensitive, true);
  assert.equal(login.fallbackToSystemBrowser, false);
  assert.equal(classifyPageSensitivity({ url: 'https://accounts.google.com/v3/signin/oauth/consent' }).fallbackToSystemBrowser, true);
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a' }, phone),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  // Active holder CAN view non-secret sensitive page during takeover (e.g. to finish sign-in or navigate away).
  const holderFrame = await service.control({ action: 'frame', botId: 'bot-a', lease: taken.lease }, desktop);
  assert.equal(holderFrame.mimeType, 'image/png');
  await assert.rejects(
    () => service.control({ action: 'handback', botId: 'bot-a', lease: taken.lease }, desktop),
    { code: 'BROWSER_HANDBACK_BLOCKED_SENSITIVE' }
  );

  // 6. A refused Google sign-in offers a system-browser recovery and strips session URL data.
  const rejectionPage = 'https://accounts.google.com/v3/signin/rejected';
  const rejected = await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken.lease,
    url: rejectionPage + '?continue=https%3A%2F%2Fconsole.cloud.google.com%2F&dsh=opaque#private',
  }, desktop);
  assert.equal(rejected.sensitive, true);
  assert.equal(rejected.fallbackToSystemBrowser, true);
  assert.equal(rejected.tabs.find(tab => tab.id === rejected.pageId)?.url, rejectionPage);
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a' }, phone),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  assert.equal(classifyPageSensitivity({ url: 'https://accounts.google.com.example.com/v3/signin/rejected' }).fallbackToSystemBrowser, false);
  assert.equal(classifyPageSensitivity({ url: rejectionPage + '/other' }).fallbackToSystemBrowser, false);

  // 7. Web Gmail login flags webLoginNotApiGrant (Google API grant != web login).
  const gmailSens = classifyPageSensitivity({ url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox' });
  assert.equal(gmailSens.webLoginNotApiGrant, true);

  await service.close();
});

test('defense-in-depth: snapshot containing leaked GOCSPX secret is withheld and holds session', async () => {
  const host = createFakeHost(['bot-a']);
  const mock = createMockProviderFactory();
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  const [tool] = service.toolsForBot();
  const opened = parseToolJson(await tool.execute({ action: 'open', url: 'https://example.com/dialog' }, { conversationId: 1 }, {}));
  mock.created.get('bot-a').state.snapshotByPage.set(opened.pageId, 'Client Secret: GOCSPX-topSecretValue999999');

  const snap = await tool.execute({ action: 'snapshot' }, { conversationId: 1 }, {});
  assert.equal(snap.isError, true);
  assert.equal(parseToolJson(snap).code, 'BROWSER_SECRET_STEP_BLOCKED');
  assert.equal(snap.output[0].text.includes('GOCSPX-'), false);

  await service.close();
});

test('unavailable / non-streamable provider degrades honestly and close() is idempotent', async () => {
  const host = createFakeHost(['bot-a']);
  const mock = createMockProviderFactory({
    available: false,
    canStreamInteract: false,
    reason: 'headless_no_display',
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  const st = await service.control({ action: 'status', botId: 'bot-a' }, ownerAuth('desktop-1'));
  assert.equal(st.available, false);
  assert.equal(st.canStreamInteract, false);
  assert.equal(st.reason, 'headless_no_display');

  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a' }, ownerAuth('desktop-1')),
    { code: 'BROWSER_STREAM_UNAVAILABLE' }
  );

  await service.close();
  await service.close();
  await assert.rejects(
    () => service.control({ action: 'status', botId: 'bot-a' }, ownerAuth('desktop-1')),
    { code: 'BROWSER_CLOSED' }
  );
});

function createFrameGateController() {
  let nextGate = null;
  return {
    arm() {
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      let resolveFrame;
      let rejectFrame;
      const promise = new Promise((resolve, reject) => {
        resolveFrame = resolve;
        rejectFrame = reject;
      });
      const gate = {
        started,
        markStarted,
        promise,
        resolve: resolveFrame,
        reject: rejectFrame,
      };
      nextGate = gate;
      return gate;
    },
    onPerform(input) {
      if (input.action === 'frame' && nextGate) {
        const gate = nextGate;
        nextGate = null;
        gate.markStarted();
        return gate.promise;
      }
      return undefined;
    },
  };
}

function syntheticFramePayload(overrides = {}) {
  return {
    mimeType: 'image/png',
    data: VALID_PNG_BASE64,
    width: 1,
    height: 1,
    ...overrides,
  };
}

test('in-flight sensitive frame is withheld when holder is preempted during async capture (with or without lease)', async () => {
  const host = createFakeHost(['bot-a']);
  const frameGate = createFrameGateController();
  const mock = createMockProviderFactory({
    onPerform: (input) => frameGate.onPerform(input),
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const phone = ownerAuth('phone-1', 'Android Phone');

  const opened = await service.control({ action: 'open', botId: 'bot-a', url: 'https://example.test/public' }, desktop);
  const takenA = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: takenA.lease,
    url: 'https://example.test/signin',
  }, desktop);

  // 1. In-flight sensitive frame WITH lease is rejected when phone preempts desktop.
  const gate1 = frameGate.arm();
  const framePromise1 = service.control({
    action: 'frame',
    botId: 'bot-a',
    lease: takenA.lease,
  }, desktop);
  await gate1.started;

  const takenB = await service.control({ action: 'takeover', botId: 'bot-a', force: true }, phone);
  assert.equal(takenB.phase, 'human');
  assert.equal(takenB.holderLabel, 'Android Phone');

  gate1.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => framePromise1, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  // 2. In-flight sensitive frame WITHOUT lease (clientId semantics) is also rejected when desktop preempts phone.
  const gate2 = frameGate.arm();
  const framePromise2 = service.control({
    action: 'frame',
    botId: 'bot-a',
  }, phone);
  await gate2.started;

  const takenC = await service.control({ action: 'takeover', botId: 'bot-a', force: true }, desktop);
  gate2.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => framePromise2, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  // 3. Current active holder can still fetch fresh sensitive frames (both with lease and via clientId without lease).
  const okWithLease = await service.control({ action: 'frame', botId: 'bot-a', lease: takenC.lease }, desktop);
  assert.equal(okWithLease.mimeType, 'image/png');
  const okWithoutLease = await service.control({ action: 'frame', botId: 'bot-a' }, desktop);
  assert.equal(okWithoutLease.mimeType, 'image/png');

  await service.close();
});

test('in-flight sensitive frame is withheld when lease expires during async capture and post-expiry pre-check blocks before provider', async () => {
  let clock = 2_000_000;
  const host = createFakeHost(['bot-a']);
  const frameGate = createFrameGateController();
  const mock = createMockProviderFactory({
    onPerform: (input) => frameGate.onPerform(input),
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
    now: () => clock,
    leaseTtlMs: 5_000,
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const opened = await service.control({ action: 'open', botId: 'bot-a', url: 'https://example.test/public' }, desktop);
  const taken1 = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken1.lease,
    url: 'https://example.test/signin',
  }, desktop);

  // 1. Lease expires while frame (with lease) is in flight -> withheld and transitions fail-closed into held.
  const gate1 = frameGate.arm();
  const framePromise1 = service.control({
    action: 'frame',
    botId: 'bot-a',
    lease: taken1.lease,
  }, desktop);
  await gate1.started;

  clock += 6_000;
  gate1.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => framePromise1, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  const heldStatus = await service.control({ action: 'status', botId: 'bot-a' }, desktop);
  assert.equal(heldStatus.phase, 'held');
  assert.equal(heldStatus.reason, 'disconnected_hold');

  // 2. Pre-capture check blocks expired holder BEFORE hitting provider (both with old lease and without lease).
  const frameCallsBefore = mock.calls.filter((c) => c.action === 'frame').length;
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a', lease: taken1.lease }, desktop),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a' }, desktop),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  assert.equal(mock.calls.filter((c) => c.action === 'frame').length, frameCallsBefore);

  // 3. Resume takeover, then let lease expire during a lease-less in-flight sensitive frame -> also withheld.
  const resumed = await service.control({ action: 'takeover', botId: 'bot-a', resume: true }, desktop);
  assert.equal(resumed.phase, 'human');
  const gate2 = frameGate.arm();
  const framePromise2 = service.control({ action: 'frame', botId: 'bot-a' }, desktop);
  await gate2.started;

  clock += 6_000;
  gate2.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => framePromise2, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  await service.close();
});

test('in-flight sensitive frame is withheld on handback or release during async capture without corrupting state', async () => {
  const host = createFakeHost(['bot-a']);
  const frameGate = createFrameGateController();
  const mock = createMockProviderFactory({
    onPerform: (input) => frameGate.onPerform(input),
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const opened = await service.control({ action: 'open', botId: 'bot-a', url: 'https://example.test/public' }, desktop);

  // 1. Handback during capture: started on normal page, handed back, frame resolves with sensitive password hint.
  const taken1 = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  const gate1 = frameGate.arm();
  const framePromise1 = service.control({ action: 'frame', botId: 'bot-a', lease: taken1.lease }, desktop);
  await gate1.started;

  const handedBack1 = await service.control({ action: 'handback', botId: 'bot-a', lease: taken1.lease }, desktop);
  assert.equal(handedBack1.phase, 'bot');

  gate1.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/public',
    title: 'Synthetic Password Step',
    hints: { hasPasswordInput: true },
  }));
  await assert.rejects(() => framePromise1, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  // 2. Handback after navigating away: stale in-flight sensitive frame is rejected and does NOT roll state back.
  const taken2 = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken2.lease,
    url: 'https://example.test/signin',
  }, desktop);

  const gate2 = frameGate.arm();
  const framePromise2 = service.control({ action: 'frame', botId: 'bot-a', lease: taken2.lease }, desktop);
  await gate2.started;

  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken2.lease,
    url: 'https://example.test/done',
  }, desktop);
  const handedBack2 = await service.control({ action: 'handback', botId: 'bot-a', lease: taken2.lease }, desktop);
  assert.equal(handedBack2.phase, 'bot');

  // open(docGen=2) -> navigate signin(docGen=3) -> navigate done(docGen=4); stale frame carries docGen=3.
  gate2.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    documentGeneration: 3,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => framePromise2, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  const statusAfterHandback = await service.control({ action: 'status', botId: 'bot-a' }, desktop);
  assert.equal(statusAfterHandback.phase, 'bot');
  assert.equal(statusAfterHandback.sensitive, false);
  assert.equal(statusAfterHandback.tabs[0]?.url, 'https://example.test/done');

  // 3. Release during in-flight sensitive frame: even a minimal payload without url/hints is withheld and does not resurrect tabs.
  const taken3 = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken3.lease,
    url: 'https://example.test/signin',
  }, desktop);

  const gate3 = frameGate.arm();
  const framePromise3 = service.control({ action: 'frame', botId: 'bot-a', lease: taken3.lease }, desktop);
  await gate3.started;

  const released = await service.control({ action: 'release', botId: 'bot-a', lease: taken3.lease }, desktop);
  assert.equal(released.phase, 'bot');
  assert.equal(released.tabs.length, 0);

  gate3.resolve(syntheticFramePayload({ pageId: opened.pageId }));
  await assert.rejects(() => framePromise3, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  const statusAfterRelease = await service.control({ action: 'status', botId: 'bot-a' }, desktop);
  assert.equal(statusAfterRelease.phase, 'bot');
  assert.equal(statusAfterRelease.tabs.length, 0);
  assert.equal(statusAfterRelease.pageId, undefined);

  await service.close();
});

test('lease-less sensitive frame keeps clientId semantics on same generation but rejects same clientId re-acquired lease generation', async () => {
  let clock = 3_000_000;
  const host = createFakeHost(['bot-a']);
  const frameGate = createFrameGateController();
  const mock = createMockProviderFactory({
    onPerform: (input) => frameGate.onPerform(input),
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
    now: () => clock,
    leaseTtlMs: 5_000,
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const phone = ownerAuth('phone-1', 'Android Phone');

  const opened = await service.control({ action: 'open', botId: 'bot-a', url: 'https://example.test/public' }, desktop);
  const taken1 = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);
  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken1.lease,
    url: 'https://example.test/signin',
  }, desktop);

  // 1. Same generation + heartbeat renewal while lease-less frame is in flight -> allowed.
  const gateRenew = frameGate.arm();
  const renewFramePromise = service.control({ action: 'frame', botId: 'bot-a' }, desktop);
  await gateRenew.started;

  clock += 3_000;
  await service.control({ action: 'status', botId: 'bot-a', lease: taken1.lease }, desktop);
  clock += 3_000;

  gateRenew.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  const renewedFrame = await renewFramePromise;
  assert.equal(renewedFrame.mimeType, 'image/png');

  // 2. Same clientId force-rotates lease (new generation) while lease-less frame is in flight -> rejected.
  const gateRotate = frameGate.arm();
  const rotateFramePromise = service.control({ action: 'frame', botId: 'bot-a' }, desktop);
  await gateRotate.started;

  const taken2 = await service.control({
    action: 'takeover',
    botId: 'bot-a',
    lease: taken1.lease,
    force: true,
  }, desktop);
  assert.notEqual(taken2.lease, taken1.lease);

  gateRotate.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => rotateFramePromise, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  // 3. Same clientId expires and resumes takeover (new generation) while lease-less frame is in flight -> rejected.
  const gateResume = frameGate.arm();
  const resumeFramePromise = service.control({ action: 'frame', botId: 'bot-a' }, desktop);
  await gateResume.started;

  clock += 6_000;
  const taken3 = await service.control({ action: 'takeover', botId: 'bot-a', resume: true }, desktop);
  assert.notEqual(taken3.lease, taken2.lease);

  gateResume.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => resumeFramePromise, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  // 4. Phone preempts then desktop preempts back (new generation for same clientId) -> rejected.
  const gateBounce = frameGate.arm();
  const bounceFramePromise = service.control({ action: 'frame', botId: 'bot-a' }, desktop);
  await gateBounce.started;

  await service.control({ action: 'takeover', botId: 'bot-a', force: true }, phone);
  const taken5 = await service.control({ action: 'takeover', botId: 'bot-a', force: true }, desktop);
  assert.notEqual(taken5.lease, taken3.lease);

  gateBounce.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/signin',
    title: 'Synthetic Sign-in',
  }));
  await assert.rejects(() => bounceFramePromise, { code: 'BROWSER_SENSITIVE_BLOCKED' });

  // Fresh lease-less request under the latest generation succeeds.
  const freshFrame = await service.control({ action: 'frame', botId: 'bot-a' }, desktop);
  assert.equal(freshFrame.mimeType, 'image/png');

  await service.close();
});

test('human frame retains pre-capture gate, never relaxes secret risk, and preserves normal viewing policy', async () => {
  const host = createFakeHost(['bot-a']);
  const frameGate = createFrameGateController();
  const mock = createMockProviderFactory({
    onPerform: (input) => frameGate.onPerform(input),
  });
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
    resolveConversationBot: async () => 'bot-a',
  });

  const desktop = ownerAuth('desktop-1', 'MacBook-Pro');
  const phone = ownerAuth('phone-1', 'Android Phone');
  const viewer = { role: 'viewer', clientId: 'viewer-1', holderLabel: 'Read-only Viewer', authenticated: true };

  const opened = await service.control({ action: 'open', botId: 'bot-a', url: 'https://example.test/public' }, desktop);
  const takenDesktop = await service.control({ action: 'takeover', botId: 'bot-a' }, desktop);

  // 1. Normal viewing policy preserved for bystander owner and read-only viewer on non-sensitive pages.
  const phoneNormal = await service.control({ action: 'frame', botId: 'bot-a' }, phone);
  assert.equal(phoneNormal.mimeType, 'image/png');
  const viewerNormal = await service.control({ action: 'frame', botId: 'bot-a' }, viewer);
  assert.equal(viewerNormal.mimeType, 'image/png');

  // In-flight normal frame still succeeds even if lease holder changes while page stays non-sensitive.
  const gateNormal = frameGate.arm();
  const normalPromise = service.control({ action: 'frame', botId: 'bot-a', lease: takenDesktop.lease }, desktop);
  await gateNormal.started;

  const takenPhone = await service.control({ action: 'takeover', botId: 'bot-a', force: true }, phone);
  gateNormal.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/public',
    title: 'Public Page',
  }));
  const normalFrame = await normalPromise;
  assert.equal(normalFrame.mimeType, 'image/png');

  // 2. Post-capture secret risk is NEVER relaxed even when the exact same active holder captures the frame.
  const gateSecret = frameGate.arm();
  const secretPromise = service.control({ action: 'frame', botId: 'bot-a', lease: takenPhone.lease }, phone);
  await gateSecret.started;

  gateSecret.resolve(syntheticFramePayload({
    pageId: opened.pageId,
    url: 'https://example.test/public',
    title: 'Synthetic Secret Dialog',
    hints: { secretDialogVisible: true },
  }));
  await assert.rejects(
    () => secretPromise,
    (err) => err?.code === 'BROWSER_SECRET_STEP_BLOCKED' && err?.details?.fallbackToSystemBrowser === true
  );

  // 3. Pre-capture gate still blocks known secret and sensitive pages BEFORE calling provider.perform(frame).
  const frameCallsBeforePreCheck = mock.calls.filter((c) => c.action === 'frame').length;
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a', lease: takenPhone.lease }, phone),
    { code: 'BROWSER_SECRET_STEP_BLOCKED' }
  );

  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: takenPhone.lease,
    url: 'https://example.test/signin',
  }, phone);
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a' }, desktop),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a' }, viewer),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  assert.equal(mock.calls.filter((c) => c.action === 'frame').length, frameCallsBeforePreCheck);

  await service.close();
});
