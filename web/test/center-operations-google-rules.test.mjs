import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { operations as automationOperations } from '../../center-contract/operations/automation.js';
import { googleRuleOperations } from '../../center-contract/operations/google-rules.js';
import { createHandlers as createAutomationHandlers } from '../../center-server/operations/automation.js';
import { createGoogleRuleHandlers } from '../../center-server/operations/google-rules.js';
import { openOperations } from '../../center-server/operations/index.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openGoogleRules } from '../../center-server/google-workspace/rules.js';
import { registerGoogleWorkspaceRoutes } from '../../center-server/google-workspace/routes.js';

const BOT_MAIN = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-main' };
const OAUTH_UNSCOPED_TARGETS = { kind: 'oauth', clientId: 'oauth-client-1', botTargets: [] };
const OAUTH_SCOPED_MAIN = {
  kind: 'oauth',
  clientId: 'oauth-client-scoped',
  botTargets: [{ deviceId: 'dev-1', botId: 'bot-main' }],
};

function createGoogleRulesHarness() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-ops-google-rules-'));
  const store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(7) });

  const setDeviceBots = (deviceId, bots) => {
    store.replaceDeviceBots(deviceId, bots);
  };
  setDeviceBots('dev-1', [
    { deviceId: 'dev-1', botId: 'bot-main', name: 'MainBot', isPrimary: true },
    { deviceId: 'dev-1', botId: 'bot-other', name: 'OtherBot', isPrimary: false },
  ]);
  setDeviceBots('dev-2', [
    { deviceId: 'dev-2', botId: 'bot-remote', name: 'RemoteBot', isPrimary: true },
  ]);

  const registryEntries = new Map([
    ['dev-1', { deviceId: 'dev-1', displayName: 'Device One', platform: 'linux', revokedAt: null }],
    ['dev-2', { deviceId: 'dev-2', displayName: 'Device Two', platform: 'windows', revokedAt: null }],
  ]);

  const bridge = {
    deviceId: 'center-internal-relay',
    registry: {
      get: (id) => registryEntries.get(id) || null,
      list: () => [...registryEntries.values()],
    },
    listDevices: () => [
      { deviceId: 'dev-1', name: 'Device One', online: true },
      { deviceId: 'dev-2', name: 'Device Two', online: false },
    ],
    async call() {
      throw Object.assign(new Error('Bridge RPC should not be called by Google rule operations'), { code: 'FORBIDDEN' });
    },
  };

  let connectedAccounts = [
    {
      id: 'acct-alice',
      email: 'alice@example.com',
      status: 'connected',
      services: [
        { service: 'gmail', state: 'ready' },
        { service: 'calendar', state: 'ready' },
      ],
    },
    {
      id: 'acct-bob',
      email: 'bob@example.com',
      status: 'connected',
      services: [
        { service: 'gmail', state: 'ready' },
        { service: 'calendar', state: 'ready' },
      ],
    },
  ];

  const accountManageCalls = [];
  const accountsStub = {
    async status() {
      return {
        configured: true,
        accounts: connectedAccounts.map((entry) => ({
          ...entry,
          services: entry.services.map((svc) => ({ ...svc })),
        })),
      };
    },
    async api() {
      throw Object.assign(new Error('Upstream Google API should not be called in operation tests'), { code: 'FORBIDDEN' });
    },
    async manage(action, body) {
      accountManageCalls.push({ action, body });
      throw Object.assign(new Error(`Google account management '${action}' must never be invoked`), { code: 'FORBIDDEN' });
    },
    async callback() {
      throw Object.assign(new Error('OAuth callback must never be invoked'), { code: 'FORBIDDEN' });
    },
  };

  let nowMs = Date.parse('2026-11-20T10:00:00.000Z');
  const notifications = [];
  const rulesService = openGoogleRules({
    store,
    google: accountsStub,
    bridge,
    notify: (deviceId) => notifications.push({ deviceId, event: 'webhook-ready' }),
    now: () => nowMs,
  });

  const ownerRoutes = new Map();
  const ownerCalls = [];
  const route = (method, pattern, handler) => {
    ownerRoutes.set(`${method} ${pattern}`, handler);
  };
  const appStub = {
    get() {},
    post() {},
  };

  registerGoogleWorkspaceRoutes(appStub, {
    route,
    publicUrl: 'https://center.example.com/',
    google: { accounts: accountsStub, rules: rulesService },
  });

  const owner = async (method, pattern, { params = {}, body, query = {} } = {}) => {
    ownerCalls.push({ method, pattern, params, body, query });
    const handler = ownerRoutes.get(`${method} ${pattern}`);
    if (!handler) {
      throw Object.assign(new Error(`Unknown owner route: ${method} ${pattern}`), { code: 'NOT_FOUND' });
    }
    let statusCode = 200;
    let sent = false;
    let sentValue;
    const reply = {
      header() {
        return reply;
      },
      code(code) {
        statusCode = code;
        return reply;
      },
      send(payload) {
        sent = true;
        sentValue = payload;
        return payload;
      },
    };
    const returned = await handler({ params, body, query }, reply);
    const value = sent ? sentValue : returned;
    if (statusCode >= 400) {
      const code = value?.error?.code || 'INTERNAL_ERROR';
      throw Object.assign(new Error(value?.error?.message || code), { code });
    }
    return value;
  };

  const handlers = createAutomationHandlers({ owner, store, bridge });

  return {
    store,
    bridge,
    registryEntries,
    rulesService,
    owner,
    ownerCalls,
    accountManageCalls,
    handlers,
    setDeviceBots,
    setConnectedAccounts(next) {
      connectedAccounts = next;
    },
    getNowMs: () => nowMs,
    advanceMs(delta) {
      nowMs += delta;
    },
    async close() {
      await rulesService.close();
      store.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('Google rule contract descriptors and handlers match 1-to-1 and exclude OAuth/account operations', () => {
  const expectedNames = [
    'automation_google_rule_list',
    'automation_google_rule_events_list',
    'automation_google_rule_create',
    'automation_google_rule_set_enabled',
    'automation_google_rule_update',
    'automation_google_rule_remove',
    'automation_google_assistant_get',
    'automation_google_assistant_configure',
    'automation_google_assistant_remove',
  ];

  const actualNames = googleRuleOperations.map((op) => op.name);
  assert.deepEqual(actualNames, expectedNames);

  for (const op of googleRuleOperations) {
    assert.equal(typeof op.description, 'string');
    assert.ok(op.description.length > 0);
    assert.equal(typeof op.readOnly, 'boolean');
    assert.equal(typeof op.destructive, 'boolean');
    if (op.readOnly) {
      assert.equal(op.destructive, false, `${op.name} cannot be both readOnly and destructive`);
    }
    assert.equal(op.inputSchema?.type, 'object');
    assert.equal(op.inputSchema?.additionalProperties, false);
  }

  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_list')?.readOnly, true);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_events_list')?.readOnly, true);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_create')?.readOnly, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_create')?.destructive, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_set_enabled')?.readOnly, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_set_enabled')?.destructive, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_update')?.readOnly, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_update')?.destructive, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_remove')?.readOnly, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_rule_remove')?.destructive, true);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_assistant_get')?.readOnly, true);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_assistant_get')?.destructive, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_assistant_configure')?.readOnly, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_assistant_configure')?.destructive, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_assistant_remove')?.readOnly, false);
  assert.equal(googleRuleOperations.find((op) => op.name === 'automation_google_assistant_remove')?.destructive, true);

  const googleHandlers = createGoogleRuleHandlers({});
  assert.deepEqual(Object.keys(googleHandlers).sort(), [...expectedNames].sort());

  const automationNames = automationOperations.map((op) => op.name);
  for (const name of expectedNames) {
    assert.ok(automationNames.includes(name), `Missing ${name} in automation contract`);
  }
  const automationHandlers = createAutomationHandlers({});
  assert.deepEqual(Object.keys(automationHandlers).sort(), [...automationNames].sort());

  const forbiddenFragments = [
    'google_authorize',
    'google_configure',
    'google_callback',
    'google_account',
    'google_status',
    'oauth',
    'token',
    'credential',
  ];
  for (const fragment of forbiddenFragments) {
    assert.equal(
      automationNames.some((name) => name.includes(fragment)),
      false,
      `Forbidden operation fragment exposed: ${fragment}`,
    );
  }
});

test('openOperations enforces automation read/write scopes and Ajv schemas for Google rule operations', async () => {
  const env = createGoogleRulesHarness();
  try {
    const seeded = await env.rulesService.manage('save', {
      name: 'Inbox Alert',
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'gmail',
      enabled: true,
      from: ['boss@example.com'],
      instruction: 'Summarize urgent mail',
    });
    const ruleId = seeded.rule.id;

    const ops = openOperations({
      store: env.store,
      owner: env.owner,
      bridge: env.bridge,
    });

    const readOnlyActor = {
      kind: 'oauth',
      clientId: 'client-ro',
      scopes: ['pibot:automation:read'],
      botTargets: [],
    };
    const writeOnlyActor = {
      kind: 'oauth',
      clientId: 'client-rw',
      scopes: ['pibot:automation:write'],
      botTargets: [],
    };
    const noScopeActor = {
      kind: 'oauth',
      clientId: 'client-none',
      scopes: [],
      botTargets: [],
    };

    const roNames = ops.list(readOnlyActor).map((op) => op.name);
    assert.ok(roNames.includes('automation_google_rule_list'));
    assert.ok(roNames.includes('automation_google_rule_events_list'));
    assert.equal(roNames.includes('automation_google_rule_create'), false);
    assert.equal(roNames.includes('automation_google_rule_set_enabled'), false);
    assert.equal(roNames.includes('automation_google_rule_update'), false);
    assert.equal(roNames.includes('automation_google_rule_remove'), false);

    // Read succeeds with read scope; writes (including create) are rejected with FORBIDDEN.
    const listed = await ops.call(readOnlyActor, 'automation_google_rule_list', {});
    assert.equal(listed.items.length, 1);
    await assert.rejects(
      () => ops.call(readOnlyActor, 'automation_google_rule_create', {
        deviceId: 'dev-1',
        botId: 'bot-main',
        account: 'alice@example.com',
        source: 'gmail',
        instruction: 'Read-only caller cannot create',
      }),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ops.call(readOnlyActor, 'automation_google_rule_set_enabled', { id: ruleId, enabled: false }),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => ops.call(readOnlyActor, 'automation_google_rule_remove', { id: ruleId }),
      (err) => err?.code === 'FORBIDDEN',
    );

    // No-scope OAuth caller cannot access even read operations.
    await assert.rejects(
      () => ops.call(noScopeActor, 'automation_google_rule_list', {}),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Write scope allows create and pause/resume, rejects reads without read scope.
    await assert.rejects(
      () => ops.call(writeOnlyActor, 'automation_google_rule_list', {}),
      (err) => err?.code === 'FORBIDDEN',
    );
    const createdByOAuth = await ops.call(writeOnlyActor, 'automation_google_rule_create', {
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'calendar',
      minutesBefore: 5,
      instruction: 'Join meeting in 5m',
    });
    assert.equal(createdByOAuth.rule.source, 'calendar');
    assert.equal(createdByOAuth.rule.minutesBefore, 5);

    const paused = await ops.call(writeOnlyActor, 'automation_google_rule_set_enabled', { id: ruleId, enabled: false });
    assert.equal(paused.rule.enabled, false);

    // Bot actor can invoke both read and write operations, including create & rebind.
    const createdByBot = await ops.call(BOT_MAIN, 'automation_google_rule_create', {
      account: 'alice@example.com',
      source: 'gmail',
      from: ['alerts@example.com'],
      instruction: 'Triage alert email',
    });
    assert.equal(createdByBot.rule.deviceId, 'dev-1');
    assert.equal(createdByBot.rule.botId, 'bot-main');
    const resumed = await ops.call(BOT_MAIN, 'automation_google_rule_set_enabled', { id: ruleId, enabled: true });
    assert.equal(resumed.rule.enabled, true);
    const rebound = await ops.call(BOT_MAIN, 'automation_google_rule_update', { id: ruleId, account: 'bob@example.com' });
    assert.equal(rebound.rule.account, 'bob@example.com');

    // Ajv schema rejects path traversal IDs, out-of-range limits, and extra fields.
    await assert.rejects(
      () => ops.call(BOT_MAIN, 'automation_google_rule_events_list', { id: '../etc/passwd' }),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => ops.call(BOT_MAIN, 'automation_google_rule_events_list', { id: ruleId, limit: 201 }),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => ops.call(BOT_MAIN, 'automation_google_rule_update', { id: ruleId, unknownField: 'bad' }),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
  } finally {
    await env.close();
  }
});

test('Google rule read, sanitized events (no unauthorized email/calendar body), toggle, and remove via owner callbacks', async () => {
  const env = createGoogleRulesHarness();
  try {
    const gmailSeed = await env.rulesService.manage('save', {
      name: 'Urgent Boss Mail',
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'gmail',
      enabled: true,
      from: ['boss@example.com'],
      subjectContains: 'Urgent',
      label: 'INBOX',
      instruction: 'Notify user about urgent boss email',
    });
    const calSeed = await env.rulesService.manage('save', {
      name: 'Team Standup Reminder',
      deviceId: 'dev-2',
      botId: 'bot-remote',
      account: 'bob@example.com',
      source: 'calendar',
      enabled: true,
      calendar: 'team@group.calendar.google.com',
      minutesBefore: 15,
      instruction: 'Prepare standup notes',
    });

    // Enqueue a real Gmail event whose durable SQLite payload contains sensitive email content.
    env.store.enqueueGoogleRuleEvent({
      ruleId: gmailSeed.rule.id,
      ruleName: gmailSeed.rule.name,
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'gmail',
      eventKey: 'gmail-msg-001',
      instruction: gmailSeed.rule.instruction,
      payloadJson: JSON.stringify({
        kind: 'google_rule_event',
        subject: 'TOP_SECRET_SUBJECT_DO_NOT_LEAK',
        text: 'CONFIDENTIAL_EMAIL_BODY_XYZ',
        body: 'RAW_EMAIL_BODY_123',
        google: { snippet: 'SNIPPET_PRIVATE', token: 'Bearer ya29.super_secret_token_999' },
      }),
      occurredAt: new Date(env.getNowMs()).toISOString(),
      expiresAt: new Date(env.getNowMs() + 3600_000).toISOString(),
      nowMs: env.getNowMs(),
    });

    // 1. List rules with and without filters.
    const allRules = await env.handlers.automation_google_rule_list({}, OAUTH_UNSCOPED_TARGETS);
    assert.equal(allRules.items.length, 2);

    const filteredAlice = await env.handlers.automation_google_rule_list(
      { account: 'ALICE@EXAMPLE.COM', deviceId: 'dev-1', botId: 'bot-main', enabled: true },
      BOT_MAIN,
    );
    assert.equal(filteredAlice.items.length, 1);
    assert.equal(filteredAlice.items[0].id, gmailSeed.rule.id);
    assert.equal(filteredAlice.items[0].runtime.pendingCount, 1);
    assert.equal(filteredAlice.items[0].runtime.targetOnline, true);

    // 2. List recent events: receipt metadata only, NEVER unauthorized email body or secrets.
    const events = await env.handlers.automation_google_rule_events_list(
      { id: gmailSeed.rule.id, limit: 10 },
      OAUTH_UNSCOPED_TARGETS,
    );
    assert.equal(events.items.length, 1);
    const ev = events.items[0];
    assert.equal(ev.ruleId, gmailSeed.rule.id);
    assert.equal(ev.eventKey, 'gmail-msg-001');
    assert.equal(ev.status, 'pending');
    for (const forbiddenKey of ['payload', 'payloadJson', 'text', 'body', 'snippet', 'subject', 'google', 'instruction']) {
      assert.equal(forbiddenKey in ev, false, `Event must not expose ${forbiddenKey}`);
    }
    const serializedEvents = JSON.stringify(events);
    assert.equal(serializedEvents.includes('TOP_SECRET_SUBJECT_DO_NOT_LEAK'), false);
    assert.equal(serializedEvents.includes('CONFIDENTIAL_EMAIL_BODY_XYZ'), false);
    assert.equal(serializedEvents.includes('RAW_EMAIL_BODY_123'), false);
    assert.equal(serializedEvents.includes('SNIPPET_PRIVATE'), false);
    assert.equal(serializedEvents.includes('ya29.super_secret_token_999'), false);

    // 3. Conservative toggle: pause cancels pending events and preserves all rule config.
    const paused = await env.handlers.automation_google_rule_set_enabled(
      { id: gmailSeed.rule.id, enabled: false },
      OAUTH_UNSCOPED_TARGETS,
    );
    assert.equal(paused.rule.enabled, false);
    assert.equal(paused.rule.account, 'alice@example.com');
    assert.equal(paused.rule.deviceId, 'dev-1');
    assert.equal(paused.rule.botId, 'bot-main');
    assert.deepEqual(paused.rule.from, ['boss@example.com']);
    assert.equal(paused.rule.subjectContains, 'Urgent');
    assert.equal(paused.rule.label, 'INBOX');
    assert.equal(paused.rule.instruction, 'Notify user about urgent boss email');

    const afterPauseEvents = await env.handlers.automation_google_rule_events_list(
      { id: gmailSeed.rule.id },
      OAUTH_UNSCOPED_TARGETS,
    );
    assert.equal(afterPauseEvents.items[0].status, 'cancelled');

    // Resume re-enables cleanly while preserving original explicit binding.
    const resumed = await env.handlers.automation_google_rule_set_enabled(
      { id: gmailSeed.rule.id, enabled: true },
      BOT_MAIN,
    );
    assert.equal(resumed.rule.enabled, true);
    assert.equal(resumed.rule.account, 'alice@example.com');

    // 4. Remove rule cleanly.
    const removed = await env.handlers.automation_google_rule_remove(
      { id: calSeed.rule.id },
      OAUTH_UNSCOPED_TARGETS,
    );
    assert.equal(removed.removed, true);
    assert.equal(removed.id, calSeed.rule.id);
    assert.equal(removed.rule.enabled, false);

    const remaining = await env.handlers.automation_google_rule_list({}, OAUTH_UNSCOPED_TARGETS);
    assert.equal(remaining.items.length, 1);
    assert.equal(remaining.items[0].id, gmailSeed.rule.id);

    // Removing an already-removed rule fails with NOT_FOUND.
    await assert.rejects(
      () => env.handlers.automation_google_rule_remove({ id: calSeed.rule.id }, OAUTH_UNSCOPED_TARGETS),
      (err) => err?.code === 'NOT_FOUND',
    );

    // Verify ONLY the 4 allowed Google rule owner routes were ever invoked; account management never touched.
    const allowedPatterns = new Set([
      'GET /api/google/rules',
      'POST /api/google/rules/save',
      'POST /api/google/rules/remove',
      'GET /api/google/rules/:id/events',
    ]);
    assert.ok(env.ownerCalls.length > 0);
    for (const call of env.ownerCalls) {
      assert.ok(
        allowedPatterns.has(`${call.method} ${call.pattern}`),
        `Unexpected owner route invoked: ${call.method} ${call.pattern}`,
      );
    }
    assert.equal(env.accountManageCalls.length, 0);
  } finally {
    await env.close();
  }
});

test('automation_google_rule_create creates Gmail/Calendar rules with target defaults and validates inputs', async () => {
  const env = createGoogleRulesHarness();
  try {
    // Bot caller defaults deviceId/botId to itself.
    const createdGmail = await env.handlers.automation_google_rule_create({
      account: 'ALICE@example.com',
      source: 'gmail',
      event: 'new_email',
      name: 'Boss Inbox',
      from: ['Boss@Example.com', 'boss@example.com'],
      subjectContains: 'Action',
      label: 'INBOX',
      instruction: 'Summarize boss mail',
    }, BOT_MAIN);
    assert.equal(createdGmail.rule.deviceId, 'dev-1');
    assert.equal(createdGmail.rule.botId, 'bot-main');
    assert.equal(createdGmail.rule.account, 'alice@example.com');
    assert.equal(createdGmail.rule.source, 'gmail');
    assert.equal(createdGmail.rule.event, 'new_email');
    assert.equal(createdGmail.rule.enabled, true);
    assert.deepEqual(createdGmail.rule.from, ['boss@example.com']);
    assert.equal(createdGmail.rule.subjectContains, 'Action');

    // Cross-device Bot call requires explicit botId.
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        deviceId: 'dev-2',
        account: 'bob@example.com',
        source: 'gmail',
        instruction: 'Missing botId',
      }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Cross-device Bot call with explicit botId succeeds for Calendar (minutesBefore: 0).
    const createdCal = await env.handlers.automation_google_rule_create({
      deviceId: 'dev-2',
      botId: 'bot-remote',
      account: 'bob@example.com',
      source: 'calendar',
      event: 'starting_soon',
      minutesBefore: 0,
      enabled: false,
      instruction: 'Ping right at start',
    }, BOT_MAIN);
    assert.equal(createdCal.rule.deviceId, 'dev-2');
    assert.equal(createdCal.rule.botId, 'bot-remote');
    assert.equal(createdCal.rule.account, 'bob@example.com');
    assert.equal(createdCal.rule.source, 'calendar');
    assert.equal(createdCal.rule.calendar, 'primary');
    assert.equal(createdCal.rule.minutesBefore, 0);
    assert.equal(createdCal.rule.enabled, false);

    // Multiple connected accounts require explicit account on create.
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        source: 'gmail',
        instruction: 'Ambiguous account',
      }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Single connected account allows omitting account on create.
    env.setConnectedAccounts([
      {
        id: 'acct-alice',
        email: 'alice@example.com',
        status: 'connected',
        services: [
          { service: 'gmail', state: 'ready' },
          { service: 'calendar', state: 'ready' },
        ],
      },
    ]);
    const autoAccountRule = await env.handlers.automation_google_rule_create({
      source: 'calendar',
      instruction: 'Auto-resolved account reminder',
    }, BOT_MAIN);
    assert.equal(autoAccountRule.rule.account, 'alice@example.com');
    assert.equal(autoAccountRule.rule.minutesBefore, 10);

    // OAuth caller must specify deviceId & botId explicitly.
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        deviceId: 'dev-1',
        source: 'gmail',
        instruction: 'Missing botId for OAuth',
      }, OAUTH_UNSCOPED_TARGETS),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Mismatched event or cross-source filters rejected.
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        source: 'gmail',
        event: 'starting_soon',
        instruction: 'Bad event',
      }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        source: 'gmail',
        minutesBefore: 5,
        instruction: 'Bad filter',
      }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        source: 'calendar',
        from: ['a@b.com'],
        instruction: 'Bad filter',
      }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Disconnected account or unknown Bot rejected.
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        account: 'missing@example.com',
        source: 'gmail',
        instruction: 'Unknown account',
      }, BOT_MAIN),
      (err) => err?.code === 'NOT_FOUND',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        deviceId: 'dev-1',
        botId: 'bot-missing',
        source: 'gmail',
        instruction: 'Unknown bot',
      }, BOT_MAIN),
      (err) => err?.code === 'BOT_NOT_FOUND',
    );

    // Scoped OAuth caller cannot create rule targeting an unauthorized Bot.
    await assert.rejects(
      () => env.handlers.automation_google_rule_create({
        deviceId: 'dev-2',
        botId: 'bot-remote',
        source: 'gmail',
        instruction: 'Unauthorized target',
      }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'FORBIDDEN',
    );

    assert.equal(env.accountManageCalls.length, 0);
  } finally {
    await env.close();
  }
});

test('automation_google_rule_update edits fields, supports rebinding target/account/source, and validates constraints', async () => {
  const env = createGoogleRulesHarness();
  try {
    const gmailSeed = await env.rulesService.manage('save', {
      name: 'Mail Rule',
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'gmail',
      enabled: true,
      from: ['boss@example.com'],
      subjectContains: 'Invoice',
      label: 'FINANCE',
      instruction: 'Check invoice',
    });
    const calSeed = await env.rulesService.manage('save', {
      name: 'Cal Rule',
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'calendar',
      enabled: true,
      calendar: 'work-cal',
      minutesBefore: 10,
      instruction: 'Join meeting',
    });

    // Empty update rejected fail-fast.
    await assert.rejects(
      () => env.handlers.automation_google_rule_update({ id: gmailSeed.rule.id }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Non-existent rule ID rejected with NOT_FOUND (never creates a new rule).
    await assert.rejects(
      () => env.handlers.automation_google_rule_update({
        id: '11111111-1111-4111-8111-111111111111',
        instruction: 'Should not create',
      }, BOT_MAIN),
      (err) => err?.code === 'NOT_FOUND',
    );

    // Cross-source fields rejected.
    await assert.rejects(
      () => env.handlers.automation_google_rule_update({ id: gmailSeed.rule.id, minutesBefore: 20 }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_update({ id: calSeed.rule.id, from: ['a@b.com'] }, BOT_MAIN),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Gmail partial edit updates normalized filters and preserves untouched fields.
    const updatedGmail = await env.handlers.automation_google_rule_update({
      id: gmailSeed.rule.id,
      name: 'Finance Mail Updated',
      from: ['CFO@Example.com', 'boss@example.com', 'cfo@example.com'],
      to: ['team@example.com'],
      instruction: 'Check invoice and draft summary',
    }, BOT_MAIN);
    assert.equal(updatedGmail.rule.name, 'Finance Mail Updated');
    assert.deepEqual(updatedGmail.rule.from, ['boss@example.com', 'cfo@example.com']);
    assert.deepEqual(updatedGmail.rule.to, ['team@example.com']);
    assert.equal(updatedGmail.rule.subjectContains, 'Invoice');
    assert.equal(updatedGmail.rule.label, 'FINANCE');
    assert.equal(updatedGmail.rule.account, 'alice@example.com');
    assert.equal(updatedGmail.rule.deviceId, 'dev-1');
    assert.equal(updatedGmail.rule.botId, 'bot-main');

    // Clearing optional Gmail filters via null / [] works cleanly.
    const clearedGmail = await env.handlers.automation_google_rule_update({
      id: gmailSeed.rule.id,
      from: null,
      to: [],
      subjectContains: null,
      label: null,
    }, BOT_MAIN);
    assert.equal('from' in clearedGmail.rule, false);
    assert.equal('to' in clearedGmail.rule, false);
    assert.equal('subjectContains' in clearedGmail.rule, false);
    assert.equal('label' in clearedGmail.rule, false);

    // Rebinding target deviceId/botId, account, and switching source gmail -> calendar works cleanly.
    const reboundToCal = await env.handlers.automation_google_rule_update({
      id: gmailSeed.rule.id,
      deviceId: 'dev-2',
      botId: 'bot-remote',
      account: 'bob@example.com',
      source: 'calendar',
      event: 'starting_soon',
      minutesBefore: 25,
      instruction: 'Handle bob calendar on remote bot',
    }, BOT_MAIN);
    assert.equal(reboundToCal.rule.deviceId, 'dev-2');
    assert.equal(reboundToCal.rule.botId, 'bot-remote');
    assert.equal(reboundToCal.rule.account, 'bob@example.com');
    assert.equal(reboundToCal.rule.source, 'calendar');
    assert.equal(reboundToCal.rule.event, 'starting_soon');
    assert.equal(reboundToCal.rule.calendar, 'primary');
    assert.equal(reboundToCal.rule.minutesBefore, 25);
    assert.equal('from' in reboundToCal.rule, false);

    // Calendar edit updates minutesBefore and resets calendar to primary when null is passed.
    const updatedCal = await env.handlers.automation_google_rule_update({
      id: calSeed.rule.id,
      minutesBefore: 30,
      calendar: null,
      instruction: 'Prepare slides 30m early',
    }, BOT_MAIN);
    assert.equal(updatedCal.rule.calendar, 'primary');
    assert.equal(updatedCal.rule.minutesBefore, 30);
    assert.equal(updatedCal.rule.instruction, 'Prepare slides 30m early');
    assert.equal(updatedCal.rule.account, 'alice@example.com');

    // Calendar edit supports minutesBefore: 0 and preserves 0 across pause/resume and list.
    const zeroCal = await env.handlers.automation_google_rule_update({
      id: calSeed.rule.id,
      minutesBefore: 0,
      instruction: 'Join meeting right at start',
    }, BOT_MAIN);
    assert.equal(zeroCal.rule.minutesBefore, 0);
    const pausedZeroCal = await env.handlers.automation_google_rule_set_enabled({
      id: calSeed.rule.id,
      enabled: false,
    }, BOT_MAIN);
    assert.equal(pausedZeroCal.rule.minutesBefore, 0);
    const listedAfterZero = await env.handlers.automation_google_rule_list({}, BOT_MAIN);
    assert.equal(listedAfterZero.items.find((item) => item.id === calSeed.rule.id)?.minutesBefore, 0);
  } finally {
    await env.close();
  }
});

test('security boundaries reject OAuth/token fields, unavailable targets/accounts, and out-of-scope botTargets', async () => {
  const env = createGoogleRulesHarness();
  try {
    const mainRule = await env.rulesService.manage('save', {
      name: 'Main Rule',
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'gmail',
      enabled: false,
      instruction: 'Handle main mail',
    });
    const remoteRule = await env.rulesService.manage('save', {
      name: 'Remote Rule',
      deviceId: 'dev-2',
      botId: 'bot-remote',
      account: 'bob@example.com',
      source: 'calendar',
      enabled: true,
      minutesBefore: 5,
      instruction: 'Handle remote calendar',
    });

    // 1. Missing or invalid actors rejected.
    await assert.rejects(
      () => env.handlers.automation_google_rule_list({}, null),
      (err) => err?.code === 'UNAUTHENTICATED',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_list({}, { kind: 'owner' }),
      (err) => err?.code === 'FORBIDDEN',
    );

    // 2. OAuth / token / credential / scope / permission fields strictly forbidden across operations.
    const forbiddenAuthInputs = [
      { token: 'ya29.evil' },
      { accessToken: 'ya29.evil' },
      { refreshToken: '1//evil' },
      { clientSecret: 'GOCSPX-evil' },
      { oauth: { code: '123' } },
      { scopes: ['https://mail.google.com/'] },
      { permissions: ['gmail.modify'] },
      { redirectUri: 'https://evil.example/cb' },
    ];
    for (const bad of forbiddenAuthInputs) {
      await assert.rejects(
        () => env.handlers.automation_google_rule_list(bad, OAUTH_UNSCOPED_TARGETS),
        (err) => err?.code === 'FORBIDDEN',
      );
      await assert.rejects(
        () => env.handlers.automation_google_rule_create({
          deviceId: 'dev-1',
          botId: 'bot-main',
          account: 'alice@example.com',
          source: 'gmail',
          instruction: 'Should reject auth fields',
          ...bad,
        }, OAUTH_UNSCOPED_TARGETS),
        (err) => err?.code === 'FORBIDDEN',
      );
      await assert.rejects(
        () => env.handlers.automation_google_rule_update({ id: mainRule.rule.id, ...bad }, OAUTH_UNSCOPED_TARGETS),
        (err) => err?.code === 'FORBIDDEN',
      );
      await assert.rejects(
        () => env.handlers.automation_google_rule_set_enabled({ id: mainRule.rule.id, enabled: true, ...bad }, OAUTH_UNSCOPED_TARGETS),
        (err) => err?.code === 'FORBIDDEN',
      );
      await assert.rejects(
        () => env.handlers.automation_google_rule_remove({ id: mainRule.rule.id, ...bad }, OAUTH_UNSCOPED_TARGETS),
        (err) => err?.code === 'FORBIDDEN',
      );
    }

    // 3. set_enabled rejects unexpected fields outside {id, enabled}.
    for (const extra of [{ deviceId: 'dev-2' }, { botId: 'bot-other' }, { account: 'bob@example.com' }, { source: 'calendar' }]) {
      await assert.rejects(
        () => env.handlers.automation_google_rule_set_enabled({
          id: mainRule.rule.id,
          enabled: true,
          ...extra,
        }, OAUTH_UNSCOPED_TARGETS),
        (err) => err?.code === 'INVALID_ARGUMENT',
      );
    }

    // 4. Scoped OAuth botTargets isolates list and blocks cross-Bot events/toggle/update/rebind/remove.
    const scopedList = await env.handlers.automation_google_rule_list({}, OAUTH_SCOPED_MAIN);
    assert.deepEqual(scopedList.items.map((r) => r.id), [mainRule.rule.id]);

    await assert.rejects(
      () => env.handlers.automation_google_rule_events_list({ id: remoteRule.rule.id }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_set_enabled({ id: remoteRule.rule.id, enabled: false }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_update({ id: remoteRule.rule.id, name: 'Hijack' }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_update({
        id: mainRule.rule.id,
        deviceId: 'dev-2',
        botId: 'bot-remote',
      }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () => env.handlers.automation_google_rule_remove({ id: remoteRule.rule.id }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'FORBIDDEN',
    );

    // 5. Original explicit account/target admission is enforced when re-enabling a paused rule:
    // 5a. Archived target Bot -> BOT_ARCHIVED.
    env.setDeviceBots('dev-1', [
      { deviceId: 'dev-1', botId: 'bot-main', name: 'MainBot', isPrimary: true, archivedAt: '2026-11-20T09:00:00.000Z' },
      { deviceId: 'dev-1', botId: 'bot-other', name: 'OtherBot', isPrimary: false },
    ]);
    await assert.rejects(
      () => env.handlers.automation_google_rule_set_enabled({ id: mainRule.rule.id, enabled: true }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'BOT_ARCHIVED',
    );
    // Restore active Bot.
    env.setDeviceBots('dev-1', [
      { deviceId: 'dev-1', botId: 'bot-main', name: 'MainBot', isPrimary: true },
      { deviceId: 'dev-1', botId: 'bot-other', name: 'OtherBot', isPrimary: false },
    ]);

    // 5b. Revoked target device -> NOT_FOUND.
    env.registryEntries.set('dev-1', {
      deviceId: 'dev-1',
      displayName: 'Device One',
      platform: 'linux',
      revokedAt: '2026-11-20T09:30:00.000Z',
    });
    await assert.rejects(
      () => env.handlers.automation_google_rule_set_enabled({ id: mainRule.rule.id, enabled: true }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'NOT_FOUND',
    );
    env.registryEntries.set('dev-1', {
      deviceId: 'dev-1',
      displayName: 'Device One',
      platform: 'linux',
      revokedAt: null,
    });

    // 5c. Original Google account removed (even when another single account bob@example.com remains connected)
    // must fail NOT_FOUND and NEVER implicitly switch to bob@example.com.
    env.setConnectedAccounts([
      {
        id: 'acct-bob',
        email: 'bob@example.com',
        status: 'connected',
        services: [
          { service: 'gmail', state: 'ready' },
          { service: 'calendar', state: 'ready' },
        ],
      },
    ]);
    await assert.rejects(
      () => env.handlers.automation_google_rule_set_enabled({ id: mainRule.rule.id, enabled: true }, OAUTH_SCOPED_MAIN),
      (err) => err?.code === 'NOT_FOUND',
    );
  } finally {
    await env.close();
  }
});

test('direct googleRules service fallback and defense-in-depth sanitization strip bodies and redact leaked secrets', async () => {
  const env = createGoogleRulesHarness();
  try {
    const seeded = await env.rulesService.manage('save', {
      name: 'Direct Rule',
      deviceId: 'dev-1',
      botId: 'bot-main',
      account: 'alice@example.com',
      source: 'gmail',
      enabled: true,
      instruction: 'Check mail',
    });

    // Direct service fallback works when deps.owner is not supplied.
    const directHandlers = createGoogleRuleHandlers({ googleRules: env.rulesService, store: env.store });
    const listed = await directHandlers.automation_google_rule_list({}, BOT_MAIN);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, seeded.rule.id);

    const toggled = await directHandlers.automation_google_rule_set_enabled(
      { id: seeded.rule.id, enabled: false },
      BOT_MAIN,
    );
    assert.equal(toggled.rule.enabled, false);

    // Defense-in-depth sanitizer strips unauthorized body/token fields even if an upstream adapter returns them.
    const leakyService = {
      async manage(action) {
        if (action === 'list') {
          return {
            items: [{
              id: 'rule-leaky',
              name: 'Leaky',
              deviceId: 'dev-1',
              botId: 'bot-main',
              account: 'alice@example.com',
              source: 'gmail',
              event: 'new_email',
              enabled: true,
              instruction: 'Check',
              createdAt: '2026-11-20T00:00:00.000Z',
              updatedAt: '2026-11-20T00:00:00.000Z',
              listeningSince: null,
              accessToken: 'ya29.leaky_rule_token_12345',
              payload: { body: 'SHOULD_NEVER_APPEAR' },
              runtime: {
                status: 'backing_off',
                reason: 'CHECK_ERROR',
                detail: 'Upstream failed with Bearer ya29.leaked_bearer_token_999 and client_secret=GOCSPX-secret999',
                enableUrl: 'javascript:alert(1)',
                lastCheckedAt: null,
                lastEventAt: null,
                backoffUntil: null,
                rateLimited: false,
                targetOnline: true,
                pendingCount: 0,
                missedCount: 0,
                lastDelivery: {
                  eventId: 'ev-1',
                  eventKey: 'k-1',
                  status: 'failed',
                  occurredAt: '2026-11-20T00:00:00.000Z',
                  receivedAt: '2026-11-20T00:00:00.000Z',
                  updatedAt: '2026-11-20T00:00:00.000Z',
                  error: { code: 'ERR', message: 'refresh_token=1//leaked_refresh_12345' },
                },
              },
            }],
          };
        }
        if (action === 'events') {
          return {
            items: [{
              id: 'ev-1',
              ruleId: 'rule-leaky',
              ruleName: 'Leaky',
              deviceId: 'dev-1',
              botId: 'bot-main',
              account: 'alice@example.com',
              source: 'gmail',
              requestId: 'req-1',
              eventKey: 'k-1',
              status: 'failed',
              cancelRequested: false,
              admission: { queueDepth: 2, payload: 'SECRET_BODY', token: 'ya29.bad_token_123456' },
              occurredAt: '2026-11-20T00:00:00.000Z',
              receivedAt: '2026-11-20T00:00:00.000Z',
              expiresAt: '2026-11-21T00:00:00.000Z',
              updatedAt: '2026-11-20T00:00:00.000Z',
              error: { code: 'ERR', message: 'Failed with GOCSPX-secret999' },
              payload: { text: 'SECRET_MAIL_BODY', subject: 'PRIVATE_SUBJECT' },
              body: 'RAW_HTML_BODY',
              instruction: 'LEAKED_INSTRUCTION',
            }],
          };
        }
        throw new Error(`Unexpected action: ${action}`);
      },
    };

    const sanitizedHandlers = createGoogleRuleHandlers({ google: { rules: leakyService } });
    const safeRules = await sanitizedHandlers.automation_google_rule_list({}, BOT_MAIN);
    assert.equal(safeRules.items.length, 1);
    assert.equal('accessToken' in safeRules.items[0], false);
    assert.equal('payload' in safeRules.items[0], false);
    assert.equal(safeRules.items[0].runtime.enableUrl, null);
    const rulesJson = JSON.stringify(safeRules);
    assert.equal(rulesJson.includes('ya29.leaky_rule_token_12345'), false);
    assert.equal(rulesJson.includes('ya29.leaked_bearer_token_999'), false);
    assert.equal(rulesJson.includes('GOCSPX-secret999'), false);
    assert.equal(rulesJson.includes('1//leaked_refresh_12345'), false);
    assert.equal(rulesJson.includes('SHOULD_NEVER_APPEAR'), false);

    const safeEvents = await sanitizedHandlers.automation_google_rule_events_list({ id: 'rule-leaky' }, BOT_MAIN);
    assert.equal(safeEvents.items.length, 1);
    assert.deepEqual(safeEvents.items[0].admission, { queueDepth: 2 });
    const eventsJson = JSON.stringify(safeEvents);
    assert.equal(eventsJson.includes('SECRET_BODY'), false);
    assert.equal(eventsJson.includes('SECRET_MAIL_BODY'), false);
    assert.equal(eventsJson.includes('PRIVATE_SUBJECT'), false);
    assert.equal(eventsJson.includes('RAW_HTML_BODY'), false);
    assert.equal(eventsJson.includes('LEAKED_INSTRUCTION'), false);
    assert.equal(eventsJson.includes('GOCSPX-secret999'), false);
    assert.equal(eventsJson.includes('ya29.bad_token_123456'), false);
  } finally {
    await env.close();
  }
});
