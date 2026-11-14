import http from 'node:http';
import https from 'node:https';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { assertDeviceToken } from './relay-protocol.js';
import { assertId } from './message-protocol.js';
import {
  ANTIGRAVITY_API,
  ANTIGRAVITY_CANCEL_PATH,
  ANTIGRAVITY_MAX_FRAME_BYTES,
  ANTIGRAVITY_PROVIDER_ID,
  ANTIGRAVITY_STREAM_PATH,
  assertAntigravityStreamEvent,
  createAntigravityErrorEvent,
} from './antigravity-provider.js';

function centerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeResponseHeaders(rawHeaders) {
  const out = {};
  for (const [key, value] of Object.entries(rawHeaders ?? {})) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.join(', ');
  }
  return out;
}

export function validateCenterUrl(centerUrl) {
  let base;
  try { base = new URL(centerUrl); } catch { throw centerError('INVALID_ARGUMENT', 'invalid center URL'); }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) ||
      base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw centerError('INVALID_ARGUMENT', 'center URL must be an HTTPS origin or loopback HTTP origin');
  }
  return base;
}

export async function connectCenter({ centerUrl, deviceId, deviceToken, ca, signal, onDisconnect, onChange, onWebhookReady, onTaskReady }) {
  const base = validateCenterUrl(centerUrl);
  assertId(deviceId, 'deviceId');
  assertDeviceToken(deviceToken);
  const transport = base.protocol === 'https:' ? https : http;
  const requests = new Set();
  let closed = false;
  let events;
  let watchdog;
  let ownerCookie = '';
  let ownerCsrf = '';
  let ownerQueue = Promise.resolve();
  const disconnect = (error) => {
    if (closed) return;
    closed = true;
    clearTimeout(watchdog);
    ownerCookie = '';
    ownerCsrf = '';
    for (const active of requests) active.destroy();
    events?.destroy();
    onDisconnect?.(error);
  };
  const headers = { Authorization: `Bearer ${deviceToken}`, 'X-Device-Id': deviceId };
  const start = (path, { method = 'GET', body, signal, headers: extraHeaders } = {}) => {
    if (closed) throw centerError('CENTER_OFFLINE', 'center is disconnected');
    const req = transport.request(new URL(path, base), {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(extraHeaders ?? {}),
      },
      ca, signal,
    });
    requests.add(req);
    req.once('close', () => requests.delete(req));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
    return req;
  };
  const request = async (path, options = {}) => {
    const req = start(path, options);
    req.setTimeout(30000, () => req.destroy(centerError('CENTER_OFFLINE', 'center request timed out')));
    const response = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const isTaskPath = path.startsWith('/api/host/tasks/') || path.startsWith('/api/host/task-dispatches/');
      // turn 准入端点透传服务端类型化错误码（TURN_SET_CHANGED/TURN_SYNC_FAILED 等）；
      // bot 管理端点同样透传有界类型码，REVISION_CONFLICT 等 CAS 失败不会丢成
      // BAD_RESPONSE。其他路径保持既有 CENTER_REQUEST_FAILED 语义及 ownerRequest 回退。
      const typedTurnError = path.startsWith('/api/host/turns/') ||
        isTaskPath ||
        /^\/api\/host\/devices\/[^/]+\/bots\/[^/]+\/(skills|skill-reviews|learning|installations)$/.test(path);
      // /api/host/vault/* 只透传固定 VAULT_* 码/消息；其他错误仍走状态码兜底。
      const typedVaultError = path.startsWith('/api/host/vault/');
      let errorCode = null;
      let errorMessage = null;
      if (typedTurnError || typedVaultError) {
        const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        const isJsonResponse = !isTaskPath || contentType === 'application/json' || contentType.endsWith('+json');
        // 任务路径仅透传真实 Center 应用层 4xx JSON 错误（保留 401 断连兜底，拒绝 5xx/网关错误页透传）。
        const allowStatus = !isTaskPath || (response.statusCode >= 400 && response.statusCode < 500 && response.statusCode !== 401);
        if (isJsonResponse && allowStatus) {
          const chunks = [];
          let totalBytes = 0;
          let oversized = false;
          for await (const chunk of response) {
            totalBytes += chunk.length;
            if (totalBytes > 65536) {
              oversized = true;
              response.destroy();
              break;
            }
            chunks.push(chunk);
          }
          if (!oversized) {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const codePattern = typedVaultError ? /^VAULT_[A-Z0-9_]{1,60}$/ : /^[A-Z][A-Z0-9_]{1,63}$/;
              const blockedTaskCodes = new Set([
                'CENTER_OFFLINE',
                'NOT_CONNECTED',
                'UNAUTHORIZED',
                'RUNTIME_BUSY',
                'BAD_RESPONSE',
                'CENTER_REQUEST_FAILED',
              ]);
              if (
                parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
                parsed.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error) &&
                typeof parsed.error.code === 'string' && codePattern.test(parsed.error.code) &&
                (!isTaskPath || !blockedTaskCodes.has(parsed.error.code))
              ) {
                errorCode = parsed.error.code;
                if (typeof parsed.error.message === 'string' && parsed.error.message.length <= 512) errorMessage = parsed.error.message;
              }
            } catch { /* 非 JSON 错误体按状态码兜底 */ }
          }
        } else {
          response.resume();
        }
      } else {
        response.resume();
      }
      if (errorCode) throw centerError(errorCode, errorMessage ?? 'center request failed');
      if (typedVaultError && response.statusCode === 404) {
        throw centerError('CENTER_VAULT_UNSUPPORTED', 'center does not support vault service');
      }
      if (response.statusCode === 409) throw centerError('REQUEST_CONFLICT', 'center revision conflict; reload before saving');
      if (response.statusCode === 401 || (response.statusCode === 403 && !path.startsWith('/api/host/devices/'))) {
        const error = centerError('UNAUTHORIZED', 'center authentication failed');
        if (response.statusCode === 401 || path === '/api/host/connection' || path.startsWith('/api/host/bot-directory')) disconnect(error);
        throw error;
      }
      if (path.startsWith('/api/host/devices/') && response.statusCode !== 404) {
        throw centerError('BAD_RESPONSE', `center request failed (${response.statusCode})`);
      }
      throw centerError('CENTER_REQUEST_FAILED', 'center request failed');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > (options.binary ? 256 * 1024 * 1024 : 16 * 1024 * 1024)) {
        response.destroy();
        throw centerError('CENTER_REQUEST_FAILED', 'center response too large');
      }
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks);
    if (options.binary) return result;
    if (response.statusCode === 204) return;
    try { return JSON.parse(result.toString('utf8')); }
    catch { throw centerError('CENTER_REQUEST_FAILED', 'invalid center response'); }
  };
  const ownerRequest = (path, { method = 'GET', body, signal } = {}) => {
    const run = ownerQueue.then(async () => {
      if (closed || signal?.aborted) throw centerError('CENTER_OFFLINE', 'center is disconnected');
      const req = transport.request(new URL(path, base), {
        method, ca, signal,
        headers: { ...(ownerCookie ? { Cookie: ownerCookie } : {}),
          ...(method !== 'GET' ? { 'X-CSRF-Token': ownerCsrf } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      });
      requests.add(req);
      req.once('close', () => requests.delete(req));
      req.setTimeout(30000, () => req.destroy(centerError('CENTER_OFFLINE', 'center request timed out')));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
      const response = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
      if (closed || signal?.aborted) { response.resume(); throw centerError('CENTER_OFFLINE', 'center is disconnected'); }
      const cookies = response.headers['set-cookie'];
      if (cookies?.length) ownerCookie = cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        const code = response.statusCode === 409 ? 'REQUEST_CONFLICT' : response.statusCode === 401 || response.statusCode === 403 ? 'CONTROL_UNAUTHORIZED' : 'BAD_RESPONSE';
        throw centerError(code, response.statusCode === 409 ? 'center revision conflict; reload before saving' : response.statusCode === 401 || response.statusCode === 403 ? 'center administrator authentication failed' : `center request failed (${response.statusCode})`);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { response.destroy(); throw centerError('BAD_RESPONSE', 'center response too large'); }
        chunks.push(chunk);
      }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw centerError('BAD_RESPONSE', 'invalid center response'); }
      if (closed || signal?.aborted) throw centerError('CENTER_OFFLINE', 'center is disconnected');
      if (path === '/api/session') {
        // SessionInfo.csrfToken 在未认证时为 null：保留旧 CSRF 为空串，只要求已认证时拿到令牌。
        if (typeof result?.authenticated !== 'boolean' ||
            (result.authenticated && (typeof result.csrfToken !== 'string' || !result.csrfToken))) {
          throw centerError('BAD_RESPONSE', 'invalid center session');
        }
        if (typeof result.csrfToken === 'string' && result.csrfToken) ownerCsrf = result.csrfToken;
      }
      return result;
    });
    ownerQueue = run.catch(() => {});
    return run;
  };
  const fetchOwnerSession = async (signal) => {
    const session = await ownerRequest('/api/session', { signal });
    return { authenticated: session.authenticated };
  };
  // 真实中心会话探测：不伪造已认证，同时让后续写请求拿到 CSRF 令牌。
  const ownerSession = async (signal) => {
    if (closed || signal?.aborted) throw centerError('CENTER_OFFLINE', 'center is disconnected');
    return fetchOwnerSession(signal);
  };
  const botModelPath = (targetDeviceId, botId) => '/api/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/model-config';
  const hostBotModelPath = (targetDeviceId, botId) => '/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/model-config';
  const botCwdPath = (targetDeviceId, botId) => '/api/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/cwd';
  const hostBotCwdPath = (targetDeviceId, botId) => '/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/cwd';
  const botCapabilitiesPath = (targetDeviceId, botId) => '/api/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/capabilities';
  const hostBotCapabilitiesPath = (targetDeviceId, botId) => '/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/capabilities';
  const runtimeStatusPath = (targetDeviceId) => '/api/devices/' + encodeURIComponent(targetDeviceId) + '/runtime-status';
  const hostRuntimeStatusPath = (targetDeviceId) => '/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/runtime-status';
  const hostBotManagePath = (targetDeviceId, botId, domain) => '/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/' + domain;
  try {
    const req = start('/api/host/events', { signal });
    req.setTimeout(15000, () => req.destroy(centerError('CENTER_OFFLINE', 'center connection timed out')));
    events = await new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
    req.setTimeout(0);
    if (events.statusCode !== 200 || !String(events.headers['content-type'] ?? '').startsWith('text/event-stream')) {
      events.resume();
      throw events.statusCode === 401 || events.statusCode === 403
        ? centerError('UNAUTHORIZED', 'center authentication failed')
        : centerError('CENTER_OFFLINE', 'center event stream unavailable');
    }
    let buffer = '';
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => events.destroy(), 45000);
      watchdog.unref?.();
    };
    const disconnected = () => disconnect(centerError('CENTER_OFFLINE', 'center event stream disconnected'));
    events.setEncoding('utf8');
    events.on('data', (chunk) => {
      arm();
      buffer += chunk;
      if (buffer.length > 65536) { events.destroy(); return; }
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buffer.slice(0, end);
        const separator = /^\r?\n\r?\n/.exec(buffer.slice(end))[0];
        buffer = buffer.slice(end + separator.length);
        const lines = frame.split(/\r?\n/);
        if (lines.includes('event: config-changed')) onChange?.();
        if (lines.includes('event: webhook-ready')) onWebhookReady?.();
        if (lines.includes('event: task-ready')) onTaskReady?.();
      }
    });
    events.once('end', disconnected);
    events.once('error', disconnected);
    events.once('close', disconnected);
    arm();
  } catch (error) {
    closed = true;
    for (const active of requests) active.destroy();
    throw error;
  }
  return {
    ownerSession,
    // Fixed-path owner management requests (capabilities/runtime status). The caller
    // owns path construction and argument validation; no arbitrary owner HTTP surface.
    ownerRequest,
    async ownerLogin(password, signal) {
      // 未认证时 GET /api/session 可能 401：探测仅用于取 CSRF，失败不阻断登录本身。
      try { await fetchOwnerSession(signal); } catch { /* 登录 POST 会给出真实结果 */ }
      if (closed || signal?.aborted) throw centerError('CENTER_OFFLINE', 'center is disconnected');
      const session = await ownerRequest('/api/session', { method: 'POST', body: { password }, signal });
      return { authenticated: session.authenticated };
    },
    botAvatarGet: (targetDeviceId, botId, signal) => request('/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/avatar', { signal }),
    botAvatarSet: (targetDeviceId, botId, input, signal) => request('/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/avatar', { method: 'PUT', body: input, signal }),
    modelPickerGet: signal => request('/api/host/model-picker', { signal }),
    providerAuth: (providerId, signal) => request('/api/host/providers/' + encodeURIComponent(providerId) + '/auth', { signal }),
    modelStarSet: (input, signal) => request('/api/host/model-stars', { method: 'PUT', body: input, signal }),
    botModelGet: (targetDeviceId, botId, signal) => request(hostBotModelPath(targetDeviceId, botId), { signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(botModelPath(targetDeviceId, botId), { signal }) : Promise.reject(err)),
    botModelSet: (targetDeviceId, botId, input, signal) => request(hostBotModelPath(targetDeviceId, botId), { method: 'PUT', body: input, signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(botModelPath(targetDeviceId, botId), { method: 'PUT', body: input, signal }) : Promise.reject(err)),
    botCwdGet: (targetDeviceId, botId, signal) => request(hostBotCwdPath(targetDeviceId, botId), { signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(botCwdPath(targetDeviceId, botId), { signal }) : Promise.reject(err)),
    botCwdSet: (targetDeviceId, botId, input, signal) => request(hostBotCwdPath(targetDeviceId, botId), { method: 'PUT', body: input, signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(botCwdPath(targetDeviceId, botId), { method: 'PUT', body: input, signal }) : Promise.reject(err)),
    botCapabilitiesGet: (targetDeviceId, botId, signal) => request(hostBotCapabilitiesPath(targetDeviceId, botId), { signal }).catch(err => {
      if (err?.code !== 'CENTER_REQUEST_FAILED') return Promise.reject(err);
      return ownerRequest(botCapabilitiesPath(targetDeviceId, botId), { signal }).catch(async (ownerErr) => {
        if (ownerErr?.code !== 'BAD_RESPONSE' || !String(ownerErr.message).includes('(404)')) throw ownerErr;
        const installations = await ownerRequest('/api/capabilities', { signal });
        if (!Array.isArray(installations)) throw ownerErr;
        return Promise.all(installations.map(async (installation) => {
          const id = encodeURIComponent(installation.installationId);
          const [config, global] = await Promise.all([
            ownerRequest(botCapabilitiesPath(targetDeviceId, botId) + '/' + id, { signal }),
            ownerRequest('/api/installations/' + id + '/config', { signal }),
          ]);
          return {
            installation: {
              ...installation,
              activation: installation.activation ?? {
                status: installation.enabled ? 'enabled' : 'disabled',
                error: null,
                updatedAt: installation.updatedAt ?? null,
              },
            },
            config,
            ...(global?.uiSchema === undefined ? {} : { uiSchema: global.uiSchema }),
          };
        }));
      });
    }),
    botCapabilitySet: (targetDeviceId, botId, installationId, input, signal) => request(hostBotCapabilitiesPath(targetDeviceId, botId) + '/' + encodeURIComponent(installationId), { method: 'PUT', body: input, signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(botCapabilitiesPath(targetDeviceId, botId) + '/' + encodeURIComponent(installationId), { method: 'PUT', body: input, signal }) : Promise.reject(err)),
    runtimeStatus: (targetDeviceId, signal) => request(hostRuntimeStatusPath(targetDeviceId), { signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(runtimeStatusPath(targetDeviceId), { signal }) : Promise.reject(err)),
    // Bot-scoped management: fixed POST paths only; typed errors preserve CAS
    // conflicts and service codes. No ownerRequest fallback — both route sets
    // ship together, so a missing endpoint is an honest CENTER_REQUEST_FAILED.
    botSkill: (targetDeviceId, botId, input, signal) => request(hostBotManagePath(targetDeviceId, botId, 'skills'), { method: 'POST', body: input, signal }),
    botSkillReview: (botId, input) => request(hostBotManagePath(deviceId, botId, 'skill-reviews'), { method: 'POST', body: input }),
    botSkillUse: (targetDeviceId, botId, input, signal) => request('/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/skills/usage', { method: 'POST', body: input, signal }),
    botLearning: (targetDeviceId, botId, input, signal) => request(hostBotManagePath(targetDeviceId, botId, 'learning'), { method: 'POST', body: input, signal }),
    botInstallation: (targetDeviceId, botId, input, signal) => request(hostBotManagePath(targetDeviceId, botId, 'installations'), { method: 'POST', body: input, signal }),
    bootstrap: (bots) => request('/api/host/bootstrap', { method: 'POST', body: { deviceId, capabilityProtocol: 1, bots } }),
    syncBots: (bots) => request('/api/host/bots-sync', { method: 'POST', body: { deviceId, bots } }).catch(() => request('/api/host/bootstrap', { method: 'POST', body: { deviceId, capabilityProtocol: 1, bots } })),
    getBotSync: ({ epoch, sinceSeq } = {}, signal) => {
      const qs = new URLSearchParams();
      if (typeof epoch === 'string' && epoch) qs.set('epoch', epoch);
      if (Number.isSafeInteger(sinceSeq) && sinceSeq >= 0) qs.set('sinceSeq', String(sinceSeq));
      const query = qs.toString();
      return request('/api/host/bot-directory' + (query ? '?' + query : ''), { signal });
    },
    getConnection: (signal) => request('/api/host/connection', { signal }),
    getSnapshot: () => request('/api/host/snapshot'),
    reportRuntime: (receipt) => request('/api/host/receipt', { method: 'POST', body: receipt }),
    getDeployments: () => request('/api/host/deployments'),
    reportDeployment: (receipt) => request('/api/host/deployments/receipt', { method: 'POST', body: receipt }),
    fetchArtifact: (ref, options = {}) => {
      const query = typeof options.admissionId === 'string' && options.admissionId
        ? '?admissionId=' + encodeURIComponent(options.admissionId) : '';
      return request('/api/host/artifacts/' + encodeURIComponent(ref) + query, { binary: true, signal: options.signal });
    },
    pollWebhookEvents: (options = {}) => request('/api/host/webhook-events/poll', { method: 'POST', body: { cursor: options.cursor }, signal: options.signal }),
    stopWebhookEvents: (input, options = {}) => request('/api/host/webhook-events/stop', { method: 'POST', body: { botId: input.botId, stopEpoch: input.stopEpoch }, signal: options.signal }),
    reportWebhookEvent: (eventId, input, options = {}) => request('/api/host/webhook-events/' + encodeURIComponent(eventId) + '/receipt', { method: 'POST', body: input, signal: options.signal }),
    prepareTurn: (input, options = {}) => request('/api/host/turns/prepare', { method: 'POST', body: input, signal: options.signal }),
    confirmTurn: (input, options = {}) => request('/api/host/turns/confirm', { method: 'POST', body: input, signal: options.signal }),
    restoreTurn: (input, options = {}) => request('/api/host/turns/restore', { method: 'POST', body: input, signal: options.signal }),
    globalTasks: (body, signal) => request('/api/host/tasks/action', { method: 'POST', body, signal }),
    pollTaskDispatches: (body, signal) => request('/api/host/task-dispatches/poll', { method: 'POST', body, signal }),
    reportTaskDispatch: (id, body, signal) => request('/api/host/task-dispatches/' + encodeURIComponent(id) + '/receipt', { method: 'POST', body, signal }),
    // 中心外部密码库：device 认证固定路径，typed VAULT_* 码透传；密码路径不自动重试。
    vaultControl: (input, options = {}) => request('/api/host/vault/control', { method: 'POST', body: input, signal: options.signal }),
    vaultFind: (input, options = {}) => request('/api/host/vault/find', { method: 'POST', body: input, signal: options.signal }),
    vaultResolve: (input, options = {}) => request('/api/host/vault/resolve', { method: 'POST', body: input, signal: options.signal }),
    listCapabilityTools: (id, botId, options = {}) => request('/api/host/capabilities/' + encodeURIComponent(id) + '/tools/list', { method: 'POST', body: { botId }, signal: options.signal }),
    callCapabilityTool: (id, botId, name, args, callId, options = {}) => request('/api/host/capabilities/' + encodeURIComponent(id) + '/tools/call', { method: 'POST', body: { botId, name, args, callId }, signal: options.signal }),
    streamAntigravity(payload, options = {}) {
      const eventStream = createAssistantMessageEventStream();
      const model = options.model ?? {
        id: typeof payload?.modelId === 'string' ? payload.modelId : '',
        api: ANTIGRAVITY_API,
        provider: ANTIGRAVITY_PROVIDER_ID,
      };
      const cancelAntigravity = async (sessionId) => {
        if (closed || typeof sessionId !== 'string' || !sessionId.trim()) return;
        let timer;
        try {
          const cancelReq = start(ANTIGRAVITY_CANCEL_PATH, { method: 'POST', body: { sessionId } });
          cancelReq.on('error', () => {});
          timer = setTimeout(() => cancelReq.destroy(centerError('CENTER_OFFLINE', 'center cancel timed out')), 5000);
          timer.unref?.();
          const cancelRes = await new Promise((resolve, reject) => {
            cancelReq.once('response', resolve);
            cancelReq.once('error', reject);
          });
          cancelRes.on('error', () => {});
          cancelRes.resume();
        } catch {
          // Best-effort cancel on caller abort.
        } finally {
          clearTimeout(timer);
        }
      };

      void (async () => {
        const signal = options.signal;
        let terminalSeen = false;
        let cancelTriggered = false;
        let started = false;
        let req = null;
        let response = null;
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
        const triggerCancel = () => {
          if (terminalSeen || cancelTriggered) return;
          cancelTriggered = true;
          req?.destroy();
          response?.destroy();
          if (started) void cancelAntigravity(sessionId);
        };
        const onAbort = () => triggerCancel();

        try {
          if (signal?.aborted) {
            eventStream.push(createAntigravityErrorEvent(model, new Error('Request was aborted'), true));
            return;
          }
          if (closed) {
            throw centerError('CENTER_OFFLINE', 'center is disconnected');
          }
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
              !sessionId.trim() || typeof payload.modelId !== 'string' || !payload.modelId.trim() ||
              !Array.isArray(payload.messages)) {
            throw centerError('INVALID_ARGUMENT', 'invalid antigravity stream payload');
          }
          let bodyPayload = payload;
          if (typeof options.onPayload === 'function') {
            const nextPayload = await options.onPayload(bodyPayload, model);
            if (nextPayload !== undefined) bodyPayload = nextPayload;
          }
          if (signal?.aborted) {
            eventStream.push(createAntigravityErrorEvent(model, new Error('Request was aborted'), true));
            return;
          }

          signal?.addEventListener('abort', onAbort, { once: true });
          req = start(ANTIGRAVITY_STREAM_PATH, {
            method: 'POST',
            body: bodyPayload,
            signal,
            headers: { Accept: 'application/x-ndjson' },
          });
          started = true;
          response = await new Promise((resolve, reject) => {
            req.once('response', resolve);
            req.once('error', reject);
          });
          req.on('error', () => {});

          await options.onResponse?.({
            status: response.statusCode ?? 0,
            headers: normalizeResponseHeaders(response.headers),
          }, model);

          if (response.statusCode < 200 || response.statusCode >= 300) {
            const errChunks = [];
            let errBytes = 0;
            for await (const chunk of response) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              if (errBytes + buf.length > 65536) {
                errChunks.push(buf.subarray(0, 65536 - errBytes));
                response.destroy();
                break;
              }
              errChunks.push(buf);
              errBytes += buf.length;
            }
            let errorCode = null;
            let errorMessage = null;
            try {
              const parsed = JSON.parse(Buffer.concat(errChunks, errBytes).toString('utf8'));
              if (typeof parsed?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(parsed.error.code)) {
                errorCode = parsed.error.code;
              }
              if (typeof parsed?.error?.message === 'string' && parsed.error.message.length <= 512) {
                errorMessage = parsed.error.message;
              }
            } catch { /* non-JSON error body */ }
            if (response.statusCode === 401 || response.statusCode === 403) {
              const authError = centerError('UNAUTHORIZED', 'center authentication failed');
              if (response.statusCode === 401) disconnect(authError);
              throw authError;
            }
            if (errorCode) throw centerError(errorCode, errorMessage ?? 'center request failed');
            throw centerError('CENTER_REQUEST_FAILED', errorMessage ?? `center antigravity stream failed (${response.statusCode})`);
          }

          const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
          if (contentType !== 'application/x-ndjson') {
            response.destroy();
            throw centerError('CENTER_REQUEST_FAILED', 'invalid antigravity stream content-type');
          }

          const decoder = new TextDecoder('utf-8', { fatal: true });
          let lineChunks = [];
          let lineBytes = 0;

          const handleLine = async (rawLine) => {
            const trimmed = rawLine.length > 0 && rawLine[rawLine.length - 1] === 0x0d
              ? rawLine.subarray(0, rawLine.length - 1)
              : rawLine;
            if (trimmed.length === 0) return false;
            const text = decoder.decode(trimmed);
            if (!text.trim()) return false;
            const parsed = JSON.parse(text);
            const event = assertAntigravityStreamEvent(parsed);
            await options.onProviderStreamEvent?.(event, model);
            if (event.type === 'done' || event.type === 'error') {
              terminalSeen = true;
            }
            eventStream.push(event);
            return terminalSeen;
          };

          for await (const chunk of response) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            let offset = 0;
            while (offset < buf.length) {
              const nl = buf.indexOf(0x0a, offset);
              if (nl === -1) {
                const tail = buf.subarray(offset);
                if (lineBytes + tail.length > ANTIGRAVITY_MAX_FRAME_BYTES) {
                  response.destroy();
                  throw centerError('CENTER_REQUEST_FAILED', 'antigravity stream frame exceeded max size');
                }
                lineChunks.push(tail);
                lineBytes += tail.length;
                break;
              }
              const slice = buf.subarray(offset, nl);
              if (lineBytes + slice.length > ANTIGRAVITY_MAX_FRAME_BYTES) {
                response.destroy();
                throw centerError('CENTER_REQUEST_FAILED', 'antigravity stream frame exceeded max size');
              }
              const lineBuf = lineChunks.length === 0
                ? slice
                : Buffer.concat([...lineChunks, slice], lineBytes + slice.length);
              lineChunks = [];
              lineBytes = 0;
              offset = nl + 1;
              if (await handleLine(lineBuf)) {
                response.on('error', () => {});
                response.destroy();
                return;
              }
            }
          }

          if (lineBytes > 0) {
            const tailBuf = lineChunks.length === 1 ? lineChunks[0] : Buffer.concat(lineChunks, lineBytes);
            lineChunks = [];
            lineBytes = 0;
            if (await handleLine(tailBuf)) return;
          }

          if (!terminalSeen) {
            if (signal?.aborted) throw new Error('Request was aborted');
            throw centerError('CENTER_REQUEST_FAILED', 'antigravity stream ended without a terminal event');
          }
        } catch (err) {
          if (terminalSeen) return;
          const aborted = Boolean(signal?.aborted);
          if (aborted) triggerCancel();
          eventStream.push(createAntigravityErrorEvent(model, err, aborted));
        } finally {
          signal?.removeEventListener('abort', onAbort);
          eventStream.end();
        }
      })();

      return eventStream;
    },
    async close() { closed = true; clearTimeout(watchdog); ownerCookie = ''; ownerCsrf = ''; for (const active of requests) active.destroy(); events.destroy(); },
  };
}
