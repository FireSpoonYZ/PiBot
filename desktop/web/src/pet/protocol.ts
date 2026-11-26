import type { BotAvatar } from '../../../../center-contract/index.js';
import type { QuestionnairePresentation } from '../../../../host-core/index.js';
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

/** Object type alias (not interface) to remain assignable to ActionRequest.input (JsonValue). */
export type PetQuestionnaireSubmitAnswer = {
  questionIndex: number;
  selectedOptions?: number[];
  customText?: string;
  notes?: string;
};

export type PetQuestionnaireSubmitPayload = {
  conversationId: number;
  requestId: string;
  cancelled: boolean;
  answers: PetQuestionnaireSubmitAnswer[];
  globalNote?: string;
};

export interface PetActiveQuestionnaire {
  toolCallId: string;
  presentation: QuestionnairePresentation;
  interactive: boolean;
  interrupted?: boolean;
}

export interface PetHandoffCard {
  id: string;
  kind: 'vault-unlock' | 'google-setup' | 'google-account-select' | 'google-browser-takeover' | 'google-readiness';
  title: string;
  detail: string;
  tone: 'attention' | 'info' | 'danger';
  actionLabel: string;
}

export interface PetProactiveAlert {
  deviceId: string;
  botId: string;
  botName: string;
  resultId: string;
  summary: string;
  completedAt: string | null;
}

export interface DesktopPetSnapshot {
  hostSessionId: string;
  revision: number;
  connection: 'connecting' | 'ready' | 'offline' | 'unconfigured';
  deviceId: string | null;
  botId: string | null;
  botName: string;
  avatar: BotAvatar | null;
  avatarReady: boolean;
  avatarRevision?: number;
  activity: BotActivity;
  mascotState: GrokMascotState;
  messages: PetMessage[];
  hasPendingUserTurn: boolean;
  streamingText: string;
  generationId: string | null;
  questionnaire: PetActiveQuestionnaire | null;
  settledQuestionnaire: QuestionnairePresentation | null;
  handoff: PetHandoffCard | null;
  proactiveAlert: PetProactiveAlert | null;
  error: string | null;
  sending: boolean;
  canStop: boolean;
}

export type DesktopPetAction =
  | { id: string; kind: 'ready' }
  | { id: string; kind: 'refresh' }
  | { id: string; kind: 'stop'; deviceId: string; botId: string }
  | { id: string; kind: 'send'; text: string; deviceId: string; botId: string }
  | {
      id: string;
      kind: 'answer-questionnaire';
      deviceId: string;
      botId: string;
      installationId: string;
      input: PetQuestionnaireSubmitPayload;
    }
  | { id: string; kind: 'open-bot'; deviceId: string; botId: string }
  | { id: string; kind: 'dismiss-proactive-alert'; resultId: string };

export interface DesktopPetResult {
  id: string;
  ok: boolean;
  message?: string;
  pendingId?: string;
  data?: unknown;
  queuedDraft?: { deviceId: string; botId: string; text: string };
}

export type PetDockSide = 'left' | 'right' | 'center';
export type PetPanelSide = 'top' | 'bottom';

export interface PetWindowHitRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

export interface PetWindowLayoutRequest {
  width: number;
  height: number;
  composerHeight?: number;
  focus?: boolean;
  hitRects?: PetWindowHitRect[];
}

export interface DesktopPetWindowState {
  visible: boolean;
  expanded: boolean;
  focused?: boolean;
  dockSide?: PetDockSide;
  panelSide?: PetPanelSide;
  composited?: boolean;
  width?: number;
  height?: number;
}

export type DesktopPetWindowAction =
  | 'show' | 'reveal' | 'hide' | 'toggle' | 'set-expanded' | 'set-layout' | 'show-main' | 'drag' | 'status';

export type DesktopPetKdeRuleAction = 'status' | 'apply' | 'remove';

export interface DesktopPetKdeRuleStatus {
  supported: boolean;
  sessionType: 'wayland' | 'x11' | 'unknown';
  installed: boolean;
  managedByPibot: boolean;
  upToDate: boolean;
  externallyManaged: boolean;
  reconfigured?: boolean;
  configPath?: string;
}

export const INITIAL_PET_SNAPSHOT: DesktopPetSnapshot = {
  hostSessionId: '',
  revision: 0,
  connection: 'connecting',
  deviceId: null,
  botId: null,
  botName: 'PiBot',
  avatar: null,
  avatarReady: false,
  activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
  mascotState: 'idle',
  messages: [],
  hasPendingUserTurn: false,
  streamingText: '',
  generationId: null,
  questionnaire: null,
  settledQuestionnaire: null,
  handoff: null,
  proactiveAlert: null,
  error: null,
  sending: false,
  canStop: false,
};
