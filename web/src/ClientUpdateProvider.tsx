// 共享客户端更新 provider：桌面定时检查，Android 读取原生后台检查结果。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CLIENT_UPDATE_AUTO_INTERVAL_MS,
  CLIENT_UPDATE_LIVE_PHASES,
  CLIENT_UPDATE_OPEN_EVENT,
  CLIENT_UPDATE_POLL_MS,
  CLIENT_UPDATE_STATUS_EVENT,
  computeMinCheckDelayMs,
  createOptimisticCheckingStatus,
  extractClientUpdateEventStatus,
  isCheckSettledPhase,
  resolveAutoInstallAction,
  shouldCommitOpResult,
  type ClientUpdateOp,
  type ClientUpdateParams,
  type ClientUpdateRequest,
  type ClientUpdateStatus,
} from './ClientUpdate';

export interface ClientUpdateContextValue {
  status: ClientUpdateStatus | undefined;
  pending: ClientUpdateOp | null;
  ready: boolean;
  actionError: string;
  lastCheckedAt: number | null;
  dismissError(): void;
  check(): void;
  download(): void;
  install(stopActive: boolean): void;
  cancel(): void;
}

const ClientUpdateContext = createContext<ClientUpdateContextValue | null>(null);

export function useClientUpdate(): ClientUpdateContextValue | null {
  return useContext(ClientUpdateContext);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function ClientUpdateProvider(props: {
  request: ClientUpdateRequest;
  ready: boolean;
  centerKey: string;
  nativeCheck?: boolean;
  children: ReactNode;
}) {
  const { request, ready, centerKey, nativeCheck = false } = props;
  const [status, setStatus] = useState<ClientUpdateStatus | undefined>(undefined);
  const [pending, setPending] = useState<ClientUpdateOp | null>(null);
  const [actionError, setActionError] = useState('');
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const epochRef = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const connectedRef = useRef(false);
  connectedRef.current = ready && Boolean(centerKey);
  const autoAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opSequence = useRef(0);
  const opInFlight = useRef<{ id: number; op: ClientUpdateOp } | null>(null);
  const autoInstallRef = useRef(false);
  const runOpRef = useRef<(op: Exclude<ClientUpdateOp, 'status'>, params?: ClientUpdateParams, automatic?: boolean) => Promise<void>>(
    async () => {},
  );
  const refreshRef = useRef<(reportError?: boolean, fromPush?: boolean) => Promise<void>>(async () => {});
  const statusRef = useRef<ClientUpdateStatus | undefined>(undefined);
  const statusRevision = useRef(0);
  const pollSequence = useRef(0);
  const appliedPoll = useRef(0);
  const lastPolledOp = useRef(0);
  const activeRefreshIdRef = useRef<number | null>(null);
  const refreshQueuedRef = useRef<{ reportError: boolean; fromPush: boolean } | null>(null);
  const manualCheckStartedAtRef = useRef<number | null>(null);
  const awaitingCheckSettleRef = useRef(false);
  const pushDuringActiveOpRef = useRef(false);
  const settleHandleRef = useRef<{ timer: ReturnType<typeof setTimeout>; cancel(): void } | null>(null);

  const clearSettleTimer = useCallback(() => {
    const handle = settleHandleRef.current;
    if (!handle) return;
    settleHandleRef.current = null;
    clearTimeout(handle.timer);
    handle.cancel();
  }, []);

  const waitMinCheckDelay = useCallback(
    (delayMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        clearSettleTimer();
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (settleHandleRef.current?.timer === timer) {
            settleHandleRef.current = null;
          }
          resolve(true);
        }, delayMs);
        settleHandleRef.current = {
          timer,
          cancel: () => {
            if (settled) return;
            settled = true;
            resolve(false);
          },
        };
      }),
    [clearSettleTimer],
  );

  const commitObservedNow = useCallback((next: ClientUpdateStatus, fromPush: boolean) => {
    const active = opInFlight.current;
    const wasChecking = awaitingCheckSettleRef.current || statusRef.current?.phase === 'checking';
    if (next.phase === 'checking') {
      awaitingCheckSettleRef.current = true;
    } else {
      manualCheckStartedAtRef.current = null;
      awaitingCheckSettleRef.current = false;
    }
    statusRef.current = next;
    setStatus(next);
    if (isCheckSettledPhase(next.phase) && (wasChecking || fromPush)) {
      setLastCheckedAt(Date.now());
    }
    // 异步下载平台（如 Android）由轮询/事件观测到 downloaded 后自动衔接安装。
    if (!active) {
      const action = resolveAutoInstallAction(autoInstallRef.current, next.phase);
      if (action === 'install') {
        autoInstallRef.current = false;
        void runOpRef.current('install', { stopActive: false });
      } else if (action === 'clear') {
        autoInstallRef.current = false;
      }
    }
  }, []);

  const applyObservedStatus = useCallback(
    (
      next: ClientUpdateStatus,
      meta: { epoch: number; revision: number; poll: number; fromPush: boolean },
    ) => {
      const { epoch, revision, poll, fromPush } = meta;
      if (!connectedRef.current) return;
      if (epoch !== epochRef.current || revision !== statusRevision.current || poll < appliedPoll.current) return;
      const active = opInFlight.current;
      // 操作刚发出时原生状态可能仍是上一次的稳定态。
      if (active?.op === 'check' && next.phase !== 'checking') {
        if (fromPush) pushDuringActiveOpRef.current = true;
        return;
      }
      if (active?.op === 'download' && ['idle', 'checking', 'available', 'up-to-date'].includes(next.phase)) {
        if (fromPush) pushDuringActiveOpRef.current = true;
        return;
      }
      if (active?.op === 'install' && next.phase === 'downloaded') return;
      appliedPoll.current = poll;
      if (active) lastPolledOp.current = active.id;

      if (!active) {
        const delayMs = computeMinCheckDelayMs(manualCheckStartedAtRef.current, Date.now(), next.phase);
        if (delayMs > 0) {
          if (!statusRef.current) {
            const checkingStatus: ClientUpdateStatus = {
              phase: 'checking',
              currentVersion: next.currentVersion,
            };
            statusRef.current = checkingStatus;
            setStatus(checkingStatus);
          }
          void waitMinCheckDelay(delayMs).then((completed) => {
            if (!completed) return;
            if (
              !connectedRef.current ||
              epoch !== epochRef.current ||
              revision !== statusRevision.current ||
              poll < appliedPoll.current ||
              opInFlight.current !== null
            ) {
              return;
            }
            commitObservedNow(next, fromPush);
          });
          return;
        }
        clearSettleTimer();
      }

      commitObservedNow(next, fromPush);
    },
    [clearSettleTimer, commitObservedNow, waitMinCheckDelay],
  );

  const refresh = useCallback(async (reportError = true, fromPush = false): Promise<void> => {
    if (!connectedRef.current) return;
    if (activeRefreshIdRef.current !== null) {
      const prev = refreshQueuedRef.current;
      refreshQueuedRef.current = {
        reportError: Boolean(prev?.reportError || reportError),
        fromPush: Boolean(prev?.fromPush || fromPush),
      };
      return;
    }
    const epoch = epochRef.current;
    const revision = statusRevision.current;
    const poll = ++pollSequence.current;
    activeRefreshIdRef.current = poll;
    try {
      const next = await requestRef.current('status');
      applyObservedStatus(next, { epoch, revision, poll, fromPush });
    } catch (error) {
      if (reportError && epoch === epochRef.current && revision === statusRevision.current && poll >= appliedPoll.current) {
        setActionError(errorMessage(error));
      }
    } finally {
      if (activeRefreshIdRef.current === poll) {
        activeRefreshIdRef.current = null;
        const queued = refreshQueuedRef.current;
        if (queued) {
          refreshQueuedRef.current = null;
          if (connectedRef.current && epoch === epochRef.current) {
            void refreshRef.current(queued.reportError, queued.fromPush);
          }
        }
      }
    }
  }, [applyObservedStatus]);
  refreshRef.current = refresh;

  const runOp = useCallback(
    async (op: Exclude<ClientUpdateOp, 'status'>, params?: ClientUpdateParams, automatic = false): Promise<void> => {
      if (!connectedRef.current) return;
      const active = opInFlight.current;
      if (active && !(op === 'cancel' && (active.op === 'download' || active.op === 'check'))) return;
      clearSettleTimer();
      const id = ++opSequence.current;
      const epoch = epochRef.current;
      opInFlight.current = { id, op };
      statusRevision.current += 1;
      if (op === 'check') {
        manualCheckStartedAtRef.current = automatic ? null : Date.now();
        awaitingCheckSettleRef.current = true;
        pushDuringActiveOpRef.current = false;
      } else {
        manualCheckStartedAtRef.current = null;
        awaitingCheckSettleRef.current = false;
        pushDuringActiveOpRef.current = false;
      }
      setPending(op);
      if (!automatic) setActionError('');
      if (op === 'check' && !automatic) {
        const prev = statusRef.current;
        if (prev && !CLIENT_UPDATE_LIVE_PHASES.has(prev.phase)) {
          const optimistic = createOptimisticCheckingStatus(prev);
          statusRef.current = optimistic;
          setStatus(optimistic);
        }
      }
      let shouldFollowUpRefresh = false;
      try {
        const next = await requestRef.current(op, params);
        if (epoch !== epochRef.current || opInFlight.current?.id !== id) return;
        if (op === 'check' && !automatic) {
          const delayMs = computeMinCheckDelayMs(manualCheckStartedAtRef.current, Date.now(), next.phase);
          if (delayMs > 0) {
            const completed = await waitMinCheckDelay(delayMs);
            if (!completed || epoch !== epochRef.current || opInFlight.current?.id !== id) return;
          }
        }
        statusRevision.current += 1;
        const commitResult = shouldCommitOpResult(op, next.phase, lastPolledOp.current === id);
        if (commitResult) {
          statusRef.current = next;
          setStatus(next);
        }
        const effectivePhase = commitResult ? next.phase : (statusRef.current?.phase ?? next.phase);
        if (op === 'check' && effectivePhase !== 'checking') {
          manualCheckStartedAtRef.current = null;
          awaitingCheckSettleRef.current = false;
          if (isCheckSettledPhase(effectivePhase)) {
            setLastCheckedAt(Date.now());
          }
        }
        if (
          pushDuringActiveOpRef.current &&
          (op === 'check' || op === 'download' || op === 'cancel') &&
          (effectivePhase === 'checking' || effectivePhase === 'downloading')
        ) {
          shouldFollowUpRefresh = true;
        }
        pushDuringActiveOpRef.current = false;
        if (op === 'download') {
          const action = resolveAutoInstallAction(autoInstallRef.current, effectivePhase);
          if (action === 'install') {
            autoInstallRef.current = false;
            opInFlight.current = { id, op: 'install' };
            setPending('install');
            const installed = await requestRef.current('install', { stopActive: false });
            if (epoch === epochRef.current && opInFlight.current?.id === id) {
              statusRevision.current += 1;
              statusRef.current = installed;
              setStatus(installed);
            }
          } else if (action === 'clear') {
            autoInstallRef.current = false;
          }
        }
      } catch (error) {
        if (epoch !== epochRef.current || opInFlight.current?.id !== id) return;
        if (op === 'check' && !automatic) {
          const delayMs = computeMinCheckDelayMs(manualCheckStartedAtRef.current, Date.now(), 'error');
          if (delayMs > 0) {
            const completed = await waitMinCheckDelay(delayMs);
            if (!completed || epoch !== epochRef.current || opInFlight.current?.id !== id) return;
          }
        }
        if (op === 'check') {
          manualCheckStartedAtRef.current = null;
          awaitingCheckSettleRef.current = false;
        }
        pushDuringActiveOpRef.current = false;
        if (op === 'download') autoInstallRef.current = false;
        statusRevision.current += 1;
        if (!automatic) {
          setActionError(errorMessage(error));
          void refreshRef.current();
        }
      } finally {
        if (epoch === epochRef.current && opInFlight.current?.id === id) {
          opInFlight.current = null;
          setPending(null);
          if (shouldFollowUpRefresh) {
            void refreshRef.current(false, true);
          }
        }
      }
    },
    [clearSettleTimer, waitMinCheckDelay],
  );
  runOpRef.current = runOp;

  const check = useCallback(() => {
    autoInstallRef.current = false;
    void runOp('check', { automatic: false });
  }, [runOp]);
  const download = useCallback(() => {
    autoInstallRef.current = true;
    void runOp('download');
  }, [runOp]);
  const install = useCallback((stopActive: boolean) => {
    autoInstallRef.current = false;
    void runOp('install', { stopActive });
  }, [runOp]);
  const cancel = useCallback(() => {
    autoInstallRef.current = false;
    void runOp('cancel');
  }, [runOp]);

  useEffect(() => {
    epochRef.current += 1;
    clearSettleTimer();
    opInFlight.current = null;
    autoInstallRef.current = false;
    manualCheckStartedAtRef.current = null;
    awaitingCheckSettleRef.current = false;
    pushDuringActiveOpRef.current = false;
    activeRefreshIdRef.current = null;
    refreshQueuedRef.current = null;
    statusRevision.current += 1;
    statusRef.current = undefined;
    setStatus(undefined);
    setPending(null);
    setActionError('');
    setLastCheckedAt(null);
    autoAtRef.current = 0;
    if (!ready || !centerKey) return;

    const handleStatusEvent = (event: Event) => {
      if (!connectedRef.current) return;
      const pushed = extractClientUpdateEventStatus(event);
      if (pushed) {
        applyObservedStatus(pushed, {
          epoch: epochRef.current,
          revision: statusRevision.current,
          poll: ++pollSequence.current,
          fromPush: true,
        });
        return;
      }
      if (!document.hidden) {
        const active = opInFlight.current;
        if (active && (active.op === 'check' || active.op === 'download' || active.op === 'cancel')) {
          pushDuringActiveOpRef.current = true;
        }
        void refresh(false, true);
      }
    };
    window.addEventListener(CLIENT_UPDATE_STATUS_EVENT, handleStatusEvent);

    const syncNative = () => { if (!document.hidden) void refresh(false, false); };
    if (nativeCheck) {
      window.addEventListener(CLIENT_UPDATE_OPEN_EVENT, syncNative);
      document.addEventListener('visibilitychange', syncNative);
      syncNative();
    } else {
      autoAtRef.current = Date.now();
      void runOp('check', { automatic: true }, true);
      const tick = () => {
        if (!opInFlight.current && Date.now() - autoAtRef.current >= CLIENT_UPDATE_AUTO_INTERVAL_MS) {
          autoAtRef.current = Date.now();
          void runOp('check', { automatic: true }, true);
        }
        timerRef.current = setTimeout(tick, 60_000);
      };
      timerRef.current = setTimeout(tick, 60_000);
    }
    return () => {
      epochRef.current += 1;
      clearSettleTimer();
      opInFlight.current = null;
      autoInstallRef.current = false;
      manualCheckStartedAtRef.current = null;
      awaitingCheckSettleRef.current = false;
      pushDuringActiveOpRef.current = false;
      activeRefreshIdRef.current = null;
      refreshQueuedRef.current = null;
      statusRevision.current += 1;
      statusRef.current = undefined;
      window.removeEventListener(CLIENT_UPDATE_STATUS_EVENT, handleStatusEvent);
      if (nativeCheck) {
        window.removeEventListener(CLIENT_UPDATE_OPEN_EVENT, syncNative);
        document.removeEventListener('visibilitychange', syncNative);
      }
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [ready, centerKey, nativeCheck, applyObservedStatus, clearSettleTimer, refresh, runOp]);

  const live =
    (status !== undefined && CLIENT_UPDATE_LIVE_PHASES.has(status.phase)) ||
    pending === 'check' ||
    pending === 'download' ||
    pending === 'install';
  useEffect(() => {
    if (!live || !ready) return;
    const timer = setInterval(() => void refresh(true, false), CLIENT_UPDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, ready, refresh]);

  const value = useMemo<ClientUpdateContextValue>(
    () => ({
      status,
      pending,
      ready: ready && Boolean(centerKey),
      actionError,
      lastCheckedAt,
      dismissError: () => setActionError(''),
      check,
      download,
      install,
      cancel,
    }),
    [status, pending, ready, centerKey, actionError, lastCheckedAt, check, download, install, cancel],
  );

  return <ClientUpdateContext.Provider value={value}>{props.children}</ClientUpdateContext.Provider>;
}
