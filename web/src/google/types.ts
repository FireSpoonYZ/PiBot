// Shared Google Workspace & Bot Browser UI contracts for PiBot chat cards and capability views.
// Type-only imports from desktop/web so no runtime cycles are introduced.
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';

export type GoogleServiceChoice = 'gmail' | 'calendar' | 'files';

export type GoogleServiceKey = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'contacts';

export type GoogleServiceReadinessState =
  | 'ready'
  | 'needs-permission'
  | 'api-disabled'
  | 'blocked-by-admin'
  | 'error';

export interface GoogleServiceReadiness {
  service: GoogleServiceKey;
  state: GoogleServiceReadinessState;
  detail?: string;
  enableUrl?: string;
}

export interface GoogleAccountView {
  id: string;
  email: string;
  status: 'connected' | 'reconnect';
  choices: GoogleServiceChoice[];
  services: GoogleServiceReadiness[];
}

export interface GoogleClientStatus {
  configured: boolean;
  clientId?: string;
  projectId?: string;
  redirectUri?: string;
  invalid?: boolean;
  error?: string;
}

export interface GoogleStatusSnapshot {
  client: GoogleClientStatus;
  accounts: GoogleAccountView[];
}

export interface GoogleAuthFlowStart {
  flowId: string;
  authorizationUrl: string;
  expiresAt: string | number;
}

export interface GoogleAuthFlowStatus {
  phase: 'pending' | 'connected' | 'failed' | 'cancelled';
  error?: string;
  account?: GoogleAccountView;
}

export type GoogleRuleSource = 'gmail' | 'calendar';

export interface GoogleRuleDto {
  id?: string;
  deviceId: string;
  botId: string;
  account: string;
  source: GoogleRuleSource;
  enabled: boolean;
  from?: string;
  subjectContains?: string;
  calendar?: string;
  minutesBefore?: number;
  instruction: string;
  status?: 'active' | 'paused' | 'paused_reconnect' | 'backoff' | 'error' | string;
  pausedReason?: string;
  lastCheckedAt?: string;
  backoffUntil?: string;
  lastError?: string;
}

export type GoogleSetupMode = 'do-it-for-me' | 'guide-here' | 'guide-browser';

export interface GoogleSetupStepView {
  id?: string;
  step?: string;
  status?: 'pending' | 'active' | 'done' | 'skipped' | 'blocked' | 'waiting-human' | string;
  title?: string;
  detail?: string;
  url?: string;
}

export interface GoogleSetupBlocker {
  kind?: string;
  code?: string;
  message?: string;
  step?: string;
  email?: string;
  services?: GoogleServiceChoice[];
  enableUrl?: string;
  [key: string]: unknown;
}

export interface GoogleSetupAction {
  id: string;
  label?: string;
  step?: string;
  email?: string;
  services?: GoogleServiceChoice[];
  url?: string;
  [key: string]: unknown;
}

export interface GoogleSetupControlState {
  id?: string;
  revision: number;
  state: string;
  mode?: string;
  step?: string;
  steps?: Record<string, GoogleSetupStepView> | GoogleSetupStepView[];
  choices?: GoogleServiceChoice[];
  projectId?: string;
  account?: string;
  accounts?: GoogleAccountView[];
  blocker?: GoogleSetupBlocker | null;
  actions?: GoogleSetupAction[];
  canUseEmbeddedBrowser?: boolean;
  browserTakeoverRequired?: boolean;
  browserPrompt?: string;
  redirectUri?: string;
  error?: string;
  unavailable?: boolean;
  reason?: string;
}

export type GoogleSetupControlCall = (
  input: Record<string, unknown>,
) => Promise<GoogleSetupControlState>;

export type BotBrowserControlCall = (
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Structured presentation payloads emitted by Google / setup / browser tools. */
export interface GoogleSetupPresentation {
  kind: 'google-setup';
  version: 1;
  installationId: string;
  botId?: string;
  runId?: string;
  card?: string;
  step?: string;
  revision?: number;
  mode?: string;
  state?: string;
  summary?: string;
}

export interface GoogleAccountSelectOption {
  id?: string;
  email: string;
  status?: 'connected' | 'reconnect';
}

export interface GoogleAccountSelectPresentation {
  kind: 'google-account-select';
  version: 1;
  installationId: string;
  requestId?: string;
  conversationId?: number;
  botId?: string;
  actionLabel?: string;
  toolName?: string;
  service?: string;
  reason?: string;
  accounts?: GoogleAccountSelectOption[];
  status?: 'pending' | 'selected' | 'cancelled';
  selectedEmail?: string;
}

export interface GoogleBrowserTakeoverPresentation {
  kind: 'google-browser-takeover';
  version: 1;
  installationId: string;
  botId?: string;
  pageId?: string;
  phase?: 'bot' | 'taking' | 'human' | 'held' | string;
  reason?: string;
  url?: string;
  step?: string;
  canStreamInteract?: boolean;
}

export interface GoogleReadinessPresentation {
  kind: 'google-readiness';
  version: 1;
  installationId: string;
  account?: string;
  service?: GoogleServiceKey | GoogleServiceChoice | string;
  state?: GoogleServiceReadinessState | 'unconfigured' | 'disconnected' | 'reconnect' | 'ambiguous-account';
  detail?: string;
  enableUrl?: string;
  accounts?: string[];
}

export type GoogleToolPresentation =
  | GoogleSetupPresentation
  | GoogleAccountSelectPresentation
  | GoogleBrowserTakeoverPresentation
  | GoogleReadinessPresentation;

/** Shared host/center context injected into chat tool cards (desktop + mobile). */
export interface GoogleChatCardContext {
  api?: DesktopPanelApi | null;
  identity?: DesktopIdentity | null;
  deviceId: string;
  botId: string;
  botName?: string;
  hostLabel?: string;
  hostPlatform?: string;
  isLocalAndroid?: boolean;
  connected?: boolean;
  callGoogleSetup?: GoogleSetupControlCall;
  callBrowser?: BotBrowserControlCall;
  onOpenBrowser?: () => void;
  onOpenCapabilities?: () => void;
  onOpenCenterAdmin?: () => void;
  onSelectGoogleAccount?: (selection: {
    email: string;
    requestId?: string;
    installationId?: string;
    conversationId?: number;
    cancelled?: boolean;
  }) => Promise<unknown>;
}
