import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { operations } from '../../center-contract/operations/collaboration.js';
import { createHandlers } from '../../center-server/operations/collaboration.js';
import { openHost } from '../../host-core/host.js';
import { openMessageLog } from '../../host-core/messages.js';
import { messageError } from '../../host-core/message-protocol.js';
import { normalizeUserMessage } from '../../host-core/scope-protocol.js';
import {
  readScopeHistory,
  readScopeMessage,
  readScopeMessageDelivery,
} from '../../host-core/runtime-scope-queries.js';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'el-center-collab-ops-'));
  const dirA = join(root, 'host-a');
  const dirB = join(root, 'host-b');

  const initA = openHost({ dataRoot: dirA });
  const botA1 = initA.createBot({ requestId: 'init-a1', role: 'Architect' });
  const botA2 = initA.createBot({ requestId: 'init-a2', role: 'Builder' });
  const botA3 = initA.createBot({ requestId: 'init-a3', role: 'Reviewer' });
  const deviceA = initA.deviceId;
  initA.close();

  const initB = openHost({ dataRoot: dirB });
  const botB1 = initB.createBot({ requestId: 'init-b1', role: 'Tester' });
  const deviceB = initB.deviceId;
  initB.close();

  const logA = openMessageLog({ dataRoot: dirA });
  const logB = openMessageLog({ dataRoot: dirB });
  const logs = new Map([
    [deviceA, logA],
    [deviceB, logB],
  ]);

  const recordedCalls = [];
  const customOverrides = new Map();
  let deviceBOnline = true;

  const bridge = {
    deviceId: 'center-internal-test',
    listDevices() {
      return [
        { deviceId: deviceA, name: 'Host A', online: true },
        { deviceId: deviceB, name: 'Host B', online: deviceBOnline },
      ];
    },
    async call(targetDeviceId, method, params) {
      recordedCalls.push({ targetDeviceId, method, params });
      const overrideKey = `${targetDeviceId}:${method}`;
      if (customOverrides.has(overrideKey)) {
        return customOverrides.get(overrideKey)(params);
      }
      if (customOverrides.has(method)) {
        return customOverrides.get(method)(targetDeviceId, params);
      }
      const log = logs.get(targetDeviceId);
      if (!log) throw messageError('NOT_FOUND', 'Host not found');
      switch (method) {
        case 'listScopeStates':
          return log.listScopeStates(params);
        case 'getScopeState':
          return log.getScopeState(params.scopeId);
        case 'listScopeReplicas':
          return log.listScopeReplicas(params.scopeId, { limit: params.limit, cursor: params.cursor });
        case 'scopeHistory':
          return readScopeHistory(log, params.scopeId, {
            limit: params.limit,
            cursor: params.cursor,
            order: params.order,
          });
        case 'getScopeMessage':
          return readScopeMessage(log, params.scopeId, params.messageId);
        case 'getScopeMessageDelivery':
          return readScopeMessageDelivery(log, params.scopeId, params.messageId);
        case 'createScope':
          return log.createScope(params.input);
        case 'updateScope':
          return log.updateScope(params.scopeId, params.input);
        case 'deleteScope':
          return log.deleteScope(params.scopeId, params.input);
        case 'publishUserMessage':
          return log.publish(normalizeUserMessage(params.scopeId, params.input));
        case 'withdrawQueued':
          return {
            botId: params.botId,
            withdrawn: params.requestId
              ? [{ requestId: params.requestId, text: 'queued-item' }]
              : [],
          };
        case 'steerQueued':
          return { botId: params.botId, requestId: params.requestId, status: 'steered' };
        case 'editMessage':
          return {
            botId: params.botId,
            requestId: params.requestId,
            status: 'queued',
            entryId: params.entryId,
          };
        case 'getWorkActivity':
          return { botId: params.botId, scopeId: params.scopeId, stopped: false, member: true, error: null };
        case 'stopWork':
          return { botId: params.botId, scopeId: params.scopeId, stopped: true, member: true, error: null };
        case 'resumeWork':
          return { botId: params.botId, scopeId: params.scopeId, stopped: false, member: true, error: null };
        default:
          throw messageError('INVALID_ARGUMENT', `Unexpected host method: ${method}`);
      }
    },
  };

  const handlers = createHandlers({ bridge });

  return {
    deviceA,
    deviceB,
    botA1,
    botA2,
    botA3,
    botB1,
    logA,
    logB,
    bridge,
    handlers,
    recordedCalls,
    customOverrides,
    setDeviceBOnline(value) {
      deviceBOnline = value;
    },
    replicateOffersAtoB(scopeId) {
      for (const offer of logA.scopeOffers().items) {
        if (offer.record.scope.scopeId !== scopeId || offer.targetDeviceId !== deviceB) continue;
        const ack = logB.acceptScopeOffer({ deviceId: deviceA }, offer.record);
        logA.acknowledgeScope({ deviceId: deviceB }, ack);
      }
    },
    close() {
      try { logA.close(); } catch { /* ignore */ }
      try { logB.close(); } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('collaboration contract descriptors match handlers 1:1 with strict read/write separation and plain JSON Schema', () => {
  assert.ok(Array.isArray(operations), 'operations must be exported as an array');
  assert.ok(operations.length > 0, 'operations must be non-empty');

  const handlers = createHandlers({ bridge: { listDevices: () => [], call: async () => ({}) } });
  const descriptorNames = operations.map((op) => op.name);
  const handlerNames = Object.keys(handlers);

  assert.equal(new Set(descriptorNames).size, descriptorNames.length, 'operation names must be unique');
  assert.deepEqual([...descriptorNames].sort(), [...handlerNames].sort(), 'every descriptor has exactly one handler');

  for (const op of operations) {
    assert.ok(op.name.startsWith('collaboration_'), `missing collaboration_ prefix: ${op.name}`);
    assert.equal(typeof op.description, 'string');
    assert.ok(op.description.length > 20, `description too short for ${op.name}`);
    assert.equal(typeof op.readOnly, 'boolean');
    assert.equal(typeof op.destructive, 'boolean');
    assert.equal(op.inputSchema?.type, 'object');
    assert.equal(typeof op.inputSchema?.properties, 'object');
    assert.ok(Array.isArray(op.inputSchema?.required));
    if (op.readOnly) {
      assert.equal(op.destructive, false, `readOnly operation cannot be destructive: ${op.name}`);
    }
    assert.equal(typeof handlers[op.name], 'function');
  }

  const publishOp = operations.find((op) => op.name === 'collaboration_publish_room_message');
  assert.ok(publishOp, 'collaboration_publish_room_message must exist');
  assert.match(publishOp.description, /owner-delegated/i);
  assert.match(publishOp.description, /room-only/i);
  assert.match(publishOp.description, /send_to/);
  assert.ok(publishOp.inputSchema.required.includes('scopeId'), 'publish must require explicit scopeId');
  assert.equal(publishOp.inputSchema.properties.author, undefined, 'publish must not expose author');
  assert.equal(publishOp.inputSchema.properties.files, undefined, 'publish must not expose file paths');
});

test('authentication, actor spoofing, unknown args, and device target boundaries are strictly enforced', async () => {
  const fx = createFixture();
  try {
    const oauthActor = { kind: 'oauth', clientId: 'mcp-owner-1' };

    await assert.rejects(
      () => fx.handlers.collaboration_list_scopes({ deviceId: fx.deviceA }, null),
      (err) => err?.code === 'UNAUTHENTICATED',
    );
    await assert.rejects(
      () => fx.handlers.collaboration_list_scopes({ deviceId: fx.deviceA }, { kind: 'admin' }),
      (err) => err?.code === 'UNAUTHENTICATED',
    );
    await assert.rejects(
      () => fx.handlers.collaboration_list_scopes({ deviceId: fx.deviceA, actor: oauthActor }, oauthActor),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () => fx.handlers.collaboration_list_scopes({ deviceId: 'center-internal-test' }, oauthActor),
      (err) => err?.code === 'NOT_FOUND',
    );
    await assert.rejects(
      () => fx.handlers.collaboration_list_scopes({ deviceId: 'unknown-device-xyz' }, oauthActor),
      (err) => err?.code === 'NOT_FOUND',
    );

    fx.setDeviceBOnline(false);
    await assert.rejects(
      () => fx.handlers.collaboration_list_scopes({ deviceId: fx.deviceB }, oauthActor),
      (err) => err?.code === 'DEVICE_OFFLINE',
    );
    fx.setDeviceBOnline(true);
  } finally {
    fx.close();
  }
});

test('room lifecycle preserves authority, CAS expectedRevision, requestId idempotency, leave semantics, and tombstone delete', async () => {
  const fx = createFixture();
  try {
    const oauthActor = { kind: 'oauth', clientId: 'mcp-owner-1' };
    const botA3Actor = { kind: 'bot', deviceId: fx.deviceA, botId: fx.botA3.botId };
    const botA1Actor = { kind: 'bot', deviceId: fx.deviceA, botId: fx.botA1.botId };

    // Create room with 3 members across Host A and Host B (Host A is authority)
    const created = await fx.handlers.collaboration_create_room(
      {
        deviceId: fx.deviceA,
        title: 'Sprint Room',
        requestId: 'req-create-1',
        members: [
          { deviceId: fx.deviceA, botId: fx.botA1.botId },
          { deviceId: fx.deviceA, botId: fx.botA2.botId },
          { deviceId: fx.deviceB, botId: fx.botB1.botId },
        ],
      },
      oauthActor,
    );
    assert.equal(created.scope.kind, 'room');
    assert.equal(created.scope.revision, 1);
    assert.equal(created.scope.title, 'Sprint Room');
    assert.equal(created.authorityDeviceId, fx.deviceA);
    assert.equal(created.isAuthority, true);
    assert.equal(created.requestId, 'req-create-1');

    // Idempotent retry with same requestId returns exact same scope revision
    const createdRetry = await fx.handlers.collaboration_create_room(
      {
        deviceId: fx.deviceA,
        title: 'Sprint Room',
        requestId: 'req-create-1',
        members: [
          { deviceId: fx.deviceB, botId: fx.botB1.botId },
          { deviceId: fx.deviceA, botId: fx.botA2.botId },
          { deviceId: fx.deviceA, botId: fx.botA1.botId },
        ],
      },
      oauthActor,
    );
    assert.equal(createdRetry.scope.scopeId, created.scope.scopeId);
    assert.equal(createdRetry.scope.revision, 1);

    const scopeId = created.scope.scopeId;
    fx.replicateOffersAtoB(scopeId);

    // Non-authority Host B cannot rename, update members, leave, or delete
    await assert.rejects(
      () =>
        fx.handlers.collaboration_rename_room(
          { deviceId: fx.deviceB, scopeId, expectedRevision: 1, title: 'Hijack' },
          oauthActor,
        ),
      (err) => err?.code === 'SCOPE_AUTHORITY_REQUIRED',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_leave_room(
          {
            deviceId: fx.deviceB,
            scopeId,
            expectedRevision: 1,
            member: { deviceId: fx.deviceB, botId: fx.botB1.botId },
          },
          oauthActor,
        ),
      (err) => err?.code === 'SCOPE_AUTHORITY_REQUIRED',
    );

    // Delegated cross-group management by Bot A3 (not a member of the room) still respects authority & CAS
    const renamed = await fx.handlers.collaboration_rename_room(
      { deviceId: fx.deviceA, scopeId, expectedRevision: 1, title: 'Design Review', requestId: 'req-rename-1' },
      botA3Actor,
    );
    assert.equal(renamed.scope.revision, 2);
    assert.equal(renamed.scope.title, 'Design Review');

    // Stale CAS expectedRevision is rejected
    await assert.rejects(
      () =>
        fx.handlers.collaboration_rename_room(
          { deviceId: fx.deviceA, scopeId, expectedRevision: 1, title: 'Stale' },
          botA3Actor,
        ),
      (err) => err?.code === 'REQUEST_CONFLICT',
    );

    // Empty title clears custom title back to default member-derived name
    const clearedTitle = await fx.handlers.collaboration_rename_room(
      { deviceId: fx.deviceA, scopeId, expectedRevision: 2, title: '' },
      oauthActor,
    );
    assert.equal(clearedTitle.scope.revision, 3);
    assert.equal(clearedTitle.scope.title, undefined);

    // Update members to add Bot A3 (now 4 members)
    const updatedMembers = await fx.handlers.collaboration_update_room_members(
      {
        deviceId: fx.deviceA,
        scopeId,
        expectedRevision: 3,
        members: [
          { deviceId: fx.deviceA, botId: fx.botA1.botId },
          { deviceId: fx.deviceA, botId: fx.botA2.botId },
          { deviceId: fx.deviceA, botId: fx.botA3.botId },
          { deviceId: fx.deviceB, botId: fx.botB1.botId },
        ],
      },
      oauthActor,
    );
    assert.equal(updatedMembers.scope.revision, 4);
    assert.equal(updatedMembers.scope.members.length, 4);

    // Bot cannot use leave_room to kick another Bot
    await assert.rejects(
      () =>
        fx.handlers.collaboration_leave_room(
          {
            deviceId: fx.deviceA,
            scopeId,
            expectedRevision: 4,
            member: { deviceId: fx.deviceA, botId: fx.botA2.botId },
          },
          botA3Actor,
        ),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Bot A3 leaves room as itself (derived from trusted actor) with requestId idempotency
    const left = await fx.handlers.collaboration_leave_room(
      { deviceId: fx.deviceA, scopeId, expectedRevision: 4, requestId: 'req-leave-a3' },
      botA3Actor,
    );
    assert.equal(left.scope.revision, 5);
    assert.deepEqual(left.leftMember, { deviceId: fx.deviceA, botId: fx.botA3.botId });
    assert.equal(left.scope.members.length, 3);

    // Idempotent retry of lost-response leave with same requestId & expectedRevision returns rev 5
    const leftRetry = await fx.handlers.collaboration_leave_room(
      { deviceId: fx.deviceA, scopeId, expectedRevision: 4, requestId: 'req-leave-a3' },
      botA3Actor,
    );
    assert.equal(leftRetry.scope.revision, 5);
    assert.equal(leftRetry.scope.members.length, 3);

    // OAuth removes botB1 -> 2 members left
    const leftOAuth = await fx.handlers.collaboration_leave_room(
      {
        deviceId: fx.deviceA,
        scopeId,
        expectedRevision: 5,
        member: { deviceId: fx.deviceB, botId: fx.botB1.botId },
      },
      oauthActor,
    );
    assert.equal(leftOAuth.scope.revision, 6);
    assert.equal(leftOAuth.scope.members.length, 2);

    // Leaving a 2-member room is rejected because room requires >= 2 members
    await assert.rejects(
      () =>
        fx.handlers.collaboration_leave_room(
          { deviceId: fx.deviceA, scopeId, expectedRevision: 6 },
          botA1Actor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Dissolve (tombstone) the room with CAS
    const deleted = await fx.handlers.collaboration_delete_room(
      { deviceId: fx.deviceA, scopeId, expectedRevision: 6, requestId: 'req-del-1' },
      oauthActor,
    );
    assert.equal(deleted.scope.revision, 7);
    assert.ok(typeof deleted.scope.deletedAt === 'string', 'tombstone must carry deletedAt');

    // Subsequent rename on deleted room returns SCOPE_DELETED
    await assert.rejects(
      () =>
        fx.handlers.collaboration_rename_room(
          { deviceId: fx.deviceA, scopeId, expectedRevision: 7, title: 'Revive' },
          oauthActor,
        ),
      (err) => err?.code === 'SCOPE_DELETED',
    );
  } finally {
    fx.close();
  }
});

test('owner-delegated room publish enforces OAuth-only, room-only, explicit scope, provenance header, and no Bot spoofing or file paths', async () => {
  const fx = createFixture();
  try {
    const oauthActor = { kind: 'oauth', clientId: 'claude@desktop[1]' };
    const botA1Actor = { kind: 'bot', deviceId: fx.deviceA, botId: fx.botA1.botId };

    const room = await fx.handlers.collaboration_create_room(
      {
        deviceId: fx.deviceA,
        title: 'Ops Room',
        members: [
          { deviceId: fx.deviceA, botId: fx.botA1.botId },
          { deviceId: fx.deviceB, botId: fx.botB1.botId },
        ],
      },
      oauthActor,
    );
    const dm = fx.logA.createScope({
      requestId: 'req-dm-1',
      kind: 'dm',
      members: [
        { deviceId: fx.deviceA, botId: fx.botA1.botId },
        { deviceId: fx.deviceA, botId: fx.botA2.botId },
      ],
    });

    // Bot caller MUST NOT publish owner-delegated user room messages (must use local send_to)
    await assert.rejects(
      () =>
        fx.handlers.collaboration_publish_room_message(
          { deviceId: fx.deviceA, scopeId: room.scope.scopeId, text: 'Pretending to be user' },
          botA1Actor,
        ),
      (err) => err?.code === 'FORBIDDEN',
    );

    // Rejects arbitrary author, Bot impersonation, file-path attachments, missing scopeId, blank text
    await assert.rejects(
      () =>
        fx.handlers.collaboration_publish_room_message(
          {
            deviceId: fx.deviceA,
            scopeId: room.scope.scopeId,
            text: 'hi',
            author: { kind: 'bot', botId: fx.botA1.botId },
          },
          oauthActor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_publish_room_message(
          {
            deviceId: fx.deviceA,
            scopeId: room.scope.scopeId,
            text: 'hi',
            files: ['/etc/passwd'],
          },
          oauthActor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_publish_room_message(
          { deviceId: fx.deviceA, text: 'missing scopeId' },
          oauthActor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_publish_room_message(
          { deviceId: fx.deviceA, scopeId: room.scope.scopeId, text: '   ' },
          oauthActor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Room-only protocol check: DM scope is rejected
    await assert.rejects(
      () =>
        fx.handlers.collaboration_publish_room_message(
          { deviceId: fx.deviceA, scopeId: dm.scope.scopeId, text: 'No user DM publish' },
          oauthActor,
        ),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );

    // Valid owner-delegated room publish attaches fixed deterministic provenance header (@ neutralized)
    const receipt = await fx.handlers.collaboration_publish_room_message(
      {
        deviceId: fx.deviceA,
        scopeId: room.scope.scopeId,
        messageId: 'msg-oauth-1',
        text: '@Builder please check build status',
      },
      oauthActor,
    );
    assert.equal(receipt.status, 'stored');
    assert.deepEqual(receipt.author, { kind: 'user' });
    assert.equal(receipt.category, 'public');
    assert.equal(receipt.provenance.kind, 'owner_delegated_oauth');
    assert.equal(receipt.provenance.clientId, 'claude@desktop[1]');
    assert.equal(receipt.provenance.header, '[Owner-delegated via OAuth: claude(at)desktop(1)]');

    // Stored ledger text carries the exact provenance header and original text
    const stored = await fx.handlers.collaboration_get_scope_message(
      { deviceId: fx.deviceA, scopeId: room.scope.scopeId, messageId: 'msg-oauth-1' },
      oauthActor,
    );
    assert.equal(
      stored.message.text,
      '[Owner-delegated via OAuth: claude(at)desktop(1)]\n@Builder please check build status',
    );

    // Idempotent retry with same messageId returns same localId
    const retry = await fx.handlers.collaboration_publish_room_message(
      {
        deviceId: fx.deviceA,
        scopeId: room.scope.scopeId,
        messageId: 'msg-oauth-1',
        text: '@Builder please check build status',
      },
      oauthActor,
    );
    assert.equal(retry.localId, receipt.localId);

    // Delivery status on source device reports local stored + pending remote peer Host B
    const delivery = await fx.handlers.collaboration_get_scope_message_delivery(
      { deviceId: fx.deviceA, scopeId: room.scope.scopeId, messageId: 'msg-oauth-1' },
      oauthActor,
    );
    assert.equal(delivery.messageId, 'msg-oauth-1');
    assert.ok(delivery.targets.some((t) => t.deviceId === fx.deviceA && t.state === 'stored'));
    assert.ok(delivery.targets.some((t) => t.deviceId === fx.deviceB && t.state === 'pending'));
  } finally {
    fx.close();
  }
});

test('internal Bot actor scope isolation, DM privacy, and bounded history pagination/truncation', async () => {
  const fx = createFixture();
  try {
    const oauthActor = { kind: 'oauth', clientId: 'mcp-owner-1' };
    const botA1Actor = { kind: 'bot', deviceId: fx.deviceA, botId: fx.botA1.botId };
    const botA3Actor = { kind: 'bot', deviceId: fx.deviceA, botId: fx.botA3.botId };

    // Private DM between A1 and A2 (A3 is NOT a member)
    const privateDm = fx.logA.createScope({
      requestId: 'req-priv-dm',
      kind: 'dm',
      members: [
        { deviceId: fx.deviceA, botId: fx.botA1.botId },
        { deviceId: fx.deviceA, botId: fx.botA2.botId },
      ],
    });
    // Room between A1 and A2 (A3 is NOT a member)
    const room = await fx.handlers.collaboration_create_room(
      {
        deviceId: fx.deviceA,
        title: 'A1-A2 Room',
        members: [
          { deviceId: fx.deviceA, botId: fx.botA1.botId },
          { deviceId: fx.deviceA, botId: fx.botA2.botId },
        ],
      },
      oauthActor,
    );

    // Publish 16 large messages (> 50 KiB total even after 4096-unit preview truncation)
    // with a surrogate pair straddling the exact 4096 UTF-16 code-unit boundary.
    const expectedPrefixLen = '[Owner-delegated via OAuth: mcp-owner-1]\n'.length;
    for (let i = 1; i <= 16; i += 1) {
      const tag = `item-${String(i).padStart(2, '0')} `;
      const padLen = 4095 - expectedPrefixLen - tag.length;
      await fx.handlers.collaboration_publish_room_message(
        {
          deviceId: fx.deviceA,
          scopeId: room.scope.scopeId,
          messageId: `msg-big-${i}`,
          text: `${tag}${'A'.repeat(padLen)}😀${'Z'.repeat(500)}`,
        },
        oauthActor,
      );
    }

    // list_scopes for Bot A3 excludes A1-A2 private DM, keeps room visible for management
    const listForA3 = await fx.handlers.collaboration_list_scopes({ deviceId: fx.deviceA }, botA3Actor);
    assert.ok(!listForA3.items.some((s) => s.scope.scopeId === privateDm.scope.scopeId));
    assert.ok(listForA3.items.some((s) => s.scope.scopeId === room.scope.scopeId));
    assert.equal(listForA3.nextCursor, null);

    // Bot A3 cannot inspect private DM state, replicas, or work activity
    await assert.rejects(
      () => fx.handlers.collaboration_get_scope({ deviceId: fx.deviceA, scopeId: privateDm.scope.scopeId }, botA3Actor),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_list_scope_replicas(
          { deviceId: fx.deviceA, scopeId: privateDm.scope.scopeId },
          botA3Actor,
        ),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_get_work_activity(
          { deviceId: fx.deviceA, botId: fx.botA1.botId, scopeId: privateDm.scope.scopeId },
          botA3Actor,
        ),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );

    // Bot A3 cannot read messages/history/delivery of a room it is NOT a member of
    await assert.rejects(
      () =>
        fx.handlers.collaboration_list_scope_history(
          { deviceId: fx.deviceA, scopeId: room.scope.scopeId },
          botA3Actor,
        ),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_get_scope_message(
          { deviceId: fx.deviceA, scopeId: room.scope.scopeId, messageId: 'msg-big-1' },
          botA3Actor,
        ),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_get_scope_message_delivery(
          { deviceId: fx.deviceA, scopeId: room.scope.scopeId, messageId: 'msg-big-1' },
          botA3Actor,
        ),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );

    // Limit > 50 is rejected (never unbounded history)
    await assert.rejects(
      () =>
        fx.handlers.collaboration_list_scope_history(
          { deviceId: fx.deviceA, scopeId: room.scope.scopeId, limit: 51 },
          botA1Actor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    // Member Bot A1 gets bounded page <= 50 KiB with surrogate-safe text truncation and valid nextCursor
    const page1 = await fx.handlers.collaboration_list_scope_history(
      { deviceId: fx.deviceA, scopeId: room.scope.scopeId, limit: 20, order: 'ascending' },
      botA1Actor,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(page1), 'utf8') <= 50 * 1024);
    assert.equal(page1.truncatedBySize, true);
    assert.ok(page1.items.length > 0 && page1.items.length < 16);
    assert.ok(page1.nextCursor !== null);
    for (const item of page1.items) {
      assert.equal(item.textTruncated, true);
      assert.equal(item.message.text.length, 4095, 'must step back 1 unit rather than split surrogate pair');
      assert.equal(item.message.text.isWellFormed(), true, 'truncation must not split surrogate pairs');
    }

    // Continuation cursor fetches remaining messages cleanly
    const page2 = await fx.handlers.collaboration_list_scope_history(
      {
        deviceId: fx.deviceA,
        scopeId: room.scope.scopeId,
        limit: 20,
        order: 'ascending',
        cursor: page1.nextCursor,
      },
      botA1Actor,
    );
    assert.ok(page2.items.length > 0);
    assert.equal(page2.items[0].localId, page1.items[page1.items.length - 1].localId + 1);
  } finally {
    fx.close();
  }
});

test('session queue/edit controls and work stop/resume preserve Host checks and actor boundaries', async () => {
  const fx = createFixture();
  try {
    const oauthActor = { kind: 'oauth', clientId: 'mcp-owner-1' };
    const botA1Actor = { kind: 'bot', deviceId: fx.deviceA, botId: fx.botA1.botId };
    const botA3Actor = { kind: 'bot', deviceId: fx.deviceA, botId: fx.botA3.botId };

    const validSha = 'a'.repeat(64);
    const room = await fx.handlers.collaboration_create_room(
      {
        deviceId: fx.deviceA,
        members: [
          { deviceId: fx.deviceA, botId: fx.botA1.botId },
          { deviceId: fx.deviceA, botId: fx.botA2.botId },
        ],
      },
      oauthActor,
    );
    const privateDm = fx.logA.createScope({
      requestId: 'req-dm-work',
      kind: 'dm',
      members: [
        { deviceId: fx.deviceA, botId: fx.botA1.botId },
        { deviceId: fx.deviceA, botId: fx.botA2.botId },
      ],
    });

    // Primary user session controls are OAuth-only (Bots cannot withdraw/steer/edit user messages)
    await assert.rejects(
      () => fx.handlers.collaboration_withdraw_queued({ deviceId: fx.deviceA, botId: fx.botA2.botId }, botA1Actor),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_steer_queued(
          { deviceId: fx.deviceA, botId: fx.botA2.botId, requestId: 'q-1' },
          botA1Actor,
        ),
      (err) => err?.code === 'FORBIDDEN',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_edit_message(
          { deviceId: fx.deviceA, botId: fx.botA2.botId, entryId: 1, text: 'forged user text' },
          botA1Actor,
        ),
      (err) => err?.code === 'FORBIDDEN',
    );

    // edit_message rejects arbitrary file-path attachments, accepts canonical 64-hex attachment IDs
    await assert.rejects(
      () =>
        fx.handlers.collaboration_edit_message(
          {
            deviceId: fx.deviceA,
            botId: fx.botA1.botId,
            entryId: 3,
            text: 'updated',
            attachments: ['/etc/passwd'],
          },
          oauthActor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );

    const edited = await fx.handlers.collaboration_edit_message(
      {
        deviceId: fx.deviceA,
        botId: fx.botA1.botId,
        entryId: 3,
        text: 'updated',
        attachments: [validSha],
        requestId: 'edit-req-1',
      },
      oauthActor,
    );
    assert.equal(edited.entryId, 3);
    assert.equal(edited.requestId, 'edit-req-1');
    assert.equal(edited.status, 'queued');

    // Host RUNTIME_BUSY error on editMessage is preserved without masking
    fx.customOverrides.set('editMessage', () => {
      throw messageError('RUNTIME_BUSY', 'bot has active or queued work');
    });
    await assert.rejects(
      () =>
        fx.handlers.collaboration_edit_message(
          { deviceId: fx.deviceA, botId: fx.botA1.botId, entryId: 3, text: 'busy edit' },
          oauthActor,
        ),
      (err) => err?.code === 'RUNTIME_BUSY',
    );
    fx.customOverrides.delete('editMessage');

    // withdraw_queued and steer_queued work for OAuth
    const withdrawn = await fx.handlers.collaboration_withdraw_queued(
      { deviceId: fx.deviceA, botId: fx.botA1.botId, requestId: 'q-9' },
      oauthActor,
    );
    assert.equal(withdrawn.botId, fx.botA1.botId);
    assert.equal(withdrawn.withdrawn.length, 1);

    const steered = await fx.handlers.collaboration_steer_queued(
      { deviceId: fx.deviceA, botId: fx.botA1.botId, requestId: 'q-10' },
      oauthActor,
    );
    assert.equal(steered.status, 'steered');

    // stop_work rejects Bot self-stop mid-turn and non-member DM access, allows room management
    await assert.rejects(
      () =>
        fx.handlers.collaboration_stop_work(
          { deviceId: fx.deviceA, botId: fx.botA1.botId, scopeId: room.scope.scopeId },
          botA1Actor,
        ),
      (err) => err?.code === 'INVALID_ARGUMENT',
    );
    await assert.rejects(
      () =>
        fx.handlers.collaboration_stop_work(
          { deviceId: fx.deviceA, botId: fx.botA1.botId, scopeId: privateDm.scope.scopeId },
          botA3Actor,
        ),
      (err) => err?.code === 'SCOPE_FORBIDDEN',
    );

    const stopped = await fx.handlers.collaboration_stop_work(
      { deviceId: fx.deviceA, botId: fx.botA1.botId, scopeId: room.scope.scopeId },
      botA3Actor,
    );
    assert.equal(stopped.stopped, true);

    const resumed = await fx.handlers.collaboration_resume_work(
      { deviceId: fx.deviceA, botId: fx.botA1.botId, scopeId: room.scope.scopeId },
      botA3Actor,
    );
    assert.equal(resumed.stopped, false);
  } finally {
    fx.close();
  }
});
