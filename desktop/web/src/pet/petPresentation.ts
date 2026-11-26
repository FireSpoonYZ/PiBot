import type { GrokMascotState } from '../../../../web/src/grokMascotEngine.ts';
import type { PetMessage } from './protocol.ts';

export const STREAMING_TO_WORKING_DWELL_MS = 450;

export interface DismissedStreamState {
  /** Last committed message ID in snapshot.messages when user dismissed streaming, or '' if none. */
  anchor: string;
  /** generationId of the dismissed streaming segment, or null if unavailable. */
  generationId: string | null;
}

export type MascotTransitionPlan =
  | { kind: 'noop' }
  | { kind: 'immediate'; state: GrokMascotState }
  | { kind: 'delay'; state: 'working'; delayMs: number };

export function captureDismissedStream(
  messages: readonly Pick<PetMessage, 'id'>[],
  generationId: string | null,
): DismissedStreamState {
  return {
    anchor: messages.length > 0 ? messages[messages.length - 1].id : '',
    generationId,
  };
}

export function reconcileDismissedStream(params: {
  dismissed: DismissedStreamState | null;
  streamingText: string;
  generationId: string | null;
  messages: readonly Pick<PetMessage, 'id' | 'role'>[];
}): { dismissed: DismissedStreamState | null; dismissSpeechId: string | null } {
  const { dismissed, streamingText, generationId, messages } = params;
  if (dismissed === null) {
    return { dismissed: null, dismissSpeechId: null };
  }
  if (Boolean(streamingText) && generationId === dismissed.generationId) {
    return { dismissed, dismissSpeechId: null };
  }

  let nextMsg: Pick<PetMessage, 'id' | 'role'> | undefined;
  if (dismissed.anchor === '') {
    nextMsg = messages[0];
  } else {
    const idx = messages.findIndex((m) => m.id === dismissed.anchor);
    if (idx === -1) {
      return { dismissed: null, dismissSpeechId: null };
    }
    nextMsg = messages[idx + 1];
  }

  if (nextMsg && nextMsg.role === 'assistant') {
    return { dismissed: null, dismissSpeechId: `speech:${nextMsg.id}` };
  }
  return { dismissed: null, dismissSpeechId: null };
}

export function canAutoShowLatestReply(params: {
  replyId: string;
  initialReplyId: string | null;
  hasPendingUserTurn: boolean;
  forcedReplyId: string | null;
  dndMode: boolean;
  dismissedIds: ReadonlySet<string>;
  suppressingStream: boolean;
}): boolean {
  if (params.dismissedIds.has(params.replyId)) {
    return false;
  }
  if (params.forcedReplyId === params.replyId) {
    return true;
  }
  if (params.suppressingStream || params.dndMode || params.hasPendingUserTurn) {
    return false;
  }
  return params.initialReplyId !== null && params.initialReplyId !== params.replyId;
}

export function planMascotTransition(params: {
  displayed: GrokMascotState;
  target: GrokMascotState;
  hasLocalOverride: boolean;
}): MascotTransitionPlan {
  if (params.displayed === params.target) {
    return { kind: 'noop' };
  }
  if (!params.hasLocalOverride && params.displayed === 'streaming' && params.target === 'working') {
    return { kind: 'delay', state: 'working', delayMs: STREAMING_TO_WORKING_DWELL_MS };
  }
  return { kind: 'immediate', state: params.target };
}
