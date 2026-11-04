import path from 'node:path';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { piMessagesApi } from '@earendil-works/pi-ai/api/pi-messages.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { normalizeHindsightConfig, parseHindsightOptions } from './hindsight-client.js';
import { normalizeRuntimeExtensions, resolveRuntimeExtensions } from './extension-manager.js';
import { readInputObject } from './cli-input.js';

const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// pi 思考档位（pi-ai ModelThinkingLevel）；provider 原生档位差异归模型 thinkingLevelMap。
const MODEL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const COST_RATES = ['input', 'output', 'cacheRead', 'cacheWrite'];
// 已接入的 provider API 工厂；未知 api 显式报错，不静默当 openai-completions。
const PROVIDER_APIS = new Map([
  ['openai-completions', openAICompletionsApi],
  ['openai-responses', openAIResponsesApi],
  ['pi-messages', piMessagesApi],
  ['anthropic-messages', anthropicMessagesApi],
]);
const DEFAULT_PROVIDER_API = 'openai-completions';

function errWithCode(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function invalidArgument(message) {
  return errWithCode(message, 'INVALID_ARGUMENT');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function rejectUnknownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidArgument(`${label} has unknown field: ${key}`);
    }
  }
}

/** Provider baseUrl 仅 http(s)，拒 userinfo/query/fragment；错误不回显 URL。 */
function normalizeProviderBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidArgument('runtime config: provider baseUrl must be an http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw invalidArgument('runtime config: provider baseUrl must be an http(s) URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidArgument('runtime config: provider baseUrl must not contain user info');
  }
  if (url.search !== '' || url.hash !== '') {
    throw invalidArgument('runtime config: provider baseUrl must not contain query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

/** bashPath 允许 bash/bash.exe；Android 另允许精确的 /system/bin/sh，不接受任意 sh.exe。 */
function isShellExecutable(bashPath) {
  const base = path.basename(bashPath).toLowerCase();
  if (base === 'bash' || base === 'bash.exe') return true;
  return process.platform === 'android' && bashPath === '/system/bin/sh';
}

/**
 * 校验执行选项边界：bashPath 与 toolPaths 均可选，仅 undefined 表示未提供；
 * 显式 null 或类型错误一律 INVALID_ARGUMENT。不探测文件存在性——路径是否可用留到实际使用。
 */
export function parseExecutionOptions(options = {}) {
  let bashPath;
  if (options.bashPath !== undefined) {
    if (typeof options.bashPath !== 'string' || options.bashPath.trim() === '' || !path.isAbsolute(options.bashPath)) {
      throw invalidArgument('bashPath must be a non-empty absolute path');
    }
    if (!isShellExecutable(options.bashPath)) {
      throw invalidArgument('bashPath must point to a bash, bash.exe, or /system/bin/sh executable');
    }
    bashPath = options.bashPath;
  }
  let toolPaths;
  if (options.toolPaths !== undefined) {
    if (typeof options.toolPaths !== 'object' || options.toolPaths === null || Array.isArray(options.toolPaths)) {
      throw invalidArgument('toolPaths must be an object');
    }
    toolPaths = {};
    for (const [name, value] of Object.entries(options.toolPaths)) {
      if (name !== 'rg' && name !== 'fd') {
        throw invalidArgument(`toolPaths has unknown tool: ${name}`);
      }
      if (value === undefined) continue;
      if (typeof value !== 'string' || value.trim() === '' || !path.isAbsolute(value)) {
        throw invalidArgument(`toolPaths.${name} must be a non-empty absolute path`);
      }
      toolPaths[name] = value;
    }
  }
  return { bashPath, toolPaths };
}

/**
 * Parse a provider/modelId reference such as "local/model" into
 * { provider, modelId }. The split is on the first "/"; modelId may contain
 * further slashes. Strings are kept exactly as given.
 */
export function parseModelRef(value) {
  if (typeof value !== 'string') throw invalidArgument('modelRef must be a string');
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    throw invalidArgument(`modelRef must be provider/modelId: ${value}`);
  }
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  if (provider.trim() === '' || modelId.trim() === '') {
    throw invalidArgument(`modelRef must be provider/modelId: ${value}`);
  }
  return { provider, modelId };
}

export function normalizeCodemodeFlag(value, fieldName = 'codemode') {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidArgument(`${fieldName} must be a boolean`);
  }
  return value;
}

/** 可选默认思考档位：仅接受已知 pi 档位；undefined/null 表示交给 SDK 默认值。 */
export function normalizeThinkingLevel(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !MODEL_THINKING_LEVELS.includes(value)) {
    throw invalidArgument(`thinkingLevel must be one of ${MODEL_THINKING_LEVELS.join(', ')}`);
  }
  return value;
}

/** cost 四档在 SDK 中必填：缺省补 0；tiers 逐档校验，不透传未知字段。 */
function readCostRates(raw, label) {
  const rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const key of COST_RATES) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw invalidArgument(`${label} ${key} must be a non-negative number`);
    }
    rates[key] = value;
  }
  return rates;
}

function normalizeCost(raw, label) {
  if (raw === undefined) return readCostRates({}, label);
  if (!isPlainObject(raw)) throw invalidArgument(`${label} must be an object`);
  rejectUnknownFields(raw, new Set([...COST_RATES, 'tiers']), label);
  const cost = readCostRates(raw, label);
  if (raw.tiers === undefined) return cost;
  if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) {
    throw invalidArgument(`${label} tiers must be a non-empty array`);
  }
  cost.tiers = raw.tiers.map((tier, index) => {
    const tierLabel = `${label} tiers[${index}]`;
    if (!isPlainObject(tier)) throw invalidArgument(`${tierLabel} must be an object`);
    rejectUnknownFields(tier, new Set([...COST_RATES, 'inputTokensAbove']), tierLabel);
    const inputTokensAbove = tier.inputTokensAbove;
    if (typeof inputTokensAbove !== 'number' || !Number.isFinite(inputTokensAbove) || inputTokensAbove <= 0) {
      throw invalidArgument(`${tierLabel} inputTokensAbove must be a positive number`);
    }
    return { ...readCostRates(tier, tierLabel), inputTokensAbove };
  });
  return cost;
}

/** thinkingLevelMap 键只能是 pi 档位，值为 provider 原生档位字符串或 null（不支持）。 */
function normalizeThinkingLevelMap(raw, label) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) throw invalidArgument(`${label} must be an object`);
  const map = {};
  for (const [level, value] of Object.entries(raw)) {
    if (!MODEL_THINKING_LEVELS.includes(level)) throw invalidArgument(`${label} has unknown level: ${level}`);
    if (value !== null && (typeof value !== 'string' || value.trim() === '')) {
      throw invalidArgument(`${label} ${level} must be a non-empty string or null`);
    }
    map[level] = value;
  }
  return map;
}

/** compat/inputLimits 由 SDK 与原生工具按各自已知字段读取：只校验对象边界，原样交给 SDK。 */
function passThroughObject(value, label) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw invalidArgument(`${label} must be an object`);
  return value;
}

/**
 * 纯运行时配置校验：不读 env/文件/网络；拒未知字段，不悄悄存 apiKey/headers。
 * 扩展配置为 runtime.extensions；legacy runtime.hindsight 仍原样保留在规范化结果里，
 * 两者同时出现属边界歧义，直接拒绝。
 */
export function normalizeRuntimeConfig(raw) {
  if (!isPlainObject(raw)) throw invalidArgument('runtime config must be a JSON object');
  rejectUnknownFields(raw, new Set(['providers', 'defaultModel', 'thinkingLevel', 'hindsight', 'extensions', 'bashPath', 'toolPaths']), 'runtime config');
  if (raw.hindsight !== undefined && raw.extensions !== undefined) {
    throw invalidArgument('runtime config must not set both hindsight and extensions');
  }
  const providers = validateProviders(raw.providers);
  let defaultModel = null;
  if (raw.defaultModel !== undefined && raw.defaultModel !== null) {
    const ref = parseModelRef(raw.defaultModel);
    const provider = providers.find((p) => p.id === ref.provider);
    if (!provider || !provider.models.some((m) => m.id === ref.modelId)) {
      throw errWithCode(`defaultModel not in registered models: ${raw.defaultModel}`, 'MODEL_NOT_FOUND');
    }
    defaultModel = raw.defaultModel;
  }
  const execution = parseExecutionOptions(raw);
  const thinkingLevel = normalizeThinkingLevel(raw.thinkingLevel);
  const normalized = { providers, defaultModel };
  if (thinkingLevel !== undefined) normalized.thinkingLevel = thinkingLevel;
  const hindsight = normalizeHindsightConfig(raw.hindsight);
  const extensions = normalizeRuntimeExtensions(raw.extensions);
  if (hindsight !== undefined) normalized.hindsight = hindsight;
  if (extensions !== undefined) normalized.extensions = extensions;
  if (execution.bashPath !== undefined) normalized.bashPath = execution.bashPath;
  if (execution.toolPaths !== undefined) normalized.toolPaths = execution.toolPaths;
  return normalized;
}

/**
 * 解析运行时配置并构建 pi-ai Models；hindsight 只返回生效启用的配置，凭证也仅此时解析，
 * 另附生效的规范扩展映射供 runtime/控制面使用。
 */
export function parseRuntimeConfig(raw) {
  const normalized = normalizeRuntimeConfig(raw);
  const models = createModels();
  for (const provider of normalized.providers) {
    models.setProvider(buildProvider(provider));
  }
  const extensions = resolveRuntimeExtensions(normalized);
  const hindsight = extensions.hindsight?.enabled ? extensions.hindsight.config : undefined;
  parseHindsightOptions(hindsight);
  return {
    models,
    defaultModel: normalized.defaultModel,
    thinkingLevel: normalized.thinkingLevel,
    bashPath: normalized.bashPath,
    toolPaths: normalized.toolPaths,
    hindsight,
    extensions,
  };
}

/**
 * 读取用户显式 runtime 配置文件（复用 cli-input.readInputObject 的有界读取：
 * 普通文件/1MiB/严格 UTF-8/单纯 JSON 对象），解析并构建 pi-ai Models。
 */
export async function loadRuntimeConfig(file) {
  return parseRuntimeConfig(readInputObject(file));
}

function validateProviders(providers) {
  if (!Array.isArray(providers)) throw invalidArgument('runtime config: providers must be an array');
  const seenProviders = new Set();
  const out = [];
  for (const p of providers) {
    if (!isPlainObject(p)) {
      throw invalidArgument('runtime config: each provider must be an object');
    }
    rejectUnknownFields(p, new Set(['id', 'name', 'api', 'baseUrl', 'apiKeyEnv', 'models']), 'runtime config provider');
    const id = p.id;
    if (typeof id !== 'string' || id.trim() === '' || !id.isWellFormed()) {
      throw invalidArgument('runtime config: provider id must be a non-empty well-formed string');
    }
    if (id.includes('/')) {
      throw invalidArgument(`runtime config: provider id must not contain "/": ${id}`);
    }
    if (seenProviders.has(id)) throw invalidArgument(`runtime config: duplicate provider id: ${id}`);
    seenProviders.add(id);

    const baseUrl = normalizeProviderBaseUrl(p.baseUrl);
    let api;
    if (p.api !== undefined) {
      const requested = typeof p.api === 'string' ? p.api.trim() : '';
      if (!PROVIDER_APIS.has(requested)) {
        throw invalidArgument(`runtime config: provider "${id}" api is not supported: ${requested || typeof p.api}; supported: ${[...PROVIDER_APIS.keys()].join(', ')}`);
      }
      api = requested;
    }
    let apiKeyEnv;
    if (p.apiKeyEnv !== undefined) {
      if (typeof p.apiKeyEnv !== 'string' || !ENV_NAME.test(p.apiKeyEnv)) {
        throw invalidArgument(`runtime config: apiKeyEnv must be a valid environment variable name: ${String(p.apiKeyEnv)}`);
      }
      apiKeyEnv = p.apiKeyEnv;
    }
    if (!Array.isArray(p.models)) throw invalidArgument(`runtime config: provider "${id}" models must be an array`);

    const seenModels = new Set();
    const models = [];
    for (const m of p.models) {
      if (!isPlainObject(m)) {
        throw invalidArgument(`runtime config: each model of provider "${id}" must be an object`);
      }
      rejectUnknownFields(m, new Set(['id', 'name', 'reasoning', 'contextWindow', 'maxTokens', 'input', 'cost', 'compat', 'thinkingLevelMap', 'inputLimits']), 'runtime config model');
      const modelId = m.id;
      if (typeof modelId !== 'string' || modelId.trim() === '' || !modelId.isWellFormed()) {
        throw invalidArgument('runtime config: model id must be a non-empty well-formed string');
      }
      if (seenModels.has(modelId)) throw invalidArgument(`runtime config: duplicate model id in provider "${id}": ${modelId}`);
      seenModels.add(modelId);
      if (m.name !== undefined && (typeof m.name !== 'string' || m.name.trim() === '' || !m.name.isWellFormed())) {
        throw invalidArgument(`runtime config: model "${modelId}" name must be a non-empty string`);
      }
      if (m.reasoning !== undefined && typeof m.reasoning !== 'boolean') {
        throw invalidArgument(`runtime config: model "${modelId}" reasoning must be a boolean`);
      }
      // 仅 undefined 缺省；显式 null 按预算类型拒绝。
      const contextWindow = m.contextWindow !== undefined ? m.contextWindow : DEFAULT_CONTEXT_WINDOW;
      const maxTokens = m.maxTokens !== undefined ? m.maxTokens : DEFAULT_MAX_TOKENS;
      if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
        throw invalidArgument(`runtime config: model "${modelId}" contextWindow must be a positive safe integer`);
      }
      if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
        throw invalidArgument(`runtime config: model "${modelId}" maxTokens must be a positive safe integer`);
      }
      if (maxTokens > contextWindow) {
        throw invalidArgument(`runtime config: model "${modelId}" maxTokens must not exceed contextWindow`);
      }
      // 显式 input 仅接受已知模态且 text 必含；规范顺序固定 text 在前、剩余模态按出现序在后。
      let input;
      if (m.input !== undefined) {
        if (!Array.isArray(m.input) || m.input.length === 0) {
          throw invalidArgument(`runtime config: model "${modelId}" input must be a non-empty array`);
        }
        const normalized = [];
        for (const kind of m.input) {
          if (typeof kind !== 'string' || (kind !== 'text' && kind !== 'image')) {
            // 固定文本：String(kind) 对带 toString 的对象可能自身抛错。
            throw invalidArgument(`runtime config: model "${modelId}" input has unknown kind`);
          }
          if (normalized.includes(kind)) {
            throw invalidArgument(`runtime config: model "${modelId}" input has duplicate kind: ${kind}`);
          }
          normalized.push(kind);
        }
        if (!normalized.includes('text')) {
          throw invalidArgument(`runtime config: model "${modelId}" input must include text`);
        }
        input = ['text', ...normalized.filter((kind) => kind !== 'text')];
      }
      const model = { id: modelId, contextWindow, maxTokens };
      if (m.name !== undefined) model.name = m.name;
      if (m.reasoning !== undefined) model.reasoning = m.reasoning;
      if (input !== undefined) model.input = input;
      model.cost = normalizeCost(m.cost, `runtime config: model "${modelId}" cost`);
      const compat = passThroughObject(m.compat, `runtime config: model "${modelId}" compat`);
      if (compat !== undefined) model.compat = compat;
      const thinkingLevelMap = normalizeThinkingLevelMap(m.thinkingLevelMap, `runtime config: model "${modelId}" thinkingLevelMap`);
      if (thinkingLevelMap !== undefined) model.thinkingLevelMap = thinkingLevelMap;
      const inputLimits = passThroughObject(m.inputLimits, `runtime config: model "${modelId}" inputLimits`);
      if (inputLimits !== undefined) model.inputLimits = inputLimits;
      models.push(model);
    }
    // 规范结果不带 undefined 属性，保证 normalize -> stringify/parse -> normalize 等价。
    const provider = { id, baseUrl, models };
    if (typeof p.name === 'string' && p.name.trim() !== '') provider.name = p.name.trim();
    if (api !== undefined) provider.api = api;
    if (apiKeyEnv !== undefined) provider.apiKeyEnv = apiKeyEnv;
    out.push(provider);
  }
  return out;
}

function resolveProviderApi(providerId, apiKind) {
  const id = apiKind ?? DEFAULT_PROVIDER_API;
  const factory = PROVIDER_APIS.get(id);
  if (!factory) throw invalidArgument(`runtime config: provider "${providerId}" api is not supported: ${id}`);
  return { id, impl: factory() };
}

export function syncModelsFromRuntimeConfig(models, raw) {
  const normalized = normalizeRuntimeConfig(raw);
  models.clearProviders();
  for (const provider of normalized.providers) {
    models.setProvider(buildProvider(provider));
  }
  return normalized;
}

function buildProvider(provider, credential) {
  const resolvedApi = resolveProviderApi(provider.id, provider.api);
  const models = provider.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: resolvedApi.id,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    input: m.input ?? ['text'],
    reasoning: m.reasoning ?? false,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    ...(m.compat === undefined ? {} : { compat: m.compat }),
    ...(m.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: m.thinkingLevelMap }),
    ...(m.inputLimits === undefined ? {} : { inputLimits: m.inputLimits }),
  }));
  return createProvider({
    id: provider.id,
    baseUrl: provider.baseUrl,
    auth: { apiKey: credential === undefined ? createApiKeyAuth(provider.apiKeyEnv) : {
      name: 'Center credential',
      async resolve() {
        if (credential === null) throw errWithCode('center provider credential is unavailable', 'INVALID_STATE');
        return { auth: { apiKey: credential }, source: 'center' };
      },
    } },
    models,
    name: provider.name ?? provider.id,
    api: resolvedApi.impl,
  });
}

function createApiKeyAuth(apiKeyEnv) {
  return {
    name: apiKeyEnv ? 'API key' : 'No key required',
    async resolve() {
      if (!apiKeyEnv) {
        return { auth: { apiKey: 'not-required' }, source: 'keyless' };
      }
      const key = process.env[apiKeyEnv];
      if (key === undefined || key === '') {
        throw new Error(`environment variable ${apiKeyEnv} is not set`);
      }
      return { auth: { apiKey: key }, source: apiKeyEnv };
    },
  };
}

/** Build the registry from the authenticated snapshot; credentials never enter local settings or process.env. */
export function applyCenterModels(snapshot, existingModels) {
  const providers = snapshot.providers.filter((provider) => provider.enabled).map((provider) => ({
    id: provider.id,
    name: provider.name,
    api: provider.api,
    baseUrl: provider.baseUrl,
    models: (snapshot.models[provider.id] ?? []).filter((model) => model.enabled).map(
      ({ enabled, revision, ...model }) => model
    ),
  }));
  const normalized = validateProviders(providers);
  const botModels = {};
  for (const bot of snapshot.bots) {
    const selection = bot.model;
    if (selection.modelRef != null) {
      const ref = parseModelRef(selection.modelRef);
      if (!normalized.find((p) => p.id === ref.provider)?.models.some((m) => m.id === ref.modelId)) {
        throw errWithCode('center selected model is unavailable', 'MODEL_NOT_FOUND');
      }
      const selected = snapshot.providers.find((p) => p.id === ref.provider);
      if (selected.credentialRef !== null && !snapshot.credentials[selected.credentialRef]) {
        throw errWithCode('center provider credential is unavailable', 'INVALID_STATE');
      }
    }
    normalizeThinkingLevel(selection.thinkingLevel);
    normalizeCodemodeFlag(selection.codemode, 'codemode');
    normalizeCodemodeFlag(selection.codemodeOnly, 'codemodeOnly');
    botModels[bot.botId] = selection;
  }
  const built = normalized.map((provider) => {
    const original = snapshot.providers.find((p) => p.id === provider.id);
    let credential;
    if (original.credentialRef !== null) {
      credential = snapshot.credentials[original.credentialRef] ?? null;
    }
    return buildProvider(provider, credential);
  });
  const models = existingModels ?? createModels();
  models.clearProviders();
  for (const provider of built) models.setProvider(provider);
  return { models, botModels };
}

export async function validateCenterProvider({ provider, models, credential }) {
  try {
    const snapshot = { providers: [{ ...provider, enabled: true, credentialRef: credential === undefined ? null : 'probe' }], models: { [provider.id]: models }, bots: [], credentials: { probe: credential } };
    const registry = applyCenterModels(snapshot).models;
    const model = registry.getModels(provider.id)[0];
    if (!model) throw invalidArgument('provider has no enabled model');
    const result = await registry.completeSimple(model, { messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }] }, { signal: AbortSignal.timeout(15000), maxTokens: 8, maxRetries: 0 });
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error('probe failed');
    return { ok: true, message: model.id };
  } catch {
    throw errWithCode('provider probe failed', 'INVALID_ARGUMENT');
  }
}

export async function discoverCenterProviderModels({ provider, credential }) {
  try {
    const result = await discoverProviderModels({ baseUrl: provider.baseUrl, api: provider.api, apiKey: credential });
    return { models: result.models.map((model) => ({ ...model, maxTokens: Math.min(DEFAULT_MAX_TOKENS, model.contextWindow), input: ['text'], enabled: true, revision: 0 })) };
  } catch {
    throw errWithCode('provider discovery failed', 'INVALID_ARGUMENT');
  }
}

/** 只读 chat 模型白名单，六字段投影，按 modelRef UTF-8 字节序排序，无凭证/baseUrl/env。 */
export function describeModelCatalog(models, defaultModel) {
  const entries = [];
  for (const model of models.getModels()) {
    entries.push({
      modelRef: `${model.provider}/${model.id}`,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
    });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.modelRef, 'utf8'), Buffer.from(b.modelRef, 'utf8')));
  return { defaultModel: defaultModel ?? null, models: entries };
}

const NON_CHAT_MODEL_RE = /(?:^|[-_/])(embedding|text-embedding|rerank|whisper|tts|dall-e|moderation|omni-moderation|babbage|davinci)(?:$|[-_/.])/i;

function extractModelRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.models)) return payload.models;
    if (Array.isArray(payload.result)) return payload.result;
  }
  return [];
}

export async function discoverProviderModels(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw modelError('INVALID_ARGUMENT', 'input must be an object');
  }
  const apiKeyEnv = typeof input.apiKeyEnv === 'string' && ENV_NAME.test(input.apiKeyEnv.trim())
    ? input.apiKeyEnv.trim()
    : '';
  const rawKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (apiKeyEnv && rawKey) {
    process.env[apiKeyEnv] = rawKey;
  }
  if (input.syncEnvOnly === true) {
    return { models: [] };
  }
  const baseUrl = normalizeHttpUrl(input.baseUrl, 'baseUrl');
  const token = rawKey || (apiKeyEnv ? (process.env[apiKeyEnv] ?? '') : '');
  const headers = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['x-api-key'] = token;
  }
  if (baseUrl.includes('anthropic.com') || input.api === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
  }

  const candidateUrls = [`${baseUrl}/models`];
  if (!/\/v\d+(?:beta\d*)?(?:\/openai)?$/i.test(baseUrl)) {
    candidateUrls.push(`${baseUrl}/v1/models`);
  }

  let lastError = null;
  let rows = null;
  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastError = new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
        if (res.status === 404 && candidateUrls.length > 1) continue;
        break;
      }
      const json = await res.json();
      rows = extractModelRows(json);
      break;
    } catch (err) {
      lastError = err;
    }
  }

  if (!rows) {
    throw modelError('INVALID_ARGUMENT', `拉取模型失败: ${lastError?.message ?? '无法连接服务商 /models 接口'}`);
  }

  const seen = new Set();
  const discovered = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue;
    let id = typeof item.id === 'string'
      ? item.id.trim()
      : typeof item.name === 'string'
        ? item.name.trim()
        : typeof item.model === 'string'
          ? item.model.trim()
          : '';
    if (!id) continue;
    if (id.startsWith('models/')) id = id.slice('models/'.length);
    if (!id || seen.has(id) || NON_CHAT_MODEL_RE.test(id)) continue;
    seen.add(id);
    const name = typeof item.display_name === 'string' && item.display_name.trim()
      ? item.display_name.trim()
      : typeof item.displayName === 'string' && item.displayName.trim()
        ? item.displayName.trim()
        : id;
    const reasoning = Boolean(
      item.reasoning ||
      /(?:reasoner|[-_/]r1\b|[-_/]o1\b|[-_/]o3\b|[-_/]o4\b|thinking|qwq)/i.test(id),
    );
    const contextWindow = Number.isSafeInteger(item.context_length) && item.context_length > 0
      ? item.context_length
      : Number.isSafeInteger(item.inputTokenLimit) && item.inputTokenLimit > 0
        ? item.inputTokenLimit
        : DEFAULT_CONTEXT_WINDOW;
    discovered.push({ id, name, reasoning, contextWindow });
  }

  return { models: discovered };

}
