import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { createProvider } from '@earendil-works/pi-ai/models';
import { getApiProvider } from '@earendil-works/pi-ai/compat';
import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_PROVIDER_ID,
  createAntigravityProvider,
} from './antigravity-provider.js';

// Keep Pi's native stream implementations and protocol-specific behavior intact.
// The Center is authoritative for model metadata and live authentication.
const builtins = new Map(builtinProviders().map(provider => [provider.id, provider]));

function credentialAuth(credential, resolver, providerId) {
  return {
    apiKey: {
      name: 'PiBot Center',
      async resolve(input) {
        if (resolver) {
          // A failed Center request must never silently fall back to a Host-local key.
          const resolved = await resolver(providerId, input.signal);
          if (!resolved?.auth) throw new Error('Center provider authentication is unavailable');
          return resolved;
        }
        if (typeof credential === 'string' && credential) {
          return { auth: { apiKey: credential }, source: 'center' };
        }
        return undefined;
      },
    },
  };
}

export function nativeCenterProvider(provider, savedModels, credential, resolver, streamAntigravity) {
  if (provider.id === ANTIGRAVITY_PROVIDER_ID) {
    return createAntigravityProvider({ provider, models: savedModels, streamAntigravity });
  }
  if (provider.api === ANTIGRAVITY_API || savedModels.some(model => model.api === ANTIGRAVITY_API)) {
    throw new Error(`Unsupported antigravity API for provider "${provider.id}"`);
  }
  const native = builtins.get(provider.id);
  const nativeModels = new Map((native?.getModels() ?? []).map(model => [model.id, model]));
  const models = savedModels.map(model => {
    const original = nativeModels.get(model.id) ?? {};
    const { enabled, revision, source, ...fields } = model;
    const api = fields.api || original.api || provider.api;
    if (!api) throw new Error('Model API is required');
    return {
      ...original,
      ...fields,
      id: model.id,
      provider: provider.id,
      api,
      baseUrl: fields.baseUrl || provider.baseUrl || original.baseUrl || native?.baseUrl,
      headers: { ...(original.headers ?? {}), ...(provider.headers ?? {}), ...(fields.headers ?? {}) },
    };
  });
  const auth = credentialAuth(credential, resolver, provider.id);
  if (native) {
    const nativeApis = new Set(native.getModels().map(model => model.api));
    const dispatch = (model, context, options, simple) => {
      if (nativeApis.has(model.api)) {
        return simple ? native.streamSimple(model, context, options) : native.stream(model, context, options);
      }
      // Pi models.json may introduce a different protocol under a built-in provider.
      // Do not route that model through the provider's original single-API handler.
      const implementation = getApiProvider(model.api);
      if (!implementation) throw new Error('Unsupported custom model API');
      return simple ? implementation.streamSimple(model, context, options) : implementation.stream(model, context, options);
    };
    return {
      ...native,
      name: provider.name || native.name,
      baseUrl: provider.baseUrl || native.baseUrl,
      headers: { ...(native.headers ?? {}), ...(provider.headers ?? {}) },
      auth,
      getModels: () => models,
      getAllModels: () => models,
      refreshModels: undefined,
      // Center already filters the model list according to the connected account.
      filterModels: undefined,
      filterAllModels: undefined,
      stream: (model, context, options) => dispatch(model, context, options, false),
      streamSimple: (model, context, options) => dispatch(model, context, options, true),
    };
  }
  const protocols = [...new Set(models.length ? models.map(model => model.api) : [provider.api || 'openai-completions'])];
  const implementations = Object.fromEntries(protocols.map(id => {
    const impl = getApiProvider(id);
    if (!impl) throw new Error('Unsupported custom provider API');
    return [id, { stream: impl.stream, streamSimple: impl.streamSimple }];
  }));
  return createProvider({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    headers: provider.headers,
    auth,
    models,
    api: implementations,
  });
}
