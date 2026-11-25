import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import {
  AGY_DELTA_VERSION, hashValue, historyChanged, historyPrefixes, isHistoryAck, semanticMessage,
} from '../center-contract/antigravity-delta.js';

const ROUTING_SECTION = 'host-turn-routing';

/** System deltas and turn routing are configuration, not append-only chat entries. */
export function projectAntigravityHistory(messages, turnContext) {
  const auxiliary = new Set(turnContext?.auxiliaryIndices ?? []);
  const system = [];
  const history = [];
  const notes = [];
  const auxiliaryMessages = [];
  let inputIndex = null;
  let rawInput = turnContext?.inputIndex;
  if (rawInput === undefined) {
    rawInput = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== 'system' && !auxiliary.has(i)) { rawInput = i; break; }
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'system') {
      const next = { ...message };
      if (next.sections && Object.hasOwn(next.sections, ROUTING_SECTION)) {
        const note = next.sections[ROUTING_SECTION];
        if (typeof note === 'string' && note.trim()) notes.push(note.trim());
        next.sections = { ...next.sections };
        delete next.sections[ROUTING_SECTION];
      }
      system.push(next);
      continue;
    }
    if (message.hindsightRecall === true || message.bcContextMaterial === true || message.bcSummaryMaterial === true) {
      throw historyChanged('Automatic memory or Billion Context projection is not supported in this AGY conversation');
    }
    if (auxiliary.has(i)) {
      auxiliaryMessages.push(semanticMessage(message));
      continue;
    }
    if (i === rawInput) inputIndex = history.length;
    history.push(message);
  }
  if (inputIndex === null || inputIndex !== history.length - 1) {
    throw historyChanged('The current input is not the append-only history tail');
  }
  const auxiliaryText = [];
  for (const message of auxiliaryMessages) {
    for (const part of message.content ?? []) {
      if (part.type !== 'text') throw historyChanged('Non-text auxiliary configuration is unsupported');
      auxiliaryText.push(part.text);
    }
  }
  const systemPrompt = [getCurrentSystemPrompt(system), ...auxiliaryText].filter(Boolean).join('\n\n');
  const config = {
    systemPrompt,
    tools: getCurrentTools(system),
    routingPolicy: typeof turnContext?.routingPolicy === 'string' ? turnContext.routingPolicy : '',
  };
  return {
    messages: history,
    config,
    turnContext: { inputIndex, ...(notes.length ? { routeNote: notes.join('\n\n') } : {}) },
  };
}

/** In-memory Host acknowledgements are an optimization; offset zero is restart-safe. */
export function createAntigravityHistoryTransport() {
  const sessions = new Map();
  return {
    prepare(payload) {
      const projected = projectAntigravityHistory(payload.messages, payload.turnContext);
      const configHash = hashValue(projected.config);
      const prefixes = historyPrefixes(projected.messages);
      const previous = sessions.get(payload.sessionId);
      if (previous && (previous.configHash !== configHash ||
          previous.prefixes.length > prefixes.length ||
          previous.prefixes.some((value, i) => value !== prefixes[i]))) {
        throw historyChanged('The Host history or configuration changed');
      }
      const state = { configHash, prefixes, acknowledged: previous?.acknowledged ?? 0 };
      sessions.set(payload.sessionId, state);
      const offset = state.acknowledged;
      const wire = {
        sessionId: payload.sessionId,
        modelId: payload.modelId,
        ...(payload.reasoning !== undefined ? { reasoning: payload.reasoning } : {}),
        delta: {
          version: AGY_DELTA_VERSION,
          offset,
          prefixHash: prefixes[offset],
          configHash,
          ...(offset === 0 ? { config: projected.config } : {}),
          messages: projected.messages.slice(offset),
        },
        turnContext: projected.turnContext,
      };
      const acknowledge = (ack) => {
        if (!isHistoryAck(ack) || ack.configHash !== configHash ||
            ack.offset >= prefixes.length || prefixes[ack.offset] !== ack.prefixHash) {
          throw historyChanged('The Center acknowledged a different history');
        }
        const current = sessions.get(payload.sessionId);
        if (current?.configHash === configHash && current.prefixes[ack.offset] === ack.prefixHash) {
          current.acknowledged = Math.max(current.acknowledged, ack.offset);
        }
      };
      return { payload: wire, acknowledge };
    },
  };
}
