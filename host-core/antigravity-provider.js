import { createProvider } from '@earendil-works/pi-ai/models';
import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROVIDER_ID,
} from '../center-contract/antigravity.js';
import { createAntigravityRunner } from './antigravity-runner.js';

export {
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_RUN_PATH,
  ANTIGRAVITY_TOOL_RESULT_PATH,
  ANTIGRAVITY_STEER_PATH,
  ANTIGRAVITY_CANCEL_PATH,
  ANTIGRAVITY_MAX_FRAME_BYTES,
  AGY_HISTORY_CHANGED,
} from '../center-contract/antigravity.js';

const unsupportedStream = () => {
  throw new Error('Antigravity provider does not support stateless streamSimple; use runExternalTurn');
};

export function createAntigravityProvider({ provider, models: savedModels, antigravityClient }) {
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

  const built = createProvider({
    id: ANTIGRAVITY_PROVIDER_ID,
    name: provider.name || ANTIGRAVITY_PROVIDER_ID,
    baseUrl: provider.baseUrl,
    headers: provider.headers,
    // Google credentials remain on Center; Host never resolves providerAuth or local env keys.
    auth: {
      apiKey: {
        name: 'PiBot Center Antigravity',
        check() {
          return typeof antigravityClient?.run === 'function'
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
        stream: unsupportedStream,
        streamSimple: unsupportedStream,
      },
    },
  });

  built.runExternalTurn = createAntigravityRunner({ antigravityClient });
  return built;
}
