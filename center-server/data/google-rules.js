// Dedicated Center SQLite store for Google Gmail/Calendar trigger rules,
// durable polling cursors/listeners, and idempotent Center->Host event deliveries.
// Shares the Host poll/receipt/stop delivery seam with webhooks without creating
// public bearer webhook routes or forging human messages.

import { createHash, randomUUID } from 'node:crypto';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired', 'missed']);
const progress = { dispatching: 0, queued: 1, running: 2 };
const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const GOOGLE_WORKSPACE_DATA_BOUNDARY = 'google-workspace';
const GOOGLE_WORKSPACE_RULE_SOURCE_TYPE = 'google-workspace-rule';

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
  return { accounts, listeners };
}

export function googleRulesStore(db, transaction) {
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

  const delivery = {
    settlePendingForDevice(deviceId, nowIso) {
      settlePending('device_id = ?', [deviceId], nowIso);
    },
    queryActiveForDevice(deviceId, afterTuple, limit) {
      return db.prepare(`SELECT *, 1 AS stream, rowid AS cursor_rowid FROM google_rule_events
        WHERE device_id = ?
          AND status IN ('pending', 'dispatching', 'queued', 'running')
          ${afterTuple ? 'AND (received_at, 1, rowid) > (?, ?, ?)' : ''}
        ORDER BY received_at, rowid LIMIT ?`)
        .all(deviceId, ...(afterTuple ?? []), limit);
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

  return {
    _delivery: delivery,

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
      if (!row) return { accounts: {}, listeners: {} };
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
  };
}
