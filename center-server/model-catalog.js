import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER_ID } from '../center-contract/antigravity.js';

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const ANTIGRAVITY_SYNC_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_RESET_SPEC = {
  name: 'Antigravity (Center agy)',
  api: ANTIGRAVITY_API,
  baseUrl: '',
  credentialRef: null,
};
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
export function openModelCatalog({ store, dataRoot, onChange, antigravity }) {
  const bundled = new Map(builtinProviders().map(profile => [profile.id, profile]));
  let status = { source: 'pi', syncedAt: null, error: null };
  const controller = new AbortController();
  const configPath = join(dataRoot, 'pi-models.json');
  const cachePath = join(dataRoot, 'pi-models-store.json');
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

  function bundledResetSpec(providerId) {
    if (providerId === ANTIGRAVITY_PROVIDER_ID) {
      return { ...ANTIGRAVITY_RESET_SPEC };
    }
    const profile = bundled.get(providerId);
    if (!profile) return null;
    const model = profile.getModels()[0];
    return {
      name: profile.name,
      api: model?.api || 'openai-completions',
      baseUrl: profile.baseUrl ?? '',
      credentialRef: profile.auth?.apiKey ? profile.id + '-api-key' : null,
    };
  }

  function ensureProviderRecord(id, spec) {
    const existing = store.getProvider(id);
    if (existing) {
      // Mark pre-migration builtin records without changing their credentials or custom endpoints.
      if (existing.native !== true) {
        store.putProvider({ ...existing, native: true }, existing.revision);
        return 1;
      }
      return 0;
    }
    store.putProvider({
      id, ...spec,
      native: true, enabled: false, configured: false,
    }, null);
    return 1;
  }

  function ensureProviders() {
    let added = ensureProviderRecord(ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_RESET_SPEC);
    for (const profile of bundled.values()) {
      added += ensureProviderRecord(profile.id, bundledResetSpec(profile.id));
    }
    return added;
  }

  // Pi's models.json customization syntax is retained, including models and
  // modelOverrides. Model metadata edited in the old UI is kept separately.
  function writePiConfig() {
    const providers = {};
    for (const provider of store.listProviders()) {
      // ModelRuntime cannot parse Antigravity's custom ACP API; it is synced separately.
      if (provider.id === ANTIGRAVITY_PROVIDER_ID) continue;
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
  function reconcileProviderModels(providerId, available, bundledModels = new Map()) {
    let modelsAdded = 0, modelsUpdated = 0;
    const existingById = new Map(store.listModels(providerId, { includeRemoved: true }).map(row => [row.id, row]));
    const ids = new Set();
    for (const candidate of available) {
      if (!candidate || typeof candidate !== 'object') continue;
      if (candidate.type && candidate.type !== 'chat') continue;
      if (!candidate.id || typeof candidate.id !== 'string') continue;
      ids.add(candidate.id);
      const current = existingById.get(candidate.id);
      if (current && current.source !== 'catalog') {
        // Older PiBot records lack source markers. Match their former bundled Pi
        // metadata to continue automatic updates, but preserve owner edits.
        const native = bundledModels.get(candidate.id);
        const legacyCatalog = current.source === undefined && native &&
          ['name', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'thinkingLevelMap', 'cost', 'compat', 'inputLimits']
            .every(key => isDeepStrictEqual(current[key], native[key]));
        if (!legacyCatalog) {
          if (current.source !== 'manual') {
            store.putModel(providerId, { ...current, source: 'manual' }, current.revision);
            modelsUpdated++;
          }
          continue;
        }
      }
      const fields = Object.fromEntries(MODEL_FIELDS.filter(key => candidate[key] !== undefined)
        .map(key => [key, candidate[key]]));
      const isRemoved = current?.removed === true;
      const value = {
        ...fields,
        input: fields.input ?? ['text'],
        reasoning: Boolean(fields.reasoning),
        enabled: isRemoved ? false : (current?.enabled ?? true),
        source: 'catalog',
        ...(isRemoved ? { removed: true } : {}),
      };
      if (!current) {
        store.putModel(providerId, value, null);
        modelsAdded++;
      } else {
        const compareKeys = [...MODEL_FIELDS, 'input', 'enabled', 'source', 'removed'];
        const comparable = Object.fromEntries(compareKeys
          .filter(key => current[key] !== undefined).map(key => [key, current[key]]));
        const next = Object.fromEntries(compareKeys
          .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
        if (JSON.stringify(comparable) !== JSON.stringify(next)) {
          store.putModel(providerId, value, current.revision);
          modelsUpdated++;
        }
      }
    }
    // A removed dynamic catalog entry should not remain advertised as usable.
    for (const old of existingById.values()) {
      if (old.source === 'catalog' && old.enabled && !ids.has(old.id)) {
        store.putModel(providerId, { ...old, enabled: false }, old.revision);
        modelsUpdated++;
      }
    }
    return { modelsAdded, modelsUpdated };
  }

  function importModels(runtime) {
    let modelsAdded = 0, modelsUpdated = 0;
    for (const provider of store.listProviders()) {
      if (provider.id === ANTIGRAVITY_PROVIDER_ID) continue;
      const available = runtime.getModels(provider.id);
      const bundledModels = new Map((bundled.get(provider.id)?.getModels() ?? []).map(model => [model.id, model]));
      const delta = reconcileProviderModels(provider.id, available, bundledModels);
      modelsAdded += delta.modelsAdded;
      modelsUpdated += delta.modelsUpdated;
    }
    if (modelsAdded || modelsUpdated) onChange();
    return { modelsAdded, modelsUpdated };
  }

  async function syncAntigravity({ signal } = {}) {
    await ready;
    if (controller.signal.aborted) throw fail('INVALID_STATE', 'Model catalog is closed');
    signal?.throwIfAborted();
    if (typeof antigravity?.catalog !== 'function') {
      throw fail('INVALID_STATE', 'Antigravity catalog is unavailable');
    }
    if (!store.getProvider(ANTIGRAVITY_PROVIDER_ID)) {
      throw fail('NOT_FOUND', 'Antigravity provider not found');
    }
    const signals = [controller.signal, AbortSignal.timeout(ANTIGRAVITY_SYNC_TIMEOUT_MS)];
    if (signal) signals.push(signal);
    const agySignal = AbortSignal.any(signals);
    const available = await antigravity.catalog({ signal: agySignal });
    agySignal.throwIfAborted();
    if (!Array.isArray(available)) {
      throw fail('INVALID_STATE', 'Antigravity returned invalid model catalog');
    }
    const normalized = available
      .filter(item => item && typeof item === 'object' && (!item.type || item.type === 'chat') && typeof item.id === 'string' && item.id.length > 0)
      .map(item => (item.api ? item : { ...item, api: ANTIGRAVITY_API }));
    if (normalized.length === 0) {
      throw fail('INVALID_STATE', 'Antigravity returned no available models');
    }
    const delta = reconcileProviderModels(ANTIGRAVITY_PROVIDER_ID, normalized);
    if (delta.modelsAdded || delta.modelsUpdated) onChange();
    return delta;
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
    const [piRefresh, agySync] = await Promise.allSettled([
      catalog.refresh({ allowNetwork: network, force, signal }),
      // Background/periodic sync isolates Antigravity failures to preserve cached catalog models.
      network
        ? syncAntigravity({ signal }).catch(() => ({ modelsAdded: 0, modelsUpdated: 0 }))
        : Promise.resolve({ modelsAdded: 0, modelsUpdated: 0 }),
    ]);
    if (piRefresh.status === 'rejected') throw piRefresh.reason;
    const outcome = piRefresh.value;
    const agyResult = agySync.status === 'fulfilled' ? agySync.value : { modelsAdded: 0, modelsUpdated: 0 };
    const piResult = importModels(catalog);
    const result = {
      modelsAdded: piResult.modelsAdded + agyResult.modelsAdded,
      modelsUpdated: piResult.modelsUpdated + agyResult.modelsUpdated,
    };
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
    syncAntigravity,
    runtime: async () => { await ready; return catalog; },
    bundledResetSpec,
    hasOAuth: id => Boolean(store.getCredential(piOauthCredentialId(id))?.configured),
    async getAuth(providerId) {
      await ready;
      if (providerId === ANTIGRAVITY_PROVIDER_ID) {
        throw fail('FORBIDDEN', 'Antigravity authentication is managed on the center server');
      }
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
