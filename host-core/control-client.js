// Control API client for the standalone Host control server (web-standard fetch only; no Node/Host imports).

import { readControlLive, readWorkLive } from './control-live-client.js';
import { normalizeVaultControl, safeVaultError } from './vault-protocol.js';

export class ControlApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ControlApiError';
    this.status = options.status;
    this.code = options.code;
  }
}

function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError('createControlClient: invalid url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('createControlClient: url must be http or https');
  }
  if (url.username || url.password) {
    throw new TypeError('createControlClient: url must not contain userinfo');
  }
  if (url.hash) {
    throw new TypeError('createControlClient: url must not contain a fragment');
  }
  if (url.searchParams.get('token') !== null) {
    throw new TypeError('createControlClient: url must not contain a token query parameter');
  }
  return url.origin + url.pathname.replace(/\/+$/, '') + '/';
}

async function readJson(response, signal) {
  try {
    return await response.json();
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return null;
  }
}

async function ensureOk(response, signal) {
  if (response.ok) return;
  const apiError = extractApiError(await readJson(response, signal));
  throw new ControlApiError(
    apiError ? apiError.message : `Host control API error (HTTP ${response.status})`,
    {
      status: response.status,
      code: apiError ? apiError.code : 'BAD_RESPONSE'
    }
  );
}

function extractApiError(data) {
  if (!data || typeof data !== 'object' || !data.error || typeof data.error !== 'object') return null;
  const { code, message } = data.error;
  if (typeof code === 'string' && typeof message === 'string') return { code, message };
  return null;
}

function callOptions(options) {
  return options && options.signal ? { signal: options.signal } : {};
}

export function createControlClient({ url, token, fetch: fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) {
    throw new TypeError('createControlClient: token must be a URL-safe string of 32-512 characters');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createControlClient: fetch must be a function');
  }
  const base = parseBaseUrl(url);
  const host = new URL(base).host;

  async function request(method, segments, { signal, query, body } = {}) {
    const target = new URL(segments.map(encodeURIComponent).join('/'), base);
    if (query && query.size > 0) target.search = query.toString();

    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw new ControlApiError(
        `Cannot reach host control API at ${host}`,
        { code: 'NETWORK' }
      );
    }

    await ensureOk(response, signal);

    const data = await readJson(response, signal);
    if (data === null || typeof data !== 'object') {
      throw new ControlApiError(
        `Host control API success response is not valid JSON (HTTP ${response.status})`,
        { status: response.status, code: 'BAD_RESPONSE' }
      );
    }
    return data;
  }

  // 共用 live 端点发送/错误清理：primary live 与 work live 只差路径与解析器。
  async function* liveStream(segments, parser, { botId, scopeId, signal } = {}) {
    const target = new URL(segments.map(encodeURIComponent).join('/'), base);
    const headers = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`
    };
    let response;
    try {
      response = await fetchImpl(target, { method: 'GET', headers, signal });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw new ControlApiError(
        `Cannot reach host control API at ${host}`,
        { code: 'NETWORK' }
      );
    }
    await ensureOk(response, signal);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'text/event-stream') {
      try {
        await response.body?.cancel();
      } catch { /* body already gone */ }
      throw new ControlApiError(
        `Host control API live response is not text/event-stream (HTTP ${response.status})`,
        { status: response.status, code: 'BAD_RESPONSE' }
      );
    }
    try {
      for await (const frame of parser(response, { botId, scopeId, signal })) {
        yield frame;
      }
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (err && err.name === 'AbortError') throw err;
      if (err && err.code === 'LIVE_PROTOCOL') {
        throw new ControlApiError(err.message, { code: 'BAD_RESPONSE' });
      }
      throw new ControlApiError(
        `Host control live stream failed at ${host}`,
        { code: 'NETWORK' }
      );
    }
  }

  return {
    getHostInfo(options) {
      return request('GET', ['v1', 'host'], callOptions(options));
    },
    listBots(options) {
      return request('GET', ['v1', 'bots'], callOptions(options));
    },
    createBot(input, options) {
      return request('POST', ['v1', 'bots'], { ...callOptions(options), body: input });
    },
    updateBotProfile(input, options) {
      const { botId, ...profile } = input;
      return request('PUT', ['v1', 'bots', botId, 'profile'], { ...callOptions(options), body: profile });
    },
    setPrimaryBot(botId, options) {
      return request('POST', ['v1', 'bots', botId, 'primary'], { ...callOptions(options), body: {} });
    },
    archiveBot(botId, options) {
      return request('POST', ['v1', 'bots', botId, 'archive'], { ...callOptions(options), body: {} });
    },
    unarchiveBot(botId, options) {
      return request('POST', ['v1', 'bots', botId, 'unarchive'], { ...callOptions(options), body: {} });
    },
    deleteBot(botId, options) {
      return request('DELETE', ['v1', 'bots', botId], callOptions(options));
    },
    getBot(botId, options) {
      return request('GET', ['v1', 'bots', botId], callOptions(options));
    },
    findByRequest(requestId, options) {
      return request('GET', ['v1', 'bot-requests', requestId], callOptions(options));
    },
    submit(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'submissions'], { ...callOptions(options), body: input });
    },
    uploadAttachment(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'attachments'], { ...callOptions(options), body: input });
    },
    putBotFileChunk(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'files', 'chunks'], { ...callOptions(options), body: input });
    },
    getAttachment(botId, attachmentId, options) {
      return request('GET', ['v1', 'bots', botId, 'attachments', attachmentId], callOptions(options));
    },
    getSubmission(botId, requestId, options) {
      return request('GET', ['v1', 'bots', botId, 'submissions', requestId], callOptions(options));
    },
    history(botId, options) {
      const query = new URLSearchParams();
      if (options?.chunked !== undefined) query.set('chunked', String(options.chunked));
      if (options && options.limit != null) query.set('limit', String(options.limit));
      if (options && options.cursor != null) query.set('cursor', JSON.stringify(options.cursor));
      return request('GET', ['v1', 'bots', botId, 'history'], { signal: options && options.signal, query });
    },
    abort(botId, options) {
      return request('POST', ['v1', 'bots', botId, 'abort'], { ...callOptions(options), body: {} });
    },
    getBotBoard(params, options) {
      return request('POST', ['v1', 'bot-board'], { ...callOptions(options), body: params });
    },
    clearHistory(botId, options) {
      return request('POST', ['v1', 'bots', botId, 'history', 'clear'], { ...callOptions(options), body: {} });
    },
    compact(botId, options) {
      return request('POST', ['v1', 'bots', botId, 'compact'], { ...callOptions(options), body: {} });
    },
    contextStatus(botId, options) {
      return request('GET', ['v1', 'bots', botId, 'context'], callOptions(options));
    },
    memoryStatus(botId, input = {}, options) {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['target', 'state', 'limit', 'cursor'].includes(key)) ||
          (input.limit !== undefined && typeof input.limit !== 'number')) {
        return Promise.reject(new ControlApiError('invalid memory status input', { code: 'INVALID_ARGUMENT' }));
      }
      const query = new URLSearchParams();
      if (input && input.target !== undefined) query.set('target', JSON.stringify(input.target));
      if (input && input.state !== undefined) query.set('state', String(input.state));
      if (input && input.limit !== undefined) query.set('limit', String(input.limit));
      if (input && input.cursor !== undefined) query.set('cursor', JSON.stringify(input.cursor));
      return request('GET', ['v1', 'bots', botId, 'memory'], { signal: options && options.signal, query });
    },
    recallMemory(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'memory', 'recall'], { ...callOptions(options), body: input });
    },
    reflectMemory(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'memory', 'reflect'], { ...callOptions(options), body: input });
    },
    retainMemory(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'memory', 'retain'], { ...callOptions(options), body: input });
    },
    getMemory(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'memory', 'get'], { ...callOptions(options), body: input });
    },
    getMemorySource(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'memory', 'source'], { ...callOptions(options), body: input });
    },
    correctMemory(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'memory', 'correct'], { ...callOptions(options), body: input });
    },
    retryMemory(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'memory', 'retry'], { ...callOptions(options), body: input });
    },
    // 固定 ~ 前缀避免 '.'/'..' scope 被 URL 折叠；request 仍逐段 URI 编码。
    getWorkContext(botId, scopeId, options) {
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId], callOptions(options));
    },
    syncWorkContext(botId, scopeId, input = {}, options) {
      return request('POST', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'sync'], { ...callOptions(options), body: input });
    },
    workHistory(botId, scopeId, options) {
      const query = new URLSearchParams();
      if (options && options.limit != null) query.set('limit', String(options.limit));
      if (options && options.cursor != null) query.set('cursor', JSON.stringify(options.cursor));
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'history'], { signal: options && options.signal, query });
    },
    workContextStatus(botId, scopeId, options) {
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'context'], callOptions(options));
    },
    getWorkActivity(botId, scopeId, options) {
      return request('GET', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'activity'], callOptions(options));
    },
    stopWork(botId, scopeId, options) {
      return request('POST', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'stop'], { ...callOptions(options), body: {} });
    },
    resumeWork(botId, scopeId, options) {
      return request('POST', ['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'resume'], { ...callOptions(options), body: {} });
    },
    listScopeStates(options) {
      const query = new URLSearchParams();
      if (options && options.limit != null) query.set('limit', String(options.limit));
      if (options && options.cursor != null) query.set('cursor', JSON.stringify(options.cursor));
      return request('GET', ['v1', 'scopes'], { signal: options && options.signal, query });
    },
    createScope(input, options) {
      return request('POST', ['v1', 'scopes'], { ...callOptions(options), body: input });
    },
    getScopeState(scopeId, options) {
      return request('GET', ['v1', 'scopes', '~' + scopeId], callOptions(options));
    },
    updateScope(scopeId, input, options) {
      return request('POST', ['v1', 'scopes', '~' + scopeId, 'members'], { ...callOptions(options), body: input });
    },
    deleteScope(scopeId, input, options) {
      return request('POST', ['v1', 'scopes', '~' + scopeId, 'delete'], { ...callOptions(options), body: input });
    },
    publishUserMessage(scopeId, input, options) {
      return request('POST', ['v1', 'scopes', '~' + scopeId, 'messages'], { ...callOptions(options), body: input });
    },
    listScopeReplicas(scopeId, options) {
      const query = new URLSearchParams();
      if (options && options.limit != null) query.set('limit', String(options.limit));
      if (options && options.cursor != null) query.set('cursor', JSON.stringify(options.cursor));
      return request('GET', ['v1', 'scopes', '~' + scopeId, 'replicas'], { signal: options && options.signal, query });
    },
    async *live(botId, options = {}) {
      for await (const frame of liveStream(['v1', 'bots', botId, 'live'], readControlLive, { botId, signal: options.signal })) {
        yield frame;
      }
    },
    async *workLive(botId, scopeId, options = {}) {
      for await (const frame of liveStream(['v1', 'bots', botId, 'work-contexts', '~' + scopeId, 'live'], readWorkLive, { botId, scopeId, signal: options.signal })) {
        yield frame;
      }
    },
    getModelCatalog(options) {
      return request('GET', ['v1', 'models'], callOptions(options));
    },
    scopeHistory(scopeId, options) {
      const query = new URLSearchParams();
      if (options && options.limit != null) query.set('limit', String(options.limit));
      if (options && options.cursor != null) query.set('cursor', JSON.stringify(options.cursor));
      if (options && options.order != null) query.set('order', options.order);
      return request('GET', ['v1', 'scopes', '~' + scopeId, 'history'], { signal: options && options.signal, query });
    },
    getScopeMessage(scopeId, messageId, options) {
      return request('GET', ['v1', 'scopes', '~' + scopeId, 'messages', '~' + messageId], callOptions(options));
    },
    getScopeMessageDelivery(scopeId, messageId, options) {
      return request('GET', ['v1', 'scopes', '~' + scopeId, 'messages', '~' + messageId, 'delivery'], callOptions(options));
    },
    getLocalSettings(options) {
      return request('GET', ['v1', 'settings'], callOptions(options));
    },
    replaceLocalSettings({ expectedRevision, settings }, options) {
      return request('PUT', ['v1', 'settings'], { ...callOptions(options), body: { expectedRevision, settings } });
    },
    getServiceStatus(options) {
      return request('GET', ['v1', 'service'], callOptions(options));
    },
    getBotSoul(botId, options) {
      return request('GET', ['v1', 'bots', botId, 'soul'], callOptions(options));
    },
    setBotSoul(botId, input, options) {
      return request('PUT', ['v1', 'bots', botId, 'soul'], { ...callOptions(options), body: input });
    },
    manageBotLearning(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'learning'], { ...callOptions(options), body: input });
    },
    reviewBotSkills(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'skill-reviews'], { ...callOptions(options), body: input });
    },
    scheduleTask(botId, input, options) {
      return request('POST', ['v1', 'bots', botId, 'schedules'], { ...callOptions(options), body: input });
    },
    discoverProviderModels(input, options) {
      return request('POST', ['v1', 'models', 'discover'], { ...callOptions(options), body: input });
    },
    validateCenterProvider(input, options) {
      return request('POST', ['v1', 'center', 'provider', 'validate'], { ...callOptions(options), body: input });
    },
    discoverCenterProviderModels(input, options) {
      return request('POST', ['v1', 'center', 'provider', 'discover'], { ...callOptions(options), body: input });
    },
    callCapabilityAction(input, options) {
      return request('POST', ['v1', 'center', 'action'], { ...callOptions(options), body: input });
    },
    // Unified Shower：参数顺序与 Runtime/远端 v2 方法表一致，body 恰为
    // {botId,scopeId?,...}；Actor/targetDeviceId 从不来自客户端。
    async vaultControl(input, options) {
      try {
        return await request('POST', ['v1', 'vault'], { ...callOptions(options), body: normalizeVaultControl(input) });
      } catch (error) {
        if (error instanceof ControlApiError && ['NETWORK', 'BAD_RESPONSE'].includes(error.code)) {
          throw new ControlApiError('Vault request is unconfirmed.', { code: error.code, status: error.status });
        }
        const safe = safeVaultError(error);
        throw new ControlApiError(safe.message, { code: safe.code, status: error?.status });
      }
    },
    getShowerStatus(target, options) {
      return request('POST', ['v1', 'shower', 'status'], { ...callOptions(options), body: target });
    },
    createShowerSession(target, input, options) {
      return request('POST', ['v1', 'shower', 'create'], { ...callOptions(options), body: { ...target, input } });
    },
    getShowerFrame(target, sessionId, limits, options) {
      return request('POST', ['v1', 'shower', 'frame'], { ...callOptions(options), body: { ...target, sessionId, limits } });
    },
    sendShowerInput(target, sessionId, input, options) {
      return request('POST', ['v1', 'shower', 'input'], { ...callOptions(options), body: { ...target, sessionId, input } });
    },
    takeoverShower(target, sessionId, options) {
      return request('POST', ['v1', 'shower', 'takeover'], { ...callOptions(options), body: { ...target, sessionId } });
    },
    releaseShowerSession(target, sessionId, options) {
      return request('POST', ['v1', 'shower', 'release'], { ...callOptions(options), body: { ...target, sessionId } });
    }
  };
}
