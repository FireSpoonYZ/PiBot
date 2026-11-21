export const CHAT_STICK_THRESHOLD_PX = 80;

export interface ChatScrollMetrics {
  turnsCount: number;
  latestTurnId: string;
  latestTurnLen: number;
  latestTurnTools: number;
  generatingLen: number;
  liveToolName: string;
  failureNotice: string;
}

export interface ChatAutoScrollInput {
  restorePending?: boolean;
  /** F6 case 1: initial entry into the chat view. */
  entering?: boolean;
  /** Backwards-compatible alias for `entering`. */
  justEntered?: boolean;
  /** F6 case 2: switched to a different bot or conversation target. */
  targetChanged: boolean;
  /** Current stick-to-bottom state driven by `useStickToBottom`. */
  stickToBottom: boolean;
  /** Suppresses the "new messages" pill while in-chat search is open. */
  searchOpen: boolean;
  /** F6 case 3: explicit incoming-content signal (preferred over metric diffing). */
  hasIncomingContent?: boolean;
  /** Optional legacy metrics pair used when `hasIncomingContent` is omitted. */
  prevMetrics?: ChatScrollMetrics;
  currentMetrics?: ChatScrollMetrics;
  /** @deprecated Handled by `useStickToBottom` ResizeObserver; ignored by F6 decision logic. */
  jumpingToBottom?: boolean;
  /** @deprecated Handled by `useStickToBottom` ResizeObserver; ignored by F6 decision logic. */
  scrollHeight?: number;
  /** @deprecated Handled by `useStickToBottom` ResizeObserver; ignored by F6 decision logic. */
  scrollTop?: number;
  /** @deprecated Handled by `useStickToBottom` ResizeObserver; ignored by F6 decision logic. */
  clientHeight?: number;
  /** @deprecated Handled by `useStickToBottom` ResizeObserver; ignored by F6 decision logic. */
  thresholdPx?: number;
}

export type ChatAutoScrollAction =
  | 'skip-restore'
  | 'force-bottom'
  | 'show-jump-pill'
  | 'noop';

export interface ChatAutoScrollDecision {
  action: ChatAutoScrollAction;
  nextStickToBottom: boolean;
  nextJumpingToBottom: boolean;
  showNewContentPill: boolean;
}

export function isNearChatBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx: number = CHAT_STICK_THRESHOLD_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

export function hasChatAnyContent(metrics: ChatScrollMetrics): boolean {
  return (
    metrics.turnsCount > 0 ||
    metrics.generatingLen > 0 ||
    Boolean(metrics.liveToolName) ||
    Boolean(metrics.failureNotice)
  );
}

export function hasIncomingChatContent(
  prev: ChatScrollMetrics,
  current: ChatScrollMetrics,
): boolean {
  return (
    current.turnsCount > prev.turnsCount ||
    (Boolean(current.latestTurnId) && current.latestTurnId !== prev.latestTurnId) ||
    current.latestTurnLen > prev.latestTurnLen ||
    current.latestTurnTools > prev.latestTurnTools ||
    current.generatingLen > prev.generatingLen ||
    (Boolean(current.liveToolName) && current.liveToolName !== prev.liveToolName) ||
    (Boolean(current.failureNotice) && current.failureNotice !== prev.failureNotice)
  );
}

/**
 * Pure decision function for chat auto-scroll (F6).
 *
 * All content/viewport size-change sticking is handled by `useStickToBottom`
 * (ResizeObserver). This helper retains only the 3 non-resize cases (plus
 * scroll-anchor restoration):
 * 1. Initial entry (`entering` / `justEntered`) -> `force-bottom`
 * 2. Target switch (`targetChanged`) -> `force-bottom`
 * 3. User scrolled up (`!stickToBottom`) & new messages arrive -> `show-jump-pill`
 *
 * It never forces bottom scroll on arbitrary content metric changes.
 */
export function decideChatAutoScroll(input: ChatAutoScrollInput): ChatAutoScrollDecision {
  if (input.restorePending) {
    return {
      action: 'skip-restore',
      nextStickToBottom: input.stickToBottom,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    };
  }

  const entering = Boolean(input.entering ?? input.justEntered);
  if (entering || input.targetChanged) {
    return {
      action: 'force-bottom',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    };
  }

  if (input.currentMetrics && !hasChatAnyContent(input.currentMetrics)) {
    return {
      action: 'noop',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    };
  }

  const incoming =
    input.hasIncomingContent ??
    (input.prevMetrics && input.currentMetrics
      ? hasIncomingChatContent(input.prevMetrics, input.currentMetrics)
      : false);

  if (!input.stickToBottom && incoming && !input.searchOpen) {
    return {
      action: 'show-jump-pill',
      nextStickToBottom: false,
      nextJumpingToBottom: false,
      showNewContentPill: true,
    };
  }

  return {
    action: 'noop',
    nextStickToBottom: input.stickToBottom,
    nextJumpingToBottom: false,
    showNewContentPill: false,
  };
}
