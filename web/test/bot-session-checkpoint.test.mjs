import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BotSessionState, BOT_SESSION_CHECKPOINT_INTERVAL, SCOPE_MESSAGE_KIND } from '../../host-core/bot-session-context.js';
import { migrateBotSessionCheckpoints } from '../../host-core/bot-session-checkpoint-migration.js';
import { createBotSessionRuntime } from '../../host-core/runtime-bot-session.js';
// The SDK is pinned and installed in host-core, independently of the web dependencies.
import { BACKGROUND_CONTEXT as context } from '../../host-core/node_modules/@earendil-works/chord/dist/context/index.js';
import { createModels } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/models.js';
import { Harness, createRegistry, defineDoc } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/index.js';
import { openNodeSqliteStorage } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js';

const originalTimestamp = '2026-01-01T00:00:00.000Z';
const ownerless = { ownership: { kind: 'ownerless' } };

function fixturePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-session-checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'durable.sqlite');
}

async function openFixture(dbPath) {
  const storage = await openNodeSqliteStorage(dbPath);
  try {
    const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
    return { harness, storage };
  } catch (error) {
    await storage.close(context);
    throw error;
  }
}

function nextSequence(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT next_seq FROM durable_metadata WHERE singleton = 1').get().next_seq;
  } finally {
    db.close();
  }
}

async function storedDocument(storage, token, conversationId) {
  const address = { kind: token.definition.kind, scope: { kind: 'conversation', conversationId } };
  const record = await storage.findDocument(address, 'current', context);
  return record && storage.document(record.id, 'current', context);
}

test('empty inbox polls leave fresh and persisted bot sessions untouched, and new messages still import', async (t) => {
  const dbPath = fixturePath(t);
  const { harness, storage } = await openFixture(dbPath);
  try {
    const conversation = await harness.commit((tx) => tx.createConversation(ownerless), context);
    const bot = { botId: 'fixture-bot', deviceId: 'fixture-device', primaryConversationId: 'fixture-primary' };
    let inbox = [];
    const sessions = createBotSessionRuntime({
      host: { deviceId: bot.deviceId, getBot: (botId) => botId === bot.botId ? bot : undefined },
      getHarness: () => harness,
      getMessageLog: () => ({
        inbox: (_botId, { cursor }) => ({
          items: inbox.filter((item) => item.localId > (cursor?.afterLocalId ?? 0)),
          nextCursor: null,
        }),
        getScope: () => ({ kind: 'room' }),
      }),
      getPrimary: () => conversation,
      context,
    });
    const resultIdentity = { nativeId: conversation.id, conversationId: bot.primaryConversationId };

    const beforeFreshPoll = nextSequence(dbPath);
    assert.deepEqual(await sessions.sync(bot.botId), { ...resultIdentity, lastImportedLocalId: 0, imported: 0 });
    assert.equal(nextSequence(dbPath), beforeFreshPoll);
    assert.equal(await storedDocument(storage, BotSessionState, conversation.id), undefined);

    await harness.commit(async (tx) => {
      const state = await tx.doc(BotSessionState, conversation.id);
      state.lastImportedLocalId = 3;
      state.importedCount = 1;
      state.updatedAt = originalTimestamp;
    }, context);
    const storedBeforePoll = await storedDocument(storage, BotSessionState, conversation.id);
    const beforePoll = nextSequence(dbPath);
    assert.deepEqual(await sessions.sync(bot.botId), { ...resultIdentity, lastImportedLocalId: 3, imported: 0 });
    assert.equal(nextSequence(dbPath), beforePoll);
    assert.deepEqual(await storedDocument(storage, BotSessionState, conversation.id), storedBeforePoll);

    const message = {
      messageId: 'fixture-message', scopeId: 'fixture-room', sourceDeviceId: 'fixture-peer',
      author: { kind: 'user' }, text: 'A real inbox message', createdAt: originalTimestamp,
    };
    inbox = [{ localId: 4, digest: 'fixture-digest', storedAt: originalTimestamp, message }];
    assert.deepEqual(await sessions.sync(bot.botId), { ...resultIdentity, lastImportedLocalId: 4, imported: 1 });
    const afterImport = await storedDocument(storage, BotSessionState, conversation.id);
    assert.equal(afterImport.value.importedCount, 2);
    assert.equal(afterImport.value.lastImportedLocalId, 4);
    assert.ok(Number.isFinite(Date.parse(afterImport.value.updatedAt)));
    assert.notEqual(afterImport.value.updatedAt, originalTimestamp);
    const { items } = await storage.scanEntries({ conversationId: conversation.id }, 10, undefined, context);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, SCOPE_MESSAGE_KIND);
    assert.equal(items[0].data.localId, 4);
    assert.deepEqual(items[0].data.message, message);

    const beforeRepeatedPoll = nextSequence(dbPath);
    assert.deepEqual(await sessions.sync(bot.botId), { ...resultIdentity, lastImportedLocalId: 4, imported: 0 });
    assert.equal(nextSequence(dbPath), beforeRepeatedPoll);
    assert.deepEqual(await storedDocument(storage, BotSessionState, conversation.id), afterImport);
  } finally {
    await harness.close(context);
  }
});

test('bot session checkpoints bound the persisted delta tail without changing the document identity', async (t) => {
  const { harness, storage } = await openFixture(fixturePath(t));
  try {
    const id = await harness.commit(async (tx) => {
      const { id } = await tx.createConversation(ownerless);
      (await tx.doc(BotSessionState, id)).updatedAt = originalTimestamp;
      return id;
    }, context);
    const update = (count) => harness.commit(async (tx) => {
      (await tx.doc(BotSessionState, id)).importedCount = count;
    }, context);
    const interval = BOT_SESSION_CHECKPOINT_INTERVAL;
    for (let count = 1; count < interval; count++) await update(count);
    const before = await storedDocument(storage, BotSessionState, id);
    assert.equal(before.deltasSinceBase, interval - 1);

    await update(interval);
    const checkpoint = await storedDocument(storage, BotSessionState, id);
    assert.equal(checkpoint.deltasSinceBase, 0);
    assert.deepEqual(checkpoint.record, before.record);
    assert.equal(checkpoint.version, before.version);
    assert.equal(checkpoint.value.importedCount, interval);
    assert.equal(checkpoint.value.updatedAt, originalTimestamp);

    await update(interval + 1);
    const next = await storedDocument(storage, BotSessionState, id);
    assert.equal(next.deltasSinceBase, 1);
    assert.equal(next.value.importedCount, interval + 1);
  } finally {
    await harness.close(context);
  }
});

const LegacyBotSessionState = defineDoc({ ...BotSessionState.definition, checkpointWhen: () => false });
const UnrelatedHistory = defineDoc({
  kind: 'fixture.rewindable', version: 1, scope: 'conversation', history: 'rewindable', fork: 'initial',
  initial: () => ({ count: 0 }), checkpointWhen: () => false,
});

test('startup migration compacts a legacy bot session in place and leaves other state and history intact', async (t) => {
  const dbPath = fixturePath(t);
  const { harness, storage } = await openFixture(dbPath);
  let ids, before;
  try {
    ids = await harness.commit(async (tx) => {
      const { id: legacy } = await tx.createConversation(ownerless);
      const { id: healthy } = await tx.createConversation(ownerless);
      const state = await tx.doc(LegacyBotSessionState, legacy);
      state.updatedAt = originalTimestamp;
      state.outgoing = { request: { messageId: 'persisted-message' } };
      state.completedTurns = { turn: { requestId: 'persisted-turn' } };
      (await tx.doc(LegacyBotSessionState, healthy)).updatedAt = originalTimestamp;
      (await tx.doc(UnrelatedHistory, legacy)).count = 0;
      const entry = await tx.appendEntry(legacy, { kind: 'fixture.entry', data: { text: 'Persisted history' } });
      return { legacy, healthy, entry: entry.id };
    }, context);
    for (let count = 1; count <= BOT_SESSION_CHECKPOINT_INTERVAL + 1; count++) {
      await harness.commit(async (tx) => {
        (await tx.doc(LegacyBotSessionState, ids.legacy)).lastImportedLocalId = count;
        (await tx.doc(UnrelatedHistory, ids.legacy)).count = count;
        if (count < BOT_SESSION_CHECKPOINT_INTERVAL) {
          (await tx.doc(LegacyBotSessionState, ids.healthy)).lastImportedLocalId = count;
        }
      }, context);
    }
    before = {
      legacy: await storedDocument(storage, LegacyBotSessionState, ids.legacy),
      healthy: await storedDocument(storage, LegacyBotSessionState, ids.healthy),
      unrelated: await storedDocument(storage, UnrelatedHistory, ids.legacy),
      conversation: await storage.conversation(ids.legacy, context),
      entry: await storage.entry(ids.entry, context),
    };
    assert.equal(before.legacy.deltasSinceBase, BOT_SESSION_CHECKPOINT_INTERVAL + 1);
    assert.equal(before.healthy.deltasSinceBase, BOT_SESSION_CHECKPOINT_INTERVAL - 1);
    assert.equal(before.unrelated.deltasSinceBase, before.legacy.deltasSinceBase);
  } finally {
    await harness.close(context);
  }

  const reopened = await openNodeSqliteStorage(dbPath);
  try {
    assert.equal(await migrateBotSessionCheckpoints(reopened, dbPath), 1);
    assert.deepEqual(await storedDocument(reopened, BotSessionState, ids.legacy), {
      ...before.legacy, deltasSinceBase: 0,
    });
    assert.deepEqual(await storedDocument(reopened, BotSessionState, ids.healthy), before.healthy);
    assert.deepEqual(await storedDocument(reopened, UnrelatedHistory, ids.legacy), before.unrelated);
    const historical = await reopened.document(before.unrelated.record.id, before.unrelated.record.createdAt, context);
    assert.deepEqual(historical.value, { count: 0 });
    assert.deepEqual(await reopened.conversation(ids.legacy, context), before.conversation);
    assert.deepEqual(await reopened.entry(ids.entry, context), before.entry);

    const beforeRetry = nextSequence(dbPath);
    assert.equal(await migrateBotSessionCheckpoints(reopened, dbPath), 0);
    assert.equal(nextSequence(dbPath), beforeRetry);
  } finally {
    await reopened.close(context);
  }
});
