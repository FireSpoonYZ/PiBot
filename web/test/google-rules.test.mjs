// Regression tests for Center Google Gmail/Calendar trigger rules, pinned vendored Orca
// trigger matching via `orca-domain.js`, durable cursors/idempotency, offline pending/missed
// handling, multi-account isolation, and end-to-end Google Workspace rule privacy boundaries
// (trusted Center envelope -> Host createWebhookConsumer -> submitPrimary allowGoogleWorkspaceRule
// -> Durable host.user-message -> syncTrustedRuleEntries / learning isolation / chatTurnModel).
//
// Includes MIT-preserved test cases adapted from stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea
// (Copyright (c) 2026 Lovecast Inc.).

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCenterStore } from '../../center-server/data/index.js';
import {
  openGoogleRules,
  createGoogleRuleDispatcher,
} from '../../center-server/google-workspace/rules.js';
import {
  assertGoogleTrigger,
  gmailRuleMatches,
  GoogleToolError,
} from '../../center-server/google-workspace/rules-orca.js';
import {
  createWebhookConsumer,
  isTrustedGoogleRuleEvent,
} from '../../host-core/host-webhooks.js';
import {
  createGoogleWorkspacePrivacy,
  GOOGLE_WORKSPACE_DATA_BOUNDARY,
  GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
  GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE,
  GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
  isTrustedDataBoundary,
  isTrustedGoogleWorkspaceRuleEntry,
  isTrustedHostSourceType,
} from '../../host-core/google-workspace-privacy.js';
import { normalizeAttribution } from '../src/chatTurnModel.ts';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const GMAIL_PATH = '/gmail/v1/users/me';
const PRIMARY_EVENTS_PATH = '/calendar/v3/calendars/primary/events';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-google-rules-'));
  const store = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  store.replaceDeviceBots('dev-1', [
    { deviceId: 'dev-1', botId: 'bot-1', name: 'Alpha', isPrimary: true },
    { deviceId: 'dev-1', botId: 'bot-2', name: 'Beta', isPrimary: false },
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

function createMemoryDurableHarness() {
  const docs = new Map();
  const conversations = new Map();
  const docKey = (def, conversationId) => {
    const scope = def?.scope ?? def?.definition?.scope;
    const kind = def?.kind ?? def?.definition?.kind ?? String(def);
    const id = scope === 'session' || typeof conversationId !== 'number' ? 'session' : conversationId;
    return `${kind}:${id}`;
  };
  const initialOf = (def) => {
    const fn = def?.definition?.initial ?? def?.initial;
    return typeof fn === 'function' ? fn() : {};
  };
  return {
    appendEntry(nativeId, entry) {
      const list = conversations.get(nativeId) ?? [];
      const id = entry.id ?? (list.length ? list[list.length - 1].id + 1 : 1);
      const stored = { conversationId: nativeId, ...entry, id };
      list.push(stored);
      conversations.set(nativeId, list);
      return stored;
    },
    entriesOf(nativeId) {
      return conversations.get(nativeId) ?? [];
    },
    harness: {
      async snapshot(def, conversationId) {
        const key = docKey(def, conversationId);
        return docs.has(key) ? structuredClone(docs.get(key)) : null;
      },
      async commit(fn) {
        const pending = new Map();
        const tx = {
          async doc(def, conversationId) {
            const key = docKey(def, conversationId);
            if (!pending.has(key)) {
              pending.set(key, docs.has(key) ? structuredClone(docs.get(key)) : initialOf(def));
            }
            return pending.get(key);
          },
          async latestEntryId(conversationId) {
            const list = conversations.get(conversationId) ?? [];
            return list.length ? list[list.length - 1].id : 0;
          },
          entry(entryId) {
            for (const list of conversations.values()) {
              const found = list.find(e => e.id === entryId);
              if (found) return found;
            }
            return null;
          },
        };
        const result = await fn(tx);
        for (const [key, value] of pending.entries()) {
          docs.set(key, structuredClone(value));
        }
        return result;
      },
      async conversation(nativeId) {
        if (!conversations.has(nativeId)) return null;
        return {
          id: nativeId,
          async entries(query = {}, limit = 100, cursor) {
            const list = conversations.get(nativeId) ?? [];
            const minId = query.minEntryId ?? 0;
            const maxId = query.maxEntryId ?? Number.POSITIVE_INFINITY;
            let filtered = list.filter(e => e.id >= minId && e.id <= maxId);
            if (query.order === 'descending') filtered = [...filtered].reverse();
            const start = typeof cursor?.offset === 'number' ? cursor.offset : 0;
            const items = filtered.slice(start, start + limit);
            const next = start + items.length < filtered.length ? { offset: start + items.length } : null;
            return { items, next };
          },
        };
      },
    },
  };
}

// Mirrors host-core/runtime.js submitPrimary + host-core/runtime-turns.js sourceMessageEntry boundary.
function buildTrustedPrimaryEntry({ deviceId, botId, input, allowGoogleWorkspaceRule, nowMs = NOW }) {
  const kind = input?.origin?.sender?.kind === 'host' ? 'host' : 'user';
  const rawSourceType = input?.origin?.sender?.sourceType;
  const sourceType = kind === 'host' && (
    rawSourceType === 'webhook' ||
    (allowGoogleWorkspaceRule && isTrustedHostSourceType(rawSourceType))
  ) ? rawSourceType : null;
  const dataBoundary = kind === 'host' && allowGoogleWorkspaceRule && isTrustedDataBoundary(input?.origin?.dataBoundary)
    ? input.origin.dataBoundary
    : null;
  const name = typeof input?.origin?.sender?.name === 'string' ? input.origin.sender.name : null;
  return {
    kind: 'host.user-message',
    data: {
      version: 1,
      source: 'host',
      requestId: input.requestId,
      botId,
      ...(dataBoundary !== null ? { dataBoundary } : {}),
      attribution: {
        kind,
        deviceId,
        channel: 'primary',
        messageId: input.requestId,
        direction: 'incoming',
        createdAt: new Date(nowMs).toISOString(),
        ...(name !== null ? { name } : {}),
        ...(sourceType !== null ? { sourceType } : {}),
      },
      turn: {
        requestId: input.requestId,
        taskId: null,
        kind: 'primary',
        scopeId: null,
        triggerMessageId: input.requestId,
        replyTo: null,
        sender: {
          kind,
          deviceId,
          ...(name !== null ? { name } : {}),
          ...(sourceType !== null ? { sourceType } : {}),
        },
        replyTarget: { kind: 'primary' },
      },
    },
    model: [{ role: 'user', content: input.text, timestamp: nowMs }],
  };
}

const authResults = (verdict, domain = 'acme.com') =>
  `mx.google.com; spf=pass smtp.mailfrom=${domain}; dmarc=${verdict} (p=REJECT) header.from=${domain}`;

function gmailMessage(id, options = {}) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: options.labels ?? ['INBOX', 'UNREAD'],
    snippet: options.snippet ?? 'Can you send the invoice?',
    internalDate: String(options.at ?? NOW + 30_000),
    payload: {
      headers: [
        ...(options.auth ?? [authResults('pass')]).map(value => ({
          name: 'Authentication-Results',
          value,
        })),
        { name: 'From', value: options.from ?? 'Sam Lee <sam@acme.com>' },
        { name: 'To', value: options.to ?? 'ada@acme.dev' },
        { name: 'Subject', value: options.subject ?? 'Invoice' },
      ],
    },
  };
}

function gmailRoutes(added, historyStatus = 200, nextHistoryId = '120') {
  return [
    url => (url.pathname === `${GMAIL_PATH}/profile` ? { status: 200, body: { historyId: '100' } } : null),
    url => (url.pathname === `${GMAIL_PATH}/history`
      ? historyStatus === 200
        ? {
          status: 200,
          body: {
            historyId: nextHistoryId,
            history: added.map(entry => ({
              messagesAdded: [
                { message: { id: entry.id, threadId: entry.threadId, labelIds: entry.labelIds } },
              ],
            })),
          },
        }
        : { status: historyStatus, body: { error: { code: historyStatus } } }
      : null),
    url => {
      const found = added.find(entry => url.pathname === `${GMAIL_PATH}/messages/${entry.id}`);
      return found ? { status: 200, body: found } : null;
    },
  ];
}

function calendarRoutes(events, syncStatus = 200) {
  let seeds = 0;
  return [
    url => {
      if (url.pathname !== PRIMARY_EVENTS_PATH) return null;
      if (url.searchParams.has('fields')) {
        return url.searchParams.has('syncToken') && syncStatus !== 200
          ? { status: syncStatus, body: { error: { code: syncStatus } } }
          : { status: 200, body: { items: [], nextSyncToken: `sync-${++seeds}` } };
      }
      return {
        status: 200,
        body: {
          items: events.map(event => ({
            id: event.id,
            summary: event.summary ?? 'Design review',
            start: event.allDay
              ? { date: '2026-11-20' }
              : { dateTime: new Date(NOW + event.startsIn).toISOString() },
            end: event.allDay
              ? { date: '2026-11-21' }
              : { dateTime: new Date(NOW + event.startsIn + 1_800_000).toISOString() },
            ...(event.status ? { status: event.status } : {}),
            attendees: [
              {
                email: 'ada@acme.dev',
                self: true,
                responseStatus: event.declined ? 'declined' : 'accepted',
              },
            ],
          })),
        },
      };
    },
  ];
}

test('Orca trigger validation caps minutesBefore and Gmail filter lengths/counts', () => {
  const cal = { id: 'm', source: 'calendar', event: 'starting_soon' };
  assert.doesNotThrow(() => assertGoogleTrigger({ ...cal, minutesBefore: 0 }));
  assert.doesNotThrow(() => assertGoogleTrigger({ ...cal, minutesBefore: 1440 }));
  assert.throws(() => assertGoogleTrigger({ ...cal, minutesBefore: 1441 }), /0 to 1440/);
  assert.throws(() => assertGoogleTrigger({ ...cal, minutesBefore: 2.5 }), /0 to 1440/);

  const mail = { id: 'g', source: 'gmail', event: 'new_email' };
  const many = Array.from({ length: 11 }, (_, i) => `p${i}@acme.com`);
  assert.throws(() => assertGoogleTrigger({ ...mail, from: many }), /too long/);
  assert.throws(() => assertGoogleTrigger({ ...mail, subjectContains: 'x'.repeat(201) }), /too long/);
});

test('Orca RFC 5322 Gmail from= and to= matching rejects spoofed display names and unverified senders', () => {
  const makeMail = (from, extra = {}) => ({
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    from,
    to: 'ada@acme.dev',
    cc: '',
    subject: 'Hi',
    snippet: '',
    at: 0,
    senderVerified: true,
    ...extra,
  });
  const fromRule = from => ({ id: 'on-mail', source: 'gmail', event: 'new_email', from });
  const fromBoss = from => gmailRuleMatches(fromRule(['boss@gmail.com']), makeMail(from), null);

  assert.equal(fromBoss('"boss@gmail.com" <attacker@gmail.com>'), false);
  assert.equal(fromBoss('boss@gmail.com <attacker@gmail.com>'), false);
  assert.equal(fromBoss('"Boss, <boss@gmail.com> @ HQ" <attacker@gmail.com>'), false);
  assert.equal(fromBoss('attacker@gmail.com (boss@gmail.com)'), false);
  assert.equal(fromBoss('boss@gmail.com, attacker@gmail.com'), false);
  assert.equal(fromBoss('Boss <boss@gmail.com>, Other <other@gmail.com>'), false);
  assert.equal(gmailRuleMatches(fromRule(['boss@gmail.com']), makeMail('boss@gmail.com', { senderVerified: false }), null), false);

  assert.equal(fromBoss('"Boss, <x@y.com> @ HQ" <boss@gmail.com>'), true);
  assert.equal(fromBoss('The Boss <BOSS@GMAIL.COM>'), true);
  assert.equal(fromBoss('boss@gmail.com'), true);
  assert.equal(gmailRuleMatches(fromRule(['gmail.com']), makeMail('"x@acme.com" <boss@gmail.com>'), null), true);
  assert.equal(gmailRuleMatches(fromRule(['acme.com']), makeMail('"x@acme.com" <boss@gmail.com>'), null), false);

  const toOps = to => gmailRuleMatches(
    { id: 'on-mail', source: 'gmail', event: 'new_email', to: ['ops@acme.com'] },
    makeMail('boss@gmail.com', { to }),
    null,
  );
  assert.equal(toOps('"ops@acme.com" <ada@acme.dev>'), false);
  assert.equal(toOps('"Lee, Kim" <lk@x.com>, Ops <OPS@acme.com>'), true);
});

test('Gmail rule seeds history via vendored orca-domain, filters DMARC/ignored/old mail, and emits trusted Google envelope without fake webhook routes', async () => {
  const { store, cleanup } = makeStore();
  let now = NOW;
  const woken = [];
  try {
    const forged = gmailMessage('m2', { auth: [authResults('fail')] });
    const planted = gmailMessage('m3', { auth: ['mx.example.com; dmarc=fail', authResults('pass')] });
    const sent = gmailMessage('m4', { labels: ['SENT'] });
    const old = gmailMessage('m5', { at: NOW - 60_000 });
    const valid = gmailMessage('m1');
    const fake = makeFakeApi('ada@acme.dev', gmailRoutes([forged, planted, sent, old, valid]));

    const google = {
      status: async () => ({
        client: { configured: true },
        accounts: [{
          id: 'acc-1',
          email: 'ada@acme.dev',
          status: 'connected',
          choices: ['gmail', 'calendar'],
          services: [{ service: 'gmail', state: 'ready' }, { service: 'calendar', state: 'ready' }],
        }],
      }),
      api: async () => fake.api,
    };

    const dispatch = createGoogleRuleDispatcher({
      store,
      notify: deviceId => woken.push(deviceId),
      now: () => now,
    });
    const rules = openGoogleRules({
      store,
      google,
      dispatch,
      now: () => now,
    });

    const { rule } = await rules.manage('save', {
      deviceId: 'dev-1',
      botId: 'bot-1',
      account: 'ada@acme.dev',
      source: 'gmail',
      enabled: true,
      from: ['acme.com'],
      instruction: 'Summarize the invoice email for me.',
    });
    assert.equal(rule.source, 'gmail');
    assert.equal(rule.event, 'new_email');
    assert.equal(rule.runtime.status, 'running');

    // First tick seeds historyId only and fires nothing.
    await rules.tick();
    assert.deepEqual(woken, []);
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '100');

    // Second tick receives changes, filters forged/planted/sent/old, dispatches m1 once.
    now += 60_000;
    await rules.tick();
    assert.deepEqual(woken, ['dev-1']);
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '120');
    const metaCall = fake.calls.find(c => c.pathname === `${GMAIL_PATH}/messages/m1`);
    assert.equal(metaCall?.searchParams.get('format'), 'metadata');

    // Must NOT create any public bearer webhook route.
    assert.deepEqual(store.listWebhookRoutes(), []);

    // Host polls via existing delivery seam and receives trusted top-level envelope markers.
    const poll = store.pollWebhookEvents('dev-1', null, now);
    assert.equal(poll.items.length, 1);
    const delivery = poll.items[0];
    assert.equal(delivery.deviceId, 'dev-1');
    assert.equal(delivery.botId, 'bot-1');
    assert.equal(delivery.routeId, rule.id);
    assert.equal(delivery.status, 'dispatching');
    assert.equal(delivery.idempotencyKey, 'gmail:ada@acme.dev:m1');
    assert.equal(delivery.trustedSource, GOOGLE_WORKSPACE_RULE_SOURCE_TYPE);
    assert.equal(delivery.dataBoundary, GOOGLE_WORKSPACE_DATA_BOUNDARY);
    assert.equal(isTrustedGoogleRuleEvent(delivery), true);
    assert.equal(delivery.payload.source, 'gmail');
    assert.equal(delivery.payload.google.ref, 'gmail:thread:t-m1');

    // Duplicate dispatch with the same eventKey is strictly idempotent.
    const dup = await dispatch({
      deviceId: 'dev-1',
      botId: 'bot-1',
      ruleId: rule.id,
      eventKey: 'gmail:ada@acme.dev:m1',
      instruction: rule.instruction,
      payload: delivery.payload,
    });
    assert.equal(dup.created, false);
    assert.equal(dup.eventId, delivery.id);
    assert.deepEqual(woken, ['dev-1']);

    // Host reports monotonic receipts back to Center.
    const queued = store.reportWebhookEvent('dev-1', delivery.id, { status: 'queued', error: null, admission: null }, now + 1000);
    assert.equal(queued.status, 'queued');
    const done = store.reportWebhookEvent('dev-1', delivery.id, { status: 'succeeded', error: null }, now + 2000);
    assert.equal(done.status, 'succeeded');

    // Unnominated bot-2 has zero rules.
    const bot2Rules = await rules.manage('list', { deviceId: 'dev-1', botId: 'bot-2' });
    assert.deepEqual(bot2Rules.items, []);

    await rules.close();
  } finally {
    cleanup();
  }
});

test('Gmail 429 rate-limit backoff exposes backing_off/rateLimited, retries from same historyId on failure, and re-seeds on 404', async () => {
  const { store, cleanup } = makeStore();
  let now = NOW;
  let labelsUp = false;
  let failDispatchOnce = true;
  const dispatched = [];
  try {
    const fake = makeFakeApi('ada@acme.dev', [
      url => (url.pathname === `${GMAIL_PATH}/labels`
        ? labelsUp
          ? { status: 200, body: { labels: [{ id: 'Label_7', name: 'Clients' }] } }
          : { status: 429, body: { error: { code: 429 } } }
        : null),
      ...gmailRoutes([gmailMessage('m1', { labels: ['INBOX', 'Label_7'] })]),
    ]);
    const google = {
      status: async () => ({
        client: { configured: true },
        accounts: [{ id: 'a1', email: 'ada@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] }],
      }),
      api: async () => fake.api,
    };

    const rules = openGoogleRules({
      store,
      google,
      dispatch: async input => {
        if (failDispatchOnce) {
          failDispatchOnce = false;
          throw new Error('temporary_dispatch_failure');
        }
        dispatched.push(input);
      },
      now: () => now,
    });

    await rules.manage('save', {
      deviceId: 'dev-1',
      botId: 'bot-1',
      account: 'ada@acme.dev',
      source: 'gmail',
      enabled: true,
      from: ['acme.com'],
      label: 'clients',
      instruction: 'Notify me.',
    });
    store.saveGoogleTriggerState({ accounts: { 'ada@acme.dev': { historyId: '7' } }, listeners: {} }, now);

    await rules.tick();
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '7');
    const listed = await rules.manage('list', { deviceId: 'dev-1', botId: 'bot-1' });
    assert.equal(listed.items[0].runtime.status, 'backing_off');
    assert.equal(listed.items[0].runtime.rateLimited, true);

    const callsAfter429 = fake.calls.length;
    labelsUp = true;
    now += 30_000;
    await rules.tick();
    assert.equal(fake.calls.length, callsAfter429);

    now += 60_000;
    await rules.tick();
    assert.equal(dispatched.length, 0);
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '7');

    await rules.tick();
    assert.deepEqual(dispatched.map(d => d.eventKey), ['gmail:ada@acme.dev:m1']);
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '120');

    const expiredFake = makeFakeApi('ada@acme.dev', gmailRoutes([gmailMessage('m9')], 404));
    const rules2 = openGoogleRules({
      store,
      google: { ...google, api: async () => expiredFake.api },
      dispatch: async input => { dispatched.push(input); },
      now: () => now,
    });
    await rules2.tick();
    assert.equal(dispatched.length, 1);
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '100');

    await rules.close();
    await rules2.close();
  } finally {
    cleanup();
  }
});

test('Calendar rule handles 410 syncToken re-seed, skips declined/all-day, marks offline meeting missed after startMs, and clears timers on close', async () => {
  const { store, cleanup } = makeStore();
  let now = NOW;
  const activeTimers = new Set();
  try {
    const fake = makeFakeApi(
      'ada@acme.dev',
      calendarRoutes(
        [
          { id: 'soon', startsIn: 5 * 60_000 },
          { id: 'in-window', startsIn: 10 * 60_000 + 20_000 },
          { id: 'later', startsIn: 3 * 3_600_000 },
          { id: 'declined', startsIn: 4 * 60_000, declined: true },
          { id: 'allday', startsIn: 4 * 60_000, allDay: true },
        ],
        410,
      ),
    );
    const google = {
      status: async () => ({
        client: { configured: true },
        accounts: [{
          id: 'a1',
          email: 'ada@acme.dev',
          status: 'connected',
          choices: ['calendar'],
          services: [{ service: 'calendar', state: 'ready' }],
        }],
      }),
      api: async () => fake.api,
    };

    const dispatch = createGoogleRuleDispatcher({ store, notify: () => {}, now: () => now });
    const rules = openGoogleRules({
      store,
      google,
      dispatch,
      now: () => now,
      tickMs: 60_000,
      setTimer: (fn, ms) => {
        const handle = { fn, ms, cleared: false };
        activeTimers.add(handle);
        return handle;
      },
      clearTimer: handle => {
        handle.cleared = true;
        activeTimers.delete(handle);
      },
    });

    const { rule } = await rules.manage('save', {
      deviceId: 'dev-1',
      botId: 'bot-1',
      account: 'ada@acme.dev',
      source: 'calendar',
      enabled: true,
      minutesBefore: 10,
      instruction: 'Prepare meeting brief.',
    });

    await rules.tick();
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.calendars?.primary?.syncToken, 'sync-1');
    assert.equal(activeTimers.size, 1);

    await rules.tick();
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.calendars?.primary?.syncToken, 'sync-2');
    assert.equal(store.listGoogleRuleEvents(rule.id, { nowMs: now }).length, 1);

    now = NOW + 6 * 60_000;
    const pollAfterStart = store.pollWebhookEvents('dev-1', null, now);
    assert.equal(pollAfterStart.items.length, 0);
    const events = store.listGoogleRuleEvents(rule.id, { nowMs: now });
    assert.equal(events[0].status, 'missed');
    assert.equal(events[0].error.code, 'MEETING_STARTED_WHILE_OFFLINE');

    await rules.close();
    assert.equal(activeTimers.size, 0);
  } finally {
    cleanup();
  }
});

test('Multi-account enforcement requires explicit account, pauses on reconnect/removal without switching accounts, and honors user stop', async () => {
  const { store, cleanup } = makeStore();
  let now = NOW;
  let accountsState = [
    { id: 'a1', email: 'alice@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
    { id: 'a2', email: 'bob@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
  ];
  const apiCalledFor = [];
  try {
    const google = {
      status: async () => ({ client: { configured: true }, accounts: accountsState }),
      api: async account => {
        apiCalledFor.push(account);
        return makeFakeApi(account, gmailRoutes([])).api;
      },
    };
    const rules = openGoogleRules({
      store,
      google,
      dispatch: createGoogleRuleDispatcher({ store, notify: () => {}, now: () => now }),
      now: () => now,
    });

    await assert.rejects(
      () => rules.manage('save', {
        deviceId: 'dev-1',
        botId: 'bot-1',
        source: 'gmail',
        enabled: true,
        instruction: 'Check mail.',
      }),
      err => err.code === 'INVALID_ARGUMENT',
    );

    const { rule: aliceRule } = await rules.manage('save', {
      deviceId: 'dev-1',
      botId: 'bot-1',
      account: 'alice@acme.dev',
      source: 'gmail',
      enabled: true,
      instruction: 'Check Alice mail.',
    });
    const { rule: manualPaused } = await rules.manage('save', {
      deviceId: 'dev-1',
      botId: 'bot-2',
      account: 'alice@acme.dev',
      source: 'gmail',
      enabled: false,
      instruction: 'Paused rule.',
    });

    accountsState = [
      { id: 'a1', email: 'alice@acme.dev', status: 'reconnect', choices: ['gmail'], services: [{ service: 'gmail', state: 'needs-permission' }] },
      { id: 'a2', email: 'bob@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
    ];
    await rules.tick();
    assert.deepEqual(apiCalledFor, []);
    const pausedList = await rules.manage('list', { account: 'alice@acme.dev' });
    assert.equal(pausedList.items.find(r => r.id === aliceRule.id).runtime.status, 'paused_account_reconnect');
    assert.equal(pausedList.items.find(r => r.id === manualPaused.id).runtime.status, 'paused_disabled');

    accountsState = [
      { id: 'a1', email: 'alice@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
      { id: 'a2', email: 'bob@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
    ];
    await rules.tick();
    assert.deepEqual(apiCalledFor, ['alice@acme.dev']);
    const resumedList = await rules.manage('list', { account: 'alice@acme.dev' });
    assert.equal(resumedList.items.find(r => r.id === aliceRule.id).runtime.status, 'running');
    assert.equal(resumedList.items.find(r => r.id === manualPaused.id).runtime.status, 'paused_disabled');

    const dispatch = createGoogleRuleDispatcher({ store, notify: () => {}, now: () => now });
    const res = await dispatch({
      deviceId: 'dev-1',
      botId: 'bot-1',
      ruleId: aliceRule.id,
      eventKey: 'gmail:alice@acme.dev:stop-test',
      instruction: aliceRule.instruction,
      payload: { kind: 'google_rule_event', source: 'gmail', text: 'hello' },
    });
    assert.equal(res.status, 'pending');
    store.stopWebhookEvents('dev-1', { botId: 'bot-1', stopEpoch: 1 });
    const afterStop = store.listGoogleRuleEvents(aliceRule.id, { nowMs: now });
    assert.equal(afterStop[0].status, 'cancelled');
    assert.equal(afterStop[0].error.code, 'USER_STOP');

    accountsState = [accountsState[1]];
    rules.onAccountRemoved('alice@acme.dev');
    await rules.tick();
    assert.deepEqual(apiCalledFor, ['alice@acme.dev']);
    const afterRemove = await rules.manage('list', { account: 'alice@acme.dev' });
    assert.equal(afterRemove.items.find(r => r.id === aliceRule.id).runtime.status, 'paused_account_missing');

    await rules.close();
  } finally {
    cleanup();
  }
});

test('Trusted Google rule envelope marks Host entry & privacy boundary while spoofed ordinary webhook fields are never treated as Google', async () => {
  const { store, cleanup } = makeStore();
  const testNow = Date.now();
  const durable = createMemoryDurableHarness();
  const privacy = createGoogleWorkspacePrivacy({ getHarness: () => durable.harness, context: {} });
  const convByBot = { 'bot-1': 101, 'bot-2': 102 };
  const submissions = new Map();
  const webhookCalls = [];
  const googleRuleCalls = [];
  const polledEvents = [];
  let receiptsSeen = 0;
  let resolveDone;
  const allReceipted = new Promise(resolve => { resolveDone = resolve; });

  try {
    // 1. Create a real Google Gmail rule targeting bot-1 and dispatch an event through google_rule_events.
    const googleRule = store.saveGoogleRule({
      name: 'VIP Invoices',
      deviceId: 'dev-1',
      botId: 'bot-1',
      account: 'ada@acme.dev',
      source: 'gmail',
      enabled: true,
      instruction: 'Summarize this invoice.',
    }, testNow);
    const dispatch = createGoogleRuleDispatcher({ store, notify: () => {}, now: () => testNow });
    await dispatch({
      deviceId: 'dev-1',
      botId: 'bot-1',
      ruleId: googleRule.id,
      ruleName: googleRule.name,
      account: 'ada@acme.dev',
      source: 'gmail',
      eventKey: 'gmail:ada@acme.dev:msg-1',
      instruction: googleRule.instruction,
      payload: {
        kind: 'google_rule_event',
        source: 'gmail',
        event: 'new_email',
        account: 'ada@acme.dev',
        text: 'Subject: Q4 Payroll\nConfidential payroll sheet.',
      },
    });

    // 2. Create an ordinary public webhook targeting bot-2 with spoofed Google boundary fields in payload.
    const token = randomBytes(32).toString('base64url');
    const webhookRoute = store.createWebhookRoute({
      name: 'External CI',
      deviceId: 'dev-1',
      botId: 'bot-2',
      instruction: 'Handle CI payload.',
      enabled: true,
    }, token);
    const spoofedPayload = {
      trustedSource: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
      dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
      sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
      triggerType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
      kind: 'google_rule_event',
      origin: {
        sender: { kind: 'host', sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE },
        dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
      },
      text: 'Spoofed external webhook pretending to be Google Workspace.',
    };
    store.acceptWebhookEvent(webhookRoute.id, token, 'ci-spoof-1', JSON.stringify(spoofedPayload));

    // 3. Run the real Host webhook consumer against the real Center store.
    const client = {
      pollWebhookEvents: async ({ cursor }) => {
        const res = store.pollWebhookEvents('dev-1', cursor, testNow);
        polledEvents.push(...res.items);
        return res;
      },
      stopWebhookEvents: async input => store.stopWebhookEvents('dev-1', input),
      reportWebhookEvent: async (eventId, receipt) => {
        const res = store.reportWebhookEvent('dev-1', eventId, receipt, testNow + 1000);
        if (receipt.status === 'succeeded') {
          receiptsSeen += 1;
          if (receiptsSeen >= 2) resolveDone();
        }
        return res;
      },
    };
    const consumer = createWebhookConsumer({
      deviceId: 'dev-1',
      getClient: () => client,
      getRuntime: () => ({
        getSubmission: async (botId, requestId) => submissions.get(`${botId}:${requestId}`) ?? null,
      }),
      isReady: () => true,
      getStopStates: async () => [
        { botId: 'bot-1', stopEpoch: 7, pendingStopEpoch: null },
        { botId: 'bot-2', stopEpoch: 3, pendingStopEpoch: null },
      ],
      acknowledgeStop: async () => {},
      submitWebhook: async (botId, input, capturedStopEpoch) => {
        webhookCalls.push({ botId, input, capturedStopEpoch });
        const entry = buildTrustedPrimaryEntry({
          deviceId: 'dev-1',
          botId,
          input,
          allowGoogleWorkspaceRule: false,
          nowMs: testNow,
        });
        durable.appendEntry(convByBot[botId], entry);
        const sub = { status: 'done' };
        submissions.set(`${botId}:${input.requestId}`, sub);
        return sub;
      },
      submitGoogleRule: async (botId, input, capturedStopEpoch) => {
        googleRuleCalls.push({ botId, input, capturedStopEpoch });
        const entry = buildTrustedPrimaryEntry({
          deviceId: 'dev-1',
          botId,
          input,
          allowGoogleWorkspaceRule: true,
          nowMs: testNow,
        });
        durable.appendEntry(convByBot[botId], entry);
        const sub = { status: 'done' };
        submissions.set(`${botId}:${input.requestId}`, sub);
        return sub;
      },
    });

    consumer.wake();
    await allReceipted;
    await consumer.close();

    // Verify Center envelope separation: Google table emits trusted envelope, webhook table never does.
    const googlePolled = polledEvents.find(e => e.routeId === googleRule.id);
    const webhookPolled = polledEvents.find(e => e.routeId === webhookRoute.id);
    assert.ok(googlePolled);
    assert.ok(webhookPolled);
    assert.equal(googlePolled.trustedSource, GOOGLE_WORKSPACE_RULE_SOURCE_TYPE);
    assert.equal(googlePolled.dataBoundary, GOOGLE_WORKSPACE_DATA_BOUNDARY);
    assert.equal(isTrustedGoogleRuleEvent(googlePolled), true);
    assert.equal(webhookPolled.trustedSource, undefined);
    assert.equal(webhookPolled.dataBoundary, undefined);
    assert.equal(isTrustedGoogleRuleEvent(webhookPolled), false);
    assert.equal(webhookPolled.payload.dataBoundary, GOOGLE_WORKSPACE_DATA_BOUNDARY);

    // Verify Host consumer routed each event strictly to its own channel with preserved stopEpoch.
    assert.equal(googleRuleCalls.length, 1);
    assert.equal(googleRuleCalls[0].botId, 'bot-1');
    assert.equal(googleRuleCalls[0].capturedStopEpoch, 7);
    assert.equal(googleRuleCalls[0].input.origin.sender.kind, 'host');
    assert.equal(googleRuleCalls[0].input.origin.sender.sourceType, GOOGLE_WORKSPACE_RULE_SOURCE_TYPE);
    assert.equal(googleRuleCalls[0].input.origin.dataBoundary, GOOGLE_WORKSPACE_DATA_BOUNDARY);

    assert.equal(webhookCalls.length, 1);
    assert.equal(webhookCalls[0].botId, 'bot-2');
    assert.equal(webhookCalls[0].capturedStopEpoch, 3);
    assert.equal(webhookCalls[0].input.origin.sender.kind, 'host');
    assert.equal(webhookCalls[0].input.origin.sender.sourceType, 'webhook');
    assert.equal(webhookCalls[0].input.origin.dataBoundary, undefined);

    // Verify Google rule entry is marked, synced via syncTrustedRuleEntries, and isolated from learning/export.
    const bot1Entries = durable.entriesOf(101);
    assert.equal(bot1Entries.length, 1);
    assert.equal(isTrustedGoogleWorkspaceRuleEntry(bot1Entries[0]), true);
    const syncRes1 = await privacy.syncTrustedRuleEntries(101, bot1Entries);
    assert.equal(syncRes1.marked, true);
    assert.equal(await privacy.isConversationTainted(101), true);
    const learning1 = await privacy.filterConversationEntriesForLearning(101, bot1Entries);
    assert.equal(learning1.tainted, true);
    assert.equal(learning1.cleanEntries.length, 0);
    await assert.rejects(
      () => privacy.assertExportAllowed(101, { operation: 'learning' }),
      err => err.code === GOOGLE_WORKSPACE_PRIVACY_BLOCKED_CODE,
    );

    // Verify spoofed ordinary webhook entry is NOT treated as Google Workspace and stays clean for learning.
    const bot2Entries = durable.entriesOf(102);
    assert.equal(bot2Entries.length, 1);
    assert.equal(isTrustedGoogleWorkspaceRuleEntry(bot2Entries[0]), false);
    const syncRes2 = await privacy.syncTrustedRuleEntries(102, bot2Entries);
    assert.equal(syncRes2.marked, false);
    assert.equal(await privacy.isConversationTainted(102), false);
    const learning2 = await privacy.filterConversationEntriesForLearning(102, bot2Entries);
    assert.equal(learning2.tainted, false);
    assert.equal(learning2.cleanEntries.length, 1);
    await assert.doesNotReject(() => privacy.assertExportAllowed(102, { operation: 'learning' }));

    // Verify frontend chatTurnModel attribution whitelist preserves google-workspace-rule only on host senders.
    const attrGoogle = normalizeAttribution(bot1Entries[0].data.attribution);
    assert.equal(attrGoogle?.sourceType, GOOGLE_WORKSPACE_RULE_SOURCE_TYPE);
    const attrWebhook = normalizeAttribution(bot2Entries[0].data.attribution);
    assert.equal(attrWebhook?.sourceType, 'webhook');
    const attrSpoofedUser = normalizeAttribution({
      kind: 'user',
      channel: 'primary',
      sourceType: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
    });
    assert.equal(attrSpoofedUser?.sourceType, undefined);

    // Verify receipts reached both Center tables.
    assert.equal(store.listGoogleRuleEvents(googleRule.id, { nowMs: testNow })[0].status, 'succeeded');
    assert.equal(store.listWebhookEvents(webhookRoute.id)[0].status, 'succeeded');
  } finally {
    cleanup();
  }
});

test('Host webhook consumer fails closed on partial trusted markers and when submitGoogleRule is unavailable', async () => {
  const webhookCalls = [];
  const receipts = [];
  let resolveDone;
  const receipted = new Promise(resolve => { resolveDone = resolve; });

  const malformedPartialEvent = {
    id: 'evt-partial',
    routeId: 'r1',
    routeName: 'Partial',
    deviceId: 'dev-1',
    botId: 'bot-1',
    requestId: 'req-partial',
    idempotencyKey: 'k1',
    status: 'dispatching',
    cancelRequested: false,
    admission: null,
    receivedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
    // Missing trustedSource: must be rejected by validateEvent!
    instruction: 'Do something.',
    payload: { ok: true },
  };
  const validGoogleEvent = {
    ...malformedPartialEvent,
    id: 'evt-google',
    requestId: 'req-google',
    idempotencyKey: 'k2',
    trustedSource: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
    dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
  };

  let polled = false;
  const client = {
    pollWebhookEvents: async () => {
      if (polled) return { items: [], nextCursor: null };
      polled = true;
      return { items: [malformedPartialEvent, validGoogleEvent], nextCursor: null };
    },
    stopWebhookEvents: async input => input,
    reportWebhookEvent: async (id, receipt) => {
      receipts.push({ id, receipt });
      resolveDone();
      return { id, ...receipt };
    },
  };

  const consumer = createWebhookConsumer({
    deviceId: 'dev-1',
    getClient: () => client,
    getRuntime: () => ({ getSubmission: async () => null }),
    isReady: () => true,
    getStopStates: async () => [{ botId: 'bot-1', stopEpoch: 1, pendingStopEpoch: null }],
    acknowledgeStop: async () => {},
    submitWebhook: async (...args) => {
      webhookCalls.push(args);
      return { status: 'done' };
    },
    // Intentionally omit submitGoogleRule to verify fail-closed behavior.
  });

  consumer.wake();
  await receipted;
  await consumer.close();

  assert.equal(webhookCalls.length, 0);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].id, 'evt-google');
  assert.equal(receipts[0].receipt.status, 'failed');
  assert.equal(receipts[0].receipt.error.code, GOOGLE_WORKSPACE_PRIVACY_UNAVAILABLE_CODE);
});
