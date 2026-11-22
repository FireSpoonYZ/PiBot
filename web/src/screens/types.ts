import { useEffect, useState } from 'react';
import type { TurnDeliveryMode } from '../native';
import type { ImageAttachment } from '../../../host-core/index.js';
import type { ScopeConversation } from '../gbot-ui';
import type { BotModelDisplayInput } from '../bot-settings/modelDisplay';
import type { ChatTurn } from '../chatTurnModel';
import type { useAction } from '../ui';
import type { GlobalTask } from '../tasks';
import type {
  ChatPending as SharedChatPending,
  ChatPendingEntry as SharedChatPendingEntry,
  HubScreen,
  UnifiedBotItem,
} from '../hub/shared';

export const isCoarsePointer = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

export function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(pointer: coarse)');
    setCoarse(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
  }, []);
  return coarse;
}

export type HubSettingsPage =
  | 'overview'
  | 'connection'
  | 'devices'
  | 'manual'
  | 'updates'
  | 'permissions'
  | 'clipboard'
  | 'advanced';
export type MobileHubScreen = HubScreen | 'bot-skills' | 'settings-center-admin';
export type { CenterAdminTab } from '../center-admin/types';

export type MobileBotItem = UnifiedBotItem & {
  resolvedModel?: BotModelDisplayInput['resolvedModel'];
};

export interface ChatPending extends SharedChatPending {
  attachments?: string[];
  delivery?: TurnDeliveryMode;
}

export interface ChatPendingEntry extends Omit<SharedChatPendingEntry, 'pending'> {
  pending: ChatPending;
}

export interface ActiveEditingTurn {
  botKey: string;
  scopeKey: string;
  entryId: number;
  text: string;
  attachments: ImageAttachment[];
}

export type PendingTaskChatAction =
  | {
      kind: 'answer_prompt';
      scopeKey: string;
      botKey: string;
      taskId: string;
      taskTitle: string;
      answer: string;
      error: string;
    }
  | {
      kind: 'confirm_plan';
      scopeKey: string;
      botKey: string;
      taskId: string;
      taskTitle: string;
      error: string;
    }
  | {
      kind: 'update_task';
      scopeKey: string;
      botKey: string;
      taskId: string;
      taskTitle: string;
      payload: Record<string, unknown> & { taskId: string };
      error: string;
    };

export type PendingTaskChatActionInput =
  | Omit<Extract<PendingTaskChatAction, { kind: 'answer_prompt' }>, 'error'>
  | Omit<Extract<PendingTaskChatAction, { kind: 'confirm_plan' }>, 'error'>
  | Omit<Extract<PendingTaskChatAction, { kind: 'update_task' }>, 'error'>;

export interface RemoteTaskContext {
  scopeKey: string;
  botKey: string;
  deviceId: string;
  botId: string;
  botRole: string;
  linkedTask: GlobalTask | null;
  prefix: string;
}

export interface HubContextMenuState {
  x: number;
  y: number;
  bot?: UnifiedBotItem;
  room?: ScopeConversation;
}

export interface HubListEntry {
  key: string;
  pinKey: string;
  pinned: boolean;
  pinIndex: number;
  bot?: UnifiedBotItem;
  room?: ScopeConversation;
  sortMs: number;
}

export interface CreateBotAttempt {
  requestId: string;
  target: string;
  profileId?: string;
}

export type ActionController = ReturnType<typeof useAction>;

export interface BubbleActionTurnState {
  turn: ChatTurn;
  editable: boolean;
  canRetry: boolean;
}

export type ChatScrollAnchor =
  | { atBottom: true }
  | { atBottom: false; turnId?: string; offsetTop?: number; scrollTop: number };
