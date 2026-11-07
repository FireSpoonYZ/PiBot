import Ajv from 'ajv';
import { builtinProviders } from '../host-core/builtin-providers.js';

const fields = ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning',
  'thinkingLevelMap', 'cost', 'compat', 'inputLimits'];
const validate = new Ajv({ strict: false }).compile({
  type: 'object', required: ['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    name: { type: 'string', minLength: 1 },
    contextWindow: { type: 'integer', minimum: 1 },
    maxTokens: { type: 'integer', minimum: 1 },
    input: { type: 'array', items: { enum: ['text', 'image'] } },
    reasoning: { type: 'boolean' },
    thinkingLevelMap: { type: 'object' }, cost: { type: 'object' },
    compat: { type: 'object' }, inputLimits: { type: 'object' },
  }, additionalProperties: false,
});

export function openModelCatalog({ store, onChange }) {
  const profiles = builtinProviders();
  let status = { source: 'bundled-pi', syncedAt: null, error: null };
  let pending;
  const lifetime = new AbortController();

  function apply(catalog) {
    let providersAdded = 0, modelsAdded = 0;
    for (const profile of profiles) {
      let provider = store.getProvider(profile.id);
      if (!provider) {
        provider = store.putProvider({ id: profile.id, name: profile.name, api: profile.api,
          baseUrl: profile.baseUrl, credentialRef: profile.id + '-api-key', enabled: false }, null);
        providersAdded++;
      }
    }
    for (const provider of store.listProviders()) {
      // An endpoint override keeps the provider's catalog; existing models remain owner-controlled.
      const known = new Set(store.listModels(provider.id).map(model => model.id));
      for (const candidate of catalog[provider.id] ?? []) {
        if (!candidate || typeof candidate !== 'object' || (candidate.type && candidate.type !== 'chat')) continue;
        if (known.has(candidate.id)) continue;
        const model = Object.fromEntries(fields.filter(key => candidate[key] !== undefined).map(key => [key, candidate[key]]));
        if (!validate(model)) continue;
        store.putModel(provider.id, { ...model, enabled: true }, null);
        known.add(model.id);
        modelsAdded++;
      }
    }
    if (providersAdded || modelsAdded) onChange();
    return { providersAdded, modelsAdded };
  }

  let cachedCatalog = Object.fromEntries(profiles.map(profile => [profile.id, profile.models]));
  apply(cachedCatalog);

  async function refresh() {
    try {
      const response = await fetch('https://pi.dev/api/models?types=chat', {
        signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
      });
      if (!response.ok) throw new Error('catalog HTTP ' + response.status);
      const bytes = await response.text();
      if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('catalog exceeds size limit');
      const catalog = JSON.parse(bytes);
      if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || Object.values(catalog).some(models => !Array.isArray(models))) {
        throw new Error('invalid catalog');
      }
      const result = apply(catalog);
      cachedCatalog = catalog;
      status = { source: 'pi.dev', syncedAt: new Date().toISOString(), error: null, ...result };
      return status;
    } catch (error) {
      status = { ...status, error: '目录同步失败，保留已有模型；稍后可手动重试' };
      throw error;
    }
  }
  function sync() {
    pending ??= refresh().finally(() => { pending = null; });
    return pending;
  }
  const timer = setInterval(() => { void sync().catch(() => {}); }, 24 * 60 * 60 * 1000);
  timer.unref();
  return {
    status: () => status, sync, apply: () => apply(cachedCatalog),
    async close() { clearInterval(timer); lifetime.abort(); await pending?.catch(() => {}); },
  };
}
