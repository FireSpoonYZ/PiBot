import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const MODEL_FIELDS = [
  'id', 'name', 'api', 'baseUrl', 'headers', 'reasoning', 'contextWindow',
  'maxTokens', 'input', 'thinkingLevelMap', 'cost', 'compat', 'inputLimits',
  'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel',
];
const AUTH_PREFIX = 'center-internal-pi-oauth-';
const fail = (code, message) => Object.assign(new Error(message), { code });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function piOauthCredentialId(providerId) {
  if (typeof providerId !== 'string' || !/^[\w.-]{1,128}$/.test(providerId)) {
    throw fail('INVALID_ARGUMENT', 'Invalid provider identifier');
  }
  return AUTH_PREFIX + providerId;
}

/**
 * Adapts Pi's serialized credential-store contract to Center's AES-GCM vault.
 * OAuth refresh tokens never enter device snapshots or owner GET responses.
 */
export function centerPiCredentialStore(store) {
  const tails = new Map();
  const read = async (providerId, options = {}) => {
    options.signal?.throwIfAborted();
    const oauthId = piOauthCredentialId(providerId);
    if (store.getCredential(oauthId)?.configured) {
      const credential = JSON.parse(store.resolveCredential(oauthId));
      if (credential?.type !== 'oauth') throw fail('INVALID_STATE', 'Malformed OAuth credential');
      return credential;
    }
    const ref = store.getProvider(providerId)?.credentialRef;
    if (!ref || !store.getCredential(ref)?.configured) return undefined;
    return { type: 'api_key', key: store.resolveCredential(ref) };
  };
  return {
    read,
    async list(options = {}) {
      options.signal?.throwIfAborted();
      const infos = [];
      for (const p of store.listProviders()) {
        const credential = await read(p.id, options);
        if (credential) infos.push({ providerId: p.id, type: credential.type });
      }
      return infos;
    },
    async modify(providerId, fn, options = {}) {
      const previous = tails.get(providerId) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        options.signal?.throwIfAborted();
        const before = await read(providerId, options);
        const next = await fn(before);
        if (next === undefined) return before;
        if (next.type !== 'oauth') throw fail('INVALID_ARGUMENT', 'Use Provider API Key settings for key credentials');
        const id = piOauthCredentialId(providerId);
        const current = store.getCredential(id);
        store.putCredential(id, { expectedRevision: current?.revision ?? null, value: JSON.stringify(next) });
        return next;
      });
      const tail = task.catch(() => {});
      tails.set(providerId, tail);
      void tail.then(() => { if (tails.get(providerId) === tail) tails.delete(providerId); });
      return task;
    },
    async delete(providerId) {
      const previous = tails.get(providerId) ?? Promise.resolve();
      const task = previous.catch(() => {}).then(() => {
        const id = piOauthCredentialId(providerId);
        const current = store.getCredential(id);
        if (current?.configured) store.deleteCredential(id, current.revision);
      });
      const tail = task.catch(() => {});
      tails.set(providerId, tail);
      void tail.then(() => { if (tails.get(providerId) === tail) tails.delete(providerId); });
      return task;
    },
  };
}

/**
 * Reuse Pi's ModelRuntime: native providers, models.json compatible overrides,
 * cached per-provider pi.dev overlays and credential-specific discovery.
 */
export function openModelCatalog({ store, dataRoot, onChange }) {
  const bundled = new Map(builtinProviders().map(profile => [profile.id, profile]));
  let status = { source: 'pi', syncedAt: null, error: null };
  const controller = new AbortController();
  const configPath = join(dataRoot, 'pi-models.json');
  const cachePath = join(dataRoot, 'pi-models-store.json');
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

  function ensureProviders() {
    let added = 0;
    for (const profile of bundled.values()) {
      const existing = store.getProvider(profile.id);
      if (existing) {
        // Mark pre-migration builtin records without changing their credentials or custom endpoints.
        if (existing.native !== true) {
          store.putProvider({ ...existing, native: true }, existing.revision);
          added++;
        }
        continue;
      }
      const model = profile.getModels()[0];
      store.putProvider({
        id: profile.id, name: profile.name, api: model?.api || 'openai-completions',
        baseUrl: profile.baseUrl ?? '', credentialRef: profile.id + '-api-key',
        native: true, enabled: false,
      }, null);
      added++;
    }
    return added;
  }

  // Pi's models.json customization syntax is retained, including models and
  // modelOverrides. Model metadata edited in the old UI is kept separately.
  function writePiConfig() {
    const providers = {};
    for (const provider of store.listProviders()) {
      const base = bundled.get(provider.id);
      const custom = structuredClone(provider.custom ?? {});
      if (!base) {
        if (!own(custom, 'api')) custom.api = provider.api;
        if (!own(custom, 'baseUrl')) custom.baseUrl = provider.baseUrl;
        if (!own(custom, 'models')) {
          custom.models = store.listModels(provider.id).filter(m => m.source !== 'catalog').map(m =>
            Object.fromEntries(MODEL_FIELDS.filter(key => m[key] !== undefined).map(key => [key, m[key]]))
          );
        }
      } else if (provider.baseUrl && provider.baseUrl !== base.baseUrl && !own(custom, 'baseUrl')) {
        custom.baseUrl = provider.baseUrl;
      }
      if (Object.keys(custom).length) providers[provider.id] = custom;
    }
    writeFileSync(configPath, JSON.stringify({ providers }), { mode: 0o600 });
  }

  const credentialStore = centerPiCredentialStore(store);
  let running;
  let catalog;
  let ready;
  function importModels(runtime) {
    let modelsAdded = 0, modelsUpdated = 0;
    for (const provider of store.listProviders()) {
      const available = runtime.getModels(provider.id);
      const ids = new Set();
      for (const candidate of available) {
        if (candidate.type && candidate.type !== 'chat') continue;
        if (!candidate.id || typeof candidate.id !== 'string') continue;
        ids.add(candidate.id);
        const current = store.listModels(provider.id).find(row => row.id === candidate.id);
        if (current && current.source !== 'catalog') {
          // Legacy models have no source tag. Preserve every existing owner edit on migration.
          if (current.source !== 'manual') {
            store.putModel(provider.id, { ...current, source: 'manual' }, current.revision);
            modelsUpdated++;
          }
          continue;
        }
        const fields = Object.fromEntries(MODEL_FIELDS.filter(key => candidate[key] !== undefined)
          .map(key => [key, candidate[key]]));
        const value = { ...fields, input: fields.input ?? ['text'], reasoning: Boolean(fields.reasoning),
          enabled: current?.enabled ?? true, source: 'catalog' };
        if (!current) {
          store.putModel(provider.id, value, null);
          modelsAdded++;
        } else {
          const comparable = Object.fromEntries([...MODEL_FIELDS, 'input', 'enabled', 'source']
            .filter(key => current[key] !== undefined).map(key => [key, current[key]]));
          const next = Object.fromEntries([...MODEL_FIELDS, 'input', 'enabled', 'source']
            .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
          if (JSON.stringify(comparable) !== JSON.stringify(next)) {
            store.putModel(provider.id, value, current.revision);
            modelsUpdated++;
          }
        }
      }
      // A removed dynamic catalog entry should not remain advertised as usable.
      for (const old of store.listModels(provider.id)) {
        if (old.source === 'catalog' && old.enabled && !ids.has(old.id)) {
          store.putModel(provider.id, { ...old, enabled: false }, old.revision);
          modelsUpdated++;
        }
      }
    }
    if (modelsAdded || modelsUpdated) onChange();
    return { modelsAdded, modelsUpdated };
  }

  ready = (async () => {
    const providersAdded = ensureProviders();
    writePiConfig();
    catalog = await ModelRuntime.create({
      credentials: credentialStore, modelsPath: configPath, modelsStorePath: cachePath,
      allowModelNetwork: false,
    });
    const result = importModels(catalog);
    if (providersAdded) onChange();
    return { providersAdded, ...result };
  })();

  async function refresh({ network = false, force = false } = {}) {
    await ready;
    if (controller.signal.aborted) throw fail('INVALID_STATE', 'Model catalog is closed');
    writePiConfig();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    const outcome = await catalog.refresh({ allowNetwork: network, force, signal });
    const result = importModels(catalog);
    status = { source: network ? 'pi.dev' : 'pi', syncedAt: new Date().toISOString(),
      error: outcome.errors.size ? '部分模型服务商同步失败；保留缓存目录' : null, ...result };
    return status;
  }
  function enqueue(options) {
    running ??= refresh(options).catch(error => {
      status = { ...status, error: '模型目录更新失败；保留已有目录' };
      throw error;
    }).finally(() => { running = null; });
    return running;
  }
  const timer = setInterval(() => { void enqueue({ network: true }).catch(() => {}); }, FOUR_HOURS);
  timer.unref?.();

  return {
    ready,
    status: () => status,
    apply: () => enqueue({ network: false }),
    sync: () => enqueue({ network: true, force: true }),
    runtime: async () => { await ready; return catalog; },
    hasOAuth: id => Boolean(store.getCredential(piOauthCredentialId(id))?.configured),
    async getAuth(providerId) {
      await ready;
      const provider = store.getProvider(providerId);
      if (!provider || !provider.enabled) throw fail('FORBIDDEN', 'Provider is unavailable');
      const result = await catalog.getAuth(providerId);
      if (!result?.auth) throw fail('INVALID_STATE', 'Provider authentication is unavailable');
      return result;
    },
    async close() {
      clearInterval(timer);
      controller.abort();
      await Promise.allSettled([ready, running].filter(Boolean));
    },
  };
}
