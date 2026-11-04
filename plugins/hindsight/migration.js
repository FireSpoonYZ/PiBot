import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = 'hindsight.sqlite';
// Identifies the completed per-Bot v2 migration without changing the store schema.
const MIGRATION_ID = 0x484d5632;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function identity(db, deviceId, endpointHash) {
  if (db.prepare('PRAGMA user_version').get().user_version !== 2) {
    fail('UNSUPPORTED_SCHEMA', 'hindsight migration requires schema version 2');
  }
  const statement = db.prepare('SELECT device_id, endpoint_hash, epoch FROM identity WHERE id = 1');
  statement.setReadBigInts(true);
  const row = statement.get();
  if (!row) fail('UNSUPPORTED_SCHEMA', 'hindsight database is missing identity');
  if (row.device_id !== deviceId) fail('REQUEST_CONFLICT', 'hindsight database owner does not match device');
  if (row.endpoint_hash !== endpointHash) {
    fail('HINDSIGHT_BINDING_MISMATCH', 'hindsight database is bound to a different endpoint');
  }
  return row;
}

function rows(db, sql, ...params) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...params);
}

function insertRows(db, table, values) {
  if (values.length === 0) return;
  const columns = Object.keys(values[0]);
  const statement = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const row of values) statement.run(...columns.map((column) => row[column]));
}

// A retain receipt has no context key; its bank and every operation must agree with one context.
function retainOwner(request, contexts, operations) {
  let receipt;
  try { receipt = JSON.parse(request.result_json); } catch { return null; }
  if (!receipt || typeof receipt.botId !== 'string' || typeof receipt.bankId !== 'string' || !Array.isArray(receipt.jobs)) return null;
  const candidates = contexts.filter((context) => context.bot_id === receipt.botId && context.bank_id === receipt.bankId);
  if (candidates.length !== 1) return null;
  const context = candidates[0];
  let target;
  try { target = JSON.parse(context.target_json); } catch { return null; }
  if (JSON.stringify(target) !== JSON.stringify(receipt.target)) return null;
  for (const job of receipt.jobs) {
    const operation = operations.get(job?.operationId);
    if (!operation || operation.context_key !== context.key || operation.document_id !== job.documentId) return null;
  }
  return context.bot_id;
}

export async function migrateLegacyHindsight({ legacyDataRoot, dataDir, deviceId, botId, endpoint, initializeTarget }) {
  const sourcePath = resolve(legacyDataRoot, DB_FILE);
  const targetPath = resolve(dataDir, DB_FILE);
  if (sourcePath === targetPath) fail('REQUEST_CONFLICT', 'hindsight migration source and target must differ');
  if (!existsSync(sourcePath)) return { migrated: false, unassignedRequests: 0 };

  const endpointHash = createHash('sha256').update(new URL(endpoint).href.replace(/\/+$/, '')).digest('hex');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let tempDir;
  try {
    source.exec('BEGIN');
    const sourceIdentity = identity(source, deviceId, endpointHash);
    const contexts = rows(source, 'SELECT * FROM contexts');
    const allOutbox = rows(source, 'SELECT * FROM outbox');
    const operations = new Map(allOutbox.map((row) => [row.operation_id, row]));
    const contextOwners = new Map(contexts.map((row) => [row.key, row.bot_id]));
    const corrections = rows(source, 'SELECT * FROM corrections');
    const correctionByRequest = new Map(corrections.map((row) => [row.request_key, row]));
    const assignedRequests = [];
    let unassignedRequests = 0;
    for (const request of rows(source, 'SELECT * FROM requests')) {
      const correction = correctionByRequest.get(request.request_key);
      const owner = request.kind === 'correct'
        ? (correction ? contextOwners.get(correction.context_key) : null)
        : request.kind === 'retain' ? retainOwner(request, contexts, operations) : null;
      if (!owner) unassignedRequests++;
      else if (owner === botId) assignedRequests.push(request);
    }

    if (existsSync(targetPath)) {
      const target = new DatabaseSync(targetPath, { readOnly: true });
      try {
        identity(target, deviceId, endpointHash);
        if (target.prepare('PRAGMA application_id').get().application_id !== MIGRATION_ID ||
            target.prepare('SELECT 1 FROM contexts WHERE bot_id <> ? LIMIT 1').get(botId)) {
          fail('REQUEST_CONFLICT', 'existing hindsight target is not this completed migration');
        }
      } finally { target.close(); }
      return { migrated: false, unassignedRequests };
    }

    mkdirSync(dataDir, { recursive: true });
    tempDir = mkdtempSync(join(dataDir, '.hindsight-migration-'));
    await initializeTarget(tempDir);
    const target = new DatabaseSync(join(tempDir, DB_FILE));
    try {
      identity(target, deviceId, endpointHash);
      target.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
      try {
        target.prepare('UPDATE identity SET epoch = ? WHERE id = 1').run(sourceIdentity.epoch);
        insertRows(target, 'contexts', contexts.filter((row) => row.bot_id === botId));
        insertRows(target, 'runs', rows(source, 'SELECT * FROM runs').filter((row) => contextOwners.get(row.context_key) === botId));
        insertRows(target, 'outbox', allOutbox.filter((row) => contextOwners.get(row.context_key) === botId));
        insertRows(target, 'requests', assignedRequests);
        const requestKeys = new Set(assignedRequests.filter((row) => row.kind === 'correct').map((row) => row.request_key));
        insertRows(target, 'corrections', corrections.filter((row) => requestKeys.has(row.request_key)));
        target.exec(`PRAGMA application_id = ${MIGRATION_ID}; COMMIT`);
      } catch (error) {
        try { target.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
      }
      target.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE');
    } finally { target.close(); }
    // Host ownership and serialized activation exclude concurrent writers; Android disallows hard links.
    renameSync(join(tempDir, DB_FILE), targetPath);
    return { migrated: true, unassignedRequests };
  } finally {
    source.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
