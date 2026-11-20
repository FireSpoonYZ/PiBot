import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operationCatalog } from '../../center-contract/operations/index.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { openHostBridge } from '../../center-server/host-bridge.js';
import { openOperations } from '../../center-server/operations/index.js';
import { createHandlers } from '../../center-server/operations/dispatch.js';

function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'pibot-dispatch-targets-'));
  const store = openCenterStore({ dataRoot, encryptionKey: randomBytes(32) });
  const bridge = openHostBridge({ dataRoot, store, relay: { getStatus: () => ({ onlineDeviceIds: [] }) } });

  bridge.registry.register({
    deviceId: 'dev-1',
    token: randomBytes(32).toString('base64url'),
    displayName: 'Host One',
  });
  bridge.registry.register({
    deviceId: 'dev-2',
    token: randomBytes(32).toString('base64url'),
    displayName: 'Host Two',
  });
  bridge.registry.register({
    deviceId: 'dev-revoked',
    token: randomBytes(32).toString('base64url'),
    displayName: 'Revoked Host',
  });
  bridge.registry.revoke('dev-revoked');

  store.replaceDeviceBots('dev-1', [
    {
      deviceId: 'dev-1',
      botId: 'bot-1',
      name: 'Alpha',
      description: 'Private bot description',
      isPrimary: true,
      lastPreview: 'Private last chat preview',
    },
    {
      deviceId: 'dev-1',
      botId: 'bot-2',
      name: 'Beta',
      description: 'Unauthorized bot description',
      isPrimary: false,
    },
    {
      deviceId: 'dev-1',
      botId: 'bot-archived',
      name: 'Archived Alpha',
      isPrimary: false,
      archivedAt: '2026-11-01T00:00:00.000Z',
    },
  ]);
  store.putBotCwd('dev-1', 'bot-1', 0, '/private/workspace/alpha');

  store.replaceDeviceBots('dev-2', [
    {
      deviceId: 'dev-2',
      botId: 'bot-3',
      name: 'Gamma',
      description: 'Second host bot',
      isPrimary: true,
    },
  ]);
  store.replaceDeviceBots('dev-revoked', [
    {
      deviceId: 'dev-revoked',
      botId: 'bot-revoked',
      name: 'Revoked Bot',
      isPrimary: true,
    },
  ]);
  store.replaceDeviceBots('dev-unregistered', [
    {
      deviceId: 'dev-unregistered',
      botId: 'bot-ghost',
      name: 'Unregistered Bot',
      isPrimary: true,
    },
  ]);
  store.replaceDeviceBots(bridge.deviceId, [
    {
      deviceId: bridge.deviceId,
      botId: 'bot-internal',
      name: 'Internal Center Bot',
      isPrimary: true,
    },
  ]);

  const ops = openOperations({
    store,
    bridge: {
      deviceId: bridge.deviceId,
      registry: bridge.registry,
      call: async () => {
        throw new Error('dispatch_list_targets must not invoke bridge.call');
      },
    },
    owner: async () => {
      throw new Error('dispatch_list_targets must not invoke owner actions');
    },
  });

  const handlers = createHandlers({ store, bridge });

  return {
    store,
    bridge,
    ops,
    handlers,
    cleanup() {
      bridge.close();
      store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('dispatch_list_targets is scoped to pibot:messages:read without requiring pibot:bots:read', async () => {
  const fixture = createFixture();
  try {
    const descriptor = operationCatalog.find((op) => op.name === 'dispatch_list_targets');
    assert.ok(descriptor, 'dispatch_list_targets should be present in operationCatalog');
    assert.equal(descriptor.domain, 'messages');
    assert.equal(descriptor.scope, 'pibot:messages:read');
    assert.equal(descriptor.readOnly, true);
    assert.equal(descriptor.destructive, false);
    assert.deepEqual(descriptor.inputSchema, {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });

    const messagesReadActor = {
      kind: 'oauth',
      clientId: 'gemini-client',
      scopes: ['pibot:messages:read'],
      botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }],
    };
    const listedNames = fixture.ops.list(messagesReadActor).map((op) => op.name);
    assert.ok(listedNames.includes('dispatch_list_targets'));
    assert.ok(listedNames.includes('dispatch_get_bot_message'));
    assert.equal(listedNames.includes('dispatch_send_bot_message'), false);
    assert.equal(listedNames.includes('pibot_bots_list'), false);

    const result = await fixture.ops.call(messagesReadActor, 'dispatch_list_targets', {});
    assert.deepEqual(result, {
      targets: [{ deviceId: 'dev-1', botId: 'bot-1', name: 'Alpha' }],
    });

    await assert.rejects(
      () => fixture.ops.call(messagesReadActor, 'pibot_bots_list', {}),
      (err) => err?.code === 'FORBIDDEN',
    );

    for (const badArgs of [
      { deviceId: 'dev-1' },
      { botTargets: [{ deviceId: 'dev-1', botId: 'bot-2' }] },
      { actor: { kind: 'oauth', clientId: 'forged', botTargets: [{ deviceId: 'dev-1', botId: 'bot-2' }] } },
    ]) {
      await assert.rejects(
        () => fixture.ops.call(messagesReadActor, 'dispatch_list_targets', badArgs),
        (err) => err?.code === 'INVALID_ARGUMENT',
      );
    }

    for (const deniedActor of [
      { kind: 'oauth', clientId: 'write-only', scopes: ['pibot:messages:write'], botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }] },
      { kind: 'oauth', clientId: 'bots-read-only', scopes: ['pibot:bots:read'], botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }] },
      { kind: 'oauth', clientId: 'no-scope', scopes: [], botTargets: [{ deviceId: 'dev-1', botId: 'bot-1' }] },
    ]) {
      assert.equal(
        fixture.ops.list(deniedActor).some((op) => op.name === 'dispatch_list_targets'),
        false,
      );
      await assert.rejects(
        () => fixture.ops.call(deniedActor, 'dispatch_list_targets', {}),
        (err) => err?.code === 'FORBIDDEN',
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('dispatch_list_targets validates device registry + active non-archived Bots and returns only minimal fields', async () => {
  const fixture = createFixture();
  try {
    const storedAlpha = fixture.store.listDeviceBots('dev-1').find((bot) => bot.botId === 'bot-1');
    assert.equal(storedAlpha?.cwd, '/private/workspace/alpha');
    assert.equal(storedAlpha?.description, 'Private bot description');

    const oauthActor = {
      kind: 'oauth',
      clientId: 'gemini-client',
      scopes: ['pibot:messages:read'],
      botTargets: [
        { deviceId: 'dev-1', botId: 'bot-1', approvedRouteIds: ['route-secret'] },
        { deviceId: 'dev-1', botId: 'bot-1' },
        { deviceId: 'dev-1', botId: 'bot-archived' },
        { deviceId: 'dev-1', botId: 'bot-missing' },
        { deviceId: 'dev-revoked', botId: 'bot-revoked' },
        { deviceId: 'dev-unregistered', botId: 'bot-ghost' },
        { deviceId: fixture.bridge.deviceId, botId: 'bot-internal' },
        { deviceId: 'dev-2', botId: 'bot-3' },
      ],
    };

    const result = await fixture.ops.call(oauthActor, 'dispatch_list_targets', {});
    assert.deepEqual(result, {
      targets: [
        { deviceId: 'dev-1', botId: 'bot-1', name: 'Alpha' },
        { deviceId: 'dev-2', botId: 'bot-3', name: 'Gamma' },
      ],
    });
    for (const item of result.targets) {
      assert.deepEqual(Object.keys(item).sort(), ['botId', 'deviceId', 'name']);
    }
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'Private bot description',
      '/private/workspace/alpha',
      'Private last chat preview',
      'route-secret',
      'bot-2',
      'Beta',
      'bot-archived',
      'bot-revoked',
      'bot-ghost',
      'bot-internal',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `Response must not expose ${forbidden}`);
    }

    for (const emptyActor of [
      { kind: 'oauth', clientId: 'empty-targets', scopes: ['pibot:messages:read'], botTargets: [] },
      { kind: 'oauth', clientId: 'missing-targets', scopes: ['pibot:messages:read'] },
    ]) {
      assert.deepEqual(
        await fixture.ops.call(emptyActor, 'dispatch_list_targets', {}),
        { targets: [] },
      );
    }

    const noRegistryHandlers = createHandlers({ store: fixture.store, bridge: null });
    assert.deepEqual(
      await noRegistryHandlers.dispatch_list_targets({}, oauthActor),
      { targets: [] },
    );

    await assert.rejects(
      () => fixture.handlers.dispatch_list_targets({}, null),
      (err) => err?.code === 'UNAUTHENTICATED',
    );
  } finally {
    fixture.cleanup();
  }
});

test('internal Bot actor cannot enumerate other Bots or devices via dispatch_list_targets', async () => {
  const fixture = createFixture();
  try {
    const botActor = { kind: 'bot', deviceId: 'dev-1', botId: 'bot-1' };

    const direct = await fixture.handlers.dispatch_list_targets({}, botActor);
    assert.deepEqual(direct, {
      targets: [{ deviceId: 'dev-1', botId: 'bot-1', name: 'Alpha' }],
    });

    assert.deepEqual(
      await fixture.handlers.dispatch_list_targets({}, { kind: 'bot', deviceId: 'dev-1', botId: 'bot-archived' }),
      { targets: [] },
    );
    assert.deepEqual(
      await fixture.handlers.dispatch_list_targets({}, { kind: 'bot', deviceId: 'dev-revoked', botId: 'bot-revoked' }),
      { targets: [] },
    );

    // Substantive permission check: either audiences:['oauth'] denies internal Bots at openOperations,
    // or baseline openOperations allows only the caller's own Bot without any global leakage.
    let opResult = null;
    let opError = null;
    try {
      opResult = await fixture.ops.call(botActor, 'dispatch_list_targets', {});
    } catch (err) {
      opError = err;
    }
    if (opError) {
      assert.equal(opError.code, 'FORBIDDEN');
    } else {
      assert.deepEqual(opResult, {
        targets: [{ deviceId: 'dev-1', botId: 'bot-1', name: 'Alpha' }],
      });
    }
  } finally {
    fixture.cleanup();
  }
});
