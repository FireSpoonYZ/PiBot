// host-core/google-setup/store.js
// Atomic, non-sensitive persistence for per-bot Google setup progress.
// Stored under `<dataRoot>/google-setup/runs.json`.
//
// Security invariant:
// ONLY non-sensitive wizard progress fields are ever written to disk.
// Never persists OAuth client secrets, refresh/access tokens, authorization codes,
// callback URLs, browser lease tokens, cookies, screenshots, or page DOM bodies.

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { googleChoices, isValidGoogleProjectId } from './console.js';
import { containsSecretMaterial, scrubNonSensitiveText, setupError } from './errors.js';
import {
  GOOGLE_SETUP_CARDS,
  GOOGLE_SETUP_RUN_MODES_SET,
  GOOGLE_SETUP_STATES_SET,
  GOOGLE_SETUP_STEPS,
  GOOGLE_SETUP_STEP_STATUSES_SET,
  isStep,
} from './rules.js';

const STORE_VERSION = 1;
const LOCK_REASONS = new Set([
  'policy-consent',
  'oauth-client-secret',
  'google-auth',
  'user-takeover',
]);

function isSafeNonNegInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sanitizeStepState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.status !== 'string' || !GOOGLE_SETUP_STEP_STATUSES_SET.has(raw.status)) {
    return null;
  }
  const out = { status: raw.status };
  if (raw.by === 'bot' || raw.by === 'user') out.by = raw.by;
  if (isSafeNonNegInt(raw.at)) out.at = raw.at;
  const note = scrubNonSensitiveText(raw.note, 500);
  if (note) out.note = note;
  return out;
}

function sanitizeAnswer(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > 20) {
    return null;
  }
  const values = [];
  for (const item of raw.values) {
    const clean = scrubNonSensitiveText(item, 320);
    if (!clean || clean === '[redacted]') return null;
    values.push(clean);
  }
  if (!isSafeNonNegInt(raw.at)) return null;
  const out = { values, at: raw.at };
  if (raw.typed === true) out.typed = true;
  return out;
}

function sanitizeBrowserLock(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (raw.active !== true || !isStep(raw.step) || !LOCK_REASONS.has(raw.reason)) {
    return undefined;
  }
  return {
    active: true,
    step: raw.step,
    reason: raw.reason,
    lockedAt: isSafeNonNegInt(raw.lockedAt) ? raw.lockedAt : 0,
    ...(raw.requiresSystemBrowser === true ? { requiresSystemBrowser: true } : {}),
  };
}

/**
 * Strict whitelist sanitizer applied before every save and after every load.
 * Drops unknown keys (e.g. accidental secrets, lease tokens, page bodies).
 */
export function sanitizePersistedRun(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = scrubNonSensitiveText(raw.id, 80);
  const botId = scrubNonSensitiveText(raw.botId, 200);
  if (!id || !botId || id === '[redacted]' || botId === '[redacted]') return null;
  if (typeof raw.state !== 'string' || !GOOGLE_SETUP_STATES_SET.has(raw.state)) return null;
  if (typeof raw.mode !== 'string' || !GOOGLE_SETUP_RUN_MODES_SET.has(raw.mode)) return null;
  if (!isSafeNonNegInt(raw.startedAt) || !isSafeNonNegInt(raw.updatedAt) || !isSafeNonNegInt(raw.revision)) {
    return null;
  }

  const steps = {};
  if (raw.steps && typeof raw.steps === 'object' && !Array.isArray(raw.steps)) {
    for (const step of GOOGLE_SETUP_STEPS) {
      const cleanStep = sanitizeStepState(raw.steps[step]);
      if (cleanStep) steps[step] = cleanStep;
    }
  }

  const answers = {};
  if (raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers)) {
    for (const card of GOOGLE_SETUP_CARDS) {
      const cleanAnswer = sanitizeAnswer(raw.answers[card]);
      if (cleanAnswer) answers[card] = cleanAnswer;
    }
  }

  const out = {
    id,
    botId,
    state: raw.state,
    mode: raw.mode,
    steps,
    answers,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    revision: raw.revision,
  };

  if (isStep(raw.personStep)) out.personStep = raw.personStep;

  const account = scrubNonSensitiveText(raw.account, 320);
  if (account && account !== '[redacted]') out.account = account;

  if (Array.isArray(raw.accounts)) {
    const accounts = raw.accounts
      .map((item) => scrubNonSensitiveText(item, 320))
      .filter((item) => item && item !== '[redacted]')
      .slice(0, 10);
    if (accounts.length > 0) out.accounts = accounts;
  }

  if (raw.kind === 'work' || raw.kind === 'personal') out.kind = raw.kind;

  if (Array.isArray(raw.services)) {
    const services = googleChoices(raw.services);
    if (services.length > 0) out.services = services;
  }

  if (typeof raw.projectId === 'string' && isValidGoogleProjectId(raw.projectId)) {
    out.projectId = raw.projectId;
  }

  const browserPageId = scrubNonSensitiveText(raw.browserPageId, 200);
  if (browserPageId && browserPageId !== '[redacted]' && !containsSecretMaterial(browserPageId)) {
    out.browserPageId = browserPageId;
  }

  const lastError = scrubNonSensitiveText(raw.lastError, 500);
  if (lastError) out.lastError = lastError;

  if (raw.clientMissed && typeof raw.clientMissed === 'object' && isSafeNonNegInt(raw.clientMissed.at)) {
    const reason = scrubNonSensitiveText(raw.clientMissed.reason, 500);
    out.clientMissed = {
      at: raw.clientMissed.at,
      ...(reason ? { reason } : {}),
    };
  }

  if (raw.cardCopies && typeof raw.cardCopies === 'object' && !Array.isArray(raw.cardCopies)) {
    const copies = {};
    for (const [key, value] of Object.entries(raw.cardCopies)) {
      if (typeof key === 'string' && key.length > 0 && key.length <= 64 && isSafeNonNegInt(value)) {
        copies[key] = value;
      }
    }
    if (Object.keys(copies).length > 0) out.cardCopies = copies;
  }

  const browserLock = sanitizeBrowserLock(raw.browserLock);
  if (browserLock) out.browserLock = browserLock;

  return out;
}

export function createGoogleSetupStore({ dataRoot, filePath } = {}) {
  const resolvedPath = filePath ?? (dataRoot ? join(dataRoot, 'google-setup', 'runs.json') : null);
  let loaded = false;
  let closed = false;
  let runs = {};
  let writeQueue = Promise.resolve();

  async function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (!resolvedPath) return;
    try {
      const raw = await readFile(resolvedPath, 'utf8');
      const parsed = JSON.parse(raw);
      const next = {};
      if (parsed && typeof parsed === 'object' && parsed.runs && typeof parsed.runs === 'object') {
        for (const [botId, entry] of Object.entries(parsed.runs)) {
          const clean = sanitizePersistedRun(entry);
          if (clean && clean.botId === botId) {
            next[botId] = clean;
          }
        }
      }
      runs = next;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // Corrupt or unreadable progress file starts clean rather than crashing Host startup.
        runs = {};
      }
    }
  }

  async function writeSnapshot(snapshot) {
    if (!resolvedPath) return;
    const directory = dirname(resolvedPath);
    const bytes = `${JSON.stringify({ version: STORE_VERSION, runs: snapshot })}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(bytes, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, resolvedPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw setupError('STORE_FAILED', `Failed to persist Google setup progress: ${error?.message ?? 'write error'}`);
    }
  }

  function enqueueWrite(snapshot) {
    const next = writeQueue.then(() => writeSnapshot(snapshot));
    writeQueue = next.catch(() => {});
    return next;
  }

  return {
    filePath: resolvedPath,

    async get(botId) {
      await ensureLoaded();
      const entry = runs[botId];
      return entry ? structuredClone(entry) : null;
    },

    async list() {
      await ensureLoaded();
      return Object.values(runs).map((entry) => structuredClone(entry));
    },

    async save(run) {
      if (closed) throw setupError('SETUP_CLOSED', 'Google setup store is closed.');
      await ensureLoaded();
      const sanitized = sanitizePersistedRun(run);
      if (!sanitized) {
        throw setupError('INVALID_ARGUMENT', 'Refused to persist invalid Google setup run.');
      }
      const nextRuns = { ...runs, [sanitized.botId]: sanitized };
      await enqueueWrite(nextRuns);
      runs = nextRuns;
      return structuredClone(sanitized);
    },

    async forget(botId) {
      if (closed) return;
      await ensureLoaded();
      if (!(botId in runs)) return;
      const nextRuns = { ...runs };
      delete nextRuns[botId];
      await enqueueWrite(nextRuns);
      runs = nextRuns;
    },

    async close() {
      closed = true;
      await writeQueue;
    },
  };
}
