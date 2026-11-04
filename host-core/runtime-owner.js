import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const OWNER_DB = 'runtime-owner.sqlite';
// SQLITE_BUSY (5) / SQLITE_LOCKED (6): another process owns the runtime now.
const BUSY_ERRCODES = new Set([5, 6]);

function runtimeBusy(message) {
  const err = new Error(message);
  err.code = 'RUNTIME_BUSY';
  return err;
}

function mapError(err) {
  if (BUSY_ERRCODES.has(err?.errcode) || err?.code === 'SQLITE_BUSY' || err?.code === 'SQLITE_LOCKED') {
    return runtimeBusy('runtime database is locked by another process');
  }
  return err;
}

/**
 * Acquire exclusive ownership of the runtime for this dataRoot. Holding a
 * BEGIN IMMEDIATE transaction on dataRoot/runtime-owner.sqlite blocks other
 * processes (busy_timeout=0, so contention fails fast); a crash releases the
 * lock via the OS file lock, so nothing needs stale/host cleanup.
 * Returns an idempotent release() that rolls back and closes the connection.
 */
export function acquireRuntimeOwner(dataRoot) {
  let db;
  try {
    db = new DatabaseSync(join(dataRoot, OWNER_DB));
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    try { db?.close(); } catch { /* close 失败不掩盖原错误 */ }
    throw mapError(err);
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  return () => {
    if (closed) return;
    try {
      db.exec('ROLLBACK');
    } finally {
      close();
    }
  };
}
