// 共享客户端更新 provider：连接后检查、24h 定时复查，旧中心与旧操作结果不覆盖当前状态。
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
  CLIENT_UPDATE_POLL_MS,
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
  children: ReactNode;
}) {
  const { request, ready, centerKey } = props;
  const [status, setStatus] = useState<ClientUpdateStatus | undefined>(undefined);
  const [pending, setPending] = useState<ClientUpdateOp | null>(null);
  const [actionError, setActionError] = useState('');
  const epochRef = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const connectedRef = useRef(false);
  connectedRef.current = ready && Boolean(centerKey);
  const autoAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const opSequence = useRef(0);
  const opInFlight = useRef<{ id: number; op: ClientUpdateOp } | null>(null);
  const statusRevision = useRef(0);
  const pollSequence = useRef(0);
  const appliedPoll = useRef(0);
  const lastPolledOp = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!connectedRef.current) return;
    const epoch = epochRef.current;
    const revision = statusRevision.current;
    const poll = ++pollSequence.current;
    try {
      const next = await requestRef.current('status');
      if (epoch !== epochRef.current || revision !== statusRevision.current || poll < appliedPoll.current) return;
      const active = opInFlight.current;
      // 操作刚发出时原生状态可能仍是上一次的稳定态。
      if (active?.op === 'check' && next.phase !== 'checking') return;
      if (active?.op === 'download' && ['idle', 'checking', 'available', 'up-to-date'].includes(next.phase)) return;
      appliedPoll.current = poll;
      if (active) lastPolledOp.current = active.id;
      setStatus(next);
    } catch (error) {
      if (epoch === epochRef.current && revision === statusRevision.current && poll >= appliedPoll.current) {
        setActionError(errorMessage(error));
      }
    }
  }, []);

  const runOp = useCallback(
    async (op: Exclude<ClientUpdateOp, 'status'>, params?: ClientUpdateParams, automatic = false): Promise<void> => {
      if (!connectedRef.current) return;
      const active = opInFlight.current;
      if (active && !(op === 'cancel' && (active.op === 'download' || active.op === 'check'))) return;
      const id = ++opSequence.current;
      const epoch = epochRef.current;
      opInFlight.current = { id, op };
      statusRevision.current += 1;
      setPending(op);
      if (!automatic) setActionError('');
      if (op === 'check' && !automatic) {
        setStatus(prev => prev && !CLIENT_UPDATE_LIVE_PHASES.has(prev.phase) ? { ...prev, phase: 'checking' } : prev);
      }
      try {
        const next = await requestRef.current(op, params);
        if (epoch === epochRef.current && opInFlight.current?.id === id) {
          statusRevision.current += 1;
          if (lastPolledOp.current !== id || (op !== 'check' && op !== 'download') || (next.phase !== 'checking' && next.phase !== 'downloading')) {
            setStatus(next);
          }
        }
      } catch (error) {
        if (epoch === epochRef.current && opInFlight.current?.id === id) {
          statusRevision.current += 1;
          if (!automatic) {
            setActionError(errorMessage(error));
            void refresh();
          }
        }
      } finally {
        if (epoch === epochRef.current && opInFlight.current?.id === id) {
          opInFlight.current = null;
          setPending(null);
        }
      }
    },
    [refresh],
  );

  const check = useCallback(() => void runOp('check', { automatic: false }), [runOp]);
  const download = useCallback(() => void runOp('download'), [runOp]);
  const install = useCallback((stopActive: boolean) => void runOp('install', { stopActive }), [runOp]);
  const cancel = useCallback(() => void runOp('cancel'), [runOp]);

  useEffect(() => {
    epochRef.current += 1;
    opInFlight.current = null;
    statusRevision.current += 1;
    setStatus(undefined);
    setPending(null);
    setActionError('');
    autoAtRef.current = 0;
    if (!ready || !centerKey) return;
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
    return () => {
      epochRef.current += 1;
      opInFlight.current = null;
      statusRevision.current += 1;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [ready, centerKey, runOp]);

  const live = (status !== undefined && CLIENT_UPDATE_LIVE_PHASES.has(status.phase)) || pending === 'check' || pending === 'download';
  useEffect(() => {
    if (!live || !ready) return;
    const timer = setInterval(() => void refresh(), CLIENT_UPDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, ready, refresh]);

  const value = useMemo<ClientUpdateContextValue>(
    () => ({
      status,
      pending,
      ready: ready && Boolean(centerKey),
      actionError,
      dismissError: () => setActionError(''),
      check,
      download,
      install,
      cancel,
    }),
    [status, pending, ready, centerKey, actionError, check, download, install, cancel],
  );

  return <ClientUpdateContext.Provider value={value}>{props.children}</ClientUpdateContext.Provider>;
}
