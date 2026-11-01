import http from 'node:http';
import https from 'node:https';
import { assertDeviceToken } from './relay-protocol.js';
import { assertId } from './message-protocol.js';

function centerError(code, message) {
  return Object.assign(new Error(message), { code });
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

export async function connectCenter({ centerUrl, deviceId, deviceToken, ca, signal, onDisconnect, onChange }) {
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
  const start = (path, { method = 'GET', body, signal } = {}) => {
    if (closed) throw centerError('CENTER_OFFLINE', 'center is disconnected');
    const req = transport.request(new URL(path, base), {
      method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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
      // 仅 turn 准入端点透传服务端类型化错误码（TURN_SET_CHANGED/TURN_SYNC_FAILED 等），
      // 其他路径保持既有 CENTER_REQUEST_FAILED 语义及 ownerRequest 回退。
      const typedTurnError = path.startsWith('/api/host/turns/');
      let errorCode = null;
      let errorMessage = null;
      if (typedTurnError) {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof parsed?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(parsed.error.code)) {
            errorCode = parsed.error.code;
            if (typeof parsed.error.message === 'string' && parsed.error.message.length <= 512) errorMessage = parsed.error.message;
          }
        } catch { /* 非 JSON 错误体按状态码兜底 */ }
      } else {
        response.resume();
      }
      if (errorCode) throw centerError(errorCode, errorMessage ?? 'center request failed');
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
  const botCapabilitiesPath = (targetDeviceId, botId) => '/api/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/capabilities';
  const hostBotCapabilitiesPath = (targetDeviceId, botId) => '/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/bots/' + encodeURIComponent(botId) + '/capabilities';
  const runtimeStatusPath = (targetDeviceId) => '/api/devices/' + encodeURIComponent(targetDeviceId) + '/runtime-status';
  const hostRuntimeStatusPath = (targetDeviceId) => '/api/host/devices/' + encodeURIComponent(targetDeviceId) + '/runtime-status';
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
        if (frame.split(/\r?\n/).some((line) => line === 'event: config-changed')) onChange?.();
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
    botModelGet: (targetDeviceId, botId, signal) => request(hostBotModelPath(targetDeviceId, botId), { signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(botModelPath(targetDeviceId, botId), { signal }) : Promise.reject(err)),
    botModelSet: (targetDeviceId, botId, input, signal) => request(hostBotModelPath(targetDeviceId, botId), { method: 'PUT', body: input, signal }).catch(err => err?.code === 'CENTER_REQUEST_FAILED' ? ownerRequest(botModelPath(targetDeviceId, botId), { method: 'PUT', body: input, signal }) : Promise.reject(err)),
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
    prepareTurn: (input, options = {}) => request('/api/host/turns/prepare', { method: 'POST', body: input, signal: options.signal }),
    confirmTurn: (input, options = {}) => request('/api/host/turns/confirm', { method: 'POST', body: input, signal: options.signal }),
    restoreTurn: (input, options = {}) => request('/api/host/turns/restore', { method: 'POST', body: input, signal: options.signal }),
    listCapabilityTools: (id, botId, options = {}) => request('/api/host/capabilities/' + encodeURIComponent(id) + '/tools/list', { method: 'POST', body: { botId }, signal: options.signal }),
    callCapabilityTool: (id, botId, name, args, callId, options = {}) => request('/api/host/capabilities/' + encodeURIComponent(id) + '/tools/call', { method: 'POST', body: { botId, name, args, callId }, signal: options.signal }),
    async close() { closed = true; clearTimeout(watchdog); ownerCookie = ''; ownerCsrf = ''; for (const active of requests) active.destroy(); events.destroy(); },
  };
}
