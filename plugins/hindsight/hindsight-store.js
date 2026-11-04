// 模块 13 Hindsight → Pi Durable 适配存储：hindsight.sqlite 只做适配状态跟踪/outbox/
// 请求幂等/纠正审计，不是事实检索数据库。schema user_version=2，6 张表：
// identity/contexts/runs/outbox/requests/corrections。
// 生命周期与身份检查沿用 message-store.js/store.js 模式：原子初始化、无 reset/drop、
// 身份绑定（deviceId + endpointHash）校验。v1→v2 只追加 runs.floor_entry_id 默认 0 列，
// 既有 run 保持原身份与原 0 下限（不回填、不重写）。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 2;
const DB_FILE = 'hindsight.sqlite';

function storeError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// 有意保留的稳定错误码直接透传；其余 SQLite/损坏 JSON 等内部错误在导出边界包成 STORE_FAILED。
const KEEP_CODES = new Set([
  'REQUEST_CONFLICT',
  'UNSUPPORTED_SCHEMA',
  'HINDSIGHT_BINDING_MISMATCH',
  'HINDSIGHT_STORE_FAILED',
]);

const REQUIRED_TABLES = ['identity', 'contexts', 'runs', 'outbox', 'requests', 'corrections'];
const REQUIRED_COLUMNS = {
  identity: ['id', 'device_id', 'endpoint_hash', 'epoch'],
  contexts: ['key', 'bot_id', 'target_json', 'bank_id', 'last_entry_id', 'cache', 'last_recall', 'last_error_code'],
  runs: ['submission_id', 'context_key', 'native_id', 'request_id', 'entry_id', 'cutoff', 'state', 'floor_entry_id'],
  outbox: ['operation_id', 'document_id', 'context_key', 'fingerprint', 'payload_json', 'source_json', 'state', 'attempts', 'next_attempt_at', 'last_error_code', 'created_at', 'updated_at'],
  requests: ['request_key', 'kind', 'fingerprint', 'result_json'],
  corrections: ['request_key', 'context_key', 'receipt_json', 'before_json', 'patch_json', 'after_json'],
};
// v1 清单：迁移前先校验能识别的旧结构，缺少基础列则拒绝，不先改表。
const V1_COLUMNS = {
  ...REQUIRED_COLUMNS,
  runs: ['submission_id', 'context_key', 'native_id', 'request_id', 'entry_id', 'cutoff', 'state'],
};

function parseJson(text) {
  return text == null ? null : JSON.parse(text);
}

const SCHEMA_SQL = `
  CREATE TABLE identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL,
    endpoint_hash TEXT NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE contexts (
    key TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    target_json TEXT NOT NULL,
    bank_id TEXT NOT NULL,
    last_entry_id INTEGER NOT NULL DEFAULT 0,
    cache TEXT,
    last_recall TEXT,
    last_error_code TEXT
  );
  CREATE TABLE runs (
    submission_id INTEGER PRIMARY KEY,
    context_key TEXT NOT NULL REFERENCES contexts(key),
    native_id INTEGER NOT NULL,
    request_id TEXT NOT NULL,
    entry_id INTEGER NOT NULL,
    cutoff INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'collected', 'unanswered')),
    floor_entry_id INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE outbox (
    operation_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL UNIQUE,
    context_key TEXT NOT NULL REFERENCES contexts(key),
    fingerprint TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    source_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'completed', 'failed')),
    attempts INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE requests (
    request_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('retain', 'correct')),
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL
  );
  CREATE TABLE corrections (
    request_key TEXT PRIMARY KEY REFERENCES requests(request_key),
    context_key TEXT NOT NULL REFERENCES contexts(key),
    receipt_json TEXT NOT NULL,
    before_json TEXT,
    patch_json TEXT NOT NULL,
    after_json TEXT
  );
  CREATE INDEX idx_hindsight_runs_pending ON runs(state, submission_id);
  CREATE INDEX idx_hindsight_runs_context_pending ON runs(context_key, state, submission_id);
  CREATE INDEX idx_hindsight_outbox_due ON outbox(state, next_attempt_at);
  CREATE INDEX idx_hindsight_outbox_context ON outbox(context_key, document_id);
  CREATE INDEX idx_hindsight_corrections_context ON corrections(context_key);
`;

// 版本非 0/1/2（含负数）一律拒绝；v1/v2 先校验表与关键列清单再做未确认纠正转换，
// 避免先改审计后才发现缺列/缺表。
function assertInventory(db, columns = REQUIRED_COLUMNS) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
  );
  if (tables.size !== REQUIRED_TABLES.length) {
    throw storeError('UNSUPPORTED_SCHEMA', 'hindsight database contains unrecognized tables');
  }
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) {
      throw storeError('UNSUPPORTED_SCHEMA', 'hindsight database is missing required table: ' + table);
    }
  }
  for (const [table, required] of Object.entries(columns)) {
    const actual = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((r) => r.name));
    for (const column of required) {
      if (!actual.has(column)) {
        throw storeError('UNSUPPORTED_SCHEMA', 'hindsight database is missing column: ' + table + '.' + column);
      }
    }
  }
}

function initSchema(db, deviceId, endpointHash) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) {
      throw storeError('UNSUPPORTED_SCHEMA', 'hindsight database schema version is not supported');
    }
    if (version === 0) {
      const existingTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      ).all();
      if (existingTables.length > 0) {
        throw storeError('UNSUPPORTED_SCHEMA', 'hindsight database file already contains unrecognized tables');
      }
      db.exec(SCHEMA_SQL);
      db.prepare('INSERT INTO identity (id, device_id, endpoint_hash, epoch) VALUES (1, ?, ?, 0)').run(
        deviceId,
        endpointHash
      );
      db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    } else {
      assertInventory(db, version === 1 ? V1_COLUMNS : REQUIRED_COLUMNS);
      const row = db.prepare('SELECT device_id, endpoint_hash FROM identity WHERE id = 1').get();
      if (!row) {
        throw storeError('UNSUPPORTED_SCHEMA', 'hindsight database is missing identity row');
      }
      if (row.device_id !== deviceId) {
        throw storeError('REQUEST_CONFLICT', 'hindsight database owner deviceId does not match host deviceId');
      }
      if (row.endpoint_hash !== endpointHash) {
        throw storeError('HINDSIGHT_BINDING_MISMATCH', 'hindsight database is bound to a different endpoint');
      }
      // 打开时把遗留 pending 纠正转为 unconfirmed：保留审计，绝不自动重发不确定 PATCH。
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE corrections
            SET receipt_json = json_set(receipt_json, '$.state', 'unconfirmed', '$.outcome', 'unconfirmed', '$.updatedAt', ?)
          WHERE json_extract(receipt_json, '$.state') = 'pending'`
      ).run(now);
      if (version === 1) {
        // 只追加列，既有 run 保持原身份与 0 下限；不重写、不删除任何行。
        db.exec('ALTER TABLE runs ADD COLUMN floor_entry_id INTEGER NOT NULL DEFAULT 0');
        db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
      }
    }
    db.exec('COMMIT');
    committed = true;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
    }
  }
}

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    const result = fn();
    db.exec('COMMIT');
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* rollback 失败不掩盖原错误 */ }
    }
  }
}

export function openHindsightStore({ dataRoot, deviceId, endpointHash }) {
  mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(join(dataRoot, DB_FILE));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  try {
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    initSchema(db, deviceId, endpointHash);

    const stmtGetContext = db.prepare('SELECT * FROM contexts WHERE key = ?');
    const stmtInsertContext = db.prepare(
      'INSERT INTO contexts (key, bot_id, target_json, bank_id) VALUES (?, ?, ?, ?)'
    );
    const stmtAdvanceLastEntry = db.prepare(
      'UPDATE contexts SET last_entry_id = MAX(last_entry_id, ?) WHERE key = ?'
    );
    const stmtGetRun = db.prepare('SELECT * FROM runs WHERE submission_id = ?');
    const stmtInsertRun = db.prepare(
      `INSERT INTO runs (submission_id, context_key, native_id, request_id, entry_id, cutoff, state, floor_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    const stmtUpdateRunCutoff = db.prepare('UPDATE runs SET cutoff = ? WHERE submission_id = ?');
    const stmtSetRunState = db.prepare('UPDATE runs SET state = ? WHERE submission_id = ?');
    // 每个 context 只返回最老 pending run：避免后写入 run 越过旧冻结视图未完成页推进共享水位。
    const stmtPendingRuns = db.prepare(
      `SELECT r.* FROM runs r
         WHERE r.state = 'pending' AND r.submission_id > ?
           AND NOT EXISTS (
             SELECT 1 FROM runs o
              WHERE o.context_key = r.context_key AND o.state = 'pending' AND o.submission_id < r.submission_id
           )
         ORDER BY r.submission_id ASC LIMIT ?`
    );
    const stmtGetOutboxByOp = db.prepare('SELECT * FROM outbox WHERE operation_id = ?');
    const stmtGetOutboxByDoc = db.prepare('SELECT * FROM outbox WHERE document_id = ?');
    const stmtInsertOutbox = db.prepare(
      `INSERT INTO outbox (operation_id, document_id, context_key, fingerprint, payload_json, source_json,
                          state, attempts, next_attempt_at, last_error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?)`
    );
    const stmtUpdateOutbox = db.prepare(
      `UPDATE outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
        WHERE operation_id = ?`
    );
    const stmtDueJobs = db.prepare(
      `SELECT * FROM outbox WHERE state <> 'completed' AND next_attempt_at <= ? ORDER BY next_attempt_at ASC, operation_id ASC LIMIT ?`
    );
    // 按 Bot 过滤的同一查询：暂停 Bot 的到期行在 SQL 内就先排除，不再占用 LIMIT 窗口。
    // 占位符数量随可写 Bot 数变化，按数量缓存 prepared statement。
    const stmtDueJobsByBot = new Map();
    const dueJobsStmtFor = (count) => {
      let stmt = stmtDueJobsByBot.get(count);
      if (!stmt) {
        const placeholders = new Array(count).fill('?').join(', ');
        stmt = db.prepare(
          `SELECT o.* FROM outbox o JOIN contexts c ON c.key = o.context_key
            WHERE o.state <> 'completed' AND o.next_attempt_at <= ? AND c.bot_id IN (${placeholders})
            ORDER BY o.next_attempt_at ASC, o.operation_id ASC LIMIT ?`
        );
        stmtDueJobsByBot.set(count, stmt);
      }
      return stmt;
    };
    const stmtGetRequest = db.prepare('SELECT * FROM requests WHERE request_key = ?');
    const stmtInsertRequest = db.prepare(
      'INSERT INTO requests (request_key, kind, fingerprint, result_json) VALUES (?, ?, ?, ?)'
    );
    const stmtGetCorrection = db.prepare('SELECT * FROM corrections WHERE request_key = ?');
    const stmtInsertCorrection = db.prepare(
      `INSERT INTO corrections (request_key, context_key, receipt_json, before_json, patch_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const stmtUpdateCorrection = db.prepare(
      'UPDATE corrections SET receipt_json = ?, before_json = ?, after_json = ? WHERE request_key = ?'
    );
    const stmtStatusCounts = db.prepare(
      'SELECT state, COUNT(*) AS n FROM outbox WHERE context_key = ? GROUP BY state'
    );
    const stmtLatestOutboxError = db.prepare(
      "SELECT last_error_code, updated_at FROM outbox WHERE context_key = ? AND state <> 'completed' AND last_error_code IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
    );
    const stmtListJobs = db.prepare(
      `SELECT * FROM outbox
        WHERE context_key = ? AND (? IS NULL OR state = ?) AND (? IS NULL OR operation_id > ?)
        ORDER BY operation_id ASC LIMIT ?`
    );
    const stmtGetEpoch = db.prepare('SELECT epoch FROM identity WHERE id = 1');
    const stmtBumpEpoch = db.prepare('UPDATE identity SET epoch = epoch + 1 WHERE id = 1');
    const stmtSaveRecall = db.prepare(
      'UPDATE contexts SET cache = ?, last_recall = ?, last_error_code = ? WHERE key = ?'
    );

    const rowToContext = (row) => ({
      key: row.key,
      botId: row.bot_id,
      target: parseJson(row.target_json),
      bankId: row.bank_id,
      lastEntryId: row.last_entry_id,
      cache: parseJson(row.cache),
      lastRecall: parseJson(row.last_recall),
      lastErrorCode: row.last_error_code,
    });

    // Context 必须携带契约 key；已存在则比较持久化所有权，不同则拒绝，绝不静默覆盖。
    const ensureContext = (ctx) => {
      const existing = stmtGetContext.get(ctx.key);
      if (existing) {
        if (
          existing.bot_id !== ctx.botId ||
          existing.target_json !== JSON.stringify(ctx.target) ||
          existing.bank_id !== ctx.bankId
        ) {
          throw storeError('REQUEST_CONFLICT', 'context key already bound to different ownership');
        }
        return rowToContext(existing);
      }
      stmtInsertContext.run(ctx.key, ctx.botId, JSON.stringify(ctx.target), ctx.bankId);
      return rowToContext(stmtGetContext.get(ctx.key));
    };

    const runToTracked = (row, contextRow) => {
      const target = parseJson(contextRow.target_json);
      return {
        submissionId: row.submission_id,
        nativeId: row.native_id,
        requestId: row.request_id,
        entryId: row.entry_id,
        cutoff: row.cutoff,
        floorEntryId: row.floor_entry_id ?? 0,
        kind: target.kind === 'scope' ? 'scope' : 'primary',
        contextKey: row.context_key,
        state: row.state,
        botId: contextRow.bot_id,
        target,
        bankId: contextRow.bank_id,
      };
    };

    const rowToJob = (row, contextRow) => {
      const target = parseJson(contextRow.target_json);
      return {
        documentId: row.document_id,
        fingerprint: row.fingerprint,
        payload: parseJson(row.payload_json),
        source: parseJson(row.source_json),
        operationId: row.operation_id,
        contextKey: row.context_key,
        botId: contextRow.bot_id,
        target,
        bankId: contextRow.bank_id,
        state: row.state,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        lastErrorCode: row.last_error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    };

    const jobReceipt = (job) => ({
      operationId: job.operationId,
      documentId: job.documentId,
      botId: job.botId,
      target: job.target,
      bankId: job.bankId,
      state: job.state,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastErrorCode: job.lastErrorCode,
    });

    const contextRowFor = (contextKey) => {
      const row = stmtGetContext.get(contextKey);
      if (!row) {
        throw storeError('HINDSIGHT_STORE_FAILED', 'context row missing in hindsight store');
      }
      return row;
    };

    const bumpEpochTx = () => {
      stmtBumpEpoch.run();
    };

    const getContext = (key) => {
      const row = stmtGetContext.get(key);
      return row ? rowToContext(row) : null;
    };

    const recordRuns = (ctx, runs) => {
      inTransaction(db, () => {
        const stored = ensureContext(ctx);
        for (const run of runs) {
          const existing = stmtGetRun.get(run.submissionId);
          if (existing) {
            // 运行身份不可变；仅同一输入的 cutoff 允许单调推进。
            if (
              existing.context_key !== stored.key ||
              existing.native_id !== run.nativeId ||
              existing.request_id !== run.requestId ||
              existing.entry_id !== run.entryId
            ) {
              throw storeError('REQUEST_CONFLICT', 'submission already tracked with different run identity');
            }
            if (typeof run.cutoff === 'number' && run.cutoff > existing.cutoff) {
              stmtUpdateRunCutoff.run(run.cutoff, run.submissionId);
            }
            continue;
          }
          stmtInsertRun.run(
            run.submissionId,
            stored.key,
            run.nativeId,
            run.requestId,
            run.entryId,
            run.cutoff,
            Number.isSafeInteger(run.floorEntryId) && run.floorEntryId > 0 ? run.floorEntryId : 0
          );
        }
      });
    };

    const pendingRuns = (afterId = 0, limit = 50) => {
      const rows = stmtPendingRuns.all(afterId, limit + 1);
      const page = rows.slice(0, limit);
      const items = page.map((row) => runToTracked(row, contextRowFor(row.context_key)));
      const nextCursor = rows.length > limit ? page[page.length - 1].submission_id : null;
      return { items, nextCursor };
    };

    const completeRun = (submissionId, { jobs = [], afterEntryId = 0, done = false, unanswered = false } = {}) => {
      inTransaction(db, () => {
        const row = stmtGetRun.get(submissionId);
        if (!row) {
          throw storeError('HINDSIGHT_STORE_FAILED', 'run not found');
        }
        if (row.state === 'collected') {
          return; // 重复 completed 调用为 no-op
        }
        if (unanswered === true) {
          stmtSetRunState.run('unanswered', submissionId);
          return;
        }
        const now = new Date().toISOString();
        const nextAttemptAt = Date.now();
        for (const job of jobs) {
          const existingDoc = stmtGetOutboxByDoc.get(job.documentId);
          if (existingDoc) {
            // 确定性 documentId 去重必须限定同一 context：定义或归属不一致则冲突。
            if (existingDoc.context_key !== row.context_key || existingDoc.fingerprint !== job.fingerprint) {
              throw storeError('REQUEST_CONFLICT', 'document already queued with a different definition or context');
            }
            continue;
          }
          stmtInsertOutbox.run(
            randomUUID(),
            job.documentId,
            row.context_key,
            job.fingerprint,
            JSON.stringify(job.payload),
            JSON.stringify(job.source),
            nextAttemptAt,
            now,
            now
          );
        }
        stmtAdvanceLastEntry.run(afterEntryId, row.context_key);
        if (done === true) {
          stmtSetRunState.run('collected', submissionId);
        }
      });
    };

    const enqueueManual = (ctx, { requestKey, fingerprint, jobs }) => {
      return inTransaction(db, () => {
        const stored = ensureContext(ctx);
        const existingReq = stmtGetRequest.get(requestKey);
        if (existingReq) {
          if (existingReq.kind !== 'retain' || existingReq.fingerprint !== fingerprint) {
            throw storeError('REQUEST_CONFLICT', 'request key already used with a different definition');
          }
          // 用原 operation_id 重建 receipt 并挂当前 outbox 状态/时间戳，绝不重新分配 job。
          const original = parseJson(existingReq.result_json);
          const jobs = original.jobs.map((job) => {
            const row = stmtGetOutboxByOp.get(job.operationId);
            if (!row) {
              throw storeError('HINDSIGHT_STORE_FAILED', 'request receipt references missing outbox operation');
            }
            return {
              operationId: row.operation_id,
              documentId: row.document_id,
              botId: stored.botId,
              target: stored.target,
              bankId: stored.bankId,
              state: row.state,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              lastErrorCode: row.last_error_code,
            };
          });
          return { botId: stored.botId, target: stored.target, bankId: stored.bankId, jobs };
        }
        const now = new Date().toISOString();
        const nextAttemptAt = Date.now();
        const receipts = [];
        for (const job of jobs) {
          const operationId = randomUUID();
          stmtInsertOutbox.run(
            operationId,
            job.documentId,
            stored.key,
            job.fingerprint,
            JSON.stringify(job.payload),
            JSON.stringify(job.source),
            nextAttemptAt,
            now,
            now
          );
          receipts.push({
            operationId,
            documentId: job.documentId,
            botId: stored.botId,
            target: stored.target,
            bankId: stored.bankId,
            state: 'pending',
            createdAt: now,
            updatedAt: now,
            lastErrorCode: null,
          });
        }
        const receipt = { botId: stored.botId, target: stored.target, bankId: stored.bankId, jobs: receipts };
        stmtInsertRequest.run(requestKey, 'retain', fingerprint, JSON.stringify(receipt));
        return receipt;
      });
    };

    // eligibleBotIds 省略 = 旧内部语义（不过滤）；[] = 无可写 Bot，直接返回 []。
    const dueJobs = (now, limit = 4, eligibleBotIds = undefined) => {
      if (eligibleBotIds === undefined) {
        return stmtDueJobs.all(now, limit).map((row) => rowToJob(row, contextRowFor(row.context_key)));
      }
      const botIds = [...new Set(eligibleBotIds)];
      if (botIds.length === 0) return [];
      return dueJobsStmtFor(botIds.length)
        .all(now, ...botIds, limit)
        .map((row) => rowToJob(row, contextRowFor(row.context_key)));
    };

    const setJob = (operationId, { state, attempts, nextAttemptAt, lastErrorCode }) => {
      inTransaction(db, () => {
        const row = stmtGetOutboxByOp.get(operationId);
        if (!row) {
          throw storeError('HINDSIGHT_STORE_FAILED', 'outbox operation not found');
        }
        // 已完成的 job 拒绝被过期异步更新回归；首次完成才 bump epoch 一次。
        if (row.state === 'completed' && state !== 'completed') {
          return;
        }
        const now = new Date().toISOString();
        stmtUpdateOutbox.run(state, attempts, nextAttemptAt, lastErrorCode, now, operationId);
        if (state === 'completed' && row.state !== 'completed') {
          bumpEpochTx();
        }
      });
    };

    const getJob = (contextKey, operationId) => {
      const row = stmtGetOutboxByOp.get(operationId);
      if (!row || row.context_key !== contextKey) {
        return null;
      }
      return rowToJob(row, contextRowFor(contextKey));
    };

    const getSource = (contextKey, documentId) => {
      const row = stmtGetOutboxByDoc.get(documentId);
      if (!row || row.context_key !== contextKey) {
        return null;
      }
      const job = rowToJob(row, contextRowFor(contextKey));
      return { source: job.source, receipt: jobReceipt(job) };
    };

    const status = (contextKey) => {
      const counts = { pending: 0, accepted: 0, completed: 0, failed: 0 };
      for (const row of stmtStatusCounts.all(contextKey)) {
        if (Object.prototype.hasOwnProperty.call(counts, row.state)) {
          counts[row.state] = row.n;
        }
      }
      const contextRow = stmtGetContext.get(contextKey);
      const lastRecall = contextRow && contextRow.last_recall != null ? parseJson(contextRow.last_recall) : null;
      // lastErrorCode 取较新的失败来源：未完成 outbox 的最新错误或 recall 错误。
      const errRow = stmtLatestOutboxError.get(contextKey);
      let lastErrorCode = null;
      if (errRow) {
        lastErrorCode = errRow.last_error_code;
        if (lastRecall && lastRecall.errorCode && lastRecall.at && lastRecall.at > errRow.updated_at) {
          lastErrorCode = lastRecall.errorCode;
        }
      } else if (lastRecall) {
        lastErrorCode = lastRecall.errorCode;
      }
      return {
        ...counts,
        lastErrorCode,
        lastRecall: lastRecall ? { at: lastRecall.at, outcome: lastRecall.outcome } : null,
      };
    };

    // keyset 分页：按 operation_id BINARY 升序，limit+1 探测；context 过滤必填。
    const listJobs = (contextKey, { state = null, afterOperationId = null, limit = 20 } = {}) => {
      const rows = stmtListJobs.all(contextKey, state, state, afterOperationId, afterOperationId, limit + 1);
      const page = rows.slice(0, limit);
      const items = page.map((row) => jobReceipt(rowToJob(row, contextRowFor(contextKey))));
      const nextAfterOperationId = rows.length > limit ? page[page.length - 1].operation_id : null;
      return { items, nextAfterOperationId };
    };

    const getEpoch = () => stmtGetEpoch.get().epoch;

    const bumpEpoch = () => {
      inTransaction(db, () => {
        bumpEpochTx();
      });
    };

    const saveRecall = (contextKey, { key, at, message, outcome, errorCode }) => {
      inTransaction(db, () => {
        contextRowFor(contextKey);
        stmtSaveRecall.run(
          JSON.stringify({ key, at, message }),
          JSON.stringify({ at: new Date(at).toISOString(), outcome, errorCode }),
          errorCode,
          contextKey
        );
      });
    };

    const beginCorrection = (ctx, { requestKey, fingerprint, requestId, memoryId, patch }) => {
      return inTransaction(db, () => {
        const stored = ensureContext(ctx);
        const existingReq = stmtGetRequest.get(requestKey);
        if (existingReq) {
          if (existingReq.kind !== 'correct' || existingReq.fingerprint !== fingerprint) {
            throw storeError('REQUEST_CONFLICT', 'request key already used with a different correction');
          }
          const corr = stmtGetCorrection.get(requestKey);
          if (!corr) {
            throw storeError('HINDSIGHT_STORE_FAILED', 'correction record missing for existing request');
          }
          return { created: false, receipt: parseJson(corr.receipt_json) };
        }
        const now = new Date().toISOString();
        const receipt = {
          requestId,
          botId: stored.botId,
          target: stored.target,
          bankId: stored.bankId,
          memoryId,
          state: 'pending',
          outcome: 'not-sent',
          createdAt: now,
          updatedAt: now,
          errorCode: null,
        };
        stmtInsertRequest.run(requestKey, 'correct', fingerprint, JSON.stringify(receipt));
        stmtInsertCorrection.run(requestKey, stored.key, JSON.stringify(receipt), null, JSON.stringify(patch), null);
        return { created: true, receipt };
      });
    };

    const finishCorrection = (requestKey, { state, outcome, errorCode, before, after }) => {
      return inTransaction(db, () => {
        const row = stmtGetCorrection.get(requestKey);
        if (!row) {
          throw storeError('HINDSIGHT_STORE_FAILED', 'correction not found');
        }
        const receipt = parseJson(row.receipt_json);
        const previousState = receipt.state;
        receipt.state = state;
        receipt.outcome = outcome;
        receipt.errorCode = errorCode;
        receipt.updatedAt = new Date().toISOString();
        stmtUpdateCorrection.run(
          JSON.stringify(receipt),
          before === undefined ? row.before_json : JSON.stringify(before),
          after === undefined ? row.after_json : JSON.stringify(after),
          requestKey
        );
        // 仅从非 applied 转入 applied 时 bump epoch；重复保存（如 PATCH 前 pending 审计）不 bump。
        if (state === 'applied' && previousState !== 'applied') {
          bumpEpochTx();
        }
        return receipt;
      });
    };

    // 导出边界：SQLite/损坏 JSON 等内部错误包成 STORE_FAILED 并保留 cause，
    // 有意抛出的稳定错误码直接透传。
    const guarded = (fn) => (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        if (err && typeof err.code === 'string' && KEEP_CODES.has(err.code)) {
          throw err;
        }
        const wrapped = storeError('HINDSIGHT_STORE_FAILED', 'hindsight store operation failed');
        wrapped.cause = err;
        throw wrapped;
      }
    };

    return {
      getContext: guarded(getContext),
      ensureContext: guarded(ensureContext),
      recordRuns: guarded(recordRuns),
      pendingRuns: guarded(pendingRuns),
      completeRun: guarded(completeRun),
      enqueueManual: guarded(enqueueManual),
      dueJobs: guarded(dueJobs),
      setJob: guarded(setJob),
      getJob: guarded(getJob),
      getSource: guarded(getSource),
      status: guarded(status),
      listJobs: guarded(listJobs),
      getEpoch: guarded(getEpoch),
      bumpEpoch: guarded(bumpEpoch),
      saveRecall: guarded(saveRecall),
      beginCorrection: guarded(beginCorrection),
      finishCorrection: guarded(finishCorrection),
      close,
    };
  } catch (err) {
    try { close(); } catch { /* close 失败不掩盖原错误 */ }
    if (err && typeof err.code === 'string' && KEEP_CODES.has(err.code)) {
      throw err;
    }
    const wrapped = storeError('HINDSIGHT_STORE_FAILED', 'hindsight store open failed');
    wrapped.cause = err;
    throw wrapped;
  }
}
