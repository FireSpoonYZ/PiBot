import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HERMES_SKILL_TOOLS } from '../skills/hermes-tools.js';

const error = (code, message) => Object.assign(new Error(message), { code });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = (value) => JSON.stringify(value);
const parse = (row) => (row ? JSON.parse(row.json) : null);

// Upstream-pinned defaults (Hermes @ 71736c9, read statically):
//   agent/background_review.py: _REVIEW_MAX_ITERATIONS=16, _REVIEW_MAX_INPUT_TOKENS_CAP=600_000,
//     _REVIEW_INPUT_CONTEXT_FRACTION=0.75, _REVIEW_MAX_INPUT_TOKENS_FALLBACK=120_000.
//   agent/agent_init.py: memory nudge default 10 (config memory.nudge_interval; counted in USER
//     TURNS — agent/turn_context.py _tick_memory_nudge); skills nudge default 10 (config
//     skills.creation_nudge_interval; counted in TOOL ITERATIONS — turn_finalizer.py
//     _iters_since_skill >= _skill_nudge_interval).
//   agent/curator.py: DEFAULT_INTERVAL_HOURS=24*7, DEFAULT_MIN_IDLE_HOURS=2,
//     DEFAULT_STALE_AFTER_DAYS=14, DEFAULT_ARCHIVE_AFTER_DAYS=30, DEFAULT_CONSOLIDATE=False;
//     curator.enabled defaults ON; first observation seeds last_run_at and defers one interval;
//     manual 'hermes curator run' bypasses the idle/interval/paused gate.
// Transport budgets below are ours (upstream runs in-process threads without them).
const REVIEW_MAX_ITERATIONS = 16;
const REVIEW_INPUT_TOKENS_CAP = 600_000;
const REVIEW_INPUT_CONTEXT_FRACTION = 0.75;
const REVIEW_INPUT_TOKENS_FALLBACK = 120_000;
const DEFAULT_MEMORY_EVERY = 10; // user turns between automatic memory reviews
const DEFAULT_SKILL_EVERY = 10; // tool iterations between automatic skill reviews
const DEFAULT_CURATOR_INTERVAL_HOURS = 24 * 7;
const DEFAULT_CURATOR_MIN_IDLE_HOURS = 2;
const DEFAULT_STALE_AFTER_DAYS = 14;
const DEFAULT_ARCHIVE_AFTER_DAYS = 30;

const DEFAULT_CALL_TIMEOUT_MS = 900_000; // one agent.run / memory.call round trip, incl. Host-side model loop
const DEFAULT_JOB_TIMEOUT_MS = 1_800_000; // whole runHermes invocation
const DEFAULT_POLL_TIMEOUT_MS = 20_000; // contract: next long-poll must answer within 20s (Host client timeout 30s)
// Upstream waits 2.0s for a cancelled review to acknowledge before letting the live turn proceed;
// our equivalent bounds the Python child's shutdown before the job is finalized regardless.
const CANCEL_GRACE_MS = 5_000;
const MAX_CALL_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_STORED_RESULT_BYTES = 1024 * 1024;
const MAX_MESSAGE = 2_000;

// Methods the vendored Python may invoke via runHermes' onCall. Nothing else is answered.
const ONCALL_METHODS = new Set(['agent.run', 'skill.call', 'memory.call']);
// Tool names the Host may execute inside an outstanding agent.run (upstream dispatch-side
// whitelist: skills toolset + read-only file tools restricted to own skills; 'memory' is NOT
// routed here — the Host maps it to Hindsight internally).
const REVIEW_TOOL_NAMES = new Set(['skills_list', 'skill_view', 'skill_manage', 'read_file', 'search_files']);
// Review-scope origin for skills.hermes provenance, per job mode.
const MODE_ORIGIN = { review: 'background_review', learn: 'background_review', curate: 'curator' };
const MODES = new Set(Object.keys(MODE_ORIGIN));
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
// Snapshot/call fields the contract declares; anything else (e.g. credentials) never reaches
// Python or the Host — provider credentials are never uploaded.
const SNAPSHOT_KEYS = ['messages', 'model', 'provider', 'systemPrompt', 'sessionId', 'tools', 'memoryEnabled', 'span'];
const AGENT_RUN_KEYS = ['prompt', 'messages', 'tools', 'allowedTools', 'maxIterations', 'maxInputTokens', 'model', 'provider', 'reasoningConfig', 'sessionId'];
// Runtime credential field names stripped ONLY at the top level of a params object. Nested
// content (transcript messages, tool schemas, tool args) is request source data and must pass
// byte/semantics-identical — a recursive strip would silently delete business fields like a
// memory entry's 'token' without actually filtering secrets inside text.
const TOP_CREDENTIAL_KEYS = new Set(['apikey', 'api_key', 'accesstoken', 'access_token', 'authorization', 'credential', 'credentials', 'credentialref', 'token', 'secret', 'password']);

function assertId(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw error('INVALID_ARGUMENT', 'Invalid ' + name);
}
function assertBot(store, deviceId, botId) {
  const bot = store.listDeviceBots(deviceId).find((item) => item.botId === botId);
  if (!bot) throw error('NOT_FOUND', 'Bot not found');
  return bot;
}
function boundedJson(value, maxBytes, name) {
  const text = json(value);
  if (text === undefined || Buffer.byteLength(text, 'utf8') > maxBytes) throw error('INVALID_ARGUMENT', name + ' too large');
  return text;
}
function intIn(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw error('VALIDATION_FAILED', 'Invalid ' + name);
  return value;
}
function boolIn(value, name) {
  if (typeof value !== 'boolean') throw error('VALIDATION_FAILED', 'Invalid ' + name);
  return value;
}
// Deterministic serialization for request fingerprints: same submission content always hashes
      // identically regardless of caller-side key order.
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function sanitizedError(value) {
  if (!object(value)) return null;
  return {
    code: typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : 'INTERNAL_ERROR',
    message: typeof value.message === 'string' ? value.message.slice(0, MAX_MESSAGE) : '',
  };
}
// Top-level credential-field strip only; never rewrites nested request source data.
function stripTopCredentials(value) {
  if (!object(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (TOP_CREDENTIAL_KEYS.has(key.toLowerCase())) continue;
    out[key] = item;
  }
  return out;
}

function defaultSettings() {
  return {
    enabled: true,
    review: { memoryEvery: DEFAULT_MEMORY_EVERY, skillEvery: DEFAULT_SKILL_EVERY },
    curator: {
      enabled: true, intervalHours: DEFAULT_CURATOR_INTERVAL_HOURS, minIdleHours: DEFAULT_CURATOR_MIN_IDLE_HOURS,
      staleAfterDays: DEFAULT_STALE_AFTER_DAYS, archiveAfterDays: DEFAULT_ARCHIVE_AFTER_DAYS,
      consolidate: false, paused: false,
    },
    budget: { maxIterations: REVIEW_MAX_ITERATIONS, maxInputTokens: null, callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS, jobTimeoutMs: DEFAULT_JOB_TIMEOUT_MS, pollTimeoutMs: DEFAULT_POLL_TIMEOUT_MS },
  };
}
function defaultCounters() {
  return {
    turnsSinceMemoryReview: 0, itersSinceSkillReview: 0,
    lastAutomaticReviewAt: null, lastCuratorRunAt: null,
    jobsStarted: 0, jobsCompleted: 0, jobsFailed: 0, jobsCancelled: 0, jobsInterrupted: 0,
    lastJobId: null, lastJobStatus: null, lastJobFinishedAt: null, lastJobSummary: null,
  };
}

function validateSettingsPatch(current, patch) {
  const next = { ...current, review: { ...current.review }, curator: { ...current.curator }, budget: { ...current.budget } };
  for (const key of Object.keys(patch)) {
    if (!['enabled', 'review', 'curator', 'budget'].includes(key)) throw error('VALIDATION_FAILED', 'Unknown setting ' + key);
  }
  if (patch.enabled !== undefined) next.enabled = boolIn(patch.enabled, 'enabled');
  if (patch.review !== undefined) {
    const section = object(patch.review) ? patch.review : { invalid: true };
    for (const key of Object.keys(section)) {
      if (!['memoryEvery', 'skillEvery'].includes(key)) throw error('VALIDATION_FAILED', 'Unknown review setting ' + key);
      // 0 disables that automatic scope, matching the upstream 'interval > 0' gates.
      section[key] = intIn(section[key], 0, 10_000, 'review.' + key);
    }
    Object.assign(next.review, section);
  }
  if (patch.curator !== undefined) {
    const section = object(patch.curator) ? patch.curator : { invalid: true };
    for (const key of Object.keys(section)) {
      if (!['enabled', 'intervalHours', 'minIdleHours', 'staleAfterDays', 'archiveAfterDays', 'consolidate', 'paused'].includes(key)) {
        throw error('VALIDATION_FAILED', 'Unknown curator setting ' + key);
      }
    }
    if (section.enabled !== undefined) section.enabled = boolIn(section.enabled, 'curator.enabled');
    if (section.paused !== undefined) section.paused = boolIn(section.paused, 'curator.paused');
    if (section.consolidate !== undefined) section.consolidate = boolIn(section.consolidate, 'curator.consolidate');
    for (const key of ['intervalHours', 'staleAfterDays', 'archiveAfterDays']) {
      // Upstream floors day/hour counts at 1 (a value < 1 would fire every tick / mass-transition).
      if (section[key] !== undefined) section[key] = intIn(section[key], 1, 100_000, 'curator.' + key);
    }
    if (section.minIdleHours !== undefined) {
      if (typeof section.minIdleHours !== 'number' || !(section.minIdleHours >= 0) || section.minIdleHours > 10_000) {
        throw error('VALIDATION_FAILED', 'Invalid curator.minIdleHours');
      }
    }
    Object.assign(next.curator, section);
  }
  if (patch.budget !== undefined) {
    const section = object(patch.budget) ? patch.budget : { invalid: true };
    for (const key of Object.keys(section)) {
      if (!['maxIterations', 'maxInputTokens', 'callTimeoutMs', 'jobTimeoutMs', 'pollTimeoutMs'].includes(key)) {
        throw error('VALIDATION_FAILED', 'Unknown budget setting ' + key);
      }
    }
    if (section.maxIterations !== undefined) section.maxIterations = intIn(section.maxIterations, 1, 128, 'budget.maxIterations');
    if (section.maxInputTokens !== undefined) {
      section.maxInputTokens = section.maxInputTokens === null ? null : intIn(section.maxInputTokens, 1, 10_000_000, 'budget.maxInputTokens');
    }
    if (section.callTimeoutMs !== undefined) section.callTimeoutMs = intIn(section.callTimeoutMs, 1_000, 3_600_000, 'budget.callTimeoutMs');
    if (section.jobTimeoutMs !== undefined) section.jobTimeoutMs = intIn(section.jobTimeoutMs, 10_000, 14_400_000, 'budget.jobTimeoutMs');
    // Contract: the next long-poll must answer within 20s (Host client times out at 30s).
    if (section.pollTimeoutMs !== undefined) section.pollTimeoutMs = intIn(section.pollTimeoutMs, 1_000, 20_000, 'budget.pollTimeoutMs');
    Object.assign(next.budget, section);
  }
  return next;
}

/**
 * Learning service: per-Bot Hermes review/learn/curate jobs. Owns settings, automatic-trigger
 * counters, durable job summaries and the Host callback long-poll; the Python process (runHermes)
 * does the actual review loop, skill callbacks go to skills.hermes, and
 * agent.run/memory.call are driven by the initiating Host through next/respond.
 */
export async function openLearningService({ dataRoot, store, skills, runHermes }) {
  if (typeof dataRoot !== 'string') throw error('INVALID_ARGUMENT', 'dataRoot is required');
  if (!store || !skills || typeof skills.hermes !== 'function' || typeof runHermes !== 'function') {
    throw error('INVALID_ARGUMENT', 'store, skills and runHermes are required');
  }
  mkdirSync(dataRoot, { recursive: true });
  const db = new DatabaseSync(join(dataRoot, 'learning.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS learning_settings (' +
    '  device_id TEXT NOT NULL, bot_id TEXT NOT NULL, json TEXT NOT NULL, revision INTEGER NOT NULL,' +
    '  PRIMARY KEY(device_id, bot_id));' +
    'CREATE TABLE IF NOT EXISTS learning_counters (' +
    '  device_id TEXT NOT NULL, bot_id TEXT NOT NULL, json TEXT NOT NULL,' +
    '  PRIMARY KEY(device_id, bot_id));' +
    'CREATE TABLE IF NOT EXISTS learning_jobs (' +
    '  job_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, bot_id TEXT NOT NULL,' +
    '  request_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,' +
    '  json TEXT NOT NULL);' +
    'CREATE INDEX IF NOT EXISTS learning_jobs_bot ON learning_jobs(device_id, bot_id, created_at);' +
    'CREATE TABLE IF NOT EXISTS learning_submissions (' +
    '  device_id TEXT NOT NULL, bot_id TEXT NOT NULL, request_id TEXT NOT NULL,' +
    '  json TEXT NOT NULL, PRIMARY KEY(device_id, bot_id, request_id));' +
    'CREATE TABLE IF NOT EXISTS learning_calls (' +
    '  call_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL,' +
    '  method TEXT NOT NULL, params TEXT NOT NULL,' +
    '  answered INTEGER NOT NULL DEFAULT 0, answered_by TEXT, result TEXT, error TEXT,' +
    '  created_at TEXT NOT NULL, delivered_at TEXT, answered_at TEXT);' +
    'CREATE INDEX IF NOT EXISTS learning_calls_job ON learning_calls(job_id);' +
    'CREATE TABLE IF NOT EXISTS learning_tool_calls (' +
    '  job_id TEXT NOT NULL, call_id TEXT NOT NULL,' +
    '  name TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, response TEXT,' +
    '  created_at TEXT NOT NULL, PRIMARY KEY(job_id, call_id));'
  );
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* keep original error */ }
      throw err;
    }
  }

  const settingsStmt = {
    get: db.prepare('SELECT json, revision FROM learning_settings WHERE device_id = ? AND bot_id = ?'),
    put: db.prepare('INSERT INTO learning_settings VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id) DO UPDATE SET json = excluded.json, revision = excluded.revision'),
  };
  const countersStmt = {
    get: db.prepare('SELECT json FROM learning_counters WHERE device_id = ? AND bot_id = ?'),
    put: db.prepare('INSERT INTO learning_counters VALUES (?, ?, ?) ON CONFLICT(device_id, bot_id) DO UPDATE SET json = excluded.json'),
  };
  const jobStmt = {
    get: db.prepare('SELECT json FROM learning_jobs WHERE job_id = ?'),
    activeFor: db.prepare("SELECT job_id, json FROM learning_jobs WHERE device_id = ? AND bot_id = ? AND status IN ('queued', 'running')"),
    put: db.prepare('INSERT INTO learning_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, json = excluded.json'),
  };
  const submissionStmt = {
    get: db.prepare('SELECT json FROM learning_submissions WHERE device_id = ? AND bot_id = ? AND request_id = ?'),
    put: db.prepare('INSERT INTO learning_submissions VALUES (?, ?, ?, ?) ON CONFLICT(device_id, bot_id, request_id) DO NOTHING'),
  };
  const callStmt = {
    get: db.prepare('SELECT * FROM learning_calls WHERE call_id = ?'),
    nextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM learning_calls WHERE job_id = ?'),
    insert: db.prepare('INSERT INTO learning_calls (call_id, job_id, seq, method, params, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    delivered: db.prepare('UPDATE learning_calls SET delivered_at = ? WHERE call_id = ?'),
    answer: db.prepare('UPDATE learning_calls SET answered = 1, answered_by = ?, result = ?, error = ?, answered_at = ? WHERE call_id = ?'),
  };
  const toolCallStmt = {
    get: db.prepare('SELECT name, args, status, response FROM learning_tool_calls WHERE job_id = ? AND call_id = ?'),
    insert: db.prepare("INSERT INTO learning_tool_calls VALUES (?, ?, ?, ?, 'pending', NULL, ?)"),
    complete: db.prepare("UPDATE learning_tool_calls SET status = 'answered', response = ? WHERE job_id = ? AND call_id = ?"),
  };

  function getSettings(deviceId, botId) {
    const row = settingsStmt.get.get(deviceId, botId);
    if (!row) return { settings: defaultSettings(), revision: 0 };
    const stored = JSON.parse(row.json);
    // Merge over defaults so keys added later never read back as undefined.
    const merged = defaultSettings();
    Object.assign(merged.review, stored.review ?? {});
    Object.assign(merged.curator, stored.curator ?? {});
    Object.assign(merged.budget, stored.budget ?? {});
    if (typeof stored.enabled === 'boolean') merged.enabled = stored.enabled;
    return { settings: merged, revision: row.revision };
  }
  function getCounters(deviceId, botId) {
    const row = countersStmt.get.get(deviceId, botId);
    return { ...defaultCounters(), ...(row ? JSON.parse(row.json) : {}) };
  }
  function saveCounters(deviceId, botId, counters) {
    countersStmt.put.run(deviceId, botId, json(counters));
  }
  function getJob(jobId) {
    return parse(jobStmt.get.get(jobId));
  }
  function saveJob(job) {
    // Job rows are receipts, not transcripts: the snapshot (full conversation) stays in the live
    // runtime's memory only — nothing beyond summaries is persisted.
    jobStmt.put.run(job.jobId, job.deviceId, job.botId, job.requestId, job.status, job.createdAt, new Date().toISOString(), json({ ...job, snapshot: undefined }));
  }
  // Live runtimes keyed by jobId; a second index keeps the one-active-job-per-Bot invariant.
  const runtimes = new Map();
  const activeByBot = new Map();
  const botKey = (deviceId, botId) => deviceId + ' ' + botId;

  // Restart recovery: a queued/running job's Python child and Host callbacks died with the last
  // process; the job cannot resume, so mark it interrupted instead of reviving or dropping it.
  const interruptedAt = new Date().toISOString();
  transaction(() => {
    const interrupted = db.prepare("SELECT job_id, json FROM learning_jobs WHERE status IN ('queued', 'running') ORDER BY created_at, job_id").all();
    for (const row of interrupted) {
      const job = JSON.parse(row.json);
      job.status = 'interrupted';
      job.finishedAt = interruptedAt;
      job.error = { code: 'INTERRUPTED', message: 'Center restarted before the job finished' };
      saveJob(job);
      const counters = getCounters(job.deviceId, job.botId);
      counters.jobsInterrupted += 1;
      counters.lastJobId = job.jobId;
      counters.lastJobStatus = job.status;
      counters.lastJobFinishedAt = interruptedAt;
      counters.lastJobSummary = job.error.message;
      saveCounters(job.deviceId, job.botId, counters);
    }
    for (const row of db.prepare('SELECT call_id FROM learning_calls WHERE answered = 0').all()) {
      callStmt.answer.run('interrupt', null, json({ code: 'INTERRUPTED', message: 'Center restarted' }), interruptedAt, row.call_id);
    }
    // Claimed but unfinished tool calls remain indeterminate after restart.
    db.prepare("UPDATE learning_tool_calls SET status = 'interrupted' WHERE status = 'pending'").run();
  });

  function notifyJob(runtime) {
    for (const waiter of [...runtime.waiters]) waiter();
  }
  function waitForJob(runtime, ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { runtime.waiters.delete(done); resolve(); }, ms);
      function done() { clearTimeout(timer); runtime.waiters.delete(done); resolve(); }
      runtime.waiters.add(done);
    });
  }

  // Aggregate input-token budget for one job, mirroring upstream _context_derived_review_input_budget.
  function deriveInputBudget(deviceId, botId, settings, snapshot) {
    if (Number.isSafeInteger(settings.budget.maxInputTokens) && settings.budget.maxInputTokens > 0) return settings.budget.maxInputTokens;
    let contextWindow = null;
    try {
      const candidates = [];
      if (typeof snapshot?.provider === 'string' && typeof snapshot?.model === 'string') {
        candidates.push({
          providerId: snapshot.provider,
          modelId: snapshot.model.includes('/') ? snapshot.model.slice(snapshot.model.indexOf('/') + 1) : snapshot.model,
        });
      }
      const ref = store.getBotModelConfig(deviceId, botId).effective?.modelRef;
      if (typeof ref === 'string' && ref.includes('/')) {
        candidates.push({ providerId: ref.slice(0, ref.indexOf('/')), modelId: ref.slice(ref.indexOf('/') + 1) });
      }
      for (const { providerId, modelId } of candidates) {
        const found = store.listModels(providerId).find((model) => model.id === modelId);
        if (found && Number.isSafeInteger(found.contextWindow) && found.contextWindow > 0) {
          contextWindow = found.contextWindow;
          break;
        }
      }
    } catch { /* fall through to the fixed fallback */ }
    if (!contextWindow) return REVIEW_INPUT_TOKENS_FALLBACK;
    return Math.min(REVIEW_INPUT_TOKENS_CAP, Math.max(1, Math.floor(contextWindow * REVIEW_INPUT_CONTEXT_FRACTION)));
  }

  // Outbound params for one host-driven callback: whitelisted, credential-free, explicit finite budget.
  function hostCallParams(runtime, method, params) {
    if (method === 'memory.call') return stripTopCredentials(object(params) ? params : {});
    const source = object(params) ? params : {};
    const clean = {};
    // Whitelist bounds the top level; declared fields pass through verbatim (byte-identical
    // prompt/messages/tools the Python side built — cache parity is pointless if we rewrite them).
    for (const key of AGENT_RUN_KEYS) {
      if (source[key] !== undefined) clean[key] = source[key];
    }
    if (typeof clean.prompt !== 'string' || !clean.prompt) throw error('INVALID_ARGUMENT', 'agent.run requires a prompt');
    if (!Array.isArray(clean.messages)) clean.messages = [];
    // Center supplies the review tool schemas when the Python side sends none.
    if (!Array.isArray(clean.tools) || !clean.tools.length) clean.tools = HERMES_SKILL_TOOLS;
    const allowed = new Set(REVIEW_TOOL_NAMES);
    if (runtime.memoryEnabled) allowed.add('memory');
    clean.allowedTools = Array.isArray(clean.allowedTools)
      ? clean.allowedTools.filter((name) => allowed.has(name))
      : [...allowed];
    // Budgets are always explicit and finite toward the Host, whatever Python asked for.
    const iterations = Number(clean.maxIterations);
    clean.maxIterations = Number.isSafeInteger(iterations) && iterations >= 1 ? Math.min(iterations, runtime.budget.maxIterations) : runtime.budget.maxIterations;
    const tokens = Number(clean.maxInputTokens);
    clean.maxInputTokens = Number.isFinite(tokens) && tokens > 0 ? Math.min(Math.floor(tokens), runtime.budget.maxInputTokens) : runtime.budget.maxInputTokens;
    clean.maxDurationMs = Math.max(1, Math.min(runtime.budget.callTimeoutMs, runtime.deadline - Date.now()));
    if (runtime.sessionId !== undefined && clean.sessionId === undefined) clean.sessionId = runtime.sessionId;
    return clean;
  }

  // Queue a Host-driven callback. At most one is outstanding per job (the Python bridge awaits each
  // onCall serially); a concurrent second call waits for the slot instead of overtaking it.
  function enqueueHostCall(runtime, method, params) {
    const previous = runtime.callChain;
    const run = previous.then(() => deliverHostCall(runtime, method, params));
    runtime.callChain = run.catch(() => {});
    return run;
  }
  function deliverHostCall(runtime, method, params) {
    return new Promise((resolve, reject) => {
      if (runtime.finished) { reject(error('INVALID_STATE', 'Job already finished')); return; }
      const clean = hostCallParams(runtime, method, params);
      boundedJson(clean, MAX_CALL_PAYLOAD_BYTES, 'call params');
      const callId = 'call-' + randomUUID();
      const seq = callStmt.nextSeq.get(runtime.job.jobId).seq;
      callStmt.insert.run(callId, runtime.job.jobId, seq, method, json(clean), new Date().toISOString());
      const timer = setTimeout(() => {
        if (runtime.pending?.callId !== callId) return;
        runtime.pending = null;
        callStmt.answer.run('timeout', null, json({ code: 'CALL_TIMEOUT', message: 'Host did not answer in time' }), new Date().toISOString(), callId);
        notifyJob(runtime);
        reject(error('CALL_TIMEOUT', 'Host did not answer the learning call in time'));
      }, runtime.budget.callTimeoutMs);
      runtime.pending = { callId, method, params: clean, resolve, reject, timer };
      notifyJob(runtime);
    });
  }

  function skillContext(runtime, requestId) {
    return {
      deviceId: runtime.job.deviceId, botId: runtime.job.botId,
      origin: MODE_ORIGIN[runtime.job.mode], sessionId: runtime.job.jobId, requestId,
    };
  }

  async function onCall(runtime, method, params) {
    if (runtime.finished) throw error('INVALID_STATE', 'Job already finished');
    if (!ONCALL_METHODS.has(method)) throw error('FORBIDDEN', 'Unsupported Hermes callback ' + method);
    if (method === 'skill.call') {
      const name = object(params) ? params.name : null;
      const args = object(params) && object(params.args) ? params.args : {};
      if (typeof name !== 'string' || !name) throw error('INVALID_ARGUMENT', 'skill.call requires a name');
      return await skills.hermes(skillContext(runtime, 'skill-' + ++runtime.skillCalls), name, args);
    }
    if (method === 'memory.call' && runtime.memoryEnabled !== true) {
      throw error('UNSUPPORTED_TARGET', 'Memory tools are not enabled for this job');
    }
    return await enqueueHostCall(runtime, method, params);
  }

  function finishJob(runtime, status, outcome) {
    if (runtime.finished) return;
    runtime.finished = true;
    clearTimeout(runtime.jobTimer);
    if (runtime.pending) {
      clearTimeout(runtime.pending.timer);
      const pending = runtime.pending;
      runtime.pending = null;
      callStmt.answer.run('cancel', null, json({ code: 'JOB_FINISHED', message: 'Job finished with a call outstanding' }), new Date().toISOString(), pending.callId);
      pending.reject(error(status === 'cancelled' ? 'CANCELLED' : 'INTERRUPTED', 'Job ' + status));
    }
    const job = runtime.job;
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (outcome?.error) job.error = sanitizedError(outcome.error) ?? { code: 'INTERNAL_ERROR', message: 'Learning job failed' };
    for (const key of ['summary', 'actions', 'usage', 'result']) {
      if (outcome?.[key] === undefined) continue;
      job[key] = boundedResult(outcome[key]);
    }
    try {
      transaction(() => {
        saveJob(job);
        const counters = getCounters(job.deviceId, job.botId);
        if (status === 'completed') counters.jobsCompleted += 1;
        else if (status === 'failed') counters.jobsFailed += 1;
        else if (status === 'cancelled') counters.jobsCancelled += 1;
        else counters.jobsInterrupted += 1;
        counters.lastJobId = job.jobId;
        counters.lastJobStatus = status;
        counters.lastJobFinishedAt = job.finishedAt;
        counters.lastJobSummary = typeof job.summary === 'string' ? job.summary.slice(0, 500) : job.error?.message ?? null;
        saveCounters(job.deviceId, job.botId, counters);
      });
    } catch {
      // A failed counters update must not leave the job row 'running': retry the status write alone
      // so next/status never report a finished job as live. Restart recovery is the last resort.
      try { saveJob(job); } catch { /* row stays stale until restart recovery */ }
    } finally {
      activeByBot.delete(botKey(job.deviceId, job.botId));
      runtimes.delete(job.jobId);
      clearTimeout(runtime.graceTimer);
      notifyJob(runtime);
      runtime.settleResolve();
    }
  }
  function boundedResult(value) {
    try {
      if (Buffer.byteLength(json(value) ?? '', 'utf8') <= MAX_STORED_RESULT_BYTES) return value;
    } catch { /* fall through */ }
    return { truncated: true };
  }

  async function runJob(runtime) {
    const { job } = runtime;
    transaction(() => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      saveJob(job);
    });
    notifyJob(runtime);
    const settings = getSettings(job.deviceId, job.botId).settings;
    const config = {
      // Center-side driver fields (not upstream): admission metadata, fired scopes, tool surface,
      // and the resolved finite budgets — the Host enforces maxIterations/maxInputTokens/maxDurationMs.
      automatic: job.automatic,
      reviewMemory: job.reviewMemory ?? null,
      reviewSkills: job.reviewSkills ?? null,
      tools: HERMES_SKILL_TOOLS,
      budget: { ...runtime.budget },
      // Upstream 'curator' config section, original keys verbatim for the bound config provider.
      curator: {
        enabled: settings.curator.enabled,
        interval_hours: settings.curator.intervalHours,
        min_idle_hours: settings.curator.minIdleHours,
        stale_after_days: settings.curator.staleAfterDays,
        archive_after_days: settings.curator.archiveAfterDays,
        consolidate: settings.curator.consolidate,
      },
      // Upstream 'auxiliary.background_review' task block: explicit finite aggregate input budget.
      auxiliary: {
        background_review: { enabled: true, max_input_tokens: runtime.budget.maxInputTokens },
      },
    };
    try {
      const outcome = await runHermes(
        { mode: job.mode, snapshot: job.snapshot, focus: job.focus ?? null, config, stateDir: runtime.stateDir },
        { onCall: (method, params) => onCall(runtime, method, params), signal: runtime.abort.signal },
      );
      if (runtime.abortReason === 'cancel') return finishJob(runtime, 'cancelled', { error: { code: 'CANCELLED', message: 'Job cancelled' } });
      if (runtime.abortReason === 'interrupt') return finishJob(runtime, 'interrupted', { error: { code: 'INTERRUPTED', message: 'Center stopped the job' } });
      if (runtime.abortReason === 'timeout') return finishJob(runtime, 'failed', { error: { code: 'TIMEOUT', message: 'Job exceeded its time budget' } });
      if (outcome?.error) return finishJob(runtime, 'failed', outcome);
      return finishJob(runtime, 'completed', outcome ?? {});
    } catch (err) {
      if (runtime.abortReason === 'cancel') return finishJob(runtime, 'cancelled', { error: { code: 'CANCELLED', message: 'Job cancelled' } });
      if (runtime.abortReason === 'interrupt') return finishJob(runtime, 'interrupted', { error: { code: 'INTERRUPTED', message: 'Center stopped the job' } });
      if (runtime.abortReason === 'timeout') return finishJob(runtime, 'failed', { error: { code: 'TIMEOUT', message: 'Job exceeded its time budget' } });
      return finishJob(runtime, 'failed', { error: sanitizedError(err) ?? { code: 'INTERNAL_ERROR', message: 'Learning job failed' } });
    }
  }

  // Persisted start decision for exactly-once submission replay.
  function recordSubmission(deviceId, botId, requestId, fingerprint, decision) {
    submissionStmt.put.run(deviceId, botId, requestId, json({ requestId, fingerprint, ...decision, decidedAt: new Date().toISOString() }));
  }

  function pickJob(job) {
    const picked = {
      jobId: job.jobId, mode: job.mode, automatic: job.automatic, status: job.status,
      createdAt: job.createdAt, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
    };
    if (job.summary !== undefined) picked.summary = job.summary;
    if (job.error) picked.error = job.error;
    return picked;
  }

  function status(identity) {
    const { settings, revision } = getSettings(identity.deviceId, identity.botId);
    const counters = getCounters(identity.deviceId, identity.botId);
    const runtime = runtimes.get(activeByBot.get(botKey(identity.deviceId, identity.botId)));
    const lastJob = counters.lastJobId ? getJob(counters.lastJobId) : null;
    const nextCuratorEligibleAt = counters.lastCuratorRunAt
      ? new Date(Date.parse(counters.lastCuratorRunAt) + settings.curator.intervalHours * 3_600_000).toISOString()
      : null;
    return {
      deviceId: identity.deviceId, botId: identity.botId,
      settings: { ...settings, revision },
      counters,
      activeJob: runtime ? pickJob(runtime.job) : null,
      lastJob: lastJob ? pickJob(lastJob) : null,
      nextCuratorEligibleAt,
    };
  }

  function configure(identity, input) {
    const current = getSettings(identity.deviceId, identity.botId);
    if (input.expectedRevision !== current.revision) throw error('REVISION_CONFLICT', 'Revision does not match');
    if (input.config !== undefined && !object(input.config)) throw error('VALIDATION_FAILED', 'Invalid config');
    const merged = validateSettingsPatch(current.settings, input.config ?? {});
    transaction(() => {
      settingsStmt.put.run(identity.deviceId, identity.botId, json(merged), current.revision + 1);
    });
    if (current.settings.enabled && merged.enabled === false) {
      const active = runtimes.get(activeByBot.get(botKey(identity.deviceId, identity.botId)));
      if (active) cancelJob(active, 'cancel');
    }
    return { settings: { ...merged, revision: current.revision + 1 } };
  }

  async function start(identity, input) {
    assertId(input.requestId, 'requestId');
    const mode = input.mode;
    if (!MODES.has(mode)) throw error('INVALID_ARGUMENT', 'Invalid learning mode');
    const automatic = input.automatic === true;
    if (automatic && mode === 'learn') throw error('INVALID_ARGUMENT', 'Learning runs are explicit only');
    const snapshot = sanitizeSnapshot(input.snapshot, mode);
    const focus = input.focus === undefined ? null : input.focus;
    if (focus !== null && (typeof focus !== 'string' || focus.length > 4_000)) throw error('INVALID_ARGUMENT', 'Invalid focus');
    // Tool-iteration count of the completed submission — upstream _iters_since_skill counts
    // iterations, not messages; the Host supplies the delta. Memory scope counts user turns (one per start).
    const iterations = input.iterations === undefined ? 0 : intIn(input.iterations, 0, 100_000, 'iterations');

    const bot = assertBot(store, identity.deviceId, identity.botId);
    if (bot.archivedAt) throw error('BOT_ARCHIVED', 'Bot is archived');
    const { deviceId, botId } = identity;
    const now = Date.now();
    const fingerprint = createHash('sha256').update(stableJson({ mode, automatic, focus, snapshot, iterations })).digest('hex');

    const admission = transaction(() => {
      const existing = parse(submissionStmt.get.get(deviceId, botId, input.requestId));
      if (existing) {
        // Same requestId, different content: a conflict, never a silent second admission or replay.
        if (existing.fingerprint !== fingerprint) throw error('REQUEST_CONFLICT', 'Learning request conflicts');
        return { replay: existing };
      }
      const { settings } = getSettings(deviceId, botId);
      const counters = getCounters(deviceId, botId);
      if (automatic && mode === 'review' && snapshot.span && snapshot.sessionId) {
        const previous = counters.reviewCursor;
        const cursor = previous?.sessionId === snapshot.sessionId ? previous.throughEntryId : 0;
        if (snapshot.span.throughEntryId <= cursor) {
          const decision = { status: 'deferred', jobId: null, mode, automatic, reason: 'already-reported' };
          recordSubmission(deviceId, botId, input.requestId, fingerprint, decision);
          return { replay: decision };
        }
        if (snapshot.span.afterEntryId !== cursor) throw error('REVISION_CONFLICT', 'Learning snapshot cursor changed');
        counters.reviewCursor = { sessionId: snapshot.sessionId, throughEntryId: snapshot.span.throughEntryId };
        saveCounters(deviceId, botId, counters);
      }
      if (!settings.enabled) {
        if (!automatic) throw error('FORBIDDEN', 'Learning is disabled for this Bot');
        const decision = { status: 'disabled', jobId: null, mode, automatic };
        recordSubmission(deviceId, botId, input.requestId, fingerprint, decision);
        return { replay: decision };
      }
      let reviewMemory = null;
      let reviewSkills = null;
      if (automatic && mode === 'review') {
        // Upstream gates are two independent counters: memory fires every memory.nudge_interval
        // (default 10) USER TURNS — ticked only when the memory tool is enabled upstream, mirrored
        // here by snapshot.memoryEnabled; skills fire every skills.creation_nudge_interval
        // (default 10) TOOL ITERATIONS accumulated since the last skill review. A fired counter
        // resets even when the spawn is skipped (upstream prepare_background_review_run drops the
        // second concurrent review), so 'busy' still consumes the trigger.
        if (snapshot.memoryEnabled === true) counters.turnsSinceMemoryReview += 1;
        counters.itersSinceSkillReview += iterations;
        reviewMemory = settings.review.memoryEvery > 0 && counters.turnsSinceMemoryReview >= settings.review.memoryEvery;
        reviewSkills = settings.review.skillEvery > 0 && counters.itersSinceSkillReview >= settings.review.skillEvery;
        if (!reviewMemory && !reviewSkills) {
          saveCounters(deviceId, botId, counters);
          const decision = { status: 'deferred', jobId: null, mode, automatic, reason: 'interval', counters: { turnsSinceMemoryReview: counters.turnsSinceMemoryReview, itersSinceSkillReview: counters.itersSinceSkillReview } };
          recordSubmission(deviceId, botId, input.requestId, fingerprint, decision);
          return { replay: decision };
        }
        if (reviewMemory) counters.turnsSinceMemoryReview = 0;
        if (reviewSkills) counters.itersSinceSkillReview = 0;
      }
      if (automatic && mode === 'curate') {
        // Upstream curator.should_run_now: enabled + not paused + last_run_at older than
        // intervalHours; a missing last_run_at is seeded and the first pass deferred.
        const lastRunAt = counters.lastCuratorRunAt ? Date.parse(counters.lastCuratorRunAt) : null;
        if (!settings.curator.enabled || settings.curator.paused) {
          const decision = { status: 'disabled', jobId: null, mode, automatic, reason: settings.curator.paused ? 'paused' : 'curator-disabled' };
          recordSubmission(deviceId, botId, input.requestId, fingerprint, decision);
          saveCounters(deviceId, botId, counters);
          return { replay: decision };
        }
        // The first admitted pass lets upstream seed its own state and defer.
        if (lastRunAt !== null && now - lastRunAt < settings.curator.intervalHours * 3_600_000) {
          const decision = { status: 'deferred', jobId: null, mode, automatic, reason: 'interval', nextEligibleAt: new Date(lastRunAt + settings.curator.intervalHours * 3_600_000).toISOString() };
          recordSubmission(deviceId, botId, input.requestId, fingerprint, decision);
          return { replay: decision };
        }
      }
      const activeRow = jobStmt.activeFor.get(deviceId, botId);
      if (activeRow) {
        const decision = { status: 'busy', jobId: null, mode, automatic, activeJobId: activeRow.job_id };
        recordSubmission(deviceId, botId, input.requestId, fingerprint, decision);
        saveCounters(deviceId, botId, counters);
        return { replay: decision };
      }
      const job = {
        jobId: 'job-' + randomUUID(), deviceId, botId, requestId: input.requestId,
        mode, automatic, focus, snapshot,
        ...(mode === 'review' ? { reviewMemory: automatic ? reviewMemory : snapshot.memoryEnabled === true, reviewSkills: automatic ? reviewSkills : true } : {}),
        status: 'queued', createdAt: new Date(now).toISOString(),
      };
      saveJob(job);
      counters.jobsStarted += 1;
      if (automatic && mode === 'review') counters.lastAutomaticReviewAt = job.createdAt;
      // Upstream run_curator_review records last_run_at at run start, manual or automatic.
      if (mode === 'curate') counters.lastCuratorRunAt = job.createdAt;
      saveCounters(deviceId, botId, counters);
      recordSubmission(deviceId, botId, input.requestId, fingerprint, { status: 'queued', jobId: job.jobId, mode, automatic });
      return { admitted: job };
    });

    if (admission.replay) {
      const replay = admission.replay;
      if (replay.jobId) {
        const job = getJob(replay.jobId);
        return { jobId: replay.jobId, status: job?.status ?? replay.status };
      }
      const result = { jobId: null, status: replay.status };
      if (replay.reason) result.reason = replay.reason;
      if (replay.activeJobId) result.activeJobId = replay.activeJobId;
      if (replay.nextEligibleAt) result.nextEligibleAt = replay.nextEligibleAt;
      return result;
    }

    const job = admission.admitted;
    const settings = getSettings(deviceId, botId).settings;
    const abort = new AbortController();
    const runtime = {
      job, abort, abortReason: null,
      deadline: Date.now() + settings.budget.jobTimeoutMs,
      finished: false, pending: null, waiters: new Set(), toolInflight: new Map(),
      callChain: Promise.resolve(), skillCalls: 0, graceTimer: null,
      budget: {
        maxIterations: settings.budget.maxIterations,
        maxInputTokens: deriveInputBudget(deviceId, botId, settings, snapshot),
        callTimeoutMs: settings.budget.callTimeoutMs,
        jobTimeoutMs: settings.budget.jobTimeoutMs,
        pollTimeoutMs: settings.budget.pollTimeoutMs,
      },
      memoryEnabled: snapshot.memoryEnabled === true,
      sessionId: typeof snapshot.sessionId === 'string' ? snapshot.sessionId : undefined,
      // base64url keeps device/bot ids path-safe on every OS (no traversal, no forbidden chars).
      stateDir: join(dataRoot, 'learning-state', Buffer.from(deviceId, 'utf8').toString('base64url'), Buffer.from(botId, 'utf8').toString('base64url')),
    };
    mkdirSync(runtime.stateDir, { recursive: true, mode: 0o700 });
    runtime.jobTimer = setTimeout(() => {
      if (runtime.finished) return;
      runtime.abortReason = 'timeout';
      abort.abort();
    }, runtime.budget.jobTimeoutMs);
    runtime.settled = new Promise((resolve) => { runtime.settleResolve = resolve; });
    runtimes.set(job.jobId, runtime);
    activeByBot.set(botKey(deviceId, botId), job.jobId);
    runtime.done = runJob(runtime);
    runtime.done.catch(() => {});
    return { jobId: job.jobId, status: 'queued' };
  }

  function sanitizeSnapshot(value, mode) {
    const snapshot = object(value) ? value : {};
    const clean = {};
    // SNAPSHOT_KEYS is the top-level whitelist: anything else (incl. credential fields) is
    // dropped; declared fields — transcript, tools — pass through verbatim, never rewritten.
    for (const key of SNAPSHOT_KEYS) {
      if (snapshot[key] !== undefined) clean[key] = snapshot[key];
    }
    if (clean.span !== undefined) {
      if (!object(clean.span)) throw error('INVALID_ARGUMENT', 'Invalid snapshot span');
      clean.span = {
        afterEntryId: intIn(clean.span.afterEntryId, 0, Number.MAX_SAFE_INTEGER, 'span.afterEntryId'),
        throughEntryId: intIn(clean.span.throughEntryId, 0, Number.MAX_SAFE_INTEGER, 'span.throughEntryId'),
        truncated: intIn(clean.span.truncated ?? 0, 0, Number.MAX_SAFE_INTEGER, 'span.truncated'),
      };
      if (clean.span.throughEntryId < clean.span.afterEntryId) throw error('INVALID_ARGUMENT', 'Invalid snapshot span');
    }
    if (!Array.isArray(clean.messages)) clean.messages = [];
    if (clean.messages.some((message) => !object(message))) throw error('INVALID_ARGUMENT', 'Invalid snapshot messages');
    if (clean.model !== undefined && typeof clean.model !== 'string') throw error('INVALID_ARGUMENT', 'Invalid snapshot model');
    if (clean.provider !== undefined && typeof clean.provider !== 'string') throw error('INVALID_ARGUMENT', 'Invalid snapshot provider');
    if (mode !== 'curate' && typeof clean.model !== 'string') throw error('INVALID_ARGUMENT', 'A snapshot model is required');
    // No Hermes memory tool is currently exposed to the model.
    clean.memoryEnabled = false;
    boundedJson(clean, MAX_SNAPSHOT_BYTES, 'snapshot');
    return clean;
  }

  async function next(identity, input) {
    assertId(input.jobId, 'jobId');
    const job = requireJob(input.jobId, identity);
    const runtime = runtimes.get(job.jobId);
    if (!runtime) return terminalReply(job);
    const started = Date.now();
    const timeout = Math.min(runtime.budget.pollTimeoutMs, DEFAULT_POLL_TIMEOUT_MS);
    for (;;) {
      if (runtime.finished) return terminalReply(runtime.job);
      if (runtime.pending) {
        const pending = runtime.pending;
        callStmt.delivered.run(new Date().toISOString(), pending.callId);
        return { jobId: job.jobId, status: runtime.job.status, call: { id: pending.callId, method: pending.method, params: pending.params } };
      }
      const elapsed = Date.now() - started;
      if (elapsed >= timeout) return { jobId: job.jobId, status: runtime.job.status };
      await waitForJob(runtime, timeout - elapsed);
    }
  }
  function terminalReply(job) {
    const reply = { jobId: job.jobId, status: job.status };
    const result = {};
    for (const key of ['summary', 'actions', 'usage', 'result']) {
      if (job[key] !== undefined) result[key] = job[key];
    }
    if (Object.keys(result).length) reply.result = result;
    if (job.error) reply.error = job.error;
    return reply;
  }

  function respond(identity, input) {
    assertId(input.jobId, 'jobId');
    assertId(input.callId, 'callId');
    const job = requireJob(input.jobId, identity);
    const call = callStmt.get.get(input.callId);
    if (!call || call.job_id !== job.jobId) throw error('NOT_FOUND', 'Call not found');
    if (call.answered) {
      // Host-answered calls replay as idempotent success; calls already closed by timeout,
      // cancellation or restart were never applied, so a late respond is honestly unacknowledged.
      const acknowledged = call.answered_by === 'host';
      return { jobId: job.jobId, callId: input.callId, status: job.status, acknowledged, reason: call.answered_by };
    }
    const runtime = runtimes.get(job.jobId);
    const pending = runtime && !runtime.finished && runtime.pending?.callId === input.callId ? runtime.pending : null;
    const resultText = input.result === undefined ? null : boundedJson(input.result, MAX_CALL_PAYLOAD_BYTES, 'call result');
    const errorValue = sanitizedError(input.error);
    // 'host' marks a result the job actually consumed; 'late' records one that arrived after the
    // job (or the call's timeout) already ended — stored for audit, honestly unacknowledged.
    callStmt.answer.run(pending ? 'host' : 'late', resultText, errorValue ? json(errorValue) : null, new Date().toISOString(), input.callId);
    if (!pending) {
      return { jobId: job.jobId, callId: input.callId, status: job.status, acknowledged: false, reason: 'job-finished' };
    }
    clearTimeout(pending.timer);
    runtime.pending = null;
    notifyJob(runtime);
    if (errorValue) {
      pending.reject(error(errorValue.code, errorValue.message || 'Call failed'));
    } else {
      pending.resolve(input.result);
    }
    return { jobId: job.jobId, callId: input.callId, status: job.status, acknowledged: true };
  }

  function cancelJob(runtime, reason) {
    if (runtime.finished) return;
    runtime.abortReason = reason === 'timeout' ? 'timeout' : reason === 'interrupt' ? 'interrupt' : 'cancel';
    runtime.abort.abort();
    // Bounded acknowledge window (upstream waits 2.0s): a wedged child must not hold the job
    // 'running' forever — after the grace the job is finalized whatever the child does.
    runtime.graceTimer = setTimeout(() => {
      if (runtime.finished) return;
      const status = runtime.abortReason === 'interrupt' ? 'interrupted' : runtime.abortReason === 'timeout' ? 'failed' : 'cancelled';
      finishJob(runtime, status, { error: { code: status === 'failed' ? 'TIMEOUT' : status === 'cancelled' ? 'CANCELLED' : 'INTERRUPTED', message: 'Job did not acknowledge cancellation in time' } });
    }, CANCEL_GRACE_MS);
    notifyJob(runtime);
  }
  function cancel(identity, input) {
    assertId(input.jobId, 'jobId');
    const job = requireJob(input.jobId, identity);
    if (TERMINAL_STATUSES.has(job.status)) return { jobId: job.jobId, status: job.status };
    const runtime = runtimes.get(job.jobId);
    if (runtime) {
      cancelJob(runtime, 'cancel');
      return { jobId: job.jobId, status: job.status, cancelling: true };
    }
    // Persisted as queued/running but no live runtime (should not happen): mark cancelled honestly.
    job.status = 'cancelled';
    job.finishedAt = new Date().toISOString();
    job.error = { code: 'CANCELLED', message: 'Job cancelled' };
    saveJob(job);
    return { jobId: job.jobId, status: 'cancelled' };
  }

  // Host relay disconnect: reuse cancelJob so device jobs end with normal cancel persistence.
  function cancelDevice(deviceId) {
    for (const runtime of [...runtimes.values()]) {
      if (runtime.job.deviceId === deviceId) cancelJob(runtime, 'cancel');
    }
  }

  async function tool(identity, input) {
    assertId(input.jobId, 'jobId');
    assertId(input.callId, 'callId');
    if (typeof input.name !== 'string' || !REVIEW_TOOL_NAMES.has(input.name)) {
      throw error('FORBIDDEN', 'Tool is not allowed in a learning review');
    }
    const args = input.args === undefined ? {} : input.args;
    if (!object(args)) throw error('INVALID_ARGUMENT', 'Invalid tool args');
    const job = requireJob(input.jobId, identity);
    const runtime = runtimes.get(job.jobId);
    if (!runtime || runtime.finished) throw error('INVALID_STATE', 'No active learning job');
    if (runtime.pending?.method !== 'agent.run') throw error('INVALID_STATE', 'No outstanding agent.run call');
    const argsText = boundedJson(args, 1024 * 1024, 'tool args');
    // Fingerprint first: an in-flight callId may only share its promise when name and args
    // match exactly — a reused id with different arguments is a conflict, not a shared result.
    const inflight = runtime.toolInflight.get(input.callId);
    if (inflight) {
      if (inflight.name !== input.name || inflight.args !== argsText) {
        throw error('REQUEST_CONFLICT', 'Tool call id was reused with a different name or arguments');
      }
      return await inflight.promise;
    }
    const existing = toolCallStmt.get.get(job.jobId, input.callId);
    if (existing) {
      if (existing.name !== input.name || existing.args !== argsText) {
        throw error('REQUEST_CONFLICT', 'Tool call id was reused with a different name or arguments');
      }
      if (existing.response != null) {
        const result = JSON.parse(existing.response);
        let parsed = result;
        if (typeof result === 'string') {
          try { parsed = JSON.parse(result); } catch { /* preserve original result */ }
        }
        const resumePublication = input.name === 'skill_manage' && Array.isArray(parsed?.publications)
          && parsed.publications.some((item) => ['queued', 'activating', 'failed'].includes(item.status));
        if (!resumePublication) return { jobId: job.jobId, callId: input.callId, name: input.name, result };
        // The skills service replays the committed draft by request id; only publication resumes.
      } else {
        // A claimed call with no result may have committed before a crash.
        return {
          jobId: job.jobId, callId: input.callId, name: input.name,
          result: { success: false, error: { code: 'INDETERMINATE', message: 'Tool call outcome is unknown; it was not re-executed' } },
        };
      }
    } else {
      // Claim before side effects so an interrupted call is never silently duplicated.
      toolCallStmt.insert.run(job.jobId, input.callId, input.name, argsText, new Date().toISOString());
    }
    const execution = (async () => {
      let result;
      try {
        result = await skills.hermes(skillContext(runtime, input.callId), input.name, args);
      } catch (err) {
        // Declared tool failures surface to the review model as success:false results, not transport errors.
        result = { success: false, error: { code: typeof err?.code === 'string' ? err.code : 'TOOL_ERROR', message: typeof err?.message === 'string' ? err.message.slice(0, MAX_MESSAGE) : 'Tool failed' } };
      }
      toolCallStmt.complete.run(boundedJson(result, 4 * 1024 * 1024, 'tool result'), job.jobId, input.callId);
      return { jobId: job.jobId, callId: input.callId, name: input.name, result };
    })();
    runtime.toolInflight.set(input.callId, { name: input.name, args: argsText, promise: execution });
    try { return await execution; } finally { runtime.toolInflight.delete(input.callId); }
  }

  function requireJob(jobId, identity) {
    const job = getJob(jobId);
    if (!job || job.deviceId !== identity.deviceId || job.botId !== identity.botId) throw error('NOT_FOUND', 'Learning job not found');
    return job;
  }

  async function execute(identity, input) {
    if (!object(identity)) throw error('INVALID_ARGUMENT', 'Identity is required');
    assertId(identity.deviceId, 'deviceId');
    assertId(identity.botId, 'botId');
    assertBot(store, identity.deviceId, identity.botId);
    const body = object(input) ? input : {};
    switch (body.action) {
      case 'status': return status(identity);
      case 'configure': return configure(identity, body);
      case 'start': return await start(identity, body);
      case 'next': return await next(identity, body);
      case 'respond': return respond(identity, body);
      case 'cancel': return cancel(identity, body);
      case 'tool': return await tool(identity, body);
      default: throw error('INVALID_ARGUMENT', 'Invalid learning action');
    }
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    for (const runtime of [...runtimes.values()]) cancelJob(runtime, 'interrupt');
    await Promise.allSettled([...runtimes.values()].map((runtime) => runtime.settled));
    const now = new Date().toISOString();
    for (const row of db.prepare("SELECT job_id, json FROM learning_jobs WHERE status IN ('queued', 'running')").all()) {
      const job = JSON.parse(row.json);
      job.status = 'interrupted';
      job.finishedAt = now;
      job.error = { code: 'INTERRUPTED', message: 'Center stopped before the job finished' };
      saveJob(job);
    }
    db.close();
  }

  return { execute, close, cancelDevice };
}

// Execute input for the management tool/route surface; kept schema-light so it cannot drift into a second API.
export const LEARNING_ACTIONS = ['status', 'configure', 'start', 'next', 'respond', 'cancel', 'tool'];
export const LEARNING_INPUT_SCHEMA = {
  type: 'object',
  required: ['action'],
  properties: {
    action: { enum: LEARNING_ACTIONS },
    expectedRevision: { type: 'integer', minimum: 0 },
    config: { type: 'object' },
    requestId: { type: 'string', minLength: 1, maxLength: 128 },
    mode: { enum: ['review', 'learn', 'curate'] },
    focus: { type: 'string', maxLength: 4000 },
    snapshot: { type: 'object' },
    automatic: { type: 'boolean' },
    iterations: { type: 'integer', minimum: 0 },
    jobId: { type: 'string', minLength: 1, maxLength: 128 },
    callId: { type: 'string', minLength: 1, maxLength: 128 },
    name: { type: 'string' },
    args: { type: 'object' },
    result: {},
    error: { type: 'object' },
  },
  additionalProperties: false,
};
