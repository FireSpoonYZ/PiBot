export type ConnectionPhase = 'online' | 'connecting' | 'offline' | 'error';

export interface ConnectionPhaseInput {
  ipcReconnecting?: boolean;
  centerReconnecting?: boolean;
  remoteConnected?: boolean;
  hasCachedRemoteBots?: boolean;
  centerConnecting?: boolean;
  centerReady?: boolean;
  centerError?: string | null;
  hasConfiguredCenter?: boolean;
}

export interface ConnectionPhaseHysteresisOptions {
  enterDelayMs?: number;
  minVisibleMs?: number;
}

export interface ConnectionPhaseState {
  /** Currently visible (hysteresis-smoothed) connection phase. */
  phase: ConnectionPhase;
  /** Most recent raw derived connection phase before hysteresis. */
  rawPhase: ConnectionPhase;
  /** Timestamp (ms) when the current non-online visible episode began, or null if visible phase is 'online'. */
  visibleSinceMs: number | null;
  /** Timestamp (ms) when rawPhase first left 'online' while visible phase remained 'online', or null otherwise. */
  nonOnlineSinceMs: number | null;
  /** Milliseconds until the next time-based phase transition (strictly > 0), or null if no timer is needed. */
  nextTransitionInMs: number | null;
}

export interface ConnectionPhaseStepResult {
  state: ConnectionPhaseState;
  phase: ConnectionPhase;
  rawPhase: ConnectionPhase;
  nextTransitionInMs: number | null;
}

export const DEFAULT_ENTER_DELAY_MS = 800;
export const DEFAULT_MIN_VISIBLE_MS = 600;

function normalizeDelayMs(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

/**
 * Pure raw derivation of the current connection phase by merging IPC reconnect state,
 * center reconnect/connecting/ready/error flags, and remote transport connectivity.
 */
export function deriveConnectionPhase(input: ConnectionPhaseInput): ConnectionPhase {
  const {
    ipcReconnecting = false,
    centerReconnecting = false,
    remoteConnected,
    hasCachedRemoteBots = false,
    centerConnecting = false,
    centerReady,
    centerError,
    hasConfiguredCenter,
  } = input;

  if (ipcReconnecting || centerReconnecting || centerConnecting) {
    return 'connecting';
  }

  const hasError = typeof centerError === 'string' && centerError.trim().length > 0;
  if (hasError && (centerReady !== true || remoteConnected === false)) {
    return 'error';
  }

  // Local-only usage (no configured center and no cached remote bots):
  // absence of center/remote connectivity is normal and should not display offline.
  if (hasConfiguredCenter === false && !hasCachedRemoteBots) {
    return 'online';
  }

  if (hasCachedRemoteBots && remoteConnected === false) {
    return 'offline';
  }

  if (hasConfiguredCenter === true) {
    if (remoteConnected === false) return 'offline';
    if (centerReady === false && remoteConnected !== true) return 'offline';
    return 'online';
  }

  // When hasConfiguredCenter is omitted, explicit false connectivity flags mean offline.
  if (centerReady === false && remoteConnected !== true) {
    return 'offline';
  }
  if (remoteConnected === false) {
    return 'offline';
  }

  return 'online';
}

/**
 * Initializes the pure connection phase hysteresis state machine at `nowMs`.
 *
 * Rules:
 * - Cold start with cached remote bots (`hasCachedRemoteBots && !remoteConnected`):
 *   frame 1 immediately displays `'connecting'` (or `'error'` if an error is already present)
 *   so the top chrome renders in place without jumping.
 * - Otherwise, if initial raw phase is non-online, stays `'online'` until `enterDelayMs` elapses.
 */
export function createConnectionPhaseState(
  initialInput: ConnectionPhaseInput,
  nowMs: number,
  options?: ConnectionPhaseHysteresisOptions,
): ConnectionPhaseState {
  const enterDelayMs = normalizeDelayMs(options?.enterDelayMs, DEFAULT_ENTER_DELAY_MS);
  const minVisibleMs = normalizeDelayMs(options?.minVisibleMs, DEFAULT_MIN_VISIBLE_MS);
  const rawPhase = deriveConnectionPhase(initialInput);

  const coldStartWithCachedBots =
    Boolean(initialInput.hasCachedRemoteBots) &&
    initialInput.remoteConnected !== true &&
    (initialInput.remoteConnected === false ||
      rawPhase === 'connecting' ||
      rawPhase === 'offline' ||
      rawPhase === 'error');

  if (coldStartWithCachedBots) {
    const phase: ConnectionPhase = rawPhase === 'error' ? 'error' : 'connecting';
    const nextTransitionInMs =
      phase === 'connecting' && rawPhase === 'offline' && minVisibleMs > 0
        ? minVisibleMs
        : null;
    return {
      phase,
      rawPhase,
      visibleSinceMs: nowMs,
      nonOnlineSinceMs: null,
      nextTransitionInMs,
    };
  }

  if (rawPhase === 'online') {
    return {
      phase: 'online',
      rawPhase: 'online',
      visibleSinceMs: null,
      nonOnlineSinceMs: null,
      nextTransitionInMs: null,
    };
  }

  if (enterDelayMs === 0) {
    return {
      phase: rawPhase,
      rawPhase,
      visibleSinceMs: nowMs,
      nonOnlineSinceMs: null,
      nextTransitionInMs: null,
    };
  }

  return {
    phase: 'online',
    rawPhase,
    visibleSinceMs: null,
    nonOnlineSinceMs: nowMs,
    nextTransitionInMs: enterDelayMs,
  };
}

/**
 * Advances the hysteresis state machine given the latest `input` at timestamp `nowMs`.
 *
 * Rules:
 * - While visible phase is `'online'`, a non-online raw phase must persist for >= `enterDelayMs`
 *   (default 800ms) before the visible phase leaves `'online'`.
 * - Once visible phase is non-online, it remains non-online for at least `minVisibleMs`
 *   (default 600ms) before returning to `'online'` (or settling from cold-start `'connecting'`
 *   to `'offline'`), preventing rapid visual flicker.
 */
export function stepConnectionPhaseState(
  prevState: ConnectionPhaseState,
  input: ConnectionPhaseInput,
  nowMs: number,
  options?: ConnectionPhaseHysteresisOptions,
): ConnectionPhaseStepResult {
  const enterDelayMs = normalizeDelayMs(options?.enterDelayMs, DEFAULT_ENTER_DELAY_MS);
  const minVisibleMs = normalizeDelayMs(options?.minVisibleMs, DEFAULT_MIN_VISIBLE_MS);
  const rawPhase = deriveConnectionPhase(input);

  if (prevState.phase === 'online') {
    if (rawPhase === 'online') {
      const state: ConnectionPhaseState = {
        phase: 'online',
        rawPhase: 'online',
        visibleSinceMs: null,
        nonOnlineSinceMs: null,
        nextTransitionInMs: null,
      };
      return { state, phase: state.phase, rawPhase, nextTransitionInMs: null };
    }

    const nonOnlineSinceMs = Math.min(prevState.nonOnlineSinceMs ?? nowMs, nowMs);
    const elapsed = nowMs - nonOnlineSinceMs;
    if (elapsed >= enterDelayMs) {
      const state: ConnectionPhaseState = {
        phase: rawPhase,
        rawPhase,
        visibleSinceMs: nowMs,
        nonOnlineSinceMs: null,
        nextTransitionInMs: null,
      };
      return { state, phase: state.phase, rawPhase, nextTransitionInMs: null };
    }

    const nextTransitionInMs = enterDelayMs - elapsed;
    const state: ConnectionPhaseState = {
      phase: 'online',
      rawPhase,
      visibleSinceMs: null,
      nonOnlineSinceMs,
      nextTransitionInMs,
    };
    return { state, phase: state.phase, rawPhase, nextTransitionInMs };
  }

  // Currently displaying a non-online phase ('connecting' | 'offline' | 'error').
  const visibleSinceMs = Math.min(prevState.visibleSinceMs ?? nowMs, nowMs);
  const visibleElapsed = nowMs - visibleSinceMs;

  if (rawPhase === 'online') {
    if (visibleElapsed >= minVisibleMs) {
      const state: ConnectionPhaseState = {
        phase: 'online',
        rawPhase: 'online',
        visibleSinceMs: null,
        nonOnlineSinceMs: null,
        nextTransitionInMs: null,
      };
      return { state, phase: state.phase, rawPhase, nextTransitionInMs: null };
    }

    const nextTransitionInMs = minVisibleMs - visibleElapsed;
    const state: ConnectionPhaseState = {
      phase: prevState.phase,
      rawPhase: 'online',
      visibleSinceMs,
      nonOnlineSinceMs: null,
      nextTransitionInMs,
    };
    return { state, phase: state.phase, rawPhase, nextTransitionInMs };
  }

  // Raw phase is still non-online. Hold 'connecting' for minVisibleMs before relaxing to 'offline'
  // (e.g. cold start with cached bots before connection attempt begins), while letting 'error'
  // and active 'connecting' reflect immediately.
  if (prevState.phase === 'connecting' && rawPhase === 'offline' && visibleElapsed < minVisibleMs) {
    const nextTransitionInMs = minVisibleMs - visibleElapsed;
    const state: ConnectionPhaseState = {
      phase: 'connecting',
      rawPhase: 'offline',
      visibleSinceMs,
      nonOnlineSinceMs: null,
      nextTransitionInMs,
    };
    return { state, phase: state.phase, rawPhase, nextTransitionInMs };
  }

  const state: ConnectionPhaseState = {
    phase: rawPhase,
    rawPhase,
    visibleSinceMs,
    nonOnlineSinceMs: null,
    nextTransitionInMs: null,
  };
  return { state, phase: state.phase, rawPhase, nextTransitionInMs: null };
}
