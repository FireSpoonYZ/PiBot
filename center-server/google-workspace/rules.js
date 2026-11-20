// Center-side Google Gmail & Calendar trigger rules service (`openGoogleRules`).
// Preserves pinned Orca trigger semantics (Gmail history listen-from-now, DMARC sender check,
// Calendar syncToken/410 re-seed/starting-soon timer, per-account/service backoff) while
// adapting to PiBot's Center shared Google account pool, per-(deviceId, botId) rule targeting,
// and durable Center->Host idempotent delivery with offline pending/missed handling.

import {
  calendarReminderExpiresAtMs,
  createGoogleRuleDispatcher,
  DEFAULT_GMAIL_EVENT_TTL_MS,
  DEFAULT_ZERO_LEAD_FIRE_WINDOW_MS,
} from './rules-dispatch.js';
import {
  assertGoogleTrigger,
  classifyCheckError,
  DEFAULT_TICK_MS,
  MAX_ADDRESSES,
  MAX_BACKOFF_MS,
  MAX_FILTER_LENGTH,
  MAX_MINUTES_BEFORE,
  MAX_REMEMBERED_FIRES,
  resolveOrcaTriggerOps,
  SCHEDULE_MAX_AGE_MS,
  SEED_RETRY_MS,
} from './rules-orca.js';

export {
  calendarReminderExpiresAtMs,
  createGoogleRuleDispatcher,
  DEFAULT_ZERO_LEAD_ADMISSION_GRACE_MS,
  DEFAULT_ZERO_LEAD_FIRE_WINDOW_MS,
} from './rules-dispatch.js';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

const SAVE_ALLOWED_FIELDS = new Set([
  'id',
  'name',
  'deviceId',
  'botId',
  'account',
  'source',
  'event',
  'enabled',
  'from',
  'to',
  'subjectContains',
  'label',
  'calendar',
  'minutesBefore',
  'instruction',
]);

const LIST_ALLOWED_FIELDS = new Set(['deviceId', 'botId', 'account', 'enabled']);
const REMOVE_ALLOWED_FIELDS = new Set(['id']);
const EVENTS_ALLOWED_FIELDS = new Set(['ruleId', 'limit']);

function assertPlainObject(value, message = 'Expected an object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ARGUMENT', message);
  }
  return value;
}

function assertAllowedFields(value, allowed) {
  assertPlainObject(value);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('INVALID_ARGUMENT', `Unknown field: ${key}`);
  }
  return value;
}

function requireText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value.trim();
}

function optionalText(value, name, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) fail('INVALID_ARGUMENT', `${name} is too long`);
  return trimmed;
}

function normalizeAddressList(raw, name) {
  if (raw === undefined || raw === null) return undefined;
  let items;
  if (typeof raw === 'string') {
    if (!raw.isWellFormed()) fail('INVALID_ARGUMENT', `Invalid ${name}`);
    items = raw.split(',');
  } else if (Array.isArray(raw)) {
    items = raw;
  } else {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  const normalized = [];
  for (const entry of items) {
    if (typeof entry !== 'string' || !entry.isWellFormed()) {
      fail('INVALID_ARGUMENT', `Invalid ${name} entry`);
    }
    const cleaned = entry.trim().toLowerCase();
    if (!cleaned) continue;
    if (cleaned.length > MAX_FILTER_LENGTH) {
      fail('INVALID_ARGUMENT', `${name} entry is too long`);
    }
    normalized.push(cleaned);
  }
  const unique = [...new Set(normalized)].sort();
  if (unique.length > MAX_ADDRESSES) {
    fail('INVALID_ARGUMENT', `Too many ${name} entries`);
  }
  return unique.length > 0 ? unique : undefined;
}

function defaultRuleName(source, account, minutesBefore) {
  const prefix = source === 'gmail'
    ? 'Google Gmail'
    : `Google Calendar (${minutesBefore}m)`;
  return `${prefix} · ${account}`.slice(0, 80);
}

function listenerKey(deviceId, botId, account) {
  return `${deviceId}\u0000${botId}\u0000${account}`;
}

function findAccountEntry(status, accountKey) {
  if (!status || !Array.isArray(status.accounts)) return null;
  const target = accountKey.toLowerCase();
  return status.accounts.find(
    entry => entry && (
      (typeof entry.email === 'string' && entry.email.toLowerCase() === target)
      || (typeof entry.id === 'string' && entry.id.toLowerCase() === target)
    ),
  ) ?? null;
}

function findServiceEntry(accountEntry, source) {
  if (!accountEntry || !Array.isArray(accountEntry.services)) return null;
  return accountEntry.services.find(entry => entry && entry.service === source) ?? null;
}

function serviceUnavailableInfo(serviceEntry) {
  if (!serviceEntry) return null;
  switch (serviceEntry.state) {
    case 'needs-permission':
      return {
        status: 'paused_service_unavailable',
        reason: 'NEEDS_PERMISSION',
        detail: serviceEntry.detail || 'Google permission for this service has not been granted.',
        enableUrl: serviceEntry.enableUrl ?? null,
      };
    case 'api-disabled':
      return {
        status: 'paused_service_unavailable',
        reason: 'API_DISABLED',
        detail: serviceEntry.detail || 'Required Google API is not enabled in the Cloud project.',
        enableUrl: serviceEntry.enableUrl ?? null,
      };
    case 'blocked-by-admin':
      return {
        status: 'paused_service_unavailable',
        reason: 'BLOCKED_BY_ADMIN',
        detail: serviceEntry.detail || 'Google service is blocked by the organization administrator.',
        enableUrl: serviceEntry.enableUrl ?? null,
      };
    default:
      return null;
  }
}

function toOrcaTarget(rule) {
  const trigger = rule.source === 'gmail'
    ? {
      id: rule.id,
      source: 'gmail',
      event: 'new_email',
      account: rule.account,
      ...(rule.from ? { from: rule.from } : {}),
      ...(rule.to ? { to: rule.to } : {}),
      ...(rule.subjectContains ? { subjectContains: rule.subjectContains } : {}),
      ...(rule.label ? { label: rule.label } : {}),
    }
    : {
      id: rule.id,
      source: 'calendar',
      event: 'starting_soon',
      account: rule.account,
      ...(rule.calendar && rule.calendar !== 'primary' ? { calendar: rule.calendar } : {}),
      minutesBefore: rule.minutesBefore ?? 10,
    };
  return {
    automationId: rule.id,
    ruleId: rule.id,
    ruleName: rule.name,
    deviceId: rule.deviceId,
    botId: rule.botId,
    account: rule.account,
    instruction: rule.instruction,
    listeningSinceMs: rule.listeningSinceMs,
    rule: trigger,
  };
}

export function openGoogleRules({
  store,
  google,
  dispatch,
  notify,
  bridge,
  now = () => Date.now(),
  tickMs = DEFAULT_TICK_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = timer => clearTimeout(timer),
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  clearIntervalFn = timer => clearInterval(timer),
  loadOrca,
  gmailEventTtlMs = DEFAULT_GMAIL_EVENT_TTL_MS,
} = {}) {
  if (!store || typeof store.listGoogleRules !== 'function') {
    fail('INVALID_ARGUMENT', 'Center store with googleRulesStore methods is required');
  }
  if (!google || typeof google.status !== 'function' || typeof google.api !== 'function') {
    fail('INVALID_ARGUMENT', 'google accounts service with status() and api() is required');
  }
  const resolvedDispatch = typeof dispatch === 'function'
    ? dispatch
    : (typeof store.enqueueGoogleRuleEvent === 'function'
      ? createGoogleRuleDispatcher({ store, notify, bridge, now, gmailEventTtlMs })
      : null);
  if (!resolvedDispatch) {
    fail('INVALID_ARGUMENT', 'dispatch function or store.enqueueGoogleRuleEvent is required');
  }

  let started = false;
  let stopped = false;
  let checking = false;
  let inflightTick = null;
  let intervalHandle = null;
  let opsPromise = null;

  // Per `${account} ${service}` backoff state (isolated so one rate limit never pauses another).
  const backoff = new Map();
  // Per `${account} ${calendarId}` upcoming schedule cache (rebuilt on change or every 30 min).
  const schedules = new Map();
  // Per `${account} ${calendarId}` failed seed timestamp (for huge calendars).
  const seedFailedAt = new Map();
  // Pending `fireWhenDue` timers keyed by `${ruleId} ${eventKey}`.
  const timers = new Map();
  // Bounded in-memory dedupe fast-path; durable SQLite UNIQUE(rule_id, event_key) backs restarts.
  const fired = new Set();

  function getOps() {
    if (!opsPromise) opsPromise = resolveOrcaTriggerOps(loadOrca);
    return opsPromise;
  }

  function clearTimersMatching(predicate) {
    for (const [key, entry] of timers.entries()) {
      if (predicate(entry)) {
        clearTimer(entry.handle);
        timers.delete(key);
      }
    }
  }

  function clearRuleRuntimeCaches(ruleId) {
    clearTimersMatching(entry => entry.ruleId === ruleId);
    const prefix = `${ruleId} `;
    for (const key of fired) {
      if (key.startsWith(prefix)) fired.delete(key);
    }
  }

  function clearAllTimers() {
    if (intervalHandle !== null) {
      clearIntervalFn(intervalHandle);
      intervalHandle = null;
    }
    for (const entry of timers.values()) {
      clearTimer(entry.handle);
    }
    timers.clear();
  }

  async function safeGoogleStatus() {
    try {
      return await google.status();
    } catch {
      return null;
    }
  }

  function listOnlineDeviceIds() {
    if (!bridge || typeof bridge.listDevices !== 'function') return null;
    try {
      const devices = bridge.listDevices();
      if (!Array.isArray(devices)) return null;
      return new Set(devices.filter(d => d && d.online).map(d => d.deviceId));
    } catch {
      return null;
    }
  }

  function isBotActive(deviceId, botId, botCache) {
    let bots = botCache.get(deviceId);
    if (!bots) {
      bots = typeof store.listDeviceBots === 'function' ? store.listDeviceBots(deviceId) : [];
      botCache.set(deviceId, bots);
    }
    const found = bots.find(bot => bot && bot.botId === botId);
    return Boolean(found && !found.archivedAt);
  }

  function presentRule(rule, { googleStatus, eventStats, onlineDevices, botCache, nowMs }) {
    const stat = eventStats?.get(rule.id) ?? { pendingCount: 0, missedCount: 0, lastDelivery: null };
    const persisted = rule.runtimeState && typeof rule.runtimeState === 'object' ? rule.runtimeState : {};
    const bKey = `${rule.account} ${rule.source}`;
    const liveBackoff = backoff.get(bKey);
    const backoffActive = Boolean(liveBackoff && nowMs < liveBackoff.until);

    let status = 'running';
    let reason = null;
    let detail = null;
    let enableUrl = null;
    let rateLimited = false;
    let backoffUntil = null;

    if (!rule.enabled) {
      status = 'paused_disabled';
      reason = 'RULE_DISABLED';
      detail = 'Rule is paused.';
    } else if (!isBotActive(rule.deviceId, rule.botId, botCache)) {
      status = 'paused_bot_unavailable';
      reason = 'BOT_UNAVAILABLE';
      detail = 'Target Bot is unavailable or archived.';
    } else if (googleStatus) {
      const accountEntry = findAccountEntry(googleStatus, rule.account);
      if (!accountEntry) {
        status = 'paused_account_missing';
        reason = 'ACCOUNT_NOT_FOUND';
        detail = 'Google account is no longer connected.';
      } else if (accountEntry.status !== 'connected') {
        status = 'paused_account_reconnect';
        reason = 'RECONNECT_REQUIRED';
        detail = 'Google account needs reconnection.';
      } else {
        const svcIssue = serviceUnavailableInfo(findServiceEntry(accountEntry, rule.source));
        if (svcIssue) {
          status = svcIssue.status;
          reason = svcIssue.reason;
          detail = svcIssue.detail;
          enableUrl = svcIssue.enableUrl;
        } else if (backoffActive) {
          status = liveBackoff.status;
          reason = liveBackoff.reason;
          detail = liveBackoff.detail;
          rateLimited = liveBackoff.rateLimited;
          backoffUntil = new Date(liveBackoff.until).toISOString();
        }
      }
    } else if (backoffActive) {
      status = liveBackoff.status;
      reason = liveBackoff.reason;
      detail = liveBackoff.detail;
      rateLimited = liveBackoff.rateLimited;
      backoffUntil = new Date(liveBackoff.until).toISOString();
    } else if (typeof persisted.status === 'string' && persisted.status !== 'running') {
      status = persisted.status;
      reason = persisted.reason ?? null;
      detail = persisted.detail ?? null;
      enableUrl = persisted.enableUrl ?? null;
      rateLimited = Boolean(persisted.rateLimited);
      backoffUntil = persisted.backoffUntil ?? null;
    }

    const targetOnline = onlineDevices === null ? null : onlineDevices.has(rule.deviceId);
    return {
      id: rule.id,
      name: rule.name,
      deviceId: rule.deviceId,
      botId: rule.botId,
      account: rule.account,
      source: rule.source,
      event: rule.event,
      enabled: rule.enabled,
      ...(rule.source === 'gmail' ? {
        ...(rule.from ? { from: rule.from } : {}),
        ...(rule.to ? { to: rule.to } : {}),
        ...(rule.subjectContains ? { subjectContains: rule.subjectContains } : {}),
        ...(rule.label ? { label: rule.label } : {}),
      } : {
        calendar: rule.calendar ?? 'primary',
        minutesBefore: rule.minutesBefore ?? 10,
      }),
      instruction: rule.instruction,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
      listeningSince: Number.isFinite(rule.listeningSinceMs) ? new Date(rule.listeningSinceMs).toISOString() : null,
      runtime: {
        status,
        reason,
        detail,
        enableUrl,
        lastCheckedAt: persisted.lastCheckedAt ?? null,
        lastEventAt: persisted.lastEventAt ?? null,
        backoffUntil,
        rateLimited,
        targetOnline,
        pendingCount: stat.pendingCount,
        missedCount: stat.missedCount,
        lastDelivery: stat.lastDelivery,
      },
    };
  }

  function updateTargetsRuntime(targets, patch) {
    if (typeof store.updateGoogleRuleRuntime !== 'function') return;
    for (const target of targets) {
      store.updateGoogleRuleRuntime(target.ruleId, patch);
    }
  }

  async function fire(target, runEvent, extra = {}) {
    const id = `${target.ruleId} ${runEvent.key}`;
    if (fired.has(id)) return true;
    fired.add(id);
    if (fired.size > MAX_REMEMBERED_FIRES) {
      fired.delete(fired.values().next().value ?? '');
    }
    const payload = {
      kind: 'google_rule_event',
      ruleId: target.ruleId,
      source: runEvent.source,
      event: runEvent.event,
      eventKey: runEvent.key,
      account: target.account,
      occurredAt: runEvent.occurredAt,
      place: runEvent.place,
      ...(runEvent.subject ? { subject: runEvent.subject } : {}),
      ...(runEvent.actor ? { actor: runEvent.actor } : {}),
      ...(runEvent.url ? { url: runEvent.url } : {}),
      text: runEvent.text,
      google: runEvent.google,
      ...(extra.startMs !== undefined ? { startMs: extra.startMs } : {}),
      ...(extra.calendarId ? { calendarId: extra.calendarId } : {}),
      ...(extra.minutesBefore !== undefined ? { minutesBefore: extra.minutesBefore } : {}),
    };
    try {
      await resolvedDispatch({
        deviceId: target.deviceId,
        botId: target.botId,
        ruleId: target.ruleId,
        ruleName: target.ruleName,
        account: target.account,
        source: runEvent.source,
        eventKey: runEvent.key,
        instruction: target.instruction,
        payload,
        occurredAt: runEvent.occurredAt,
        ...(extra.expiresAt ? { expiresAt: extra.expiresAt } : {}),
      });
      if (typeof store.updateGoogleRuleRuntime === 'function') {
        store.updateGoogleRuleRuntime(target.ruleId, {
          lastEventAt: new Date(now()).toISOString(),
        });
      }
      return true;
    } catch (error) {
      fired.delete(id);
      console.warn('[google-rules] dispatch failed; will retry on next check', error?.code ?? error?.message ?? error);
      return false;
    }
  }

  async function guarded(account, service, targets, nowMs, work) {
    const key = `${account} ${service}`;
    const paused = backoff.get(key);
    if (paused && nowMs < paused.until) {
      return;
    }
    try {
      await work();
      backoff.delete(key);
      updateTargetsRuntime(targets, {
        status: 'running',
        reason: null,
        detail: null,
        enableUrl: null,
        rateLimited: false,
        backoffUntil: null,
        lastCheckedAt: new Date(nowMs).toISOString(),
      });
    } catch (error) {
      const failures = (paused?.failures ?? 0) + 1;
      const classified = classifyCheckError(error);
      const delayMs = Math.min(classified.baseBackoffMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
      const until = nowMs + delayMs;
      backoff.set(key, {
        failures,
        until,
        status: classified.status,
        reason: classified.reason,
        detail: classified.detail,
        rateLimited: classified.rateLimited,
      });
      updateTargetsRuntime(targets, {
        status: classified.status,
        reason: classified.reason,
        detail: classified.detail,
        enableUrl: null,
        rateLimited: classified.rateLimited,
        backoffUntil: new Date(until).toISOString(),
        lastCheckedAt: new Date(nowMs).toISOString(),
      });
      if (failures === 1) {
        console.warn(`[google-rules] ${service} check for ${account} failed (${classified.reason}); backing off`);
      }
    }
  }

  async function checkGmail(ops, account, targets, state, nowMs) {
    const saved = (state.accounts[account] ??= {});
    const api = await google.api(account);
    if (!saved.historyId) {
      saved.historyId = await ops.gmailHistoryNow(api);
      return;
    }
    const changes = await ops.gmailChangesSince(api, saved.historyId);
    if (changes.kind === 'seeded') {
      saved.historyId = changes.historyId;
      console.warn(`[google-rules] Gmail history for ${account} expired; listening from now`);
      return;
    }
    if (changes.skipped > 0) {
      console.warn(`[google-rules] skipped ${changes.skipped} older new messages for ${account}`);
    }
    // Fetched before historyId advances so a 429 or error retries the same mail next tick.
    const labels = targets.some(target => target.rule.label) ? await ops.gmailLabelIds(api) : null;
    let allDispatched = true;
    for (const mail of changes.mail) {
      for (const target of targets) {
        const lKey = listenerKey(target.deviceId, target.botId, account);
        const listenerSince = state.listeners[lKey] ?? nowMs;
        const ruleSince = Number.isFinite(target.listeningSinceMs) ? target.listeningSinceMs : 0;
        const since = Math.max(listenerSince, ruleSince);
        if (mail.at >= since && ops.gmailRuleMatches(target.rule, mail, labels)) {
          const runEvent = ops.gmailRunEvent(target, mail);
          const ok = await fire(target, runEvent);
          allDispatched = ok && allDispatched;
        }
      }
    }
    // Advance cursor only after every matched dispatch was durably accepted.
    if (allDispatched) {
      saved.historyId = changes.historyId;
    }
  }

  function isCalendarPastFireWindow(minutesBefore, startMs, nowMs) {
    return minutesBefore === 0
      ? nowMs >= startMs + DEFAULT_ZERO_LEAD_FIRE_WINDOW_MS
      : nowMs >= startMs;
  }

  function isCalendarDueNow(minutesBefore, startMs, dueAt, nowMs) {
    if (nowMs < dueAt) return false;
    return !isCalendarPastFireWindow(minutesBefore, startMs, nowMs);
  }

  function buildCalendarExtra(target, calendarId, event, firedAtMs) {
    return {
      startMs: event.startMs,
      calendarId,
      minutesBefore: target.rule.minutesBefore,
      expiresAt: new Date(calendarReminderExpiresAtMs(event.startMs, target.rule.minutesBefore, firedAtMs)).toISOString(),
    };
  }

  async function getCalendarSchedule(ops, api, account, calendarId, savedCal, nowMs, lookbackMs = 0) {
    const key = `${account} ${calendarId}`;
    let changed = false;
    if (savedCal.syncToken || nowMs - (seedFailedAt.get(key) ?? -Infinity) >= SEED_RETRY_MS) {
      const synced = await ops.calendarChangedSince(api, calendarId, savedCal.syncToken);
      changed = synced.changed;
      if (synced.syncToken) {
        savedCal.syncToken = synced.syncToken;
      } else {
        delete savedCal.syncToken;
        seedFailedAt.set(key, nowMs);
      }
    }
    const queryFromMs = lookbackMs > 0 ? nowMs - lookbackMs : nowMs;
    const built = schedules.get(key);
    if (
      built
      && !changed
      && nowMs - built.builtAt < SCHEDULE_MAX_AGE_MS
      && built.queryFromMs <= queryFromMs
    ) {
      return built.events;
    }
    const events = await ops.upcomingEvents(api, calendarId, queryFromMs);
    schedules.set(key, { builtAt: nowMs, queryFromMs, events });
    return events;
  }

  async function fireWhenDue(ops, target, calendarId, event, nowMs) {
    const minutesBefore = target.rule.minutesBefore;
    // The lookback is for late ticks, not for replaying meetings that predate this listener.
    if (minutesBefore === 0 && Number.isFinite(target.listeningSinceMs) && event.startMs < target.listeningSinceMs) return;
    if (isCalendarPastFireWindow(minutesBefore, event.startMs, nowMs)) return;
    const dueAt = ops.calendarDueAt(target.rule, event);
    const runEvent = ops.calendarRunEvent(target, event);
    const timerKey = `${target.ruleId} ${runEvent.key}`;
    if (isCalendarDueNow(minutesBefore, event.startMs, dueAt, nowMs)) {
      const existingTimer = timers.get(timerKey);
      if (existingTimer) {
        clearTimer(existingTimer.handle);
        timers.delete(timerKey);
      }
      await fire(target, runEvent, buildCalendarExtra(target, calendarId, event, nowMs));
      return;
    }
    if (stopped || dueAt - nowMs > tickMs || timers.has(timerKey) || fired.has(timerKey)) {
      return;
    }
    const handle = setTimer(() => {
      timers.delete(timerKey);
      if (stopped) return;
      const currentMs = now();
      if (!isCalendarDueNow(minutesBefore, event.startMs, dueAt, currentMs)) return;
      // Re-verify the rule is still enabled with matching lead time before firing a deferred reminder.
      try {
        const latest = store.getGoogleRule(target.ruleId);
        if (!latest || !latest.enabled || latest.minutesBefore !== minutesBefore) return;
      } catch {
        return;
      }
      void fire(target, runEvent, buildCalendarExtra(target, calendarId, event, currentMs));
    }, dueAt - nowMs);
    handle?.unref?.();
    timers.set(timerKey, { handle, ruleId: target.ruleId, account: target.account });
  }

  async function checkCalendar(ops, account, targets, state, nowMs) {
    const ids = new Set(targets.map(target => target.rule.calendar ?? 'primary'));
    const existingCalendars = state.accounts[account]?.calendars;
    for (const id of Object.keys(existingCalendars ?? {})) {
      if (!ids.has(id)) {
        delete existingCalendars[id];
        schedules.delete(`${account} ${id}`);
      }
    }
    if (ids.size === 0) {
      if (state.accounts[account]) delete state.accounts[account].calendars;
      clearTimersMatching(entry => entry.account === account);
      return;
    }
    const api = await google.api(account);
    const calendars = ((state.accounts[account] ??= {}).calendars ??= {});
    for (const calendarId of ids) {
      const mine = targets.filter(target => (target.rule.calendar ?? 'primary') === calendarId);
      const lookbackMs = mine.some(target => target.rule.minutesBefore === 0)
        ? DEFAULT_ZERO_LEAD_FIRE_WINDOW_MS
        : 0;
      const events = await getCalendarSchedule(
        ops,
        api,
        account,
        calendarId,
        (calendars[calendarId] ??= {}),
        nowMs,
        lookbackMs,
      );
      for (const target of mine) {
        for (const event of events) {
          await fireWhenDue(ops, target, calendarId, event, now());
        }
      }
    }
  }

  async function runCheck() {
    const ops = await getOps();
    let status;
    try {
      status = await google.status();
    } catch (error) {
      console.warn('[google-rules] google.status() failed; keeping existing cursors', error?.code ?? error?.message ?? error);
      return;
    }

    const nowMs = now();
    const rules = store.listGoogleRules();
    const botCache = new Map();
    const activeTargets = [];
    const activeRuleIds = new Set();

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!isBotActive(rule.deviceId, rule.botId, botCache)) {
        store.updateGoogleRuleRuntime?.(rule.id, {
          status: 'paused_bot_unavailable',
          reason: 'BOT_UNAVAILABLE',
          detail: 'Target Bot is unavailable or archived.',
          enableUrl: null,
          rateLimited: false,
          backoffUntil: null,
        });
        continue;
      }
      const accountEntry = findAccountEntry(status, rule.account);
      if (!accountEntry) {
        store.updateGoogleRuleRuntime?.(rule.id, {
          status: 'paused_account_missing',
          reason: 'ACCOUNT_NOT_FOUND',
          detail: 'Google account is no longer connected.',
          enableUrl: null,
          rateLimited: false,
          backoffUntil: null,
        });
        store.cancelGoogleRuleEventsForAccount?.(
          rule.account,
          'GOOGLE_ACCOUNT_UNAVAILABLE',
          'Google account is no longer connected',
          nowMs,
        );
        continue;
      }
      if (accountEntry.status !== 'connected') {
        store.updateGoogleRuleRuntime?.(rule.id, {
          status: 'paused_account_reconnect',
          reason: 'RECONNECT_REQUIRED',
          detail: 'Google account needs reconnection.',
          enableUrl: null,
          rateLimited: false,
          backoffUntil: null,
        });
        continue;
      }
      const svcIssue = serviceUnavailableInfo(findServiceEntry(accountEntry, rule.source));
      if (svcIssue) {
        store.updateGoogleRuleRuntime?.(rule.id, {
          status: svcIssue.status,
          reason: svcIssue.reason,
          detail: svcIssue.detail,
          enableUrl: svcIssue.enableUrl,
          rateLimited: false,
          backoffUntil: null,
        });
        continue;
      }
      activeRuleIds.add(rule.id);
      activeTargets.push(toOrcaTarget(rule));
    }

    // Cancel any scheduled timers for rules that are no longer active.
    clearTimersMatching(entry => !activeRuleIds.has(entry.ruleId));

    const state = store.getGoogleTriggerState();
    const before = JSON.stringify(state);

    // Track listeners per (deviceId, botId, account): older mail never starts a newly listening Bot.
    const listening = new Set(
      activeTargets.map(target => listenerKey(target.deviceId, target.botId, target.account)),
    );
    for (const key of listening) {
      state.listeners[key] ??= nowMs;
    }
    for (const key of Object.keys(state.listeners)) {
      if (!listening.has(key)) delete state.listeners[key];
    }

    const activeAccounts = new Set(activeTargets.map(target => target.account));
    for (const account of Object.keys(state.accounts)) {
      if (!activeAccounts.has(account)) {
        delete state.accounts[account];
        backoff.delete(`${account} gmail`);
        backoff.delete(`${account} calendar`);
      }
    }

    for (const account of activeAccounts) {
      if (stopped) break;
      const mine = activeTargets.filter(target => target.account === account);
      const gmail = mine.filter(target => target.rule.source === 'gmail');
      const calendar = mine.filter(target => target.rule.source === 'calendar');
      if (gmail.length === 0) {
        if (state.accounts[account]) delete state.accounts[account].historyId;
        backoff.delete(`${account} gmail`);
      } else {
        await guarded(account, 'gmail', gmail, nowMs, () => checkGmail(ops, account, gmail, state, nowMs));
      }
      if (calendar.length === 0) {
        if (state.accounts[account]) delete state.accounts[account].calendars;
        backoff.delete(`${account} calendar`);
        clearTimersMatching(entry => entry.account === account);
      } else {
        await guarded(account, 'calendar', calendar, nowMs, () => checkCalendar(ops, account, calendar, state, nowMs));
      }
    }

    if (JSON.stringify(state) !== before) {
      store.saveGoogleTriggerState(state, nowMs);
    }
  }

  function tick() {
    if (checking || stopped) return inflightTick ?? Promise.resolve();
    checking = true;
    inflightTick = runCheck()
      .catch(error => {
        console.warn('[google-rules] trigger check failed', error?.code ?? error?.message ?? error);
      })
      .finally(() => {
        checking = false;
        inflightTick = null;
      });
    return inflightTick;
  }

  async function manage(action, input = {}) {
    if (action === 'list') {
      const filter = assertAllowedFields(input ?? {}, LIST_ALLOWED_FIELDS);
      const query = {
        ...(filter.deviceId !== undefined ? { deviceId: optionalText(filter.deviceId, 'deviceId', 128) } : {}),
        ...(filter.botId !== undefined ? { botId: optionalText(filter.botId, 'botId', 128) } : {}),
        ...(filter.account !== undefined ? { account: optionalText(filter.account, 'account', MAX_FILTER_LENGTH)?.toLowerCase() } : {}),
        ...(filter.enabled !== undefined ? { enabled: typeof filter.enabled === 'boolean' ? filter.enabled : fail('INVALID_ARGUMENT', 'Invalid enabled') } : {}),
      };
      const rules = store.listGoogleRules(query);
      const nowMs = now();
      const googleStatus = await safeGoogleStatus();
      const eventStats = typeof store.getGoogleRuleEventStats === 'function'
        ? store.getGoogleRuleEventStats(rules.map(r => r.id), nowMs)
        : new Map();
      const onlineDevices = listOnlineDeviceIds();
      const botCache = new Map();
      return {
        items: rules.map(rule => presentRule(rule, { googleStatus, eventStats, onlineDevices, botCache, nowMs })),
      };
    }

    if (action === 'save') {
      const body = assertAllowedFields(input, SAVE_ALLOWED_FIELDS);
      const id = optionalText(body.id, 'id', 128);
      const existing = id ? store.getGoogleRule(id) : null;

      const source = body.source !== undefined ? body.source : existing?.source;
      if (source !== 'gmail' && source !== 'calendar') {
        fail('INVALID_ARGUMENT', 'source must be gmail or calendar');
      }
      const expectedEvent = source === 'gmail' ? 'new_email' : 'starting_soon';
      if (body.event !== undefined && body.event !== expectedEvent) {
        fail('INVALID_ARGUMENT', `event must be ${expectedEvent} for ${source}`);
      }

      const enabled = body.enabled !== undefined
        ? (typeof body.enabled === 'boolean' ? body.enabled : fail('INVALID_ARGUMENT', 'enabled must be a boolean'))
        : (existing ? existing.enabled : true);

      const deviceId = body.deviceId !== undefined
        ? requireText(body.deviceId, 'deviceId', 128)
        : (existing ? existing.deviceId : fail('INVALID_ARGUMENT', 'deviceId is required'));
      const botId = body.botId !== undefined
        ? requireText(body.botId, 'botId', 128)
        : (existing ? existing.botId : fail('INVALID_ARGUMENT', 'botId is required'));
      const instruction = body.instruction !== undefined
        ? requireText(body.instruction, 'instruction', 8000)
        : (existing ? existing.instruction : fail('INVALID_ARGUMENT', 'instruction is required'));

      const targetChanged = !existing || deviceId !== existing.deviceId || botId !== existing.botId;
      if (targetChanged || enabled) {
        if (bridge?.registry) {
          const device = bridge.registry.get(deviceId);
          if (!device || device.revokedAt !== null || deviceId === bridge.deviceId) {
            fail('NOT_FOUND', 'Device not found');
          }
        }
        if (typeof store.listDeviceBots === 'function') {
          const bot = store.listDeviceBots(deviceId).find(item => item && item.botId === botId);
          if (!bot) fail('BOT_NOT_FOUND', 'Target Bot not found');
          if (bot.archivedAt) fail('BOT_ARCHIVED', 'Target Bot is archived');
        }
      }

      const googleStatus = await safeGoogleStatus();
      const rawAccount = body.account !== undefined
        ? optionalText(body.account, 'account', MAX_FILTER_LENGTH)
        : existing?.account;

      let account;
      if (rawAccount) {
        const matched = findAccountEntry(googleStatus, rawAccount);
        if (matched && typeof matched.email === 'string') {
          account = matched.email.toLowerCase();
        } else {
          const accountChanged = !existing || rawAccount.toLowerCase() !== existing.account.toLowerCase();
          if (googleStatus && (!existing || accountChanged || enabled)) {
            fail('NOT_FOUND', 'Google account not found');
          }
          account = rawAccount.toLowerCase();
        }
      } else {
        const connected = (googleStatus?.accounts ?? []).filter(
          entry => entry && entry.status === 'connected' && typeof entry.email === 'string',
        );
        if (connected.length === 1) {
          account = connected[0].email.toLowerCase();
        } else if (connected.length === 0) {
          fail('INVALID_STATE', 'No connected Google account is available');
        } else {
          fail('INVALID_ARGUMENT', 'Multiple Google accounts are connected; specify account');
        }
      }

      const sameSource = existing && existing.source === source;
      let ruleData;
      if (source === 'gmail') {
        if (body.calendar !== undefined || body.minutesBefore !== undefined) {
          fail('INVALID_ARGUMENT', 'calendar and minutesBefore are not valid for gmail rules');
        }
        const from = body.from !== undefined ? normalizeAddressList(body.from, 'from') : (sameSource ? existing.from : undefined);
        const to = body.to !== undefined ? normalizeAddressList(body.to, 'to') : (sameSource ? existing.to : undefined);
        const subjectContains = body.subjectContains !== undefined
          ? optionalText(body.subjectContains, 'subjectContains', MAX_FILTER_LENGTH)
          : (sameSource ? existing.subjectContains : undefined);
        const label = body.label !== undefined
          ? optionalText(body.label, 'label', MAX_FILTER_LENGTH)
          : (sameSource ? existing.label : undefined);
        assertGoogleTrigger({
          id: id ?? 'new',
          source: 'gmail',
          event: 'new_email',
          account,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(subjectContains ? { subjectContains } : {}),
          ...(label ? { label } : {}),
        });
        const name = body.name !== undefined
          ? (optionalText(body.name, 'name', 80) ?? defaultRuleName('gmail', account))
          : (existing?.name ?? defaultRuleName('gmail', account));
        ruleData = {
          ...(id ? { id } : {}),
          name,
          deviceId,
          botId,
          account,
          source: 'gmail',
          enabled,
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(subjectContains ? { subjectContains } : {}),
          ...(label ? { label } : {}),
          instruction,
        };
      } else {
        if (
          body.from !== undefined
          || body.to !== undefined
          || body.subjectContains !== undefined
          || body.label !== undefined
        ) {
          fail('INVALID_ARGUMENT', 'from, to, subjectContains, and label are not valid for calendar rules');
        }
        const calendar = body.calendar !== undefined
          ? (optionalText(body.calendar, 'calendar', MAX_FILTER_LENGTH) ?? 'primary')
          : (sameSource ? (existing.calendar ?? 'primary') : 'primary');
        const minutesBefore = body.minutesBefore !== undefined
          ? body.minutesBefore
          : (sameSource && Number.isInteger(existing.minutesBefore) ? existing.minutesBefore : 10);
        if (!Number.isInteger(minutesBefore) || minutesBefore < 0 || minutesBefore > MAX_MINUTES_BEFORE) {
          fail('INVALID_ARGUMENT', `minutesBefore must be an integer between 0 and ${MAX_MINUTES_BEFORE}`);
        }
        assertGoogleTrigger({
          id: id ?? 'new',
          source: 'calendar',
          event: 'starting_soon',
          account,
          ...(calendar !== 'primary' ? { calendar } : {}),
          minutesBefore,
        });
        const name = body.name !== undefined
          ? (optionalText(body.name, 'name', 80) ?? defaultRuleName('calendar', account, minutesBefore))
          : (existing?.name ?? defaultRuleName('calendar', account, minutesBefore));
        ruleData = {
          ...(id ? { id } : {}),
          name,
          deviceId,
          botId,
          account,
          source: 'calendar',
          enabled,
          calendar,
          minutesBefore,
          instruction,
        };
      }

      const nowMs = now();
      const saved = store.saveGoogleRule(ruleData, nowMs);
      clearRuleRuntimeCaches(saved.id);
      const eventStats = typeof store.getGoogleRuleEventStats === 'function'
        ? store.getGoogleRuleEventStats([saved.id], nowMs)
        : new Map();
      const onlineDevices = listOnlineDeviceIds();
      const botCache = new Map();
      return {
        rule: presentRule(saved, { googleStatus, eventStats, onlineDevices, botCache, nowMs }),
      };
    }

    if (action === 'remove') {
      const body = assertAllowedFields(input, REMOVE_ALLOWED_FIELDS);
      const id = requireText(body.id, 'id', 128);
      const nowMs = now();
      const removed = store.removeGoogleRule(id, nowMs);
      clearRuleRuntimeCaches(id);
      const googleStatus = await safeGoogleStatus();
      const onlineDevices = listOnlineDeviceIds();
      const botCache = new Map();
      return {
        removed: true,
        id,
        rule: presentRule(removed, { googleStatus, eventStats: new Map(), onlineDevices, botCache, nowMs }),
      };
    }

    if (action === 'events') {
      const body = assertAllowedFields(input, EVENTS_ALLOWED_FIELDS);
      const ruleId = requireText(body.ruleId, 'ruleId', 128);
      const limit = body.limit === undefined
        ? 50
        : (Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 200
          ? body.limit
          : fail('INVALID_ARGUMENT', 'Invalid limit'));
      return {
        items: store.listGoogleRuleEvents(ruleId, { limit, nowMs: now() }),
      };
    }

    fail('INVALID_ARGUMENT', `Unsupported Google rules action: ${String(action)}`);
  }

  function onAccountRemoved(account) {
    if (typeof account !== 'string' || !account.trim()) return;
    const key = account.trim().toLowerCase();
    backoff.delete(`${key} gmail`);
    backoff.delete(`${key} calendar`);
    clearTimersMatching(entry => entry.account === key);
    for (const schedKey of schedules.keys()) {
      if (schedKey.startsWith(`${key} `)) schedules.delete(schedKey);
    }
    const nowMs = now();
    store.cancelGoogleRuleEventsForAccount?.(
      key,
      'GOOGLE_ACCOUNT_REMOVED',
      'Google account was removed before dispatch',
      nowMs,
    );
    const affected = store.listGoogleRules({ account: key });
    for (const rule of affected) {
      if (rule.enabled) {
        store.updateGoogleRuleRuntime?.(rule.id, {
          status: 'paused_account_missing',
          reason: 'ACCOUNT_NOT_FOUND',
          detail: 'Google account was removed from Center.',
          enableUrl: null,
          rateLimited: false,
          backoffUntil: null,
        });
      }
    }
  }

  function onAccountChanged(account) {
    if (typeof account === 'string' && account.trim()) {
      const key = account.trim().toLowerCase();
      backoff.delete(`${key} gmail`);
      backoff.delete(`${key} calendar`);
    } else {
      backoff.clear();
    }
  }

  function start() {
    if (stopped || started) return;
    started = true;
    intervalHandle = setIntervalFn(() => {
      void tick();
    }, tickMs);
    intervalHandle?.unref?.();
    void tick();
  }

  async function close() {
    stopped = true;
    started = false;
    clearAllTimers();
    if (inflightTick) {
      try { await inflightTick; } catch { /* Already logged in tick(). */ }
    }
  }

  return {
    manage,
    start,
    tick,
    onAccountRemoved,
    onAccountChanged,
    close,
  };
}

/**
 * Optional route-mounting helper for the Center integration entry point.
 * Expects `route(method, path, handler, write)` from `center-server/routes.js`
 * (owner auth on GET, owner auth + CSRF on POST, Cache-Control: no-store).
 */
export function registerGoogleRuleRoutes(route, { rules }) {
  route('GET', '/api/google/rules', req => rules.manage('list', {
    ...(req.query?.deviceId !== undefined ? { deviceId: String(req.query.deviceId) } : {}),
    ...(req.query?.botId !== undefined ? { botId: String(req.query.botId) } : {}),
    ...(req.query?.account !== undefined ? { account: String(req.query.account) } : {}),
  }));
  route('POST', '/api/google/rules/save', req => rules.manage('save', req.body), true);
  route('POST', '/api/google/rules/remove', req => rules.manage('remove', req.body), true);
  route('GET', '/api/google/rules/:id/events', req => rules.manage('events', {
    ruleId: req.params.id,
    ...(req.query?.limit !== undefined && req.query.limit !== '' ? { limit: Number(req.query.limit) } : {}),
  }));
}
