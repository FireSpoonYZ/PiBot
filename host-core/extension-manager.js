// 仅供读取和规范化旧 Host 设置；运行时策略来自中心快照。
import { normalizeHindsightConfig } from './hindsight-client.js';

const EXTENSION_ID = 'hindsight';

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

/**
 * 规范 Host 扩展配置：{hindsight?:{enabled,defaultEnabled,config?}}。
 * enabled=true 时 config 必填且按 Hindsight 选项校验；disabled 时 config 可保留。
 * defaultEnabled 省略时跟随 enabled（与 legacy runtime.hindsight 语义一致）。
 */
export function normalizeRuntimeExtensions(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw invalidArgument('runtime config: extensions must be a plain object');
  rejectUnknownFields(value, new Set([EXTENSION_ID]), 'runtime config extensions');
  const normalized = {};
  if (value.hindsight !== undefined) {
    const hindsight = value.hindsight;
    if (!isPlainObject(hindsight)) throw invalidArgument('runtime config: extensions.hindsight must be a plain object');
    rejectUnknownFields(hindsight, new Set(['enabled', 'defaultEnabled', 'config']), 'runtime config extensions.hindsight');
    if (typeof hindsight.enabled !== 'boolean') {
      throw invalidArgument('runtime config: extensions.hindsight.enabled must be a boolean');
    }
    if (hindsight.defaultEnabled !== undefined && typeof hindsight.defaultEnabled !== 'boolean') {
      throw invalidArgument('runtime config: extensions.hindsight.defaultEnabled must be a boolean');
    }
    const defaultEnabled = hindsight.defaultEnabled === undefined ? hindsight.enabled : hindsight.defaultEnabled;
    const config = normalizeHindsightConfig(hindsight.config);
    if (hindsight.enabled && config === undefined) {
      throw invalidArgument('runtime config: extensions.hindsight.config is required when enabled');
    }
    normalized.hindsight = { enabled: hindsight.enabled, defaultEnabled };
    if (config !== undefined) normalized.hindsight.config = config;
  }
  return normalized;
}

/**
 * 生效的规范扩展映射：显式 extensions 优先；仅当 extensions 缺省时才把 legacy
 * runtime.hindsight 解析为 enabled:true/defaultEnabled:true/config:legacy。
 */
export function resolveRuntimeExtensions({ extensions, hindsight } = {}) {
  const canonical = normalizeRuntimeExtensions(extensions);
  if (canonical !== undefined) return canonical;
  if (hindsight === undefined) return {};
  return { hindsight: { enabled: true, defaultEnabled: true, config: normalizeHindsightConfig(hindsight) } };
}

