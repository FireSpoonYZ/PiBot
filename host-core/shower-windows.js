// host-core/shower-windows.js
// Windows Shower backend: one fixed native child-session host
// (host-core/native/windows/build/shower-windows.exe) per machine, driven over
// strict JSONL on stdin/stdout. The RDP host runs in the parent session and only
// forwards frame/input/launch to its own child-session agent, so this adapter
// never captures or injects the physical desktop. Session ownership stays with
// the manager: this file uses the manager-allocated sessionId, never invents a
// second desktop, never adopts another process' child session, and never
// retries or replays input. Request payloads, image data and credentials are
// never forwarded to stderr or into error messages.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { messageError } from './message-protocol.js';
import { SHOWER_ERROR_CODES, SHOWER_MAX_FRAME_BASE64_BYTES } from './shower-protocol.js';
import { resolveCuaDriverPath } from './cua-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXE = path.join(HERE, 'native', 'windows', 'build', 'shower-windows.exe');
// 只有受信任的进程环境可以改原生宿主二进制；模型/客户端参数永远没有这个入口。
const EXE_ENV = 'E_LAUNCHER_SHOWER_WINDOWS_EXE';

const PLATFORM = 'windows';
const MAX_SESSIONS = 1;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_DIMENSION = 160;
const MAX_DIMENSION = 4096;
// 原生宿主自己等 agent 25 s；这里更早失败，好在 20 s 的控制 RPC 之前报告“未确认”。
const REQUEST_TIMEOUT_MS = 15_000;
// 启动授权与 native bootstrap 共用有界上限，包含一次可能的 UAC 等待。
const PREPARE_TIMEOUT_MS = 300_000;
const CANCEL_TIMEOUT_MS = 5_000;
// 给同步注销留出时间；超时后由强制关闭和 guardian 完成清理。
const RELEASE_TIMEOUT_MS = 15_000;
const SHUTDOWN_GRACE_MS = 2_000;
const EXIT_WAIT_MS = SHUTDOWN_GRACE_MS + 1_000;
const MAX_REQUEST_BYTES = 1024 * 1024;
// contract：原生整行 base64 帧上限 2 MiB。
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING = 16;
// Cua 固定上游 cua-driver-rs 的 MCP 直连预算：请求与单条应答都不会撑爆既有管道上限。
const CUA_REQUEST_TIMEOUT_MS = 35_000;
const MAX_CUA_REQUEST_BYTES = 128 * 1024;
// 取消 cua 后多等一个有界窗口：原生先杀 driver 并释放按键才回包，绝不能让 manager 在清理未
// 完成时就把人工输入放进会话。
const CUA_CANCEL_SETTLE_MS = 15_000;
const MAX_STDERR_LINE = 512;
const STDERR_KEEP = 10;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const PHASES = new Set([
  'unavailable',
  'idle',
  'starting',
  'authentication-required',
  'ready',
  'closed',
  'error',
]);
const OUTCOMES = new Set(['not-sent', 'unconfirmed', 'responded']);
const NATIVE_CODES = new Set([...SHOWER_ERROR_CODES, 'INVALID_ARGUMENT', 'CANCELLED']);
const PREVIEW_MODES = new Set(['visible', 'minimized', 'offscreen', 'hidden']);
// 与原生宿主 WindowsKeys 一致：没有任何按键会被静默近似。
const WINDOWS_KEYS = Object.freeze([
  'ENTER', 'TAB', 'ESCAPE', 'SPACE', 'BACKSPACE', 'DELETE',
  'LEFT', 'UP', 'RIGHT', 'DOWN', 'HOME', 'END', 'PAGEUP', 'PAGEDOWN',
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'0123456789',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function showerError(code, message, outcome) {
  const error = messageError(code, message);
  if (outcome !== undefined) error.outcome = outcome;
  return error;
}

function invalid(message, outcome = 'not-sent') {
  return showerError('INVALID_ARGUMENT', message, outcome);
}

function cancelled(message, outcome) {
  return showerError('CANCELLED', message, outcome);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function checkAborted(signal) {
  if (signal?.aborted) throw cancelled('Shower 操作已取消，且未发送', 'not-sent');
}

function capabilities() {
  return {
    // 本机没有 Windows 应用目录：只支持直接启动程序路径。
    launchKinds: ['process'],
    inputKinds: ['click', 'drag', 'scroll', 'key', 'text'],
    keys: [...WINDOWS_KEYS],
    nativePreview: true,
  };
}

function idleView() {
  return {
    sessionId: null,
    platform: PLATFORM,
    phase: 'idle',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    capabilities: capabilities(),
    updatedAt: new Date().toISOString(),
  };
}

function unavailableView(error) {
  const view = idleView();
  view.phase = 'unavailable';
  view.error = {
    code: typeof error?.code === 'string' ? error.code : 'SHOWER_UNAVAILABLE',
    message: typeof error?.message === 'string' ? error.message : 'Windows Shower 不可用',
  };
  return view;
}

function errorView(sessionId, code, message, updatedAt = new Date().toISOString()) {
  return {
    sessionId,
    platform: PLATFORM,
    phase: 'error',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    capabilities: capabilities(),
    updatedAt,
    error: { code, message },
  };
}

function optionalRecordSessionId(record) {
  return typeof record?.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null;
}

function requireRecordSessionId(record) {
  const sessionId = optionalRecordSessionId(record);
  if (sessionId === null) throw invalid('Shower record 必须携带 manager 分配的 sessionId');
  return sessionId;
}

/** 原生错误只保留稳定 code；文案有界，未知 code 归入 SHOWER_BACKEND_FAILED。 */
function wireError(raw) {
  const code = isPlainObject(raw) && typeof raw.code === 'string' && NATIVE_CODES.has(raw.code)
    ? raw.code
    : 'SHOWER_BACKEND_FAILED';
  const outcome = isPlainObject(raw) && OUTCOMES.has(raw.outcome) ? raw.outcome : 'responded';
  const text = isPlainObject(raw) && typeof raw.message === 'string' ? raw.message : '';
  const message = text.isWellFormed() && text.trim() !== ''
    ? text.slice(0, MAX_STDERR_LINE)
    : `Windows Shower 原生宿主返回 ${code}`;
  return showerError(code, message, outcome);
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 固定 exe 路径；仅受信任环境可覆盖为绝对路径，且不接受任何客户端/模型来源。 */
function resolveExePath() {
  const override = process.env[EXE_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    if (!path.isAbsolute(override)) {
      throw showerError('SHOWER_UNAVAILABLE', `${EXE_ENV} 必须是绝对路径: ${override}`, 'not-sent');
    }
    const resolved = path.normalize(override);
    if (!isFile(resolved)) {
      throw showerError('SHOWER_UNAVAILABLE', `${EXE_ENV} 指向的文件不存在: ${resolved}`, 'not-sent');
    }
    return resolved;
  }
  if (!isFile(DEFAULT_EXE)) {
    throw showerError(
      'SHOWER_UNAVAILABLE',
      `缺少 Windows Shower 原生宿主 ${DEFAULT_EXE}；请先构建 host-core/native/windows`
        + `（.NET Framework 4.8 x64，MSTSCLib 互操作在构建时生成），`
        + `或把 ${EXE_ENV} 设为已构建 exe 的绝对路径`,
      'not-sent',
    );
  }
  return DEFAULT_EXE;
}

function createParam(createOptions) {
  if (createOptions === undefined || createOptions === null) return {};
  if (!isPlainObject(createOptions)) throw invalid('Shower create options 必须是对象');
  const options = {};
  for (const name of ['width', 'height']) {
    const value = createOptions[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < MIN_DIMENSION || value > MAX_DIMENSION) {
      throw invalid(`create ${name} 必须是 ${MIN_DIMENSION}..${MAX_DIMENSION} 的整数`);
    }
    options[name] = value;
  }
  return options;
}

function limitsParam(limits) {
  if (limits === undefined || limits === null) return {};
  if (!isPlainObject(limits)) throw invalid('Shower frame limits 必须是对象');
  const requested = {};
  for (const name of ['maxWidth', 'maxHeight', 'maxBytes']) {
    const value = limits[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw invalid(`frame limits ${name} 必须是正整数`);
    requested[name] = value;
  }
  if (requested.maxBytes !== undefined) {
    // 全局绝对上限；原生也永远不会超出自己的编码上限。
    requested.maxBytes = Math.min(requested.maxBytes, SHOWER_MAX_FRAME_BASE64_BYTES);
  }
  return requested;
}

/** 对外只允许 tools/list 与 tools/call；其余 MCP 方法一律拒绝，request 原样透传不进 JSON-RPC 信封。 */
function cuaRequestParam(request) {
  if (!isPlainObject(request)) throw invalid('Cua request 必须是对象');
  for (const key of Object.keys(request)) {
    if (key !== 'method' && key !== 'params') throw invalid('Cua request 不允许字段 ' + key);
  }
  const method = request.method;
  if (method !== 'tools/list' && method !== 'tools/call') {
    throw invalid('Cua request.method 必须是 tools/list 或 tools/call');
  }
  if (request.params !== undefined && !isPlainObject(request.params)) throw invalid('Cua request.params 必须是对象');
  if (method === 'tools/call') {
    const params = request.params;
    if (!params || typeof params.name !== 'string' || params.name === '') {
      throw invalid('tools/call 的 params.name 必须是非空字符串');
    }
    if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
      throw invalid('tools/call 的 params.arguments 必须是对象');
    }
  }
  const wire = { method };
  // params 原样透传（含 tools/list 的 cursor/_meta 等分页字段），外层键已限定 method/params。
  if (request.params !== undefined) wire.params = request.params;
  const line = JSON.stringify(wire);
  if (Buffer.byteLength(line, 'utf8') > MAX_CUA_REQUEST_BYTES) {
    throw invalid('Cua request 超过 ' + MAX_CUA_REQUEST_BYTES + ' 字节上限');
  }
  return wire;
}

/** source/taskId/callId 只从可信 options 转发，模型参数无法设置。 */
function trustedFields(source, taskId, callId) {
  const fields = {};
  if (source === 'agent' || source === 'human') fields.source = source;
  if (typeof taskId === 'string' && taskId !== '') fields.taskId = taskId;
  if (typeof callId === 'string' && callId !== '') fields.callId = callId;
  return fields;
}

function viewFromSnapshot(raw, expectedSessionId) {
  if (!isPlainObject(raw)) throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 原生宿主返回了无效会话', 'responded');
  if (raw.sessionId !== null && raw.sessionId !== undefined && raw.sessionId !== expectedSessionId) {
    throw showerError('SHOWER_SESSION_MISMATCH', 'Windows Shower 原生宿主报告了其他会话', 'responded');
  }
  if (typeof raw.phase !== 'string' || !PHASES.has(raw.phase)) {
    throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 原生宿主报告了未知阶段', 'responded');
  }
  if (!Number.isSafeInteger(raw.width) || raw.width < 0
      || !Number.isSafeInteger(raw.height) || raw.height < 0) {
    throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 原生宿主报告了无效分辨率', 'responded');
  }
  const view = {
    sessionId: raw.sessionId ?? null,
    platform: PLATFORM,
    phase: raw.phase,
    width: raw.width,
    height: raw.height,
    capabilities: isPlainObject(raw.capabilities) ? raw.capabilities : capabilities(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
  if (isPlainObject(raw.error)) {
    view.error = {
      code: typeof raw.error.code === 'string' ? raw.error.code : 'SHOWER_BACKEND_FAILED',
      message: typeof raw.error.message === 'string' ? raw.error.message : '',
    };
  }
  return view;
}

function frameFromNative(raw, sessionId, limits) {
  if (!isPlainObject(raw)) throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 原生宿主返回了无效帧', 'responded');
  if (raw.sessionId !== sessionId) {
    throw showerError('SHOWER_SESSION_MISMATCH', 'Windows Shower 帧不属于当前会话', 'responded');
  }
  for (const name of ['width', 'height', 'imageWidth', 'imageHeight']) {
    if (!Number.isSafeInteger(raw[name]) || raw[name] < 1) {
      throw showerError('SHOWER_BACKEND_FAILED', `Windows Shower 帧的 ${name} 无效`, 'responded');
    }
  }
  if (raw.mimeType !== 'image/jpeg' && raw.mimeType !== 'image/png') {
    throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 帧的 mimeType 无效', 'responded');
  }
  if (typeof raw.capturedAt !== 'string' || raw.capturedAt === '') {
    throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 帧缺少 capturedAt', 'responded');
  }
  if (typeof raw.frameId !== 'string' || raw.frameId === '') {
    throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 帧缺少 frameId', 'responded');
  }
  const data = raw.data;
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 帧的图像数据无效', 'responded');
  }
  const maxBytes = Math.min(limits.maxBytes ?? SHOWER_MAX_FRAME_BASE64_BYTES, SHOWER_MAX_FRAME_BASE64_BYTES);
  if (data.length > maxBytes) {
    throw showerError('SHOWER_FRAME_TOO_LARGE', `帧需要 ${data.length} base64 字节，上限是 ${maxBytes}`, 'responded');
  }
  if ((limits.maxWidth !== undefined && raw.imageWidth > limits.maxWidth)
      || (limits.maxHeight !== undefined && raw.imageHeight > limits.maxHeight)) {
    throw showerError(
      'SHOWER_FRAME_TOO_LARGE',
      `帧 ${raw.imageWidth}×${raw.imageHeight} 超出 ${limits.maxWidth ?? '默认'}×${limits.maxHeight ?? '默认'} 上限`,
      'responded',
    );
  }
  return {
    sessionId,
    frameId: raw.frameId,
    capturedAt: raw.capturedAt,
    width: raw.width,
    height: raw.height,
    imageWidth: raw.imageWidth,
    imageHeight: raw.imageHeight,
    mimeType: raw.mimeType,
    data,
  };
}

/**
 * 固定本机原生宿主的 JSONL 客户端：一行一个请求/应答，1 请求 1 id，
 * stdout 严格分行且行长有界，stderr 只保留有界诊断。超时/取消会向原生转发
 * cancel 以停止在途操作，但绝不重发原请求。
 */
function openNativeHost(child) {
  const pending = new Map();
  const diagnostics = [];
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let exitError = null;
  let closed = false;
  let closing = null;

  const started = new Promise((resolve, reject) => {
    const cleanup = () => {
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onStartError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onStartError = (error) => {
      cleanup();
      exitError = showerError('SHOWER_UNAVAILABLE', `无法启动 Windows Shower 原生宿主: ${error.message}`, 'not-sent');
      reject(exitError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onStartError);
  });
  started.catch(() => {});

  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });

  function finish(entry, error, result) {
    if (entry.settled) return;
    entry.settled = true;
    pending.delete(entry.id);
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    if (error) entry.reject(error);
    else entry.resolve(result);
  }

  function failPending(code, message) {
    for (const entry of [...pending.values()]) {
      finish(entry, showerError(code, message, entry.written ? 'unconfirmed' : 'not-sent'));
    }
  }

  function diagnosticSuffix() {
    const line = diagnostics.length > 0 ? diagnostics[diagnostics.length - 1] : '';
    return line === '' ? '' : `（原生诊断：${line}）`;
  }

  function fatal(message) {
    if (exitError) return;
    exitError = showerError('SHOWER_UNAVAILABLE', message + diagnosticSuffix());
    failPending(exitError.code, exitError.message);
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }

  function handleLine(line) {
    const text = line.trim();
    if (text === '') return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      fatal('Windows Shower 原生宿主输出了非法 JSON');
      return;
    }
    if (!isPlainObject(message)) {
      fatal('Windows Shower 原生宿主输出了非对象帧');
      return;
    }
    // 非请求对应的 status 事件允许出现，但永不满足排队的请求。
    if (message.event !== undefined) return;
    if (typeof message.id !== 'string') return;
    const entry = pending.get(message.id);
    // 超时/取消后的迟到应答直接丢弃：绝不把它当成重放的机会。
    if (!entry) return;
    // 已取消请求在 settle 窗口内收到的应答只能证明收尾结果：成功应答必须仍按取消报告
    // unconfirmed，绝不向调用方冒充一次成功的控制。
    if (entry.aborting && message.ok === true) {
      finish(entry, cancelled('Shower 操作已取消；迟到应答不代表成功，不会自动重发', 'unconfirmed'));
      return;
    }
    if (message.ok === true) finish(entry, null, message.result);
    else finish(entry, wireError(message.error));
  }

  function onStdout(chunk) {
    stdoutBuffer += chunk;
    for (let index = stdoutBuffer.indexOf('\n'); index !== -1; index = stdoutBuffer.indexOf('\n')) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      handleLine(line);
      if (exitError) return;
    }
    if (stdoutBuffer.length > MAX_LINE_BYTES) fatal('Windows Shower 原生宿主的输出行超出帧预算');
  }

  function pushDiagnostic(line) {
    const text = line.replace(/\s+/g, ' ').trim().slice(0, MAX_STDERR_LINE);
    if (text === '') return;
    diagnostics.push(text);
    if (diagnostics.length > STDERR_KEEP) diagnostics.shift();
  }

  function onStderr(chunk) {
    stderrBuffer += chunk;
    for (;;) {
      const index = stderrBuffer.indexOf('\n');
      if (index === -1) break;
      pushDiagnostic(stderrBuffer.slice(0, index));
      stderrBuffer = stderrBuffer.slice(index + 1);
    }
    if (stderrBuffer.length > MAX_STDERR_LINE) {
      pushDiagnostic(stderrBuffer);
      stderrBuffer = '';
    }
  }

  function requestCancel(targetId) {
    request('cancel', { requestId: targetId }, { timeoutMs: CANCEL_TIMEOUT_MS }).catch(() => {});
  }

  function request(method, params, options = {}) {
    const { signal, timeoutMs = REQUEST_TIMEOUT_MS, cancelSettleMs = 0 } = options;
    if (exitError) return Promise.reject(showerError(exitError.code, exitError.message, 'not-sent'));
    if (closed) return Promise.reject(showerError('SHOWER_UNAVAILABLE', 'Windows Shower 原生宿主已关闭', 'not-sent'));
    checkAborted(signal);
    if (pending.size >= MAX_PENDING) {
      return Promise.reject(showerError('SHOWER_BUSY', '同一时刻的 Shower 原生请求过多', 'not-sent'));
    }
    const id = randomUUID();
    let line;
    try {
      line = `${JSON.stringify({ id, method, params })}\n`;
    } catch {
      return Promise.reject(invalid('Shower 原生请求无法序列化'));
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_REQUEST_BYTES) {
      return Promise.reject(invalid('Shower 原生请求超过 1 MiB'));
    }
    return new Promise((resolve, reject) => {
      const entry = {
        id,
        method,
        signal,
        onAbort: null,
        timer: null,
        written: false,
        settled: false,
        cancelSettleMs,
        aborting: false,
        resolve,
        reject,
      };
      pending.set(id, entry);
      entry.timer = setTimeout(() => {
        const current = pending.get(id);
        if (!current) return;
        if (current.method !== 'cancel') requestCancel(id);
        // cancel-settle：先请求原生收尾，窗口内继续等真应答；原生清理完成后自己回包。
        // 窗口到期仍无应答意味着清理未确认，会话标记为破坏，后续控制一律拒绝。
        if (current.cancelSettleMs > 0 && !current.aborting) {
          const settle = Math.min(current.cancelSettleMs, CUA_CANCEL_SETTLE_MS);
          current.cancelSettleMs = 0;
          current.aborting = true;
          entry.timer = setTimeout(() => {
            const again = pending.get(id);
            if (!again) return;
            fatal('Windows Shower 原生宿主在取消收尾窗口内没有应答，会话控制状态未确认');
          }, settle);
          entry.timer.unref?.();
          return;
        }
        finish(current, showerError(
          'SHOWER_BACKEND_FAILED',
          `Windows Shower 原生宿主在 ${timeoutMs} ms 内没有应答，结果未确认`,
          'unconfirmed',
        ));
      }, timeoutMs);
      entry.timer.unref?.();
      if (signal) {
        entry.onAbort = () => {
          const current = pending.get(id);
          if (!current) return;
          const outcome = current.written ? 'unconfirmed' : 'not-sent';
          // cancel-settle：取消先发往原生，但在原生确认收尾（杀 driver + 释放按键后回包）或窗口
          // 到期前保持挂起；人工接管绝不能抢在 driver 清理之前被放行。
          if (outcome === 'unconfirmed' && current.cancelSettleMs > 0 && !current.aborting) {
            current.aborting = true;
            if (current.method !== 'cancel') requestCancel(id);
            const settle = Math.min(current.cancelSettleMs, CUA_CANCEL_SETTLE_MS);
            if (current.timer) clearTimeout(current.timer);
            current.timer = setTimeout(() => {
              const again = pending.get(id);
              if (!again) return;
              fatal('Windows Shower 原生宿主在取消收尾窗口内没有应答，会话控制状态未确认');
            }, settle);
            current.timer.unref?.();
            return;
          }
          finish(current, cancelled(
            outcome === 'unconfirmed' ? 'Shower 操作已取消；结果未确认，不会自动重发' : 'Shower 操作已取消，且未发送',
            outcome,
          ));
          if (outcome === 'unconfirmed' && current.method !== 'cancel') requestCancel(id);
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      entry.written = true;
      try {
        child.stdin.write(line, 'utf8', (error) => {
          if (!error) return;
          const current = pending.get(id);
          if (!current) return;
          finish(current, showerError('SHOWER_UNAVAILABLE', `写入 Windows Shower 原生宿主失败: ${error.message}`, 'unconfirmed'));
        });
      } catch (error) {
        finish(entry, showerError('SHOWER_UNAVAILABLE', `写入 Windows Shower 原生宿主失败: ${error.message}`, 'not-sent'));
      }
    });
  }

  // 只结束本后端自己 spawn 的进程：先 EOF 让它自清理，grace 后仍存活才强杀。
  function close() {
    if (closing) return closing;
    closed = true;
    failPending('SHOWER_UNAVAILABLE', 'Windows Shower 原生宿主已关闭');
    // EOF 让原生宿主释放它拥有的会话并自行退出；超时后强制结束。
    try {
      child.stdin.end();
    } catch {
      /* 已退出 */
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, SHUTDOWN_GRACE_MS);
    timer.unref?.();
    // 有界退出等待：即使强杀也失败，关闭路径也不会永久挂住调用方。
    closing = Promise.race([exited, delay(EXIT_WAIT_MS)]).catch(() => {});
    return closing;
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', onStderr);
  child.once('error', (error) => fatal(`Windows Shower 原生宿主进程错误: ${error.message}`));
  child.once('exit', (code, signal) => {
    fatal(`Windows Shower 原生宿主已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`);
  });
  // 退出后的 EPIPE 由 exit 处理统一报告，写入回调不重复抛出。
  child.stdin.on('error', () => {});

  return {
    started,
    request,
    close,
    get exitError() {
      return exitError;
    },
    get closed() {
      return closed;
    },
  };
}

export function createWindowsShowerBackend({ dataRoot } = {}) {
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '') {
    throw invalid('createWindowsShowerBackend: dataRoot 必须是非空路径');
  }
  const stateDir = path.join(path.resolve(dataRoot), 'shower-windows');

  let host = null;
  let starting = null;
  // 仅本次启动 prepare 成功的宿主拥有子会话授权；重启/换进程后必须重新 prepare。
  let authorizedHost = null;
  let preparing = null;
  let activeSessionId = null;
  // 首次 cua 调用才解析 driver；之后该路径对本后端固定，任何调用方都不能替换。
  let cuaDriverPath = null;
  // 原生宿主意外退出后保留失败快照，status 报告 error 而不是假装空闲。
  let hostFailure = null;
  let closed = false;
  // 正在有界关闭的宿主：下一次 spawn 前等它真正退出，避免两个原生进程抢同一状态目录/文件锁。
  let retiring = null;
  // 已经强制收尾的会话：宿主已退出/关闭后重复 release 要幂等完成，而不是永远卡住归属。
  let teardownSessionId = null;

  function markHostFailure(dead) {
    if (host === dead) host = null;
    if (activeSessionId === null) return;
    const error = dead.exitError;
    hostFailure = {
      sessionId: activeSessionId,
      code: typeof error?.code === 'string' ? error.code : 'SHOWER_UNAVAILABLE',
      message: typeof error?.message === 'string' ? error.message : 'Windows Shower 原生宿主已退出',
      updatedAt: new Date().toISOString(),
    };
  }

  function failureView(failure) {
    return errorView(failure.sessionId, failure.code, failure.message, failure.updatedAt);
  }

  /** 只关闭本后端 spawn 的宿主（stdin EOF + 有界强杀），并返回有界完成 Promise。 */
  function shutdownHost() {
    const current = host;
    host = null;
    authorizedHost = null;
    if (!current) return Promise.resolve();
    let done;
    try {
      done = current.close();
    } catch {
      done = Promise.resolve();
    }
    const tracked = Promise.resolve(done)
      .catch(() => {})
      .finally(() => {
        if (retiring === tracked) retiring = null;
      });
    retiring = tracked;
    return tracked;
  }

  async function startHost() {
    const exePath = resolveExePath();
    try {
      mkdirSync(stateDir, { recursive: true });
    } catch (error) {
      throw showerError('SHOWER_UNAVAILABLE', `无法创建 Windows Shower 状态目录 ${stateDir}: ${error.message}`, 'not-sent');
    }
    let child;
    try {
      child = spawn(exePath, ['host', '--state-dir', stateDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      throw showerError('SHOWER_UNAVAILABLE', `无法启动 Windows Shower 原生宿主: ${error.message}`, 'not-sent');
    }
    const created = openNativeHost(child);
    try {
      await created.started;
    } catch (error) {
      created.close();
      throw error;
    }
    return created;
  }

  /** 原生进程按需启动：status/preview/release 都不会创建它。 */
  async function acquireHost(signal) {
    if (closed) throw showerError('SHOWER_UNAVAILABLE', 'Shower Windows 后端已关闭', 'not-sent');
    if (host && !host.closed && !host.exitError) return host;
    if (host) markHostFailure(host);
    // 上一个宿主可能还在有界关闭：先等它退出，避免第二个进程继续持有 MSTSCLib.dll 等文件锁。
    if (retiring) await retiring;
    if (host && !host.closed && !host.exitError) return host;
    if (starting) return starting;
    checkAborted(signal);
    const promise = startHost()
      .then((created) => {
        host = created;
        return created;
      })
      .finally(() => {
        starting = null;
      });
    starting = promise;
    return promise;
  }

  /** 启动准备：开启并保留原生宿主，在本机完成一次管理员授权；不创建桌面。 */
  function prepareHost({ signal } = {}) {
    if (authorizedHost !== null && authorizedHost === host && !host.closed && !host.exitError) {
      return Promise.resolve();
    }
    if (preparing) return preparing;
    const run = (async () => {
      checkAborted(signal);
      const client = await acquireHost(signal);
      checkAborted(signal);
      try {
        await client.request('prepare', {}, { signal, timeoutMs: PREPARE_TIMEOUT_MS });
      } catch (error) {
        // 取消/超时/失败都不保留半个授权状态；授权丢失后只有重启 Host 才能重新准备。
        await shutdownHost();
        throw error;
      }
      authorizedHost = client;
    })();
    const tracked = run.then(
      (value) => {
        if (preparing === tracked) preparing = null;
        return value;
      },
      (error) => {
        if (preparing === tracked) preparing = null;
        throw error;
      },
    );
    preparing = tracked;
    return tracked;
  }

  /** ensure 只能使用本次启动已 prepare 的宿主；授权丢失明确要求重启 Host。 */
  function authorizedClient() {
    if (closed) throw showerError('SHOWER_UNAVAILABLE', 'Shower Windows 后端已关闭', 'not-sent');
    if (host && host.exitError) markHostFailure(host);
    if (authorizedHost === null || authorizedHost !== host || host.closed || host.exitError) {
      authorizedHost = null;
      throw showerError(
        'SHOWER_UNAVAILABLE',
        'Windows Shower 尚未完成启动管理员授权或已失效；请重启 Host 后重试',
        'not-sent',
      );
    }
    return authorizedHost;
  }

  /** 已就绪的会话才接受 frame/input/launch/preview；绝不为它们隐式创建环境。 */
  function requireHost(sessionId) {
    if (closed) throw showerError('SHOWER_UNAVAILABLE', 'Shower Windows 后端已关闭', 'not-sent');
    if (host && host.exitError) markHostFailure(host);
    if (!host) {
      if (hostFailure && hostFailure.sessionId === sessionId) {
        throw showerError(hostFailure.code, hostFailure.message, 'not-sent');
      }
      throw showerError('SHOWER_SESSION_NOT_FOUND', `Windows Shower 会话不存在: ${sessionId}`, 'not-sent');
    }
    if (activeSessionId !== sessionId) {
      throw showerError('SHOWER_SESSION_NOT_FOUND', `Windows Shower 会话不在本机宿主中: ${sessionId}`, 'not-sent');
    }
    return host;
  }

  async function status(record, { signal } = {}) {
    if (closed) throw showerError('SHOWER_UNAVAILABLE', 'Shower Windows 后端已关闭', 'not-sent');
    checkAborted(signal);
    const sessionId = optionalRecordSessionId(record);
    if (sessionId === null) {
      try {
        resolveExePath();
      } catch (error) {
        return unavailableView(error);
      }
      return idleView();
    }
    if (host && host.exitError) markHostFailure(host);
    if (!host) {
      if (hostFailure && hostFailure.sessionId === sessionId) return failureView(hostFailure);
      try {
        resolveExePath();
      } catch (error) {
        return unavailableView(error);
      }
      return idleView();
    }
    // 本机宿主拥有别的会话：该 sessionId 没有环境，状态保持无副作用。
    if (activeSessionId !== sessionId) return idleView();
    try {
      const snapshot = await host.request('status', { sessionId }, { signal });
      return viewFromSnapshot(snapshot, sessionId);
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      if (error?.code === 'SHOWER_SESSION_MISMATCH' || error?.code === 'SHOWER_SESSION_NOT_FOUND') return idleView();
      if (host?.exitError) {
        markHostFailure(host);
        if (hostFailure) return failureView(hostFailure);
      }
      return errorView(
        sessionId,
        typeof error?.code === 'string' ? error.code : 'SHOWER_BACKEND_FAILED',
        typeof error?.message === 'string' ? error.message : 'Windows Shower 会话状态不可用',
      );
    }
  }

  async function ensure(record, createOptions = {}, { signal } = {}) {
    checkAborted(signal);
    if (closed) throw showerError('SHOWER_UNAVAILABLE', 'Shower Windows 后端已关闭', 'not-sent');
    const sessionId = requireRecordSessionId(record);
    const options = createParam(createOptions);
    const client = authorizedClient();
    checkAborted(signal);
    let snapshot;
    try {
      // 启动/RDP 登录都在原生后台线程里，这里立刻拿到 starting/authentication-required。
      snapshot = await client.request('ensure', { sessionId, options }, { signal });
    } catch (error) {
      if (client.exitError) markHostFailure(client);
      throw error;
    }
    if (!isPlainObject(snapshot) || snapshot.sessionId !== sessionId) {
      throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 原生宿主没有回显 manager 分配的会话 ID', 'responded');
    }
    activeSessionId = sessionId;
    hostFailure = null;
    teardownSessionId = null;
    return viewFromSnapshot(snapshot, sessionId);
  }

  async function frame(record, limits = {}, { signal } = {}) {
    checkAborted(signal);
    const sessionId = requireRecordSessionId(record);
    const requested = limitsParam(limits);
    const client = requireHost(sessionId);
    checkAborted(signal);
    const raw = await client.request('frame', { sessionId, limits: requested }, { signal });
    return frameFromNative(raw, sessionId, requested);
  }

  async function input(record, value, { signal, source, taskId, callId } = {}) {
    checkAborted(signal);
    const sessionId = requireRecordSessionId(record);
    if (!isPlainObject(value) || typeof value.type !== 'string') throw invalid('Shower input 必须是带 type 的对象');
    const client = requireHost(sessionId);
    checkAborted(signal);
    const params = { sessionId, input: value, ...trustedFields(source, taskId, callId) };
    // 只发送一次；取消/超时后由 signal 报告 unconfirmed，绝不重放。
    await client.request('input', params, { signal });
    return { sessionId, type: value.type, source: source ?? 'agent', callId: callId ?? null };
  }

  async function launch(record, value, { signal, source, taskId, callId } = {}) {
    checkAborted(signal);
    const sessionId = requireRecordSessionId(record);
    if (!isPlainObject(value)) throw invalid('Shower launch 必须是对象');
    const client = requireHost(sessionId);
    checkAborted(signal);
    const raw = await client.request('launch', { sessionId, launch: value, ...trustedFields(source, taskId, callId) }, { signal });
    return {
      sessionId,
      kind: typeof value.kind === 'string' ? value.kind : null,
      program: isPlainObject(raw) && typeof raw.program === 'string' ? raw.program : (value.program ?? null),
      pid: isPlainObject(raw) && Number.isSafeInteger(raw.pid) ? raw.pid : null,
      source: source ?? 'agent',
      callId: callId ?? null,
    };
  }

  /** 固定 driver 绝对路径：只在首个 cua 调用解析，缺失即 SHOWER_UNAVAILABLE，绝不退到主桌面。 */
  function pinnedCuaDriver() {
    if (cuaDriverPath !== null) return cuaDriverPath;
    cuaDriverPath = resolveCuaDriverPath();
    return cuaDriverPath;
  }

  /** 返回原样 MCP result 对象（原生已解开 { result } 包装），不套 JSON-RPC 信封。 */
  async function cua(record, request, { signal, source, taskId, callId } = {}) {
    checkAborted(signal);
    const sessionId = requireRecordSessionId(record);
    const wire = cuaRequestParam(request);
    const driverPath = pinnedCuaDriver();
    const client = requireHost(sessionId);
    checkAborted(signal);
    const params = { sessionId, driverPath, request: wire, ...trustedFields(source, taskId, callId) };
    // cancelSettle：信号取消后等原生确认 driver 已杀、按键已释放，人工接管才不会遇上还活着的旧 driver。
    const raw = await client.request('cua', params, { signal, timeoutMs: CUA_REQUEST_TIMEOUT_MS, cancelSettleMs: CUA_CANCEL_SETTLE_MS });
    if (!isPlainObject(raw)) {
      throw showerError('SHOWER_BACKEND_FAILED', 'Windows Shower 原生宿主返回了无效 Cua 结果', 'unconfirmed');
    }
    return raw;
  }

  /** 原生预览窗口只影响子会话窗口本身；隐藏不会断开连接或销毁桌面。 */
  async function preview(record, mode, { signal } = {}) {
    checkAborted(signal);
    const sessionId = requireRecordSessionId(record);
    if (typeof mode !== 'string' || !PREVIEW_MODES.has(mode)) {
      throw invalid('Shower preview mode 必须是 visible、minimized、offscreen 或 hidden');
    }
    const client = requireHost(sessionId);
    checkAborted(signal);
    const raw = await client.request('preview', { sessionId, mode }, { signal });
    return {
      sessionId,
      preview: isPlainObject(raw) && typeof raw.preview === 'string' ? raw.preview : mode,
    };
  }

  async function release(record, { signal } = {}) {
    // 显式释放忽略调用方 abort：被取消的请求也不能留下本后端拥有的子会话。
    void signal;
    if (closed) throw showerError('SHOWER_UNAVAILABLE', 'Shower Windows 后端已关闭', 'not-sent');
    const sessionId = optionalRecordSessionId(record);
    if (sessionId === null) return { sessionId: null, released: false, phase: 'idle' };
    if (host && host.exitError) markHostFailure(host);
    if (!host) {
      // 宿主已退出/已关闭：同一归属重复 release 必须幂等收尾，而不是永远卡住 manager 归属。
      if (activeSessionId === sessionId || teardownSessionId === sessionId) {
        if (activeSessionId === sessionId) activeSessionId = null;
        hostFailure = null;
        teardownSessionId = sessionId;
        // 没有任何原生应答：只声明本后端已结束该环境，不伪装成原生确认。
        return { sessionId, released: true, phase: 'closed', forced: true, nativeRelease: 'unconfirmed' };
      }
      return { sessionId, released: false, phase: 'closed' };
    }
    if (activeSessionId === null) {
      // 宿主没有拥有会话（ensure 未成功）：无需原生 release，直接收尾让出文件锁。
      await shutdownHost();
      hostFailure = null;
      teardownSessionId = sessionId;
      return { sessionId, released: false, phase: 'closed' };
    }
    if (activeSessionId !== sessionId) {
      // 宿主拥有其他会话：过期的 record 不能关掉别人的桌面。
      if (teardownSessionId === sessionId) {
        return { sessionId, released: true, phase: 'closed', forced: true, nativeRelease: 'unconfirmed' };
      }
      return { sessionId, released: false, phase: 'closed' };
    }
    let raw = null;
    let failure = null;
    try {
      raw = await host.request('release', { sessionId }, { timeoutMs: RELEASE_TIMEOUT_MS });
    } catch (error) {
      failure = error;
    } finally {
      // 成功释放屏幕后复用已授权的宿主；异常或 Host 退出时才终止进程并恢复系统原值。
      if (failure) await shutdownHost();
      if (activeSessionId === sessionId) activeSessionId = null;
      hostFailure = null;
      teardownSessionId = sessionId;
    }
    if (failure) throw failure;
    return {
      sessionId,
      released: isPlainObject(raw) ? raw.released !== false : true,
      phase: isPlainObject(raw) && typeof raw.phase === 'string' ? raw.phase : 'closed',
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      // 单个关闭步骤失败/超时不能跳过后面的清理。
      if (retiring) await retiring.catch(() => {});
      await shutdownHost();
    } finally {
      hostFailure = null;
      activeSessionId = null;
      teardownSessionId = null;
      authorizedHost = null;
    }
  }

  return {
    platform: PLATFORM,
    maxSessions: MAX_SESSIONS,
    status,
    ensure,
    frame,
    input,
    launch,
    preview,
    release,
    cua,
    close,
    prepare: prepareHost,
  };
}
