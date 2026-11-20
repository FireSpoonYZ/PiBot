import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { patchPiDurable, PI_DURABLE_VERSION } from '../../host-core/patch-pi-durable.js';
// The SDK is pinned and installed in host-core, independently of the web dependencies.
import { BACKGROUND_CONTEXT as context } from '../../host-core/node_modules/@earendil-works/chord/dist/context/index.js';
import { createModels } from '../../host-core/node_modules/@earendil-works/pi-ai/dist/models.js';
import { Harness, createRegistry, defineDoc } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/index.js';
import { openNodeSqliteDatabase, openNodeSqliteStorage } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js';
import { SqliteStorage } from '../../host-core/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/storage.js';

const ownerless = { ownership: { kind: 'ownerless' } };

function fixturePath(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-bc-checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'durable.sqlite');
}

async function loadBillionContextState() {
  const stateUrl = new URL('../../plugins/billion-context/context-state.js', import.meta.url);
  try {
    return await import(stateUrl.href);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    // Standalone plugin deps (acp-kernel) are installed at package/deploy time, not in repo root.
    // Re-evaluate the real context-state.js module with a minimal acp-kernel initial-state stub.
    const stubUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(
      'export const createInitialState = () => ({ blocks: {}, turns: 0 });' +
      'export const createContentStore = () => ({ entries: {} });'
    );
    const source = readFileSync(stateUrl, 'utf8');
    const rewritten = source.replace(/from\s+['"]acp-kernel['"]/, `from ${JSON.stringify(stubUrl)}`);
    assert.notEqual(rewritten, source, 'expected context-state.js to import acp-kernel');
    return import('data:text/javascript;charset=utf-8,' + encodeURIComponent(rewritten));
  }
}

function observeSqliteDatabase(db, queries) {
  const wrapExecutor = (executor) => ({
    exec: (sql) => executor.exec(sql),
    run: (sql, ...params) => executor.run(sql, ...params),
    runCounted: (sql, ...params) => executor.runCounted(sql, ...params),
    get: (sql, ...params) => {
      queries.push({ method: 'get', sql, params });
      return executor.get(sql, ...params);
    },
    all: (sql, ...params) => {
      queries.push({ method: 'all', sql, params });
      return executor.all(sql, ...params);
    },
  });
  return {
    ...wrapExecutor(db),
    transaction: (callback) => db.transaction((tx) => callback(wrapExecutor(tx))),
    close: () => db.close(),
  };
}

function readRevisions(dbPath, docId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT seq, kind, version FROM document_revisions WHERE document_id = ? ORDER BY seq').all(docId);
  } finally {
    db.close();
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

function makeTurnPayload(turn) {
  return {
    state: { turn, blocks: turn >= 2 ? [`block-${turn}`] : [] },
    contentStore: { latestTurn: turn },
    prepared: {
      key: `turn-${turn}`,
      taskId: `task-${turn}`,
      cutoff: 100 + turn,
      headEntryId: null,
      contextWindow: 128000,
      tokenCount: (turn + 1) * 50,
      messages: Array.from({ length: turn + 1 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${turn} message ${index}`,
        timestamp: index,
      })),
    },
  };
}

test('legacy uncheckpointed host.bc-context cold-reads step-by-step without unbounded .all, preserves historical cutoffs, and checkpoints new writes', async (t) => {
  const { BC_KERNEL_VERSION, createContextState } = await loadBillionContextState();
  const ContextState = createContextState(defineDoc);
  assert.equal(ContextState.definition.kind, 'host.bc-context');
  assert.equal(ContextState.definition.version, 1);
  assert.equal(ContextState.definition.scope, 'conversation');
  assert.equal(ContextState.definition.history, 'rewindable');
  assert.equal(ContextState.definition.fork, 'asOf');
  assert.equal(ContextState.definition.initial().kernelVersion, BC_KERNEL_VERSION);
  assert.equal(ContextState.definition.initial().prepared, null);

  const LegacyContextState = defineDoc({ ...ContextState.definition, checkpointWhen: () => false });
  const dbPath = fixturePath(t);

  let conversationId;
  let legacyRecord;
  const entries = [];
  {
    const storage = await openNodeSqliteStorage(dbPath);
    const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
    try {
      conversationId = await harness.commit(async (tx) => {
        const { id } = await tx.createConversation(ownerless);
        const doc = await tx.doc(LegacyContextState, id);
        Object.assign(doc, makeTurnPayload(0));
        entries.push(await tx.appendEntry(id, { kind: 'fixture.turn', data: { turn: 0 } }));
        return id;
      }, context);

      for (let turn = 1; turn <= 4; turn++) {
        await harness.commit(async (tx) => {
          const doc = await tx.doc(LegacyContextState, conversationId);
          Object.assign(doc, makeTurnPayload(turn));
          entries.push(await tx.appendEntry(conversationId, { kind: 'fixture.turn', data: { turn } }));
        }, context);
      }

      legacyRecord = await storage.findDocument(
        { kind: ContextState.definition.kind, scope: { kind: 'conversation', conversationId } },
        'current',
        context
      );
      assert.ok(legacyRecord);
    } finally {
      await harness.close(context);
    }
  }

  const docId = legacyRecord.id;
  const legacyRevisions = readRevisions(dbPath, docId);
  assert.deepEqual(
    legacyRevisions.map((row) => row.kind),
    ['base', 'delta', 'delta', 'delta', 'delta']
  );
  const legacySeqs = legacyRevisions.map((row) => row.seq);

  const queries = [];
  const rawDb = await openNodeSqliteDatabase(dbPath);
  const storage = await SqliteStorage.open(observeSqliteDatabase(rawDb, queries));
  const harness = await Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
  try {
    // Cold read through Harness.snapshot (same read path as contextStatus).
    queries.length = 0;
    const coldSnapshot = await harness.snapshot(ContextState, conversationId, context);
    assert.deepEqual(coldSnapshot, { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(4) });

    const coldRevisionAll = queries.filter((q) => q.method === 'all' && q.sql.includes('document_revisions'));
    assert.equal(coldRevisionAll.length, 0, 'materializeDocument must not call unbounded .all() on document_revisions');
    const coldTailGets = queries.filter(
      (q) => q.method === 'get' && q.sql.includes('document_revisions') && q.sql.includes('seq > ?')
    );
    assert.equal(coldTailGets.length, 5);
    for (const [index, query] of coldTailGets.entries()) {
      assert.match(query.sql, /ORDER BY seq LIMIT 1/);
      assert.deepEqual(query.params, [docId, legacySeqs[index], Number.MAX_SAFE_INTEGER]);
    }

    const legacyCurrent = await storage.document(docId, 'current', context);
    assert.equal(legacyCurrent.deltasSinceBase, 4);
    assert.deepEqual(legacyCurrent.value, { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(4) });

    // Historical cutoffs and asOf fork stay intact without unbounded .all().
    queries.length = 0;
    for (let turn = 0; turn <= 4; turn++) {
      const historical = await storage.document(docId, legacySeqs[turn], context);
      assert.equal(historical.deltasSinceBase, turn);
      assert.deepEqual(historical.value, { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(turn) });
    }

    const forked = await harness.commit(
      (tx) => tx.forkConversation(conversationId, entries[2].id, ownerless),
      context
    );
    const forkedSnapshot = await harness.snapshot(ContextState, forked.id, context);
    assert.deepEqual(forkedSnapshot, { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(2) });
    assert.equal(
      queries.filter((q) => q.method === 'all' && q.sql.includes('document_revisions')).length,
      0
    );

    // Subsequent BC writes using the updated definition checkpoint on every real change.
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ContextState, conversationId);
      Object.assign(doc, makeTurnPayload(5));
    }, context);
    const afterTurn5 = await storage.document(docId, 'current', context);
    assert.equal(afterTurn5.deltasSinceBase, 0);
    assert.deepEqual(afterTurn5.record, legacyRecord);
    assert.deepEqual(afterTurn5.value, { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(5) });

    // A no-op retry read inside commit does not write a spurious checkpoint.
    const seqBeforeNoop = nextSequence(dbPath);
    const cachedKey = await harness.commit(async (tx) => {
      const doc = await tx.doc(ContextState, conversationId);
      return doc.prepared?.key;
    }, context);
    assert.equal(cachedKey, 'turn-5');
    assert.equal(nextSequence(dbPath), seqBeforeNoop);

    await harness.commit(async (tx) => {
      const doc = await tx.doc(ContextState, conversationId);
      Object.assign(doc, makeTurnPayload(6));
    }, context);
    const afterTurn6 = await storage.document(docId, 'current', context);
    assert.equal(afterTurn6.deltasSinceBase, 0);
    assert.deepEqual(afterTurn6.value, { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(6) });

    const finalRevisions = readRevisions(dbPath, docId);
    assert.deepEqual(
      finalRevisions.map((row) => row.kind),
      ['base', 'delta', 'delta', 'delta', 'delta', 'base', 'base']
    );

    // Historical cutoffs across both legacy delta tail and new checkpoints remain readable.
    const turn5Seq = finalRevisions[5].seq;
    assert.deepEqual(
      (await storage.document(docId, legacySeqs[0], context)).value,
      { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(0) }
    );
    assert.deepEqual(
      (await storage.document(docId, legacySeqs[2], context)).value,
      { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(2) }
    );
    assert.deepEqual(
      (await storage.document(docId, legacySeqs[4], context)).value,
      { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(4) }
    );
    const turn5Doc = await storage.document(docId, turn5Seq, context);
    assert.equal(turn5Doc.deltasSinceBase, 0);
    assert.deepEqual(turn5Doc.value, { kernelVersion: BC_KERNEL_VERSION, ...makeTurnPayload(5) });
    assert.equal(
      queries.filter((q) => q.method === 'all' && q.sql.includes('document_revisions')).length,
      0
    );
  } finally {
    await harness.close(context);
  }
});

test('patchPiDurable is version-guarded and idempotent on installed @earendil-works/pi-durable', (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pibot-patch-pi-durable-'));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const installedPkgDir = fileURLToPath(
    new URL('../../host-core/node_modules/@earendil-works/pi-durable', import.meta.url)
  );
  const tempNodeModules = join(tempRoot, 'node_modules');
  const tempPkgDir = join(tempNodeModules, '@earendil-works', 'pi-durable');
  for (const relPath of [
    'package.json',
    join('dist', 'harness', 'generation.js'),
    join('dist', 'harness', 'types.d.ts'),
    join('dist', 'storage', 'sqlite', 'storage.js'),
  ]) {
    const src = join(installedPkgDir, relPath);
    if (!existsSync(src)) continue;
    const dest = join(tempPkgDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }

  assert.deepEqual(patchPiDurable(tempNodeModules), {
    generationChanged: false,
    typesChanged: false,
    storageChanged: false,
  });

  const pkgPath = join(tempPkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.version, PI_DURABLE_VERSION);
  writeFileSync(pkgPath, JSON.stringify({ ...pkg, version: '9.9.9' }, null, 2), 'utf8');
  assert.throws(() => patchPiDurable(tempNodeModules), /Expected @earendil-works\/pi-durable@/);
});
