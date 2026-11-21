// Shared Google Workspace & Bot Browser UI contracts for PiBot chat cards and capability views.
// Aligned with center-server/google-workspace/*, host-core/google-setup/service.js,
// and host-core/browser-setup-protocol.js.
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import type { BrowserDestination } from '../bot-browser/protocol';

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

export interface GoogleRuleRuntimeView {
  status: string;
  reason?: string | null;
  detail?: string | null;
  enableUrl?: string | null;
  lastCheckedAt?: string | null;
  lastEventAt?: string | null;
  backoffUntil?: string | null;
  rateLimited?: boolean;
  targetOnline?: boolean | null;
  pendingCount?: number;
  missedCount?: number;
}

export interface GoogleRuleDto {
  id?: string;
  name?: string;
  deviceId: string;
  botId: string;
  account: string;
  source: GoogleRuleSource;
  event?: 'new_email' | 'starting_soon';
  enabled: boolean;
  from?: string | string[];
  to?: string | string[];
  subjectContains?: string;
  label?: string;
  calendar?: string;
  minutesBefore?: number;
  instruction: string;
  listeningSince?: string | null;
  runtime?: GoogleRuleRuntimeView;
  // Optional legacy flat fallbacks
  status?: string;
  pausedReason?: string;
  lastCheckedAt?: string;
  backoffUntil?: string;
  lastError?: string;
}

export type GoogleSetupMode = 'do-it-for-me' | 'guide-here' | 'guide-browser';

export interface GoogleSetupStepView {
  id?: string;
  step?: string;
  status?: 'pending' | 'active' | 'needs-user' | 'done' | 'skipped' | 'failed' | string;
  by?: 'user' | 'bot';
  note?: string;
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
  signedIn?: string;
  wanted?: string;
  services?: GoogleServiceChoice[];
  enableUrl?: string;
  enableUrls?: Array<{ service: string; url: string }>;
  actions?: GoogleSetupAction[];
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

export interface GoogleSetupModeAvailabilityEntry {
  available?: boolean;
  reason?: string;
  caveat?: string;
  fallbackMode?: string;
  recommended?: boolean;
  canIsolateSensitivePages?: boolean;
  clientStepRequiresSystemBrowser?: boolean;
}

export interface GoogleSetupModeAvailability {
  recommendedMode?: GoogleSetupMode;
  clientStepRequiresSystemBrowser?: boolean;
  modes?: Partial<Record<GoogleSetupMode, GoogleSetupModeAvailabilityEntry>>;
}

export interface GoogleSetupBrowserLock {
  active: boolean;
  step?: string;
  reason?: string;
  lockedAt?: number;
  requiresSystemBrowser?: boolean;
}

export interface GoogleSetupCardView {
  card?: string;
  step?: string;
  copy?: number;
  title?: string;
  summary?: string;
  actions?: GoogleSetupAction[];
}

export interface GoogleSetupControlState {
  id?: string | null;
  botId?: string;
  revision: number;
  state: string;
  mode?: string | null;
  step?: string | null;
  steps?: Record<string, GoogleSetupStepView> | GoogleSetupStepView[];
  choices?: GoogleServiceChoice[];
  projectId?: string;
  account?: string;
  accounts?: string[];
  kind?: 'work' | 'personal';
  personStep?: string;
  browserPageId?: string;
  browserLock?: GoogleSetupBrowserLock;
  brandingLinks?: {
    homePage?: string;
    privacyPolicy?: string;
    authorizedDomain?: string;
    redirectUri?: string;
  };
  center?: {
    reachable?: boolean;
    isAdmin?: boolean;
    client?: GoogleClientStatus;
    accounts?: GoogleAccountView[];
  } | null;
  modeAvailability?: GoogleSetupModeAvailability;
  blocker?: GoogleSetupBlocker | null;
  actions?: GoogleSetupAction[];
  card?: GoogleSetupCardView | null;
  canUseEmbeddedBrowser?: boolean;
  browserTakeoverRequired?: boolean;
  browserPrompt?: string;
  redirectUri?: string;
  applied?: boolean;
  resumeQueued?: boolean;
  stale?: boolean;
  staleReason?: string;
  error?: string;
  lastError?: string;
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
  installationId?: string;
  botId?: string;
  runId?: string | null;
  card?: string | null;
  step?: string | null;
  copy?: number;
  revision?: number;
  mode?: string | null;
  state?: string;
  title?: string;
  summary?: string;
  blockerKind?: string | null;
  actions?: Array<{ id: string; label?: string; step?: string }>;
}

export interface GoogleAccountSelectOption {
  id?: string;
  email: string;
  status?: 'connected' | 'reconnect';
}

export interface GoogleAccountSelectPresentation {
  kind: 'google-account-select';
  version: 1;
  installationId?: string;
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
  installationId?: string;
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
  installationId?: string;
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
  onOpenBrowserDestination?: (destination: BrowserDestination) => void;
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
