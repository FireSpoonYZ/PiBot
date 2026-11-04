import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../host-core/store.js';
import { collectBotDirectory } from '../../host-core/bot-directory.js';
import { openCenterStore } from '../../center-server/data/index.js';

test('host-core store v5 rebuilds legacy v4 database, preserves deviceId, and wipes old bots directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-host-v5-test-'));
  try {
    const dbPath = path.join(tmpDir, 'host.sqlite');
    const oldBotDir = path.join(tmpDir, 'bots', 'legacy_bot_1');
    fs.mkdirSync(oldBotDir, { recursive: true });
    fs.writeFileSync(path.join(oldBotDir, 'SOUL.md'), 'old soul');

    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE host_identity (id INTEGER PRIMARY KEY CHECK (id = 1), device_id TEXT NOT NULL);
      INSERT INTO host_identity (id, device_id) VALUES (1, 'dev_preserved_123');
      CREATE TABLE bots (bot_id TEXT PRIMARY KEY, role TEXT NOT NULL);
      INSERT INTO bots (bot_id, role) VALUES ('legacy_bot_1', 'OldBot');
      PRAGMA user_version = 4;
    `);
    legacyDb.close();

    const store = openStore(tmpDir);
    assert.equal(store.deviceId, 'dev_preserved_123');
    assert.deepEqual(store.listBots(), []);
    assert.equal(store.getPrimaryBotId(), null);
    assert.equal(fs.existsSync(oldBotDir), false);
    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('host-core store enforces primary bot invariants, archive/unarchive, delete, and activity recording', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-host-bots-test-'));
  try {
    const store = openStore(tmpDir);

    // First bot is automatically primary even without makePrimary
    const botA = store.createBot({
      requestId: 'req_1',
      role: 'Alpha',
      cwd: tmpDir,
      description: 'First bot',
    });
    assert.equal(botA.isPrimary, true);
    assert.equal(store.getPrimaryBotId(), botA.botId);

    // Second bot defaults to non-primary
    const botB = store.createBot({
      requestId: 'req_2',
      role: 'Beta',
      cwd: tmpDir,
    });
    assert.equal(botB.isPrimary, false);
    assert.equal(store.getPrimaryBotId(), botA.botId);

    // Third bot with makePrimary: true atomically switches primary
    const botC = store.createBot({
      requestId: 'req_3',
      role: 'Gamma',
      cwd: tmpDir,
      makePrimary: true,
    });
    assert.equal(botC.isPrimary, true);
    assert.equal(store.getPrimaryBotId(), botC.botId);
    assert.equal(store.getBot(botA.botId)?.isPrimary, false);

    // Primary bot cannot be archived or deleted
    assert.throws(
      () => store.archiveBot(botC.botId),
      (err) => err?.code === 'PRIMARY_BOT_PROTECTED',
    );
    assert.throws(
      () => store.deleteBot(botC.botId),
      (err) => err?.code === 'PRIMARY_BOT_PROTECTED',
    );

    // Switch primary to botA
    const switched = store.setPrimaryBot(botA.botId);
    assert.equal(switched.isPrimary, true);
    assert.equal(store.getBot(botC.botId)?.isPrimary, false);

    // Archive botB
    const archivedB = store.archiveBot(botB.botId);
    assert.ok(archivedB.archivedAt);

    // Archived bot cannot be set as primary
    assert.throws(
      () => store.setPrimaryBot(botB.botId),
      (err) => err?.code === 'BOT_ARCHIVED',
    );

    // 14-day expiry query finds archived bot when cutoff >= archivedAt
    const futureCutoff = new Date(Date.now() + 60_000).toISOString();
    const expired = store.listExpiredArchivedBots(futureCutoff);
    assert.deepEqual(expired.map((b) => b.botId), [botB.botId]);

    // Unarchive botB restores it
    const restoredB = store.unarchiveBot(botB.botId);
    assert.equal(restoredB.archivedAt, null);

    // Activity recording updates lastActivityAt & lastPreview
    const updatedA = store.recordBotActivity(botA.botId, {
      lastActivityAt: '2026-10-28T12:00:00.000Z',
      lastPreview: 'Latest reply from Alpha',
    });
    assert.equal(updatedA.lastActivityAt, '2026-10-28T12:00:00.000Z');
    assert.equal(updatedA.lastPreview, 'Latest reply from Alpha');

    // Permanent delete removes botB
    const deleted = store.deleteBot(botB.botId);
    assert.equal(deleted.deleted, true);
    assert.equal(store.getBot(botB.botId), null);

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('center-server data v2 tracks monotonic seq, bot_events changelog, and snapshot/diff sync', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-center-sync-test-'));
  try {
    const store = openCenterStore({
      dataRoot: tmpDir,
      encryptionKey: new Uint8Array(32).fill(7),
    });

    const initialSync = store.getBotSync({ epoch: null, sinceSeq: 0, devices: [] });
    assert.equal(initialSync.mode, 'snapshot');
    assert.equal(initialSync.seq, 0);
    assert.ok(initialSync.epoch);

    // First sync inserts two bots and increments seq
    const r1 = store.replaceDeviceBots('dev_win', [
      {
        deviceId: 'dev_win',
        botId: 'b1',
        name: 'MainWin',
        description: 'Primary on Win',
        isPrimary: true,
        createdAt: '2026-10-28T09:00:00.000Z',
        lastActivityAt: '2026-10-28T10:00:00.000Z',
        lastPreview: 'Hello from Win',
        archivedAt: null,
        deviceName: 'Windows Host',
        platform: 'win32',
      },
      {
        deviceId: 'dev_win',
        botId: 'b2',
        name: 'HelperWin',
        description: '',
        isPrimary: false,
        createdAt: '2026-10-28T09:30:00.000Z',
        lastActivityAt: null,
        lastPreview: null,
        archivedAt: null,
        deviceName: 'Windows Host',
        platform: 'win32',
      },
    ]);
    assert.equal(r1.seq, 2);

    // Identical sync does not advance seq
    const rNoop = store.replaceDeviceBots('dev_win', [
      {
        deviceId: 'dev_win',
        botId: 'b1',
        name: 'MainWin',
        description: 'Primary on Win',
        isPrimary: true,
        createdAt: '2026-10-28T09:00:00.000Z',
        lastActivityAt: '2026-10-28T10:00:00.000Z',
        lastPreview: 'Hello from Win',
        archivedAt: null,
        deviceName: 'Windows Host',
        platform: 'win32',
      },
      {
        deviceId: 'dev_win',
        botId: 'b2',
        name: 'HelperWin',
        description: '',
        isPrimary: false,
        createdAt: '2026-10-28T09:30:00.000Z',
        lastActivityAt: null,
        lastPreview: null,
        archivedAt: null,
        deviceName: 'Windows Host',
        platform: 'win32',
      },
    ]);
    assert.equal(rNoop.seq, 2);

    // Incremental diff since seq 1 returns only seq 2
    const diffSync = store.getBotSync({
      epoch: initialSync.epoch,
      sinceSeq: 1,
      devices: [{ deviceId: 'dev_win', displayName: 'Windows Host', platform: 'win32', online: true }],
    });
    assert.equal(diffSync.mode, 'diff');
    assert.equal(diffSync.seq, 2);
    assert.equal(diffSync.events.length, 1);
    assert.equal(diffSync.events[0].op, 'upsert');
    assert.equal(diffSync.events[0].botId, 'b2');

    // Deleting b2 emits delete event
    const rDel = store.replaceDeviceBots('dev_win', [
      {
        deviceId: 'dev_win',
        botId: 'b1',
        name: 'MainWin',
        description: 'Primary on Win',
        isPrimary: true,
        createdAt: '2026-10-28T09:00:00.000Z',
        lastActivityAt: '2026-10-28T11:00:00.000Z',
        lastPreview: 'Updated reply',
        archivedAt: null,
        deviceName: 'Windows Host',
        platform: 'win32',
      },
    ]);
    assert.equal(rDel.seq, 4);
    const diffSync2 = store.getBotSync({
      epoch: initialSync.epoch,
      sinceSeq: 2,
      devices: [{ deviceId: 'dev_win', displayName: 'Windows Host', platform: 'win32', online: false }],
    });
    assert.equal(diffSync2.mode, 'diff');
    assert.deepEqual(
      diffSync2.events.map((e) => [e.op, e.botId]),
      [
        ['upsert', 'b1'],
        ['delete', 'b2'],
      ],
    );

    // Offline device still appears in snapshot with online: false
    const offlineSnapshot = store.getBotSync({
      epoch: null,
      sinceSeq: 0,
      devices: [{ deviceId: 'dev_win', displayName: 'Windows Host', platform: 'win32', online: false }],
    });
    assert.equal(offlineSnapshot.mode, 'snapshot');
    assert.equal(offlineSnapshot.bots.length, 1);
    assert.equal(offlineSnapshot.bots[0].botId, 'b1');
    assert.equal(offlineSnapshot.bots[0].online, false);

    store.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('collectBotDirectory orders primary bots first, then by lastActivityAt ?? createdAt desc, then archived', async () => {
  const result = await collectBotDirectory({
    async listDevices() {
      return {
        items: [
          { deviceId: 'dev_1', displayName: 'Linux Box', platform: 'linux', online: true },
        ],
        nextCursor: null,
      };
    },
    async listBots() {
      return [
        {
          botId: 'bot_old_active',
          deviceId: 'dev_1',
          name: 'OldCreatedButJustReplied',
          isPrimary: false,
          createdAt: '2026-10-28T08:00:00.000Z',
          lastActivityAt: '2026-10-28T12:00:00.000Z',
          lastPreview: 'Fresh reply',
          archivedAt: null,
        },
        {
          botId: 'bot_new_idle',
          deviceId: 'dev_1',
          name: 'NewCreatedNoReply',
          isPrimary: false,
          createdAt: '2026-10-28T10:00:00.000Z',
          lastActivityAt: null,
          lastPreview: null,
          archivedAt: null,
        },
        {
          botId: 'bot_primary',
          deviceId: 'dev_1',
          name: 'MainLinux',
          isPrimary: true,
          createdAt: '2026-10-28T07:00:00.000Z',
          lastActivityAt: null,
          lastPreview: null,
          archivedAt: null,
        },
        {
          botId: 'bot_archived',
          deviceId: 'dev_1',
          name: 'ArchivedBot',
          isPrimary: false,
          createdAt: '2026-10-28T11:00:00.000Z',
          lastActivityAt: '2026-10-28T13:00:00.000Z',
          lastPreview: 'Archived reply',
          archivedAt: '2026-10-28T13:05:00.000Z',
        },
      ];
    },
  });

  assert.deepEqual(
    result.bots.map((b) => b.botId),
    ['bot_primary', 'bot_old_active', 'bot_new_idle', 'bot_archived'],
  );
  assert.equal(result.bots[0].isPrimary, true);
  assert.equal(result.bots[1].lastPreview, 'Fresh reply');
});
