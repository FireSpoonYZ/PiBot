import type { PetDockSide, PetPanelSide } from './protocol.ts';

export const PET_LAYOUT_CONSTANTS = {
  COLLAPSED_W: 164,
  COLLAPSED_H: 128,
  MAX_STAGE_W: 520,
  MAX_STAGE_H: 720,
  STAGE_PAD: 12,
  DOCK_HEIGHT: 104,
  COMPOSER_PILL_WIDTH: 296,
  COMPOSER_PILL_BASE_HEIGHT: 44,
  COMPOSER_LINE_HEIGHT: 19,
  COMPOSER_TEXTAREA_BASE_HEIGHT: 28,
  COMPOSER_TEXTAREA_MAX_HEIGHT: 72,
  COMPOSER_RECALL_GAP: 5,
  COMPOSER_RECALL_HEIGHT: 22,
  COMPOSER_GAP: 8,
  VIEWPORT_SIZE_TOLERANCE: 4,
  OPEN_READY_TIMEOUT_MS: 120,
  OPEN_IPC_TIMEOUT_MS: 350,
  BLUR_DISMISS_GRACE_MS: 180,
} as const;

export type ComposerPhase = 'closed' | 'opening' | 'open' | 'closing';

export interface ComposerLayoutTarget {
  width: number;
  height: number;
  composerHeight: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface PetOrientation {
  dockSide: PetDockSide;
  panelSide: PetPanelSide;
  composited: boolean;
}

export interface PlanComposerOpenInput {
  /** Width of non-composer content inside `.pet-envelope` (e.g. active bubble width, or 0/dock width). */
  baseContentWidth: number;
  /** Height of non-composer content inside `.pet-envelope` (dock + optional bubble with margin). */
  baseContentHeight: number;
  /** Whether `.pet-recall-chip` ("Last reply") will be rendered below the composer pill. */
  canRecallReply: boolean;
  /** Current draft text (used to estimate multi-line textarea height before mount). */
  draft?: string;
}

export interface PlanComposerCloseInput {
  /** Whether a bubble (speech/question/handoff/progress/menu/settings/etc.) remains visible after close. */
  hasBubble: boolean;
  /** Width of `.pet-envelope` after composer is removed. */
  baseContentWidth: number;
  /** Height of `.pet-envelope` after composer is removed. */
  baseContentHeight: number;
}

export interface NativeOpenAck {
  dockSide?: PetDockSide;
  panelSide?: PetPanelSide;
  composited?: boolean;
  focused?: boolean;
  width?: number;
  height?: number;
}

export interface ComposerState {
  phase: ComposerPhase;
  /** Monotonic token invalidating stale async `set-layout`, rAF, and fallback timeout callbacks. */
  token: number;
  /** Target expanded window dimensions while `phase === 'opening'`. */
  pendingTarget: ComposerLayoutTarget | null;
  /** Whether native `set-layout` has acknowledged the current `'opening'` request. */
  nativeAcked: boolean;
  /** Orientation returned by native `set-layout`, held until viewport is ready to avoid mid-resize flips. */
  pendingOrientation: Partial<PetOrientation> | null;
  /** Timestamp (ms) when `phase` entered `'open'`. */
  openedAt: number;
  /** True once focus is confirmed in `'open'` (textarea/window focus or native `focused: true`). */
  hasConfirmedFocus: boolean;
  /** Last observed native OS window focus state from `pibot:pet-window` / `status` / `set-layout`. */
  nativeFocused: boolean;
  /** Last observed DOM window focus state (`window` focus/blur / `document.hasFocus()`). */
  domFocused: boolean;
}

export type ComposerFocusEvent =
  | {
      kind: 'native-focus';
      focused: boolean;
      documentHasFocus: boolean;
      now: number;
      isRecording?: boolean;
      isAvatarPressing?: boolean;
    }
  | {
      kind: 'window-focus';
      now: number;
    }
  | {
      kind: 'window-blur';
      documentHasFocus: boolean;
      now: number;
      isRecording?: boolean;
      isAvatarPressing?: boolean;
    }
  | {
      kind: 'composer-focus';
      now: number;
    }
  | {
      kind: 'composer-blur';
      targetInComposer: boolean;
      targetInDock: boolean;
      hasRelatedTarget: boolean;
      documentHasFocus: boolean;
      now: number;
      isRecording?: boolean;
      isAvatarPressing?: boolean;
    };

export interface ComposerFocusTransition {
  state: ComposerState;
  shouldDismiss: boolean;
}

export interface ComposerCommitCheck {
  ready: boolean;
  reason: 'not-opening' | 'awaiting-native' | 'awaiting-viewport' | 'viewport-ready' | 'timeout-fallback';
}

export interface ComposerOpenCommitResult {
  state: ComposerState;
  orientation: Partial<PetOrientation> | null;
}

export function createInitialComposerState(
  initial?: { nativeFocused?: boolean; domFocused?: boolean },
): ComposerState {
  return {
    phase: 'closed',
    token: 0,
    pendingTarget: null,
    nativeAcked: false,
    pendingOrientation: null,
    openedAt: 0,
    hasConfirmedFocus: false,
    nativeFocused: Boolean(initial?.nativeFocused),
    domFocused: Boolean(initial?.domFocused),
  };
}

export function estimateComposerHeight(input: { canRecallReply: boolean; draft?: string }): number {
  const rawLines = (input.draft ?? '').split('\n');
  let visualLines = 0;
  for (const line of rawLines) {
    visualLines += Math.max(1, Math.ceil(line.length / 22));
  }
  const extraLines = Math.max(0, Math.min(2, visualLines - 1));
  const maxExtraTextareaH =
    PET_LAYOUT_CONSTANTS.COMPOSER_TEXTAREA_MAX_HEIGHT - PET_LAYOUT_CONSTANTS.COMPOSER_TEXTAREA_BASE_HEIGHT;
  const extraTextareaH = Math.min(maxExtraTextareaH, extraLines * PET_LAYOUT_CONSTANTS.COMPOSER_LINE_HEIGHT);
  const pillHeight = PET_LAYOUT_CONSTANTS.COMPOSER_PILL_BASE_HEIGHT + extraTextareaH;
  const recallHeight = input.canRecallReply
    ? PET_LAYOUT_CONSTANTS.COMPOSER_RECALL_GAP + PET_LAYOUT_CONSTANTS.COMPOSER_RECALL_HEIGHT
    : 0;
  return pillHeight + recallHeight + PET_LAYOUT_CONSTANTS.COMPOSER_GAP;
}

export function planComposerOpenLayout(input: PlanComposerOpenInput): ComposerLayoutTarget {
  const rawComposerHeight = estimateComposerHeight({
    canRecallReply: input.canRecallReply,
    draft: input.draft,
  });
  const baseW = Number.isFinite(input.baseContentWidth) ? Math.max(0, input.baseContentWidth) : 0;
  const baseH = Number.isFinite(input.baseContentHeight)
    ? Math.max(PET_LAYOUT_CONSTANTS.DOCK_HEIGHT, input.baseContentHeight)
    : PET_LAYOUT_CONSTANTS.DOCK_HEIGHT;
  const contentW = Math.max(baseW, PET_LAYOUT_CONSTANTS.COMPOSER_PILL_WIDTH);
  const contentH = baseH + rawComposerHeight;
  const width = Math.min(
    PET_LAYOUT_CONSTANTS.MAX_STAGE_W,
    Math.max(PET_LAYOUT_CONSTANTS.COLLAPSED_W, Math.ceil(contentW + PET_LAYOUT_CONSTANTS.STAGE_PAD * 2)),
  );
  const height = Math.min(
    PET_LAYOUT_CONSTANTS.MAX_STAGE_H,
    Math.max(PET_LAYOUT_CONSTANTS.COLLAPSED_H, Math.ceil(contentH + PET_LAYOUT_CONSTANTS.STAGE_PAD * 2)),
  );
  const composerHeight = Math.min(
    rawComposerHeight,
    Math.max(0, height - PET_LAYOUT_CONSTANTS.COLLAPSED_H),
  );
  return { width, height, composerHeight };
}

export function planComposerCloseLayout(input: PlanComposerCloseInput): ComposerLayoutTarget {
  if (!input.hasBubble) {
    return {
      width: PET_LAYOUT_CONSTANTS.COLLAPSED_W,
      height: PET_LAYOUT_CONSTANTS.COLLAPSED_H,
      composerHeight: 0,
    };
  }
  const baseW = Number.isFinite(input.baseContentWidth) ? Math.max(0, input.baseContentWidth) : 0;
  const baseH = Number.isFinite(input.baseContentHeight)
    ? Math.max(PET_LAYOUT_CONSTANTS.DOCK_HEIGHT, input.baseContentHeight)
    : PET_LAYOUT_CONSTANTS.DOCK_HEIGHT;
  return {
    width: Math.min(
      PET_LAYOUT_CONSTANTS.MAX_STAGE_W,
      Math.max(PET_LAYOUT_CONSTANTS.COLLAPSED_W, Math.ceil(baseW + PET_LAYOUT_CONSTANTS.STAGE_PAD * 2)),
    ),
    height: Math.min(
      PET_LAYOUT_CONSTANTS.MAX_STAGE_H,
      Math.max(PET_LAYOUT_CONSTANTS.COLLAPSED_H, Math.ceil(baseH + PET_LAYOUT_CONSTANTS.STAGE_PAD * 2)),
    ),
    composerHeight: 0,
  };
}

export function isViewportReadyForTarget(
  viewport: ViewportSize,
  target: Pick<ComposerLayoutTarget, 'width' | 'height'>,
  tolerance: number = PET_LAYOUT_CONSTANTS.VIEWPORT_SIZE_TOLERANCE,
): boolean {
  return (
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    viewport.width >= target.width - tolerance &&
    viewport.height >= target.height - tolerance
  );
}

export function doesViewportMatchLayout(
  viewport: ViewportSize,
  target: Pick<ComposerLayoutTarget, 'width' | 'height'>,
  tolerance: number = PET_LAYOUT_CONSTANTS.VIEWPORT_SIZE_TOLERANCE,
): boolean {
  return (
    Number.isFinite(viewport.width) &&
    Number.isFinite(viewport.height) &&
    Math.abs(viewport.width - target.width) <= tolerance &&
    Math.abs(viewport.height - target.height) <= tolerance
  );
}

export function shouldRenderComposer(phase: ComposerPhase, settingsOpen: boolean): boolean {
  return phase === 'open' && !settingsOpen;
}

export function shouldSyncNormalNativeLayout(phase: ComposerPhase): boolean {
  return phase === 'closed' || phase === 'open';
}

export function shouldHoldOrientationUpdate(phase: ComposerPhase): boolean {
  return phase === 'opening' || phase === 'closing';
}

export function mergePetOrientation(
  current: PetOrientation,
  patch: Partial<PetOrientation> | null | undefined,
): PetOrientation {
  if (!patch) return current;
  const dockSide = patch.dockSide ?? current.dockSide;
  const panelSide = patch.panelSide ?? current.panelSide;
  const composited = patch.composited ?? current.composited;
  if (
    dockSide === current.dockSide &&
    panelSide === current.panelSide &&
    composited === current.composited
  ) {
    return current;
  }
  return { dockSide, panelSide, composited };
}

export function beginComposerOpen(
  state: ComposerState,
  target: ComposerLayoutTarget,
): ComposerState {
  return {
    ...state,
    phase: 'opening',
    token: state.token + 1,
    pendingTarget: target,
    nativeAcked: false,
    pendingOrientation: null,
    hasConfirmedFocus: false,
  };
}

export function ackComposerOpenNative(
  state: ComposerState,
  token: number,
  ack: NativeOpenAck,
): ComposerState {
  if (state.phase !== 'opening' || state.token !== token) {
    return state;
  }
  const orientation: Partial<PetOrientation> = {};
  if (ack.dockSide !== undefined) orientation.dockSide = ack.dockSide;
  if (ack.panelSide !== undefined) orientation.panelSide = ack.panelSide;
  if (ack.composited !== undefined) orientation.composited = ack.composited;
  let pendingTarget = state.pendingTarget;
  if (pendingTarget) {
    const ackW = typeof ack.width === 'number' && Number.isFinite(ack.width) && ack.width > 0
      ? Math.ceil(ack.width)
      : pendingTarget.width;
    const ackH = typeof ack.height === 'number' && Number.isFinite(ack.height) && ack.height > 0
      ? Math.ceil(ack.height)
      : pendingTarget.height;
    const nextW = Math.min(pendingTarget.width, ackW);
    const nextH = Math.min(pendingTarget.height, ackH);
    if (nextW !== pendingTarget.width || nextH !== pendingTarget.height) {
      pendingTarget = { ...pendingTarget, width: nextW, height: nextH };
    }
  }
  return {
    ...state,
    pendingTarget,
    nativeAcked: true,
    pendingOrientation: orientation,
    nativeFocused: typeof ack.focused === 'boolean' ? ack.focused : state.nativeFocused,
  };
}

export function canCommitComposerOpen(
  state: ComposerState,
  viewport: ViewportSize,
  timedOut = false,
): ComposerCommitCheck {
  if (state.phase !== 'opening' || !state.pendingTarget) {
    return { ready: false, reason: 'not-opening' };
  }
  if (!state.nativeAcked) {
    return timedOut
      ? { ready: true, reason: 'timeout-fallback' }
      : { ready: false, reason: 'awaiting-native' };
  }
  if (isViewportReadyForTarget(viewport, state.pendingTarget)) {
    return { ready: true, reason: 'viewport-ready' };
  }
  return timedOut
    ? { ready: true, reason: 'timeout-fallback' }
    : { ready: false, reason: 'awaiting-viewport' };
}

export function commitComposerOpen(
  state: ComposerState,
  now: number,
  initialDomFocused = false,
): ComposerOpenCommitResult {
  if (state.phase !== 'opening') {
    return { state, orientation: null };
  }
  const orientation = state.pendingOrientation;
  const next: ComposerState = {
    ...state,
    phase: 'open',
    pendingTarget: null,
    nativeAcked: false,
    pendingOrientation: null,
    openedAt: now,
    hasConfirmedFocus: false,
    domFocused: initialDomFocused || state.domFocused,
  };
  return { state: next, orientation };
}

export function beginComposerClose(state: ComposerState): ComposerState {
  if (state.phase === 'closed') {
    return state;
  }
  return {
    ...state,
    phase: 'closing',
    token: state.token + 1,
    pendingTarget: null,
    nativeAcked: false,
    pendingOrientation: null,
    hasConfirmedFocus: false,
  };
}

export function completeComposerClose(state: ComposerState, token: number): ComposerState {
  if (state.phase !== 'closing' || state.token !== token) {
    return state;
  }
  return {
    ...state,
    phase: 'closed',
    pendingTarget: null,
    nativeAcked: false,
    pendingOrientation: null,
    hasConfirmedFocus: false,
  };
}

export function forceCloseComposer(state: ComposerState): ComposerState {
  if (
    state.phase === 'closed' &&
    state.pendingTarget === null &&
    !state.nativeAcked &&
    state.pendingOrientation === null &&
    !state.hasConfirmedFocus
  ) {
    return state;
  }
  return {
    ...state,
    phase: 'closed',
    token: state.token + 1,
    pendingTarget: null,
    nativeAcked: false,
    pendingOrientation: null,
    hasConfirmedFocus: false,
  };
}

export function evaluateComposerFocusEvent(
  state: ComposerState,
  event: ComposerFocusEvent,
  graceMs: number = PET_LAYOUT_CONSTANTS.BLUR_DISMISS_GRACE_MS,
): ComposerFocusTransition {
  const blocked = Boolean(
    ('isRecording' in event && event.isRecording) ||
    ('isAvatarPressing' in event && event.isAvatarPressing),
  );

  if (event.kind === 'window-focus' || event.kind === 'composer-focus') {
    return {
      state: {
        ...state,
        domFocused: true,
        hasConfirmedFocus: state.phase === 'open' ? true : state.hasConfirmedFocus,
      },
      shouldDismiss: false,
    };
  }

  if (event.kind === 'native-focus') {
    const wasNativeFocused = state.nativeFocused;
    const next: ComposerState = {
      ...state,
      nativeFocused: event.focused,
      hasConfirmedFocus: state.phase === 'open' && event.focused ? true : state.hasConfirmedFocus,
    };
    if (event.focused || state.phase !== 'open' || blocked) {
      return { state: next, shouldDismiss: false };
    }
    // State echo guard: if native already considered the window unfocused while WebView2
    // still has DOM focus, repeated `focused: false` broadcasts (e.g. from `set-layout`)
    // must never close the composer.
    if (!wasNativeFocused && event.documentHasFocus) {
      return { state: next, shouldDismiss: false };
    }
    const elapsed = event.now - state.openedAt;
    if (elapsed < graceMs) {
      const confirmedGenuineLoss =
        wasNativeFocused && state.hasConfirmedFocus && !event.documentHasFocus;
      return { state: next, shouldDismiss: confirmedGenuineLoss };
    }
    const shouldDismiss =
      wasNativeFocused || (state.hasConfirmedFocus && !event.documentHasFocus);
    return { state: next, shouldDismiss };
  }

  if (event.kind === 'window-blur') {
    const wasDomFocused = state.domFocused;
    const next: ComposerState = {
      ...state,
      domFocused: false,
    };
    if (state.phase !== 'open' || blocked || event.documentHasFocus) {
      return { state: next, shouldDismiss: false };
    }
    const elapsed = event.now - state.openedAt;
    if (elapsed < graceMs) {
      const confirmedGenuineLoss = wasDomFocused && state.hasConfirmedFocus;
      return { state: next, shouldDismiss: confirmedGenuineLoss };
    }
    return { state: next, shouldDismiss: state.hasConfirmedFocus || elapsed >= graceMs };
  }

  // event.kind === 'composer-blur'
  if (state.phase !== 'open' || blocked) {
    return { state, shouldDismiss: false };
  }
  if (event.targetInComposer || event.targetInDock) {
    return { state, shouldDismiss: false };
  }
  if (event.hasRelatedTarget) {
    return { state, shouldDismiss: true };
  }
  const elapsed = event.now - state.openedAt;
  if (elapsed < graceMs && !state.hasConfirmedFocus) {
    return { state, shouldDismiss: false };
  }
  return { state, shouldDismiss: true };
}
