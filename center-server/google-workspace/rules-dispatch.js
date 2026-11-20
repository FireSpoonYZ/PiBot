// Internal Center->Host dispatch helper for Google Gmail/Calendar trigger rules.
// Enqueues durably into center.sqlite (google_rule_events) with atomic (rule_id, event_key)
// idempotency and wakes the target Host through the existing webhook-ready SSE + poll/receipt
// channel without forging public bearer webhook routes or human chat messages.

export const DEFAULT_GMAIL_EVENT_TTL_MS = 24 * 60 * 60 * 1000;
// Bounded post-start fire and Host admission grace windows for `minutesBefore: 0`
// calendar reminders so normal timer jitter / polling ticks deliver once to online
// Hosts without creating already-expired rows or relaxing positive-lead expiry.
export const DEFAULT_ZERO_LEAD_FIRE_WINDOW_MS = 90_000;
export const DEFAULT_ZERO_LEAD_ADMISSION_GRACE_MS = 60_000;

export function calendarReminderExpiresAtMs(startMs, minutesBefore, nowMs) {
  if (minutesBefore !== 0) return startMs;
  const latestFire = startMs + DEFAULT_ZERO_LEAD_FIRE_WINDOW_MS;
  return nowMs >= latestFire ? latestFire : Math.max(startMs, nowMs) + DEFAULT_ZERO_LEAD_ADMISSION_GRACE_MS;
}

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function requireText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value;
}

// Sort object keys iteratively without recursion so untrusted email/calendar payloads never overflow the stack.
export function stablePayloadJson(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('INVALID_ARGUMENT', 'Expected payload object');
  }
  const chunks = [];
  const stack = [{ value: payload }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') {
      chunks.push(item);
      continue;
    }
    const value = item.value;
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        fail('INVALID_ARGUMENT', 'Invalid JSON number in payload');
      }
      chunks.push(JSON.stringify(value));
      continue;
    }
    const array = Array.isArray(value);
    const keys = array
      ? Object.keys(value)
      : Object.keys(value).filter(key => value[key] !== undefined).sort();
    chunks.push(array ? '[' : '{');
    stack.push(array ? ']' : '}');
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      const nextValue = value[key];
      stack.push({ value: array && nextValue === undefined ? null : nextValue });
      if (!array) stack.push(`${JSON.stringify(key)}:`);
      if (index > 0) stack.push(',');
    }
  }
  return chunks.join('');
}

function resolveExpiresAtIso(input, nowMs, gmailEventTtlMs) {
  if (typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt))) {
    return new Date(Date.parse(input.expiresAt)).toISOString();
  }
  if (typeof input.expiresAt === 'number' && Number.isFinite(input.expiresAt)) {
    return new Date(input.expiresAt).toISOString();
  }
  const source = input.source ?? input.payload?.source;
  const startMs = input.payload?.startMs;
  if (source === 'calendar' && typeof startMs === 'number' && Number.isFinite(startMs)) {
    const minutesBefore = input.minutesBefore ?? input.payload?.minutesBefore;
    return new Date(calendarReminderExpiresAtMs(startMs, minutesBefore, nowMs)).toISOString();
  }
  return new Date(nowMs + gmailEventTtlMs).toISOString();
}

function isDeviceOnline(bridge, deviceId) {
  if (!bridge || typeof bridge.listDevices !== 'function') return null;
  try {
    const devices = bridge.listDevices();
    if (!Array.isArray(devices)) return null;
    const found = devices.find(entry => entry && entry.deviceId === deviceId);
    return found ? Boolean(found.online) : false;
  } catch {
    return null;
  }
}

/**
 * Creates the internal Center->Host dispatcher for Google trigger rules.
 * `notify` should be wired by center routes to `deviceId => notify(deviceId, 'webhook-ready')`.
 */
export function createGoogleRuleDispatcher({
  store,
  notify,
  bridge,
  now = () => Date.now(),
  gmailEventTtlMs = DEFAULT_GMAIL_EVENT_TTL_MS,
} = {}) {
  if (!store || typeof store.enqueueGoogleRuleEvent !== 'function') {
    fail('INVALID_ARGUMENT', 'store.enqueueGoogleRuleEvent is required');
  }

  return async function dispatch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('INVALID_ARGUMENT', 'Expected dispatch input object');
    }
    const deviceId = requireText(input.deviceId, 'deviceId', 128);
    const botId = requireText(input.botId, 'botId', 128);
    const ruleId = requireText(input.ruleId, 'ruleId', 128);
    const eventKey = requireText(input.eventKey, 'eventKey', 512);
    const instruction = requireText(input.instruction, 'instruction', 8000);
    const payloadJson = stablePayloadJson(input.payload);
    const nowMs = now();
    const occurredAt = typeof input.occurredAt === 'string'
      ? input.occurredAt
      : new Date(
        typeof input.occurredAt === 'number' && Number.isFinite(input.occurredAt)
          ? input.occurredAt
          : (typeof input.payload?.occurredAt === 'number' && Number.isFinite(input.payload.occurredAt)
            ? input.payload.occurredAt
            : nowMs),
      ).toISOString();
    const expiresAt = resolveExpiresAtIso(input, nowMs, gmailEventTtlMs);

    const { event, created } = store.enqueueGoogleRuleEvent({
      ruleId,
      ruleName: typeof input.ruleName === 'string' && input.ruleName.trim() ? input.ruleName.trim().slice(0, 80) : undefined,
      deviceId,
      botId,
      account: typeof input.account === 'string' && input.account.trim() ? input.account.trim().toLowerCase() : undefined,
      source: input.source === 'gmail' || input.source === 'calendar' ? input.source : undefined,
      eventKey,
      instruction,
      payloadJson,
      occurredAt,
      expiresAt,
      nowMs,
    });

    const targetOnline = isDeviceOnline(bridge, deviceId);
    if (created && event.status === 'pending') {
      notify?.(deviceId);
    }

    return {
      eventId: event.id,
      requestId: event.requestId,
      status: event.status,
      created,
      targetOnline,
    };
  };
}
