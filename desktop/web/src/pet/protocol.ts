import type { BotAvatar } from '../../../../center-contract/index.js';
import type { BotActivity } from '../../../../web/src/botActivity';
import type { GrokMascotState } from '../../../../web/src/grokMascotEngine';

export const PET_EVENTS = {
  action: 'pibot:pet-action',
  state: 'pibot:pet-state',
  result: 'pibot:pet-result',
  window: 'pibot:pet-window',
} as const;

export interface PetMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface DesktopPetSnapshot {
  hostSessionId: string;
  revision: number;
  connection: 'connecting' | 'ready' | 'offline' | 'unconfigured';
  deviceId: string | null;
  botId: string | null;
  botName: string;
  avatar: BotAvatar | null;
  activity: BotActivity;
  mascotState: GrokMascotState;
  messages: PetMessage[];
  streamingText: string;
  generationId: string | null;
  error: string | null;
  sending: boolean;
  canStop: boolean;
}

export type DesktopPetAction =
  | { id: string; kind: 'ready' }
  | { id: string; kind: 'refresh' }
  | { id: string; kind: 'stop'; deviceId: string; botId: string }
  | { id: string; kind: 'send'; text: string; deviceId: string; botId: string };

export interface DesktopPetResult {
  id: string;
  ok: boolean;
  message?: string;
  pendingId?: string;
  queuedDraft?: { deviceId: string; botId: string; text: string };
}

export type PetDockSide = 'left' | 'right';
export type PetPanelSide = 'top' | 'bottom';

export interface DesktopPetWindowState {
  visible: boolean;
  expanded: boolean;
  dockSide?: PetDockSide;
  panelSide?: PetPanelSide;
  composited?: boolean;
}

export type DesktopPetWindowAction =
  | 'show' | 'hide' | 'toggle' | 'set-expanded' | 'show-main' | 'drag' | 'status';

export const INITIAL_PET_SNAPSHOT: DesktopPetSnapshot = {
  hostSessionId: '',
  revision: 0,
  connection: 'connecting',
  deviceId: null,
  botId: null,
  botName: 'PiBot',
  avatar: null,
  activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
  mascotState: 'idle',
  messages: [],
  streamingText: '',
  generationId: null,
  error: null,
  sending: false,
  canStop: false,
};
