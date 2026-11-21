// gbot-ui lane：跨来源 scope 会话列表 hook（只读）。
// 数据来源为既有 listScopeStates/scopeHistory 读取 API，不改 host 协议；
// 每来源显式冻结 DesktopIdentity，不修改全局 identity。
// 传入 partitionKey 时支持首帧同步从 localStorage 恢复同分区缓存，在线刷新后原地更新并写回缓存（F4 / H3 / H5）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopIdentity, ScopeReadApi } from '../../../desktop/web/src/scope-api';
import type {
  DesktopObservationEvent,
  DesktopUiSnapshot,
  LiveTarget,
  ObservationHandle,
  RemoteControlMethodMap,
} from '../../../desktop/web/src/types';
import type {
  MessageHistoryPage,
  ScopeInfo,
  ScopeListCursor,
  ScopeListPage,
  StoredMessage,
} from '../../../host-core/index.js';
import { useText } from '../ui';
import { conversationTitle } from './ConversationChat';
import type { ConversationBot } from './ConversationChat';
import {
  normalizePartitionKey,
  readScopeConversationsCacheEntry,
  removeCachedScopeConversation,
  writeCachedScopeConversations,
  type CachedScopeConversation,
  type ScopeCacheStorage,
} from './scopeCache';

export interface ScopeConversationSource {
  api: ScopeReadApi;
  /** 冻结的读取身份：分页/历史请求始终用它，不跟随 api.identity 漂移。 */
  identity: DesktopIdentity;
  /** 成员名/头像目录；无信息时成员名用自然 fallback（已移除的 Bot），不回退 ID。 */
  bots?: readonly ConversationBot[];
  /** 来源标签（错误提示可区分哪一端失败）。 */
  label?: string;
}

export interface ScopeConversation {
  /** 稳定 key：来源序号 + 全局 scopeId（同 scopeId 跨设备副本合并后唯一）。 */
  key: string;
  api: ScopeReadApi;
  identity: DesktopIdentity;
  scope: ScopeInfo;
  title: string;
  lastPreview: string;
  /** undefined 表示尚未读到历史，null 表示确认没有消息。 */
  lastActivityAt: string | null | undefined;
}

export interface UseScopeConversationsOptions {
  /**
   * 持久化缓存分区键（如 Host.tsx 的 pinStorageScope / Desktop 的 profileKey）。
   * 传入后首帧同步从 localStorage 恢复该分区群聊列表，切换分区同步切换缓存，
   * 在线刷新后原地更新并写回缓存。缺省或空串时不启用跨重启 localStorage 缓存，保持既有调用方完全兼容。
   */
  partitionKey?: string | null;
  /**
   * 宿主仍在等待更多来源接入（例如远端 Center 尚未就绪、仅本机来源先连上）。
   * 为 true 时保留缓存中尚未出现在 sources 里的其他账号会话，避免本机先返回把远端群聊短暂冲掉。
   */
  awaitingSources?: boolean;
  /** 可选自定义存储后端（单元测试注入用；缺省使用 window.localStorage）。 */
  storage?: ScopeCacheStorage | null;
}

export interface UseScopeConversationsResult {
  items: ScopeConversation[];
  loading: boolean;
  /** 当前来源及会话类型已完成至少一次在线读取。 */
  loaded: boolean;
  /** 当前分区是否已完成首屏水合（命中本地缓存或至少完成一次在线读取）；用于区分骨架行与空态（H5）。 */
  hasHydrated: boolean;
  /** hasHydrated 的同义别名，便于调用方按语义读取。 */
  hasInitialData: boolean;
  error: string | null;
  /** 等待本轮（或与在途合并后的）实际刷新结束。 */
  refresh: () => Promise<void>;
  /** 外部（如权威节点 getScopeState/deleteScope 确认墓碑后）立即登记已删除 scopeId 并剔除残留副本。 */
  markDeleted: (scopeId: string) => void;
}

const POLL_INTERVAL_MS = 5_000;
// 单轮历史并发上限 3：原生 RPC 共 8 槽，余量留给中心状态/本机列表/用户操作。
const HISTORY_CONCURRENCY = 3;
const LIST_PAGE_LIMIT = 20;

type ScopeKind = 'room' | 'dm';

interface PartitionItemsState {
  cacheKey: string | null;
  items: ScopeConversation[];
  hydrated: boolean;
}

interface AccountSnapshot {
  items: ScopeConversation[];
  history: Map<string, { preview: string; at: string | null }>;
}

function isPeerOfflineError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return code === 'OFFLINE' || code === 'CONTROL_UNAVAILABLE' || code === 'DISCONNECTED';
}

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const r = e as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code.trim() : '';
    let message = typeof r.message === 'string' ? r.message.trim() : '';
    if (code && message.startsWith(`${code}:`)) {
      message = message.slice(code.length + 1).trim();
    }
    if (
      message === code ||
      /^(unconfirmed|not-sent|responded)$/i.test(message) ||
      /^(unconfirmed|not-sent|responded):\s*[A-Z0-9_]+$/i.test(message)
    ) {
      message = '';
    }
    if (code) return message ? code + ': ' + message : code;
    if (message) return message;
  }
  return String(e);
}

function previewOf(message: StoredMessage): string {
  return message.message.text;
}

/** 判定 scope 是否带有删除墓碑（deletedAt 非空字符串）。 */
function isScopeDeleted(info: ScopeInfo): boolean {
  const raw = (info.scope as { deletedAt?: unknown }).deletedAt;
  return typeof raw === 'string' && raw.trim().length > 0;
}

/** 来源稳定键：冻结身份四元组。 */
function sourceKey(s: ScopeConversationSource): string {
  const id = s.identity;
  return id.profileId + '|' + id.kind + '|' + id.generation + '|' + id.targetDeviceId;
}

/** 离线保留同账户最近快照：键为账户级（不含 generation）。 */
function accountKeyOfIdentity(id: DesktopIdentity): string {
  return id.profileId + '|' + id.kind + '|' + id.targetDeviceId;
}

function accountKey(s: ScopeConversationSource): string {
  return accountKeyOfIdentity(s.identity);
}

/**
 * 为冷启动缓存项构造安全离线只读 ScopeReadApi 占位：
 * 在真实 source 连上前点击缓存群聊也能安全打开详情（transportConnected=false），
 * 真实 source 就绪后由调用方按 identity 无缝升级为 liveApi。
 */
function createOfflineScopeReadApi(identity: DesktopIdentity): ScopeReadApi {
  const frozenIdentity: DesktopIdentity = {
    profileId: identity.profileId,
    targetDeviceId: identity.targetDeviceId,
    generation: 0,
    kind: identity.kind,
  };
  return {
    identity: frozenIdentity,
    identityForTarget(targetDeviceId: string): DesktopIdentity {
      return { ...frozenIdentity, targetDeviceId };
    },
    snapshot: null as DesktopUiSnapshot | null,
    transportConnected: false,
    async call<M extends keyof RemoteControlMethodMap>(
      _id: DesktopIdentity,
      _method: M,
      _params: RemoteControlMethodMap[M]['params'],
    ): Promise<RemoteControlMethodMap[M]['result']> {
      throw Object.assign(new Error('Offline'), {
        code: 'OFFLINE',
        message: 'Offline',
        outcome: 'not-sent' as const,
      });
    },
    observe(
      _id: DesktopIdentity,
      _target: LiveTarget,
      _onEvent: (event: DesktopObservationEvent) => void,
    ): ObservationHandle {
      return {
        ready: Promise.resolve(),
        close: async () => {},
      };
    },
    reportError(): void {
      // Offline cached placeholder: ignore error reports.
    },
  };
}

function resolveCachedTitle(
  item: ScopeConversation,
  bots: readonly ConversationBot[],
  t?: (zh: string, en: string) => string,
): string {
  const customTitle = typeof item.scope.scope.title === 'string' ? item.scope.scope.title.trim() : '';
  if (customTitle) return customTitle;
  if (
    bots.length > 0 &&
    item.scope.scope.members.some((m) =>
      bots.some((b) => b.deviceId === m.deviceId && b.botId === m.botId),
    )
  ) {
    return conversationTitle(item.scope.scope, bots, t);
  }
  return item.title || conversationTitle(item.scope.scope, bots, t);
}

function hydrateCachedScopeConversations(
  cached: readonly CachedScopeConversation[],
  kind?: ScopeKind,
  deletedScopeIds?: ReadonlySet<string>,
): ScopeConversation[] {
  const out: ScopeConversation[] = [];
  for (const entry of cached) {
    if (isScopeDeleted(entry.scope) || deletedScopeIds?.has(entry.scope.scope.scopeId)) continue;
    if (kind && entry.scope.scope.kind !== kind) continue;
    const identity: DesktopIdentity = {
      profileId: entry.identity.profileId,
      targetDeviceId: entry.identity.targetDeviceId,
      generation: 0,
      kind: entry.identity.kind,
    };
    out.push({
      key: entry.key,
      api: createOfflineScopeReadApi(identity),
      identity,
      scope: entry.scope,
      title: entry.title,
      lastPreview: entry.lastPreview,
      lastActivityAt: entry.lastActivityAt,
    });
  }
  return mergeItems(out, deletedScopeIds);
}

function sameConversationList(
  a: readonly ScopeConversation[],
  b: readonly ScopeConversation[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.key !== y.key ||
      x.api !== y.api ||
      x.title !== y.title ||
      x.lastPreview !== y.lastPreview ||
      x.lastActivityAt !== y.lastActivityAt ||
      x.scope.scope.scopeId !== y.scope.scope.scopeId ||
      x.scope.scope.revision !== y.scope.scope.revision ||
      x.scope.isAuthority !== y.scope.isAuthority ||
      x.scope.authorityDeviceId !== y.scope.authorityDeviceId
    ) {
      return false;
    }
    const xm = x.scope.scope.members;
    const ym = y.scope.scope.members;
    if (xm.length !== ym.length) return false;
    for (let j = 0; j < xm.length; j += 1) {
      if (xm[j]!.deviceId !== ym[j]!.deviceId || xm[j]!.botId !== ym[j]!.botId) {
        return false;
      }
    }
  }
  return true;
}

interface SourceSnapshot {
  /** 已按 kind 过滤且排除删除墓碑的活跃 scope 列表。 */
  scopes: ScopeInfo[];
  /** 本次读取观测到的删除墓碑 scopeId 集合。 */
  deletedScopeIds: Set<string>;
  history: Map<string, { preview: string; at: string | null }>;
  error: string | null;
}

/**
 * 汇总一个来源的全部 scope（沿 nextCursor 分页到无游标，不设人为页数上限），
 * 排除已删除墓碑并按 kind 过滤后再逐个 scopeHistory 取最新一条（room 列表不额外读 DM 历史）。
 * history 失败保留该 scope 的上次预览/时间；无上次数据时保持未知。
 * 失效由调用方判定；每个 await 后经 stillValid() 早退。
 */
async function loadSource(
  source: ScopeConversationSource,
  kind: ScopeKind | undefined,
  prevHistory: Map<string, { preview: string; at: string | null }> | undefined,
  knownDeletedIds: ReadonlySet<string>,
  stillValid: () => boolean,
): Promise<SourceSnapshot> {
  const { api, identity } = source;
  const rawScopes: ScopeInfo[] = [];
  let cursor: ScopeListCursor | null = null;
  do {
    const page: ScopeListPage = await api.call(identity, 'listScopeStates', {
      limit: LIST_PAGE_LIMIT,
      cursor,
    });
    if (!stillValid()) throw new Error('stale');
    rawScopes.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  const deletedScopeIds = new Set<string>();
  const activeScopes: ScopeInfo[] = [];
  for (const s of rawScopes) {
    if (isScopeDeleted(s)) {
      deletedScopeIds.add(s.scope.scopeId);
    } else if (!knownDeletedIds.has(s.scope.scopeId)) {
      activeScopes.push(s);
    }
  }

  const filtered = kind ? activeScopes.filter((s) => s.scope.kind === kind) : activeScopes;

  const history = new Map<string, { preview: string; at: string | null }>();
  let firstError: string | null = null;
  // 并发上限 3：游标池逐条取 scope，失败只记首个错误并保留旧预览。
  const queue = [...filtered];
  const workers = Array.from(
    { length: Math.min(HISTORY_CONCURRENCY, queue.length) },
    async () => {
      for (;;) {
        const scope = queue.shift();
        if (!scope || !stillValid()) return;
        const scopeId = scope.scope.scopeId;
        const prev = prevHistory?.get(scopeId);
        try {
          const page: MessageHistoryPage = await api.call(identity, 'scopeHistory', {
            scopeId,
            limit: 1,
            order: 'descending',
          });
          if (!stillValid()) return;
          const last = page.items[0];
          history.set(scopeId, {
            preview: last ? previewOf(last) : '',
            at: last ? last.message.createdAt : null,
          });
        } catch (e) {
          if (!stillValid()) return;
          // 失败保留该 scope 此前预览/时间，避免列表项在时间轴上乱跳。
          if (prev) history.set(scopeId, prev);
          if (firstError === null && !isPeerOfflineError(e)) firstError = errText(e);
        }
      }
    },
  );
  await Promise.all(workers);
  return { scopes: filtered, deletedScopeIds, history, error: firstError };
}

function buildItems(
  source: ScopeConversationSource,
  snap: SourceSnapshot,
  t?: (zh: string, en: string) => string,
): ScopeConversation[] {
  const bots = source.bots ?? [];
  return snap.scopes
    .filter((scope) => !isScopeDeleted(scope) && !snap.deletedScopeIds.has(scope.scope.scopeId))
    .map((scope) => {
      const h = snap.history.get(scope.scope.scopeId);
      return {
        key: sourceKey(source) + ':' + scope.scope.scopeId,
        api: source.api,
        identity: source.identity,
        scope,
        title: conversationTitle(scope.scope, bots, t),
        lastPreview: h?.preview ?? '',
        lastActivityAt: h?.at,
      };
    });
}

/**
 * 同全局 scopeId 的多设备副本合并：
 * - 任何来源已确认删除的 scopeId 一律排除，禁止旧副本或离线快照复活；
 * - 更高 revision 优先（确保改名 title 等新 revision 覆盖滞后副本），同 revision 权威来源优先，其次 sources 顺序。
 */
function mergeItems(
  list: ScopeConversation[],
  deletedScopeIds?: ReadonlySet<string>,
): ScopeConversation[] {
  const merged = new Map<string, ScopeConversation>();
  for (const item of list) {
    const scopeId = item.scope.scope.scopeId;
    if (isScopeDeleted(item.scope) || deletedScopeIds?.has(scopeId)) {
      merged.delete(scopeId);
      continue;
    }
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
  return [...merged.values()].sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return bt - at;
  });
}

export function useScopeConversations(
  sources: ScopeConversationSource[],
  pageActive = true,
  kind?: ScopeKind,
  options?: string | UseScopeConversationsOptions | null,
): UseScopeConversationsResult {
  const t = useText();
  const tRef = useRef(t);
  tRef.current = t;

  const rawPartitionKey = typeof options === 'string' ? options : options?.partitionKey;
  const awaitingSources =
    typeof options === 'object' && options !== null ? Boolean(options.awaitingSources) : false;
  const customStorage =
    typeof options === 'object' && options !== null ? options.storage : undefined;

  const storageRef = useRef<ScopeCacheStorage | null | undefined>(customStorage);
  storageRef.current = customStorage;
  const awaitingSourcesRef = useRef(awaitingSources);
  awaitingSourcesRef.current = awaitingSources;

  // 同一分区下 dm 与 room 缓存独立隔离，避免 DM 列表覆写群聊缓存；
  // room 与未指定 kind 直接复用 partitionKey，与 readCachedScopeConversations(partitionKey) 一致。
  const cacheKey = useMemo(() => {
    const trimmed = typeof rawPartitionKey === 'string' ? rawPartitionKey.trim() : '';
    if (!trimmed) return null;
    const normalized = normalizePartitionKey(trimmed);
    return kind === 'dm' ? `${normalized}|dm` : normalized;
  }, [rawPartitionKey, kind]);
  const cacheKeyRef = useRef<string | null>(cacheKey);
  cacheKeyRef.current = cacheKey;

  // sources/bots 数组可能每次渲染重建：稳定键由内容计算（非引用），
  // ref 持有最新值；只有键/kind/分区/可见性变化才重载，避免请求循环。
  const sourcesKey = sources.map(sourceKey).join('\n');
  const resultKey = `${cacheKey ?? ''}\n${kind ?? ''}\n${sourcesKey}`;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  /** 按分区隔离的已确认删除墓碑集：防止滞后副本、轮询失败回退或离线快照复活已删群，也不跨分区串味。 */
  const deletedByPartitionRef = useRef<Map<string, Set<string>>>(new Map());
  const getDeletedSet = useCallback((targetCacheKey: string | null): Set<string> => {
    const bucket = targetCacheKey ?? '__ephemeral__';
    let set = deletedByPartitionRef.current.get(bucket);
    if (!set) {
      set = new Set<string>();
      deletedByPartitionRef.current.set(bucket, set);
    }
    return set;
  }, []);

  /** 按分区隔离的每来源账户级最近数据（离线快照 + history 失败时的旧预览来源）。 */
  const snapshotsByPartitionRef = useRef<Map<string, Map<string, AccountSnapshot>>>(new Map());
  const getSnapshotsMap = useCallback(
    (targetCacheKey: string | null): Map<string, AccountSnapshot> => {
      const bucket = targetCacheKey ?? '__ephemeral__';
      let map = snapshotsByPartitionRef.current.get(bucket);
      if (!map) {
        map = new Map<string, AccountSnapshot>();
        snapshotsByPartitionRef.current.set(bucket, map);
      }
      return map;
    },
    [],
  );

  const readPartitionState = useCallback(
    (targetCacheKey: string | null): PartitionItemsState => {
      if (!targetCacheKey) {
        return { cacheKey: null, items: [], hydrated: false };
      }
      const entry = readScopeConversationsCacheEntry(targetCacheKey, storageRef.current);
      if (!entry.hit) {
        return { cacheKey: targetCacheKey, items: [], hydrated: false };
      }
      const deletedSet = getDeletedSet(targetCacheKey);
      return {
        cacheKey: targetCacheKey,
        items: hydrateCachedScopeConversations(entry.items, kind, deletedSet),
        hydrated: true,
      };
    },
    [kind, getDeletedSet],
  );

  // 首帧同步从 localStorage 读取当前分区缓存（H3 / H5）。
  const [partitionState, setPartitionState] = useState<PartitionItemsState>(() =>
    readPartitionState(cacheKey),
  );
  // 分区切换时当拍同步读取新分区缓存，不经过空白中间帧，也绝不把旧分区写入新分区。
  const activePartitionState = useMemo<PartitionItemsState>(
    () => (partitionState.cacheKey === cacheKey ? partitionState : readPartitionState(cacheKey)),
    [partitionState, cacheKey, readPartitionState],
  );
  const partitionCacheRef = useRef<{ cacheKey: string | null; items: ScopeConversation[] }>({
    cacheKey: partitionState.cacheKey,
    items: partitionState.items,
  });

  useEffect(() => {
    if (partitionState.cacheKey !== cacheKey) {
      partitionCacheRef.current = {
        cacheKey: activePartitionState.cacheKey,
        items: activePartitionState.items,
      };
      setPartitionState(activePartitionState);
    }
  }, [cacheKey, partitionState.cacheKey, activePartitionState]);

  const [loading, setLoading] = useState(false);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 顺序号：每轮开始/作废 +1；旧响应一律抛弃。 */
  const seqRef = useRef(0);
  /** 唯一串行刷新链：在途时所有调用（含首轮）共享同一 Promise，链内末轮结束才 resolve。 */
  const flightRef = useRef<Promise<void> | null>(null);
  /** 唯一待刷新槽：在途被 force 置位，当前轮结算后链内续一轮；单个布尔非队列。 */
  const pendingRef = useRef(false);
  /** 最新单轮读取体：链内每轮经 ref 取最新 kind/pageActive/docVisible/sources/cacheKey。 */
  const readRoundRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const mountedRef = useRef(true);
  /** 文档可见性：隐藏时暂停读取与定时，恢复时立即刷新一轮。 */
  const [docVisible, setDocVisible] = useState(() =>
    typeof document === 'undefined' ? true : document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const onVisibility = (): void => setDocVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * 单轮真实读取体：每轮开始 bump seq（旧响应一律抛弃），stillValid 守卫每个 await 后早退；
   * pageActive/docVisible 关闭或全部来源离线时不发网络请求，保留当前分区缓存与账户快照。
   * 渲染期写入 ref，刷新链内每轮经它取最新 kind/pageActive/docVisible/sources/cacheKey。
   */
  readRoundRef.current = async () => {
    if (!mountedRef.current) return;
    const seq = ++seqRef.current;
    const roundCacheKey = cacheKeyRef.current;
    const roundAwaitingSources = awaitingSourcesRef.current;
    const stillValid = () =>
      mountedRef.current && seq === seqRef.current && roundCacheKey === cacheKeyRef.current;
    const snapshots = getSnapshotsMap(roundCacheKey);
    const deletedScopeIds = getDeletedSet(roundCacheKey);
    const all = sourcesRef.current;
    const currentKind = kind;
    const translate = tRef.current;
    const mergedPool: ScopeConversation[] = [];
    const errors: string[] = [];
    /** 是否有在线来源参与读取：有则 mergedPool 为权威（空列表也覆盖旧快照）。 */
    let onlineAttempted = false;
    /** 本轮是否至少有一个在线来源成功返回（全失败时不覆盖本地持久缓存）。 */
    let anyOnlineSucceeded = false;

    const purgeSnapshots = (idsToPurge: ReadonlySet<string>) => {
      if (idsToPurge.size === 0) return;
      for (const snap of snapshots.values()) {
        snap.items = snap.items.filter(
          (item) => !idsToPurge.has(item.scope.scope.scopeId) && !isScopeDeleted(item.scope),
        );
        for (const id of idsToPurge) {
          snap.history.delete(id);
        }
      }
    };

    // 读取当前分区已持久化的缓存项，按账户分组供离线回退、历史回退与首屏保活。
    const cachedItemsForPartition: ScopeConversation[] = roundCacheKey
      ? (partitionCacheRef.current.cacheKey === roundCacheKey
          ? partitionCacheRef.current.items
          : hydrateCachedScopeConversations(
              readScopeConversationsCacheEntry(roundCacheKey, storageRef.current).items,
              currentKind,
              deletedScopeIds,
            ))
      : [];
    const cachedByAccount = new Map<string, ScopeConversation[]>();
    for (const item of cachedItemsForPartition) {
      const scopeId = item.scope.scope.scopeId;
      if (deletedScopeIds.has(scopeId) || isScopeDeleted(item.scope)) continue;
      if (currentKind && item.scope.scope.kind !== currentKind) continue;
      const acc = accountKeyOfIdentity(item.identity);
      const bucket = cachedByAccount.get(acc);
      if (bucket) bucket.push(item);
      else cachedByAccount.set(acc, [item]);
    }
    const fallbackBots: readonly ConversationBot[] =
      all.find((s) => (s.bots?.length ?? 0) > 0)?.bots ?? [];
    const presentAccounts = new Set(all.map(accountKey));
    const online = pageActive && docVisible ? all.filter((s) => s.api.transportConnected) : [];

    // 当前账户快照集（不含本轮网络结果）：结合内存快照与同分区持久化缓存，避免冷启动首帧被清空。
    const snapPool: ScopeConversation[] = [];
    for (const s of all) {
      const acc = accountKey(s);
      const snap = snapshots.get(acc);
      const bots = s.bots ?? [];
      if (snap) {
        for (const item of snap.items) {
          const scopeId = item.scope.scope.scopeId;
          if (deletedScopeIds.has(scopeId) || isScopeDeleted(item.scope)) continue;
          if (currentKind && item.scope.scope.kind !== currentKind) continue;
          snapPool.push({
            ...item,
            title: conversationTitle(item.scope.scope, bots, translate),
          });
        }
      } else {
        const cachedAcc = cachedByAccount.get(acc);
        if (cachedAcc) {
          for (const item of cachedAcc) {
            snapPool.push({
              ...item,
              api: s.api,
              identity: s.identity,
              title: resolveCachedTitle(item, bots, translate),
            });
          }
        }
      }
    }
    // 离线、页面未激活、或仍在等待更多来源接入时，保留同分区缓存中尚未出现在 sources 里的其他账号项。
    if (
      roundCacheKey !== null &&
      (!pageActive || !docVisible || online.length === 0 || roundAwaitingSources)
    ) {
      for (const [acc, list] of cachedByAccount) {
        if (presentAccounts.has(acc)) continue;
        for (const item of list) {
          snapPool.push({
            ...item,
            title: resolveCachedTitle(item, fallbackBots, translate),
          });
        }
      }
    }

    const commitItems = (
      nextItems: ScopeConversation[],
      nextHydratedFlag: boolean,
    ): void => {
      setPartitionState((prev) => {
        const sameKey = prev.cacheKey === roundCacheKey;
        const hydrated = (sameKey && prev.hydrated) || nextHydratedFlag;
        if (sameKey && prev.hydrated === hydrated && sameConversationList(prev.items, nextItems)) {
          return prev;
        }
        return {
          cacheKey: roundCacheKey,
          items: nextItems,
          hydrated,
        };
      });
    };

    if (pageActive && docVisible) {
      if (roundCacheKey === null) {
        // 未启用分区缓存（如 Desktop 旧路径）：保持既有行为，网络读取前先收敛到当前账户快照不留旧账户项。
        commitItems(mergeItems(snapPool, deletedScopeIds), false);
      } else if (snapPool.length > 0) {
        // 启用分区缓存时绝不先清空为空数组；仅在已有快照/缓存时原地刷新标题与实时 api 引用。
        commitItems(mergeItems(snapPool, deletedScopeIds), true);
      }

      if (online.length === 0) {
        // 无在线来源：离线快照/同分区缓存即最终结果。
        mergedPool.push(...snapPool);
      } else {
        onlineAttempted = true;
        // loading 由整条刷新链持有，链末统一释放。
        setLoading(true);
        const roundRemovedIds = new Set<string>();
        const onlineAuthorityMap = new Map<
          string,
          { source: ScopeConversationSource; activeIds: Set<string> }
        >();
        for (const source of online) {
          const label = source.label ?? source.identity.targetDeviceId;
          const acc = accountKey(source);
          const prev = snapshots.get(acc);
          const cachedAcc = cachedByAccount.get(acc);
          let prevHistory = prev?.history;
          if (!prevHistory && cachedAcc && cachedAcc.length > 0) {
            prevHistory = new Map<string, { preview: string; at: string | null }>();
            for (const item of cachedAcc) {
              if (item.lastActivityAt !== undefined || item.lastPreview) {
                prevHistory.set(item.scope.scope.scopeId, {
                  preview: item.lastPreview,
                  at: item.lastActivityAt ?? null,
                });
              }
            }
          }
          try {
            const snap = await loadSource(
              source,
              currentKind,
              prevHistory,
              deletedScopeIds,
              stillValid,
            );
            if (!stillValid()) return;
            anyOnlineSucceeded = true;
            for (const deletedId of snap.deletedScopeIds) {
              deletedScopeIds.add(deletedId);
              roundRemovedIds.add(deletedId);
            }
            const activeIds = new Set(snap.scopes.map((s) => s.scope.scopeId));
            onlineAuthorityMap.set(source.identity.targetDeviceId, { source, activeIds });
            const prevItemsForDiff = prev?.items ?? cachedAcc;
            if (prevItemsForDiff) {
              for (const prevItem of prevItemsForDiff) {
                if (currentKind && prevItem.scope.scope.kind !== currentKind) continue;
                const prevId = prevItem.scope.scope.scopeId;
                if (!activeIds.has(prevId)) {
                  roundRemovedIds.add(prevId);
                  if (
                    prevItem.scope.isAuthority ||
                    prevItem.scope.authorityDeviceId === source.identity.targetDeviceId
                  ) {
                    deletedScopeIds.add(prevId);
                  }
                }
              }
            }
            const produced = buildItems(source, snap, translate);
            // 成功结果即权威（含空列表），快照替换，不回退旧快照。
            snapshots.set(acc, { items: produced, history: snap.history });
            mergedPool.push(...produced);
            if (snap.error) errors.push(label + ': ' + snap.error);
          } catch (e) {
            if (!stillValid()) return;
            const msg = errText(e);
            if (msg === 'stale') return;
            // 单来源失败：保留同账户未删除旧项（优先内存快照，次选本地持久化缓存）。
            const bots = source.bots ?? [];
            const fallbackItems = prev?.items ?? cachedAcc;
            if (fallbackItems) {
              for (const item of fallbackItems) {
                const scopeId = item.scope.scope.scopeId;
                if (deletedScopeIds.has(scopeId) || isScopeDeleted(item.scope)) continue;
                if (currentKind && item.scope.scope.kind !== currentKind) continue;
                mergedPool.push({
                  ...item,
                  api: source.api,
                  identity: source.identity,
                  title: prev
                    ? conversationTitle(item.scope.scope, bots, translate)
                    : resolveCachedTitle(item, bots, translate),
                });
              }
            }
            if (!isPeerOfflineError(e)) {
              errors.push(label + ': ' + msg);
            }
          }
        }
        // 冷启动或重连时若滞后副本仍返回某群聊，而该群在线权威节点的 listScopeStates 已不含它，
        // 向权威节点单点核实 getScopeState：确认携带 deletedAt 墓碑后立即压制滞后副本，避免僵尸群常驻。
        const probedOrphans = new Set<string>();
        for (const item of mergedPool) {
          const scopeId = item.scope.scope.scopeId;
          const authDeviceId = item.scope.authorityDeviceId;
          if (
            item.scope.isAuthority ||
            !authDeviceId ||
            deletedScopeIds.has(scopeId) ||
            probedOrphans.has(scopeId)
          ) {
            continue;
          }
          const authOnline = onlineAuthorityMap.get(authDeviceId);
          if (!authOnline || authOnline.activeIds.has(scopeId)) continue;
          probedOrphans.add(scopeId);
          try {
            const authLatest: ScopeInfo = await authOnline.source.api.call(
              authOnline.source.identity,
              'getScopeState',
              { scopeId },
            );
            if (!stillValid()) return;
            if (isScopeDeleted(authLatest)) {
              deletedScopeIds.add(scopeId);
              roundRemovedIds.add(scopeId);
            }
          } catch (checkErr) {
            if (!stillValid()) return;
            if ((checkErr as { code?: unknown })?.code === 'SCOPE_DELETED') {
              deletedScopeIds.add(scopeId);
              roundRemovedIds.add(scopeId);
            }
          }
        }
        purgeSnapshots(deletedScopeIds);
        // 离线来源的同账户缓存项并入结果（排除本轮在线已确认删除或移除的群聊，防止离线快照复活）。
        for (const s of all) {
          if (s.api.transportConnected) continue;
          const acc = accountKey(s);
          const bots = s.bots ?? [];
          const cached = snapshots.get(acc);
          if (cached) {
            cached.items = cached.items.filter(
              (item) =>
                !deletedScopeIds.has(item.scope.scope.scopeId) &&
                !roundRemovedIds.has(item.scope.scope.scopeId) &&
                !isScopeDeleted(item.scope),
            );
            for (const item of cached.items) {
              if (currentKind && item.scope.scope.kind !== currentKind) continue;
              mergedPool.push({
                ...item,
                title: conversationTitle(item.scope.scope, bots, translate),
              });
            }
          } else {
            const persisted = cachedByAccount.get(acc);
            if (persisted) {
              for (const item of persisted) {
                const scopeId = item.scope.scope.scopeId;
                if (
                  deletedScopeIds.has(scopeId) ||
                  roundRemovedIds.has(scopeId) ||
                  isScopeDeleted(item.scope)
                ) {
                  continue;
                }
                if (currentKind && item.scope.scope.kind !== currentKind) continue;
                mergedPool.push({
                  ...item,
                  api: s.api,
                  identity: s.identity,
                  title: resolveCachedTitle(item, bots, translate),
                });
              }
            }
          }
        }
        // 仍有远端来源待接入或本轮全部在线来源均失败时，保留同分区缓存里尚未进入 sources 的其他账号项。
        if (roundCacheKey !== null && (roundAwaitingSources || !anyOnlineSucceeded)) {
          for (const [acc, list] of cachedByAccount) {
            if (presentAccounts.has(acc)) continue;
            for (const item of list) {
              const scopeId = item.scope.scope.scopeId;
              if (
                deletedScopeIds.has(scopeId) ||
                roundRemovedIds.has(scopeId) ||
                isScopeDeleted(item.scope)
              ) {
                continue;
              }
              const authOnline = item.scope.authorityDeviceId
                ? onlineAuthorityMap.get(item.scope.authorityDeviceId)
                : undefined;
              if (authOnline && !authOnline.activeIds.has(scopeId)) {
                continue;
              }
              mergedPool.push({
                ...item,
                title: resolveCachedTitle(item, fallbackBots, translate),
              });
            }
          }
        }
      }
    }
    if (!stillValid()) return;
    // 隐藏/页面非激活：不发请求；离线来源快照已在上方并入 mergedPool，
    // 隐藏时 mergedPool 为空，改用当前账户快照与同分区缓存收敛显示。
    const finalItems = mergeItems(
      onlineAttempted || mergedPool.length > 0 ? mergedPool : snapPool,
      deletedScopeIds,
    );

    if (roundCacheKey !== null) {
      const shouldPersist = anyOnlineSucceeded && (!roundAwaitingSources || finalItems.length > 0);
      if (shouldPersist) {
        partitionCacheRef.current = { cacheKey: roundCacheKey, items: finalItems };
        writeCachedScopeConversations(roundCacheKey, finalItems, storageRef.current);
      } else if (finalItems.length > 0) {
        partitionCacheRef.current = { cacheKey: roundCacheKey, items: finalItems };
      }
      const nextHydrated = finalItems.length > 0 || (onlineAttempted && !roundAwaitingSources);
      commitItems(finalItems, nextHydrated);
    } else {
      commitItems(finalItems, onlineAttempted);
    }

    // 只上报第一条来源错误：多来源拼接（"A: …；B: …"）会把原始异常整串暴露给用户，
    // 单条错误也能保持 humanizeError 的 KNOWN_CODE_PREFIX（"CODE: message"）可解析。
    setError(errors.length > 0 ? errors[0] : null);
    if (onlineAttempted) setLoadedKey(resultKey);
  };

  /**
   * 单一读取通道：任意时刻至多一条串行刷新链（flight）。
   * 链在途：非 force（定时）直接共享链不占槽；force 立即 bump seq 作废旧轮 + 占唯一
   * pending 槽，不并行重启（旧请求仍占原生槽位），返回同一 flight——所有调用方
   * （含首轮 refresh）都等到链内末轮结束。无在途：开启新链，do/while 逐轮 await
   * 最新 readRoundRef；链自身只 await 单轮、不 await flight。链末统一清
   * flight/loading（含隐藏、离线、stale、卸载各出口）。
   */
  const load = useCallback((force: boolean): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve();
    const current = flightRef.current;
    if (current) {
      if (force) {
        seqRef.current += 1;
        pendingRef.current = true;
      }
      return current;
    }
    const flight = (async () => {
      try {
        do {
          pendingRef.current = false;
          await readRoundRef.current();
        } while (pendingRef.current && mountedRef.current);
      } finally {
        flightRef.current = null;
        if (mountedRef.current) setLoading(false);
      }
    })();
    flightRef.current = flight;
    return flight;
  }, []);

  const refresh = useCallback((): Promise<void> => load(true), [load]);

  const markDeleted = useCallback(
    (scopeId: string): void => {
      if (!scopeId) return;
      const activeCacheKey = cacheKeyRef.current;
      getDeletedSet(activeCacheKey).add(scopeId);
      const snapshots = getSnapshotsMap(activeCacheKey);
      for (const snap of snapshots.values()) {
        snap.items = snap.items.filter((item) => item.scope.scope.scopeId !== scopeId);
        snap.history.delete(scopeId);
      }
      if (partitionCacheRef.current.cacheKey === activeCacheKey) {
        partitionCacheRef.current = {
          cacheKey: activeCacheKey,
          items: partitionCacheRef.current.items.filter(
            (item) => item.scope.scope.scopeId !== scopeId,
          ),
        };
      }
      if (activeCacheKey !== null) {
        removeCachedScopeConversation(activeCacheKey, scopeId, storageRef.current);
      }
      if (mountedRef.current) {
        setPartitionState((prev) => ({
          ...prev,
          items: prev.items.filter((item) => item.scope.scope.scopeId !== scopeId),
        }));
      }
    },
    [getDeletedSet, getSnapshotsMap],
  );

  // 初次/换来源（sourcesKey）/换 kind/换分区/待接入来源状态变化/pageActive/可见性恢复：请求一轮合并刷新——
  // 无在途链立即开启；有则作废旧轮并入唯一待刷新槽，链内续读最新闭包的一轮。
  useEffect(() => {
    void load(true);
  }, [load, sourcesKey, kind, pageActive, docVisible, cacheKey, awaitingSources]);

  // 可见且 pageActive 时每 5 秒刷新；定时在途直接丢弃，不占待刷新槽。
  useEffect(() => {
    if (!pageActive || !docVisible) return;
    const timer = window.setInterval(() => { void load(false); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load, pageActive, docVisible, sourcesKey, kind, cacheKey]);

  // 卸载时作废旧响应；在途链经 mountedRef/while 条件自然终止，不再续网络。
  useEffect(() => () => { seqRef.current += 1; }, []);

  const loaded = loadedKey === resultKey;
  const hasHydrated =
    cacheKey !== null
      ? activePartitionState.hydrated || (loaded && partitionState.cacheKey === cacheKey)
      : loaded || activePartitionState.items.length > 0;

  return {
    items: activePartitionState.items,
    loading,
    loaded,
    hasHydrated,
    hasInitialData: hasHydrated,
    error,
    refresh,
    markDeleted,
  };
}
