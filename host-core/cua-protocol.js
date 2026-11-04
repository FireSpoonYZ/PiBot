// host-core/cua-protocol.js
// Host 内置 Cua 边界协议：固定上游 cua-driver-rs 的 MCP 请求/结果形状。
// 纯边界模块：无 I/O、无 Host/Runtime/存储；cua-tools 与 shower-manager 共享它。
// Driver 进程以 ['mcp','--direct'] 启动，握手（initialize protocol 2024-11-05 /
// notifications/initialized）、stderr 与单条响应 ≤2MiB、单调用超时由两端 backend 各自实现；
// 这里只建模对外的 tools/list 与 tools/call，不包 JSON-RPC id/envelope。
// 暴露面与上游 inventory 一一对应：本模块不再持有允许名单，上游任意工具名都可达。
import { messageError } from './message-protocol.js';

const INVALID_ARGUMENT = 'INVALID_ARGUMENT';
// 模型侧单请求 arguments 上限；Driver 响应/stderr 边界由后端按 ≤2MiB 执行。
export const CUA_MAX_REQUEST_BYTES = 128 * 1024;
// 观察图片缺省注入尺寸：模型未指定时补 1024，再收敛到模型内联上限（上限 1280 只是
// 缺省注入的天花板，不限制模型显式请求；只改缺省值，不重编码像素）。
export const CUA_DEFAULT_MAX_IMAGE_DIMENSION = 1024;
export const CUA_MAX_IMAGE_DIMENSION = 1280;
// cua-tools 侧文本预算与 shower 一致（50 KiB）；图片总量走 Shower/模型内联预算。
export const CUA_MAX_TEXT_OUTPUT_BYTES = 50 * 1024;
// 含图观察结果的结构化元数据随单独文本块返回；保留 capture_id 等键供模型续读。
export const CUA_MAX_STRUCTURED_METADATA_BYTES = 64 * 1024;

const ALLOWED_METHODS = new Set(['tools/list', 'tools/call']);

// 声明截图尺寸的观察类工具：调用前必须先校验模型视觉能力并钳制 max_image_dimension。
// 其余工具由 cua-tools 在结果侧兜底拦截图片输出，不按上游工具数量裁剪集合。
const OBSERVE_TOOLS = new Set(['get_window_state', 'get_desktop_state']);

function invalid(message) {
  return messageError(INVALID_ARGUMENT, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 对外只建模 tools/list 与 tools/call：method 字符串 + params，不包 id/envelope。 */
export function normalizeCuaRequest(value) {
  if (!isPlainObject(value)) throw invalid('Cua request must be a plain object');
  for (const key of Object.keys(value)) {
    if (key !== 'method' && key !== 'params') throw invalid('Cua request has unknown field: ' + key);
  }
  if (!ALLOWED_METHODS.has(value.method)) {
    throw invalid("Cua request method must be 'tools/list' or 'tools/call'");
  }
  if (value.method === 'tools/list') {
    const params = value.params === undefined ? {} : value.params;
    if (!isPlainObject(params) || Object.keys(params).length !== 0) {
      throw invalid('tools/list params must be an empty object');
    }
    return { method: 'tools/list', params: {} };
  }
  if (!isPlainObject(value.params)) throw invalid('tools/call params must be a plain object');
  for (const key of Object.keys(value.params)) {
    if (key !== 'name' && key !== 'arguments') throw invalid('tools/call params has unknown field: ' + key);
  }
  if (typeof value.params.name !== 'string' || value.params.name === '') {
    throw invalid('tools/call params.name must be a non-empty string');
  }
  if (!isPlainObject(value.params.arguments)) throw invalid('tools/call params.arguments must be a plain object');
  return { method: 'tools/call', params: { name: value.params.name, arguments: value.params.arguments } };
}

/**
 * 模型侧 tools/call arguments 边界：纯对象，序列化后计入 128 KiB 请求上限。
 * 上游 schema 允许的字段（session、screenshot_out_file 等 Driver 内部参数）原样透传；
 * Host 不删字段、不注入自己的 sessionId——Shower 路由归属由 resolveIdentity + 会话绑定解析。
 */
export function normalizeCuaToolArguments(args, requestBytes) {
  if (!isPlainObject(args)) throw invalid('cua call arguments must be a plain object');
  if (requestBytes !== undefined && Buffer.byteLength(JSON.stringify(args), 'utf8') > requestBytes) {
    throw invalid('Cua call arguments exceed the ' + Math.round(requestBytes / 1024) + ' KiB request limit');
  }
  return args;
}

/**
 * tools/call 结果形状：content 块数组 + 可选 structuredContent/isError，原样透传给模型侧。
 * MCP 允许 structuredContent-only 的结果（content 缺省视为空）；缺省时补空数组，
 * 不拒绝合法形状，让 full mirror 中走该形状的工具可用。
 */
export function normalizeCuaResult(value) {
  if (!isPlainObject(value)) {
    throw messageError('SHOWER_BACKEND_FAILED', 'Cua driver returned an invalid tools/call result');
  }
  if (value.content !== undefined && !Array.isArray(value.content)) {
    throw messageError('SHOWER_BACKEND_FAILED', 'Cua driver returned an invalid tools/call result');
  }
  if (value.content === undefined && value.structuredContent === undefined) {
    throw messageError('SHOWER_BACKEND_FAILED', 'Cua driver returned an invalid tools/call result');
  }
  const result = { content: Array.isArray(value.content) ? value.content : [] };
  if (value.structuredContent !== undefined) result.structuredContent = value.structuredContent;
  if (value.isError === true) result.isError = true;
  return result;
}

export function isCuaObserveTool(name) {
  return OBSERVE_TOOLS.has(name);
}

/**
 * 观察参数的模型默认注入：只在模型没给 max_image_dimension 时补一个符合当前模型
 * 图片内联预算的默认尺寸（缺省 1024 与模型上限的更小值）。上游 schema 允许的显式值
 * （含 0=原尺寸与 >1280）原样透传给 Driver——Host 不替上游做参数合法性判断，也不重编码；
 * 结果过大由输出预算与 frame 边界拒绝。只改缺省，不动显式语义，Driver 仍注册同一 capture_id。
 */
export function clampCuaObserveArguments(name, args, maxAllowed = CUA_MAX_IMAGE_DIMENSION) {
  if (!OBSERVE_TOOLS.has(name)) return args;
  if (args.max_image_dimension !== undefined) return args;
  const cap = Math.max(1, Math.min(CUA_MAX_IMAGE_DIMENSION, maxAllowed));
  return { ...args, max_image_dimension: Math.min(CUA_DEFAULT_MAX_IMAGE_DIMENSION, cap) };
}
