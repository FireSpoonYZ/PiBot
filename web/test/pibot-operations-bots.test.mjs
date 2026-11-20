import test from 'node:test';
import assert from 'node:assert/strict';
import {
  operations,
  BOT_AVATAR_SHAPES,
  BOT_THINKING_LEVELS,
  BOT_SESSION_ACTIONS,
} from '../../center-contract/operations/bots.js';
import { createHandlers } from '../../center-server/operations/bots.js';

const VALID_SHA256 = 'a'.repeat(64);
const UPDATED_SHA256 = 'b'.repeat(64);

const ALLOWED_OWNER_ROUTES = new Set([
  'GET /api/bot-sync',
  'GET /api/devices',
  'GET /api/devices/:deviceId/bots',
  'POST /api/devices/:deviceId/bots',
  'PATCH /api/devices/:deviceId/bots/:botId',
  'POST /api/devices/:deviceId/bots/:botId/primary',
  'POST /api/devices/:deviceId/bots/:botId/archive',
  'POST /api/devices/:deviceId/bots/:botId/unarchive',
  'DELETE /api/devices/:deviceId/bots/:botId',
  'GET /api/devices/:deviceId/bots/:botId/avatar',
  'PUT /api/devices/:deviceId/bots/:botId/avatar',
  'GET /api/devices/:deviceId/bots/:botId/cwd',
  'PUT /api/devices/:deviceId/bots/:botId/cwd',
  'GET /api/devices/:deviceId/bots/:botId/model-config',
  'PUT /api/devices/:deviceId/bots/:botId/model-config',
]);

const ALLOWED_BRIDGE_METHODS = new Set([
  'getBot',
  'getBotSoul',
  'setBotSoul',
  'abort',
  'clearHistory',
  'compact',
]);

function makeAvatar(overrides = {}) {
  return {
    id: 'jarvis-blue',
    shape: 'blob',
    color: '#2B70F6',
    rotation: 0,
    expressionIndex: 0,
    labelZh: '经典蓝',
    labelEn: 'Classic Blue',
    ...overrides,
  };
}

function createHarness({ offlineDevices = new Set() } = {}) {
  const ownerCalls = [];
  const bridgeCalls = [];

  const devices = [
    {
      deviceId: 'center-internal-1',
      name: 'Center Internal',
      platform: 'linux',
      online: true,
      oauthAdminEnabled: true,
      deviceToken: 'secret-should-never-leak',
    },
    {
      deviceId: 'dev-1',
      name: 'Workstation',
      platform: 'linux',
      online: !offlineDevices.has('dev-1'),
      oauthAdminEnabled: true,
      deviceToken: 'secret-device-token',
    },
    {
      deviceId: 'dev-2',
      name: 'Laptop',
      platform: 'macos',
      online: !offlineDevices.has('dev-2'),
      oauthAdminEnabled: false,
    },
  ];

  const botsByKey = new Map([
    [
      'dev-1:bot-1',
      {
        deviceId: 'dev-1',
        botId: 'bot-1',
        name: 'Alpha',
        description: 'Primary assistant',
        isPrimary: true,
        archivedAt: null,
        cwd: '/workspace/alpha',
        cwdRevision: 2,
        modelRef: 'openai/gpt-5',
        resolvedModel: {
          effectiveModelRef: 'openai/gpt-5',
          effectiveModelName: 'GPT-5',
          effectiveProviderName: 'OpenAI',
          source: 'bot',
          available: true,
          internalSecret: 'leak-me-not',
        },
        avatar: { ...makeAvatar(), injectedControl: 'must-strip' },
        avatarRevision: 1,
        primaryConversationId: 'conv-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-02T00:00:00.000Z',
        lastPreview: 'hello',
        deviceName: 'Workstation',
        platform: 'linux',
        online: !offlineDevices.has('dev-1'),
        rawToken: 'should-be-stripped',
      },
    ],
    [
      'dev-1:bot-2',
      {
        deviceId: 'dev-1',
        botId: 'bot-2',
        name: 'Beta',
        description: 'Archived helper',
        isPrimary: false,
        archivedAt: '2026-01-03T00:00:00.000Z',
        cwd: '/workspace/beta',
        cwdRevision: 1,
        modelRef: null,
        resolvedModel: null,
        avatar: null,
        avatarRevision: 0,
        primaryConversationId: 'conv-2',
        createdAt: '2026-01-01T01:00:00.000Z',
        lastActivityAt: null,
        lastPreview: null,
        deviceName: 'Workstation',
        platform: 'linux',
        online: !offlineDevices.has('dev-1'),
      },
    ],
    [
      'dev-2:bot-3',
      {
        deviceId: 'dev-2',
        botId: 'bot-3',
        name: 'Gamma',
        description: 'Remote worker',
        isPrimary: true,
        archivedAt: null,
        cwd: '/Users/gamma',
        cwdRevision: 0,
        modelRef: 'anthropic/claude-sonnet',
        resolvedModel: {
          effectiveModelRef: 'anthropic/claude-sonnet',
          effectiveModelName: 'Claude Sonnet',
          effectiveProviderName: 'Anthropic',
          source: 'global',
          available: true,
        },
        avatar: makeAvatar({ id: 'sky-hex', shape: 'hex' }),
        avatarRevision: 0,
        primaryConversationId: 'conv-3',
        createdAt: '2026-01-01T02:00:00.000Z',
        lastActivityAt: null,
        lastPreview: null,
        deviceName: 'Laptop',
        platform: 'macos',
        online: !offlineDevices.has('dev-2'),
      },
    ],
  ]);

  const modelConfigs = new Map([
    [
      'dev-1:bot-1',
      {
        global: { modelRef: 'anthropic/claude-sonnet', thinkingLevel: 'medium', secretField: 'drop' },
        overrides: { modelRef: 'openai/gpt-5', codemode: true, secretOverride: 'drop' },
        effective: { modelRef: 'openai/gpt-5', thinkingLevel: 'medium', codemode: true },
        revision: 3,
      },
    ],
  ]);

  const souls = new Map([
    [
      'dev-1:bot-1',
      {
        botId: 'bot-1',
        path: 'bots/bot-1/SOUL.md',
        revision: VALID_SHA256,
        text: '# Alpha\nBe concise.',
        internalHostDetail: 'strip-me',
      },
    ],
  ]);

  function error(code, message) {
    return Object.assign(new Error(message), { code });
  }

  const deps = {
    async owner(method, routePattern, { params = {}, body, query = {} } = {}) {
      const key = `${method} ${routePattern}`;
      assert.equal(ALLOWED_OWNER_ROUTES.has(key), true, `Unexpected owner route: ${key}`);
      ownerCalls.push({ method, routePattern, params, body, query });

      if (key === 'GET /api/bot-sync') {
        return {
          epoch: 'epoch-1',
          seq: 10,
          mode: 'snapshot',
          devices,
          bots: [...botsByKey.values()],
        };
      }
      if (key === 'GET /api/devices') {
        return devices;
      }
      if (key === 'GET /api/devices/:deviceId/bots') {
        return [...botsByKey.values()].filter((b) => b.deviceId === params.deviceId);
      }
      if (key === 'POST /api/devices/:deviceId/bots') {
        const bot = {
          deviceId: params.deviceId,
          botId: 'bot-created',
          name: body.role,
          description: body.description ?? '',
          isPrimary: Boolean(body.makePrimary),
          archivedAt: null,
          cwd: body.cwd ?? '/workspace/default',
          cwdRevision: 1,
          modelRef: null,
          resolvedModel: null,
          avatar: null,
          avatarRevision: 0,
          primaryConversationId: 'conv-created',
          createdAt: '2026-01-05T00:00:00.000Z',
          lastActivityAt: null,
          lastPreview: null,
          extraLeakyField: 'strip-me',
        };
        botsByKey.set(`${params.deviceId}:${bot.botId}`, bot);
        return bot;
      }
      if (key === 'PATCH /api/devices/:deviceId/bots/:botId') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        const updated = {
          ...bot,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          extraRawField: 'strip-me',
        };
        botsByKey.set(`${params.deviceId}:${params.botId}`, updated);
        return updated;
      }
      if (key === 'POST /api/devices/:deviceId/bots/:botId/primary') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        const updated = { ...bot, isPrimary: true };
        botsByKey.set(`${params.deviceId}:${params.botId}`, updated);
        return updated;
      }
      if (key === 'POST /api/devices/:deviceId/bots/:botId/archive') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        const updated = { ...bot, archivedAt: '2026-01-06T00:00:00.000Z' };
        botsByKey.set(`${params.deviceId}:${params.botId}`, updated);
        return updated;
      }
      if (key === 'POST /api/devices/:deviceId/bots/:botId/unarchive') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        const updated = { ...bot, archivedAt: null };
        botsByKey.set(`${params.deviceId}:${params.botId}`, updated);
        return updated;
      }
      if (key === 'DELETE /api/devices/:deviceId/bots/:botId') {
        botsByKey.delete(`${params.deviceId}:${params.botId}`);
        return undefined;
      }
      if (key === 'GET /api/devices/:deviceId/bots/:botId/model-config') {
        return (
          modelConfigs.get(`${params.deviceId}:${params.botId}`) ?? {
            global: { modelRef: 'anthropic/claude-sonnet' },
            overrides: {},
            effective: { modelRef: 'anthropic/claude-sonnet' },
            revision: 0,
          }
        );
      }
      if (key === 'PUT /api/devices/:deviceId/bots/:botId/model-config') {
        const current = modelConfigs.get(`${params.deviceId}:${params.botId}`) ?? {
          global: { modelRef: 'anthropic/claude-sonnet' },
          overrides: {},
          effective: { modelRef: 'anthropic/claude-sonnet' },
          revision: 0,
        };
        if (body.expectedRevision !== current.revision) {
          throw error('REVISION_CONFLICT', 'Revision does not match');
        }
        const effective = { ...current.global };
        for (const [k, v] of Object.entries(body.value)) {
          if (v !== null && v !== undefined) effective[k] = v;
        }
        const next = {
          global: current.global,
          overrides: body.value,
          effective,
          revision: current.revision + 1,
        };
        modelConfigs.set(`${params.deviceId}:${params.botId}`, next);
        return next;
      }
      if (key === 'GET /api/devices/:deviceId/bots/:botId/cwd') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        return { value: bot.cwd ?? null, revision: bot.cwdRevision ?? 0 };
      }
      if (key === 'PUT /api/devices/:deviceId/bots/:botId/cwd') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        if (body.expectedRevision !== (bot.cwdRevision ?? 0)) {
          throw error('REVISION_CONFLICT', 'Revision does not match');
        }
        bot.cwd = body.value;
        bot.cwdRevision = (bot.cwdRevision ?? 0) + 1;
        return { value: bot.cwd, revision: bot.cwdRevision };
      }
      if (key === 'GET /api/devices/:deviceId/bots/:botId/avatar') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        return { value: bot.avatar ?? null, revision: bot.avatarRevision ?? 0 };
      }
      if (key === 'PUT /api/devices/:deviceId/bots/:botId/avatar') {
        const bot = botsByKey.get(`${params.deviceId}:${params.botId}`);
        if (!bot) throw error('NOT_FOUND', 'Bot not found');
        if (body.expectedRevision !== (bot.avatarRevision ?? 0)) {
          throw error('REVISION_CONFLICT', 'Revision does not match');
        }
        bot.avatar = body.value;
        bot.avatarRevision = (bot.avatarRevision ?? 0) + 1;
        return { value: bot.avatar, revision: bot.avatarRevision };
      }

      throw new Error(`Unhandled mock owner route: ${key}`);
    },
    bridge: {
      deviceId: 'center-internal-1',
      async call(deviceId, method, params) {
        assert.equal(ALLOWED_BRIDGE_METHODS.has(method), true, `Unexpected bridge method: ${method}`);
        bridgeCalls.push({ deviceId, method, params });
        if (offlineDevices.has(deviceId)) {
          throw error('DEVICE_OFFLINE', 'Device offline');
        }
        if (method === 'getBot') {
          const bot = botsByKey.get(`${deviceId}:${params.botId}`);
          if (!bot) throw error('BOT_NOT_FOUND', 'Bot not found');
          return {
            botId: bot.botId,
            deviceId,
            role: bot.name,
            description: bot.description,
            cwd: '/workspace/live-applied',
            primaryConversationId: bot.primaryConversationId,
            createdAt: bot.createdAt,
            isPrimary: bot.isPrimary,
            lastActivityAt: '2026-01-04T00:00:00.000Z',
            lastPreview: 'fresh preview',
            archivedAt: bot.archivedAt,
            hostSecret: 'must-strip',
          };
        }
        if (method === 'getBotSoul') {
          const soul = souls.get(`${deviceId}:${params.botId}`);
          if (!soul) throw error('BOT_NOT_FOUND', 'Bot not found');
          return soul;
        }
        if (method === 'setBotSoul') {
          assert.equal('self' in params.input, false, 'Center relay must never pass self:true');
          const soul = souls.get(`${deviceId}:${params.botId}`);
          if (!soul) throw error('BOT_NOT_FOUND', 'Bot not found');
          if (params.input.expectedRevision !== soul.revision) {
            throw error('REQUEST_CONFLICT', 'SOUL revision does not match');
          }
          const updated = {
            botId: params.botId,
            path: `bots/${params.botId}/SOUL.md`,
            revision: UPDATED_SHA256,
            text: params.input.text,
            status: 'applied',
            extraField: 'strip-me',
          };
          souls.set(`${deviceId}:${params.botId}`, updated);
          return updated;
        }
        if (method === 'abort') {
          return { botId: params.botId, withdrawn: ['req-1', 123], extraField: 'strip-me' };
        }
        if (method === 'clearHistory') {
          return { botId: params.botId, conversationId: 'conv-1', clearedThroughEntryId: 42, extraField: 'strip-me' };
        }
        if (method === 'compact') {
          return { botId: params.botId, conversationId: 'conv-1', compacted: true, extraField: 'strip-me' };
        }
        throw new Error(`Unhandled mock bridge method: ${method}`);
      },
    },
  };

  return { deps, handlers: createHandlers(deps), ownerCalls, bridgeCalls };
}

test('contract operations and server handlers have exact 1-to-1 correspondence and strict JSON Schema descriptors', () => {
  const { handlers } = createHarness();
  const opNames = operations.map((op) => op.name);
  const handlerNames = Object.keys(handlers);

  assert.equal(opNames.length, 14);
  assert.deepEqual([...opNames].sort(), [...handlerNames].sort());

  for (const op of operations) {
    assert.match(op.name, /^pibot_bots?_[a-z_]+$/);
    assert.equal(typeof op.description, 'string');
    assert.ok(op.description.length > 10);
    assert.equal(typeof op.readOnly, 'boolean');
    assert.equal(typeof op.destructive, 'boolean');
    if (op.readOnly) {
      assert.equal(op.destructive, false, `${op.name} is readOnly and must not be destructive`);
    }
    assert.equal(op.inputSchema.type, 'object');
    assert.equal(typeof op.inputSchema.properties, 'object');
    assert.equal(typeof handlers[op.name], 'function');
  }

  // Verify strict structured avatar schema (no raw arbitrary object)
  const avatarOp = operations.find((op) => op.name === 'pibot_bot_set_avatar');
  assert.ok(avatarOp);
  const avatarVariants = avatarOp.inputSchema.properties.avatar.anyOf;
  assert.equal(avatarVariants.length, 2);
  const avatarObjectSchema = avatarVariants.find((variant) => variant.type === 'object');
  assert.equal(avatarObjectSchema.additionalProperties, false);
  assert.deepEqual(avatarObjectSchema.required, [
    'id',
    'shape',
    'color',
    'rotation',
    'expressionIndex',
    'labelZh',
    'labelEn',
  ]);
  assert.deepEqual(avatarObjectSchema.properties.shape.enum, [...BOT_AVATAR_SHAPES]);
  assert.equal(avatarObjectSchema.properties.color.pattern, '^#[0-9a-fA-F]{6}$');

  const modelOp = operations.find((op) => op.name === 'pibot_bot_set_model');
  assert.deepEqual(
    modelOp.inputSchema.properties.thinkingLevel.anyOf[0].enum,
    [...BOT_THINKING_LEVELS],
  );

  const sessionOp = operations.find((op) => op.name === 'pibot_bot_session_control');
  assert.deepEqual(sessionOp.inputSchema.properties.action.enum, [...BOT_SESSION_ACTIONS]);
});

test('pibot_bots_list lists directory, filters archived, paginates, hides center-* and strips non-whitelisted fields', async () => {
  const { handlers } = createHarness();
  const actor = { kind: 'oauth', clientId: 'client-1' };

  const all = await handlers.pibot_bots_list(undefined, actor);
  assert.equal(all.devices.length, 2);
  assert.equal(all.devices.some((d) => d.deviceId.startsWith('center-')), false);
  assert.deepEqual(Object.keys(all.devices[0]).sort(), ['deviceId', 'name', 'online', 'platform']);
  assert.equal(all.total, 3);
  assert.equal(all.bots.length, 3);
  assert.equal(all.nextOffset, null);

  const alpha = all.bots.find((b) => b.botId === 'bot-1');
  assert.equal('rawToken' in alpha, false);
  assert.equal('internalSecret' in alpha.resolvedModel, false);
  assert.equal('injectedControl' in alpha.avatar, false);
  assert.deepEqual(Object.keys(alpha.avatar).sort(), [
    'color',
    'expressionIndex',
    'id',
    'labelEn',
    'labelZh',
    'rotation',
    'shape',
  ]);

  const activeOnly = await handlers.pibot_bots_list({ includeArchived: false, offset: 0, limit: 1 }, actor);
  assert.equal(activeOnly.total, 2);
  assert.equal(activeOnly.bots.length, 1);
  assert.equal(activeOnly.nextOffset, 1);
  assert.equal(activeOnly.bots[0].archivedAt, null);

  const singleDevice = await handlers.pibot_bots_list({ deviceId: 'dev-1', includeArchived: false }, actor);
  assert.equal(singleDevice.devices.length, 1);
  assert.equal(singleDevice.devices[0].deviceId, 'dev-1');
  assert.equal(singleDevice.bots.length, 1);
  assert.equal(singleDevice.bots[0].botId, 'bot-1');

  await assert.rejects(
    () => handlers.pibot_bots_list({ deviceId: 'center-internal-1' }, actor),
    (err) => err?.code === 'NOT_FOUND',
  );
});

test('pibot_bot_get returns whitelisted metadata, configs, live Host merge, and degrades gracefully when offline', async () => {
  const { handlers } = createHarness();
  const actor = { kind: 'oauth', clientId: 'client-1' };

  const detail = await handlers.pibot_bot_get({ deviceId: 'dev-1', botId: 'bot-1' }, actor);
  assert.equal(detail.hostOnline, true);
  assert.equal(detail.hostCwd, '/workspace/live-applied');
  assert.equal(detail.bot.cwd, '/workspace/alpha');
  assert.equal(detail.bot.lastPreview, 'fresh preview');
  assert.equal('rawToken' in detail.bot, false);
  assert.equal('hostSecret' in detail.bot, false);
  assert.equal('injectedControl' in detail.avatar.value, false);
  assert.equal('secretField' in detail.modelConfig.global, false);
  assert.equal('secretOverride' in detail.modelConfig.overrides, false);
  assert.equal(detail.modelConfig.revision, 3);
  assert.equal(detail.cwd.revision, 2);
  assert.equal(detail.avatar.revision, 1);

  const offlineHarness = createHarness({ offlineDevices: new Set(['dev-1']) });
  const offlineDetail = await offlineHarness.handlers.pibot_bot_get(
    { deviceId: 'dev-1', botId: 'bot-1' },
    actor,
  );
  assert.equal(offlineDetail.hostOnline, false);
  assert.equal(offlineDetail.hostCwd, null);
  assert.equal(offlineDetail.bot.botId, 'bot-1');
  assert.equal(offlineHarness.bridgeCalls.length, 0);

  await assert.rejects(
    () => handlers.pibot_bot_get({ deviceId: 'dev-1', botId: 'missing-bot' }, actor),
    (err) => err?.code === 'NOT_FOUND',
  );
});

test('create, update_profile, set_primary, set_model, set_cwd, set_avatar enforce schemas, CAS, and whitelisting', async () => {
  const { handlers, ownerCalls } = createHarness();
  const actor = { kind: 'oauth', clientId: 'client-1' };

  // create with explicit requestId
  const created = await handlers.pibot_bot_create(
    {
      deviceId: 'dev-1',
      name: 'Researcher',
      description: 'Reads papers',
      cwd: '/workspace/research',
      makePrimary: false,
      requestId: 'req-create-1',
    },
    actor,
  );
  assert.equal(created.requestId, 'req-create-1');
  assert.equal(created.bot.name, 'Researcher');
  assert.equal('extraLeakyField' in created.bot, false);

  // reject relative cwd on create
  await assert.rejects(
    () => handlers.pibot_bot_create({ deviceId: 'dev-1', name: 'BadCwd', cwd: 'relative/path' }, actor),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  // update profile
  const updated = await handlers.pibot_bot_update_profile(
    { deviceId: 'dev-1', botId: 'bot-1', name: 'Alpha Prime', description: 'Updated desc' },
    actor,
  );
  assert.equal(updated.bot.name, 'Alpha Prime');
  assert.equal('extraRawField' in updated.bot, false);

  await assert.rejects(
    () => handlers.pibot_bot_update_profile({ deviceId: 'dev-1', botId: 'bot-1' }, actor),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  // set primary
  const primary = await handlers.pibot_bot_set_primary({ deviceId: 'dev-1', botId: 'bot-2' }, actor);
  assert.equal(primary.bot.isPrimary, true);

  // set model with CAS and override merge + explicit null clear
  const modelUpdated = await handlers.pibot_bot_set_model(
    {
      deviceId: 'dev-1',
      botId: 'bot-1',
      expectedRevision: 3,
      thinkingLevel: 'high',
      codemode: null,
    },
    actor,
  );
  assert.equal(modelUpdated.revision, 4);
  assert.equal(modelUpdated.overrides.modelRef, 'openai/gpt-5');
  assert.equal(modelUpdated.overrides.thinkingLevel, 'high');
  assert.equal(modelUpdated.overrides.codemode, null);

  await assert.rejects(
    () =>
      handlers.pibot_bot_set_model(
        { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: 3, thinkingLevel: 'low' },
        actor,
      ),
    (err) => err?.code === 'REVISION_CONFLICT',
  );

  await assert.rejects(
    () =>
      handlers.pibot_bot_set_model(
        { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: 4, thinkingLevel: 'ultra' },
        actor,
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  // set cwd (POSIX / Windows / UNC allowed, relative rejected, CAS enforced)
  const cwdUpdated = await handlers.pibot_bot_set_cwd(
    { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: 2, cwd: 'C:\\Projects\\Alpha' },
    actor,
  );
  assert.equal(cwdUpdated.value, 'C:\\Projects\\Alpha');
  assert.equal(cwdUpdated.revision, 3);
  assert.equal(cwdUpdated.appliesAt, 'next-idle');

  await assert.rejects(
    () =>
      handlers.pibot_bot_set_cwd(
        { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: 3, cwd: './not-absolute' },
        actor,
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  // set avatar: reject raw arbitrary object / extra fields, accept strict 7-field object and null
  await assert.rejects(
    () =>
      handlers.pibot_bot_set_avatar(
        {
          deviceId: 'dev-1',
          botId: 'bot-1',
          expectedRevision: 1,
          avatar: { ...makeAvatar(), arbitraryControl: true },
        },
        actor,
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  await assert.rejects(
    () =>
      handlers.pibot_bot_set_avatar(
        {
          deviceId: 'dev-1',
          botId: 'bot-1',
          expectedRevision: 1,
          avatar: makeAvatar({ shape: 'not-a-shape' }),
        },
        actor,
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  const avatarUpdated = await handlers.pibot_bot_set_avatar(
    {
      deviceId: 'dev-1',
      botId: 'bot-1',
      expectedRevision: 1,
      avatar: makeAvatar({ id: 'coral-wedge', shape: 'wedge', color: '#EA403C', rotation: 14, expressionIndex: 2 }),
    },
    actor,
  );
  assert.equal(avatarUpdated.revision, 2);
  assert.equal(avatarUpdated.value.shape, 'wedge');

  const avatarCleared = await handlers.pibot_bot_set_avatar(
    { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: 2, avatar: null },
    actor,
  );
  assert.equal(avatarCleared.revision, 3);
  assert.equal(avatarCleared.value, null);

  assert.ok(ownerCalls.length > 0);
});

test('SOUL read/write enforces CAS, rejects self-targeting over Center relay with Host set_bot_soul guidance', async () => {
  const { handlers, bridgeCalls } = createHarness();
  const selfBot = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-1' };
  const otherBot = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-2' };

  // Reading own SOUL is read-only and allowed
  const readSelf = await handlers.pibot_bot_soul_get({ deviceId: 'dev-1', botId: 'bot-1' }, selfBot);
  assert.equal(readSelf.revision, VALID_SHA256);
  assert.equal(readSelf.text, '# Alpha\nBe concise.');
  assert.equal('internalHostDetail' in readSelf, false);

  // Editing own SOUL through Center relay is forbidden and routes to local Host set_bot_soul
  const callsBefore = bridgeCalls.length;
  await assert.rejects(
    () =>
      handlers.pibot_bot_set_soul(
        { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: VALID_SHA256, text: '# Updated' },
        selfBot,
      ),
    (err) => err?.code === 'FORBIDDEN' && /set_bot_soul/.test(err.message),
  );
  assert.equal(bridgeCalls.length, callsBefore);

  // Editing another Bot's SOUL succeeds without self:true
  const updated = await handlers.pibot_bot_set_soul(
    { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: VALID_SHA256, text: '# Updated by peer' },
    otherBot,
  );
  assert.equal(updated.revision, UPDATED_SHA256);
  assert.equal(updated.status, 'applied');
  assert.equal('extraField' in updated, false);

  // Invalid revision or oversized SOUL text rejected before calling bridge
  await assert.rejects(
    () =>
      handlers.pibot_bot_set_soul(
        { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: 'not-sha256', text: 'x' },
        otherBot,
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () =>
      handlers.pibot_bot_set_soul(
        { deviceId: 'dev-1', botId: 'bot-1', expectedRevision: UPDATED_SHA256, text: 'x'.repeat(65537) },
        otherBot,
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );
});

test('self-stopping and destructive lifecycle operations reject calling Bot self-target, allow peer/OAuth, and reject spoofed args', async () => {
  const { handlers, ownerCalls, bridgeCalls } = createHarness();
  const selfBot = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-1' };
  const peerBot = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-2' };
  const oauthActor = { kind: 'oauth', clientId: 'oauth-client-1' };

  // Calling Bot cannot stop, clear_history, compact, archive, or delete itself
  for (const action of ['stop', 'clear_history', 'compact']) {
    await assert.rejects(
      () => handlers.pibot_bot_session_control({ deviceId: 'dev-1', botId: 'bot-1', action }, selfBot),
      (err) => err?.code === 'FORBIDDEN',
    );
  }
  await assert.rejects(
    () => handlers.pibot_bot_archive({ deviceId: 'dev-1', botId: 'bot-1' }, selfBot),
    (err) => err?.code === 'FORBIDDEN',
  );
  await assert.rejects(
    () => handlers.pibot_bot_delete({ deviceId: 'dev-1', botId: 'bot-1' }, selfBot),
    (err) => err?.code === 'FORBIDDEN',
  );
  assert.equal(ownerCalls.length, 0);
  assert.equal(bridgeCalls.length, 0);

  // Spoofed actor / arbitrary path keys in args are strictly rejected
  await assert.rejects(
    () =>
      handlers.pibot_bot_delete(
        { deviceId: 'dev-1', botId: 'bot-2', actor: { kind: 'oauth', clientId: 'spoofed' } },
        selfBot,
      ),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  // Peer Bot and OAuth actor can perform session controls and lifecycle actions
  const stopped = await handlers.pibot_bot_session_control(
    { deviceId: 'dev-1', botId: 'bot-1', action: 'stop' },
    peerBot,
  );
  assert.deepEqual(stopped, {
    action: 'stop',
    deviceId: 'dev-1',
    botId: 'bot-1',
    stopped: true,
    withdrawn: ['req-1'],
  });

  const cleared = await handlers.pibot_bot_session_control(
    { deviceId: 'dev-1', botId: 'bot-1', action: 'clear_history' },
    oauthActor,
  );
  assert.deepEqual(cleared, {
    action: 'clear_history',
    deviceId: 'dev-1',
    botId: 'bot-1',
    conversationId: 'conv-1',
    clearedThroughEntryId: 42,
  });

  const compacted = await handlers.pibot_bot_session_control(
    { deviceId: 'dev-1', botId: 'bot-1', action: 'compact' },
    oauthActor,
  );
  assert.deepEqual(compacted, {
    action: 'compact',
    deviceId: 'dev-1',
    botId: 'bot-1',
    conversationId: 'conv-1',
    compacted: true,
  });

  const archived = await handlers.pibot_bot_archive({ deviceId: 'dev-1', botId: 'bot-1' }, oauthActor);
  assert.equal(typeof archived.bot.archivedAt, 'string');

  const unarchived = await handlers.pibot_bot_unarchive({ deviceId: 'dev-1', botId: 'bot-1' }, oauthActor);
  assert.equal(unarchived.bot.archivedAt, null);

  const deleted = await handlers.pibot_bot_delete({ deviceId: 'dev-1', botId: 'bot-2' }, selfBot);
  assert.deepEqual(deleted, { deviceId: 'dev-1', botId: 'bot-2', deleted: true });
});
