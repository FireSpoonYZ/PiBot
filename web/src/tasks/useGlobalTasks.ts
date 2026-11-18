import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  countWaitingTasks,
  isTaskNotFoundError,
  type GlobalTask,
  type TaskListCursor,
} from './types';

export type TaskTransportFn = (input: Record<string, unknown>) => Promise<any>;

export interface UseGlobalTasksOptions {
  transport: TaskTransportFn | null;
  enabled: boolean;
  pollIntervalMs?: number;
  draftStorageKey?: string;
  /** 隔离当前 Center/工作区任务缓存与异步响应的稳定键；默认回退为 draftStorageKey。 */
  scopeKey?: string;
}

export interface GlobalTasksController {
  tasks: GlobalTask[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  waitingCount: number;
  activeTruncated?: boolean;
  historyTruncated?: boolean;
  createDraft: string;
  setCreateDraft: (value: string) => void;
  showDraftSaved: boolean;
  markDraftLeftUnpublished: () => void;
  refresh: () => Promise<GlobalTask[]>;
  getTask: (taskId: string) => Promise<GlobalTask | null>;
  createTask: (input: { text: string; title?: string }) => Promise<GlobalTask>;
  updateTask: (input: Record<string, unknown> & { taskId: string }) => Promise<GlobalTask>;
  confirmPlan: (taskId: string, expectedRevision?: number) => Promise<GlobalTask>;
  answerPrompt: (taskId: string, answer: string, expectedRevision?: number) => Promise<GlobalTask>;
  resolveAdoptionScope: (
    taskId: string,
    scope: 'keep' | 'redo',
    expectedRevision?: number,
  ) => Promise<GlobalTask>;
  dismissAdoption: (taskId: string) => Promise<GlobalTask>;
  deleteTask: (taskId: string) => Promise<void>;
}

const DEFAULT_DRAFT_STORAGE_KEY = 'pibot-global-task-draft:v1';
const DEFAULT_POLL_INTERVAL_MS = 4000;
const ACTIVE_PAGE_LIMIT = 500;
const HISTORY_DONE_LIMIT = 200;
const MAX_ACTIVE_PAGES = 20;
const EMPTY_TASKS: GlobalTask[] = [];

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

interface ScopedTasksState {
  scopeKey: string;
  tasks: GlobalTask[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  activeTruncated: boolean;
  historyTruncated: boolean;
}

interface ScopedDraftState {
  scopeKey: string;
  storageKey: string;
  value: string;
  showSaved: boolean;
}

function readDraftStorage(key: string): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeDraftStorage(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

function pickNewerTask(existing: GlobalTask | undefined, incoming: GlobalTask): GlobalTask {
  if (!existing) return incoming;
  if (incoming.revision !== existing.revision) {
    return incoming.revision > existing.revision ? incoming : existing;
  }
  return incoming.updatedAt >= existing.updatedAt ? incoming : existing;
}

function sortTasksDesc(tasks: GlobalTask[]): GlobalTask[] {
  return tasks.slice().sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
    if (a.id === b.id) return 0;
    return a.id < b.id ? 1 : -1;
  });
}

function upsertTaskList(list: GlobalTask[], task: GlobalTask): GlobalTask[] {
  const index = list.findIndex(item => item.id === task.id);
  if (index === -1) return [task, ...list];
  const merged = pickNewerTask(list[index], task);
  if (merged === list[index]) return list;
  const next = list.slice();
  next[index] = merged;
  return next;
}

function parseListCursor(raw: unknown): TaskListCursor | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { updatedAt?: unknown; id?: unknown };
  if (
    typeof obj.updatedAt === 'number' &&
    Number.isFinite(obj.updatedAt) &&
    typeof obj.id === 'string' &&
    obj.id.length > 0
  ) {
    return { updatedAt: obj.updatedAt, id: obj.id };
  }
  return null;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '操作失败');
}

export function useGlobalTasks({
  transport,
  enabled,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  draftStorageKey = DEFAULT_DRAFT_STORAGE_KEY,
  scopeKey,
}: UseGlobalTasksOptions): GlobalTasksController {
  const effectiveScopeKey = scopeKey ?? draftStorageKey;
  const hasTransport = Boolean(transport);

  const [scopedState, setScopedState] = useState<ScopedTasksState>(() => ({
    scopeKey: effectiveScopeKey,
    tasks: EMPTY_TASKS,
    loading: false,
    loaded: false,
    error: null,
    activeTruncated: false,
    historyTruncated: false,
  }));

  const [draftState, setDraftState] = useState<ScopedDraftState>(() => {
    const stored = readDraftStorage(draftStorageKey);
    return {
      scopeKey: effectiveScopeKey,
      storageKey: draftStorageKey,
      value: stored,
      showSaved: stored.trim().length > 0,
    };
  });

  const [visible, setVisible] = useState<boolean>(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  );

  const scopeMatches = scopedState.scopeKey === effectiveScopeKey;
  const exposedTasks = scopeMatches ? scopedState.tasks : EMPTY_TASKS;
  const exposedLoading = scopeMatches ? scopedState.loading : false;
  const exposedLoaded = scopeMatches ? scopedState.loaded : false;
  const exposedError = scopeMatches ? scopedState.error : null;
  const exposedActiveTruncated = scopeMatches ? scopedState.activeTruncated : false;
  const exposedHistoryTruncated = scopeMatches ? scopedState.historyTruncated : false;

  const draftMatches =
    draftState.scopeKey === effectiveScopeKey && draftState.storageKey === draftStorageKey;
  const exposedCreateDraft = draftMatches ? draftState.value : readDraftStorage(draftStorageKey);
  const exposedShowDraftSaved = draftMatches
    ? draftState.showSaved
    : exposedCreateDraft.trim().length > 0;

  const transportRef = useRef(transport);
  transportRef.current = transport;
  const tasksRef = useRef(exposedTasks);
  tasksRef.current = exposedTasks;
  const activeScopeRef = useRef(effectiveScopeKey);
  const draftStorageKeyRef = useRef(draftStorageKey);
  draftStorageKeyRef.current = draftStorageKey;
  const scopeEpochRef = useRef(0);
  const mutationSeqRef = useRef(0);
  const inFlightRefreshRef = useRef<{
    scopeKey: string;
    epoch: number;
    promise: Promise<GlobalTask[]>;
  } | null>(null);
  const pinnedByGetRef = useRef<Map<string, GlobalTask>>(new Map());
  const deletedAtSeqRef = useRef<Map<string, number>>(new Map());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrentScope = useCallback((expectedScope: string, expectedEpoch: number) => {
    return (
      mountedRef.current &&
      activeScopeRef.current === expectedScope &&
      scopeEpochRef.current === expectedEpoch
    );
  }, []);

  useIsomorphicLayoutEffect(() => {
    activeScopeRef.current = effectiveScopeKey;
    inFlightRefreshRef.current = null;
    pinnedByGetRef.current.clear();
    deletedAtSeqRef.current.clear();
    setScopedState({
      scopeKey: effectiveScopeKey,
      tasks: EMPTY_TASKS,
      loading: false,
      loaded: false,
      error: null,
      activeTruncated: false,
      historyTruncated: false,
    });
    return () => {
      scopeEpochRef.current += 1;
      inFlightRefreshRef.current = null;
      pinnedByGetRef.current.clear();
      deletedAtSeqRef.current.clear();
    };
  }, [effectiveScopeKey]);

  useEffect(() => {
    const stored = readDraftStorage(draftStorageKey);
    setDraftState({
      scopeKey: effectiveScopeKey,
      storageKey: draftStorageKey,
      value: stored,
      showSaved: stored.trim().length > 0,
    });
  }, [effectiveScopeKey, draftStorageKey]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibilityChange = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const setCreateDraft = useCallback(
    (value: string) => {
      writeDraftStorage(draftStorageKey, value);
      setDraftState(prev => ({
        scopeKey: effectiveScopeKey,
        storageKey: draftStorageKey,
        value,
        showSaved:
          prev.scopeKey === effectiveScopeKey && prev.storageKey === draftStorageKey
            ? prev.showSaved
            : false,
      }));
    },
    [effectiveScopeKey, draftStorageKey],
  );

  const markDraftLeftUnpublished = useCallback(() => {
    const hasText = readDraftStorage(draftStorageKey).trim().length > 0;
    setDraftState(prev => ({
      scopeKey: effectiveScopeKey,
      storageKey: draftStorageKey,
      value:
        prev.scopeKey === effectiveScopeKey && prev.storageKey === draftStorageKey
          ? prev.value
          : readDraftStorage(draftStorageKey),
      showSaved: hasText,
    }));
  }, [effectiveScopeKey, draftStorageKey]);

  const refresh = useCallback(async (): Promise<GlobalTask[]> => {
    const fn = transportRef.current;
    if (!fn) return tasksRef.current;

    const scopeAtStart = effectiveScopeKey;
    const epochAtStart = scopeEpochRef.current;
    if (
      inFlightRefreshRef.current &&
      inFlightRefreshRef.current.scopeKey === scopeAtStart &&
      inFlightRefreshRef.current.epoch === epochAtStart
    ) {
      return inFlightRefreshRef.current.promise;
    }

    const seqAtStart = mutationSeqRef.current;
    setScopedState(prev =>
      prev.scopeKey === scopeAtStart ? { ...prev, loading: true } : prev,
    );

    let settled = false;
    let flightEntry: {
      scopeKey: string;
      epoch: number;
      promise: Promise<GlobalTask[]>;
    } | null = null;

    const promise = (async () => {
      try {
        // Center keyset pagination contract:
        // list input: { status, limit, cursor?: { updatedAt: number, id: string } | null }
        // list response: { tasks: GlobalTask[], serverTime: number, nextCursor?: { updatedAt: number, id: string } | null }
        const fetchAllActivePages = async (): Promise<{
          tasks: GlobalTask[];
          truncated: boolean;
        }> => {
          const collected: GlobalTask[] = [];
          let cursor: TaskListCursor | null = null;
          let truncated = false;
          for (let page = 0; page < MAX_ACTIVE_PAGES; page += 1) {
            if (!isCurrentScope(scopeAtStart, epochAtStart)) {
              return { tasks: EMPTY_TASKS, truncated: false };
            }
            const res = await fn({
              action: 'list',
              status: 'active',
              limit: ACTIVE_PAGE_LIMIT,
              ...(cursor ? { cursor } : {}),
            });
            if (!isCurrentScope(scopeAtStart, epochAtStart)) {
              return { tasks: EMPTY_TASKS, truncated: false };
            }
            const pageTasks: GlobalTask[] = Array.isArray(res?.tasks) ? res.tasks : [];
            collected.push(...pageTasks);
            const nextCursor = parseListCursor(res?.nextCursor);
            if (!nextCursor) {
              truncated = false;
              break;
            }
            if (
              cursor &&
              cursor.updatedAt === nextCursor.updatedAt &&
              cursor.id === nextCursor.id
            ) {
              truncated = true;
              break;
            }
            cursor = nextCursor;
            if (page === MAX_ACTIVE_PAGES - 1) {
              truncated = true;
            }
          }
          return { tasks: collected, truncated };
        };

        const historyPromise = fn({
          action: 'list',
          status: 'done',
          limit: HISTORY_DONE_LIMIT,
        });

        const [activeResult, doneRes] = await Promise.all([
          fetchAllActivePages(),
          historyPromise,
        ]);

        if (!isCurrentScope(scopeAtStart, epochAtStart)) {
          return EMPTY_TASKS;
        }

        const doneTasks: GlobalTask[] = Array.isArray(doneRes?.tasks) ? doneRes.tasks : [];
        const historyTruncated =
          doneRes && typeof doneRes === 'object' && 'nextCursor' in doneRes
            ? Boolean((doneRes as { nextCursor?: unknown }).nextCursor)
            : doneTasks.length >= HISTORY_DONE_LIMIT;

        if (mutationSeqRef.current !== seqAtStart) {
          return tasksRef.current;
        }

        const buildMergedTasks = (baseTasks: GlobalTask[]): GlobalTask[] => {
          const byId = new Map<string, GlobalTask>();
          const mergeIncoming = (incoming: GlobalTask) => {
            if (!incoming || !incoming.id) return;
            const deletedSeq = deletedAtSeqRef.current.get(incoming.id);
            if (deletedSeq !== undefined && seqAtStart <= deletedSeq) return;
            byId.set(incoming.id, pickNewerTask(byId.get(incoming.id), incoming));
          };

          for (const task of activeResult.tasks) mergeIncoming(task);
          for (const task of doneTasks) mergeIncoming(task);

          // 保留先前同一 scope 内已经出现更高 revision 的本地更新，避免较旧快照回写
          for (const existing of baseTasks) {
            const listed = byId.get(existing.id);
            if (listed) {
              byId.set(existing.id, pickNewerTask(existing, listed));
            }
          }

          // 已通过 getTask 独立拉取的历史/超页任务，不能被后续 list(done=200) 刷掉
          for (const [pinnedId, pinnedTask] of pinnedByGetRef.current.entries()) {
            const deletedSeq = deletedAtSeqRef.current.get(pinnedId);
            if (deletedSeq !== undefined && seqAtStart <= deletedSeq) continue;
            const merged = pickNewerTask(byId.get(pinnedId), pinnedTask);
            byId.set(pinnedId, merged);
            pinnedByGetRef.current.set(pinnedId, merged);
          }

          return sortTasksDesc([...byId.values()]);
        };

        const returnedTasks = buildMergedTasks(tasksRef.current);
        setScopedState(prev => {
          if (prev.scopeKey !== scopeAtStart || !isCurrentScope(scopeAtStart, epochAtStart)) {
            return prev;
          }
          return {
            scopeKey: scopeAtStart,
            tasks: buildMergedTasks(prev.tasks),
            loading: prev.loading,
            loaded: true,
            error: null,
            activeTruncated: activeResult.truncated,
            historyTruncated,
          };
        });
        return returnedTasks;
      } catch (err) {
        if (isCurrentScope(scopeAtStart, epochAtStart) && mutationSeqRef.current === seqAtStart) {
          setScopedState(prev =>
            prev.scopeKey === scopeAtStart ? { ...prev, error: errorMessageOf(err) } : prev,
          );
        }
        return tasksRef.current;
      } finally {
        settled = true;
        if (flightEntry && inFlightRefreshRef.current === flightEntry) {
          inFlightRefreshRef.current = null;
        }
        if (isCurrentScope(scopeAtStart, epochAtStart)) {
          setScopedState(prev =>
            prev.scopeKey === scopeAtStart ? { ...prev, loading: false } : prev,
          );
        }
      }
    })();

    if (!settled) {
      flightEntry = { scopeKey: scopeAtStart, epoch: epochAtStart, promise };
      inFlightRefreshRef.current = flightEntry;
    }
    return promise;
  }, [effectiveScopeKey, isCurrentScope]);

  const getTask = useCallback(
    async (taskId: string): Promise<GlobalTask | null> => {
      const fn = transportRef.current;
      if (!fn) {
        throw new Error('当前未连接中心服务，无法加载任务详情');
      }
      const scopeAtStart = effectiveScopeKey;
      const epochAtStart = scopeEpochRef.current;
      const seqAtStart = mutationSeqRef.current;
      try {
        const res = await fn({ action: 'get', taskId });
        if (!isCurrentScope(scopeAtStart, epochAtStart)) {
          return null;
        }
        const task = res?.task as GlobalTask | undefined;
        if (!task || !task.id) {
          throw new Error('任务响应缺少有效的任务数据');
        }
        const deletedSeq = deletedAtSeqRef.current.get(task.id);
        if (deletedSeq !== undefined && seqAtStart <= deletedSeq) {
          return null;
        }
        const winner = pickNewerTask(pinnedByGetRef.current.get(task.id), task);
        pinnedByGetRef.current.set(task.id, winner);
        setScopedState(prev => {
          if (prev.scopeKey !== scopeAtStart || !isCurrentScope(scopeAtStart, epochAtStart)) {
            return prev;
          }
          return {
            ...prev,
            tasks: upsertTaskList(prev.tasks, winner),
          };
        });
        return winner;
      } catch (err) {
        if (isTaskNotFoundError(err)) {
          if (isCurrentScope(scopeAtStart, epochAtStart)) {
            pinnedByGetRef.current.delete(taskId);
            setScopedState(prev => {
              if (prev.scopeKey !== scopeAtStart) return prev;
              if (!prev.tasks.some(item => item.id === taskId)) return prev;
              return {
                ...prev,
                tasks: prev.tasks.filter(item => item.id !== taskId),
              };
            });
          }
          return null;
        }
        throw err;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveScopeKey, hasTransport, isCurrentScope],
  );

  useEffect(() => {
    if (!enabled || !transport || !visible) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = Math.max(1000, pollIntervalMs);

    const loop = async () => {
      await refresh();
      if (!disposed) {
        timer = setTimeout(() => {
          void loop();
        }, interval);
      }
    };

    void loop();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, transport, visible, pollIntervalMs, refresh]);

  const runTaskAction = useCallback(
    async (
      input: Record<string, unknown>,
      scopeAtStart = effectiveScopeKey,
      epochAtStart = scopeEpochRef.current,
    ): Promise<GlobalTask> => {
      const fn = transportRef.current;
      if (!fn) {
        throw new Error('当前未连接中心服务，无法同步任务');
      }
      if (!isCurrentScope(scopeAtStart, epochAtStart)) {
        throw new Error('当前任务上下文已切换，请重试');
      }
      const mySeq = (mutationSeqRef.current += 1);
      const res = await fn(input);
      const task = res?.task as GlobalTask | undefined;
      if (!task || !task.id) {
        throw new Error('任务响应缺少有效的任务数据');
      }
      if (!isCurrentScope(scopeAtStart, epochAtStart)) {
        return task;
      }
      const deletedSeq = deletedAtSeqRef.current.get(task.id);
      if (deletedSeq !== undefined && mySeq <= deletedSeq) {
        return task;
      }
      if (pinnedByGetRef.current.has(task.id)) {
        pinnedByGetRef.current.set(
          task.id,
          pickNewerTask(pinnedByGetRef.current.get(task.id), task),
        );
      }
      setScopedState(prev => {
        if (prev.scopeKey !== scopeAtStart) return prev;
        return {
          ...prev,
          tasks: upsertTaskList(prev.tasks, task),
          loaded: true,
          error: null,
        };
      });
      return task;
    },
    [effectiveScopeKey, isCurrentScope],
  );

  const resolveExpectedRevision = useCallback(
    async (
      taskId: string,
      explicitRevision: number | undefined,
      scopeAtStart: string,
      epochAtStart: number,
    ): Promise<number> => {
      if (typeof explicitRevision === 'number' && Number.isFinite(explicitRevision)) {
        return explicitRevision;
      }
      const cached =
        tasksRef.current.find(item => item.id === taskId) ?? pinnedByGetRef.current.get(taskId);
      if (cached) {
        return cached.revision;
      }
      const fetched = await getTask(taskId);
      if (!isCurrentScope(scopeAtStart, epochAtStart)) {
        throw new Error('当前任务上下文已切换，请重试');
      }
      if (!fetched) {
        throw new Error('任务不存在或已删除');
      }
      return fetched.revision;
    },
    [getTask, isCurrentScope],
  );

  const createTask = useCallback(
    async (input: { text: string; title?: string }): Promise<GlobalTask> => {
      const scopeAtStart = effectiveScopeKey;
      const epochAtStart = scopeEpochRef.current;
      const draftKeyAtStart = draftStorageKeyRef.current;
      const text = input.text.trim();
      const title = input.title?.trim();
      const task = await runTaskAction(
        {
          action: 'create',
          text,
          ...(title ? { title } : {}),
          origin: { kind: 'ui', label: '' },
        },
        scopeAtStart,
        epochAtStart,
      );
      if (isCurrentScope(scopeAtStart, epochAtStart)) {
        writeDraftStorage(draftKeyAtStart, '');
        if (draftStorageKeyRef.current === draftKeyAtStart) {
          setDraftState({
            scopeKey: scopeAtStart,
            storageKey: draftKeyAtStart,
            value: '',
            showSaved: false,
          });
        }
      }
      return task;
    },
    [effectiveScopeKey, isCurrentScope, runTaskAction],
  );

  const updateTask = useCallback(
    (input: Record<string, unknown> & { taskId: string }) =>
      runTaskAction({ ...input, action: 'update' }),
    [runTaskAction],
  );

  const confirmPlan = useCallback(
    async (taskId: string, expectedRevision?: number): Promise<GlobalTask> => {
      const scopeAtStart = effectiveScopeKey;
      const epochAtStart = scopeEpochRef.current;
      const rev = await resolveExpectedRevision(
        taskId,
        expectedRevision,
        scopeAtStart,
        epochAtStart,
      );
      return runTaskAction(
        { action: 'confirm_plan', taskId, expectedRevision: rev },
        scopeAtStart,
        epochAtStart,
      );
    },
    [effectiveScopeKey, resolveExpectedRevision, runTaskAction],
  );

  const answerPrompt = useCallback(
    async (taskId: string, answer: string, expectedRevision?: number): Promise<GlobalTask> => {
      const scopeAtStart = effectiveScopeKey;
      const epochAtStart = scopeEpochRef.current;
      const rev = await resolveExpectedRevision(
        taskId,
        expectedRevision,
        scopeAtStart,
        epochAtStart,
      );
      return runTaskAction(
        { action: 'answer_prompt', taskId, answer, expectedRevision: rev },
        scopeAtStart,
        epochAtStart,
      );
    },
    [effectiveScopeKey, resolveExpectedRevision, runTaskAction],
  );

  const resolveAdoptionScope = useCallback(
    async (
      taskId: string,
      scope: 'keep' | 'redo',
      expectedRevision?: number,
    ): Promise<GlobalTask> => {
      const scopeAtStart = effectiveScopeKey;
      const epochAtStart = scopeEpochRef.current;
      const rev = await resolveExpectedRevision(
        taskId,
        expectedRevision,
        scopeAtStart,
        epochAtStart,
      );
      return runTaskAction(
        { action: 'resolve_adoption_scope', taskId, scope, expectedRevision: rev },
        scopeAtStart,
        epochAtStart,
      );
    },
    [effectiveScopeKey, resolveExpectedRevision, runTaskAction],
  );

  const dismissAdoption = useCallback(
    (taskId: string) => runTaskAction({ action: 'dismiss_adoption', taskId }),
    [runTaskAction],
  );

  const deleteTask = useCallback(
    async (taskId: string): Promise<void> => {
      const fn = transportRef.current;
      if (!fn) {
        throw new Error('当前未连接中心服务，无法删除任务');
      }
      const scopeAtStart = effectiveScopeKey;
      const epochAtStart = scopeEpochRef.current;
      const mySeq = (mutationSeqRef.current += 1);
      await fn({ action: 'delete', taskId });
      if (!isCurrentScope(scopeAtStart, epochAtStart)) {
        return;
      }
      deletedAtSeqRef.current.set(taskId, mySeq);
      pinnedByGetRef.current.delete(taskId);
      setScopedState(prev =>
        prev.scopeKey === scopeAtStart
          ? {
              ...prev,
              tasks: prev.tasks.filter(item => item.id !== taskId),
              error: null,
            }
          : prev,
      );
    },
    [effectiveScopeKey, isCurrentScope],
  );

  const waitingCount = useMemo(() => countWaitingTasks(exposedTasks), [exposedTasks]);

  return useMemo(
    () => ({
      tasks: exposedTasks,
      loading: exposedLoading,
      loaded: exposedLoaded,
      error: exposedError,
      waitingCount,
      activeTruncated: exposedActiveTruncated,
      historyTruncated: exposedHistoryTruncated,
      createDraft: exposedCreateDraft,
      setCreateDraft,
      showDraftSaved: exposedShowDraftSaved,
      markDraftLeftUnpublished,
      refresh,
      getTask,
      createTask,
      updateTask,
      confirmPlan,
      answerPrompt,
      resolveAdoptionScope,
      dismissAdoption,
      deleteTask,
    }),
    [
      exposedTasks,
      exposedLoading,
      exposedLoaded,
      exposedError,
      waitingCount,
      exposedActiveTruncated,
      exposedHistoryTruncated,
      exposedCreateDraft,
      setCreateDraft,
      exposedShowDraftSaved,
      markDraftLeftUnpublished,
      refresh,
      getTask,
      createTask,
      updateTask,
      confirmPlan,
      answerPrompt,
      resolveAdoptionScope,
      dismissAdoption,
      deleteTask,
    ],
  );
}
