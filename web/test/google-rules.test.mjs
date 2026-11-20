// Regression tests for Center Google Gmail/Calendar trigger rules, Orca MIT trigger matching,
// durable cursors/idempotency, offline pending/missed handling, multi-account isolation,
// and the shared Center->Host webhook poll/receipt/stop delivery seam.
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
} from '../../center-server/google-workspace/rules-orca.js';

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
          throw Object.assign(
            new Error(answer.message ?? `Google HTTP ${answer.status}`),
            { status: answer.status, code: answer.code },
          );
        }
        const parsed = read(answer.body);
        if (parsed === null) throw new Error('Unexpected response shape');
        return parsed;
      }
    }
    throw Object.assign(new Error(`Unhandled route ${url.pathname}`), { status: 404 });
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

test('Gmail rule seeds history from now, filters DMARC/ignored/old mail, and delivers durably through Host poll/receipt without fake webhook routes', async () => {
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
      loadOrca: async () => null,
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

    // Host polls via existing webhook delivery seam and receives validated delivery event.
    const poll = store.pollWebhookEvents('dev-1', null, now);
    assert.equal(poll.items.length, 1);
    const delivery = poll.items[0];
    assert.equal(delivery.deviceId, 'dev-1');
    assert.equal(delivery.botId, 'bot-1');
    assert.equal(delivery.routeId, rule.id);
    assert.equal(delivery.status, 'dispatching');
    assert.equal(delivery.idempotencyKey, 'gmail:ada@acme.dev:m1');
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
      loadOrca: async () => null,
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

    // Tick 1: label lookup hits 429 -> backs off 60s and keeps historyId at 7.
    await rules.tick();
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '7');
    const listed = await rules.manage('list', { deviceId: 'dev-1', botId: 'bot-1' });
    assert.equal(listed.items[0].runtime.status, 'backing_off');
    assert.equal(listed.items[0].runtime.rateLimited, true);

    // Within 60s backoff window: no new API calls.
    const callsAfter429 = fake.calls.length;
    labelsUp = true;
    now += 30_000;
    await rules.tick();
    assert.equal(fake.calls.length, callsAfter429);

    // After backoff expires: dispatch fails once -> historyId stays at 7.
    now += 60_000;
    await rules.tick();
    assert.equal(dispatched.length, 0);
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '7');

    // Next tick succeeds -> dispatches m1 and commits historyId 120.
    await rules.tick();
    assert.deepEqual(dispatched.map(d => d.eventKey), ['gmail:ada@acme.dev:m1']);
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.historyId, '120');

    // Simulate expired history (404): re-seeds to 100 without firing old mail.
    const expiredFake = makeFakeApi('ada@acme.dev', gmailRoutes([gmailMessage('m9')], 404));
    const rules2 = openGoogleRules({
      store,
      google: { ...google, api: async () => expiredFake.api },
      dispatch: async input => { dispatched.push(input); },
      now: () => now,
      loadOrca: async () => null,
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
          { id: 'in-window', startsIn: 10 * 60_000 + 20_000 }, // due in 20s -> schedules timer
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
      loadOrca: async () => null,
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

    // Tick 1: seeds sync-1, enqueues 'soon' (due now), schedules timer for 'in-window'.
    await rules.tick();
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.calendars?.primary?.syncToken, 'sync-1');
    assert.equal(activeTimers.size, 1);

    // Tick 2: Calendar returns 410 -> re-seeds sync-2, does NOT duplicate 'soon'.
    await rules.tick();
    assert.equal(store.getGoogleTriggerState().accounts['ada@acme.dev']?.calendars?.primary?.syncToken, 'sync-2');
    assert.equal(store.listGoogleRuleEvents(rule.id, { nowMs: now }).length, 1);

    // Host stays offline past meeting start time (NOW + 5m) -> event transitions to 'missed', never dispatched late!
    now = NOW + 6 * 60_000;
    const pollAfterStart = store.pollWebhookEvents('dev-1', null, now);
    assert.equal(pollAfterStart.items.length, 0);
    const events = store.listGoogleRuleEvents(rule.id, { nowMs: now });
    assert.equal(events[0].status, 'missed');
    assert.equal(events[0].error.code, 'MEETING_STARTED_WHILE_OFFLINE');

    // close() clears all pending timers.
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
      loadOrca: async () => null,
    });

    // Multiple accounts without explicit account must fail.
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

    // Alice goes into reconnect -> Alice's rule pauses, NEVER falls back to Bob.
    accountsState = [
      { id: 'a1', email: 'alice@acme.dev', status: 'reconnect', choices: ['gmail'], services: [{ service: 'gmail', state: 'needs-permission' }] },
      { id: 'a2', email: 'bob@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
    ];
    await rules.tick();
    assert.deepEqual(apiCalledFor, []);
    const pausedList = await rules.manage('list', { account: 'alice@acme.dev' });
    const aliceView = pausedList.items.find(r => r.id === aliceRule.id);
    const manualView = pausedList.items.find(r => r.id === manualPaused.id);
    assert.equal(aliceView.runtime.status, 'paused_account_reconnect');
    assert.equal(manualView.runtime.status, 'paused_disabled');

    // Alice reconnects -> Alice's enabled rule resumes; manually disabled rule stays paused!
    accountsState = [
      { id: 'a1', email: 'alice@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
      { id: 'a2', email: 'bob@acme.dev', status: 'connected', choices: ['gmail'], services: [{ service: 'gmail', state: 'ready' }] },
    ];
    await rules.tick();
    assert.deepEqual(apiCalledFor, ['alice@acme.dev']);
    const resumedList = await rules.manage('list', { account: 'alice@acme.dev' });
    assert.equal(resumedList.items.find(r => r.id === aliceRule.id).runtime.status, 'running');
    assert.equal(resumedList.items.find(r => r.id === manualPaused.id).runtime.status, 'paused_disabled');

    // Enqueue a pending event and verify stopWebhookEvents cancels it cleanly.
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

    // Removing Alice from Center pauses Alice's rule and never uses Bob.
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
