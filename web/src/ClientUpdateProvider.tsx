// 共享客户端更新 provider：统一编排桌面与 Android 全生命周期自动检查、原生推送与零闪烁状态同步。
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  CLIENT_UPDATE_LIVE_PHASES,
  CLIENT_UPDATE_POLL_MS,
  createClientUpdateController,
  type ClientUpdateCheckReason,
  type ClientUpdateController,
  type ClientUpdateOp,
  type ClientUpdateRequest,
  type ClientUpdateSnapshot,
  type ClientUpdateStatus,
} from './ClientUpdate';

export interface ClientUpdateContextValue {
  status: ClientUpdateStatus | undefined;
  pending: ClientUpdateOp | null;
  ready: boolean;
  centerKey: string;
  actionError: string;
  lastCheckedAt: number | null;
  dismissError(): void;
  check(): void;
  triggerAutoCheck(reason: ClientUpdateCheckReason): void;
  download(): void;
  install(stopActive: boolean): void;
  cancel(): void;
}

const ClientUpdateContext = createContext<ClientUpdateContextValue | null>(null);

export function useClientUpdate(): ClientUpdateContextValue | null {
  return useContext(ClientUpdateContext);
}

export function ClientUpdateProvider(props: {
  request: ClientUpdateRequest;
  ready: boolean;
  centerKey: string;
  nativeCheck?: boolean;
  children: ReactNode;
}) {
  const { request, ready, centerKey, nativeCheck = false } = props;
  const requestRef = useRef(request);
  requestRef.current = request;

  const controllerRef = useRef<ClientUpdateController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createClientUpdateController({
      request: (op, params) => requestRef.current(op, params),
    });
  }
  const controller = controllerRef.current;

  const [snapshot, setSnapshot] = useState<ClientUpdateSnapshot>(() => controller.getSnapshot());

  useEffect(() => {
    setSnapshot(controller.getSnapshot());
    return controller.subscribe(setSnapshot);
  }, [controller]);

  useEffect(() => {
    controller.start({ ready, centerKey, nativeCheck });
    return () => controller.stop();
  }, [ready, centerKey, nativeCheck, controller]);

  const { status, pending, actionError, lastCheckedAt } = snapshot;
  const live =
    (status !== undefined && CLIENT_UPDATE_LIVE_PHASES.has(status.phase)) ||
    pending === 'check' ||
    pending === 'download' ||
    pending === 'install';
  useEffect(() => {
    if (!live || !ready) return;
    const timer = setInterval(() => void controller.refresh(true, false), CLIENT_UPDATE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, ready, controller]);

  const value = useMemo<ClientUpdateContextValue>(
    () => ({
      status,
      pending,
      ready: ready && Boolean(centerKey),
      centerKey,
      actionError,
      lastCheckedAt,
      dismissError: controller.dismissError,
      check: controller.check,
      triggerAutoCheck: controller.triggerAutoCheck,
      download: controller.download,
      install: controller.install,
      cancel: controller.cancel,
    }),
    [status, pending, ready, centerKey, actionError, lastCheckedAt, controller],
  );

  return <ClientUpdateContext.Provider value={value}>{props.children}</ClientUpdateContext.Provider>;
}
