// Durable, idempotent Center -> Host dispatch helper for Google Workspace rules.
// Reuses the existing webhook_events inbox and Host poll/receipt/stop-epoch path
// under a reserved `center-internal-google-rule:` route namespace that is blocked
// from all public /api/webhooks/* endpoints and never issues a Bearer token or
// fabricates a human chat message.

import { createHash } from 'node:crypto';
import { INTERNAL_GOOGLE_RULE_ROUTE_PREFIX } from './constants.js';

const MAX_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_ROUTE_NAME_LENGTH = 80;
const MAX_INSTRUCTION_LENGTH = 8000;
const MAX_PAYLOAD_BYTES = 60 * 1024;

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

function requireBoundedId(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH || !value.isWellFormed()) {
    fail('INVALID_ARGUMENT', `Invalid ${name}`);
  }
  return value.trim();
}

function normalizeIdempotencyKey(eventKey) {
  if (typeof eventKey !== 'string' || !eventKey.trim() || !eventKey.isWellFormed()) {
    fail('INVALID_ARGUMENT', 'Invalid eventKey');
  }
  const trimmed = eventKey.trim();
  if (trimmed.length <= MAX_IDEMPOTENCY_KEY_LENGTH) return trimmed;
  return 'sha256:' + createHash('sha256').update(trimmed, 'utf8').digest('hex');
}

function normalizeInstruction(instruction, source) {
  if (typeof instruction === 'string' && instruction.trim() && instruction.isWellFormed()) {
    return instruction.trim().slice(0, MAX_INSTRUCTION_LENGTH);
  }
  const label = source === 'calendar' ? 'calendar reminder' : source === 'gmail' ? 'new email' : 'Google Workspace event';
  return `Handle this triggered Google Workspace ${label}.`;
}

function normalizeRouteName({ ruleName, source }) {
  if (typeof ruleName === 'string' && ruleName.trim() && ruleName.isWellFormed()) {
    return ruleName.trim().slice(0, MAX_ROUTE_NAME_LENGTH);
  }
  if (source === 'calendar') return 'Google Workspace · Calendar';
  if (source === 'gmail') return 'Google Workspace · Gmail';
  return 'Google Workspace Rule';
}

// Non-recursive canonical JSON serialization (safe against deeply nested payloads).
function stableJson(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('INVALID_ARGUMENT', 'Expected payload object');
  }
  const chunks = [];
  const stack = [{ value: payload }];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') {
      chunks.push(item);
      continue;
    }
    const value = item.value;
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        chunks.push('null');
      } else if (value === undefined) {
        chunks.push('null');
      } else {
        chunks.push(JSON.stringify(value));
      }
      continue;
    }
    const array = Array.isArray(value);
    const keys = array
      ? Object.keys(value)
      : Object.keys(value).filter((k) => value[k] !== undefined).sort();
    chunks.push(array ? '[' : '{');
    stack.push(array ? ']' : '}');
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      stack.push({ value: value[key] });
      if (!array) stack.push(JSON.stringify(key) + ':');
      if (index > 0) stack.push(',');
    }
  }
  return chunks.join('');
}

function serializeBoundedPayload(rawPayload, meta) {
  const base = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
    ? { ...rawPayload }
    : { data: rawPayload ?? null };
  const envelope = {
    triggerType: 'google-workspace-rule',
    ruleId: meta.ruleId,
    eventKey: meta.eventKey,
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.account ? { account: meta.account } : {}),
    event: base,
  };
  const serialized = stableJson(envelope);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) return serialized;
  const fallback = stableJson({
    triggerType: 'google-workspace-rule',
    ruleId: meta.ruleId,
    eventKey: meta.eventKey,
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.account ? { account: meta.account } : {}),
    truncated: true,
    preview: serialized.slice(0, 8192),
  });
  return fallback;
}

export function internalRouteIdForRule(ruleId) {
  return INTERNAL_GOOGLE_RULE_ROUTE_PREFIX + requireBoundedId(ruleId, 'ruleId');
}

export function createGoogleRuleDispatcher({ store, notify = () => {} }) {
  if (!store || typeof store.enqueueInternalWebhookEvent !== 'function') {
    throw new Error('store.enqueueInternalWebhookEvent is required');
  }

  async function dispatch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail('INVALID_ARGUMENT', 'Expected dispatch object');
    }
    const deviceId = requireBoundedId(input.deviceId, 'deviceId');
    const botId = requireBoundedId(input.botId, 'botId');
    const ruleId = requireBoundedId(input.ruleId, 'ruleId');
    const idempotencyKey = normalizeIdempotencyKey(input.eventKey);
    const source = input.source === 'gmail' || input.source === 'calendar'
      ? input.source
      : (input.payload?.source === 'gmail' || input.payload?.source === 'calendar' ? input.payload.source : undefined);
    const account = typeof input.account === 'string' && input.account.trim()
      ? input.account.trim()
      : (typeof input.payload?.account === 'string' && input.payload.account.trim() ? input.payload.account.trim() : undefined);
    const instruction = normalizeInstruction(input.instruction, source);
    const routeName = normalizeRouteName({ ruleName: input.ruleName, source });
    const routeId = internalRouteIdForRule(ruleId);
    const payloadJson = serializeBoundedPayload(input.payload, { ruleId, eventKey: idempotencyKey, source, account });

    const { event, created } = store.enqueueInternalWebhookEvent({
      routeId,
      routeName,
      deviceId,
      botId,
      idempotencyKey,
      instruction,
      payloadJson,
    });
    if (created) notify(deviceId);
    return {
      eventId: event.id,
      requestId: event.requestId,
      status: event.status,
      created,
    };
  }

  function cancelRule(ruleId) {
    if (typeof ruleId !== 'string' || !ruleId.trim()) return { cancelled: 0 };
    if (typeof store.cancelInternalWebhookRoute !== 'function') return { cancelled: 0 };
    return store.cancelInternalWebhookRoute(
      internalRouteIdForRule(ruleId),
      'GOOGLE_RULE_REMOVED',
      'Google Workspace rule was removed before dispatch',
    );
  }

  return { dispatch, cancelRule };
}
