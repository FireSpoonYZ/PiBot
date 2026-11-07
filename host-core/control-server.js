// 模块 5：本机长期控制服务。认证与 HTTP IO 边界由 control-http.js 提供；
// 本文件只负责路由、并发跟踪与生命周期/资源释放。
import http from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { normalizeHostSettings } from './host-settings.js';
import { normalizeBotBoardParams } from './bot-board-protocol.js';
import { openHost } from './host.js';
import { openRuntime } from './runtime.js';
import { validateCenterProvider, discoverCenterProviderModels } from './runtime-models.js';
import { parseHindsightOptions } from './hindsight-client.js';
import {
  ControlHttpError,
  createControlAuthorizer,
  readControlBody,
  writeControlJson,
  writeControlError,
} from './control-http.js';
import { serveBotLive, serveWorkLive } from './control-live.js';
import { resolveRuntimeExtensions } from './extension-manager.js';
import { MEMORY_HTTP_INACTIVITY_MS, normalizeControlCall } from './remote-control-protocol.js';
import {
  normalizeShowerCreate,
  normalizeShowerFrameLimits,
  normalizeShowerInput,
  normalizeShowerSessionId,
  normalizeShowerTarget,
} from './shower-protocol.js';

const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const PROTOCOL_VERSION = 1;
const HTTP_IDLE_TIMEOUT_MS = 30000;
const JOB_STATE_RE = /^(pending|accepted|completed|failed)$/;
const MAX_STATUS_LIMIT = 200;

const EXTRA_ERROR_STATUS = Object.freeze({
  PRIMARY_BOT_PROTECTED: 409,
  BOT_ARCHIVED: 409,
  INVALID_STATE: 409,
  ATTACHMENT_NOT_FOUND: 404,
  MODEL_NO_VISION: 409,
});

const routes = [
  { method: 'POST', key: '/v1/bot-board', pattern: /^\/v1\/bot-board\/?$/, params: [], hasBody: true, handler: getBotBoard },
  { method: 'POST', key: '/v1/center/provider/validate', pattern: /^\/v1\/center\/provider\/validate\/?$/, params: [], hasBody: true, handler: centerValidateProvider },
  { method: 'POST', key: '/v1/center/provider/discover', pattern: /^\/v1\/center\/provider\/discover\/?$/, params: [], hasBody: true, handler: centerDiscoverProvider },
  { method: 'POST', key: '/v1/center/action', pattern: /^\/v1\/center\/action\/?$/, params: [], hasBody: true, handler: centerAction },
  { method: 'GET', key: '/v1/host', pattern: /^\/v1\/host\/?$/, params: [], hasBody: false, handler: getHostInfo },
  { method: 'GET', key: '/v1/bots', pattern: /^\/v1\/bots\/?$/, params: [], hasBody: false, handler: listBots },
  { method: 'POST', key: '/v1/bots', pattern: /^\/v1\/bots\/?$/, params: [], hasBody: true, handler: createBot },
  { method: 'GET', key: '/v1/bots/:botId', pattern: /^\/v1\/bots\/([^/]+)\/?$/, params: ['botId'], hasBody: false, handler: getBot },
  { method: 'DELETE', key: '/v1/bots/:botId', pattern: /^\/v1\/bots\/([^/]+)\/?$/, params: ['botId'], hasBody: false, handler: deleteBot },
  { method: 'PUT', key: '/v1/bots/:botId/profile', pattern: /^\/v1\/bots\/([^/]+)\/profile\/?$/, params: ['botId'], hasBody: true, handler: updateBotProfile },
  { method: 'POST', key: '/v1/bots/:botId/primary', pattern: /^\/v1\/bots\/([^/]+)\/primary\/?$/, params: ['botId'], hasBody: true, handler: setPrimaryBot },
  { method: 'POST', key: '/v1/bots/:botId/archive', pattern: /^\/v1\/bots\/([^/]+)\/archive\/?$/, params: ['botId'], hasBody: true, handler: archiveBot },
  { method: 'POST', key: '/v1/bots/:botId/unarchive', pattern: /^\/v1\/bots\/([^/]+)\/unarchive\/?$/, params: ['botId'], hasBody: true, handler: unarchiveBot },
  { method: 'GET', key: '/v1/bots/:botId/live', pattern: /^\/v1\/bots\/([^/]+)\/live\/?$/, params: ['botId'], hasBody: false, handler: live },
  { method: 'GET', key: '/v1/bot-requests/:requestId', pattern: /^\/v1\/bot-requests\/([^/]+)\/?$/, params: ['requestId'], hasBody: false, handler: findByRequest },
  { method: 'POST', key: '/v1/bots/:botId/submissions', pattern: /^\/v1\/bots\/([^/]+)\/submissions\/?$/, params: ['botId'], hasBody: true, handler: submit },
  { method: 'POST', key: '/v1/bots/:botId/attachments', pattern: /^\/v1\/bots\/([^/]+)\/attachments\/?$/, params: ['botId'], hasBody: true, handler: uploadAttachment },
  { method: 'POST', key: '/v1/bots/:botId/files/chunks', pattern: /^\/v1\/bots\/([^/]+)\/files\/chunks\/?$/, params: ['botId'], hasBody: true, handler: putBotFileChunk },
  { method: 'GET', key: '/v1/bots/:botId/attachments/:attachmentId', pattern: /^\/v1\/bots\/([^/]+)\/attachments\/([^/]+)\/?$/, params: ['botId', 'attachmentId'], hasBody: false, handler: getAttachment },
  { method: 'GET', key: '/v1/bots/:botId/submissions/:requestId', pattern: /^\/v1\/bots\/([^/]+)\/submissions\/([^/]+)\/?$/, params: ['botId', 'requestId'], hasBody: false, handler: getSubmission },
  { method: 'GET', key: '/v1/bots/:botId/history', pattern: /^\/v1\/bots\/([^/]+)\/history\/?$/, params: ['botId'], hasBody: false, handler: history },
  { method: 'POST', key: '/v1/bots/:botId/abort', pattern: /^\/v1\/bots\/([^/]+)\/abort\/?$/, params: ['botId'], hasBody: true, handler: abort },
  { method: 'POST', key: '/v1/bots/:botId/history/clear', pattern: /^\/v1\/bots\/([^/]+)\/history\/clear\/?$/, params: ['botId'], hasBody: true, handler: clearHistory },
  { method: 'POST', key: '/v1/bots/:botId/compact', pattern: /^\/v1\/bots\/([^/]+)\/compact\/?$/, params: ['botId'], hasBody: true, handler: compact },
  { method: 'GET', key: '/v1/bots/:botId/memory', pattern: /^\/v1\/bots\/([^/]+)\/memory\/?$/, params: ['botId'], hasBody: false, handler: memoryStatus },
  { method: 'POST', key: '/v1/bots/:botId/memory/recall', pattern: /^\/v1\/bots\/([^/]+)\/memory\/recall\/?$/, params: ['botId'], hasBody: true, handler: memoryRecall },
  { method: 'POST', key: '/v1/bots/:botId/memory/reflect', pattern: /^\/v1\/bots\/([^/]+)\/memory\/reflect\/?$/, params: ['botId'], hasBody: true, handler: memoryReflect },
  { method: 'POST', key: '/v1/bots/:botId/memory/retain', pattern: /^\/v1\/bots\/([^/]+)\/memory\/retain\/?$/, params: ['botId'], hasBody: true, handler: memoryRetain },
  { method: 'POST', key: '/v1/bots/:botId/memory/get', pattern: /^\/v1\/bots\/([^/]+)\/memory\/get\/?$/, params: ['botId'], hasBody: true, handler: memoryGet },
  { method: 'POST', key: '/v1/bots/:botId/memory/source', pattern: /^\/v1\/bots\/([^/]+)\/memory\/source\/?$/, params: ['botId'], hasBody: true, handler: memorySource },
  { method: 'POST', key: '/v1/bots/:botId/memory/correct', pattern: /^\/v1\/bots\/([^/]+)\/memory\/correct\/?$/, params: ['botId'], hasBody: true, handler: memoryCorrect },
  { method: 'POST', key: '/v1/bots/:botId/memory/retry', pattern: /^\/v1\/bots\/([^/]+)\/memory\/retry\/?$/, params: ['botId'], hasBody: true, handler: memoryRetry },
  { method: 'GET', key: '/v1/bots/:botId/context', pattern: /^\/v1\/bots\/([^/]+)\/context\/?$/, params: ['botId'], hasBody: false, handler: contextStatus },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: getWorkContext },
  { method: 'POST', key: '/v1/bots/:botId/work-contexts/:scopeKey/sync', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/sync\/?$/, params: ['botId', 'scopeKey'], hasBody: true, handler: syncWorkContext },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/history', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/history\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: workHistory },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/context', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/context\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: workContextStatus },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/activity', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/activity\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: getWorkActivity },
  { method: 'POST', key: '/v1/bots/:botId/work-contexts/:scopeKey/stop', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/stop\/?$/, params: ['botId', 'scopeKey'], hasBody: true, handler: stopWork },
  { method: 'POST', key: '/v1/bots/:botId/work-contexts/:scopeKey/resume', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/resume\/?$/, params: ['botId', 'scopeKey'], hasBody: true, handler: resumeWork },
  { method: 'GET', key: '/v1/models', pattern: /^\/v1\/models\/?$/, params: [], hasBody: false, handler: models },
  { method: 'POST', key: '/v1/models/discover', pattern: /^\/v1\/models\/discover\/?$/, params: [], hasBody: true, handler: discoverModels },
  { method: 'GET', key: '/v1/bots/:botId/work-contexts/:scopeKey/live', pattern: /^\/v1\/bots\/([^/]+)\/work-contexts\/([^/]+)\/live\/?$/, params: ['botId', 'scopeKey'], hasBody: false, handler: workLive },
  { method: 'GET', key: '/v1/scopes', pattern: /^\/v1\/scopes\/?$/, params: [], hasBody: false, handler: listScopes },
  { method: 'POST', key: '/v1/scopes', pattern: /^\/v1\/scopes\/?$/, params: [], hasBody: true, handler: createScope },
  { method: 'GET', key: '/v1/scopes/:scopeKey/history', pattern: /^\/v1\/scopes\/([^/]+)\/history\/?$/, params: ['scopeKey'], hasBody: false, handler: scopeHistory },
  { method: 'GET', key: '/v1/scopes/:scopeKey/messages/:messageKey', pattern: /^\/v1\/scopes\/([^/]+)\/messages\/([^/]+)\/?$/, params: ['scopeKey', 'messageKey'], hasBody: false, handler: scopeMessage },
  { method: 'GET', key: '/v1/scopes/:scopeKey/messages/:messageKey/delivery', pattern: /^\/v1\/scopes\/([^/]+)\/messages\/([^/]+)\/delivery\/?$/, params: ['scopeKey', 'messageKey'], hasBody: false, handler: scopeMessageDelivery },
  { method: 'GET', key: '/v1/settings', pattern: /^\/v1\/settings\/?$/, params: [], hasBody: false, handler: getSettings },
  { method: 'PUT', key: '/v1/settings', pattern: /^\/v1\/settings\/?$/, params: [], hasBody: true, handler: putSettings },
  { method: 'GET', key: '/v1/bots/:botId/soul', pattern: /^\/v1\/bots\/([^/]+)\/soul\/?$/, params: ['botId'], hasBody: false, handler: getBotSoul },
  { method: 'PUT', key: '/v1/bots/:botId/soul', pattern: /^\/v1\/bots\/([^/]+)\/soul\/?$/, params: ['botId'], hasBody: true, handler: setBotSoul },
  { method: 'POST', key: '/v1/bots/:botId/learning', pattern: /^\/v1\/bots\/([^/]+)\/learning\/?$/, params: ['botId'], hasBody: true, handler: manageBotLearning },
  { method: 'POST', key: '/v1/bots/:botId/schedules', pattern: /^\/v1\/bots\/([^/]+)\/schedules\/?$/, params: ['botId'], hasBody: true, handler: botSchedules },
  { method: 'POST', key: '/v1/service/update', pattern: /^\/v1\/service\/update\/?$/, params: [], hasBody: true, handler: updateService },
  { method: 'GET', key: '/v1/service', pattern: /^\/v1\/service\/?$/, params: [], hasBody: false, handler: serviceStatus },
  { method: 'GET', key: '/v1/scopes/:scopeKey', pattern: /^\/v1\/scopes\/([^/]+)\/?$/, params: ['scopeKey'], hasBody: false, handler: getScopeState },
  { method: 'POST', key: '/v1/scopes/:scopeKey/members', pattern: /^\/v1\/scopes\/([^/]+)\/members\/?$/, params: ['scopeKey'], hasBody: true, handler: updateScopeMembers },
  { method: 'POST', key: '/v1/scopes/:scopeKey/delete', pattern: /^\/v1\/scopes\/([^/]+)\/delete\/?$/, params: ['scopeKey'], hasBody: true, handler: deleteScope },
  { method: 'POST', key: '/v1/scopes/:scopeKey/messages', pattern: /^\/v1\/scopes\/([^/]+)\/messages\/?$/, params: ['scopeKey'], hasBody: true, handler: publishUserMessage },
  { method: 'GET', key: '/v1/scopes/:scopeKey/replicas', pattern: /^\/v1\/scopes\/([^/]+)\/replicas\/?$/, params: ['scopeKey'], hasBody: false, handler: listScopeReplicas },
  // Unified Shower v2：body 恰为远端参数；认证/Origin 拒绝沿用全局 authorize。
  { method: 'POST', key: '/v1/shower/status', pattern: /^\/v1\/shower\/status\/?$/, params: [], hasBody: true, handler: showerStatus },
  { method: 'POST', key: '/v1/shower/create', pattern: /^\/v1\/shower\/create\/?$/, params: [], hasBody: true, handler: showerCreate },
  { method: 'POST', key: '/v1/shower/frame', pattern: /^\/v1\/shower\/frame\/?$/, params: [], hasBody: true, handler: showerFrame },
  { method: 'POST', key: '/v1/shower/input', pattern: /^\/v1\/shower\/input\/?$/, params: [], hasBody: true, handler: showerInput },
  { method: 'POST', key: '/v1/shower/takeover', pattern: /^\/v1\/shower\/takeover\/?$/, params: [], hasBody: true, handler: showerTakeover },
  { method: 'POST', key: '/v1/shower/release', pattern: /^\/v1\/shower\/release\/?$/, params: [], hasBody: true, handler: showerRelease },
];

// The eight Hindsight routes may legitimately stay silent for up to the 120s
// backend cap and one manual compaction can wait on a model summarization;
// only these responses extend the socket inactivity window.
const SLOW_ROUTE_KEYS = new Set([
  '/v1/bots/:botId/memory',
  '/v1/bots/:botId/memory/recall',
  '/v1/bots/:botId/memory/reflect',
  '/v1/bots/:botId/memory/retain',
  '/v1/bots/:botId/memory/get',
  '/v1/bots/:botId/memory/source',
  '/v1/bots/:botId/memory/correct',
  '/v1/bots/:botId/memory/retry',
  '/v1/bots/:botId/compact',
]);

/**
 * 打开长期本机控制服务。token 与 port 在打开任何数据前校验；
 * 只固定绑定 127.0.0.1；单个 openRuntime + 单独 openHost 登记连接。
 */
export async function openControlServer(options) {
  const { token, port = DEFAULT_PORT, settings, getServiceStatus, deferResume, onBotsChanged, onBotsSync, ...runtimeOptions } = options ?? {};
  // 可选 settings/callback 一旦提供必须完整合法，否则 INVALID_ARGUMENT，不静默当未配置。
  let settingsStore = null;
  let activeRevision = null;
  if (settings !== undefined) {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings must be an object');
    }
    const store = settings.store;
    if (typeof store !== 'object' || store === null ||
        typeof store.get !== 'function' || typeof store.replace !== 'function' || typeof store.close !== 'function') {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings.store must expose get/replace/close');
    }
    if (!Number.isSafeInteger(settings.activeRevision) || settings.activeRevision <= 0) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings.activeRevision must be a positive safe integer');
    }
    settingsStore = store;
    activeRevision = settings.activeRevision;
  }
  if (getServiceStatus !== undefined && typeof getServiceStatus !== 'function') {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'getServiceStatus must be a function');
  }
  const ctx = {
    settingsStore,
    activeRevision,
    getServiceStatus: getServiceStatus ?? null,
    centerManaged: Boolean(runtimeOptions.centerRuntime),
    onBotsChanged,
    onBotsSync,
  };
  assertPort(port);
  // token 格式由 createControlAuthorizer 校验；在打开任何数据前调用并保留结果。
  const authorize = createControlAuthorizer(token);

  // 先校验生效的规范扩展配置（含 enabled 扩展的 apiKeyEnv 解析），再打开本服务自己的 Host；
  // 仍把原始字段传给 openRuntime，绝不把归一化后的 apiKey 对象送回公共解析器。
  // 生效映射复用规范解析：disabled 的别名不解析凭证；HostService 同时传 extensions+hindsight 是合法输入。
  const effectiveExtensions = resolveRuntimeExtensions(runtimeOptions);
  parseHindsightOptions(
    effectiveExtensions.hindsight?.enabled ? effectiveExtensions.hindsight.config : undefined
  );

  // nativeBridge 只能注入函数；在打开本服务 Host 前拒绝，避免已开资源泄漏。
  if (runtimeOptions.nativeBridge !== undefined && typeof runtimeOptions.nativeBridge !== 'function') {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'nativeBridge must be a function');
  }

  const host = openHost({ dataRoot: runtimeOptions.dataRoot });
  let runtime;
  try {
    runtime = await openRuntime({ ...runtimeOptions, onBotsChanged, onBotsSync });
  } catch (err) {
    try { host.close(); } catch { /* 打开失败清理不掩盖原错误 */ }
    throw err;
  }

  let closed = false;
  const inflight = new Set();
  const track = (task) => {
    inflight.add(task);
    task.then(() => inflight.delete(task), () => inflight.delete(task));
  };

  const server = http.createServer((req, res) => {
    if (closed) {
      res.destroy();
      return;
    }
    track((async () => {
      try {
        await dispatch(host, runtime, authorize, req, res, ctx);
      } catch (err) {
        if (!res.writableEnded) {
          const mapped = !(err instanceof ControlHttpError) && typeof err?.code === 'string' && EXTRA_ERROR_STATUS[err.code]
            ? new ControlHttpError(EXTRA_ERROR_STATUS[err.code], err.code, err.message)
            : err;
          try { writeControlError(res, mapped); } catch { res.destroy(); }
        }
      }
    })());
  });
  // 头部/请求体读取有界，慢请求不会让关闭无限等待。
  server.headersTimeout = 15000;
  server.requestTimeout = 60000;
  server.timeout = HTTP_IDLE_TIMEOUT_MS;

  await listen(server, port).catch(async (err) => {
    try { server.close(); } catch { /* 释放本次资源不掩盖原错误 */ }
    try { await runtime.close(); } catch { /* 释放本次资源不掩盖原错误 */ }
    try { host.close(); } catch { /* 释放本次资源不掩盖原错误 */ }
    throw err;
  });

  try {
    if (!deferResume) runtime.resume(); // 仅监听成功后启动已有任务调度
  } catch (err) {
    try { server.close(); server.closeAllConnections(); } catch { /* 不掩盖原错误 */ }
    try { await runtime.close(); } catch { /* 不掩盖原错误 */ }
    try { host.close(); } catch { /* 不掩盖原错误 */ }
    throw err;
  }

  const url = 'http://' + BIND_HOST + ':' + server.address().port;
  let closePromise = null;
  const close = () => {
    closePromise ??= (async () => {
      closed = true;
      const errors = [];
      const serverClosed = new Promise((resolve) => server.once('close', resolve));
      // 先关闭监听与本次连接：慢请求体读取被取消，不会拖住关闭。
      try { server.close(); } catch (err) { errors.push(err); }
      try { server.closeIdleConnections(); } catch (err) { errors.push(err); }
      try { server.closeAllConnections(); } catch (err) { errors.push(err); }
      // 再等待已接受调用收尾，最后关闭运行时与登记连接。
      try {
        while (inflight.size > 0) await Promise.allSettled([...inflight]);
      } catch (err) { errors.push(err); }
      try { await serverClosed; } catch (err) { errors.push(err); }
      try { await runtime.close(); } catch (err) { errors.push(err); }
      try { host.close(); } catch (err) { errors.push(err); }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'control server close failed');
    })();
    return closePromise;
  };

  return {
    deviceId: host.deviceId,
    url,
    close,
    resume: () => runtime.resume(),
    // Internal SSE wakeup only; no public route or caller-supplied origin.
    notifyWebhookReady: () => runtime.notifyWebhookReady(),
    applyCenterSnapshot: (snapshot, options) => runtime.applyCenterSnapshot(snapshot, options),
    // 内部即时撤销；不注册 HTTP 路由，不对外暴露。
    revokeCenterCapabilities: (snapshot) => runtime.revokeCenterCapabilities(snapshot),
    setCenterOnline: (online) => runtime.setCenterOnline(online),
    withCapabilityActivation: (id, publish) => runtime.withCapabilityActivation(id, publish),
    // 冷启动 pinned-turn 恢复；HostService 在 activation/resume 前调用一次。不注册 HTTP 路由。
    restoreTurns: () => runtime.restoreTurns(),
  };
}

async function dispatch(host, runtime, authorize, req, res, ctx) {
  authorize(req);
  let url;
  try {
    url = new URL(req.url, 'http://' + BIND_HOST);
  } catch {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'malformed request URL');
  }
  const method = req.method.toUpperCase();
  // 先收集全部路径匹配项，再按方法选择：避免同路径 GET 挡住 POST。
  const pathMatches = [];
  for (const route of routes) {
    const m = route.pattern.exec(url.pathname);
    if (m) pathMatches.push({ route, segments: m.slice(1) });
  }
  if (pathMatches.length === 0) throw new ControlHttpError(404, 'NOT_FOUND', 'unknown route: ' + url.pathname);
  const match = pathMatches.find((item) => item.route.method === method);
  if (!match) {
    const allowed = [...new Set(pathMatches.map((item) => item.route.method))];
    res.setHeader('Allow', allowed.join(', '));
    throw new ControlHttpError(405, 'METHOD_NOT_ALLOWED', 'method ' + method + ' not allowed for ' + url.pathname);
  }

  const centerStatus = ctx.getServiceStatus?.().center;
  // 离线/恢复暂停只放行本地已鉴权动作：持久 enqueue、被动回执/状态与取消。
  // 这些路径走 Harness snapshot/commit/abortTask，不隐式 resume 调度器；
  // 模型、工具、问卷等执行路由仍被拒绝（runtime 侧另有 online/recovery 门禁兜底）。
  const OFFLINE_ALLOWED = new Set([
    '/v1/host', '/v1/settings', '/v1/service', '/v1/service/update', '/v1/bot-board',
    '/v1/bots/:botId/submissions', '/v1/bots/:botId/submissions/:requestId', '/v1/bots/:botId/abort',
    '/v1/bot-requests/:requestId', '/v1/bots/:botId/history', '/v1/bots/:botId/live',
    // 只读读取已上传图片：中心离线时草稿/历史仍可展示既有附件。
    '/v1/bots/:botId/attachments/:attachmentId',
    // 被动 scope 只读浏览：与 runtime proxy offlineMethods 同一批纯账本读，
    // 不写、不推理（createScope/updateScopeMembers/publishUserMessage 仍受 Center 门禁）。
    '/v1/scopes', '/v1/scopes/:scopeKey', '/v1/scopes/:scopeKey/history',
    '/v1/scopes/:scopeKey/messages/:messageKey',
    '/v1/scopes/:scopeKey/messages/:messageKey/delivery',
    '/v1/scopes/:scopeKey/replicas',
  ]);
  if (centerStatus && centerStatus.state !== 'ready' && !OFFLINE_ALLOWED.has(match.route.key)) {
    throw new ControlHttpError(503, 'CENTER_OFFLINE', 'center is not ready');
  }
  const params = {};
  match.route.params.forEach((name, i) => {
    params[name] = decodeSegment(match.segments[i]);
  });

  let body;
  if (match.route.hasBody) {
    body = await readControlBody(req);
  } else {
    req.resume(); // 排空多余请求体，避免占用保活连接
  }
  // 只有 memory/compact 路由放宽处理期间 socket 空闲上限；请求体/头/其他路由不变，
  // 响应结束后恢复默认值，keep-alive 复用连接不继承 130s。
  const extendedIdle = SLOW_ROUTE_KEYS.has(match.route.key);
  if (extendedIdle) res.setTimeout(MEMORY_HTTP_INACTIVITY_MS);
  try {
    await match.route.handler(host, runtime, params, body, req, res, ctx);
  } finally {
    if (extendedIdle) res.setTimeout(HTTP_IDLE_TIMEOUT_MS);
  }
}

async function centerValidateProvider(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await validateCenterProvider(body));
}
async function centerDiscoverProvider(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await discoverCenterProviderModels(body));
}
async function centerAction(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.callCapabilityAction(body.installationId, body.action, body.request));
}

async function getHostInfo(host, runtime, params, body, req, res) {
  const device = await runtime.getCurrentDevice();
  writeControlJson(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    deviceId: host.deviceId,
    defaultWorkspace: host.defaultWorkspace,
    displayName: device.displayName,
    platform: device.platform,
    arch: device.arch,
  });
}

async function listBots(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, host.listBots());
}

async function createBot(host, runtime, params, body, req, res) {
  const bot = await runtime.createBot(body);
  writeControlJson(res, 201, bot);
}

async function updateBotProfile(host, runtime, params, body, req, res, ctx) {
  const bot = host.updateBotProfile({ ...body, botId: params.botId });
  if (ctx.onBotsSync) await ctx.onBotsSync();
  else if (ctx.onBotsChanged) await ctx.onBotsChanged();
  writeControlJson(res, 200, bot);
}

async function setPrimaryBot(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.setPrimaryBot(params.botId));
}

async function archiveBot(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.archiveBot(params.botId));
}

async function unarchiveBot(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.unarchiveBot(params.botId));
}

async function deleteBot(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.deleteBot(params.botId));
}

async function getBot(host, runtime, params, body, req, res) {
  const bot = host.getBot(params.botId);
  if (!bot) throw new ControlHttpError(404, 'BOT_NOT_FOUND', 'bot not found');
  writeControlJson(res, 200, bot);
}

async function live(host, runtime, params, body, req, res) {
  await serveBotLive(req, res, runtime, params.botId);
}

async function findByRequest(host, runtime, params, body, req, res) {
  const bot = host.findByRequest(params.requestId);
  if (!bot) throw new ControlHttpError(404, 'BOT_REQUEST_NOT_FOUND', 'request not found');
  writeControlJson(res, 200, bot);
}

async function submit(host, runtime, params, body, req, res) {
  // 只等待受理，不等待模型回答。
  const submission = await runtime.submit(params.botId, {
    ...body,
    origin: { sender: { kind: 'user' }, replyTo: null },
  });
  writeControlJson(res, 202, submission);
}

// body 恰为远端 v2 参数 {botId?,name,mimeType,data}；botId 以路径为准，
// 与远端 submit 一样由 normalizeControlCall 校验大小/字段/编码。
async function uploadAttachment(host, runtime, params, body, req, res) {
  const { params: input } = normalizeControlCall('uploadAttachment', { ...body, botId: params.botId });
  writeControlJson(res, 200, await runtime.uploadAttachment(params.botId, {
    name: input.name,
    mimeType: input.mimeType,
    data: input.data,
  }));
}

async function putBotFileChunk(host, runtime, params, body, req, res) {
  const { params: { botId, ...input } } = normalizeControlCall('putBotFileChunk', { ...body, botId: params.botId });
  writeControlJson(res, 200, await runtime.putBotFileChunk(botId, input));
}

async function getAttachment(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const { params: input } = normalizeControlCall('getAttachment', params);
  writeControlJson(res, 200, await runtime.getAttachment(params.botId, input.attachmentId));
}

async function getSubmission(host, runtime, params, body, req, res) {
  const submission = await runtime.getSubmission(params.botId, params.requestId);
  if (!submission) throw new ControlHttpError(404, 'SUBMISSION_NOT_FOUND', 'submission not found');
  writeControlJson(res, 200, submission);
}

async function history(host, runtime, params, body, req, res) {
  const search = new URL(req.url, 'http://' + BIND_HOST).searchParams;
  const options = parseHistoryQuery(search);
  const chunked = search.get('chunked');
  if (chunked !== null) {
    if (chunked !== 'true' && chunked !== 'false') {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'chunked must be a boolean');
    }
    options.chunked = chunked === 'true';
  }
  const page = await runtime.history(params.botId, options);
  writeControlJson(res, 200, page);
}

async function abort(host, runtime, params, body, req, res) {
  await runtime.abort(params.botId);
  writeControlJson(res, 200, { botId: params.botId });
}

async function getBotBoard(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.getBotBoard(normalizeBotBoardParams(body)));
}

// /clear 与 /compact 不读取请求体（与 abort 一致），成功才返回新的可见历史边界/压缩结果。
async function clearHistory(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.clearHistory(params.botId));
}

async function compact(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.compact(params.botId));
}

async function memoryStatus(host, runtime, params, body, req, res) {
  const input = parseMemoryStatusQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams);
  writeControlJson(res, 200, await runtime.memoryStatus(params.botId, input));
}

async function memoryRecall(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.recallMemory(params.botId, body));
}

async function memoryReflect(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.reflectMemory(params.botId, body));
}

async function memoryRetain(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 202, await runtime.retainMemory(params.botId, body));
}

async function memoryGet(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.getMemory(params.botId, body));
}

async function memorySource(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.getMemorySource(params.botId, body));
}

async function memoryCorrect(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 202, await runtime.correctMemory(params.botId, body));
}
async function memoryRetry(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 202, await runtime.retryMemory(params.botId, body));
}

async function contextStatus(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.contextStatus(params.botId));
}

async function getWorkContext(host, runtime, params, body, req, res) {
  const record = await runtime.getWorkContext(params.botId, workScopeId(params.scopeKey));
  if (!record) throw new ControlHttpError(404, 'WORK_CONTEXT_NOT_FOUND', 'work context not found');
  writeControlJson(res, 200, record);
}

async function syncWorkContext(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.syncWorkContext(params.botId, workScopeId(params.scopeKey), body));
}

async function workHistory(host, runtime, params, body, req, res) {
  const scopeId = workScopeId(params.scopeKey);
  const options = parseHistoryQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams);
  writeControlJson(res, 200, await runtime.workHistory(params.botId, scopeId, options));
}

async function workContextStatus(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.workContextStatus(params.botId, workScopeId(params.scopeKey)));
}

async function getWorkActivity(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.getWorkActivity(params.botId, workScopeId(params.scopeKey)));
}

async function stopWork(host, runtime, params, body, req, res) {
  if (Object.keys(body).length !== 0) throw invalidArgument('stopWork body must be an empty object');
  writeControlJson(res, 200, await runtime.stopWork(params.botId, workScopeId(params.scopeKey)));
}

async function resumeWork(host, runtime, params, body, req, res) {
  if (Object.keys(body).length !== 0) throw invalidArgument('resumeWork body must be an empty object');
  writeControlJson(res, 200, await runtime.resumeWork(params.botId, workScopeId(params.scopeKey)));
}

async function listScopes(host, runtime, params, body, req, res) {
  const options = parseScopeQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams, ['limit', 'cursor']);
  writeControlJson(res, 200, await runtime.listScopeStates(options));
}

async function createScope(host, runtime, params, body, req, res) {
  writeControlJson(res, 201, await runtime.createScope(body));
}

async function getScopeState(host, runtime, params, body, req, res) {
  // get-scope 不允许任何查询参数；从严拒绝未知/重复查询字段。
  parseScopeQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams, []);
  writeControlJson(res, 200, await runtime.getScopeState(workScopeId(params.scopeKey)));
}

async function updateScopeMembers(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.updateScope(workScopeId(params.scopeKey), body));
}

async function deleteScope(host, runtime, params, body, req, res) {
  writeControlJson(res, 200, await runtime.deleteScope(workScopeId(params.scopeKey), body));
}

async function publishUserMessage(host, runtime, params, body, req, res) {
  writeControlJson(res, 202, await runtime.publishUserMessage(workScopeId(params.scopeKey), body));
}

async function listScopeReplicas(host, runtime, params, body, req, res) {
  const options = parseScopeQuery(new URL(req.url, 'http://' + BIND_HOST).searchParams, ['limit', 'cursor']);
  writeControlJson(res, 200, await runtime.listScopeReplicas(workScopeId(params.scopeKey), options));
}

// Shower body 是远端参数 {botId,scopeId?,...}：未知字段直接 400，target 只由
// botId/scopeId 派生（模型不能给 Actor/targetDeviceId），其余值走同一套 normalizer。
const SHOWER_TARGET_KEYS = ['botId', 'scopeId'];

function showerTarget(body, extraKeys) {
  for (const key of Object.keys(body)) {
    if (!SHOWER_TARGET_KEYS.includes(key) && !extraKeys.includes(key)) {
      throw invalidArgument('unknown shower request field: ' + key);
    }
  }
  return normalizeShowerTarget({ botId: body.botId, scopeId: body.scopeId });
}

// create/frame 立即返回当前快照（starting/authentication-required 不阻塞），
// 不延长控制请求的 20s 框架；帧大小上限由协议与 backend 保证在通用线/帧预算内。
async function showerStatus(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.getShowerStatus(showerTarget(body, [])));
}

async function showerCreate(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const target = showerTarget(body, ['input']);
  const input = body.input === undefined ? undefined : normalizeShowerCreate(body.input);
  writeControlJson(res, 200, await runtime.createShowerSession(target, input));
}

async function showerFrame(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const target = showerTarget(body, ['sessionId', 'limits']);
  const sessionId = normalizeShowerSessionId(body.sessionId);
  const limits = body.limits === undefined ? undefined : normalizeShowerFrameLimits(body.limits);
  writeControlJson(res, 200, await runtime.getShowerFrame(target, sessionId, limits));
}

async function showerInput(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const target = showerTarget(body, ['sessionId', 'input']);
  const sessionId = normalizeShowerSessionId(body.sessionId);
  writeControlJson(res, 200, await runtime.sendShowerInput(target, sessionId, normalizeShowerInput(body.input)));
}

async function showerTakeover(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const target = showerTarget(body, ['sessionId']);
  writeControlJson(res, 200, await runtime.takeoverShower(target, normalizeShowerSessionId(body.sessionId)));
}

async function showerRelease(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const target = showerTarget(body, ['sessionId']);
  writeControlJson(res, 200, await runtime.releaseShowerSession(target, normalizeShowerSessionId(body.sessionId)));
}

async function models(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.getModelCatalog());
}

async function workLive(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  await serveWorkLive(req, res, runtime, params.botId, workScopeId(params.scopeKey));
}

async function scopeHistory(host, runtime, params, body, req, res) {
  const options = parseScopeQuery(
    new URL(req.url, 'http://' + BIND_HOST).searchParams,
    ['limit', 'cursor', 'order']
  );
  if (options.order !== undefined) {
    if (options.order !== 'ascending' && options.order !== 'descending') {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', "order must be 'ascending' or 'descending'");
    }
  } else {
    delete options.order;
  }
  writeControlJson(res, 200, await runtime.scopeHistory(workScopeId(params.scopeKey), options));
}

async function scopeMessage(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  // messageKey 也固定 ~ 前缀（与 scopeKey 同一套保护/解码）。
  const message = await runtime.getScopeMessage(workScopeId(params.scopeKey), workScopeId(params.messageKey));
  if (!message) throw new ControlHttpError(404, 'MESSAGE_NOT_FOUND', 'message not found');
  writeControlJson(res, 200, message);
}

async function scopeMessageDelivery(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  const delivery = await runtime.getScopeMessageDelivery(workScopeId(params.scopeKey), workScopeId(params.messageKey));
  if (!delivery) throw new ControlHttpError(404, 'DELIVERY_NOT_FOUND', 'delivery not found');
  writeControlJson(res, 200, delivery);
}

async function getSettings(host, runtime, params, body, req, res, ctx) {
  assertNoQuery(req);
  if (!ctx.settingsStore) throw new ControlHttpError(503, 'CONTROL_UNAVAILABLE', 'settings store is not configured');
  const snapshot = ctx.settingsStore.get();
  writeControlJson(res, 200, {
    ...snapshot,
    activeRevision: ctx.activeRevision,
    restartRequired: snapshot.revision !== ctx.activeRevision,
  });
}

async function putSettings(host, runtime, params, body, req, res, ctx) {
  assertNoQuery(req);
  if (!ctx.settingsStore) throw new ControlHttpError(503, 'CONTROL_UNAVAILABLE', 'settings store is not configured');
  const update = validateSettingsUpdate(body);
  if (ctx.centerManaged) {
    const previous = ctx.settingsStore.get().settings.runtime;
    const next = normalizeHostSettings(update.settings).runtime;
    for (const field of ['providers', 'defaultModel', 'thinkingLevel', 'hindsight', 'extensions']) {
      if (!isDeepStrictEqual(previous[field], next[field])) {
        throw new ControlHttpError(403, 'INVALID_ARGUMENT', 'provider, model and extension settings are managed by the center');
      }
    }
  }
  const snapshot = ctx.settingsStore.replace(update);
  if (!ctx.centerManaged) {
    try { runtime?.reloadModels?.(snapshot.settings?.runtime); } catch { /* ignore */ }
  }
  writeControlJson(res, 200, {
    ...snapshot,
    activeRevision: ctx.activeRevision,
    restartRequired: snapshot.revision !== ctx.activeRevision,
  });
}

function validateSettingsUpdate(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings update must be a JSON object');
  }
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('expectedRevision') || !keys.includes('settings')) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings update must contain exactly expectedRevision and settings');
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision <= 0) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'expectedRevision must be a positive safe integer');
  }
  if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'settings must be a JSON object');
  }
  return { expectedRevision: body.expectedRevision, settings: body.settings };
}

// Bot 扩展/SOUL 路由：未知 Bot 与设置/内存路由一致直接 404，输入校验交给 runtime CAS。
function requireBot(host, botId) {
  if (!host.getBot(botId)) throw new ControlHttpError(404, 'BOT_NOT_FOUND', 'bot not found');
}

async function getBotSoul(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  requireBot(host, params.botId);
  writeControlJson(res, 200, await runtime.getBotSoul(params.botId));
}

async function setBotSoul(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  requireBot(host, params.botId);
  writeControlJson(res, 200, await runtime.setBotSoul(params.botId, body));
}

async function manageBotLearning(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  requireBot(host, params.botId);
  writeControlJson(res, 200, await runtime.manageBotLearning(params.botId, body));
}

async function botSchedules(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  requireBot(host, params.botId);
  writeControlJson(res, 200, await runtime.scheduleTask(params.botId, body));
}

async function discoverModels(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  writeControlJson(res, 200, await runtime.discoverProviderModels(body));
}

async function updateService(host, runtime, params, body, req, res) {
  assertNoQuery(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => !['action', 'stopActive'].includes(key))
      || !['prepare', 'cancel'].includes(body.action)
      || (body.stopActive !== undefined && typeof body.stopActive !== 'boolean')) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'invalid update operation');
  }
  writeControlJson(res, 200, await (body.action === 'prepare'
    ? runtime.prepareUpdate({ stopActive: body.stopActive ?? false })
    : runtime.cancelUpdate()));
}

async function serviceStatus(host, runtime, params, body, req, res, ctx) {
  assertNoQuery(req);
  if (!ctx.getServiceStatus) throw new ControlHttpError(503, 'CONTROL_UNAVAILABLE', 'service status is not configured');
  writeControlJson(res, 200, await ctx.getServiceStatus());
}

function workScopeId(scopeKey) {
  // dispatch 已解码一次；固定前缀保护 '.'/'..' scope，避免 URL 路径折叠。
  if (!scopeKey.startsWith('~')) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'work context scope path segment must start with ~');
  }
  return scopeKey.slice(1);
}

function parseHistoryQuery(searchParams) {
  const rawLimit = searchParams.get('limit');
  let limit;
  if (rawLimit !== null) {
    if (!/^[1-9]\d*$/.test(rawLimit)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'limit must be a positive decimal integer');
    }
    limit = Number(rawLimit);
  }
  const rawCursor = searchParams.get('cursor');
  let cursor;
  if (rawCursor !== null) {
    try {
      cursor = JSON.parse(rawCursor);
    } catch {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
    }
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
    }
  }
  return { limit, cursor };
}

// 新 scope 路由严格查询解析：只允许指定键、每个键至多一次，拒绝未知/重复字段。
function parseScopeQuery(searchParams, allowed) {
  const seen = new Set();
  const options = {};
  for (const [key, value] of searchParams) {
    if (!allowed.includes(key)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'unknown query parameter: ' + key);
    }
    if (seen.has(key)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'query parameter may appear at most once: ' + key);
    }
    seen.add(key);
    if (key === 'limit') {
      if (!/^[1-9]\d*$/.test(value)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'limit must be a positive decimal integer');
      }
      options.limit = Number(value);
    } else if (key === 'order') {
      options.order = value;
    } else {
      try {
        options.cursor = JSON.parse(value);
      } catch {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
      }
      if (options.cursor === null || typeof options.cursor !== 'object' || Array.isArray(options.cursor)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'cursor must be a JSON object');
      }
    }
  }
  return options;
}

// GET memory 状态严格查询解析：只允许 target/state/limit/cursor，每键至多一次，
// 拒绝未知/重复/畸形值；无任何参数时返回 {}（默认 primary、全部状态、limit20）。
function parseMemoryStatusQuery(searchParams) {
  const seen = new Set();
  const input = {};
  for (const [key, value] of searchParams) {
    if (key !== 'target' && key !== 'state' && key !== 'limit' && key !== 'cursor') {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'unknown query parameter: ' + key);
    }
    if (seen.has(key)) {
      throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'query parameter may appear at most once: ' + key);
    }
    seen.add(key);
    if (key === 'state') {
      if (!JOB_STATE_RE.test(value)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'state must be pending, accepted, completed, or failed');
      }
      input.state = value;
    } else if (key === 'limit') {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > MAX_STATUS_LIMIT) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', `limit must be a strict positive integer between 1 and ${MAX_STATUS_LIMIT}`);
      }
      input.limit = Number(value);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', key + ' must be a JSON object');
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ControlHttpError(400, 'INVALID_ARGUMENT', key + ' must be a JSON object');
      }
      input[key] = parsed;
    }
  }
  return input;
}

// memory POST 路由不允许任何查询参数；从严拒绝未知/重复查询字段。
function assertNoQuery(req) {
  if (new URL(req.url, 'http://' + BIND_HOST).searchParams.size > 0) {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'query parameters are not allowed for this route');
  }
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new ControlHttpError(400, 'INVALID_ARGUMENT', 'malformed percent-encoding in URL path');
  }
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw invalidArgument('port must be an integer between 0 and 65535');
  }
}

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
