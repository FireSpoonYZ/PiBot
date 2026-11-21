// gbot-ui lane：会话置顶本地状态与排序持久化 hook。
// 存储分区按 storageScope 隔离（自动剥离连接 generation，避免重连/刷新造成重置或重排）。
// 仅在显式置顶/取消置顶/拖拽或键盘重排/移除时写入 localStorage，换分区绝不将旧分区值写入新分区。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useText } from '../ui';
import { normalizePartitionKey } from './scopeCache';

const STORAGE_KEY_PREFIX = 'gbot-chat-pins:v1:';

export interface UseChatPinsResult {
  pinnedKeys: string[];
  isPinned: (key: string) => boolean;
  togglePin: (key: string) => void;
  reorderPins: (keys: string[]) => void;
  removePin: (key: string) => void;
  error: string | null;
}

export function botPinKey(deviceId: string, botId: string): string {
  return `bot:${deviceId}:${botId}`;
}

export function roomPinKey(scopeId: string): string {
  return `room:${scopeId}`;
}

/**
 * 规范化存储分区键：剥离可能混入的连接 generation 段，保证重连或刷新不会产生新分区。
 */
export function normalizePinStorageScope(storageScope: string): string {
  return normalizePartitionKey(storageScope);
}

function storageKeyForScope(scope: string): string {
  return `${STORAGE_KEY_PREFIX}${scope}`;
}

function normalizePinKey(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function normalizePinKeys(input: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const key = normalizePinKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 仅重排已存在于 currentPins 中的置顶项，保留因搜索/设备筛选而不可见的置顶项原位，
 * 避免过滤视图下重排导致不可见置顶项丢失或顺序抖动。
 */
export function reorderExistingPins(
  currentPins: readonly string[],
  incomingOrder: readonly string[],
): string[] {
  const currentSet = new Set(currentPins);
  const seen = new Set<string>();
  const subset: string[] = [];
  for (const rawKey of incomingOrder) {
    const key = normalizePinKey(rawKey);
    if (!key || !currentSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    subset.push(key);
  }
  if (subset.length <= 1) {
    return [...currentPins];
  }
  let subsetIndex = 0;
  return currentPins.map((key) => (seen.has(key) ? subset[subsetIndex++]! : key));
}

type PinTextFn = (zh: string, en: string) => string;

function defaultPinText(zh: string, en: string): string {
  const lang = typeof document !== 'undefined' && document.documentElement.lang
    ? document.documentElement.lang
    : (typeof navigator !== 'undefined' ? navigator.language : 'zh');
  return lang.toLowerCase().startsWith('zh') ? zh : en;
}

function formatStorageError(action: string, error: unknown, t: PinTextFn): string {
  const detail =
    error instanceof Error && error.message ? error.message : String(error ?? 'unknown error');
  return `${action}${t('：', ': ')}${detail}`;
}

// 内存态按分区缓存：当 localStorage 不可用或写入配额失败时，当前会话内仍可继续置顶与排序交互。
const memoryByScope = new Map<string, string[]>();
const dirtyMemoryScopes = new Set<string>();
const errorByScope = new Map<string, string>();

interface ScopedPinState {
  scope: string;
  keys: string[];
  error: string | null;
}

function readScopePins(scope: string, t: PinTextFn = defaultPinText): ScopedPinState {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      const fallback = memoryByScope.get(scope) ?? [];
      const err = t('本地存储不可用 (localStorage unavailable)', 'Local storage unavailable');
      errorByScope.set(scope, err);
      return { scope, keys: [...fallback], error: err };
    }
    const raw = window.localStorage.getItem(storageKeyForScope(scope));
    if (dirtyMemoryScopes.has(scope) && memoryByScope.has(scope)) {
      return {
        scope,
        keys: [...memoryByScope.get(scope)!],
        error: errorByScope.get(scope) ?? null,
      };
    }
    if (raw === null) {
      memoryByScope.set(scope, []);
      errorByScope.delete(scope);
      return { scope, keys: [], error: null };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const fallback = memoryByScope.get(scope) ?? [];
      const err = t('读取置顶状态失败：存储数据格式无效', 'Failed to read pins: invalid stored data format');
      errorByScope.set(scope, err);
      return { scope, keys: [...fallback], error: err };
    }
    const keys = normalizePinKeys(parsed);
    memoryByScope.set(scope, keys);
    errorByScope.delete(scope);
    return { scope, keys, error: null };
  } catch (err) {
    const fallback = memoryByScope.get(scope) ?? [];
    const message = formatStorageError(t('读取置顶状态失败', 'Failed to read pins'), err, t);
    errorByScope.set(scope, message);
    return { scope, keys: [...fallback], error: message };
  }
}

function writeScopePins(scope: string, keys: readonly string[], t: PinTextFn = defaultPinText): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return t('本地存储不可用 (localStorage unavailable)', 'Local storage unavailable');
    }
    window.localStorage.setItem(storageKeyForScope(scope), JSON.stringify(keys));
    return null;
  } catch (err) {
    return formatStorageError(t('保存置顶状态失败', 'Failed to save pins'), err, t);
  }
}

export function useChatPins(storageScope: string): UseChatPinsResult {
  const t = useText();
  const tRef = useRef<PinTextFn>(t);
  tRef.current = t;
  const scope = useMemo(() => normalizePinStorageScope(storageScope), [storageScope]);
  const [state, setState] = useState<ScopedPinState>(() => readScopePins(scope, tRef.current));

  // 分区切换时当拍同步按新分区读取，不经过写 effect，杜绝把旧分区状态写进新分区。
  const activeState = useMemo<ScopedPinState>(
    () => (state.scope === scope ? state : readScopePins(scope, tRef.current)),
    [state, scope],
  );
  const activeRef = useRef<ScopedPinState>(activeState);
  activeRef.current = activeState;

  useEffect(() => {
    if (state.scope !== scope) {
      setState(readScopePins(scope, tRef.current));
    }
  }, [scope, state.scope]);

  const applyMutation = useCallback((computeNext: (currentKeys: string[]) => string[]) => {
    const current = activeRef.current;
    const targetScope = current.scope;
    const nextKeys = normalizePinKeys(computeNext(current.keys));
    if (sameKeys(current.keys, nextKeys) && current.error === null) {
      return;
    }
    memoryByScope.set(targetScope, nextKeys);
    const writeError = writeScopePins(targetScope, nextKeys, tRef.current);
    if (writeError !== null) {
      dirtyMemoryScopes.add(targetScope);
      errorByScope.set(targetScope, writeError);
    } else {
      dirtyMemoryScopes.delete(targetScope);
      errorByScope.delete(targetScope);
    }
    const nextState: ScopedPinState = {
      scope: targetScope,
      keys: nextKeys,
      error: writeError,
    };
    activeRef.current = nextState;
    setState(nextState);
  }, []);

  const pinnedSet = useMemo(() => new Set(activeState.keys), [activeState.keys]);

  const isPinned = useCallback(
    (key: string): boolean => {
      const normalized = normalizePinKey(key);
      return normalized.length > 0 && pinnedSet.has(normalized);
    },
    [pinnedSet],
  );

  const togglePin = useCallback(
    (key: string): void => {
      const normalized = normalizePinKey(key);
      if (!normalized) return;
      applyMutation((prev) =>
        prev.includes(normalized)
          ? prev.filter((item) => item !== normalized)
          : [...prev, normalized],
      );
    },
    [applyMutation],
  );

  const reorderPins = useCallback(
    (keys: string[]): void => {
      if (!Array.isArray(keys)) return;
      applyMutation((prev) => reorderExistingPins(prev, keys));
    },
    [applyMutation],
  );

  const removePin = useCallback(
    (key: string): void => {
      const normalized = normalizePinKey(key);
      if (!normalized) return;
      applyMutation((prev) =>
        prev.includes(normalized) ? prev.filter((item) => item !== normalized) : prev,
      );
    },
    [applyMutation],
  );

  return {
    pinnedKeys: activeState.keys,
    isPinned,
    togglePin,
    reorderPins,
    removePin,
    error: activeState.error,
  };
}
