import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotBrowserService } from '../../host-core/bot-browser/service.js';
import { botBrowserProfileDirectory } from '../../host-core/bot-browser/protocol.js';
import {
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

test('per-bot profile isolation and persistent conversation ownership binding', async () => {
  assert.throws(() => botBrowserProfileDirectory('/tmp/root', '../escape'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => botBrowserProfileDirectory('/tmp/root', 'a/b'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => botBrowserProfileDirectory('/tmp/root', 'C:evil'), { code: 'INVALID_ARGUMENT' });

  const host = createFakeHost(['bot-a', 'bot-b']);
  const mock = createMockProviderFactory();
  const service = createBotBrowserService({
    host,
    createProvider: mock.factory,
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
  await service.control({
    action: 'navigate',
    botId: 'bot-a',
    lease: taken.lease,
    url: 'https://accounts.google.com/v3/signin',
  }, desktop);
  await assert.rejects(
    () => service.control({ action: 'frame', botId: 'bot-a' }, phone),
    { code: 'BROWSER_SENSITIVE_BLOCKED' }
  );
  // Active holder CAN view non-secret sensitive page during takeover (e.g. to finish sign-in or navigate away).
  const holderFrame = await service.control({ action: 'frame', botId: 'bot-a', lease: taken.lease }, desktop);
  assert.equal(holderFrame.mimeType, 'image/png');

  // 6. Web Gmail login flags webLoginNotApiGrant (Google API grant != web login).
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
