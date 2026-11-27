// Unit and integration tests for Center-side Proactive Google Workspace Assistant:
// - Frozen contract constants (`center-contract/google-workspace.js`)
// - SQLite singleton binding CRUD, `botContent()` `effectiveConfig.proactiveAssistant` injection/clearing,
//   and automatic pause/cancellation when bound Bot is archived or deleted
// - Shared Gmail/Calendar polling, 0-LLM noise filter, 4-mail thread folding, batch window & digest flush,
//   empty-bucket 0-event guarantee, and timely Calendar pre-meeting alerts (never delayed by email batching)
// - `x-pibot-google-assistant: batch-v1` poll capability header gating (old Hosts receive nothing)
// - HTTP `/api/google/assistant/*` routes including `/api/google/assistant/setup` (dedicated & existing modes)
// - Built-in Center operations `automation_google_assistant_{get,configure,remove}` Bot + OAuth MCP parity
//   and unauthorized/consent-bypass rejection.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_GOOGLE_ASSISTANT_SOUL,
  GOOGLE_ASSISTANT_ALLOWED_TOOLS,
  GOOGLE_ASSISTANT_BOARD_RESULT_KIND,
  GOOGLE_ASSISTANT_DESENSITIZED_BOARD_SUMMARY,
  GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW,
  GOOGLE_ASSISTANT_POLL_HEADER,
  GOOGLE_ASSISTANT_POLL_VALUE,
  GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
  GOOGLE_WORKSPACE_DATA_BOUNDARY,
  GOOGLE_WORKSPACE_INSTALLATION_ID,
  GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
} from '../../center-contract/google-workspace.js';
import { googleRuleOperations } from '../../center-contract/operations/google-rules.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openGoogleRules } from '../../center-server/google-workspace/rules.js';
import { GoogleToolError } from '../../center-server/google-workspace/rules-orca.js';
import { registerGoogleWorkspaceRoutes } from '../../center-server/google-workspace/routes.js';
import { registerWebhookRoutes } from '../../center-server/webhooks.js';
import { createGoogleRuleHandlers } from '../../center-server/operations/google-rules.js';
import { openOperations } from '../../center-server/operations/index.js';
import { invokeOwnerAction, retainOwnerAction } from '../../center-server/operations/owner-actions.js';

const GMAIL_PATH = '/gmail/v1/users/me';
const PRIMARY_EVENTS_PATH = '/calendar/v3/calendars/primary/events';
const NOW = new Date(2026, 10, 20, 8, 30, 0, 0).getTime();

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-google-assistant-center-'));
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  store.replaceDeviceBots('dev-1', [
    { deviceId: 'dev-1', botId: 'bot-1', name: 'MainBot', isPrimary: true },
    { deviceId: 'dev-1', botId: 'bot-2', name: 'OtherBot', isPrimary: false },
  ]);
  store.replaceDeviceBots('dev-2', [
    { deviceId: 'dev-2', botId: 'bot-remote', name: 'RemoteBot', isPrimary: true },
  ]);
  return {
    store,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeFakeApi(email, routes) {
  const calls = [];
  const invoke = async (service, urlString, read, allow404) => {
    const url = new URL(urlString);
    calls.push(url);
    for (const route of routes) {
      const answer = route(url, service);
      if (answer) {
        if (allow404 && answer.status === 404) return null;
        if (answer.status < 200 || answer.status >= 300) {
          const err = new GoogleToolError(answer.message ?? `Google HTTP ${answer.status}`, answer.status);
          if (answer.code) err.code = answer.code;
          throw err;
        }
        const parsed = read(answer.body);
        if (parsed === null) throw new Error('Unexpected response shape');
        return parsed;
      }
    }
    throw new GoogleToolError(`Unhandled route ${url.pathname}`, 404);
  };
  return {
    calls,
    api: {
      email,
      get: (service, url, read) => invoke(service, url, read, false),
      find: (service, url, read) => invoke(service, url, read, true),
      send: async () => { throw new Error('unexpected write'); },
      bytes: async () => { throw new Error('unexpected bytes'); },
    },
  };
}

const authResults = (verdict, domain = 'acme.com') =>
  `mx.google.com; spf=pass smtp.mailfrom=${domain}; dmarc=${verdict} (p=REJECT) header.from=${domain}`;

function gmailMessage(id, options = {}) {
  return {
    id,
    threadId: options.threadId ?? `t-${id}`,
    labelIds: options.labels ?? ['INBOX', 'UNREAD'],
    snippet: options.snippet ?? 'Please review the attached contract update.',
    internalDate: String(options.at ?? NOW + 30_000),
    payload: {
      headers: [
        ...(options.auth ?? [authResults('pass')]).map(value => ({
          name: 'Authentication-Results',
          value,
        })),
        { name: 'From', value: options.from ?? 'Sam Lee <sam@acme.com>' },
        { name: 'To', value: options.to ?? 'ada@acme.dev' },
        { name: 'Subject', value: options.subject ?? 'Contract update' },
      ],
    },
  };
}

function makeDynamicGmailRoutes(getAdded, getNextHistoryId) {
  return [
    url => (url.pathname === `${GMAIL_PATH}/profile` ? { status: 200, body: { historyId: '100' } } : null),
    url => (url.pathname === `${GMAIL_PATH}/history`
      ? {
        status: 200,
        body: {
          historyId: getNextHistoryId(),
          history: getAdded().map(entry => ({
            messagesAdded: [
              { message: { id: entry.id, threadId: entry.threadId, labelIds: entry.labelIds } },
            ],
          })),
        },
      }
      : null),
    url => {
      const found = getAdded().find(entry => url.pathname === `${GMAIL_PATH}/messages/${entry.id}`);
      return found ? { status: 200, body: found } : null;
    },
  ];
}

function calendarRoutes(events, baseNowMs = NOW) {
  let seeds = 0;
  return [
    url => {
      if (url.pathname !== PRIMARY_EVENTS_PATH) return null;
      if (url.searchParams.has('fields')) {
        return { status: 200, body: { items: [], nextSyncToken: `sync-${++seeds}` } };
      }
      return {
        status: 200,
        body: {
          items: events.map(event => ({
            id: event.id,
            summary: event.summary ?? 'Architecture Sync',
            start: { dateTime: new Date(baseNowMs + event.startsIn).toISOString() },
            end: { dateTime: new Date(baseNowMs + event.startsIn + 1_800_000).toISOString() },
            attendees: [
              { email: 'ada@acme.dev', self: true, responseStatus: 'accepted' },
            ],
          })),
        },
      };
    },
  ];
}

function makeRouteHarness({ store, google, rules, bridge, learning, notifyDevice }) {
  const ownerActions = new Map();
  const ownerRoutes = new Map();
  const hostRoutes = new Map();

  const route = (method, pattern, handler) => {
    retainOwnerAction(ownerActions, method, pattern, handler);
    ownerRoutes.set(`${method} ${pattern}`, handler);
  };
  const host = (method, pattern, handler) => {
    hostRoutes.set(`${method} ${pattern}`, handler);
  };
  const appStub = {
    get() {},
    post() {},
    rateLimit() { return () => {}; },
  };

  registerGoogleWorkspaceRoutes(appStub, {
    route,
    store,
    bridge,
    publicUrl: 'https://center.example.com/',
    google: { accounts: google, rules },
    notifyDevice,
    learning,
  });
  registerWebhookRoutes(appStub, {
    store,
    bridge,
    route,
    host,
    publicUrl: 'https://center.example.com/',
    notify: () => {},
  });

  async function callMap(map, method, pattern, req = {}) {
    const handler = map.get(`${method} ${pattern}`);
    if (!handler) throw Object.assign(new Error(`Unknown route: ${method} ${pattern}`), { code: 'NOT_FOUND' });
    let statusCode = 200;
    let sent = false;
    let payload;
    const reply = {
      header() { return reply; },
      code(code) { statusCode = code; return reply; },
      send(value) { sent = true; payload = value; return value; },
    };
    const returned = await handler(
      { params: {}, query: {}, headers: {}, ...req },
      reply,
    );
    const value = sent ? payload : returned;
    if (statusCode >= 400) {
      throw Object.assign(new Error(value?.error?.message || value?.error?.code || 'ERROR'), {
        code: value?.error?.code || 'INTERNAL_ERROR',
        statusCode,
      });
    }
    return { statusCode, body: value };
  }

  return {
    ownerActions,
    callOwner: (method, pattern, req) => callMap(ownerRoutes, method, pattern, req),
    callHost: (method, pattern, req) => callMap(hostRoutes, method, pattern, req),
    ownerAdapter: (method, path, input) => invokeOwnerAction(ownerActions, method, path, input),
  };
}

test('Frozen Google Workspace contract constants and assistant operation descriptors match specification', () => {
  assert.equal(GOOGLE_WORKSPACE_INSTALLATION_ID, 'builtin.google-workspace');
  assert.equal(GOOGLE_WORKSPACE_DATA_BOUNDARY, 'google-workspace');
  assert.equal(GOOGLE_WORKSPACE_RULE_SOURCE_TYPE, 'google-workspace-rule');
  assert.equal(GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE, 'google-workspace-assistant');
  assert.equal(GOOGLE_ASSISTANT_POLL_HEADER, 'x-pibot-google-assistant');
  assert.equal(GOOGLE_ASSISTANT_POLL_VALUE, 'batch-v1');
  assert.equal(GOOGLE_ASSISTANT_BOARD_RESULT_KIND, 'proactive-google');
  assert.equal(GOOGLE_ASSISTANT_DESENSITIZED_PREVIEW, '邮件与日程更新');
  assert.equal(GOOGLE_ASSISTANT_DESENSITIZED_BOARD_SUMMARY, '有新的邮件或日程待查看');
  assert.deepEqual(GOOGLE_ASSISTANT_ALLOWED_TOOLS, [
    'gmail_search',
    'gmail_read',
    'gmail_draft',
    'calendar_list',
    'calendar_get',
    'calendar_suggest-time',
    'contacts_find',
    'drive_search',
    'drive_list',
    'drive_read',
    'docs_read',
    'sheets_read',
  ]);
  assert.equal(Object.isFrozen(GOOGLE_ASSISTANT_ALLOWED_TOOLS), true);
  assert.equal(typeof DEFAULT_GOOGLE_ASSISTANT_SOUL, 'string');
  assert.match(DEFAULT_GOOGLE_ASSISTANT_SOUL, /\(pass\)/);
  assert.match(DEFAULT_GOOGLE_ASSISTANT_SOUL, /gmail_draft/);
  assert.match(DEFAULT_GOOGLE_ASSISTANT_SOUL, /Hindsight/);

  const assistantOps = googleRuleOperations.filter(op => op.name.startsWith('automation_google_assistant_'));
  assert.deepEqual(assistantOps.map(op => op.name), [
    'automation_google_assistant_get',
    'automation_google_assistant_configure',
    'automation_google_assistant_remove',
  ]);
  const getOp = assistantOps.find(op => op.name === 'automation_google_assistant_get');
  const cfgOp = assistantOps.find(op => op.name === 'automation_google_assistant_configure');
  const remOp = assistantOps.find(op => op.name === 'automation_google_assistant_remove');
  assert.equal(getOp.readOnly, true);
  assert.equal(getOp.destructive, false);
  assert.equal(cfgOp.readOnly, false);
  assert.equal(cfgOp.destructive, false);
  assert.equal('hindsightPrivateMemory' in cfgOp.inputSchema.properties, false);
  assert.equal(remOp.readOnly, false);
  assert.equal(remOp.destructive, true);

  const handlers = createGoogleRuleHandlers({});
  for (const op of assistantOps) {
    assert.equal(typeof handlers[op.name], 'function');
  }
});

test('SQLite store CRUD, botContent effectiveConfig.proactiveAssistant injection/clearing, and Bot archival/deletion pause', () => {
  const { store, cleanup } = makeStore();
  try {
    assert.equal(store.getGoogleAssistant(), null);

    // Unbound snapshot has empty effectiveConfig on builtin.google-workspace.
    const snapBefore = store.getDeviceSnapshot('dev-1', 'wss://center.test/v1/link');
    const bot1Before = snapBefore.bots.find(b => b.botId === 'bot-1');
    const gwBefore = bot1Before.capabilities.find(c => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID);
    assert.deepEqual(gwBefore.effectiveConfig, {});
    const turnBefore = store.getBotTurnContext('dev-1', 'bot-1');

    // Save dedicated binding on dev-1/bot-1.
    const saved = store.saveGoogleAssistant({
      enabled: true,
      deviceId: 'dev-1',
      botId: 'bot-1',
      mode: 'dedicated',
      accounts: ['Bob@Acme.dev', 'ada@acme.dev', 'ada@acme.dev'],
      batchWindowMinutes: 12,
      digestTimes: [],
      calendarEnabled: true,
      calendarLeadMinutes: 15,
    }, NOW);
    assert.equal(saved.revision, 1);
    assert.deepEqual(saved.accounts, ['ada@acme.dev', 'bob@acme.dev']);
    assert.equal(saved.hindsightPrivateMemory, true);
    assert.equal(saved.listeningSince, new Date(NOW).toISOString());

    // Bound Bot gets proactiveAssistant effectiveConfig; sibling Bot stays {}; checksum & revision update.
    const snapBound = store.getDeviceSnapshot('dev-1', 'wss://center.test/v1/link');
    assert.ok(snapBound.revision > snapBefore.revision);
    const gwBot1 = snapBound.bots.find(b => b.botId === 'bot-1').capabilities
      .find(c => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID);
    const gwBot2 = snapBound.bots.find(b => b.botId === 'bot-2').capabilities
      .find(c => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID);
    assert.deepEqual(gwBot1.effectiveConfig, {
      proactiveAssistant: {
        role: 'dedicated',
        accounts: ['ada@acme.dev', 'bob@acme.dev'],
        hindsightPrivateMemory: true,
      },
    });
    assert.deepEqual(gwBot2.effectiveConfig, {});
    const turnBound = store.getBotTurnContext('dev-1', 'bot-1');
    assert.notEqual(turnBound.checksum, turnBefore.checksum);

    // CAS mismatch fails cleanly.
    assert.throws(
      () => store.saveGoogleAssistant({
        enabled: true,
        deviceId: 'dev-1',
        botId: 'bot-1',
        mode: 'dedicated',
        accounts: ['ada@acme.dev'],
        expectedRevision: 99,
      }, NOW + 1000),
      err => err.code === 'REVISION_CONFLICT',
    );

    // Enqueue a pending assistant event, then archive bot-1 -> event cancelled and assistant paused!
    const enq = store.enqueueGoogleAssistantEvent({
      deviceId: 'dev-1',
      botId: 'bot-1',
      account: 'ada@acme.dev',
      source: 'gmail',
      eventKey: 'gassist:gmail:ada@acme.dev:test-archive',
      instruction: 'Check batch',
      payloadJson: JSON.stringify({ kind: 'google_assistant_batch' }),
      nowMs: NOW + 1000,
    });
    assert.equal(enq.created, true);
    assert.equal(enq.event.status, 'pending');

    store.upsertDeviceBot('dev-1', {
      deviceId: 'dev-1',
      botId: 'bot-1',
      name: 'MainBot',
      archivedAt: new Date(NOW + 2000).toISOString(),
    });
    const afterArchive = store.getGoogleAssistant();
    assert.equal(afterArchive.enabled, false);
    const eventsAfterArchive = store.listGoogleAssistantEvents({ nowMs: NOW + 2000 });
    assert.equal(eventsAfterArchive[0].status, 'cancelled');

    const snapPaused = store.getDeviceSnapshot('dev-1', 'wss://center.test/v1/link');
    const gwPaused = snapPaused.bots.find(b => b.botId === 'bot-1').capabilities
      .find(c => c.installationId === GOOGLE_WORKSPACE_INSTALLATION_ID);
    assert.deepEqual(gwPaused.effectiveConfig, {});

    // Rebind to bot-2 and remove bot-2 -> assistant pauses and pending event cancels.
    store.saveGoogleAssistant({
      enabled: true,
      deviceId: 'dev-1',
      botId: 'bot-2',
      mode: 'existing',
      accounts: ['ada@acme.dev'],
    }, NOW + 3000);
    assert.equal(store.getGoogleAssistant().hindsightPrivateMemory, false);
    store.enqueueGoogleAssistantEvent({
      deviceId: 'dev-1',
      botId: 'bot-2',
      account: 'ada@acme.dev',
      source: 'gmail',
      eventKey: 'gassist:gmail:ada@acme.dev:test-delete',
      instruction: 'Check batch',
      payloadJson: JSON.stringify({ kind: 'google_assistant_batch' }),
      nowMs: NOW + 3500,
    });
    store.removeDeviceBot('dev-1', 'bot-2');
    assert.equal(store.getGoogleAssistant().enabled, false);
    assert.equal(store.listGoogleAssistantEvents({ nowMs: NOW + 4000 })[0].status, 'cancelled');

    // Remove binding completely.
    const removed = store.removeGoogleAssistant(NOW + 5000);
    assert.equal(removed.removed, true);
    assert.equal(store.getGoogleAssistant(), null);
  } finally {
    cleanup();
  }
});

test('Gmail 0-LLM noise filter, 4-mail thread folding, batch window flush, empty-bucket 0 events, and shared polling with static rules', async () => {
  const { store, cleanup } = makeStore();
  let now = NOW;
  let currentAdded = [];
  let nextHistoryId = '100';
  const woken = [];
  try {
    const fake = makeFakeApi(
      'ada@acme.dev',
      makeDynamicGmailRoutes(() => currentAdded, () => nextHistoryId),
    );
    const google = {
      status: async () => ({
        client: { configured: true },
        accounts: [{
          id: 'acc-1',
          email: 'ada@acme.dev',
          status: 'connected',
          services: [
            { service: 'gmail', state: 'ready' },
            { service: 'calendar', state: 'ready' },
          ],
        }],
      }),
      api: async () => fake.api,
    };

    const rules = openGoogleRules({
      store,
      google,
      notify: deviceId => woken.push(deviceId),
      now: () => now,
    });

    // Enable assistant (dedicated, 10m window, no digest slots) AND a static Gmail rule on same account.
    await rules.assistantManage('save', {
      enabled: true,
      deviceId: 'dev-1',
      botId: 'bot-1',
      mode: 'dedicated',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: 10,
      digestTimes: [],
      calendarEnabled: false,
    });
    await rules.manage('save', {
      deviceId: 'dev-1',
      botId: 'bot-2',
      account: 'ada@acme.dev',
      source: 'gmail',
      enabled: true,
      from: ['vip.com'],
      instruction: 'Notify VIP mail.',
    });

    // Tick 1: seeds historyId only (0 events).
    await rules.tick();
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '100');
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);

    // Tick 2: ONLY promotional/social/forum noise arrives -> filtered cleanly, bucket stays empty, 0 events!
    now += 60_000;
    nextHistoryId = '110';
    currentAdded = [
      gmailMessage('noise-1', { at: now, labels: ['INBOX', 'CATEGORY_PROMOTIONS'], from: 'deals@shop.com', subject: '50% off' }),
      gmailMessage('noise-2', { at: now, labels: ['INBOX', 'CATEGORY_SOCIAL'], from: 'social@net.com', subject: 'New follower' }),
      gmailMessage('noise-3', { at: now, labels: ['INBOX', 'CATEGORY_FORUMS'], from: 'list@forum.org', subject: 'Digest' }),
    ];
    await rules.tick();
    assert.equal((await rules.assistantManage('get')).runtime.pendingBucketCount, 0);

    // Advance past 10m window with empty bucket -> STILL 0 events!
    now += 15 * 60_000;
    currentAdded = [];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);

    // Tick 4: 4 messages in ONE thread + 1 starred promotion + 1 VIP static rule mail in ONE shared poll!
    const historyCallsBefore = fake.calls.filter(u => u.pathname === `${GMAIL_PATH}/history`).length;
    now += 60_000;
    nextHistoryId = '125';
    currentAdded = [
      gmailMessage('m1', { threadId: 't-deal', at: now, from: 'Alice <alice@acme.com>', subject: 'Q4 Deal', snippet: 'Msg 1' }),
      gmailMessage('m2', { threadId: 't-deal', at: now + 1000, from: 'Bob <bob@acme.com>', subject: 'Re: Q4 Deal', snippet: 'Msg 2' }),
      gmailMessage('m3', { threadId: 't-deal', at: now + 2000, from: 'Alice <alice@acme.com>', subject: 'Re: Q4 Deal', snippet: 'Msg 3' }),
      gmailMessage('m4', { threadId: 't-deal', at: now + 3000, from: 'Alice <alice@acme.com>', subject: 'Re: Q4 Deal', snippet: 'Final terms ready' }),
      gmailMessage('m-star', { threadId: 't-star', at: now + 4000, labels: ['INBOX', 'CATEGORY_PROMOTIONS', 'STARRED'], from: 'promo@vip.com', auth: [authResults('pass', 'vip.com')], subject: 'Starred VIP Promo' }),
    ];
    await rules.tick();
    const historyCallsAfter = fake.calls.filter(u => u.pathname === `${GMAIL_PATH}/history`).length;
    // Shared poll: exactly ONE Gmail history call served BOTH static rule and assistant!
    assert.equal(historyCallsAfter - historyCallsBefore, 1);

    // Static rule fired immediately for vip.com, while assistant folded 5 messages into 2 threads waiting for 10m window!
    const state = store.getGoogleTriggerState();
    assert.equal(state.assistantBucket['ada@acme.dev'].threads['t-deal'].messageCount, 4);
    assert.equal(state.assistantBucket['ada@acme.dev'].threads['t-deal'].latestMessageId, 'm4');
    assert.equal(state.assistantBucket['ada@acme.dev'].threads['t-deal'].snippet, 'Final terms ready');
    assert.equal(state.assistantBucket['ada@acme.dev'].threads['t-star'].priority, 'high');
    assert.equal((await rules.assistantManage('get')).runtime.pendingBucketCount, 2);
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);

    // 5 minutes later: still inside 10m batch window -> 0 assistant events.
    now += 5 * 60_000;
    currentAdded = [];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);

    // 10 minutes after bucket open -> flushes into ONE deterministic batch event and clears bucket!
    now += 5 * 60_000;
    await rules.tick();
    const flushedEvents = store.listGoogleAssistantEvents({ nowMs: now });
    assert.equal(flushedEvents.length, 1);
    assert.equal(flushedEvents[0].source, 'gmail');
    assert.match(flushedEvents[0].eventKey, /^gassist:gmail:ada@acme\.dev:[0-9a-f]{64}$/);
    assert.equal((await rules.assistantManage('get')).runtime.pendingBucketCount, 0);

    // Poll with capability header and inspect folded payload.
    const poll = store.pollWebhookEvents('dev-1', null, now, { googleAssistantBatch: true });
    const assistantDelivery = poll.items.find(item => item.trustedSource === GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE);
    assert.ok(assistantDelivery);
    assert.equal(assistantDelivery.dataBoundary, GOOGLE_WORKSPACE_DATA_BOUNDARY);
    assert.equal(assistantDelivery.payload.kind, 'google_assistant_batch');
    assert.equal(assistantDelivery.payload.threadCount, 2);
    const dealThread = assistantDelivery.payload.threads.find(t => t.threadId === 't-deal');
    assert.equal(dealThread.messageCount, 4);
    assert.equal(dealThread.latestMessageId, 'm4');

    // Subsequent tick with empty bucket produces 0 new events.
    now += 15 * 60_000;
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 1);

    await rules.close();
  } finally {
    cleanup();
  }
});

test('Digest times separate routine automated mail until HH:mm slot while high-priority flushes after batch window', async () => {
  const { store, cleanup } = makeStore();
  // Local 08:40:00
  let now = new Date(2026, 10, 20, 8, 40, 0, 0).getTime();
  let currentAdded = [];
  let nextHistoryId = '100';
  try {
    const fake = makeFakeApi(
      'ada@acme.dev',
      makeDynamicGmailRoutes(() => currentAdded, () => nextHistoryId),
    );
    const google = {
      status: async () => ({
        client: { configured: true },
        accounts: [{
          id: 'acc-1',
          email: 'ada@acme.dev',
          status: 'connected',
          services: [{ service: 'gmail', state: 'ready' }],
        }],
      }),
      api: async () => fake.api,
    };
    const rules = openGoogleRules({ store, google, now: () => now });

    await rules.assistantManage('save', {
      enabled: true,
      deviceId: 'dev-1',
      botId: 'bot-1',
      mode: 'existing',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: 10,
      digestTimes: ['09:00', '18:00'],
      calendarEnabled: false,
    });

    // Seed historyId at 08:40.
    await rules.tick();

    // 08:41: 1 direct human high-priority mail + 1 automated routine mail arrive.
    now = new Date(2026, 10, 20, 8, 41, 0, 0).getTime();
    nextHistoryId = '105';
    currentAdded = [
      gmailMessage('m-high', { threadId: 't-high', at: now, from: 'CEO <ceo@acme.com>', subject: 'Need approval' }),
      gmailMessage('m-routine', { threadId: 't-routine', at: now, from: 'GitHub <notifications@github.com>', subject: 'Weekly summary' }),
    ];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);

    // 08:51 (+10m): ONLY high-priority flushes; routine stays buffered for 09:00 digest!
    now = new Date(2026, 10, 20, 8, 51, 0, 0).getTime();
    currentAdded = [];
    await rules.tick();
    const afterHigh = store.listGoogleAssistantEvents({ nowMs: now });
    assert.equal(afterHigh.length, 1);
    assert.equal((await rules.assistantManage('get')).runtime.pendingBucketCount, 1);
    const poll1 = store.pollWebhookEvents('dev-1', null, now, { googleAssistantBatch: true });
    assert.equal(poll1.items[0].payload.batchKind, 'high_priority');
    assert.deepEqual(poll1.items[0].payload.threads.map(t => t.threadId), ['t-high']);
    store.reportWebhookEvent('dev-1', poll1.items[0].id, { status: 'succeeded', error: null }, now + 1000);

    // 09:00: digest slot fires routine thread and clears bucket!
    now = new Date(2026, 10, 20, 9, 0, 0, 0).getTime();
    await rules.tick();
    const afterDigest = store.listGoogleAssistantEvents({ nowMs: now });
    assert.equal(afterDigest.length, 2);
    assert.equal((await rules.assistantManage('get')).runtime.pendingBucketCount, 0);
    const poll2 = store.pollWebhookEvents('dev-1', null, now, { googleAssistantBatch: true });
    assert.equal(poll2.items.length, 1);
    assert.equal(poll2.items[0].payload.batchKind, 'digest');
    assert.deepEqual(poll2.items[0].payload.threads.map(t => t.threadId), ['t-routine']);

    await rules.close();
  } finally {
    cleanup();
  }
});

test('High-priority batch window stays independent of older buffered routine threads waiting for digestTimes', async () => {
  const { store, cleanup } = makeStore();
  let now = new Date(2026, 10, 20, 7, 59, 0, 0).getTime();
  let currentAdded = [];
  let nextHistoryId = '100';
  try {
    const fake = makeFakeApi(
      'ada@acme.dev',
      makeDynamicGmailRoutes(() => currentAdded, () => nextHistoryId),
    );
    const google = {
      status: async () => ({
        client: { configured: true },
        accounts: [{
          id: 'acc-1',
          email: 'ada@acme.dev',
          status: 'connected',
          services: [{ service: 'gmail', state: 'ready' }],
        }],
      }),
      api: async () => fake.api,
    };
    const rules = openGoogleRules({ store, google, now: () => now });

    await rules.assistantManage('save', {
      enabled: true,
      deviceId: 'dev-1',
      botId: 'bot-1',
      mode: 'existing',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: 10,
      digestTimes: ['09:00', '18:00'],
      calendarEnabled: false,
    });

    // Seed historyId at 07:59.
    await rules.tick();

    // 08:00: routine automated email arrives (opens bucket at 08:00, highOpenedAtMs stays unset).
    now = new Date(2026, 10, 20, 8, 0, 0, 0).getTime();
    nextHistoryId = '101';
    currentAdded = [
      gmailMessage('m-r1', { threadId: 't-r1', at: now, from: 'CI <noreply@ci.acme.com>', subject: 'Nightly report' }),
    ];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);
    assert.equal(store.getGoogleTriggerState().assistantBucket['ada@acme.dev'].highOpenedAtMs, undefined);

    // 08:25 (25m after routine openedAtMs): first high-priority email arrives -> must NOT flush immediately!
    now = new Date(2026, 10, 20, 8, 25, 0, 0).getTime();
    nextHistoryId = '102';
    currentAdded = [
      gmailMessage('m-h1', { threadId: 't-h1', at: now, from: 'Alice <alice@acme.com>', subject: 'Budget Q4' }),
    ];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);
    assert.equal(store.getGoogleTriggerState().assistantBucket['ada@acme.dev'].highOpenedAtMs, now);

    // 08:30 (+5m): second high-priority email arrives -> folds with t-h1, still waits for 08:35!
    now = new Date(2026, 10, 20, 8, 30, 0, 0).getTime();
    nextHistoryId = '103';
    currentAdded = [
      gmailMessage('m-h2', { threadId: 't-h2', at: now, from: 'Bob <bob@acme.com>', subject: 'Client call' }),
    ];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 0);

    // 08:35 (+10m since 08:25): BOTH high-priority threads flush together in ONE batch, routine remains, highOpenedAtMs resets!
    now = new Date(2026, 10, 20, 8, 35, 0, 0).getTime();
    currentAdded = [];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 1);
    const pollHigh1 = store.pollWebhookEvents('dev-1', null, now, { googleAssistantBatch: true });
    assert.equal(pollHigh1.items.length, 1);
    assert.equal(pollHigh1.items[0].payload.batchKind, 'high_priority');
    assert.deepEqual(pollHigh1.items[0].payload.threads.map(t => t.threadId), ['t-h1', 't-h2']);
    store.reportWebhookEvent('dev-1', pollHigh1.items[0].id, { status: 'succeeded', error: null }, now + 1000);
    assert.equal(store.getGoogleTriggerState().assistantBucket['ada@acme.dev'].highOpenedAtMs, undefined);

    // 08:40: a third high-priority email arrives while routine is still waiting -> gets a fresh 10m window (08:40 -> 08:50)!
    now = new Date(2026, 10, 20, 8, 40, 0, 0).getTime();
    nextHistoryId = '104';
    currentAdded = [
      gmailMessage('m-h3', { threadId: 't-h3', at: now, from: 'Carol <carol@acme.com>', subject: 'Follow-up' }),
    ];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 1);

    now = new Date(2026, 10, 20, 8, 50, 0, 0).getTime();
    currentAdded = [];
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 2);
    const pollHigh2 = store.pollWebhookEvents('dev-1', null, now, { googleAssistantBatch: true });
    assert.equal(pollHigh2.items.length, 1);
    assert.deepEqual(pollHigh2.items[0].payload.threads.map(t => t.threadId), ['t-h3']);
    store.reportWebhookEvent('dev-1', pollHigh2.items[0].id, { status: 'succeeded', error: null }, now + 1000);

    // 09:00: digest slot flushes routine thread t-r1 cleanly.
    now = new Date(2026, 10, 20, 9, 0, 0, 0).getTime();
    await rules.tick();
    assert.equal(store.listGoogleAssistantEvents({ nowMs: now }).length, 3);
    const pollDigest = store.pollWebhookEvents('dev-1', null, now, { googleAssistantBatch: true });
    assert.equal(pollDigest.items.length, 1);
    assert.equal(pollDigest.items[0].payload.batchKind, 'digest');
    assert.deepEqual(pollDigest.items[0].payload.threads.map(t => t.threadId), ['t-r1']);

    await rules.close();
  } finally {
    cleanup();
  }
});

test('Calendar 15m timely alert fires immediately without waiting for Gmail batch window and marks offline meetings missed', async () => {
  const { store, cleanup } = makeStore();
  let now = NOW;
  const woken = [];
  try {
    const fake = makeFakeApi(
      'ada@acme.dev',
      calendarRoutes([
        { id: 'standup', summary: 'Daily Standup', startsIn: 10 * 60_000 },
        { id: 'later', summary: 'Later Review', startsIn: 3 * 3_600_000 },
      ], NOW),
    );
    const google = {
      status: async () => ({
        client: { configured: true },
        accounts: [{
          id: 'acc-1',
          email: 'ada@acme.dev',
          status: 'connected',
          services: [
            { service: 'gmail', state: 'needs-permission' },
            { service: 'calendar', state: 'ready' },
          ],
        }],
      }),
      api: async () => fake.api,
    };
    const rules = openGoogleRules({
      store,
      google,
      notify: deviceId => woken.push(deviceId),
      now: () => now,
    });

    // Large 60m Gmail batch window must NOT delay 15m Calendar pre-meeting alert!
    await rules.assistantManage('save', {
      enabled: true,
      deviceId: 'dev-1',
      botId: 'bot-1',
      mode: 'dedicated',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: 60,
      calendarEnabled: true,
      calendarLeadMinutes: 15,
    });

    await rules.tick();
    assert.deepEqual(woken, ['dev-1']);
    const events = store.listGoogleAssistantEvents({ nowMs: now });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'calendar');
    assert.match(events[0].eventKey, /^gassist:cal:ada@acme\.dev:/);
    assert.equal(events[0].status, 'pending');

    // Host stays offline past meeting start -> marked missed, never delivered late!
    now = NOW + 11 * 60_000;
    const pollLate = store.pollWebhookEvents('dev-1', null, now, { googleAssistantBatch: true });
    assert.equal(pollLate.items.length, 0);
    const afterStart = store.listGoogleAssistantEvents({ nowMs: now });
    assert.equal(afterStart[0].status, 'missed');
    assert.equal(afterStart[0].error.code, 'MEETING_STARTED_WHILE_OFFLINE');

    await rules.close();
  } finally {
    cleanup();
  }
});

test('x-pibot-google-assistant: batch-v1 poll header gates assistant events so old Hosts receive nothing', async () => {
  const { store, cleanup } = makeStore();
  const testNow = Date.now();
  try {
    const bridge = {
      deviceId: 'center-relay',
      registry: { get: id => (id === 'dev-1' ? { deviceId: 'dev-1', revokedAt: null } : null) },
      listDevices: () => [{ deviceId: 'dev-1', name: 'Dev 1', online: true }],
    };
    const google = {
      status: async () => ({
        configured: true,
        accounts: [{
          id: 'acc-1',
          email: 'ada@acme.dev',
          status: 'connected',
          services: [{ service: 'gmail', state: 'ready' }],
        }],
      }),
      api: async () => { throw new Error('unused'); },
    };
    const rules = openGoogleRules({ store, google, bridge, now: () => testNow });
    const harness = makeRouteHarness({ store, google, rules, bridge });

    store.saveGoogleAssistant({
      enabled: true,
      deviceId: 'dev-1',
      botId: 'bot-1',
      mode: 'dedicated',
      accounts: ['ada@acme.dev'],
    }, testNow);
    const { event } = store.enqueueGoogleAssistantEvent({
      deviceId: 'dev-1',
      botId: 'bot-1',
      account: 'ada@acme.dev',
      source: 'gmail',
      eventKey: 'gassist:gmail:ada@acme.dev:header-gate-1',
      instruction: 'Inspect batch',
      payloadJson: JSON.stringify({ kind: 'google_assistant_batch', threads: [] }),
      nowMs: testNow,
    });

    // Old Host without header gets 0 items (event remains pending).
    const oldPoll = await harness.callHost('POST', '/api/host/webhook-events/poll', {
      centerDevice: { deviceId: 'dev-1' },
      headers: {},
      body: { cursor: null },
    });
    assert.deepEqual(oldPoll.body.items, []);
    assert.equal(store.listGoogleAssistantEvents({ nowMs: testNow })[0].status, 'pending');

    // Wrong header value also gets 0 items.
    const wrongPoll = await harness.callHost('POST', '/api/host/webhook-events/poll', {
      centerDevice: { deviceId: 'dev-1' },
      headers: { [GOOGLE_ASSISTANT_POLL_HEADER]: 'legacy' },
      body: { cursor: null },
    });
    assert.deepEqual(wrongPoll.body.items, []);

    // New Host with x-pibot-google-assistant: batch-v1 receives trusted envelope and can report receipts.
    const newPoll = await harness.callHost('POST', '/api/host/webhook-events/poll', {
      centerDevice: { deviceId: 'dev-1' },
      headers: { [GOOGLE_ASSISTANT_POLL_HEADER]: GOOGLE_ASSISTANT_POLL_VALUE },
      body: { cursor: null },
    });
    assert.equal(newPoll.body.items.length, 1);
    assert.equal(newPoll.body.items[0].id, event.id);
    assert.equal(newPoll.body.items[0].trustedSource, GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE);
    assert.equal(newPoll.body.items[0].dataBoundary, GOOGLE_WORKSPACE_DATA_BOUNDARY);

    const receipt = await harness.callHost('POST', '/api/host/webhook-events/:id/receipt', {
      centerDevice: { deviceId: 'dev-1' },
      params: { id: event.id },
      body: { status: 'succeeded', error: null },
    });
    assert.equal(receipt.body.status, 'succeeded');

    await rules.close();
  } finally {
    cleanup();
  }
});

test('HTTP /api/google/assistant/setup handles dedicated Bot creation and existing Bot binding with config-changed notifications', async () => {
  const { store, cleanup } = makeStore();
  const bridgeCalls = [];
  const learningCalls = [];
  const configNotifications = [];
  try {
    const registryMap = new Map([
      ['dev-1', { deviceId: 'dev-1', revokedAt: null }],
      ['dev-2', { deviceId: 'dev-2', revokedAt: null }],
    ]);
    const bridge = {
      deviceId: 'center-relay',
      registry: { get: id => registryMap.get(id) ?? null },
      listDevices: () => [
        { deviceId: 'dev-1', name: 'Dev 1', online: true },
        { deviceId: 'dev-2', name: 'Dev 2', online: true },
      ],
      async call(deviceId, method, params) {
        bridgeCalls.push({ deviceId, method, params });
        if (method === 'createBot') {
          return { deviceId, botId: 'bot-mail-steward', name: params.role, role: params.role };
        }
        if (method === 'getBotSoul') {
          return { botId: params.botId, revision: 'a'.repeat(64), text: '' };
        }
        if (method === 'setBotSoul') {
          return { botId: params.botId, revision: 'b'.repeat(64), text: params.input.text, status: 'applied' };
        }
        throw new Error(`Unexpected bridge method: ${method}`);
      },
    };
    const learning = {
      async execute(identity, input) {
        learningCalls.push({ identity, input });
        if (input.action === 'status') return { settings: { revision: 0 } };
        return { settings: { revision: 1, review: { enabled: false } } };
      },
    };
    const google = {
      status: async () => ({
        configured: true,
        accounts: [{
          id: 'acc-1',
          email: 'ada@acme.dev',
          status: 'connected',
          services: [
            { service: 'gmail', state: 'ready' },
            { service: 'calendar', state: 'ready' },
          ],
        }],
      }),
      api: async () => { throw new Error('unused'); },
    };
    const rules = openGoogleRules({ store, google, bridge, now: () => NOW });
    const harness = makeRouteHarness({
      store,
      google,
      rules,
      bridge,
      learning,
      notifyDevice: (deviceId, event) => configNotifications.push({ deviceId, event }),
    });

    // Dedicated setup: creates Bot, applies DEFAULT_GOOGLE_ASSISTANT_SOUL, applies model, disables auto-learning review.
    const dedicatedRes = await harness.callOwner('POST', '/api/google/assistant/setup', {
      body: {
        mode: 'dedicated',
        deviceId: 'dev-1',
        createBot: {
          role: '邮件与日程管家',
          modelRef: 'openai/gpt-4o-mini',
          thinkingLevel: 'low',
        },
        batchWindowMinutes: 10,
        calendarLeadMinutes: 15,
      },
    });
    assert.equal(dedicatedRes.body.assistant.mode, 'dedicated');
    assert.equal(dedicatedRes.body.assistant.botId, 'bot-mail-steward');
    assert.equal(dedicatedRes.body.assistant.hindsightPrivateMemory, true);
    assert.deepEqual(dedicatedRes.body.assistant.accounts, ['ada@acme.dev']);
    assert.deepEqual(dedicatedRes.body.createdBot, {
      deviceId: 'dev-1',
      botId: 'bot-mail-steward',
      role: '邮件与日程管家',
      soulApplied: true,
      modelApplied: true,
    });
    assert.equal(store.getBotModelConfig('dev-1', 'bot-mail-steward').overrides.modelRef, 'openai/gpt-4o-mini');
    assert.equal(store.getBotModelConfig('dev-1', 'bot-mail-steward').overrides.thinkingLevel, 'low');
    assert.ok(bridgeCalls.some(c => c.method === 'setBotSoul' && c.params.input.text === DEFAULT_GOOGLE_ASSISTANT_SOUL));
    assert.ok(learningCalls.some(c => c.input.action === 'configure' && c.input.config.review.enabled === false));
    assert.deepEqual(configNotifications, [{ deviceId: 'dev-1', event: 'config-changed' }]);

    // Existing setup on dev-2/bot-remote: defaults digestTimes to ['09:00', '18:00'], hindsightPrivateMemory to false,
    // and notifies BOTH old device (dev-1) and new device (dev-2)!
    configNotifications.length = 0;
    const existingRes = await harness.callOwner('POST', '/api/google/assistant/setup', {
      body: {
        mode: 'existing',
        deviceId: 'dev-2',
        botId: 'bot-remote',
      },
    });
    assert.equal(existingRes.body.assistant.mode, 'existing');
    assert.equal(existingRes.body.assistant.deviceId, 'dev-2');
    assert.equal(existingRes.body.assistant.botId, 'bot-remote');
    assert.deepEqual(existingRes.body.assistant.digestTimes, ['09:00', '18:00']);
    assert.equal(existingRes.body.assistant.hindsightPrivateMemory, false);
    assert.equal(existingRes.body.createdBot, undefined);
    assert.deepEqual(configNotifications, [
      { deviceId: 'dev-2', event: 'config-changed' },
      { deviceId: 'dev-1', event: 'config-changed' },
    ]);

    // Events endpoint returns metadata only (no payload or instruction).
    store.enqueueGoogleAssistantEvent({
      deviceId: 'dev-2',
      botId: 'bot-remote',
      account: 'ada@acme.dev',
      source: 'gmail',
      eventKey: 'gassist:gmail:ada@acme.dev:sanitized-check',
      instruction: 'SECRET_INSTRUCTION',
      payloadJson: JSON.stringify({ snippet: 'PRIVATE_EMAIL_BODY' }),
      nowMs: NOW + 1000,
    });
    const eventsRes = await harness.callOwner('GET', '/api/google/assistant/events', { query: { limit: '10' } });
    assert.equal(eventsRes.body.items.length, 1);
    assert.equal('payload' in eventsRes.body.items[0], false);
    assert.equal('instruction' in eventsRes.body.items[0], false);

    // Remove notifies old device dev-2.
    configNotifications.length = 0;
    const removeRes = await harness.callOwner('POST', '/api/google/assistant/remove', { body: {} });
    assert.equal(removeRes.body.removed, true);
    assert.deepEqual(configNotifications, [{ deviceId: 'dev-2', event: 'config-changed' }]);

    await rules.close();
  } finally {
    cleanup();
  }
});

test('Built-in operations automation_google_assistant_{get,configure,remove} enforce Bot & OAuth MCP parity, scope/botTargets, and owner-only consent', async () => {
  const { store, cleanup } = makeStore();
  try {
    const bridge = {
      deviceId: 'center-relay',
      registry: {
        get: id => (id === 'dev-1' || id === 'dev-2' ? { deviceId: id, revokedAt: null } : null),
      },
      listDevices: () => [
        { deviceId: 'dev-1', name: 'Dev 1', online: true },
        { deviceId: 'dev-2', name: 'Dev 2', online: true },
      ],
      async call() { throw new Error('Bridge RPC should not be invoked by assistant operations'); },
    };
    const google = {
      status: async () => ({
        configured: true,
        accounts: [
          {
            id: 'acc-1',
            email: 'ada@acme.dev',
            status: 'connected',
            services: [{ service: 'gmail', state: 'ready' }, { service: 'calendar', state: 'ready' }],
          },
          {
            id: 'acc-2',
            email: 'work@acme.dev',
            status: 'connected',
            services: [{ service: 'gmail', state: 'ready' }, { service: 'calendar', state: 'ready' }],
          },
        ],
      }),
      api: async () => { throw new Error('unused'); },
    };
    const rules = openGoogleRules({ store, google, bridge, now: () => NOW });
    const harness = makeRouteHarness({ store, google, rules, bridge });

    const ops = openOperations({
      store,
      bridge,
      owner: harness.ownerAdapter,
    });
    const directHandlers = createGoogleRuleHandlers({ owner: harness.ownerAdapter, store });

    const botActor = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-1' };
    const oauthReadOnly = { kind: 'oauth', clientId: 'mcp-ro', scopes: ['pibot:automation:read'] };
    const oauthWriteAll = {
      kind: 'oauth',
      clientId: 'mcp-rw',
      scopes: ['pibot:automation:read', 'pibot:automation:write'],
    };
    const oauthScopedBot2 = {
      kind: 'oauth',
      clientId: 'mcp-scoped',
      scopes: ['pibot:automation:read', 'pibot:automation:write'],
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-2' }],
    };

    // Bot creates assistant binding on itself; even with mode='dedicated', hindsightPrivateMemory stays false!
    const created = await ops.call(botActor, 'automation_google_assistant_configure', {
      enabled: true,
      mode: 'dedicated',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: 15,
      calendarLeadMinutes: 10,
    });
    assert.equal(created.assistant.deviceId, 'dev-1');
    assert.equal(created.assistant.botId, 'bot-1');
    assert.equal(created.assistant.hindsightPrivateMemory, false);
    assert.equal(created.assistant.batchWindowMinutes, 15);

    // Passing hindsightPrivateMemory or OAuth token fields is rejected!
    await assert.rejects(
      () => ops.call(botActor, 'automation_google_assistant_configure', { hindsightPrivateMemory: true }),
      err => err.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => directHandlers.automation_google_assistant_configure({ hindsightPrivateMemory: true }, botActor),
      err => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => directHandlers.automation_google_assistant_configure({ accessToken: 'ya29.fake' }, botActor),
      err => err.code === 'FORBIDDEN',
    );

    // Owner enables hindsightPrivateMemory via owner route; subsequent Bot/OAuth update on the SAME Bot preserves it.
    await harness.callOwner('POST', '/api/google/assistant/save', {
      body: { hindsightPrivateMemory: true },
    });
    const updatedByOAuth = await ops.call(oauthWriteAll, 'automation_google_assistant_configure', {
      accounts: ['ada@acme.dev', 'work@acme.dev'],
      digestTimes: ['09:00', '18:00'],
    });
    assert.equal(updatedByOAuth.assistant.hindsightPrivateMemory, true);
    assert.deepEqual(updatedByOAuth.assistant.accounts, ['ada@acme.dev', 'work@acme.dev']);
    assert.deepEqual(updatedByOAuth.assistant.digestTimes, ['09:00', '18:00']);

    // Redirecting to a DIFFERENT Bot via OAuth MUST reset hindsightPrivateMemory to false (no cross-Bot consent transfer!).
    const redirectedByOAuth = await ops.call(oauthWriteAll, 'automation_google_assistant_configure', {
      deviceId: 'dev-1',
      botId: 'bot-2',
    });
    assert.equal(redirectedByOAuth.assistant.botId, 'bot-2');
    assert.equal(redirectedByOAuth.assistant.hindsightPrivateMemory, false);

    // Restore back to bot-1 (owner grants hindsightPrivateMemory again) for scoped-target checks below.
    await harness.callOwner('POST', '/api/google/assistant/save', {
      body: { deviceId: 'dev-1', botId: 'bot-1', hindsightPrivateMemory: true },
    });

    // Read-only OAuth caller can read, but cannot configure or remove.
    const readRes = await ops.call(oauthReadOnly, 'automation_google_assistant_get', {});
    assert.equal(readRes.assistant.botId, 'bot-1');
    await assert.rejects(
      () => ops.call(oauthReadOnly, 'automation_google_assistant_configure', { enabled: false }),
      err => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ops.call(oauthReadOnly, 'automation_google_assistant_remove', {}),
      err => err.code === 'FORBIDDEN',
    );

    // Scoped OAuth caller authorized only for bot-2 cannot see, mutate, or remove bot-1's binding!
    const scopedGet = await ops.call(oauthScopedBot2, 'automation_google_assistant_get', {});
    assert.deepEqual(scopedGet, { assistant: null, runtime: null });
    await assert.rejects(
      () => ops.call(oauthScopedBot2, 'automation_google_assistant_configure', { enabled: false }),
      err => err.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ops.call(oauthScopedBot2, 'automation_google_assistant_remove', {}),
      err => err.code === 'FORBIDDEN',
    );

    // Authorized OAuth caller can remove cleanly via the same owner route.
    const removed = await ops.call(oauthWriteAll, 'automation_google_assistant_remove', {});
    assert.deepEqual(removed, { removed: true });
    assert.equal(store.getGoogleAssistant(), null);

    await rules.close();
  } finally {
    cleanup();
  }
});
