// gbot-ui lane：跨来源 scope 会话列表 hook（只读）。
// 数据来源为既有 listScopeStates/scopeHistory 读取 API，不改 host 协议；
// 每来源显式冻结 DesktopIdentity，不修改全局 identity。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScopeReadApi } from '../../../desktop/web/src/scope-api';
import type { DesktopIdentity } from '../../../desktop/web/src/scope-api';
import type {
  MessageHistoryPage,
  ScopeInfo,
  ScopeListCursor,
  ScopeListPage,
  StoredMessage,
} from '../../../host-core/index.js';
import { conversationTitle } from './ConversationChat';
import type { ConversationBot } from './ConversationChat';

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
  lastActivityAt: string | null;
}

export interface UseScopeConversationsResult {
  items: ScopeConversation[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 5_000;
const HISTORY_CONCURRENCY = 4;
const LIST_PAGE_LIMIT = 20;

type ScopeKind = 'room' | 'dm';

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const r = e as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code : '';
    const message = typeof r.message === 'string' ? r.message : '';
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
function accountKey(s: ScopeConversationSource): string {
  const id = s.identity;
  return id.profileId + '|' + id.kind + '|' + id.targetDeviceId;
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
 * history 失败保留该 scope 的上次预览/时间；无上次数据时才放空值。
 * 失效由调用方判定；每个 await 后经 stillValid() 早退。
 */
async function loadSource(
  source: ScopeConversationSource,
  kind: ScopeKind | undefined,
  prevHistory: Map<string, { preview: string; at: string | null }> | undefined,
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
    } else {
      activeScopes.push(s);
    }
  }

  const filtered = kind ? activeScopes.filter((s) => s.scope.kind === kind) : activeScopes;

  const history = new Map<string, { preview: string; at: string | null }>();
  let firstError: string | null = null;
  // 并发上限 4：游标池逐条取 scope，失败只记首个错误并保留旧预览。
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
          history.set(scopeId, prev ?? { preview: '', at: null });
          if (firstError === null) firstError = errText(e);
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
        title: conversationTitle(scope.scope, bots),
        lastPreview: h?.preview ?? '',
        lastActivityAt: h?.at ?? null,
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
): UseScopeConversationsResult {
  // sources/bots 数组可能每次渲染重建：稳定键由内容计算（非引用），
  // ref 持有最新值；只有键/kind/可见性变化才重载，避免请求循环。
  const sourcesKey = sources.map(sourceKey).join('\n');
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const [items, setItems] = useState<ScopeConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 顺序号：每次读取 +1；旧响应一律抛弃，旧请求 finally 不能锁住新读取。 */
  const seqRef = useRef(0);
  /** 不重入标记：与 seq 并用——新读取由调用方显式发起时先 bump seq 再置位。 */
  const inflightRef = useRef(false);
  const mountedRef = useRef(true);
  /** 每来源账户级最近数据（离线快照 + history 失败时的旧预览来源）。 */
  const snapshotRef = useRef<Map<string, { items: ScopeConversation[]; history: Map<string, { preview: string; at: string | null }> }>>(new Map());
  /** 跨来源已确认删除的 scopeId 墓碑集：防止滞后副本、轮询失败回退或离线快照复活已删群。 */
  const deletedScopeIdsRef = useRef<Set<string>>(new Set());
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
   * 单一读取通道：初次/换来源/换 kind/可见性恢复/5 秒定时/手动 refresh 全走这里。
   * seq 递增即作废旧请求（旧请求 finally 检查 seq 后才释放 loading）。
   * 可见性/pageActive 关闭时直接返回，不发请求。
   */
  const load = useCallback(async (force: boolean) => {
    if (!mountedRef.current) return;
    // 不重入：5 秒定时不叠加请求；force（换来源/kind/可见性恢复/手动 refresh）
    // 直接接管——bump seq 使旧请求作废，旧 finally 不释放本请求的标记。
    if (inflightRef.current && !force) return;
    const seq = ++seqRef.current;
    const stillValid = () => mountedRef.current && seq === seqRef.current;
    const snapshots = snapshotRef.current;
    const all = sourcesRef.current;
    const currentKind = kind;
    const mergedPool: ScopeConversation[] = [];
    const errors: string[] = [];
    /** 是否有在线来源参与读取：有则 mergedPool 为权威（空列表也覆盖旧快照）。 */
    let onlineAttempted = false;

    const deletedScopeIds = deletedScopeIdsRef.current;
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

    try {
      // 当前账户快照集（不含网络结果）：隐藏/离线/换账户等待期间只恢复它，不留旧账户项或已删项。
      const snapPool: ScopeConversation[] = [];
      for (const s of all) {
        const snap = snapshots.get(accountKey(s));
        if (snap) {
          const bots = s.bots ?? [];
          for (const item of snap.items) {
            const scopeId = item.scope.scope.scopeId;
            if (deletedScopeIds.has(scopeId) || isScopeDeleted(item.scope)) continue;
            if (currentKind && item.scope.scope.kind !== currentKind) continue;
            snapPool.push({
              ...item,
              title: conversationTitle(item.scope.scope, bots),
            });
          }
        }
      }
      if (pageActive && docVisible) {
        const online = all.filter((s) => s.api.transportConnected);
        // 先把显示收敛到当前账户快照（网络读取完成前不留旧账户项）。
        setItems(mergeItems(snapPool, deletedScopeIds));
        if (online.length === 0) {
          // 无在线来源：离线快照即最终结果。
          mergedPool.push(...snapPool);
        } else {
          onlineAttempted = true;
          // inflight 只在真实网络读取前持有；finally 统一释放。
          inflightRef.current = true;
          setLoading(true);
          const roundRemovedIds = new Set<string>();
          for (const source of online) {
            const label = source.label ?? source.identity.targetDeviceId;
            const acc = accountKey(source);
            const prev = snapshots.get(acc);
            try {
              const snap = await loadSource(source, currentKind, prev?.history, stillValid);
              if (!stillValid()) return;
              for (const deletedId of snap.deletedScopeIds) {
                deletedScopeIds.add(deletedId);
                roundRemovedIds.add(deletedId);
              }
              if (prev) {
                const activeIds = new Set(snap.scopes.map((s) => s.scope.scopeId));
                for (const prevItem of prev.items) {
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
              const produced = buildItems(source, snap);
              // 成功结果即权威（含空列表），快照替换，不回退旧快照。
              snapshots.set(acc, { items: produced, history: snap.history });
              mergedPool.push(...produced);
              if (snap.error) errors.push(label + ': ' + snap.error);
            } catch (e) {
              if (!stillValid()) return;
              const msg = errText(e);
              if (msg === 'stale') return;
              // 单来源失败：保留同账户未删除旧项 + 记错误，其他来源不受影响。
              if (prev) {
                const bots = source.bots ?? [];
                for (const item of prev.items) {
                  const scopeId = item.scope.scope.scopeId;
                  if (deletedScopeIds.has(scopeId) || isScopeDeleted(item.scope)) continue;
                  if (currentKind && item.scope.scope.kind !== currentKind) continue;
                  mergedPool.push({
                    ...item,
                    title: conversationTitle(item.scope.scope, bots),
                  });
                }
              }
              errors.push(label + ': ' + msg);
            }
          }
          purgeSnapshots(deletedScopeIds);
          // 离线来源的同账户缓存项并入结果（排除本轮在线已确认删除或移除的群聊，防止离线快照复活）。
          for (const s of all) {
            if (s.api.transportConnected) continue;
            const cached = snapshots.get(accountKey(s));
            if (!cached) continue;
            const bots = s.bots ?? [];
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
                title: conversationTitle(item.scope.scope, bots),
              });
            }
          }
        }
      }
      if (!stillValid()) return;
      // 隐藏/页面非激活：不发请求；离线来源快照已在上方并入 mergedPool，
      // 隐藏时 mergedPool 为空，改用当前账户快照收敛显示（不留旧账户列表）。
      setItems(
        mergeItems(
          onlineAttempted || mergedPool.length > 0 ? mergedPool : snapPool,
          deletedScopeIds,
        ),
      );
      setError(errors.length > 0 ? errors.join('；') : null);
    } finally {
      // 所有出口统一释放标记/loading（含隐藏、离线与 stale 早退）；
      // 过期请求的 finally 不释放标记、不锁新读取（新读取已自行接管）。
      if (seq === seqRef.current) {
        inflightRef.current = false;
        setLoading(false);
      }
    }
  }, [kind, pageActive, docVisible]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  // 初次/换来源（sourcesKey）/换 kind/可见性恢复：立即强制读取一轮，
  // 覆盖任何在途请求（bump seq 作废旧响应，旧 finally 不锁标记）。
  useEffect(() => {
    void load(true);
  }, [load, sourcesKey]);

  // 可见且 pageActive 时每 5 秒刷新；定时本身不重入（seq 机制抛弃重叠响应）。
  useEffect(() => {
    if (!pageActive || !docVisible) return;
    const timer = window.setInterval(() => { void load(false); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load, pageActive, docVisible, sourcesKey]);

  // 卸载时作废旧响应。
  useEffect(() => () => { seqRef.current += 1; }, []);

  return { items, loading, error, refresh };
}
