// host-core/hindsight-client.js
// Official @vectorize-io/hindsight-client 0.9.2 adapter for Pi Durable.
// The generated SDK (createClient/createConfig/sdk) issues exactly one fetch per
// call and its generated client defaults to redirect:follow; this adapter owns
// the per-instance fetch that restores redirect:error, the 2MiB request/response
// bound, per-operation timeouts and the draining close(), while keeping the
// existing method signatures, DTO checks and stable error codes. No global fetch
// patch, no automatic retries, no mutation replay.
import { createClient, createConfig, sdk } from './client/hindsight-sdk.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024; // request/response UTF-8 bound, 2MiB
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_REFLECT_TIMEOUT_MS = 120_000;
// Upper bound the control transports align their Hindsight deadlines with.
export const HINDSIGHT_MAX_TIMEOUT_MS = 120_000;
// Exact bank-id existence goes through listBanks (q is a substring filter), so
// pagination stays bounded instead of scanning an unbounded bank list.
const BANK_PAGE_LIMIT = 100;
const BANK_MAX_PAGES = 10;

const OPERATION_STATUSES = new Set([
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'not_found',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_SAFE_TOKEN_RE = /^[\x21-\x7E]+$/;

export class HindsightClientError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'HindsightClientError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function clientError(code, message) {
  return new HindsightClientError(code, message);
}

function closedError() {
  return clientError('HINDSIGHT_CLOSED', 'HINDSIGHT_CLOSED');
}

function unavailableError() {
  return clientError('HINDSIGHT_UNAVAILABLE', 'HINDSIGHT_UNAVAILABLE');
}

function protocolError(message = 'HINDSIGHT_PROTOCOL_ERROR') {
  return clientError('HINDSIGHT_PROTOCOL_ERROR', message);
}

function statusError(code, status) {
  return new HindsightClientError(code, code, status);
}

function abortError() {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error) {
  return !!error && typeof error === 'object' && error.name === 'AbortError';
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl must use http or https');
  }
  if (url.username || url.password) {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl must not contain credentials');
  }
  if (url.search || url.hash) {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl must not contain query or fragment');
  }
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      throw clientError('INVALID_ARGUMENT', 'hindsight http baseUrl must target loopback');
    }
  }
  return url.href.replace(/\/+$/, '');
}

function normalizeTimeout(value, name) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > HINDSIGHT_MAX_TIMEOUT_MS
  ) {
    throw clientError(
      'INVALID_ARGUMENT',
      `${name} must be a positive safe integer <= ${HINDSIGHT_MAX_TIMEOUT_MS}`,
    );
  }
  return value;
}

/**
 * 纯 Hindsight 配置校验：不读环境变量/文件/网络。
 * undefined -> undefined；拒 null/非 plain/未知 key；baseUrl 沿用原规则；
 * apiKeyEnv 只校验名称，sharedMemory 默认 false。
 * 超时只在显式提供时进入归一化结果，避免把默认值写进既有 seed/CAS 形状。
 */
export function normalizeHindsightConfig(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw clientError('INVALID_ARGUMENT', 'hindsight options must be a plain object');
  }
  const allowed = new Set([
    'baseUrl',
    'apiKeyEnv',
    'sharedMemory',
    'timeoutMs',
    'reflectTimeoutMs',
    'topic',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw clientError('INVALID_ARGUMENT', `unknown hindsight option key: ${key}`);
    }
  }
  if (typeof value.baseUrl !== 'string' || value.baseUrl.length === 0) {
    throw clientError('INVALID_ARGUMENT', 'hindsight baseUrl is required');
  }
  const baseUrl = normalizeBaseUrl(value.baseUrl);
  let apiKeyEnv;
  if (value.apiKeyEnv !== undefined) {
    if (typeof value.apiKeyEnv !== 'string' || !ENV_NAME_RE.test(value.apiKeyEnv)) {
      throw clientError('INVALID_ARGUMENT', 'hindsight apiKeyEnv must be a standard environment variable name');
    }
    apiKeyEnv = value.apiKeyEnv;
  }
  let sharedMemory = false;
  if (value.sharedMemory !== undefined) {
    if (typeof value.sharedMemory !== 'boolean') {
      throw clientError('INVALID_ARGUMENT', 'hindsight sharedMemory must be a boolean');
    }
    sharedMemory = value.sharedMemory;
  }
  const normalized = { baseUrl, sharedMemory };
  if (apiKeyEnv !== undefined) normalized.apiKeyEnv = apiKeyEnv;
  if (value.timeoutMs !== undefined) {
    normalized.timeoutMs = normalizeTimeout(value.timeoutMs, 'timeoutMs');
  }
  if (value.reflectTimeoutMs !== undefined) {
    normalized.reflectTimeoutMs = normalizeTimeout(value.reflectTimeoutMs, 'reflectTimeoutMs');
  }
  if (value.topic !== undefined) {
    if (
      typeof value.topic !== 'string' ||
      value.topic.trim().length === 0 ||
      value.topic.trim().length > 256 ||
      !value.topic.isWellFormed()
    ) {
      throw clientError('INVALID_ARGUMENT', 'hindsight topic must be a non-blank string <= 256 chars');
    }
    normalized.topic = value.topic.trim();
  }
  return normalized;
}

/**
 * Parse Host-provided hindsight options into a normalized config.
 * Returns null when undefined; rejects null/non-plain/unknown keys.
 * 复用 normalizeHindsightConfig 纯校验后，再在此解析环境变量：
 * 显式 apiKeyEnv 必须是标准环境名且解析为 nonempty header-safe ASCII token；
 * 省略 apiKeyEnv 是受支持的无鉴权本地服务场景。超时在此填默认值。
 */
export function parseHindsightOptions(value) {
  if (value === undefined) return null;
  const normalized = normalizeHindsightConfig(value);
  let apiKey;
  if (normalized.apiKeyEnv !== undefined) {
    const resolved = process.env[normalized.apiKeyEnv];
    if (resolved === undefined || resolved.length === 0 || !HEADER_SAFE_TOKEN_RE.test(resolved)) {
      throw clientError(
        'INVALID_ARGUMENT',
        `hindsight apiKeyEnv ${normalized.apiKeyEnv} must resolve to a nonempty header-safe ASCII token`,
      );
    }
    apiKey = resolved;
  }
  return {
    baseUrl: normalized.baseUrl,
    apiKey,
    sharedMemory: normalized.sharedMemory,
    timeoutMs: normalized.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    reflectTimeoutMs: normalized.reflectTimeoutMs ?? DEFAULT_REFLECT_TIMEOUT_MS,
    ...(normalized.topic !== undefined ? { topic: normalized.topic } : {}),
  };
}

/**
 * Create a Hindsight client. No network happens in the constructor.
 */
export function createHindsightClient(config) {
  // config is the normalized output of parseHindsightOptions ({baseUrl, apiKey,
  // sharedMemory, timeoutMs, reflectTimeoutMs}); URL/env/header/sharedMemory
  // validation already happened there. Only a minimal structural guard remains
  // so a broken internal config fails early.
  if (!isPlainObject(config) || typeof config.baseUrl !== 'string' || config.baseUrl.length === 0) {
    throw clientError('INVALID_ARGUMENT', 'hindsight client config must be a normalized plain object with baseUrl');
  }
  const baseUrl = config.baseUrl;
  const apiKey = config.apiKey; // already header-safe or undefined
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const reflectTimeoutMs = config.reflectTimeoutMs ?? DEFAULT_REFLECT_TIMEOUT_MS;
  let closed = false;
  const pending = new Set(); // {cancel, promise} per in-flight request

  function mustString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
      throw clientError('INVALID_ARGUMENT', `${name} must be a non-empty string`);
    }
    return value;
  }

  function mustResourceId(value, name) {
    mustString(value, name);
    if (value === '.' || value === '..') {
      throw clientError('INVALID_ARGUMENT', `${name} must not be '.' or '..'`);
    }
    if (!value.isWellFormed()) {
      throw clientError('INVALID_ARGUMENT', `${name} must not contain lone surrogates`);
    }
    return value;
  }

  function mustPlain(value, name) {
    if (!isPlainObject(value)) {
      throw clientError('INVALID_ARGUMENT', `${name} must be a plain object`);
    }
    return value;
  }

  function mustOptString(value, name) {
    if (value !== undefined && typeof value !== 'string') {
      throw clientError('INVALID_ARGUMENT', `${name} must be a string`);
    }
    return value;
  }

  function mustSafePositiveInt(value, name) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw clientError('INVALID_ARGUMENT', `${name} must be a positive safe integer`);
    }
    return value;
  }

  function mustStringArray(value, name) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      throw clientError('INVALID_ARGUMENT', `${name} must be an array of strings`);
    }
    return value;
  }

  function plainObject(value) {
    if (!isPlainObject(value)) throw protocolError();
    return value;
  }

  function protocolCheck(condition, message) {
    if (!condition) throw protocolError(message);
  }

  function validateBankResponse(response, bankId) {
    plainObject(response);
    protocolCheck(response.bank_id === bankId, 'bank response bank_id mismatch');
    return response;
  }

  /**
   * Re-read the response through the 2MiB bound and hand the SDK an equivalent
   * Response: the generated client parses whatever body it receives unbounded.
   * 2xx bodies must be strict UTF-8 and nonempty JSON; the SDK returns {} for
   * 204/empty bodies and decodes text non-fatally, so both are rejected here
   * before the SDK sees them (parseAs:'json' forces JSON parsing).
   */
  async function limitResponse(response) {
    const tooLarge = 'hindsight response body exceeds 2MiB limit';
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw protocolError(tooLarge);
    }
    const chunks = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_BODY_BYTES) throw protocolError(tooLarge);
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = Buffer.concat(chunks);
    if (response.status >= 200 && response.status < 300) {
      if (response.status === 204 || bytes.byteLength === 0) {
        throw protocolError('hindsight response body must be nonempty JSON');
      }
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw protocolError('hindsight response body is not valid UTF-8');
      }
      try {
        JSON.parse(text);
      } catch {
        throw protocolError('hindsight response body is not valid JSON');
      }
      const headers = new Headers(response.headers);
      // content-length:0 会让 SDK 走空体分支，content-encoding 对已解码文本不再成立。
      headers.delete('content-length');
      headers.delete('content-encoding');
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    // 非 2xx 保持原样，交给 SDK 做既有稳定错误映射。
    // 204/304 and empty bodies must stay bodyless for the Response constructor.
    const body = response.status === 204 || response.status === 304 || bytes.byteLength === 0
      ? null
      : bytes;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Per-instance fetch: the SDK's generated client hardcodes redirect:follow, so
  // the request is re-issued here with redirect:error; clones only to measure.
  async function sdkFetch(request) {
    if (request.body !== null) {
      const text = await request.clone().text();
      if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
        throw clientError('INVALID_ARGUMENT', 'hindsight request body exceeds 2MiB limit');
      }
    }
    return limitResponse(await fetch(request, { redirect: 'error' }));
  }

  const headers = { Accept: 'application/json' };
  if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
  const client = createClient(createConfig({ baseUrl, headers, fetch: sdkFetch, parseAs: 'json' }));

  function statusFor(response) {
    const status = response?.status;
    if (!Number.isSafeInteger(status)) return unavailableError();
    switch (status) {
      case 401:
      case 403:
        return statusError('HINDSIGHT_AUTH_FAILED', status);
      case 404:
        return statusError('HINDSIGHT_NOT_FOUND', status);
      case 409:
        return statusError('HINDSIGHT_CONFLICT', status);
      default:
        if (status >= 500) return statusError('HINDSIGHT_UNAVAILABLE', status);
        return statusError('HINDSIGHT_INVALID_REQUEST', status);
    }
  }

  // The SDK resolves failures instead of throwing ({error,request,response});
  // fetch-layer rejections keep their code, 2xx parse failures stay protocol.
  async function sdkCall(sdkFn, options, sdkSignal) {
    const result = await sdkFn({ client, signal: sdkSignal, ...options });
    if (result.error === undefined) return result.data;
    if (result.error instanceof HindsightClientError) throw result.error;
    if (result.response?.ok) throw protocolError();
    throw statusFor(result.response);
  }

  function request(run, deadlineMs, signal) {
    if (closed) return Promise.reject(closedError());
    const ctrl = new AbortController();
    let cause = null;
    const cancel = (reason) => {
      if (cause !== null) return; // first cause wins
      cause = reason;
      ctrl.abort();
    };
    const entry = { cancel };
    const promise = (async () => {
      const onAbort = () => cancel('caller');
      if (signal) {
        if (signal.aborted) throw abortError();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const timer = setTimeout(() => cancel('timeout'), deadlineMs);
      try {
        return await run(ctrl.signal);
      } catch (error) {
        // First cancel cause wins: even if the body reader throws after cancellation,
        // classify from the recorded cause rather than the thrown error type.
        if (cause === 'caller') throw abortError();
        if (cause === 'close') throw closedError();
        if (cause === 'timeout') throw unavailableError();
        if (error instanceof HindsightClientError) throw error;
        if (isAbortError(error)) throw abortError();
        throw unavailableError();
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    })().finally(() => pending.delete(entry));
    entry.promise = promise;
    pending.add(entry);
    return promise;
  }

  function close() {
    close.promise ??= (async () => {
      if (!closed) {
        closed = true; // seal admission synchronously
        for (const entry of pending) entry.cancel('close');
      }
      await Promise.allSettled([...pending].map((entry) => entry.promise));
    })();
    return close.promise;
  }

  return {
    // 存在性走 listBanks（q 为子串过滤）后按 bank_id 精确匹配；不依赖 /config。
    async getBank(bankId, signal) {
      const id = mustResourceId(bankId, 'bankId');
      return request(async (sdkSignal) => {
        let offset = 0;
        for (let page = 0; page < BANK_MAX_PAGES; page += 1) {
          const list = plainObject(
            await sdkCall(
              sdk.listBanks,
              { query: { q: id, limit: BANK_PAGE_LIMIT, offset } },
              sdkSignal,
            ),
          );
          const banks = list.banks;
          protocolCheck(Array.isArray(banks), 'bank list banks must be an array');
          const match = banks.find((bank) => isPlainObject(bank) && bank.bank_id === id);
          if (match) return validateBankResponse(match, id);
          const total = list.total;
          protocolCheck(Number.isSafeInteger(total) && total >= 0, 'bank list total must be a nonnegative integer');
          offset += banks.length;
          if (banks.length === 0 || offset >= total) break;
        }
        throw statusError('HINDSIGHT_NOT_FOUND', 404);
      }, timeoutMs, signal);
    },
    async createBank(bankId, options = {}, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const opts = mustPlain(options ?? {}, 'createBank options');
      const payload = {};
      if (opts.name !== undefined) payload.name = mustOptString(opts.name, 'name');
      if (opts.retainMission !== undefined) {
        payload.retain_mission = mustOptString(opts.retainMission, 'retainMission');
      }
      if (opts.reflectMission !== undefined) {
        payload.reflect_mission = mustOptString(opts.reflectMission, 'reflectMission');
      }
      if (opts.observationsMission !== undefined) {
        payload.observations_mission = mustOptString(opts.observationsMission, 'observationsMission');
      }
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.createOrUpdateBank,
          { path: { bank_id: id }, body: payload },
          sdkSignal,
        );
        return validateBankResponse(response, id);
      }, timeoutMs, signal);
    },
    async retain(bankId, input, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const opts = mustPlain(input, 'retain input');
      const documentId = mustString(opts.documentId, 'documentId');
      const operationId = mustString(opts.operationId, 'operationId');
      if (!UUID_RE.test(operationId)) {
        throw clientError('INVALID_ARGUMENT', 'operationId must be a UUID');
      }
      const content = mustString(opts.content, 'content');
      const item = { content, document_id: documentId, update_mode: 'replace' };
      if (opts.context !== undefined) item.context = mustOptString(opts.context, 'context');
      if (opts.metadata !== undefined) {
        const metadata = mustPlain(opts.metadata, 'metadata');
        for (const value of Object.values(metadata)) {
          if (typeof value !== 'string') {
            throw clientError('INVALID_ARGUMENT', 'metadata values must be strings');
          }
        }
        item.metadata = metadata;
      }
      if (opts.tags !== undefined) item.tags = mustStringArray(opts.tags, 'tags');
      if (opts.timestamp !== undefined) item.timestamp = mustOptString(opts.timestamp, 'timestamp');
      if (opts.strategy !== undefined) item.strategy = mustOptString(opts.strategy, 'strategy');
      if (opts.observationScopes !== undefined) item.observation_scopes = opts.observationScopes;
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.retainMemories,
          { path: { bank_id: id }, body: { items: [item], async: true, operation_id: operationId } },
          sdkSignal,
        );
        plainObject(response);
        protocolCheck(response.success === true, 'retain response success must be true');
        protocolCheck(response.bank_id === id, 'retain response bank_id mismatch');
        protocolCheck(response.async === true, 'retain response async must be true');
        protocolCheck(response.operation_id === operationId, 'retain response operation_id mismatch');
        return response;
      }, timeoutMs, signal);
    },
    async getOperation(bankId, operationId, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const opId = mustResourceId(operationId, 'operationId');
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.getOperationStatus,
          { path: { bank_id: id, operation_id: opId } },
          sdkSignal,
        );
        plainObject(response);
        protocolCheck(response.operation_id === opId, 'operation response operation_id mismatch');
        protocolCheck(OPERATION_STATUSES.has(response.status), 'operation response status invalid');
        return response;
      }, timeoutMs, signal);
    },
    async retryOperation(bankId, operationId, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const opId = mustResourceId(operationId, 'operationId');
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.retryOperation,
          { path: { bank_id: id, operation_id: opId } },
          sdkSignal,
        );
        plainObject(response);
        protocolCheck(response.success === true, 'retry response success must be true');
        protocolCheck(typeof response.message === 'string', 'retry response message must be a string');
        protocolCheck(response.operation_id === opId, 'retry response operation_id mismatch');
        return response;
      }, timeoutMs, signal);
    },
    async recall(bankId, input, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const opts = mustPlain(input, 'recall input');
      const query = mustString(opts.query, 'query');
      const body = { query, budget: 'mid', include: { source_facts: {} } };
      if (opts.maxTokens !== undefined) {
        const maxTokens = mustSafePositiveInt(opts.maxTokens, 'maxTokens');
        body.max_tokens = maxTokens;
        body.include.source_facts.max_tokens = maxTokens;
      }
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.recallMemories,
          { path: { bank_id: id }, body },
          sdkSignal,
        );
        plainObject(response);
        protocolCheck(Array.isArray(response.results), 'recall response results must be an array');
        for (const item of response.results) {
          plainObject(item);
          protocolCheck(typeof item.id === 'string', 'recall result id must be a string');
          protocolCheck(typeof item.text === 'string', 'recall result text must be a string');
          if (item.type !== undefined && item.type !== null && typeof item.type !== 'string') {
            throw protocolError('recall result type must be a string or null');
          }
          if (
            item.document_id !== undefined &&
            item.document_id !== null &&
            typeof item.document_id !== 'string'
          ) {
            throw protocolError('recall result document_id must be a string or null');
          }
          if (item.source_fact_ids !== undefined && item.source_fact_ids !== null) {
            if (
              !Array.isArray(item.source_fact_ids) ||
              !item.source_fact_ids.every((v) => typeof v === 'string')
            ) {
              throw protocolError('recall result source_fact_ids must be an array of strings or null');
            }
          }
        }
        if (response.source_facts !== undefined && response.source_facts !== null) {
          if (typeof response.source_facts !== 'object' || Array.isArray(response.source_facts)) {
            throw protocolError('recall source_facts must be an object or null');
          }
          for (const entry of Object.values(response.source_facts)) {
            plainObject(entry);
            protocolCheck(typeof entry.id === 'string', 'recall source_fact id must be a string');
            protocolCheck(typeof entry.text === 'string', 'recall source_fact text must be a string');
          }
        }
        if (
          response.source_facts_truncated !== undefined &&
          response.source_facts_truncated !== null &&
          typeof response.source_facts_truncated !== 'boolean'
        ) {
          throw protocolError('recall source_facts_truncated must be a boolean or null');
        }
        return response;
      }, timeoutMs, signal);
    },
    async reflect(bankId, input, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const opts = mustPlain(input, 'reflect input');
      const query = mustString(opts.query, 'query');
      const body = { query, budget: 'mid', include: { facts: {} } };
      if (opts.maxTokens !== undefined) {
        body.max_tokens = mustSafePositiveInt(opts.maxTokens, 'maxTokens');
      }
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.reflect,
          { path: { bank_id: id }, body },
          sdkSignal,
        );
        plainObject(response);
        protocolCheck(typeof response.text === 'string', 'reflect response text must be a string');
        return response;
      }, reflectTimeoutMs, signal);
    },
    async getMemory(bankId, memoryId, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const memId = mustResourceId(memoryId, 'memoryId');
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.getMemory,
          { path: { bank_id: id, memory_id: memId } },
          sdkSignal,
        );
        return plainObject(response);
      }, timeoutMs, signal);
    },
    async updateMemory(bankId, memoryId, input, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const memId = mustResourceId(memoryId, 'memoryId');
      const opts = mustPlain(input, 'updateMemory input');
      if (opts.text === undefined && opts.state === undefined) {
        throw clientError('INVALID_ARGUMENT', 'updateMemory requires text or state');
      }
      const payload = {};
      if (opts.text !== undefined) payload.text = mustOptString(opts.text, 'text');
      if (opts.state !== undefined) {
        if (opts.state !== 'valid' && opts.state !== 'invalidated') {
          throw clientError('INVALID_ARGUMENT', 'state must be valid or invalidated');
        }
        payload.state = opts.state;
      }
      if (opts.reason !== undefined) payload.reason = mustOptString(opts.reason, 'reason');
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.updateMemory,
          { path: { bank_id: id, memory_id: memId }, body: payload },
          sdkSignal,
        );
        return plainObject(response);
      }, timeoutMs, signal);
    },
    async getDocument(bankId, documentId, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const docId = mustResourceId(documentId, 'documentId');
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.getDocument,
          { path: { bank_id: id, document_id: docId } },
          sdkSignal,
        );
        plainObject(response);
        protocolCheck(response.id === docId, 'document response id mismatch');
        protocolCheck(response.bank_id === id, 'document response bank_id mismatch');
        return response;
      }, timeoutMs, signal);
    },
    async listMentalModels(bankId, options = {}, signal) {
      const id = mustResourceId(bankId, 'bankId');
      const effectiveSignal = signal ?? options?.signal;
      return request(async (sdkSignal) => {
        const response = await sdkCall(
          sdk.listMentalModels,
          { path: { bank_id: id } },
          sdkSignal,
        );
        return plainObject(response);
      }, timeoutMs, effectiveSignal);
    },
    close,
  };
}
