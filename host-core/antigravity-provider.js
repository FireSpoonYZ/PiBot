import { createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';

// Mirror center-contract/antigravity.js (host-core bundling forbids imports outside host-core/ and plugins/).
export const ANTIGRAVITY_PROVIDER_ID = 'antigravity';
export const ANTIGRAVITY_API = 'pibot-antigravity-acp';
export const ANTIGRAVITY_STREAM_PATH = '/api/host/antigravity/stream';
export const ANTIGRAVITY_CANCEL_PATH = '/api/host/antigravity/cancel';
export const ANTIGRAVITY_MAX_FRAME_BYTES = 33554432;

const STREAM_EVENT_TYPES = new Set([
  'start',
  'text_start', 'text_delta', 'text_end',
  'thinking_start', 'thinking_delta', 'thinking_end',
  'toolcall_start', 'toolcall_delta', 'toolcall_end',
  'done', 'error',
]);
const DONE_REASONS = new Set(['stop', 'length', 'toolUse', 'deferred']);
const ERROR_REASONS = new Set(['aborted', 'error']);

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertAssistantMessageShape(message, label) {
  if (!isPlainRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
    throw new Error(`Invalid antigravity ${label} message`);
  }
}

export function assertAntigravityStreamEvent(event) {
  if (!isPlainRecord(event) || typeof event.type !== 'string' || !STREAM_EVENT_TYPES.has(event.type)) {
    throw new Error('Invalid antigravity stream event type');
  }
  if (event.type === 'done') {
    if (!DONE_REASONS.has(event.reason)) {
      throw new Error('Invalid antigravity done reason');
    }
    assertAssistantMessageShape(event.message, 'done');
    return event;
  }
  if (event.type === 'error') {
    if (!ERROR_REASONS.has(event.reason)) {
      throw new Error('Invalid antigravity error reason');
    }
    assertAssistantMessageShape(event.error, 'error');
    return event;
  }
  assertAssistantMessageShape(event.partial, 'partial');
  return event;
}

export function createAntigravityErrorEvent(model, error, aborted = false) {
  const reason = aborted ? 'aborted' : 'error';
  return {
    type: 'error',
    reason,
    error: {
      role: 'assistant',
      content: [],
      api: model?.api || ANTIGRAVITY_API,
      provider: model?.provider || ANTIGRAVITY_PROVIDER_ID,
      model: model?.id || '',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reason,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

export function createAntigravityProvider({ provider, models: savedModels, streamAntigravity }) {
  if (!provider || provider.id !== ANTIGRAVITY_PROVIDER_ID) {
    throw new Error(`Antigravity provider id must be "${ANTIGRAVITY_PROVIDER_ID}"`);
  }
  if (provider.api !== ANTIGRAVITY_API) {
    throw new Error(`Antigravity provider API must be "${ANTIGRAVITY_API}"`);
  }
  const models = (savedModels ?? []).map((model) => {
    const { enabled, revision, source, ...fields } = model;
    const api = fields.api || provider.api;
    if (api !== ANTIGRAVITY_API) {
      throw new Error(`Antigravity model "${model.id}" API must be "${ANTIGRAVITY_API}"`);
    }
    return {
      ...fields,
      id: model.id,
      name: fields.name || model.id,
      provider: ANTIGRAVITY_PROVIDER_ID,
      api: ANTIGRAVITY_API,
      baseUrl: fields.baseUrl || provider.baseUrl || '',
      input: fields.input ?? ['text'],
      reasoning: fields.reasoning ?? false,
      cost: fields.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: fields.contextWindow,
      maxTokens: fields.maxTokens,
      headers: { ...(provider.headers ?? {}), ...(fields.headers ?? {}) },
    };
  });

  const streamImpl = (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (typeof streamAntigravity !== 'function') {
          throw new Error('Antigravity center stream is unavailable');
        }
        if (!model || model.provider !== ANTIGRAVITY_PROVIDER_ID || model.api !== ANTIGRAVITY_API) {
          throw new Error(`Unsupported antigravity model API: ${model?.api ?? 'unknown'}`);
        }
        const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : '';
        if (!sessionId.trim()) {
          throw new Error('Antigravity stream requires a non-empty options.sessionId');
        }
        if (options?.signal?.aborted) {
          eventStream.push(createAntigravityErrorEvent(model, new Error('Request was aborted'), true));
          return;
        }
        const { messages } = normalizeContext(context);
        let payload = {
          sessionId,
          modelId: model.id,
          messages,
          ...(model.reasoning && options?.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
        };
        const nextPayload = await options?.onPayload?.(payload, model);
        if (nextPayload !== undefined) {
          payload = nextPayload;
        }
        if (options?.signal?.aborted) {
          eventStream.push(createAntigravityErrorEvent(model, new Error('Request was aborted'), true));
          return;
        }
        const source = streamAntigravity(payload, {
          signal: options?.signal,
          model,
          onResponse: options?.onResponse,
          onProviderStreamEvent: options?.onProviderStreamEvent,
        });
        if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
          throw new Error('Antigravity center stream is unavailable');
        }
        let sawTerminal = false;
        for await (const rawEvent of source) {
          const event = assertAntigravityStreamEvent(rawEvent);
          eventStream.push(event);
          if (event.type === 'done' || event.type === 'error') {
            sawTerminal = true;
            return;
          }
        }
        if (!sawTerminal) {
          throw new Error('Antigravity stream ended without a terminal event');
        }
      } catch (error) {
        eventStream.push(createAntigravityErrorEvent(model, error, options?.signal?.aborted ?? false));
      } finally {
        eventStream.end();
      }
    })();
    return eventStream;
  };

  return createProvider({
    id: ANTIGRAVITY_PROVIDER_ID,
    name: provider.name || ANTIGRAVITY_PROVIDER_ID,
    baseUrl: provider.baseUrl,
    headers: provider.headers,
    // Google credentials remain on Center; Host never resolves providerAuth or local env keys.
    auth: {
      apiKey: {
        name: 'PiBot Center Antigravity',
        check() {
          return typeof streamAntigravity === 'function'
            ? { source: 'center', type: 'api_key' }
            : undefined;
        },
        async resolve() {
          return { auth: { apiKey: 'center-managed' }, source: 'center' };
        },
      },
    },
    models,
    api: {
      [ANTIGRAVITY_API]: {
        stream: streamImpl,
        streamSimple: streamImpl,
      },
    },
  });
}
