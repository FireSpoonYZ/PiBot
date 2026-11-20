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
  restorePending: boolean;
  justEntered: boolean;
  targetChanged: boolean;
  stickToBottom: boolean;
  jumpingToBottom: boolean;
  searchOpen: boolean;
  prevMetrics: ChatScrollMetrics;
  currentMetrics: ChatScrollMetrics;
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  thresholdPx?: number;
}

export type ChatAutoScrollAction =
  | 'skip-restore'
  | 'force-bottom'
  | 'reset-empty'
  | 'scroll-bottom'
  | 'smooth-bottom'
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
 * Pure decision function for smart chat auto-scroll:
 * - Preserves restored scroll position when returning from DM/room (`restorePending`).
 * - Forces scroll to bottom on chat entry or target change.
 * - Auto-follows new messages/streaming only while sticking within 80px of bottom.
 * - Shows the "↓ New messages" jump pill when scrolled up and new content arrives (unless searching).
 */
export function decideChatAutoScroll(input: ChatAutoScrollInput): ChatAutoScrollDecision {
  const threshold = input.thresholdPx ?? CHAT_STICK_THRESHOLD_PX;

  if (input.restorePending) {
    return {
      action: 'skip-restore',
      nextStickToBottom: input.stickToBottom,
      nextJumpingToBottom: input.jumpingToBottom,
      showNewContentPill: false,
    };
  }

  if (input.justEntered || input.targetChanged) {
    return {
      action: 'force-bottom',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    };
  }

  if (!hasChatAnyContent(input.currentMetrics)) {
    return {
      action: 'reset-empty',
      nextStickToBottom: true,
      nextJumpingToBottom: input.jumpingToBottom,
      showNewContentPill: false,
    };
  }

  if (input.stickToBottom) {
    return {
      action: input.jumpingToBottom ? 'smooth-bottom' : 'scroll-bottom',
      nextStickToBottom: true,
      nextJumpingToBottom: input.jumpingToBottom,
      showNewContentPill: false,
    };
  }

  const incoming = hasIncomingChatContent(input.prevMetrics, input.currentMetrics);
  if (incoming && !input.searchOpen) {
    if (isNearChatBottom(input.scrollHeight, input.scrollTop, input.clientHeight, threshold)) {
      return {
        action: 'scroll-bottom',
        nextStickToBottom: true,
        nextJumpingToBottom: false,
        showNewContentPill: false,
      };
    }
    return {
      action: 'show-jump-pill',
      nextStickToBottom: false,
      nextJumpingToBottom: input.jumpingToBottom,
      showNewContentPill: true,
    };
  }

  return {
    action: 'noop',
    nextStickToBottom: input.stickToBottom,
    nextJumpingToBottom: input.jumpingToBottom,
    showNewContentPill: false,
  };
}
