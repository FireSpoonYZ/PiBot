// Dedicated Center SQLite store for Google Gmail/Calendar trigger rules,
// proactive Google assistant binding & batched events, durable polling cursors/listeners,
// and idempotent Center->Host event deliveries.
// Shares the Host poll/receipt/stop delivery seam with webhooks without creating
// public bearer webhook routes or forging human messages.

import { createHash, randomUUID } from 'node:crypto';
import {
  GOOGLE_ASSISTANT_POLL_VALUE,
  GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
  GOOGLE_WORKSPACE_DATA_BOUNDARY,
  GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
} from '../../center-contract/google-workspace.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'missed']);
const progress = { dispatching: 0, queued: 1, running: 2 };
const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const DIGEST_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function safeParseJson(raw, fallback) {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function isoOf(ms) {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function ruleValue(row) {
  const config = safeParseJson(row.config_json, {});
  const runtime = safeParseJson(row.runtime_json, {});
  return {
    id: row.id,
    name: row.name,
    deviceId: row.device_id,
    botId: row.bot_id,
    account: row.account,
    source: row.source,
    event: row.event,
    enabled: Boolean(row.enabled),
    ...(row.source === 'gmail' ? {
      ...(Array.isArray(config.from) && config.from.length ? { from: config.from } : {}),
      ...(Array.isArray(config.to) && config.to.length ? { to: config.to } : {}),
      ...(typeof config.subjectContains === 'string' && config.subjectContains ? { subjectContains: config.subjectContains } : {}),
      ...(typeof config.label === 'string' && config.label ? { label: config.label } : {}),
    } : {
      calendar: typeof config.calendar === 'string' && config.calendar ? config.calendar : 'primary',
      minutesBefore: Number.isInteger(config.minutesBefore) ? config.minutesBefore : 10,
    }),
    instruction: row.instruction,
    listeningSinceMs: Number.isFinite(row.listening_since_ms) ? row.listening_since_ms : null,
    runtimeState: runtime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function eventValue(row, includePayload = false) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    deviceId: row.device_id,
    botId: row.bot_id,
    account: row.account,
    source: row.source,
    requestId: row.request_id,
    eventKey: row.event_key,
    status: row.status,
    cancelRequested: Boolean(row.cancel_requested),
    admission: row.admission_json === null ? null : safeParseJson(row.admission_json, null),
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    error: row.error_json === null ? null : safeParseJson(row.error_json, null),
    ...(includePayload ? {
      instruction: row.instruction,
      payload: safeParseJson(row.payload_json, {}),
    } : {}),
  };
}

function toHostDeliveryEvent(row) {
  return {
    id: row.id,
    routeId: row.rule_id,
    routeName: row.rule_name,
    deviceId: row.device_id,
    botId: row.bot_id,
    requestId: row.request_id,
    idempotencyKey: row.event_key,
    status: row.status,
    cancelRequested: Boolean(row.cancel_requested),
    admission: row.admission_json === null ? null : safeParseJson(row.admission_json, null),
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    ...(row.error_json === null ? {} : { error: safeParseJson(row.error_json, null) }),
    // Trusted Center envelope markers emitted exclusively from google_rule_events;
    // public webhook_events rows never emit these top-level fields regardless of payload.
    trustedSource: GOOGLE_WORKSPACE_RULE_SOURCE_TYPE,
    dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
    instruction: row.instruction,
    payload: safeParseJson(row.payload_json, {}),
  };
}

function normalizeAccountsList(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().toLowerCase();
    if (trimmed) cleaned.push(trimmed);
  }
  return [...new Set(cleaned)].sort();
}

function normalizeDigestTimes(raw) {
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (DIGEST_TIME_RE.test(trimmed)) cleaned.push(trimmed);
  }
  return [...new Set(cleaned)].sort();
}

function assistantValue(row) {
  if (!row) return null;
  const accounts = normalizeAccountsList(safeParseJson(row.accounts_json, []));
  const config = safeParseJson(row.config_json, {});
  const runtime = safeParseJson(row.runtime_json, {});
  const mode = row.mode === 'existing' ? 'existing' : 'dedicated';
  const batchWindowMinutes = Number.isInteger(config.batchWindowMinutes)
    && config.batchWindowMinutes >= 1
    && config.batchWindowMinutes <= 1440
    ? config.batchWindowMinutes
    : 10;
  const digestTimes = normalizeDigestTimes(config.digestTimes);
  const calendarEnabled = typeof config.calendarEnabled === 'boolean' ? config.calendarEnabled : true;
  const calendarLeadMinutes = Number.isInteger(config.calendarLeadMinutes)
    && config.calendarLeadMinutes >= 0
    && config.calendarLeadMinutes <= 1440
    ? config.calendarLeadMinutes
    : 15;
  const hindsightPrivateMemory = typeof config.hindsightPrivateMemory === 'boolean'
    ? config.hindsightPrivateMemory
    : mode === 'dedicated';
  const listeningSinceMs = Number.isFinite(row.listening_since_ms) ? row.listening_since_ms : null;
  return {
    enabled: Boolean(row.enabled),
    deviceId: row.device_id,
    botId: row.bot_id,
    mode,
    accounts,
    batchWindowMinutes,
    digestTimes,
    calendarEnabled,
    calendarLeadMinutes,
    hindsightPrivateMemory,
    revision: Number.isInteger(row.revision) && row.revision >= 1 ? row.revision : 1,
    listeningSince: listeningSinceMs !== null ? isoOf(listeningSinceMs) : null,
    listeningSinceMs,
    runtimeState: runtime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assistantEventValue(row, includePayload = false) {
  return {
    id: row.id,
    deviceId: row.device_id,
    botId: row.bot_id,
    account: row.account,
    source: row.source,
    routeName: row.route_name,
    requestId: row.request_id,
    eventKey: row.event_key,
    status: row.status,
    cancelRequested: Boolean(row.cancel_requested),
    admission: row.admission_json === null ? null : safeParseJson(row.admission_json, null),
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    error: row.error_json === null ? null : safeParseJson(row.error_json, null),
    ...(includePayload ? {
      instruction: row.instruction,
      payload: safeParseJson(row.payload_json, {}),
    } : {}),
  };
}

function toAssistantHostDeliveryEvent(row) {
  return {
    id: row.id,
    routeId: 'google-proactive-assistant',
    routeName: row.route_name,
    deviceId: row.device_id,
    botId: row.bot_id,
    requestId: row.request_id,
    idempotencyKey: row.event_key,
    status: row.status,
    cancelRequested: Boolean(row.cancel_requested),
    admission: row.admission_json === null ? null : safeParseJson(row.admission_json, null),
    receivedAt: row.received_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    ...(row.error_json === null ? {} : { error: safeParseJson(row.error_json, null) }),
    // Trusted Center envelope markers emitted exclusively from google_assistant_events;
    // public webhook_events and google_rule_events never emit this trustedSource.
    trustedSource: GOOGLE_WORKSPACE_ASSISTANT_SOURCE_TYPE,
    dataBoundary: GOOGLE_WORKSPACE_DATA_BOUNDARY,
    instruction: row.instruction,
    payload: safeParseJson(row.payload_json, {}),
  };
}

function extractConfig(input) {
  if (input.source === 'gmail') {
    const config = {};
    if (Array.isArray(input.from) && input.from.length) config.from = input.from;
    if (Array.isArray(input.to) && input.to.length) config.to = input.to;
    if (typeof input.subjectContains === 'string' && input.subjectContains) {
      config.subjectContains = input.subjectContains;
    }
    if (typeof input.label === 'string' && input.label) config.label = input.label;
    return config;
  }
  return {
    calendar: typeof input.calendar === 'string' && input.calendar ? input.calendar : 'primary',
    minutesBefore: Number.isInteger(input.minutesBefore) ? input.minutesBefore : 10,
  };
}

function normalizeTriggerState(raw) {
  const accounts = {};
  if (raw && typeof raw.accounts === 'object' && raw.accounts && !Array.isArray(raw.accounts)) {
    for (const [account, entry] of Object.entries(raw.accounts)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const next = {};
      if (typeof entry.historyId === 'string' && entry.historyId) next.historyId = entry.historyId;
      if (entry.calendars && typeof entry.calendars === 'object' && !Array.isArray(entry.calendars)) {
        const calendars = {};
        for (const [calId, cal] of Object.entries(entry.calendars)) {
          if (!cal || typeof cal !== 'object' || Array.isArray(cal)) continue;
          calendars[calId] = typeof cal.syncToken === 'string' && cal.syncToken ? { syncToken: cal.syncToken } : {};
        }
        if (Object.keys(calendars).length > 0) next.calendars = calendars;
      }
      if (next.historyId || next.calendars) accounts[account] = next;
    }
  }
  const listeners = {};
  if (raw && typeof raw.listeners === 'object' && raw.listeners && !Array.isArray(raw.listeners)) {
    for (const [key, since] of Object.entries(raw.listeners)) {
      if (typeof since === 'number' && Number.isFinite(since)) listeners[key] = since;
    }
  }
  const assistantBucket = {};
  if (raw && typeof raw.assistantBucket === 'object' && raw.assistantBucket && !Array.isArray(raw.assistantBucket)) {
    for (const [account, entry] of Object.entries(raw.assistantBucket)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const threads = {};
      if (entry.threads && typeof entry.threads === 'object' && !Array.isArray(entry.threads)) {
        for (const [tid, item] of Object.entries(entry.threads)) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const threadId = typeof item.threadId === 'string' && item.threadId ? item.threadId : tid;
          const latestMessageId = typeof item.latestMessageId === 'string' ? item.latestMessageId : '';
          if (!threadId || !latestMessageId) continue;
          threads[threadId] = {
            threadId,
            latestMessageId,
            messageCount: Number.isSafeInteger(item.messageCount) && item.messageCount >= 1 ? item.messageCount : 1,
            from: typeof item.from === 'string' ? item.from : '',
            to: typeof item.to === 'string' ? item.to : '',
            cc: typeof item.cc === 'string' ? item.cc : '',
            subject: typeof item.subject === 'string' ? item.subject : '',
            snippet: typeof item.snippet === 'string' ? item.snippet : '',
            latestAt: typeof item.latestAt === 'number' && Number.isFinite(item.latestAt) ? item.latestAt : 0,
            labelIds: Array.isArray(item.labelIds) ? item.labelIds.filter(label => typeof label === 'string') : [],
            senderVerified: Boolean(item.senderVerified),
            priority: item.priority === 'high' ? 'high' : 'routine',
          };
        }
      }
      const overflowCount = Number.isSafeInteger(entry.overflowCount) && entry.overflowCount > 0
        ? entry.overflowCount
        : 0;
      const hasHigh = Object.values(threads).some(item => item.priority === 'high');
      const openedAtMs = typeof entry.openedAtMs === 'number' && Number.isFinite(entry.openedAtMs) ? entry.openedAtMs : 0;
      const highOpenedAtMs = hasHigh
        ? (typeof entry.highOpenedAtMs === 'number' && Number.isFinite(entry.highOpenedAtMs) && entry.highOpenedAtMs > 0
          ? entry.highOpenedAtMs
          : (openedAtMs > 0 ? openedAtMs : null))
        : null;
      if (Object.keys(threads).length > 0 || overflowCount > 0) {
        assistantBucket[account] = {
          openedAtMs,
          ...(highOpenedAtMs !== null ? { highOpenedAtMs } : {}),
          threads,
          overflowCount,
        };
      }
    }
  }
  const lastDigestSlots = {};
  if (raw && typeof raw.lastDigestSlots === 'object' && raw.lastDigestSlots && !Array.isArray(raw.lastDigestSlots)) {
    for (const [slotKey, ts] of Object.entries(raw.lastDigestSlots)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) lastDigestSlots[slotKey] = ts;
    }
  }
  return { accounts, listeners, assistantBucket, lastDigestSlots };
}

export function googleRulesStore(db, transaction, options = {}) {
  const onAssistantChanged = typeof options?.onAssistantChanged === 'function'
    ? options.onAssistantChanged
    : null;

  // Created idempotently inside a transaction so no schema user_version conflict occurs with sibling modules.
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS google_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        device_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        account TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('gmail', 'calendar')),
        event TEXT NOT NULL CHECK(event IN ('new_email', 'starting_soon')),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        config_json TEXT NOT NULL,
        instruction TEXT NOT NULL,
        listening_since_ms INTEGER,
        runtime_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_google_rules_device_bot
        ON google_rules(device_id, bot_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_google_rules_account
        ON google_rules(account) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS google_trigger_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS google_rule_events (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL REFERENCES google_rules(id),
        rule_name TEXT NOT NULL,
        device_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        account TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('gmail', 'calendar')),
        request_id TEXT NOT NULL UNIQUE,
        event_key TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'dispatching', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'missed')),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
        admission_json TEXT,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_json TEXT,
        instruction TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(rule_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_google_rule_events_rule_time
        ON google_rule_events(rule_id, received_at);
      CREATE INDEX IF NOT EXISTS idx_google_rule_events_device_active
        ON google_rule_events(device_id, received_at)
        WHERE status IN ('pending', 'dispatching', 'queued', 'running');
      CREATE TABLE IF NOT EXISTS google_proactive_assistant (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        device_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('dedicated', 'existing')),
        accounts_json TEXT NOT NULL,
        config_json TEXT NOT NULL,
        listening_since_ms INTEGER,
        runtime_json TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS google_assistant_events (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        account TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('gmail', 'calendar')),
        route_name TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        event_key TEXT NOT NULL UNIQUE,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'dispatching', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired', 'missed')),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
        admission_json TEXT,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error_json TEXT,
        instruction TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_google_assistant_events_time
        ON google_assistant_events(received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_google_assistant_events_device_active
        ON google_assistant_events(device_id, received_at)
        WHERE status IN ('pending', 'dispatching', 'queued', 'running');
    `);
  });

  function requireRule(id) {
    const row = db.prepare('SELECT * FROM google_rules WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) fail('NOT_FOUND', 'Google rule not found');
    return row;
  }

  function requireActiveBot(deviceId, botId) {
    const row = db.prepare('SELECT json FROM device_bots WHERE device_id = ? AND bot_id = ?').get(deviceId, botId);
    if (!row) fail('BOT_NOT_FOUND', 'Target Bot not found');
    const parsed = safeParseJson(row.json, null);
    if (!parsed) fail('BOT_NOT_FOUND', 'Target Bot not found');
    if (parsed.archivedAt) fail('BOT_ARCHIVED', 'Target Bot is archived');
    return parsed;
  }

  function cancelPending(where, params, nowIso, code, message) {
    db.prepare(`UPDATE google_rule_events SET status = 'cancelled', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND ${where}`)
      .run(nowIso, JSON.stringify({ code, message }), ...params);
  }

  function cancelPendingAssistant(where, params, nowIso, code, message) {
    db.prepare(`UPDATE google_assistant_events SET status = 'cancelled', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND ${where}`)
      .run(nowIso, JSON.stringify({ code, message }), ...params);
  }

  function settlePending(where, params, nowIso) {
    // Calendar reminders whose meeting start time already passed while target Bot was offline are marked missed, never delivered late.
    db.prepare(`UPDATE google_rule_events SET status = 'missed', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND source = 'calendar' AND expires_at <= ? AND ${where}`)
      .run(
        nowIso,
        JSON.stringify({ code: 'MEETING_STARTED_WHILE_OFFLINE', message: 'Meeting started before target Bot was available' }),
        nowIso,
        ...params,
      );
    // Gmail events not dispatched within their TTL expire cleanly.
    db.prepare(`UPDATE google_rule_events SET status = 'expired', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND source = 'gmail' AND expires_at <= ? AND ${where}`)
      .run(
        nowIso,
        JSON.stringify({ code: 'GOOGLE_EVENT_EXPIRED', message: 'Event was not dispatched before it expired' }),
        nowIso,
        ...params,
      );
    cancelPending(`(${where}) AND (
      NOT EXISTS (SELECT 1 FROM google_rules r WHERE r.id = google_rule_events.rule_id AND r.enabled = 1 AND r.deleted_at IS NULL)
      OR NOT EXISTS (
        SELECT 1 FROM device_bots b
        WHERE b.device_id = google_rule_events.device_id
          AND b.bot_id = google_rule_events.bot_id
          AND COALESCE(json_extract(b.json, '$.archivedAt'), '') = ''
      )
    )`, params, nowIso, 'GOOGLE_RULE_UNAVAILABLE', 'Google rule or target Bot is no longer available');
  }

  function settlePendingAssistant(where, params, nowIso) {
    db.prepare(`UPDATE google_assistant_events SET status = 'missed', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND source = 'calendar' AND expires_at <= ? AND ${where}`)
      .run(
        nowIso,
        JSON.stringify({ code: 'MEETING_STARTED_WHILE_OFFLINE', message: 'Meeting started before target Bot was available' }),
        nowIso,
        ...params,
      );
    db.prepare(`UPDATE google_assistant_events SET status = 'expired', updated_at = ?, error_json = ?
      WHERE status = 'pending' AND source = 'gmail' AND expires_at <= ? AND ${where}`)
      .run(
        nowIso,
        JSON.stringify({ code: 'GOOGLE_EVENT_EXPIRED', message: 'Event was not dispatched before it expired' }),
        nowIso,
        ...params,
      );
    cancelPendingAssistant(`(${where}) AND (
      NOT EXISTS (
        SELECT 1 FROM google_proactive_assistant a
        WHERE a.id = 1
          AND a.enabled = 1
          AND a.device_id = google_assistant_events.device_id
          AND a.bot_id = google_assistant_events.bot_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM device_bots b
        WHERE b.device_id = google_assistant_events.device_id
          AND b.bot_id = google_assistant_events.bot_id
          AND COALESCE(json_extract(b.json, '$.archivedAt'), '') = ''
      )
    )`, params, nowIso, 'GOOGLE_ASSISTANT_UNAVAILABLE', 'Proactive Google assistant or target Bot is no longer available');
  }

  const delivery = {
    settlePendingForDevice(deviceId, nowIso) {
      settlePending('device_id = ?', [deviceId], nowIso);
    },
    queryActiveForDevice(deviceId, afterTuple, limit, streamIndex = 1) {
      if (!Number.isSafeInteger(streamIndex) || streamIndex < 1) {
        fail('INVALID_ARGUMENT', 'Invalid delivery stream index');
      }
      return db.prepare(`SELECT *, ? AS stream, rowid AS cursor_rowid FROM google_rule_events
        WHERE device_id = ?
          AND status IN ('pending', 'dispatching', 'queued', 'running')
          ${afterTuple ? 'AND (received_at, ?, rowid) > (?, ?, ?)' : ''}
        ORDER BY received_at, rowid LIMIT ?`)
        .all(
          streamIndex,
          deviceId,
          ...(afterTuple ? [streamIndex, ...afterTuple] : []),
          limit,
        );
    },
    markDispatching(id, nowIso) {
      db.prepare("UPDATE google_rule_events SET status = 'dispatching', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso, id);
    },
    toHostDeliveryEvent,
    reportEvent(deviceId, id, input, nowMs = Date.now()) {
      const row = db.prepare('SELECT * FROM google_rule_events WHERE id = ? AND device_id = ?').get(id, deviceId);
      if (!row) return null;
      if (terminal.has(row.status)) return eventValue(row);
      if (row.status === 'pending') fail('INVALID_STATE', 'Google rule event has not been dispatched');
      if (!terminal.has(input.status) && progress[input.status] < progress[row.status]) return eventValue(row);
      const errorJson = input.error == null ? null : JSON.stringify(input.error);
      const admissionJson = input.status !== 'queued' ? null
        : input.admission === undefined ? row.admission_json
        : input.admission === null ? null : JSON.stringify(input.admission);
      if (row.status === input.status && row.error_json === errorJson && row.admission_json === admissionJson) {
        return eventValue(row);
      }
      row.status = input.status;
      row.updated_at = isoOf(nowMs);
      row.error_json = errorJson;
      row.admission_json = admissionJson;
      db.prepare('UPDATE google_rule_events SET status = ?, updated_at = ?, error_json = ?, admission_json = ? WHERE id = ?')
        .run(row.status, row.updated_at, row.error_json, row.admission_json, id);
      return eventValue(row);
    },
    stopForBot(deviceId, botId, nowIso) {
      cancelPending('device_id = ? AND bot_id = ?', [deviceId, botId], nowIso, 'USER_STOP', 'Google rule event cancelled by user stop');
      db.prepare(`UPDATE google_rule_events SET cancel_requested = 1, updated_at = ?
        WHERE device_id = ? AND bot_id = ? AND status IN ('dispatching', 'queued', 'running') AND cancel_requested = 0`)
        .run(nowIso, deviceId, botId);
    },
    cancelForBot(deviceId, botId, nowIso) {
      cancelPending('device_id = ? AND bot_id = ?', [deviceId, botId], nowIso, 'BOT_NOT_FOUND', 'Target Bot was deleted before dispatch');
    },
  };

  const assistantDelivery = {
    supportsPoll(pollOptions) {
      return pollOptions?.googleAssistantBatch === true
        || pollOptions?.googleAssistant === GOOGLE_ASSISTANT_POLL_VALUE;
    },
    settlePendingForDevice(deviceId, nowIso) {
      settlePendingAssistant('device_id = ?', [deviceId], nowIso);
    },
    queryActiveForDevice(deviceId, afterTuple, limit, streamIndex = 2) {
      if (!Number.isSafeInteger(streamIndex) || streamIndex < 1) {
        fail('INVALID_ARGUMENT', 'Invalid delivery stream index');
      }
      return db.prepare(`SELECT *, ? AS stream, rowid AS cursor_rowid FROM google_assistant_events
        WHERE device_id = ?
          AND status IN ('pending', 'dispatching', 'queued', 'running')
          ${afterTuple ? 'AND (received_at, ?, rowid) > (?, ?, ?)' : ''}
        ORDER BY received_at, rowid LIMIT ?`)
        .all(
          streamIndex,
          deviceId,
          ...(afterTuple ? [streamIndex, ...afterTuple] : []),
          limit,
        );
    },
    markDispatching(id, nowIso) {
      db.prepare("UPDATE google_assistant_events SET status = 'dispatching', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso, id);
    },
    toHostDeliveryEvent: toAssistantHostDeliveryEvent,
    reportEvent(deviceId, id, input, nowMs = Date.now()) {
      const row = db.prepare('SELECT * FROM google_assistant_events WHERE id = ? AND device_id = ?').get(id, deviceId);
      if (!row) return null;
      if (terminal.has(row.status)) return assistantEventValue(row);
      if (row.status === 'pending') fail('INVALID_STATE', 'Google assistant event has not been dispatched');
      if (!terminal.has(input.status) && progress[input.status] < progress[row.status]) return assistantEventValue(row);
      const errorJson = input.error == null ? null : JSON.stringify(input.error);
      const admissionJson = input.status !== 'queued' ? null
        : input.admission === undefined ? row.admission_json
        : input.admission === null ? null : JSON.stringify(input.admission);
      if (row.status === input.status && row.error_json === errorJson && row.admission_json === admissionJson) {
        return assistantEventValue(row);
      }
      row.status = input.status;
      row.updated_at = isoOf(nowMs);
      row.error_json = errorJson;
      row.admission_json = admissionJson;
      db.prepare('UPDATE google_assistant_events SET status = ?, updated_at = ?, error_json = ?, admission_json = ? WHERE id = ?')
        .run(row.status, row.updated_at, row.error_json, row.admission_json, id);
      return assistantEventValue(row);
    },
    stopForBot(deviceId, botId, nowIso) {
      cancelPendingAssistant('device_id = ? AND bot_id = ?', [deviceId, botId], nowIso, 'USER_STOP', 'Google assistant event cancelled by user stop');
      db.prepare(`UPDATE google_assistant_events SET cancel_requested = 1, updated_at = ?
        WHERE device_id = ? AND bot_id = ? AND status IN ('dispatching', 'queued', 'running') AND cancel_requested = 0`)
        .run(nowIso, deviceId, botId);
    },
    cancelForBot(deviceId, botId, nowIso) {
      cancelPendingAssistant('device_id = ? AND bot_id = ?', [deviceId, botId], nowIso, 'BOT_NOT_FOUND', 'Target Bot was deleted before dispatch');
    },
  };

  return {
    _delivery: delivery,
    _assistantDelivery: assistantDelivery,

    listGoogleRules(filter = {}) {
      const clauses = ['deleted_at IS NULL'];
      const params = [];
      if (typeof filter.deviceId === 'string' && filter.deviceId) {
        clauses.push('device_id = ?');
        params.push(filter.deviceId);
      }
      if (typeof filter.botId === 'string' && filter.botId) {
        clauses.push('bot_id = ?');
        params.push(filter.botId);
      }
      if (typeof filter.account === 'string' && filter.account) {
        clauses.push('account = ?');
        params.push(filter.account.toLowerCase());
      }
      if (typeof filter.enabled === 'boolean') {
        clauses.push('enabled = ?');
        params.push(filter.enabled ? 1 : 0);
      }
      return db.prepare(`SELECT * FROM google_rules WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC`)
        .all(...params)
        .map(ruleValue);
    },

    getGoogleRule(id) {
      return ruleValue(requireRule(id));
    },

    saveGoogleRule(input, nowMs = Date.now()) {
      return transaction(() => {
        const nowIso = isoOf(nowMs);
        const configJson = JSON.stringify(extractConfig(input));
        const event = input.source === 'gmail' ? 'new_email' : 'starting_soon';
        if (input.id) {
          const current = requireRule(input.id);
          const sameTarget = current.device_id === input.deviceId
            && current.bot_id === input.botId
            && current.account === input.account
            && current.source === input.source;
          let listeningSinceMs;
          if (!input.enabled) {
            listeningSinceMs = null;
          } else if (current.enabled && sameTarget && Number.isFinite(current.listening_since_ms)) {
            listeningSinceMs = current.listening_since_ms;
          } else {
            listeningSinceMs = nowMs;
          }
          db.prepare(`UPDATE google_rules
            SET name = ?, device_id = ?, bot_id = ?, account = ?, source = ?, event = ?,
                enabled = ?, config_json = ?, instruction = ?, listening_since_ms = ?, updated_at = ?
            WHERE id = ?`)
            .run(
              input.name,
              input.deviceId,
              input.botId,
              input.account,
              input.source,
              event,
              input.enabled ? 1 : 0,
              configJson,
              input.instruction,
              listeningSinceMs,
              nowIso,
              input.id,
            );
          if (!input.enabled) {
            cancelPending('rule_id = ?', [input.id], nowIso, 'GOOGLE_RULE_DISABLED', 'Google rule was disabled before dispatch');
          }
          return ruleValue(requireRule(input.id));
        }
        const id = randomUUID();
        const listeningSinceMs = input.enabled ? nowMs : null;
        db.prepare(`INSERT INTO google_rules
          (id, name, device_id, bot_id, account, source, event, enabled, config_json, instruction,
           listening_since_ms, runtime_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`)
          .run(
            id,
            input.name,
            input.deviceId,
            input.botId,
            input.account,
            input.source,
            event,
            input.enabled ? 1 : 0,
            configJson,
            input.instruction,
            listeningSinceMs,
            nowIso,
            nowIso,
          );
        return ruleValue(requireRule(id));
      });
    },

    removeGoogleRule(id, nowMs = Date.now()) {
      return transaction(() => {
        const row = requireRule(id);
        const nowIso = isoOf(nowMs);
        db.prepare('UPDATE google_rules SET enabled = 0, listening_since_ms = NULL, deleted_at = ?, updated_at = ? WHERE id = ?')
          .run(nowIso, nowIso, id);
        cancelPending('rule_id = ?', [id], nowIso, 'GOOGLE_RULE_DELETED', 'Google rule was deleted before dispatch');
        return ruleValue({ ...row, enabled: 0, listening_since_ms: null, deleted_at: nowIso, updated_at: nowIso });
      });
    },

    getGoogleTriggerState() {
      const row = db.prepare('SELECT state_json FROM google_trigger_state WHERE id = 1').get();
      if (!row) return { accounts: {}, listeners: {}, assistantBucket: {}, lastDigestSlots: {} };
      return normalizeTriggerState(safeParseJson(row.state_json, null));
    },

    saveGoogleTriggerState(state, nowMs = Date.now()) {
      const normalized = normalizeTriggerState(state);
      const nowIso = isoOf(nowMs);
      db.prepare(`INSERT INTO google_trigger_state (id, state_json, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .run(JSON.stringify(normalized), nowIso);
      return normalized;
    },

    updateGoogleRuleRuntime(id, patch) {
      return transaction(() => {
        const row = db.prepare('SELECT runtime_json FROM google_rules WHERE id = ? AND deleted_at IS NULL').get(id);
        if (!row) return null;
        const current = safeParseJson(row.runtime_json, {});
        const next = { ...current, ...patch };
        db.prepare('UPDATE google_rules SET runtime_json = ? WHERE id = ?').run(JSON.stringify(next), id);
        return next;
      });
    },

    enqueueGoogleRuleEvent({
      ruleId,
      ruleName,
      deviceId,
      botId,
      account,
      source,
      eventKey,
      instruction,
      payloadJson,
      occurredAt,
      expiresAt,
      nowMs = Date.now(),
    }) {
      return transaction(() => {
        const rule = requireRule(ruleId);
        if (!rule.enabled) fail('INVALID_STATE', 'Google rule is disabled');
        if (rule.device_id !== deviceId || rule.bot_id !== botId) {
          fail('INVALID_ARGUMENT', 'Rule target does not match event target');
        }
        requireActiveBot(deviceId, botId);
        const nowIso = isoOf(nowMs);
        settlePending('rule_id = ?', [ruleId], nowIso);

        // Durable idempotency: once recorded for (rule_id, event_key), never re-enqueue or re-run side effects.
        const existing = db.prepare('SELECT * FROM google_rule_events WHERE rule_id = ? AND event_key = ?').get(ruleId, eventKey);
        if (existing) {
          return { event: eventValue(existing), created: false };
        }

        const eventId = `grule-evt-${randomUUID()}`;
        const requestId = randomUUID();
        const digest = sha256Hex(payloadJson);
        const resolvedSource = source ?? rule.source;
        const resolvedAccount = (account ?? rule.account).toLowerCase();
        const resolvedName = (ruleName || rule.name).slice(0, 80);
        const occurredIso = typeof occurredAt === 'string' ? occurredAt : isoOf(occurredAt ?? nowMs);
        const expiresIso = typeof expiresAt === 'string'
          ? expiresAt
          : isoOf(nowMs + 24 * 60 * 60 * 1000);
        const alreadyExpired = expiresIso <= nowIso;
        const initialStatus = alreadyExpired
          ? (resolvedSource === 'calendar' ? 'missed' : 'expired')
          : 'pending';
        const initialError = alreadyExpired
          ? JSON.stringify(
            resolvedSource === 'calendar'
              ? { code: 'MEETING_STARTED_WHILE_OFFLINE', message: 'Meeting started before reminder could be dispatched' }
              : { code: 'GOOGLE_EVENT_EXPIRED', message: 'Event expired before dispatch' },
          )
          : null;

        db.prepare(`INSERT INTO google_rule_events
          (id, rule_id, rule_name, device_id, bot_id, account, source, request_id, event_key, payload_digest,
           status, cancel_requested, admission_json, occurred_at, received_at, expires_at, updated_at, error_json, instruction, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            eventId,
            ruleId,
            resolvedName,
            deviceId,
            botId,
            resolvedAccount,
            resolvedSource,
            requestId,
            eventKey,
            digest,
            initialStatus,
            occurredIso,
            nowIso,
            expiresIso,
            nowIso,
            initialError,
            instruction,
            payloadJson,
          );
        const row = db.prepare('SELECT * FROM google_rule_events WHERE id = ?').get(eventId);
        return { event: eventValue(row), created: initialStatus === 'pending' };
      });
    },

    listGoogleRuleEvents(ruleId, { limit = 50, nowMs = Date.now() } = {}) {
      return transaction(() => {
        requireRule(ruleId);
        settlePending('rule_id = ?', [ruleId], isoOf(nowMs));
        const capped = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 50));
        return db.prepare('SELECT * FROM google_rule_events WHERE rule_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?')
          .all(ruleId, capped)
          .map(row => eventValue(row));
      });
    },

    getGoogleRuleEventStats(ruleIds, nowMs = Date.now()) {
      return transaction(() => {
        const stats = new Map();
        if (!Array.isArray(ruleIds) || ruleIds.length === 0) return stats;
        const nowIso = isoOf(nowMs);
        for (const ruleId of ruleIds) {
          settlePending('rule_id = ?', [ruleId], nowIso);
          const counts = db.prepare(`SELECT
            SUM(CASE WHEN status IN ('pending', 'dispatching', 'queued', 'running') THEN 1 ELSE 0 END) AS pending_count,
            SUM(CASE WHEN status IN ('missed', 'expired') THEN 1 ELSE 0 END) AS missed_count
            FROM google_rule_events WHERE rule_id = ?`).get(ruleId);
          const latest = db.prepare('SELECT * FROM google_rule_events WHERE rule_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 1').get(ruleId);
          stats.set(ruleId, {
            pendingCount: Number(counts?.pending_count ?? 0),
            missedCount: Number(counts?.missed_count ?? 0),
            lastDelivery: latest ? {
              eventId: latest.id,
              eventKey: latest.event_key,
              status: latest.status,
              occurredAt: latest.occurred_at,
              receivedAt: latest.received_at,
              updatedAt: latest.updated_at,
              error: latest.error_json === null ? null : safeParseJson(latest.error_json, null),
            } : null,
          });
        }
        return stats;
      });
    },

    cancelGoogleRuleEventsForBot(deviceId, botId, nowMs = Date.now()) {
      delivery.cancelForBot(deviceId, botId, isoOf(nowMs));
    },

    cancelGoogleRuleEventsForAccount(account, code = 'GOOGLE_ACCOUNT_UNAVAILABLE', message = 'Google account is no longer available', nowMs = Date.now()) {
      if (typeof account !== 'string' || !account.trim()) return;
      cancelPending('account = ?', [account.trim().toLowerCase()], isoOf(nowMs), code, message);
    },

    // ---- Proactive Google Assistant Singleton Binding & Events ----

    getGoogleAssistant() {
      const row = db.prepare('SELECT * FROM google_proactive_assistant WHERE id = 1').get();
      return assistantValue(row);
    },

    saveGoogleAssistant(input, nowMs = Date.now()) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        fail('INVALID_ARGUMENT', 'Expected assistant configuration object');
      }
      return transaction(() => {
        const current = db.prepare('SELECT * FROM google_proactive_assistant WHERE id = 1').get();
        if (input.expectedRevision !== undefined) {
          const currentRev = current ? current.revision : 0;
          if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== currentRev) {
            fail('REVISION_CONFLICT', 'Proactive Google assistant revision does not match');
          }
        }
        const deviceId = typeof input.deviceId === 'string' && input.deviceId.trim()
          ? input.deviceId.trim()
          : fail('INVALID_ARGUMENT', 'deviceId is required');
        const botId = typeof input.botId === 'string' && input.botId.trim()
          ? input.botId.trim()
          : fail('INVALID_ARGUMENT', 'botId is required');
        const mode = input.mode === 'dedicated' || input.mode === 'existing'
          ? input.mode
          : fail('INVALID_ARGUMENT', 'mode must be dedicated or existing');
        const enabled = typeof input.enabled === 'boolean' ? input.enabled : true;
        const accounts = normalizeAccountsList(input.accounts);
        if (accounts.length === 0) {
          fail('INVALID_ARGUMENT', 'At least one Google account is required');
        }
        const batchWindowMinutes = input.batchWindowMinutes === undefined ? 10 : input.batchWindowMinutes;
        if (!Number.isInteger(batchWindowMinutes) || batchWindowMinutes < 1 || batchWindowMinutes > 1440) {
          fail('INVALID_ARGUMENT', 'batchWindowMinutes must be an integer between 1 and 1440');
        }
        const digestTimes = input.digestTimes === undefined
          ? []
          : (Array.isArray(input.digestTimes) ? normalizeDigestTimes(input.digestTimes) : fail('INVALID_ARGUMENT', 'Invalid digestTimes'));
        const calendarEnabled = input.calendarEnabled === undefined
          ? true
          : (typeof input.calendarEnabled === 'boolean' ? input.calendarEnabled : fail('INVALID_ARGUMENT', 'calendarEnabled must be boolean'));
        const calendarLeadMinutes = input.calendarLeadMinutes === undefined ? 15 : input.calendarLeadMinutes;
        if (!Number.isInteger(calendarLeadMinutes) || calendarLeadMinutes < 0 || calendarLeadMinutes > 1440) {
          fail('INVALID_ARGUMENT', 'calendarLeadMinutes must be an integer between 0 and 1440');
        }
        const hindsightPrivateMemory = input.hindsightPrivateMemory === undefined
          ? mode === 'dedicated'
          : (typeof input.hindsightPrivateMemory === 'boolean'
            ? input.hindsightPrivateMemory
            : fail('INVALID_ARGUMENT', 'hindsightPrivateMemory must be boolean'));

        const nowIso = isoOf(nowMs);
        const accountsJson = JSON.stringify(accounts);
        const configJson = JSON.stringify({
          batchWindowMinutes,
          digestTimes,
          calendarEnabled,
          calendarLeadMinutes,
          hindsightPrivateMemory,
        });

        if (current) {
          const sameTarget = current.device_id === deviceId && current.bot_id === botId;
          let listeningSinceMs;
          if (!enabled) {
            listeningSinceMs = null;
          } else if (current.enabled && sameTarget && Number.isFinite(current.listening_since_ms)) {
            listeningSinceMs = current.listening_since_ms;
          } else {
            listeningSinceMs = nowMs;
          }
          const nextRevision = (Number.isInteger(current.revision) ? current.revision : 1) + 1;
          db.prepare(`UPDATE google_proactive_assistant
            SET enabled = ?, device_id = ?, bot_id = ?, mode = ?, accounts_json = ?, config_json = ?,
                listening_since_ms = ?, revision = ?, updated_at = ?
            WHERE id = 1`)
            .run(
              enabled ? 1 : 0,
              deviceId,
              botId,
              mode,
              accountsJson,
              configJson,
              listeningSinceMs,
              nextRevision,
              nowIso,
            );
          if (!enabled) {
            cancelPendingAssistant('1 = 1', [], nowIso, 'GOOGLE_ASSISTANT_DISABLED', 'Proactive Google assistant was disabled before dispatch');
          } else if (!sameTarget) {
            cancelPendingAssistant(
              'device_id = ? AND bot_id = ?',
              [current.device_id, current.bot_id],
              nowIso,
              'GOOGLE_ASSISTANT_REBOUND',
              'Proactive Google assistant target Bot was changed before dispatch',
            );
          }
          const prevAccounts = normalizeAccountsList(safeParseJson(current.accounts_json, []));
          const nextSet = new Set(accounts);
          for (const oldAcct of prevAccounts) {
            if (!nextSet.has(oldAcct)) {
              cancelPendingAssistant(
                'account = ?',
                [oldAcct],
                nowIso,
                'GOOGLE_ASSISTANT_ACCOUNT_UNWATCHED',
                'Google account was removed from proactive assistant watch list',
              );
            }
          }
        } else {
          const listeningSinceMs = enabled ? nowMs : null;
          db.prepare(`INSERT INTO google_proactive_assistant
            (id, enabled, device_id, bot_id, mode, accounts_json, config_json, listening_since_ms, runtime_json, revision, created_at, updated_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)`)
            .run(
              enabled ? 1 : 0,
              deviceId,
              botId,
              mode,
              accountsJson,
              configJson,
              listeningSinceMs,
              nowIso,
              nowIso,
            );
        }
        onAssistantChanged?.();
        const saved = db.prepare('SELECT * FROM google_proactive_assistant WHERE id = 1').get();
        return assistantValue(saved);
      });
    },

    removeGoogleAssistant(nowMs = Date.now()) {
      return transaction(() => {
        const current = db.prepare('SELECT * FROM google_proactive_assistant WHERE id = 1').get();
        if (!current) return { removed: false, previous: null };
        const previous = assistantValue(current);
        const nowIso = isoOf(nowMs);
        db.prepare('DELETE FROM google_proactive_assistant WHERE id = 1').run();
        cancelPendingAssistant('1 = 1', [], nowIso, 'GOOGLE_ASSISTANT_REMOVED', 'Proactive Google assistant was removed before dispatch');
        onAssistantChanged?.();
        return { removed: true, previous };
      });
    },

    updateGoogleAssistantRuntime(patch) {
      return transaction(() => {
        const row = db.prepare('SELECT runtime_json FROM google_proactive_assistant WHERE id = 1').get();
        if (!row) return null;
        const current = safeParseJson(row.runtime_json, {});
        const next = { ...current, ...patch };
        db.prepare('UPDATE google_proactive_assistant SET runtime_json = ? WHERE id = 1').run(JSON.stringify(next));
        return next;
      });
    },

    pauseGoogleAssistantForBot(deviceId, botId, reason = 'BOT_UNAVAILABLE', detail = 'Target Bot is unavailable or archived.', nowMs = Date.now()) {
      return transaction(() => {
        const nowIso = isoOf(nowMs);
        cancelPendingAssistant(
          'device_id = ? AND bot_id = ?',
          [deviceId, botId],
          nowIso,
          reason === 'BOT_ARCHIVED' ? 'BOT_ARCHIVED' : 'BOT_NOT_FOUND',
          detail,
        );
        const row = db.prepare('SELECT * FROM google_proactive_assistant WHERE id = 1').get();
        if (!row || row.device_id !== deviceId || row.bot_id !== botId || !row.enabled) {
          return false;
        }
        const currentRuntime = safeParseJson(row.runtime_json, {});
        const nextRuntime = {
          ...currentRuntime,
          status: 'paused_bot_unavailable',
          reason,
          detail,
        };
        const nextRevision = (Number.isInteger(row.revision) ? row.revision : 1) + 1;
        db.prepare(`UPDATE google_proactive_assistant
          SET enabled = 0, listening_since_ms = NULL, runtime_json = ?, revision = ?, updated_at = ?
          WHERE id = 1`)
          .run(JSON.stringify(nextRuntime), nextRevision, nowIso);
        onAssistantChanged?.();
        return true;
      });
    },

    enqueueGoogleAssistantEvent({
      deviceId,
      botId,
      account,
      source,
      routeName,
      eventKey,
      instruction,
      payloadJson,
      occurredAt,
      expiresAt,
      nowMs = Date.now(),
    }) {
      return transaction(() => {
        const assistant = db.prepare('SELECT * FROM google_proactive_assistant WHERE id = 1').get();
        if (!assistant || !assistant.enabled) {
          fail('INVALID_STATE', 'Proactive Google assistant is not enabled');
        }
        if (assistant.device_id !== deviceId || assistant.bot_id !== botId) {
          fail('INVALID_ARGUMENT', 'Assistant target does not match event target');
        }
        if (source !== 'gmail' && source !== 'calendar') {
          fail('INVALID_ARGUMENT', 'source must be gmail or calendar');
        }
        const resolvedAccount = typeof account === 'string' && account.trim()
          ? account.trim().toLowerCase()
          : fail('INVALID_ARGUMENT', 'account is required');
        requireActiveBot(deviceId, botId);
        const nowIso = isoOf(nowMs);
        settlePendingAssistant('1 = 1', [], nowIso);

        // Durable idempotency on event_key: retries never duplicate turns or side effects.
        const existing = db.prepare('SELECT * FROM google_assistant_events WHERE event_key = ?').get(eventKey);
        if (existing) {
          return { event: assistantEventValue(existing), created: false };
        }

        const eventId = `gassist-evt-${randomUUID()}`;
        const requestId = randomUUID();
        const digest = sha256Hex(payloadJson);
        const resolvedName = (typeof routeName === 'string' && routeName.trim() ? routeName.trim() : '邮件与日程管家').slice(0, 80);
        const occurredIso = typeof occurredAt === 'string' ? occurredAt : isoOf(occurredAt ?? nowMs);
        const expiresIso = typeof expiresAt === 'string'
          ? expiresAt
          : isoOf(nowMs + 24 * 60 * 60 * 1000);
        const alreadyExpired = expiresIso <= nowIso;
        const initialStatus = alreadyExpired
          ? (source === 'calendar' ? 'missed' : 'expired')
          : 'pending';
        const initialError = alreadyExpired
          ? JSON.stringify(
            source === 'calendar'
              ? { code: 'MEETING_STARTED_WHILE_OFFLINE', message: 'Meeting started before reminder could be dispatched' }
              : { code: 'GOOGLE_EVENT_EXPIRED', message: 'Event expired before dispatch' },
          )
          : null;

        db.prepare(`INSERT INTO google_assistant_events
          (id, device_id, bot_id, account, source, route_name, request_id, event_key, payload_digest,
           status, cancel_requested, admission_json, occurred_at, received_at, expires_at, updated_at, error_json, instruction, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            eventId,
            deviceId,
            botId,
            resolvedAccount,
            source,
            resolvedName,
            requestId,
            eventKey,
            digest,
            initialStatus,
            occurredIso,
            nowIso,
            expiresIso,
            nowIso,
            initialError,
            instruction,
            payloadJson,
          );
        const row = db.prepare('SELECT * FROM google_assistant_events WHERE id = ?').get(eventId);
        return { event: assistantEventValue(row), created: initialStatus === 'pending' };
      });
    },

    listGoogleAssistantEvents({ limit = 50, nowMs = Date.now() } = {}) {
      return transaction(() => {
        settlePendingAssistant('1 = 1', [], isoOf(nowMs));
        const capped = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 50));
        return db.prepare('SELECT * FROM google_assistant_events ORDER BY received_at DESC, rowid DESC LIMIT ?')
          .all(capped)
          .map(row => assistantEventValue(row));
      });
    },

    cancelGoogleAssistantEventsForBot(deviceId, botId, nowMs = Date.now()) {
      assistantDelivery.cancelForBot(deviceId, botId, isoOf(nowMs));
    },

    cancelGoogleAssistantEventsForAccount(account, code = 'GOOGLE_ACCOUNT_UNAVAILABLE', message = 'Google account is no longer available', nowMs = Date.now()) {
      if (typeof account !== 'string' || !account.trim()) return;
      cancelPendingAssistant('account = ?', [account.trim().toLowerCase()], isoOf(nowMs), code, message);
    },

    getGoogleAssistantEventStats(nowMs = Date.now()) {
      return transaction(() => {
        const nowIso = isoOf(nowMs);
        settlePendingAssistant('1 = 1', [], nowIso);
        const counts = db.prepare(`SELECT
          SUM(CASE WHEN status IN ('pending', 'dispatching', 'queued', 'running') THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN status IN ('missed', 'expired') THEN 1 ELSE 0 END) AS missed_count
          FROM google_assistant_events`).get();
        const latest = db.prepare('SELECT * FROM google_assistant_events ORDER BY received_at DESC, rowid DESC LIMIT 1').get();
        return {
          pendingDeliveryCount: Number(counts?.pending_count ?? 0),
          missedCount: Number(counts?.missed_count ?? 0),
          lastDelivery: latest ? {
            eventId: latest.id,
            eventKey: latest.event_key,
            source: latest.source,
            account: latest.account,
            status: latest.status,
            occurredAt: latest.occurred_at,
            receivedAt: latest.received_at,
            updatedAt: latest.updated_at,
            error: latest.error_json === null ? null : safeParseJson(latest.error_json, null),
          } : null,
        };
      });
    },
  };
}
