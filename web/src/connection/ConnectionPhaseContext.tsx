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
  createConnectionPhaseState,
  deriveConnectionPhase,
  stepConnectionPhaseState,
  type ConnectionPhase,
  type ConnectionPhaseHysteresisOptions,
  type ConnectionPhaseInput,
  type ConnectionPhaseState,
} from './connectionPhase';

export interface ConnectionPhaseContextValue {
  phase: ConnectionPhase;
  rawPhase: ConnectionPhase;
  ipcReconnecting: boolean;
  centerReconnecting: boolean;
  centerConnecting: boolean;
  centerReady: boolean;
  centerError: string | null;
  detail?: string | null;
  onOpenSettings?: () => void;
}

const defaultConnectionPhaseContext: ConnectionPhaseContextValue = {
  phase: 'online',
  rawPhase: 'online',
  ipcReconnecting: false,
  centerReconnecting: false,
  centerConnecting: false,
  centerReady: false,
  centerError: null,
  detail: null,
};

export const ConnectionPhaseContext = createContext<ConnectionPhaseContextValue>(
  defaultConnectionPhaseContext,
);

export function useConnectionPhaseContext(): ConnectionPhaseContextValue {
  return useContext(ConnectionPhaseContext);
}

interface NormalizedInputSnapshot {
  ipcReconnecting: boolean | undefined;
  centerReconnecting: boolean | undefined;
  remoteConnected: boolean | undefined;
  hasCachedRemoteBots: boolean | undefined;
  centerConnecting: boolean | undefined;
  centerReady: boolean | undefined;
  centerError: string | null | undefined;
  hasConfiguredCenter: boolean | undefined;
  enterDelayMs: number | undefined;
  minVisibleMs: number | undefined;
}

function isSameSnapshot(a: NormalizedInputSnapshot, b: NormalizedInputSnapshot): boolean {
  return (
    a.ipcReconnecting === b.ipcReconnecting &&
    a.centerReconnecting === b.centerReconnecting &&
    a.remoteConnected === b.remoteConnected &&
    a.hasCachedRemoteBots === b.hasCachedRemoteBots &&
    a.centerConnecting === b.centerConnecting &&
    a.centerReady === b.centerReady &&
    a.centerError === b.centerError &&
    a.hasConfiguredCenter === b.hasConfiguredCenter &&
    a.enterDelayMs === b.enterDelayMs &&
    a.minVisibleMs === b.minVisibleMs
  );
}

function isSamePhaseState(a: ConnectionPhaseState, b: ConnectionPhaseState): boolean {
  return (
    a.phase === b.phase &&
    a.rawPhase === b.rawPhase &&
    a.visibleSinceMs === b.visibleSinceMs &&
    a.nonOnlineSinceMs === b.nonOnlineSinceMs &&
    a.nextTransitionInMs === b.nextTransitionInMs
  );
}

/**
 * React hook wrapping the pure connection-phase hysteresis state machine.
 * Schedules at most one timeout for the next pending hysteresis transition.
 */
export function useConnectionPhase(
  input: ConnectionPhaseInput,
  options?: ConnectionPhaseHysteresisOptions,
): ConnectionPhase {
  const {
    ipcReconnecting,
    centerReconnecting,
    remoteConnected,
    hasCachedRemoteBots,
    centerConnecting,
    centerReady,
    centerError,
    hasConfiguredCenter,
  } = input;
  const enterDelayMs = options?.enterDelayMs;
  const minVisibleMs = options?.minVisibleMs;

  const currentSnapshot: NormalizedInputSnapshot = {
    ipcReconnecting,
    centerReconnecting,
    remoteConnected,
    hasCachedRemoteBots,
    centerConnecting,
    centerReady,
    centerError,
    hasConfiguredCenter,
    enterDelayMs,
    minVisibleMs,
  };

  const currentInput: ConnectionPhaseInput = {
    ipcReconnecting,
    centerReconnecting,
    remoteConnected,
    hasCachedRemoteBots,
    centerConnecting,
    centerReady,
    centerError,
    hasConfiguredCenter,
  };

  const [machine, setMachine] = useState<ConnectionPhaseState>(() =>
    createConnectionPhaseState(currentInput, Date.now(), { enterDelayMs, minVisibleMs }),
  );

  const latestInputRef = useRef<ConnectionPhaseInput>(currentInput);
  latestInputRef.current = currentInput;

  const latestOptionsRef = useRef<ConnectionPhaseHysteresisOptions>({ enterDelayMs, minVisibleMs });
  latestOptionsRef.current = { enterDelayMs, minVisibleMs };

  const lastSteppedSnapshotRef = useRef<NormalizedInputSnapshot>(currentSnapshot);

  useEffect(() => {
    const nextSnapshot: NormalizedInputSnapshot = {
      ipcReconnecting,
      centerReconnecting,
      remoteConnected,
      hasCachedRemoteBots,
      centerConnecting,
      centerReady,
      centerError,
      hasConfiguredCenter,
      enterDelayMs,
      minVisibleMs,
    };
    if (isSameSnapshot(lastSteppedSnapshotRef.current, nextSnapshot)) {
      return;
    }
    lastSteppedSnapshotRef.current = nextSnapshot;
    setMachine(prev => {
      const next = stepConnectionPhaseState(
        prev,
        latestInputRef.current,
        Date.now(),
        latestOptionsRef.current,
      ).state;
      return isSamePhaseState(prev, next) ? prev : next;
    });
  }, [
    ipcReconnecting,
    centerReconnecting,
    remoteConnected,
    hasCachedRemoteBots,
    centerConnecting,
    centerReady,
    centerError,
    hasConfiguredCenter,
    enterDelayMs,
    minVisibleMs,
  ]);

  useEffect(() => {
    const delay = machine.nextTransitionInMs;
    if (delay === null) return;
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      setMachine(prev => {
        const next = stepConnectionPhaseState(
          prev,
          latestInputRef.current,
          Date.now(),
          latestOptionsRef.current,
        ).state;
        // If another transition is still pending (e.g. timer woke 1ms early due to clock jitter),
        // return the fresh object so this effect reschedules rather than stalling.
        if (next.nextTransitionInMs !== null) return next;
        return isSamePhaseState(prev, next) ? prev : next;
      });
    }, Math.max(1, delay));
    return () => {
      clearTimeout(timer);
    };
  }, [machine]);

  return machine.phase;
}

export interface ConnectionPhaseProviderInputProps extends ConnectionPhaseInput {
  value?: undefined;
  detail?: string | null;
  onOpenSettings?: () => void;
  options?: ConnectionPhaseHysteresisOptions;
  children: ReactNode;
}

export interface ConnectionPhaseProviderValueProps {
  value: ConnectionPhaseContextValue;
  children: ReactNode;
}

export type ConnectionPhaseProviderProps =
  | ConnectionPhaseProviderInputProps
  | ConnectionPhaseProviderValueProps;

export function ConnectionPhaseProvider(props: ConnectionPhaseProviderProps) {
  const explicitValue = 'value' in props && props.value !== undefined ? props.value : undefined;
  const inputProps = explicitValue ? undefined : (props as ConnectionPhaseProviderInputProps);

  const input: ConnectionPhaseInput = {
    ipcReconnecting: inputProps?.ipcReconnecting,
    centerReconnecting: inputProps?.centerReconnecting,
    remoteConnected: inputProps?.remoteConnected,
    hasCachedRemoteBots: inputProps?.hasCachedRemoteBots,
    centerConnecting: inputProps?.centerConnecting,
    centerReady: inputProps?.centerReady,
    centerError: inputProps?.centerError,
    hasConfiguredCenter: inputProps?.hasConfiguredCenter,
  };

  const phase = useConnectionPhase(input, inputProps?.options);
  const rawPhase = deriveConnectionPhase(input);

  const ipcReconnecting = Boolean(inputProps?.ipcReconnecting);
  const centerReconnecting = Boolean(inputProps?.centerReconnecting);
  const centerConnecting = Boolean(inputProps?.centerConnecting);
  const centerReady = Boolean(inputProps?.centerReady);
  const centerError = inputProps?.centerError ?? null;
  const detail = inputProps?.detail ?? null;
  const onOpenSettings = inputProps?.onOpenSettings;

  const computedValue = useMemo<ConnectionPhaseContextValue>(
    () => ({
      phase,
      rawPhase,
      ipcReconnecting,
      centerReconnecting,
      centerConnecting,
      centerReady,
      centerError,
      detail,
      onOpenSettings,
    }),
    [
      phase,
      rawPhase,
      ipcReconnecting,
      centerReconnecting,
      centerConnecting,
      centerReady,
      centerError,
      detail,
      onOpenSettings,
    ],
  );

  return (
    <ConnectionPhaseContext.Provider value={explicitValue ?? computedValue}>
      {props.children}
    </ConnectionPhaseContext.Provider>
  );
}
