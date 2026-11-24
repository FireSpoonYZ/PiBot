import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES,
  DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES,
  assistantRuntimeBadgeMeta,
  buildGoogleAssistantSetupPayload,
  defaultDigestTimesForMode,
  formatDigestTimesInput,
  parseDigestTimesInput,
  pickDefaultAssistantDeviceId,
  pickDefaultExistingAssistantBot,
  shouldPromptGoogleAssistantSetup,
} from '../src/center-admin/googleHelpers.ts';

const enT = (_zh, en) => en;
const zhT = (zh, _en) => zh;

test('defaultDigestTimesForMode returns scheduled defaults for existing mode and empty for dedicated mode', () => {
  const existing = defaultDigestTimesForMode('existing');
  assert.deepEqual(existing, ['09:00', '18:00']);
  existing.push('22:00');
  assert.deepEqual(defaultDigestTimesForMode('existing'), ['09:00', '18:00']);

  assert.deepEqual(defaultDigestTimesForMode('dedicated'), []);
});

test('parseDigestTimesInput parses comma/space/punctuation-separated HH:mm, dedupes, canonicalizes, and sorts', () => {
  assert.deepEqual(parseDigestTimesInput(''), { valid: true, times: [] });
  assert.deepEqual(parseDigestTimesInput('   '), { valid: true, times: [] });

  assert.deepEqual(parseDigestTimesInput('18:00, 09:00'), {
    valid: true,
    times: ['09:00', '18:00'],
  });

  assert.deepEqual(parseDigestTimesInput('18:30 8:00 12:15 08:00'), {
    valid: true,
    times: ['08:00', '12:15', '18:30'],
  });

  assert.deepEqual(parseDigestTimesInput('9：05，23:59、00:00; 09:05'), {
    valid: true,
    times: ['00:00', '09:05', '23:59'],
  });

  // Up to 6 unique times are allowed (duplicates before count check do not exceed limit).
  assert.deepEqual(
    parseDigestTimesInput('08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 08:00'),
    {
      valid: true,
      times: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00'],
    },
  );
});

test('parseDigestTimesInput rejects invalid times and more than 6 unique slots', () => {
  for (const invalid of ['24:00', '25:10', '12:60', '09:5', 'abc', '-01:00', '09:00:00']) {
    const res = parseDigestTimesInput(invalid, enT);
    assert.equal(res.valid, false, `expected "${invalid}" to fail`);
    assert.deepEqual(res.times, []);
    assert.ok(res.error && res.error.length > 0);
  }

  const tooMany = parseDigestTimesInput('08:00 09:00 10:00 11:00 12:00 13:00 14:00', enT);
  assert.equal(tooMany.valid, false);
  assert.deepEqual(tooMany.times, []);
  assert.match(tooMany.error, /6/);
});

test('formatDigestTimesInput formats arrays cleanly and handles empty or undefined input', () => {
  assert.equal(formatDigestTimesInput(undefined), '');
  assert.equal(formatDigestTimesInput(null), '');
  assert.equal(formatDigestTimesInput([]), '');
  assert.equal(formatDigestTimesInput(['09:00', '18:00']), '09:00, 18:00');
  assert.equal(formatDigestTimesInput([' 08:30 ', '', ' 17:45 ']), '08:30, 17:45');
});

test('buildGoogleAssistantSetupPayload builds valid dedicated mode payload', () => {
  const res = buildGoogleAssistantSetupPayload(
    {
      mode: 'dedicated',
      deviceId: ' dev-1 ',
      role: ' 邮件与日程管家 ',
      modelRef: ' openai/gpt-4o-mini ',
      accounts: [' ada@acme.dev ', 'ADA@acme.dev', 'bob@acme.dev'],
      batchWindowMinutes: DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES,
      digestTimesInput: '',
      calendarEnabled: true,
      calendarLeadMinutes: DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES,
      hindsightPrivateMemory: true,
    },
    enT,
  );
  assert.equal(res.ok, true);
  assert.equal('enabled' in res.payload, false);
  assert.deepEqual(res.payload, {
    mode: 'dedicated',
    deviceId: 'dev-1',
    createBot: {
      role: '邮件与日程管家',
      modelRef: 'openai/gpt-4o-mini',
    },
    accounts: ['ada@acme.dev', 'bob@acme.dev'],
    batchWindowMinutes: 10,
    digestTimes: [],
    calendarEnabled: true,
    calendarLeadMinutes: 15,
    hindsightPrivateMemory: true,
  });

  // Dedicated mode with empty modelRef (use default model) and 0-minute calendar lead time.
  const defaultModelRes = buildGoogleAssistantSetupPayload(
    {
      mode: 'dedicated',
      deviceId: 'dev-1',
      role: 'Mail Bot',
      modelRef: '   ',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: '1',
      calendarEnabled: true,
      calendarLeadMinutes: '0',
      hindsightPrivateMemory: false,
    },
    enT,
  );
  assert.equal(defaultModelRes.ok, true);
  assert.deepEqual(defaultModelRes.payload, {
    mode: 'dedicated',
    deviceId: 'dev-1',
    createBot: { role: 'Mail Bot' },
    accounts: ['ada@acme.dev'],
    batchWindowMinutes: 1,
    digestTimes: [],
    calendarEnabled: true,
    calendarLeadMinutes: 0,
    hindsightPrivateMemory: false,
  });

  // Dedicated mode keeping an existing dedicated botId omits createBot when no createBot fields are provided.
  const keepDedicatedRes = buildGoogleAssistantSetupPayload(
    {
      mode: 'dedicated',
      deviceId: 'dev-1',
      botId: 'bot-mail',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: 15,
      digestTimesInput: '09:00',
      calendarEnabled: false,
      calendarLeadMinutes: '',
      hindsightPrivateMemory: true,
    },
    enT,
  );
  assert.equal(keepDedicatedRes.ok, true);
  assert.deepEqual(keepDedicatedRes.payload, {
    mode: 'dedicated',
    deviceId: 'dev-1',
    botId: 'bot-mail',
    accounts: ['ada@acme.dev'],
    batchWindowMinutes: 15,
    digestTimes: ['09:00'],
    calendarEnabled: false,
    calendarLeadMinutes: 15,
    hindsightPrivateMemory: true,
  });
});

test('buildGoogleAssistantSetupPayload builds valid existing mode payload', () => {
  const res = buildGoogleAssistantSetupPayload(
    {
      mode: 'existing',
      deviceId: 'dev-1',
      botId: 'bot-main',
      accounts: ['ada@acme.dev'],
      batchWindowMinutes: '10',
      digestTimesInput: '18:00, 09:00',
      calendarEnabled: true,
      calendarLeadMinutes: 15,
      hindsightPrivateMemory: false,
    },
    enT,
  );
  assert.equal(res.ok, true);
  assert.equal('enabled' in res.payload, false);
  assert.deepEqual(res.payload, {
    mode: 'existing',
    deviceId: 'dev-1',
    botId: 'bot-main',
    accounts: ['ada@acme.dev'],
    batchWindowMinutes: 10,
    digestTimes: ['09:00', '18:00'],
    calendarEnabled: true,
    calendarLeadMinutes: 15,
    hindsightPrivateMemory: false,
  });
});

test('buildGoogleAssistantSetupPayload rejects invalid inputs across modes and bounds', () => {
  const baseDedicated = {
    mode: 'dedicated',
    deviceId: 'dev-1',
    role: 'Mail Assistant',
    accounts: ['ada@acme.dev'],
    batchWindowMinutes: 10,
    digestTimesInput: '',
    calendarEnabled: true,
    calendarLeadMinutes: 15,
    hindsightPrivateMemory: true,
  };

  // Missing deviceId
  assert.equal(buildGoogleAssistantSetupPayload({ ...baseDedicated, deviceId: '  ' }, enT).ok, false);

  // Missing accounts
  assert.equal(buildGoogleAssistantSetupPayload({ ...baseDedicated, accounts: [] }, enT).ok, false);
  assert.equal(buildGoogleAssistantSetupPayload({ ...baseDedicated, accounts: ['  '] }, enT).ok, false);

  // Missing role in dedicated mode when no botId
  assert.equal(buildGoogleAssistantSetupPayload({ ...baseDedicated, role: '' }, enT).ok, false);

  // Role exceeding max length
  assert.equal(
    buildGoogleAssistantSetupPayload({ ...baseDedicated, role: 'a'.repeat(65) }, enT).ok,
    false,
  );

  // Whitespace in modelRef
  assert.equal(
    buildGoogleAssistantSetupPayload({ ...baseDedicated, modelRef: 'openai/gpt 4o' }, enT).ok,
    false,
  );

  // Missing botId in existing mode
  const missingBot = buildGoogleAssistantSetupPayload(
    {
      ...baseDedicated,
      mode: 'existing',
      botId: '  ',
    },
    enT,
  );
  assert.equal(missingBot.ok, false);

  // Out-of-range or non-integer batchWindowMinutes (must be 1..1440)
  for (const badBatch of [0, -1, 1441, 10.5, 'abc', '']) {
    assert.equal(
      buildGoogleAssistantSetupPayload({ ...baseDedicated, batchWindowMinutes: badBatch }, enT).ok,
      false,
      `expected batchWindowMinutes=${String(badBatch)} to fail`,
    );
  }
  assert.equal(
    buildGoogleAssistantSetupPayload({ ...baseDedicated, batchWindowMinutes: 1440 }, enT).ok,
    true,
  );

  // Out-of-range or non-integer calendarLeadMinutes (must be 0..1440)
  for (const badLead of [-1, 1441, 5.5, 'xyz', '']) {
    assert.equal(
      buildGoogleAssistantSetupPayload({ ...baseDedicated, calendarLeadMinutes: badLead }, enT).ok,
      false,
      `expected calendarLeadMinutes=${String(badLead)} to fail`,
    );
  }
  assert.equal(
    buildGoogleAssistantSetupPayload({ ...baseDedicated, calendarLeadMinutes: 1440 }, enT).ok,
    true,
  );

  // Invalid digestTimes
  assert.equal(
    buildGoogleAssistantSetupPayload({ ...baseDedicated, digestTimesInput: '25:00' }, enT).ok,
    false,
  );
});

test('shouldPromptGoogleAssistantSetup prompts only when unconfigured and at least one account is connected', () => {
  assert.equal(shouldPromptGoogleAssistantSetup(null, 1), true);
  assert.equal(shouldPromptGoogleAssistantSetup(null, 2), true);
  assert.equal(shouldPromptGoogleAssistantSetup(null, 0), false);
  assert.equal(shouldPromptGoogleAssistantSetup(undefined, 1), true);

  const sampleAssistant = {
    enabled: true,
    deviceId: 'dev-1',
    botId: 'bot-1',
    mode: 'dedicated',
    accounts: ['ada@acme.dev'],
    batchWindowMinutes: 10,
    digestTimes: [],
    calendarEnabled: true,
    calendarLeadMinutes: 15,
    hindsightPrivateMemory: true,
    revision: 1,
    listeningSince: null,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
  assert.equal(shouldPromptGoogleAssistantSetup(sampleAssistant, 1), false);
  assert.equal(shouldPromptGoogleAssistantSetup({ ...sampleAssistant, enabled: false }, 2), false);
});

test('device/bot selection and runtime status helpers pick sensible defaults', () => {
  const devices = [
    { deviceId: 'dev-offline', online: false },
    { deviceId: 'dev-online', online: true },
  ];
  assert.equal(pickDefaultAssistantDeviceId(devices), 'dev-online');
  assert.equal(pickDefaultAssistantDeviceId(devices, 'dev-offline'), 'dev-online');
  assert.equal(pickDefaultAssistantDeviceId([{ deviceId: 'dev-offline', online: false }]), 'dev-offline');

  const bots = [
    { deviceId: 'dev-offline', botId: 'bot-arch', isPrimary: true, archivedAt: '2026-01-01T00:00:00Z', online: false },
    { deviceId: 'dev-online', botId: 'bot-sec', isPrimary: false, archivedAt: null, online: true },
    { deviceId: 'dev-online', botId: 'bot-main', isPrimary: true, archivedAt: null, online: true },
  ];
  assert.equal(pickDefaultExistingAssistantBot(bots, devices)?.botId, 'bot-main');
  assert.equal(pickDefaultExistingAssistantBot([], devices), null);

  const makeRuntime = (status, extra = {}) => ({
    status,
    pendingBucketCount: 0,
    pendingDeliveryCount: 0,
    missedCount: 0,
    ...extra,
  });

  assert.equal(assistantRuntimeBadgeMeta({ enabled: false }, null, zhT).tone, 'muted');
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('paused_disabled'), enT).tone, 'muted');
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('running'), enT).tone, 'ok');
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('backing_off'), enT).tone, 'warn');
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('paused_account_reconnect'), enT).tone, 'warn');
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('paused_service_unavailable'), enT).tone, 'warn');
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('paused_bot_unavailable'), enT).tone, 'danger');
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('paused_account_missing'), enT).tone, 'danger');
  assert.equal(
    assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('running', { targetOnline: false }), enT).tone,
    'warn',
  );
  assert.equal(assistantRuntimeBadgeMeta({ enabled: true }, makeRuntime('error'), enT).tone, 'danger');
});
