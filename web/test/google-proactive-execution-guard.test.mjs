import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';

import { GOOGLE_WORKSPACE_INSTALLATION_ID } from '../../center-contract/google-workspace.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { openCenterExecution } from '../../center-server/execution.js';
import { registerAuth } from '../../center-server/auth.js';
import { registerRoutes } from '../../center-server/routes.js';
import { errorStatus } from '../../center-server/server.js';
import {
  openGoogleAccounts,
  GOOGLE_ACCOUNTS_CREDENTIAL_ID,
} from '../../center-server/google-workspace/accounts.js';
import {
  createGoogleWorkspaceMcpAdapter,
  PROACTIVE_ASSISTANT_ALLOWED_TOOLS,
  resolveReadDraftPolicy,
} from '../../center-server/google-workspace/mcp-server.js';
import { createMailCalendarTools } from '../../center-server/google-workspace/mail-calendar-tools.js';
import { createFileTools } from '../../center-server/google-workspace/file-tools.js';

const Fastify = createRequire(new URL('../../center-server/package.json', import.meta.url))('fastify');

const PUBLIC_URL = 'https://center.example.com';
const OWNER_PASSWORD = 'owner-password-for-proactive-guard-tests';

const EXPECTED_ALLOWED_TOOLS = [
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
];

function makeOwnerPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function cookieOf(res, previous = '') {
  const raw = res.headers['set-cookie'];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((value) => value.split(';')[0]);
  return cookies.length ? cookies.join('; ') : previous;
}

function seedConnectedAccounts(store, records) {
  const accounts = {};
  const nowMs = Date.now();
  for (const item of records) {
    accounts[item.id] = {
      id: item.id,
      sub: item.id,
      email: item.email,
      client: {
        clientId: item.clientId ?? '123456-test.apps.googleusercontent.com',
        clientSecret: item.clientSecret ?? 'GOCSPX-testsecretvalue123456',
      },
      projectId: item.projectId ?? 'pibot-test-project',
      refreshToken: item.refreshToken ?? `1//refresh-${item.id}`,
      accessToken: item.accessToken ?? `ya29.access-${item.id}`,
      expiresAt: nowMs + 60 * 60 * 1000,
      grantedScopes: item.grantedScopes ?? [
        'openid',
        'email',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/drive',
      ],
      choices: item.choices ?? ['gmail', 'calendar', 'drive'],
      status: item.status ?? 'connected',
      services: item.services ?? [
        { service: 'gmail', state: 'ready' },
        { service: 'calendar', state: 'ready' },
        { service: 'drive', state: 'ready' },
      ],
      checkedAt: nowMs,
      connectedAt: nowMs,
      updatedAt: nowMs,
    };
  }
  const existing = store.getCredential(GOOGLE_ACCOUNTS_CREDENTIAL_ID);
  store.putCredential(GOOGLE_ACCOUNTS_CREDENTIAL_ID, {
    expectedRevision: existing?.revision ?? null,
    value: JSON.stringify({ version: 1, accounts }),
  });
}

function parseErrorPayload(mcpResult) {
  assert.equal(mcpResult.isError, true);
  const parsed = JSON.parse(mcpResult.content[0].text);
  assert.ok(parsed && typeof parsed.error === 'object');
  return parsed.error;
}

function buildMockedTools(recordedCalls) {
  const orca = {
    'google-gmail-read': {
      async searchGmail(api, args) {
        recordedCalls.push({ op: 'searchGmail', email: api.email, args });
        return { account: api.email, threads: [], estimate: 0 };
      },
      async readGmail(api, args) {
        recordedCalls.push({ op: 'readGmail', email: api.email, args });
        return { account: api.email, ref: args.ref, subject: 'Re: Status', messages: [] };
      },
      async downloadGmailAttachment(api, ref) {
        recordedCalls.push({ op: 'downloadGmailAttachment', email: api.email, ref });
        return {
          ref,
          name: 'report.pdf',
          type: 'application/pdf',
          size: 5,
          data: Buffer.from('hello').toString('base64'),
        };
      },
    },
    'google-gmail-write': {
      async saveGmailDraft(api, args) {
        recordedCalls.push({ op: 'saveGmailDraft', email: api.email, args });
        return {
          account: api.email,
          ref: 'gmail:draft:d-1',
          messageRef: 'gmail:msg:m-draft-1',
          threadRef: 'gmail:thread:t-1',
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject ?? '',
          kind: args.replyTo ? 'reply' : args.forward ? 'forward' : 'new',
          updated: Boolean(args.draft),
          attachments: args.attachments.map((file) => file.name),
        };
      },
      async sendGmailDraft(api, ref) {
        recordedCalls.push({ op: 'sendGmailDraft', email: api.email, ref });
        return { account: api.email, messageRef: 'gmail:msg:sent-1', threadRef: 'gmail:thread:t-1' };
      },
      async modifyGmail(api, args) {
        recordedCalls.push({ op: 'modifyGmail', email: api.email, args });
        return { account: api.email, refs: args.refs };
      },
    },
    'google-calendar-read': {
      async listCalendarEvents(api, args) {
        recordedCalls.push({ op: 'listCalendarEvents', email: api.email, args });
        return { account: api.email, events: [] };
      },
      async getCalendarEvent(api, args) {
        recordedCalls.push({ op: 'getCalendarEvent', email: api.email, args });
        return { account: api.email, event: { ref: args.ref, title: 'Sync' } };
      },
    },
    'google-calendar-write': {
      async createCalendarEvent(api, args) {
        recordedCalls.push({ op: 'createCalendarEvent', email: api.email, args });
        return { account: api.email, action: 'created', event: { ref: 'calendar:primary:event:e1', title: args.title } };
      },
    },
    'google-calendar-free-time': {
      async suggestCalendarTime(api, args) {
        recordedCalls.push({ op: 'suggestCalendarTime', email: api.email, args });
        return { account: api.email, slots: [] };
      },
    },
    'google-contacts-read': {
      async findContacts(api, query) {
        recordedCalls.push({ op: 'findContacts', email: api.email, query });
        return { account: api.email, contacts: [] };
      },
    },
    'google-drive': {
      async searchDrive(api, args) {
        recordedCalls.push({ op: 'searchDrive', email: api.email, args });
        return { account: api.email, files: [] };
      },
      async shareDrive(api, args) {
        recordedCalls.push({ op: 'shareDrive', email: api.email, args });
        return { account: api.email, shared: true };
      },
    },
    'google-drive-read': {
      async readDrive(api, args) {
        recordedCalls.push({ op: 'readDrive', email: api.email, args });
        return { account: api.email, ref: args.ref, text: 'hello' };
      },
      async downloadDrive(api, ref) {
        recordedCalls.push({ op: 'downloadDrive', email: api.email, ref });
        return { ref, name: 'doc.pdf', data: Buffer.from('pdf').toString('base64') };
      },
    },
    'google-docs': {
      async readDoc(api, args) {
        recordedCalls.push({ op: 'readDoc', email: api.email, args });
        return { account: api.email, ref: args.ref, markdown: '# Doc' };
      },
    },
    'google-sheets': {
      async readSheet(api, args) {
        recordedCalls.push({ op: 'readSheet', email: api.email, args });
        return { account: api.email, ref: args.ref, values: [] };
      },
    },
  };

  return [
    ...createMailCalendarTools({ loadOrca: async () => orca }),
    ...createFileTools({ loadOrca: async () => orca }),
  ];
}

async function openGuardHarness({ accounts = [{ id: 'sub-work', email: 'work@co.com' }, { id: 'sub-personal', email: 'personal@gmail.com' }], initialBinding = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pibot-google-proactive-guard-'));
  const rawStore = openCenterStore({ dataRoot: dir, encryptionKey: randomBytes(32) });
  let assistantBinding = initialBinding;

  // Preserve compatibility both before and after store.getGoogleAssistant lands in data/google-rules.js.
  const store = Object.assign(Object.create(rawStore), {
    getGoogleAssistant: () => assistantBinding,
  });

  seedConnectedAccounts(rawStore, accounts);

  const googleAccounts = await openGoogleAccounts({
    store: rawStore,
    publicUrl: PUBLIC_URL,
    fetchImpl: async () => {
      throw new Error('Unexpected outbound Google HTTP request in guard test');
    },
  });

  const recordedCalls = [];
  const tools = buildMockedTools(recordedCalls);
  const adapter = createGoogleWorkspaceMcpAdapter({
    accounts: googleAccounts,
    tools,
    getAssistantBinding: () => (typeof store.getGoogleAssistant === 'function' ? store.getGoogleAssistant() : null),
  });

  const execution = openCenterExecution({
    store,
    packages: { async getInstalled() { return null; } },
    oauth: {},
    builtinAdapters: new Map([[GOOGLE_WORKSPACE_INSTALLATION_ID, adapter]]),
  });

  const bridge = openHostBridge({
    dataRoot: dir,
    store,
    linkUrl: 'wss://center.example.com/v1/link',
    relay: { getStatus: () => ({ onlineDeviceIds: [] }) },
  });

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook('onRequest', (req, reply, done) => {
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    done();
  });
  app.setErrorHandler((error, _req, reply) => {
    let code = error.code;
    if (code === 'FST_CSRF_INVALID_TOKEN' || code === 'FST_CSRF_MISSING_SECRET') code = 'CSRF_INVALID';
    else if (error.statusCode === 429) code = 'RATE_LIMITED';
    else if (error.statusCode === 413) code = 'PAYLOAD_TOO_LARGE';
    else if (error.statusCode === 400 && !errorStatus[code]) code = 'INVALID_ARGUMENT';
    if (!errorStatus[code]) code = 'INTERNAL_ERROR';
    reply.code(errorStatus[code] || 500).send({
      error: {
        code,
        message: code === 'INTERNAL_ERROR' ? 'Internal error' : code.replaceAll('_', ' ').toLowerCase(),
      },
    });
  });

  await registerAuth(app, {
    sessionKey: randomBytes(32),
    ownerPasswordHash: makeOwnerPasswordHash(OWNER_PASSWORD),
  });

  const routes = registerRoutes(app, {
    store,
    packages: { async reconcileDevice() {} },
    bridge,
    execution,
    oauth: {},
    linkUrl: 'wss://center.example.com/v1/link',
    turns: {},
    publicUrl: PUBLIC_URL,
    google: { accounts: googleAccounts },
  });
  await app.ready();

  async function loginOwner() {
    let res = await app.inject({ method: 'GET', url: '/api/session' });
    let cookie = cookieOf(res);
    res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { cookie, 'x-csrf-token': res.json().csrfToken },
      payload: { password: OWNER_PASSWORD },
    });
    assert.equal(res.statusCode, 200);
    cookie = cookieOf(res, cookie);
    return { cookie, csrfToken: res.json().csrfToken };
  }

  async function registerDevice(owner, displayName, bots) {
    const devRes = await app.inject({
      method: 'POST',
      url: '/api/devices',
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrfToken },
      payload: { displayName, platform: 'linux' },
    });
    assert.equal(devRes.statusCode, 201);
    const { deviceId, deviceToken } = devRes.json();
    rawStore.replaceDeviceBots(
      deviceId,
      bots.map((bot, idx) => ({
        deviceId,
        botId: bot.botId,
        name: bot.name ?? bot.botId,
        isPrimary: bot.isPrimary ?? idx === 0,
      })),
    );
    return {
      deviceId,
      deviceToken,
      headers: { authorization: `Bearer ${deviceToken}`, 'x-device-id': deviceId },
    };
  }

  return {
    app,
    store,
    rawStore,
    execution,
    adapter,
    recordedCalls,
    setBinding(next) {
      assistantBinding = next;
    },
    loginOwner,
    registerDevice,
    async close() {
      routes.close();
      await app.close();
      await execution.close();
      await adapter.close();
      googleAccounts.close();
      bridge.close();
      rawStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('PROACTIVE_ASSISTANT_ALLOWED_TOOLS and resolveReadDraftPolicy match frozen contract', () => {
  assert.deepEqual([...PROACTIVE_ASSISTANT_ALLOWED_TOOLS], EXPECTED_ALLOWED_TOOLS);

  const dedicatedBinding = {
    enabled: true,
    deviceId: 'dev-1',
    botId: 'bot-guard',
    mode: 'dedicated',
    accounts: ['Work@Co.com'],
  };
  const dedicatedPolicy = resolveReadDraftPolicy(
    { deviceId: 'dev-1', botId: 'bot-guard', backgroundProactive: false },
    () => dedicatedBinding,
  );
  assert.equal(dedicatedPolicy.restricted, true);
  assert.equal(dedicatedPolicy.mode, 'dedicated');
  assert.deepEqual([...dedicatedPolicy.allowedAccounts], ['work@co.com']);

  const existingBinding = {
    enabled: true,
    deviceId: 'dev-1',
    botId: 'bot-main',
    mode: 'existing',
    accounts: [],
  };
  assert.equal(
    resolveReadDraftPolicy({ deviceId: 'dev-1', botId: 'bot-main', backgroundProactive: false }, () => existingBinding).restricted,
    false,
  );
  const existingBgPolicy = resolveReadDraftPolicy(
    { deviceId: 'dev-1', botId: 'bot-main', backgroundProactive: true },
    () => existingBinding,
  );
  assert.equal(existingBgPolicy.restricted, true);
  assert.equal(existingBgPolicy.allowedAccounts, null);

  assert.equal(
    resolveReadDraftPolicy({ deviceId: 'dev-1', botId: 'bot-other', backgroundProactive: true }, () => dedicatedBinding).restricted,
    false,
  );
  assert.equal(
    resolveReadDraftPolicy({ deviceId: 'dev-2', botId: 'bot-guard', backgroundProactive: true }, () => dedicatedBinding).restricted,
    false,
  );
  assert.equal(
    resolveReadDraftPolicy({ deviceId: 'dev-1', botId: 'bot-guard', backgroundProactive: true }, () => ({ ...dedicatedBinding, enabled: false })).restricted,
    false,
  );
});

test('dedicated Bot always exposes only 12 allowed tools and blocks write/download/share tools across both execution and MCP layers', async () => {
  const harness = await openGuardHarness();
  try {
    const owner = await harness.loginOwner();
    const dev = await harness.registerDevice(owner, 'Node-Dedicated', [
      { botId: 'bot-dedicated', name: 'MailGuard', isPrimary: false },
      { botId: 'bot-other', name: 'General', isPrimary: true },
    ]);

    harness.setBinding({
      enabled: true,
      deviceId: dev.deviceId,
      botId: 'bot-dedicated',
      mode: 'dedicated',
      accounts: ['work@co.com'],
    });

    // Dedicated Bot is ALWAYS restricted — even when backgroundProactive is omitted or false.
    for (const bgFlag of [undefined, false, true]) {
      const listed = await harness.execution.listTools(
        dev.deviceId,
        GOOGLE_WORKSPACE_INSTALLATION_ID,
        bgFlag === undefined ? { botId: 'bot-dedicated' } : { botId: 'bot-dedicated', backgroundProactive: bgFlag },
      );
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        [...EXPECTED_ALLOWED_TOOLS].sort(),
      );
    }

    const forbiddenTools = [
      ['gmail_send', { ref: 'gmail:draft:d-1', account: 'work@co.com' }],
      ['gmail_archive', { refs: ['gmail:thread:t-1'], account: 'work@co.com' }],
      ['gmail_label', { refs: ['gmail:thread:t-1'], add: ['Work'], account: 'work@co.com' }],
      ['gmail_mark-read', { refs: ['gmail:thread:t-1'], account: 'work@co.com' }],
      ['calendar_create', { title: 'Meeting', start: '2026-12-01T10:00:00Z', account: 'work@co.com' }],
      ['calendar_update', { ref: 'calendar:primary:event:e1', title: 'Moved', account: 'work@co.com' }],
      ['calendar_delete', { ref: 'calendar:primary:event:e1', account: 'work@co.com' }],
      ['calendar_respond', { ref: 'calendar:primary:event:e1', answer: 'accept', account: 'work@co.com' }],
      ['drive_download', { ref: 'file-1', account: 'work@co.com' }],
      ['drive_upload', { name: 'a.txt', data: 'YQ==', account: 'work@co.com' }],
      ['drive_mkdir', { name: 'Folder', account: 'work@co.com' }],
      ['drive_move', { ref: 'file-1', folder: 'root', account: 'work@co.com' }],
      ['drive_share', { ref: 'file-1', with: ['x@co.com'], account: 'work@co.com' }],
      ['docs_create', { title: 'New Doc', account: 'work@co.com' }],
      ['docs_append', { ref: 'doc-1', markdown: 'hi', account: 'work@co.com' }],
      ['docs_replace', { ref: 'doc-1', old: 'a', new: 'b', account: 'work@co.com' }],
      ['docs_comment', { ref: 'doc-1', comment: 'hi', account: 'work@co.com' }],
      ['sheets_create', { title: 'New Sheet', account: 'work@co.com' }],
      ['sheets_write', { ref: 'sheet-1', range: 'A1', values: [['x']], account: 'work@co.com' }],
      ['sheets_append', { ref: 'sheet-1', values: [['x']], account: 'work@co.com' }],
      ['sheets_upsert', { ref: 'sheet-1', key: 'id', values: [['1']], account: 'work@co.com' }],
    ];

    const client = await harness.adapter.getClient();
    for (const [toolName, args] of forbiddenTools) {
      // 1. Rejected by openCenterExecution (listTools defense-in-depth).
      await assert.rejects(
        () => harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
          botId: 'bot-dedicated',
          callId: `exec-${toolName}`,
          name: toolName,
          args,
        }),
        (err) => err?.code === 'FORBIDDEN',
        `execution.callTool must reject ${toolName}`,
      );

      // 2. Rejected directly inside MCP CallToolRequestSchema (defense-in-depth).
      const directRes = await harness.adapter.runWithCaller(
        { deviceId: dev.deviceId, botId: 'bot-dedicated', callId: `direct-${toolName}` },
        () => client.callTool(toolName, args),
      );
      const errPayload = parseErrorPayload(directRes);
      assert.equal(errPayload.code, 'FORBIDDEN', `mcp-server must reject ${toolName}`);
    }

    assert.equal(harness.recordedCalls.length, 0);
  } finally {
    await harness.close();
  }
});

test('dedicated Bot enforces gmail_read download/out restrictions and gmail_draft reply-only invariants', async () => {
  const harness = await openGuardHarness();
  try {
    const owner = await harness.loginOwner();
    const dev = await harness.registerDevice(owner, 'Node-MailRules', [
      { botId: 'bot-dedicated', name: 'MailGuard', isPrimary: true },
    ]);
    harness.setBinding({
      enabled: true,
      deviceId: dev.deviceId,
      botId: 'bot-dedicated',
      mode: 'dedicated',
      accounts: ['work@co.com'],
    });

    // Normal gmail_read({ ref }) -> allowed.
    const okRead = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'read-ok',
      name: 'gmail_read',
      args: { ref: 'gmail:thread:t-42', account: 'work@co.com' },
    });
    assert.notEqual(okRead.isError, true);
    assert.equal(harness.recordedCalls.at(-1).op, 'readGmail');

    // gmail_read with download or out -> FORBIDDEN.
    for (const badReadArgs of [
      { download: 'gmail:att:m-1:1', account: 'work@co.com' },
      { download: 'gmail:att:m-1:1', out: 'report.pdf', account: 'work@co.com' },
      { ref: 'gmail:thread:t-42', out: 'dump.txt', account: 'work@co.com' },
      { download: null, account: 'work@co.com' },
    ]) {
      const res = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
        botId: 'bot-dedicated',
        callId: 'read-bad',
        name: 'gmail_read',
        args: badReadArgs,
      });
      const err = parseErrorPayload(res);
      assert.equal(err.code, 'FORBIDDEN');
      assert.match(err.message, /Attachment download to disk is disabled/i);
    }

    // Valid in-thread reply draft -> allowed.
    const okDraft = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'draft-ok',
      name: 'gmail_draft',
      args: { replyTo: 'gmail:msg:m-10', body: 'Thanks, reviewing today.', account: 'work@co.com' },
    });
    assert.notEqual(okDraft.isError, true);
    assert.equal(harness.recordedCalls.at(-1).op, 'saveGmailDraft');

    const callsBeforeInvalidDrafts = harness.recordedCalls.length;

    // Invalid gmail_draft variants -> ALL FORBIDDEN.
    const badDraftCases = [
      { body: 'Cold outreach without replyTo' },
      { replyTo: '   ', body: 'Blank replyTo' },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', to: ['external@evil.com'] },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', to: [] },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', cc: ['cc@co.com'] },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', bcc: ['bcc@co.com'] },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', replyAll: true },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', replyAll: false },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', forward: 'gmail:msg:m-11' },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', draft: 'gmail:draft:d-1' },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', attach: ['secrets.env'] },
      { replyTo: 'gmail:msg:m-10', body: 'Hi', attachments: [{ name: 'a.txt', data: 'YQ==' }] },
    ];

    for (const badDraftArgs of badDraftCases) {
      const res = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
        botId: 'bot-dedicated',
        callId: 'draft-bad',
        name: 'gmail_draft',
        args: { ...badDraftArgs, account: 'work@co.com' },
      });
      const err = parseErrorPayload(res);
      assert.equal(err.code, 'FORBIDDEN', `expected FORBIDDEN for ${JSON.stringify(badDraftArgs)}`);
      assert.match(err.message, /in-thread replies/i);
    }

    assert.equal(harness.recordedCalls.length, callsBeforeInvalidDrafts);
  } finally {
    await harness.close();
  }
});

test('account allowlist blocks disallowed emails/IDs, auto-selects single bound account, and filters ambiguous choices', async () => {
  const harness = await openGuardHarness({
    accounts: [
      { id: 'sub-work', email: 'work@co.com' },
      { id: 'sub-ops', email: 'ops@co.com' },
      { id: 'sub-personal', email: 'personal@gmail.com' },
    ],
  });
  try {
    const owner = await harness.loginOwner();
    const dev = await harness.registerDevice(owner, 'Node-Accounts', [
      { botId: 'bot-dedicated', name: 'MailGuard', isPrimary: true },
    ]);

    // 1. Single allowed account: work@co.com.
    harness.setBinding({
      enabled: true,
      deviceId: dev.deviceId,
      botId: 'bot-dedicated',
      mode: 'dedicated',
      accounts: ['work@co.com'],
    });

    // Explicit allowed account (including mixed case) succeeds.
    const okExplicit = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'acct-ok-explicit',
      name: 'gmail_search',
      args: { query: 'is:unread', account: 'Work@Co.com' },
    });
    assert.notEqual(okExplicit.isError, true);
    assert.equal(harness.recordedCalls.at(-1).email, 'work@co.com');

    // Omitting account auto-selects the single bound account cleanly without ambiguity.
    const okAuto = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'acct-ok-auto',
      name: 'gmail_search',
      args: { query: 'is:starred' },
    });
    assert.notEqual(okAuto.isError, true);
    assert.equal(harness.recordedCalls.at(-1).email, 'work@co.com');

    const callsBeforeBlocked = harness.recordedCalls.length;

    // Disallowed account by email -> FORBIDDEN.
    const blockedEmail = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'acct-blocked-email',
      name: 'gmail_search',
      args: { query: 'is:unread', account: 'personal@gmail.com' },
    });
    assert.equal(parseErrorPayload(blockedEmail).code, 'FORBIDDEN');

    // Disallowed account by internal Google sub ID -> FORBIDDEN after resolution before tool.run.
    const blockedId = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'acct-blocked-id',
      name: 'gmail_search',
      args: { query: 'is:unread', account: 'sub-personal' },
    });
    assert.equal(parseErrorPayload(blockedId).code, 'FORBIDDEN');

    // Unconnected foreign email -> FORBIDDEN (never leaks whether it exists).
    const blockedForeign = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'acct-blocked-foreign',
      name: 'gmail_search',
      args: { query: 'is:unread', account: 'stranger@other.org' },
    });
    assert.equal(parseErrorPayload(blockedForeign).code, 'FORBIDDEN');

    assert.equal(harness.recordedCalls.length, callsBeforeBlocked);

    // 2. Two allowed accounts (work@co.com, ops@co.com) with personal@gmail.com excluded:
    // Omitting account returns GOOGLE_ACCOUNT_AMBIGUOUS listing ONLY allowed accounts.
    harness.setBinding({
      enabled: true,
      deviceId: dev.deviceId,
      botId: 'bot-dedicated',
      mode: 'dedicated',
      accounts: ['work@co.com', 'ops@co.com'],
    });
    const ambig = await harness.execution.callTool(dev.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-dedicated',
      callId: 'acct-ambig',
      name: 'gmail_search',
      args: { query: 'is:unread' },
    });
    const ambigErr = parseErrorPayload(ambig);
    assert.equal(ambigErr.code, 'GOOGLE_ACCOUNT_AMBIGUOUS');
    assert.deepEqual(ambigErr.accounts.map((a) => a.email).sort(), ['ops@co.com', 'work@co.com']);
    assert.doesNotMatch(ambig.content[0].text, /personal@gmail\.com/);
    assert.deepEqual(
      ambig._meta['pibot/accountChoices'].map((a) => a.email).sort(),
      ['ops@co.com', 'work@co.com'],
    );
  } finally {
    await harness.close();
  }
});

test('existing Bot is unrestricted on foreground turns, restricted on backgroundProactive turns, and strips model-spoofed backgroundProactive', async () => {
  const harness = await openGuardHarness();
  try {
    const owner = await harness.loginOwner();
    const devA = await harness.registerDevice(owner, 'Node-Existing', [
      { botId: 'bot-main', name: 'MainBot', isPrimary: true },
      { botId: 'bot-unrelated', name: 'OtherBot', isPrimary: false },
    ]);
    const devB = await harness.registerDevice(owner, 'Node-OtherDevice', [
      { botId: 'bot-main', name: 'SameIdOtherDevice', isPrimary: true },
    ]);

    harness.setBinding({
      enabled: true,
      deviceId: devA.deviceId,
      botId: 'bot-main',
      mode: 'existing',
      accounts: ['work@co.com'],
    });

    // 1. Existing Bot foreground turn (omitted and false): full 33 tools, writes/downloads/other accounts allowed.
    for (const bgFlag of [undefined, false]) {
      const fgList = await harness.execution.listTools(
        devA.deviceId,
        GOOGLE_WORKSPACE_INSTALLATION_ID,
        bgFlag === undefined ? { botId: 'bot-main' } : { botId: 'bot-main', backgroundProactive: bgFlag },
      );
      const fgNames = fgList.tools.map((t) => t.name);
      assert.equal(fgNames.length, 33);
      assert.ok(fgNames.includes('gmail_send'));
      assert.ok(fgNames.includes('drive_download'));
    }

    const fgSend = await harness.execution.callTool(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-main',
      callId: 'fg-send',
      name: 'gmail_send',
      args: { ref: 'gmail:draft:d-1', account: 'personal@gmail.com' },
    });
    assert.notEqual(fgSend.isError, true);
    assert.equal(harness.recordedCalls.at(-1).op, 'sendGmailDraft');
    assert.equal(harness.recordedCalls.at(-1).email, 'personal@gmail.com');

    const fgDownload = await harness.execution.callTool(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-main',
      callId: 'fg-dl',
      name: 'gmail_read',
      args: { download: 'gmail:att:m-1:1', account: 'work@co.com' },
    });
    assert.notEqual(fgDownload.isError, true);
    assert.equal(harness.recordedCalls.at(-1).op, 'downloadGmailAttachment');

    const fgNewDraft = await harness.execution.callTool(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-main',
      callId: 'fg-draft',
      name: 'gmail_draft',
      args: { to: ['bob@co.com'], subject: 'Hello', body: 'Foreground draft', account: 'personal@gmail.com' },
    });
    assert.notEqual(fgNewDraft.isError, true);
    assert.equal(harness.recordedCalls.at(-1).op, 'saveGmailDraft');

    // 2. Existing Bot background proactive turn (backgroundProactive: true): restricted identically to dedicated Bot.
    const bgList = await harness.execution.listTools(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-main',
      backgroundProactive: true,
    });
    assert.deepEqual(
      bgList.tools.map((t) => t.name).sort(),
      [...EXPECTED_ALLOWED_TOOLS].sort(),
    );

    await assert.rejects(
      () => harness.execution.callTool(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
        botId: 'bot-main',
        callId: 'bg-send',
        name: 'gmail_send',
        args: { ref: 'gmail:draft:d-1', account: 'work@co.com', backgroundProactive: false },
        backgroundProactive: true,
      }),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Model-supplied `backgroundProactive: false` inside args MUST be stripped and CANNOT bypass trusted caller context.
    const spoofedDraft = await harness.execution.callTool(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-main',
      callId: 'bg-spoof-draft',
      name: 'gmail_draft',
      args: { to: ['attacker@evil.com'], body: 'Spoofed', account: 'work@co.com', backgroundProactive: false },
      backgroundProactive: true,
    });
    assert.equal(parseErrorPayload(spoofedDraft).code, 'FORBIDDEN');

    const spoofedAccount = await harness.execution.callTool(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-main',
      callId: 'bg-spoof-acct',
      name: 'gmail_search',
      args: { query: 'is:unread', account: 'personal@gmail.com', backgroundProactive: false },
      backgroundProactive: true,
    });
    assert.equal(parseErrorPayload(spoofedAccount).code, 'FORBIDDEN');

    // Allowed read with stripped model-supplied `backgroundProactive: false` executes safely on allowed account.
    const bgOkSearch = await harness.execution.callTool(devA.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
      botId: 'bot-main',
      callId: 'bg-ok-search',
      name: 'gmail_search',
      args: { query: 'is:unread', account: 'work@co.com', backgroundProactive: false },
      backgroundProactive: true,
    });
    assert.notEqual(bgOkSearch.isError, true);
    assert.equal(harness.recordedCalls.at(-1).op, 'searchGmail');
    assert.equal(harness.recordedCalls.at(-1).email, 'work@co.com');

    // 3. Unrelated Bot on same device & same botId on different device are completely unaffected even with backgroundProactive: true.
    for (const target of [
      { deviceId: devA.deviceId, botId: 'bot-unrelated' },
      { deviceId: devB.deviceId, botId: 'bot-main' },
    ]) {
      const otherList = await harness.execution.listTools(target.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
        botId: target.botId,
        backgroundProactive: true,
      });
      assert.equal(otherList.tools.length, 33);

      const otherSend = await harness.execution.callTool(target.deviceId, GOOGLE_WORKSPACE_INSTALLATION_ID, {
        botId: target.botId,
        callId: `other-send-${target.deviceId}-${target.botId}`,
        name: 'gmail_send',
        args: { ref: 'gmail:draft:d-1', account: 'personal@gmail.com' },
        backgroundProactive: true,
      });
      assert.notEqual(otherSend.isError, true);
    }
  } finally {
    await harness.close();
  }
});

test('HTTP host routes validate backgroundProactive strictly, enforce guardrails, and expose sanitized assistant summary on /api/host/google/status', async () => {
  const harness = await openGuardHarness();
  try {
    const owner = await harness.loginOwner();
    const dev = await harness.registerDevice(owner, 'Node-HTTP', [
      { botId: 'bot-main', name: 'MainBot', isPrimary: true },
    ]);

    // 1. /api/host/google/status returns assistant: null when unconfigured.
    const statusNull = await harness.app.inject({
      method: 'GET',
      url: '/api/host/google/status',
      headers: dev.headers,
    });
    assert.equal(statusNull.statusCode, 200);
    assert.equal(statusNull.headers['cache-control'], 'no-store');
    assert.equal(statusNull.json().assistant, null);

    // Configure existing-mode assistant binding.
    harness.setBinding({
      enabled: true,
      deviceId: dev.deviceId,
      botId: 'bot-main',
      mode: 'existing',
      accounts: ['work@co.com'],
      secretShouldNotAppear: 'ya29.must-never-leak',
    });

    const statusBound = await harness.app.inject({
      method: 'GET',
      url: '/api/host/google/status',
      headers: dev.headers,
    });
    assert.equal(statusBound.statusCode, 200);
    assert.deepEqual(statusBound.json().assistant, {
      enabled: true,
      deviceId: dev.deviceId,
      botId: 'bot-main',
      mode: 'existing',
      accounts: ['work@co.com'],
    });
    assert.doesNotMatch(statusBound.body, /ya29\.|1\/\/refresh|GOCSPX-|secretShouldNotAppear/);

    const listUrl = `/api/host/capabilities/${encodeURIComponent(GOOGLE_WORKSPACE_INSTALLATION_ID)}/tools/list`;
    const callUrl = `/api/host/capabilities/${encodeURIComponent(GOOGLE_WORKSPACE_INSTALLATION_ID)}/tools/call`;

    // 2. Non-boolean backgroundProactive is rejected with 400 INVALID_ARGUMENT on both tools/list and tools/call.
    for (const invalidVal of ['true', 'false', 1, 0, null, {}]) {
      const badList = await harness.app.inject({
        method: 'POST',
        url: listUrl,
        headers: dev.headers,
        payload: { botId: 'bot-main', backgroundProactive: invalidVal },
      });
      assert.equal(badList.statusCode, 400);
      assert.equal(badList.json().error.code, 'INVALID_ARGUMENT');

      const badCall = await harness.app.inject({
        method: 'POST',
        url: callUrl,
        headers: dev.headers,
        payload: {
          botId: 'bot-main',
          callId: 'c-invalid',
          name: 'gmail_search',
          args: { query: 'is:unread' },
          backgroundProactive: invalidVal,
        },
      });
      assert.equal(badCall.statusCode, 400);
      assert.equal(badCall.json().error.code, 'INVALID_ARGUMENT');
    }

    // 3. Valid boolean backgroundProactive forwards to Center execution and enforces guardrails end-to-end over HTTP.
    const httpBgList = await harness.app.inject({
      method: 'POST',
      url: listUrl,
      headers: dev.headers,
      payload: { botId: 'bot-main', backgroundProactive: true },
    });
    assert.equal(httpBgList.statusCode, 200);
    assert.deepEqual(
      httpBgList.json().tools.map((t) => t.name).sort(),
      [...EXPECTED_ALLOWED_TOOLS].sort(),
    );

    const httpFgList = await harness.app.inject({
      method: 'POST',
      url: listUrl,
      headers: dev.headers,
      payload: { botId: 'bot-main', backgroundProactive: false },
    });
    assert.equal(httpFgList.statusCode, 200);
    assert.equal(httpFgList.json().tools.length, 33);

    const httpBgBlockedTool = await harness.app.inject({
      method: 'POST',
      url: callUrl,
      headers: dev.headers,
      payload: {
        botId: 'bot-main',
        callId: 'http-bg-send',
        name: 'gmail_send',
        args: { ref: 'gmail:draft:d-1', account: 'work@co.com' },
        backgroundProactive: true,
      },
    });
    assert.equal(httpBgBlockedTool.statusCode, 403);
    assert.equal(httpBgBlockedTool.json().error.code, 'FORBIDDEN');

    const httpBgBlockedDraft = await harness.app.inject({
      method: 'POST',
      url: callUrl,
      headers: dev.headers,
      payload: {
        botId: 'bot-main',
        callId: 'http-bg-draft',
        name: 'gmail_draft',
        args: { to: ['x@co.com'], body: 'hi', account: 'work@co.com' },
        backgroundProactive: true,
      },
    });
    assert.equal(httpBgBlockedDraft.statusCode, 200);
    assert.equal(parseErrorPayload(httpBgBlockedDraft.json()).code, 'FORBIDDEN');

    const httpBgAllowedDraft = await harness.app.inject({
      method: 'POST',
      url: callUrl,
      headers: dev.headers,
      payload: {
        botId: 'bot-main',
        callId: 'http-bg-draft-ok',
        name: 'gmail_draft',
        args: { replyTo: 'gmail:msg:m-5', body: 'Draft reply', account: 'work@co.com' },
        backgroundProactive: true,
      },
    });
    assert.equal(httpBgAllowedDraft.statusCode, 200);
    assert.notEqual(httpBgAllowedDraft.json().isError, true);
  } finally {
    await harness.close();
  }
});
