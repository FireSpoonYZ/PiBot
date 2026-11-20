import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../host-core/store.js';
import { collectBotDirectory } from '../../host-core/bot-directory.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { formatActionableDirectoryError, isRemoteBotOnline } from '../src/botOperations.ts';

test('host-core store v5 rejects legacy v4 database with UNSUPPORTED_SCHEMA and preserves existing host data', () => {
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

    assert.throws(
      () => openStore(tmpDir),
      (err) => err?.code === 'UNSUPPORTED_SCHEMA',
    );
    assert.equal(fs.existsSync(path.join(oldBotDir, 'SOUL.md')), true);
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
  let store;
  try {
    store = openCenterStore({
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
  } finally {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

for (const deletion of ['replaceDeviceBots', 'removeDeviceBot']) {
  test(`${deletion}: dispatch cancellation and Bot deletion share one atomic transaction`, () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-bot-delete-atomic-'));
    let store;
    let db;
    try {
      store = openCenterStore({ dataRoot, encryptionKey: new Uint8Array(32).fill(7) });
      const keeper = { deviceId: 'dev-a', botId: 'keeper', name: 'Keeper' };
      store.replaceDeviceBots('dev-a', [keeper, { deviceId: 'dev-a', botId: 'victim', name: 'Victim' }]);
      db = new DatabaseSync(path.join(dataRoot, 'center.sqlite'));
      const insert = db.prepare(`INSERT INTO task_dispatches
        (id, task_id, kind, device_id, bot_id, request_id, task_title, status, instruction,
         payload_json, created_at, expires_at, updated_at)
        VALUES (?, 'task-a', 'step', 'dev-a', ?, ?, 'task', ?, 'work', '{}', 1, 9999999999999, 1)`);
      for (const botId of ['victim', 'keeper']) {
        for (const status of ['pending', 'dispatching', 'queued', 'running', 'succeeded']) {
          const id = `${botId}-${status}`;
          insert.run(id, botId, id, status);
        }
      }
      db.prepare(`INSERT INTO google_rules
        (id, name, device_id, bot_id, account, source, event, enabled, config_json, instruction, created_at, updated_at)
        VALUES ('rule-victim', 'Rule', 'dev-a', 'victim', 'user@example.com', 'gmail', 'new_email', 1, '{}', 'handle',
          '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run();
      db.prepare(`INSERT INTO google_rule_events
        (id, rule_id, rule_name, device_id, bot_id, account, source, request_id, event_key, payload_digest,
         status, occurred_at, received_at, expires_at, updated_at, instruction, payload_json)
        VALUES ('gre-victim-pending', 'rule-victim', 'Rule', 'dev-a', 'victim', 'user@example.com', 'gmail',
          'req-gre-victim', 'evt-gre-victim', 'digest', 'pending',
          '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
          '2026-11-01T00:00:00.000Z', 'handle', '{}')`).run();
      const dispatches = (botId) => db.prepare(`SELECT id, status, cancel_requested, updated_at
        FROM task_dispatches WHERE bot_id = ? ORDER BY id`).all(botId)
        .map(row => [row.id, row.status, row.cancel_requested, row.updated_at]);
      const googleRuleEventStatus = () => db.prepare(`SELECT status, error_json FROM google_rule_events WHERE id = 'gre-victim-pending'`).get();
      const originalVictim = dispatches('victim');
      const originalKeeper = dispatches('keeper');
      const originalGoogleRuleEvent = googleRuleEventStatus();
      const originalBots = store.listDeviceBots('dev-a');
      const originalSeq = db.prepare('SELECT seq FROM sync_meta WHERE id = 1').get().seq;
      const originalRevision = db.prepare('SELECT config_revision FROM metadata WHERE id = 1').get().config_revision;

      // Fail after both dispatch updates and Google rule cancellation, while recording the directory event.
      // The outer deletion transaction (with nested savepoints) must undo the Bot removal and all cancellation writes.
      db.exec(`CREATE TRIGGER reject_bot_delete BEFORE INSERT ON bot_events
        WHEN NEW.op = 'delete' AND NEW.bot_id = 'victim'
        BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`);
      const remove = () => deletion === 'replaceDeviceBots'
        ? store.replaceDeviceBots('dev-a', [keeper]) : store.removeDeviceBot('dev-a', 'victim');
      assert.throws(remove, /injected deletion failure/);
      assert.deepEqual(store.listDeviceBots('dev-a'), originalBots);
      assert.deepEqual(dispatches('victim'), originalVictim);
      assert.deepEqual(dispatches('keeper'), originalKeeper);
      assert.deepEqual(googleRuleEventStatus(), originalGoogleRuleEvent);
      assert.equal(db.prepare('SELECT seq FROM sync_meta WHERE id = 1').get().seq, originalSeq);
      assert.equal(db.prepare('SELECT config_revision FROM metadata WHERE id = 1').get().config_revision, originalRevision);

      db.exec('DROP TRIGGER reject_bot_delete');
      remove();
      assert.deepEqual(store.listDeviceBots('dev-a').map(bot => bot.botId), ['keeper']);
      const statusFor = (botId, status) => db.prepare('SELECT status, cancel_requested FROM task_dispatches WHERE id = ?')
        .get(`${botId}-${status}`);
      assert.equal(statusFor('victim', 'pending').status, 'cancelled');
      for (const status of ['dispatching', 'queued', 'running']) {
        assert.equal(statusFor('victim', status).status, status);
        assert.equal(statusFor('victim', status).cancel_requested, 1);
      }
      assert.equal(statusFor('victim', 'succeeded').status, 'succeeded');
      assert.equal(statusFor('victim', 'succeeded').cancel_requested, 0);
      assert.equal(googleRuleEventStatus().status, 'cancelled');
      assert.deepEqual(dispatches('keeper'), originalKeeper);

      // The standalone entry retains its own transaction: failure in its second
      // update must also roll back the first (pending -> cancelled) update.
      db.exec(`CREATE TRIGGER reject_dispatch_cancel BEFORE UPDATE ON task_dispatches
        WHEN OLD.bot_id = 'keeper' AND OLD.status = 'running'
        BEGIN SELECT RAISE(ABORT, 'injected cancellation failure'); END`);
      assert.throws(() => store.cancelTaskDispatchesForBot('dev-a', 'keeper'), /injected cancellation failure/);
      assert.deepEqual(dispatches('keeper'), originalKeeper);
      db.exec('DROP TRIGGER reject_dispatch_cancel');
      store.cancelTaskDispatchesForBot('dev-a', 'keeper');
      assert.equal(statusFor('keeper', 'pending').status, 'cancelled');
      assert.equal(statusFor('keeper', 'running').cancel_requested, 1);
      assert.deepEqual(store.listDeviceBots('dev-a').map(bot => bot.botId), ['keeper']);
      assert.equal(store.cancelTaskDispatchesForBotInTransaction, undefined);
    } finally {
      db?.close();
      store?.close();
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
}

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

test('formatActionableDirectoryError suppresses peer offline/control-unavailable errors and names actionable peers', () => {
  const devices = [
    { deviceId: '384b8ea7-b7f5-4833-b6a7-9fe3c8f75005', displayName: 'Windows', online: true },
    { deviceId: '5630ba0c-0048-479f-8c22-649e71fc8a24', displayName: 'maco', online: true },
    { deviceId: 'c27deb86-5123-4f9c-8457-85f5b9759c77', displayName: 'Linux', online: true },
  ];

  assert.equal(
    formatActionableDirectoryError(
      [
        { deviceId: '384b8ea7-b7f5-4833-b6a7-9fe3c8f75005', code: 'CONTROL_UNAVAILABLE', message: 'Target host unavailable' },
        { deviceId: '5630ba0c-0048-479f-8c22-649e71fc8a24', code: 'OFFLINE', message: 'Remote target unavailable' },
        { deviceId: 'c27deb86-5123-4f9c-8457-85f5b9759c77', code: 'DISCONNECTED' },
      ],
      devices,
    ),
    '',
  );

  assert.equal(
    formatActionableDirectoryError(
      [
        { deviceId: '5630ba0c-0048-479f-8c22-649e71fc8a24', code: 'CONTROL_UNAVAILABLE', message: 'Target host unavailable' },
        { deviceId: '384b8ea7-b7f5-4833-b6a7-9fe3c8f75005', code: 'TIMEOUT', message: 'call timed out' },
      ],
      devices,
    ),
    'Windows: TIMEOUT: call timed out',
  );
});

test('isRemoteBotOnline requires both relay device online and bot online !== false', () => {
  assert.equal(isRemoteBotOnline({ remoteConnected: true, deviceOnline: true, botOnline: true }), true);
  assert.equal(isRemoteBotOnline({ remoteConnected: true, deviceOnline: true, botOnline: undefined }), true);
  // Relay link open (deviceOnline=true) while Host control failed (botOnline=false) must show offline
  assert.equal(isRemoteBotOnline({ remoteConnected: true, deviceOnline: true, botOnline: false }), false);
  assert.equal(isRemoteBotOnline({ remoteConnected: false, deviceOnline: true, botOnline: true }), false);
  assert.equal(isRemoteBotOnline({ remoteConnected: true, deviceOnline: false, botOnline: true }), false);
});
