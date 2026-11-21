// gbot-ui lane：首帧同步分区判定与群聊/scope 会话 localStorage 缓存辅助（纯函数、无 DOM/React 依赖）。
// 供 useChatPins / HostPage / useScopeConversations 与 Node 单元测试共用，消除冷启动首帧分区切换（H4）与群聊延迟插入（H3）跳动。
import type { DesktopIdentity } from '../../../desktop/web/src/scope-api';
import type { MessageMember, MessageScope, ScopeInfo } from '../../../host-core/index.js';

/** 与 CenterGate / native 桥共用的既有 active center URL localStorage 键名。 */
export const ACTIVE_CENTER_URL_STORAGE_KEY = 'active-center-url';

/** 按分区隔离的 scope 会话列表缓存键前缀（版本化，便于后续结构演进）。 */
export const SCOPE_CONVERSATIONS_CACHE_KEY_PREFIX = 'gbot-scope-conversations:v1:';

export const SCOPE_CONVERSATIONS_CACHE_VERSION = 1;

const MAX_CACHED_SCOPE_CONVERSATIONS = 200;
const MAX_CACHED_PREVIEW_CHARS = 500;

export interface ScopeCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ReadInitialCenterPartitionKeyOptions {
  /** 来自 ActiveCenter Context 的当前已就绪中心地址。 */
  activeCenterUrl?: string | null;
  /** 来自 centerConn.saved?.url 的已保存中心地址。 */
  savedCenterUrl?: string | null;
  /** 来自 centerConn.url 的当前配置中心地址。 */
  centerConnUrl?: string | null;
  /**
   * 实时 URL 均尚未就绪时是否允许同步回退读取 localStorage['active-center-url']。
   * 默认 true；若 CenterGate 已初始化且确认无中心连接，调用方可传 false 退回本机分区。
   */
  allowCachedCenterUrl?: boolean;
  /** 远端连接档案 ID（无 center URL 时的次级回退，与 Host.tsx 一致）。 */
  remoteProfileId?: string | null;
  /** 远端连接类型（'local' | 'relay'）。 */
  remoteKind?: 'local' | 'relay' | string | null;
  /** 本机设备 ID（localHost?.deviceId || localBots[0]?.deviceId）。 */
  localDeviceId?: string | null;
  /** 可选自定义存储（传 null 显式禁用存储读取；缺省自动解析 window.localStorage）。 */
  storage?: ScopeCacheStorage | null;
}

/** 持久化在 localStorage 中的单条 scope 会话记录（已剥离非可序列化 api 与瞬态 delivery）。 */
export interface CachedScopeConversation {
  key: string;
  identity: DesktopIdentity;
  scope: ScopeInfo;
  title: string;
  lastPreview: string;
  /** undefined 表示尚未读到历史，null 表示确认没有消息。 */
  lastActivityAt?: string | null;
}

/** 写入缓存时接受的输入形状（兼容完整 ScopeConversation 与精简 CachedScopeConversation）。 */
export interface ScopeConversationCacheInput {
  key?: string;
  identity: DesktopIdentity;
  scope: ScopeInfo;
  title: string;
  lastPreview: string;
  lastActivityAt?: string | null;
}

export interface ScopeConversationsCacheEntry {
  /** 是否命中本地存储中的合法缓存条目（即使 items 为空数组也表示上次已确认无群聊）。 */
  hit: boolean;
  items: CachedScopeConversation[];
  updatedAt: number | null;
}

interface StoredScopeConversationsEnvelope {
  v: number;
  updatedAt?: number;
  items: CachedScopeConversation[];
}

function resolveStorage(storage?: ScopeCacheStorage | null): ScopeCacheStorage | null {
  if (storage !== undefined) return storage;
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Restricted storage environment
  }
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      return localStorage;
    }
  } catch {
    // Restricted storage environment
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 规范化存储分区键：剥离可能混入的连接 generation 段，保证重连或刷新不会产生新分区。
 * 与 chatPins.normalizePinStorageScope 保持完全一致。
 */
export function normalizePartitionKey(partitionKey: string): string {
  const trimmed = (partitionKey ?? '').trim();
  if (!trimmed) return 'default';
  const parts = trimmed
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^(?:generation|gen)[:=]\d+$/i.test(part));

  if (
    parts.length >= 3 &&
    (parts[1] === 'local' || parts[1] === 'relay') &&
    /^\d+$/.test(parts[2]!)
  ) {
    parts.splice(2, 1);
  } else if (parts.length >= 2 && /^\d+$/.test(parts[1]!)) {
    parts.splice(1, 1);
  }

  return parts.join('|') || 'default';
}

/**
 * 规范化中心地址为分区标识段：与 Host.tsx 一致优先取 new URL(raw).origin，
 * 解析失败或 origin 为 'null' 时保留 trim 后原文。
 */
export function normalizeCenterUrlOrigin(rawUrl: string): string {
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) return '';
  try {
    const origin = new URL(trimmed).origin;
    return origin && origin !== 'null' ? origin : trimmed;
  } catch {
    return trimmed;
  }
}

/** 同步读取已缓存的 active-center-url；不可用或异常时安全返回空串。 */
export function readActiveCenterUrlCache(storage?: ScopeCacheStorage | null): string {
  const store = resolveStorage(storage);
  if (!store) return '';
  try {
    return (store.getItem(ACTIVE_CENTER_URL_STORAGE_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

/** 同步写入或清理 active-center-url 缓存；忽略存储配额与权限异常。 */
export function writeActiveCenterUrlCache(
  url: string | null | undefined,
  storage?: ScopeCacheStorage | null,
): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  const trimmed = typeof url === 'string' ? url.trim() : '';
  try {
    if (trimmed) {
      store.setItem(ACTIVE_CENTER_URL_STORAGE_KEY, trimmed);
    } else {
      store.removeItem(ACTIVE_CENTER_URL_STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 计算首帧稳定的置顶/群聊缓存分区键：
 * 1. 优先使用实时 Center URL（activeCenterUrl -> savedCenterUrl -> centerConnUrl）；
 * 2. 首帧实时值尚未加载时，同步回退读取 localStorage['active-center-url']（修 H4）；
 * 3. 无中心地址时按 remoteProfileId/remoteKind 或本机 localDeviceId 回退，与 Host.tsx L1156-1170 完全一致。
 */
export function readInitialCenterPartitionKey(
  options: ReadInitialCenterPartitionKeyOptions = {},
): string {
  const liveCenterRaw = (
    options.activeCenterUrl ||
    options.savedCenterUrl ||
    options.centerConnUrl ||
    ''
  ).trim();
  const centerRaw =
    liveCenterRaw ||
    (options.allowCachedCenterUrl !== false ? readActiveCenterUrlCache(options.storage) : '');

  if (centerRaw) {
    return `center:${normalizeCenterUrlOrigin(centerRaw)}`;
  }

  const profileId = (options.remoteProfileId ?? '').trim();
  if (profileId) {
    const kind = (options.remoteKind ?? '').trim();
    return kind ? `profile:${profileId}:${kind}` : `profile:${profileId}`;
  }

  const localDev = (options.localDeviceId ?? '').trim() || 'local';
  return `local:${localDev}`;
}

export function scopeConversationsCacheKey(partitionKey: string): string {
  return `${SCOPE_CONVERSATIONS_CACHE_KEY_PREFIX}${normalizePartitionKey(partitionKey)}`;
}

function sanitizeMembers(raw: unknown): MessageMember[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MessageMember[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const deviceId = typeof entry.deviceId === 'string' ? entry.deviceId.trim() : '';
    const botId = typeof entry.botId === 'string' ? entry.botId.trim() : '';
    if (!deviceId || !botId) continue;
    out.push({ deviceId, botId });
  }
  return out;
}

function sanitizeIdentity(raw: unknown): DesktopIdentity | null {
  if (!isRecord(raw)) return null;
  const profileId = typeof raw.profileId === 'string' ? raw.profileId.trim() : '';
  const targetDeviceId = typeof raw.targetDeviceId === 'string' ? raw.targetDeviceId.trim() : '';
  const kind = raw.kind === 'local' || raw.kind === 'relay' ? raw.kind : null;
  if (!profileId || !targetDeviceId || !kind) return null;
  const rawGen = raw.generation;
  const generation =
    typeof rawGen === 'number' && Number.isFinite(rawGen) && rawGen >= 0
      ? Math.trunc(rawGen)
      : 0;
  return { profileId, targetDeviceId, generation, kind };
}

function sanitizeScopeInfo(raw: unknown): ScopeInfo | null {
  if (!isRecord(raw) || !isRecord(raw.scope)) return null;
  const rawScope = raw.scope;
  const scopeId = typeof rawScope.scopeId === 'string' ? rawScope.scopeId.trim() : '';
  const kind = rawScope.kind === 'room' || rawScope.kind === 'dm' ? rawScope.kind : null;
  if (!scopeId || !kind) return null;
  // 已删除墓碑绝不进入或恢复出缓存。
  if (typeof rawScope.deletedAt === 'string' && rawScope.deletedAt.trim().length > 0) {
    return null;
  }
  const members = sanitizeMembers(rawScope.members);
  if (members === null) return null;

  const rawRevision = rawScope.revision;
  const revision =
    typeof rawRevision === 'number' && Number.isFinite(rawRevision) && rawRevision >= 0
      ? Math.trunc(rawRevision)
      : 0;
  const rawTitle = typeof rawScope.title === 'string' ? rawScope.title.trim() : '';

  const messageScope: MessageScope = {
    scopeId,
    kind,
    revision,
    members,
    ...(rawTitle ? { title: rawTitle } : {}),
  };

  const authorityDeviceId =
    typeof raw.authorityDeviceId === 'string' && raw.authorityDeviceId.trim().length > 0
      ? raw.authorityDeviceId.trim()
      : null;

  return {
    scope: messageScope,
    authorityDeviceId,
    isAuthority: Boolean(raw.isAuthority),
    // delivery 为瞬态同步回执状态，不持久化。
    delivery: null,
  };
}

function sanitizeCachedScopeConversation(raw: unknown): CachedScopeConversation | null {
  if (!isRecord(raw)) return null;
  const identity = sanitizeIdentity(raw.identity);
  const scope = sanitizeScopeInfo(raw.scope);
  if (!identity || !scope) return null;

  const title = typeof raw.title === 'string' ? raw.title : '';
  const rawPreview = typeof raw.lastPreview === 'string' ? raw.lastPreview : '';
  const lastPreview =
    rawPreview.length > MAX_CACHED_PREVIEW_CHARS
      ? rawPreview.slice(0, MAX_CACHED_PREVIEW_CHARS)
      : rawPreview;

  const rawKey = typeof raw.key === 'string' ? raw.key.trim() : '';
  const key =
    rawKey ||
    `${identity.profileId}|${identity.kind}|0|${identity.targetDeviceId}:${scope.scope.scopeId}`;

  const item: CachedScopeConversation = {
    key,
    identity,
    scope,
    title,
    lastPreview,
  };

  if (raw.lastActivityAt === null) {
    item.lastActivityAt = null;
  } else if (typeof raw.lastActivityAt === 'string' && raw.lastActivityAt.trim().length > 0) {
    item.lastActivityAt = raw.lastActivityAt;
  }

  return item;
}

function dedupeAndSortCachedItems(rawItems: readonly unknown[]): CachedScopeConversation[] {
  const merged = new Map<string, CachedScopeConversation>();
  for (const raw of rawItems) {
    const item = sanitizeCachedScopeConversation(raw);
    if (!item) continue;
    const scopeId = item.scope.scope.scopeId;
    const existing = merged.get(scopeId);
    if (!existing) {
      merged.set(scopeId, item);
      continue;
    }
    const itemRev = item.scope.scope.revision ?? 0;
    const existingRev = existing.scope.scope.revision ?? 0;
    if (
      itemRev > existingRev ||
      (itemRev === existingRev && item.scope.isAuthority && !existing.scope.isAuthority)
    ) {
      merged.set(scopeId, item);
    }
  }

  return [...merged.values()]
    .sort((a, b) => {
      const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) || 0 : 0;
      const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) || 0 : 0;
      return bt - at || a.scope.scope.scopeId.localeCompare(b.scope.scope.scopeId);
    })
    .slice(0, MAX_CACHED_SCOPE_CONVERSATIONS);
}

/**
 * 读取指定分区的群聊/scope 缓存完整结果（含 hit 标记，可区分「无缓存条目」与「已确认空列表」）。
 */
export function readScopeConversationsCacheEntry(
  partitionKey: string,
  storage?: ScopeCacheStorage | null,
): ScopeConversationsCacheEntry {
  const trimmedKey = (partitionKey ?? '').trim();
  if (!trimmedKey) return { hit: false, items: [], updatedAt: null };
  const store = resolveStorage(storage);
  if (!store) return { hit: false, items: [], updatedAt: null };

  try {
    const raw = store.getItem(scopeConversationsCacheKey(trimmedKey));
    if (raw === null) return { hit: false, items: [], updatedAt: null };
    const parsed: unknown = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return {
        hit: true,
        items: dedupeAndSortCachedItems(parsed),
        updatedAt: null,
      };
    }

    if (
      isRecord(parsed) &&
      parsed.v === SCOPE_CONVERSATIONS_CACHE_VERSION &&
      Array.isArray(parsed.items)
    ) {
      const updatedAt =
        typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : null;
      return {
        hit: true,
        items: dedupeAndSortCachedItems(parsed.items),
        updatedAt,
      };
    }

    return { hit: false, items: [], updatedAt: null };
  } catch {
    return { hit: false, items: [], updatedAt: null };
  }
}

/**
 * 按分区同步读取缓存的 scope 会话列表（对齐 readCachedRemoteBots 约定，异常安全返回空数组）。
 */
export function readCachedScopeConversations(
  partitionKey: string,
  storage?: ScopeCacheStorage | null,
): CachedScopeConversation[] {
  return readScopeConversationsCacheEntry(partitionKey, storage).items;
}

/**
 * 按分区将 scope 会话列表写入 localStorage：
 * 自动剥离非可序列化 api 与瞬态 delivery、过滤已删除墓碑、按 scopeId 去重并限制上限。
 */
export function writeCachedScopeConversations(
  partitionKey: string,
  items: readonly ScopeConversationCacheInput[],
  storage?: ScopeCacheStorage | null,
): boolean {
  const trimmedKey = (partitionKey ?? '').trim();
  if (!trimmedKey) return false;
  const store = resolveStorage(storage);
  if (!store) return false;

  const sanitized = dedupeAndSortCachedItems(items);
  const payload: StoredScopeConversationsEnvelope = {
    v: SCOPE_CONVERSATIONS_CACHE_VERSION,
    updatedAt: Date.now(),
    items: sanitized,
  };
  try {
    store.setItem(scopeConversationsCacheKey(trimmedKey), JSON.stringify(payload));
    return true;
  } catch {
    // Ignore quota/storage errors
    return false;
  }
}

/** 从指定分区缓存中立即剔除已删除的 scopeId（仅在缓存已存在时写回，避免制造假缓存命中）。 */
export function removeCachedScopeConversation(
  partitionKey: string,
  scopeId: string,
  storage?: ScopeCacheStorage | null,
): boolean {
  const trimmedScopeId = (scopeId ?? '').trim();
  if (!trimmedScopeId) return false;
  const entry = readScopeConversationsCacheEntry(partitionKey, storage);
  if (!entry.hit) return false;
  const next = entry.items.filter((item) => item.scope.scope.scopeId !== trimmedScopeId);
  if (next.length === entry.items.length) return true;
  return writeCachedScopeConversations(partitionKey, next, storage);
}
