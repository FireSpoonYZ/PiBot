// Node-only helpers shared by the Host and Center append-only AGY transport.
import { createHash } from 'node:crypto';

export const AGY_DELTA_VERSION = 1;
export const AGY_HISTORY_CHANGED = 'AGY_HISTORY_CHANGED';
export const AGY_EMPTY_PREFIX = createHash('sha256').update('pibot-agy-history-v1').digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const METADATA = new Set([
  'timestamp', 'durationMs', 'usage', 'cost', 'responseId', 'diagnostics',
  'rawStopReason', 'endTurn', 'thinkingLevel',
]);

export function historyChanged(detail = 'The conversation or its configuration changed') {
  return Object.assign(new Error(`${AGY_HISTORY_CHANGED}: ${detail}. Use /clear to start a new Antigravity conversation.`),
    { code: AGY_HISTORY_CHANGED });
}

export function canonicalJson(value) {
  const ancestors = new Set();
  const visit = (item) => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) {
      throw new TypeError('Antigravity history must contain finite, acyclic JSON values');
    }
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) {
      throw new TypeError('Antigravity history contains a non-JSON object');
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return item.map((entry) => entry === undefined ? null : visit(entry));
      const result = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (item[key] !== undefined) result[key] = visit(item[key]);
      }
      return result;
    } finally {
      ancestors.delete(item);
    }
  };
  return JSON.stringify(visit(value));
}

export function hashValue(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function semanticMessage(message) {
  const result = {};
  for (const [key, value] of Object.entries(message)) {
    if (!METADATA.has(key)) result[key] = value;
  }
  if (typeof result.content === 'string') {
    result.content = [{ type: 'text', text: result.content }];
  } else if (Array.isArray(result.content)) {
    result.content = result.content.map((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
      const copy = { ...block };
      if (copy.type === 'text') delete copy.textSignature;
      if (copy.type === 'thinking') delete copy.thinkingSignature;
      if (copy.type === 'toolCall') delete copy.thoughtSignature;
      return copy;
    });
  }
  return result;
}

export function messageHash(message) {
  return hashValue(semanticMessage(message));
}

export function historyPrefixes(messages) {
  const prefixes = [AGY_EMPTY_PREFIX];
  for (const message of messages) {
    prefixes.push(hashValue([prefixes.at(-1), messageHash(message)]));
  }
  return prefixes;
}

export function isHash(value) {
  return typeof value === 'string' && HASH.test(value);
}

export function isHistoryAck(value) {
  return value?.type === 'history_ack' && value.version === AGY_DELTA_VERSION &&
    Number.isSafeInteger(value.offset) && value.offset >= 0 &&
    isHash(value.prefixHash) && isHash(value.configHash);
}

/** The ack records durable transport receipt, never native prompt consumption. */
export function acceptHistoryDelta(previous, delta) {
  if (!delta || delta.version !== AGY_DELTA_VERSION ||
      !Number.isSafeInteger(delta.offset) || delta.offset < 0 ||
      !isHash(delta.prefixHash) || !isHash(delta.configHash) || !Array.isArray(delta.messages)) {
    throw new TypeError('Invalid Antigravity history delta');
  }
  let history = previous;
  if (!history) {
    if (delta.offset !== 0 || delta.prefixHash !== AGY_EMPTY_PREFIX || !delta.config) {
      throw historyChanged('The Center history mapping is missing');
    }
    if (hashValue(delta.config) !== delta.configHash) throw historyChanged('Invalid configuration fingerprint');
    history = { version: AGY_DELTA_VERSION, config: structuredClone(delta.config),
      configHash: delta.configHash, messages: [], prefixes: [AGY_EMPTY_PREFIX] };
  }
  if (history.configHash !== delta.configHash ||
      (delta.config !== undefined && hashValue(delta.config) !== history.configHash)) {
    throw historyChanged('Soul, routing rules, or tool declarations changed');
  }
  if (delta.offset > history.messages.length || history.prefixes[delta.offset] !== delta.prefixHash) {
    throw historyChanged('The accepted history prefix changed');
  }
  const messages = history.messages.slice();
  const prefixes = history.prefixes.slice();
  for (let i = 0; i < delta.messages.length; i++) {
    const index = delta.offset + i;
    const message = delta.messages[i];
    if (!message || message.role === 'system') throw new TypeError('System messages belong to the AGY configuration');
    const nextHash = hashValue([prefixes[index], messageHash(message)]);
    if (index < messages.length) {
      if (prefixes[index + 1] !== nextHash) throw historyChanged('An accepted history entry was edited');
    } else {
      messages.push(structuredClone(message));
      prefixes.push(nextHash);
    }
  }
  const end = delta.offset + delta.messages.length;
  const received = { ...history, messages, prefixes };
  return {
    history: received,
    end,
    ack: { type: 'history_ack', version: AGY_DELTA_VERSION, offset: end,
      prefixHash: prefixes[end], configHash: history.configHash },
  };
}
