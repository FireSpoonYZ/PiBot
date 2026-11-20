import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GMAIL_DRAFT_ATTACH_MAX_BYTES,
  MAIL_CALENDAR_TOOL_NAMES,
  PAIRED_REQUEST_PARAMS_MAX_BYTES,
  TOOL_DOWNLOAD_MAX_BYTES,
  applyAskedBy,
  createMailCalendarTools,
  formatAskedByLine,
  mailCalendarTools,
} from '../../center-server/google-workspace/mail-calendar-tools.js';

function fakeApi(email = 'ada@acme.dev') {
  return {
    email,
    async get() {
      throw new Error('unexpected direct get');
    },
    async find() {
      throw new Error('unexpected direct find');
    },
    async send() {
      throw new Error('unexpected direct send');
    },
    async bytes() {
      throw new Error('unexpected direct bytes');
    },
  };
}

function makeHarness(overrides = {}) {
  const calls = [];
  const fixedNow = 1_762_340_400_000;
  const orca = {
    'google-gmail-read': {
      async searchGmail(api, args) {
        calls.push(['searchGmail', api.email, args]);
        return { account: api.email, threads: [], estimate: 0 };
      },
      async readGmail(api, args) {
        calls.push(['readGmail', api.email, args]);
        return { account: api.email, ref: args.ref, subject: 'Hi', messages: [] };
      },
      async downloadGmailAttachment(api, ref) {
        calls.push(['downloadGmailAttachment', api.email, ref]);
        return {
          ref,
          name: 'report.pdf',
          type: 'application/pdf',
          size: 5,
          data: Buffer.from('hello').toString('base64'),
        };
      },
      ...overrides['google-gmail-read'],
    },
    'google-gmail-write': {
      async saveGmailDraft(api, args) {
        calls.push(['saveGmailDraft', api.email, args]);
        return {
          account: api.email,
          ref: 'gmail:draft:r-1',
          messageRef: 'gmail:msg:m-1',
          threadRef: 'gmail:thread:t-1',
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject ?? '',
          kind: args.replyTo ? 'reply' : args.forward ? 'forward' : 'new',
          updated: Boolean(args.draft),
          attachments: args.attachments.map((file) => file.name),
          link: 'https://mail.google.com/mail/u/ada%40acme.dev/#drafts?compose=m-1',
        };
      },
      async sendGmailDraft(api, ref) {
        calls.push(['sendGmailDraft', api.email, ref]);
        return {
          account: api.email,
          messageRef: 'gmail:msg:m-2',
          threadRef: 'gmail:thread:t-1',
          to: ['sam@acme.dev'],
          cc: [],
          bcc: [],
          subject: 'Q3 plan',
        };
      },
      async modifyGmail(api, args) {
        calls.push(['modifyGmail', api.email, args]);
        return {
          account: api.email,
          refs: args.refs,
          added: args.add,
          removed: args.remove,
          created: [],
        };
      },
      ...overrides['google-gmail-write'],
    },
    'google-calendar-read': {
      async listCalendarEvents(api, args) {
        calls.push(['listCalendarEvents', api.email, args]);
        return {
          account: api.email,
          now: args.now,
          timeZone: 'America/New_York',
          calendar: { id: 'primary', name: 'Primary' },
          from: '2025-11-05T00:00:00-05:00',
          to: '2025-11-07T00:00:00-05:00',
          events: [],
        };
      },
      async listCalendars(api, now) {
        calls.push(['listCalendars', api.email, now]);
        return {
          account: api.email,
          now,
          timeZone: 'America/New_York',
          calendars: [{ id: 'primary', name: 'Primary', primary: true, access: 'owner' }],
        };
      },
      async getCalendarEvent(api, args) {
        calls.push(['getCalendarEvent', api.email, args]);
        return {
          account: api.email,
          now: args.now,
          timeZone: 'America/New_York',
          calendar: { id: 'primary', name: 'Primary' },
          event: {
            ref: args.ref,
            title: 'Review',
            start: '2025-11-05T14:00:00-05:00',
            end: '2025-11-05T14:30:00-05:00',
            allDay: false,
            attendees: [],
            recurring: false,
          },
        };
      },
      ...overrides['google-calendar-read'],
    },
    'google-calendar-write': {
      async createCalendarEvent(api, args) {
        calls.push(['createCalendarEvent', api.email, args]);
        return {
          account: api.email,
          now: args.now,
          timeZone: 'America/New_York',
          calendar: { id: 'primary', name: 'Primary' },
          action: 'created',
          event: {
            ref: 'calendar:primary:event:e1',
            title: args.title,
            start: args.start,
            end: args.end ?? args.start,
            allDay: Boolean(args.allDay),
            attendees: [],
            recurring: Boolean(args.repeat),
          },
          series: Boolean(args.repeat),
          notified: args.notify ? args.with : [],
        };
      },
      async updateCalendarEvent(api, args) {
        calls.push(['updateCalendarEvent', api.email, args]);
        return {
          account: api.email,
          now: args.now,
          timeZone: 'America/New_York',
          calendar: { id: 'primary', name: 'Primary' },
          action: 'updated',
          event: {
            ref: args.ref,
            title: args.title ?? 'Review',
            start: args.start ?? '2025-11-05T15:00:00-05:00',
            end: '2025-11-05T15:30:00-05:00',
            allDay: false,
            attendees: [],
            recurring: Boolean(args.series),
          },
          series: Boolean(args.series),
          notified: [],
        };
      },
      async deleteCalendarEvent(api, args) {
        calls.push(['deleteCalendarEvent', api.email, args]);
        return {
          account: api.email,
          now: args.now,
          timeZone: 'America/New_York',
          calendar: { id: 'primary', name: 'Primary' },
          action: 'deleted',
          event: {
            ref: args.ref,
            title: 'Review',
            start: '2025-11-05T14:00:00-05:00',
            end: '2025-11-05T14:30:00-05:00',
            allDay: false,
            attendees: [],
            recurring: false,
          },
          series: Boolean(args.series),
          notified: [],
          cancelled: true,
        };
      },
      async respondToCalendarEvent(api, args) {
        calls.push(['respondToCalendarEvent', api.email, args]);
        return {
          account: api.email,
          now: args.now,
          timeZone: 'America/New_York',
          calendar: { id: 'primary', name: 'Primary' },
          action: 'responded',
          event: {
            ref: args.ref,
            title: 'Review',
            start: '2025-11-05T14:00:00-05:00',
            end: '2025-11-05T14:30:00-05:00',
            allDay: false,
            attendees: [],
            recurring: false,
          },
          series: Boolean(args.series),
          notified: [],
          response: args.answer === 'accept' ? 'accepted' : args.answer === 'decline' ? 'declined' : 'tentative',
        };
      },
      ...overrides['google-calendar-write'],
    },
    'google-calendar-free-time': {
      async suggestCalendarTime(api, args) {
        calls.push(['suggestCalendarTime', api.email, args]);
        return {
          account: api.email,
          now: args.now,
          timeZone: 'America/New_York',
          durationMinutes: 30,
          hours: { from: '09:00', to: '17:00' },
          from: '2025-11-05T14:00:00.000Z',
          to: '2025-11-12T05:00:00.000Z',
          people: args.with,
          unknown: [],
          slots: [],
        };
      },
      ...overrides['google-calendar-free-time'],
    },
    'google-contacts-read': {
      async findContacts(api, query) {
        calls.push(['findContacts', api.email, query]);
        return { account: api.email, query, people: [], skipped: [] };
      },
      ...overrides['google-contacts-read'],
    },
  };

  const tools = createMailCalendarTools({
    loadOrca: async () => orca,
    now: () => fixedNow,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { calls, fixedNow, tools, byName };
}

test('mailCalendarTools exports all 15 upstream-aligned tools with strict schemas and no model caller spoofing', () => {
  assert.deepEqual(MAIL_CALENDAR_TOOL_NAMES, [
    'gmail_search',
    'gmail_read',
    'gmail_draft',
    'gmail_send',
    'gmail_archive',
    'gmail_label',
    'gmail_mark-read',
    'calendar_list',
    'calendar_get',
    'calendar_create',
    'calendar_update',
    'calendar_delete',
    'calendar_respond',
    'calendar_suggest-time',
    'contacts_find',
  ]);
  assert.equal(mailCalendarTools.length, 15);
  for (const tool of mailCalendarTools) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10);
    assert.equal(typeof tool.run, 'function');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties.account, `${tool.name} must allow optional account`);
    for (const forbidden of ['botToken', 'callerSessionId', 'askedBy', 'caller', 'actor']) {
      assert.equal(
        tool.inputSchema.properties[forbidden],
        undefined,
        `${tool.name} must not expose ${forbidden}`
      );
    }
  }
});

test('gmail_search, gmail_read (text + attachment), and contacts_find dispatch cleanly and enforce boundaries', async () => {
  const { calls, byName } = makeHarness();
  const api = fakeApi();

  await byName.get('gmail_search').run({ query: ' from:sam is:unread ', limit: 10, pageToken: 'p2', account: 'ada@acme.dev' }, { api });
  await byName.get('gmail_read').run({ ref: 'gmail:thread:18c2f0a1b2c3d4e5', offset: 16000 }, { api });
  const att = await byName.get('gmail_read').run({ download: 'gmail:att:18c2f0a1b2c3d4e5:2', out: 'downloads/report.pdf' }, { api });
  await byName.get('contacts_find').run({ query: ' Sam Lee ' }, { api });

  assert.equal(att.name, 'report.pdf');
  assert.equal(att.data, Buffer.from('hello').toString('base64'));
  assert.deepEqual(calls, [
    ['searchGmail', 'ada@acme.dev', { query: 'from:sam is:unread', pageToken: 'p2', limit: 10 }],
    ['readGmail', 'ada@acme.dev', { ref: 'gmail:thread:18c2f0a1b2c3d4e5', offset: 16000 }],
    ['downloadGmailAttachment', 'ada@acme.dev', 'gmail:att:18c2f0a1b2c3d4e5:2'],
    ['findContacts', 'ada@acme.dev', 'Sam Lee'],
  ]);

  await assert.rejects(
    () => byName.get('gmail_read').run({ ref: 'gmail:thread:1', download: 'gmail:att:1:2' }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );
  await assert.rejects(
    () => byName.get('gmail_read').run({ ref: 'gmail:att:18c2f0a1b2c3d4e5:2' }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );
  await assert.rejects(
    () => byName.get('gmail_read').run({ download: 'gmail:att:18c2f0a1b2c3d4e5:2', offset: 10 }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );
  await assert.rejects(
    () => byName.get('gmail_read').run({ ref: 'gmail:thread:18c2f0a1b2c3d4e5', out: 'x.txt' }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );
  await assert.rejects(
    () => byName.get('gmail_search').run({ query: 'test', limit: 51 }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );
});

test('gmail_read enforces TOOL_DOWNLOAD_MAX_BYTES defense-in-depth on attachment payload', async () => {
  const oversized = Buffer.alloc(TOOL_DOWNLOAD_MAX_BYTES + 1).toString('base64');
  const { byName } = makeHarness({
    'google-gmail-read': {
      async downloadGmailAttachment(_api, ref) {
        return { ref, name: 'big.bin', data: oversized };
      },
    },
  });
  await assert.rejects(
    () => byName.get('gmail_read').run({ download: 'gmail:att:18c2f0a1b2c3d4e5:2' }, { api: fakeApi() }),
    { code: 'INVALID_ARGUMENT' }
  );
});

test('gmail_draft handles address splitting, attribution, host-transferred attachments, and rejects local Center fs paths', async () => {
  const { calls, byName } = makeHarness();
  const api = fakeApi();
  const pdfBase64 = Buffer.from('%PDF-1.4').toString('base64');

  await byName.get('gmail_draft').run(
    {
      to: ['"Lee, Sam" <sam@acme.dev>, ana@acme.dev'],
      cc: ['ops@acme.dev'],
      subject: 'Q3 plan',
      body: 'Here is the update.',
      attachments: [{ name: 'plan.pdf', data: pdfBase64 }],
    },
    { api, askedBy: 'asked by Carol via Ivy' }
  );

  // Draft revision without body must not synthesize a body (keeps existing draft body intact).
  await byName.get('gmail_draft').run(
    { draft: 'gmail:draft:r-1', subject: 'Q3 plan (v2)' },
    { api, askedBy: 'asked by Carol via Ivy' }
  );

  assert.deepEqual(calls, [
    [
      'saveGmailDraft',
      'ada@acme.dev',
      {
        to: ['"Lee, Sam" <sam@acme.dev>', 'ana@acme.dev'],
        cc: ['ops@acme.dev'],
        bcc: [],
        subject: 'Q3 plan',
        body: 'Here is the update.\n\nasked by Carol via Ivy',
        attachments: [{ name: 'plan.pdf', data: pdfBase64 }],
      },
    ],
    [
      'saveGmailDraft',
      'ada@acme.dev',
      {
        to: [],
        cc: [],
        bcc: [],
        subject: 'Q3 plan (v2)',
        draft: 'gmail:draft:r-1',
        attachments: [],
      },
    ],
  ]);

  // Center must reject raw attach paths if Host did not transfer them.
  await assert.rejects(
    () =>
      byName.get('gmail_draft').run(
        { to: ['sam@acme.dev'], subject: 'Hi', body: 'See file', attach: ['/etc/passwd'] },
        { api }
      ),
    { code: 'INVALID_ARGUMENT' }
  );

  // Missing body without draft is rejected.
  await assert.rejects(
    () => byName.get('gmail_draft').run({ to: ['sam@acme.dev'], subject: 'Hi' }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );

  // Invalid base64 is rejected.
  await assert.rejects(
    () =>
      byName.get('gmail_draft').run(
        {
          to: ['sam@acme.dev'],
          subject: 'Hi',
          body: 'x',
          attachments: [{ name: 'bad.txt', data: 'not-valid-base64!' }],
        },
        { api }
      ),
    { code: 'INVALID_ARGUMENT' }
  );

  // Oversized attachment exceeds GMAIL_DRAFT_ATTACH_MAX_BYTES.
  const tooBig = Buffer.alloc(GMAIL_DRAFT_ATTACH_MAX_BYTES + 3).toString('base64');
  await assert.rejects(
    () =>
      byName.get('gmail_draft').run(
        {
          to: ['sam@acme.dev'],
          subject: 'Hi',
          body: 'x',
          attachments: [{ name: 'huge.bin', data: tooBig }],
        },
        { api }
      ),
    { code: 'INVALID_ARGUMENT' }
  );

  // Body + near-limit attachment exceeding PAIRED_REQUEST_PARAMS_MAX_BYTES is rejected.
  const nearMaxRaw = Math.floor((PAIRED_REQUEST_PARAMS_MAX_BYTES - 100_000) / 4) * 3;
  const nearMaxB64 = Buffer.alloc(Math.min(nearMaxRaw, GMAIL_DRAFT_ATTACH_MAX_BYTES - 3)).toString('base64');
  await assert.rejects(
    () =>
      byName.get('gmail_draft').run(
        {
          to: ['sam@acme.dev'],
          subject: 'Hi',
          body: 'a'.repeat(150_000),
          attachments: [{ name: 'large.bin', data: nearMaxB64 }],
        },
        { api }
      ),
    { code: 'INVALID_ARGUMENT' }
  );
});

test('gmail_send, gmail_archive, gmail_label, gmail_mark-read map directly to upstream write operations', async () => {
  const { calls, byName } = makeHarness();
  const api = fakeApi();

  await byName.get('gmail_send').run({ ref: 'gmail:draft:r-1' }, { api });
  await byName.get('gmail_archive').run({ refs: ['gmail:thread:1', 'gmail:msg:2'] }, { api });
  await byName.get('gmail_label').run({ refs: ['gmail:thread:1'], add: ['Receipts'], remove: ['To do'] }, { api });
  await byName.get('gmail_mark-read').run({ refs: ['gmail:thread:1'] }, { api });

  assert.deepEqual(calls, [
    ['sendGmailDraft', 'ada@acme.dev', 'gmail:draft:r-1'],
    ['modifyGmail', 'ada@acme.dev', { refs: ['gmail:thread:1', 'gmail:msg:2'], add: [], remove: ['inbox'] }],
    ['modifyGmail', 'ada@acme.dev', { refs: ['gmail:thread:1'], add: ['Receipts'], remove: ['To do'] }],
    ['modifyGmail', 'ada@acme.dev', { refs: ['gmail:thread:1'], add: [], remove: ['unread'] }],
  ]);

  await assert.rejects(
    () => byName.get('gmail_label').run({ refs: ['gmail:thread:1'] }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );
});

test('calendar tools dispatch with consistent now timestamp, defaults, attribution, and RSVP validation', async () => {
  const { calls, fixedNow, byName } = makeHarness();
  const api = fakeApi();

  await byName.get('calendar_list').run({}, { api });
  await byName.get('calendar_list').run({ calendars: true }, { api });
  await byName.get('calendar_get').run({ ref: 'calendar:primary:event:e1' }, { api });
  await byName.get('calendar_create').run(
    {
      title: 'Q3 review',
      start: '2026-11-05T14:00',
      duration: '45m',
      with: ['sam@acme.dev, ana@acme.dev'],
      body: 'Agenda',
      meet: true,
    },
    { api, askedBy: { name: 'Carol', botName: 'Ivy' } }
  );
  await byName.get('calendar_update').run(
    {
      ref: 'calendar:primary:event:e1',
      start: '2026-11-05T15:00',
      with: ['lee@acme.dev'],
      without: ['ana@acme.dev'],
      notify: false,
    },
    { api, askedBy: 'asked by Carol via Ivy' }
  );
  await byName.get('calendar_delete').run({ ref: 'calendar:primary:event:e1', series: true }, { api });
  await byName.get('calendar_respond').run({ ref: 'calendar:primary:event:e1', answer: 'ACCEPT' }, { api });
  await byName.get('calendar_suggest-time').run(
    { with: ['sam@acme.dev, ana@acme.dev'], duration: '30m', hours: '09:00-17:00' },
    { api }
  );

  assert.deepEqual(calls, [
    ['listCalendarEvents', 'ada@acme.dev', { now: fixedNow }],
    ['listCalendars', 'ada@acme.dev', fixedNow],
    ['getCalendarEvent', 'ada@acme.dev', { ref: 'calendar:primary:event:e1', now: fixedNow }],
    [
      'createCalendarEvent',
      'ada@acme.dev',
      {
        title: 'Q3 review',
        start: '2026-11-05T14:00',
        duration: '45m',
        body: 'Agenda\n\nasked by Carol via Ivy',
        with: ['sam@acme.dev', 'ana@acme.dev'],
        meet: true,
        notify: true,
        now: fixedNow,
      },
    ],
    [
      'updateCalendarEvent',
      'ada@acme.dev',
      {
        ref: 'calendar:primary:event:e1',
        start: '2026-11-05T15:00',
        with: ['lee@acme.dev'],
        without: ['ana@acme.dev'],
        notify: false,
        now: fixedNow,
      },
    ],
    ['deleteCalendarEvent', 'ada@acme.dev', { ref: 'calendar:primary:event:e1', series: true, notify: true, now: fixedNow }],
    ['respondToCalendarEvent', 'ada@acme.dev', { ref: 'calendar:primary:event:e1', answer: 'accept', now: fixedNow }],
    [
      'suggestCalendarTime',
      'ada@acme.dev',
      {
        with: ['sam@acme.dev', 'ana@acme.dev'],
        duration: '30m',
        hours: '09:00-17:00',
        now: fixedNow,
      },
    ],
  ]);

  await assert.rejects(
    () => byName.get('calendar_respond').run({ ref: 'calendar:primary:event:e1', answer: 'yes' }, { api }),
    { code: 'INVALID_ARGUMENT' }
  );
});

test('security boundaries: rejects model-supplied caller fields, missing api, and pre-aborted signals', async () => {
  const { calls, byName } = makeHarness();
  const api = fakeApi();

  for (const key of ['askedBy', 'botToken', 'callerSessionId', 'caller', 'actor']) {
    await assert.rejects(
      () => byName.get('gmail_search').run({ query: 'is:unread', [key]: 'spoofed' }, { api }),
      { code: 'INVALID_ARGUMENT' }
    );
  }

  await assert.rejects(
    () => byName.get('gmail_search').run({ query: 'is:unread' }, {}),
    { code: 'INVALID_STATE' }
  );

  const ac = new AbortController();
  ac.abort(new Error('cancelled'));
  await assert.rejects(
    () => byName.get('gmail_send').run({ ref: 'gmail:draft:r-1' }, { api, signal: ac.signal }),
    /cancelled/
  );
  assert.equal(calls.length, 0);
});

test('askedBy attribution formatting is bounded to 140 chars and idempotent', () => {
  assert.equal(formatAskedByLine('asked by Carol via Ivy'), 'asked by Carol via Ivy');
  assert.equal(formatAskedByLine('Carol', 'Ivy'), 'asked by Carol via Ivy');
  assert.equal(
    formatAskedByLine({ names: ['Carol', 'Dan', 'Carol'], botName: 'Ivy' }),
    'asked by Carol, Dan via Ivy'
  );
  assert.equal(
    applyAskedBy('Hello\n\nasked by Carol via Ivy', 'asked by Carol via Ivy'),
    'Hello\n\nasked by Carol via Ivy'
  );
  const longLine = formatAskedByLine({ names: ['A'.repeat(200)], botName: 'Ivy' });
  assert.ok(longLine.length <= 140);
  assert.ok(longLine.endsWith('via Ivy'));
});
