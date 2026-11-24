import type {
  Accepted,
  ActionDescriptor,
  ActionRequest,
  ActionResult,
  ActivationStatus,
  ApiError,
  ArtifactUploadReceipt,
  BatchModelsRequest,
  BotAvatar,
  BotCapabilityConfig,
  BotCapabilityEntry,
  BotCwdConfig,
  BotLearningCounters,
  BotLearningJobSummary,
  BotLearningSettings,
  BotLearningSettingsPatch,
  BotLearningStatus,
  BotModelConfig,
  BotRef,
  BotSyncResponse,
  CapabilityKind,
  CapabilityTool,
  CapabilityToolsListResponse,
  CenterCreateBotRequest,
  CenterUpdateBotRequest,
  ClientReleaseArch,
  ClientReleaseFormat,
  ClientReleaseListResponse,
  ClientReleaseMetadata,
  ClientReleasePlatform,
  ClientReleasePublishRequest,
  ClientReleaseRecord,
  CreatePairingCodeResponse,
  CredentialInfo,
  CredentialWrite,
  DeleteModelResult,
  DeleteProviderResult,
  DeploymentPhase,
  DeploymentReceipt,
  Device,
  DevicePlatform,
  DeviceRuntimeStatus,
  DiscoveryResult,
  EnableRequest,
  HealthState,
  InstallRequest,
  InstallSource,
  Installation,
  InstallationConfig,
  InstallationOwnerBot,
  InstallationSkillFilesResponse,
  JsonObject,
  JsonSchema,
  JsonValue,
  LoginRequest,
  Model,
  ModelCatalogItem,
  ModelConfig,
  ModelPickerResponse,
  ModelSelection,
  Operation,
  OperationRequest,
  PackageVersion,
  PairingCaState,
  PairingCodeState,
  PairingCodeStatus,
  Provider,
  ProviderAuthFlow,
  ProviderAuthStatus,
  ProviderCheckRequest,
  ProviderCheckResult,
  PutBotCapability,
  PutInstallationConfig,
  PutInstallationDisplayName,
  PutInstallationSkillFilesRequest,
  RevisionWrite,
  RuntimeApplyStatus,
  SessionInfo,
  SkillPackageEntry,
  SkillVisibilityScope,
  UpdateRequest,
} from '../../../center-contract/index.js';
import type * as React from 'react';

export type {
  Accepted,
  ActionDescriptor,
  ActionRequest,
  ActionResult,
  ActivationStatus,
  ApiError,
  ArtifactUploadReceipt,
  BatchModelsRequest,
  BotAvatar,
  BotCapabilityConfig,
  BotCapabilityEntry,
  BotCwdConfig,
  BotLearningCounters,
  BotLearningJobSummary,
  BotLearningSettings,
  BotLearningStatus,
  BotModelConfig,
  BotRef,
  BotSyncResponse,
  CapabilityKind,
  CapabilityTool,
  CapabilityToolsListResponse,
  CenterCreateBotRequest,
  CenterUpdateBotRequest,
  ClientReleaseArch,
  ClientReleaseFormat,
  ClientReleaseListResponse,
  ClientReleaseMetadata,
  ClientReleasePlatform,
  ClientReleasePublishRequest,
  ClientReleaseRecord,
  CreatePairingCodeResponse,
  CredentialInfo,
  CredentialWrite,
  DeleteModelResult,
  DeleteProviderResult,
  DeploymentPhase,
  DeploymentReceipt,
  Device,
  DevicePlatform,
  DeviceRuntimeStatus,
  DiscoveryResult,
  EnableRequest,
  HealthState,
  InstallRequest,
  InstallSource,
  Installation,
  InstallationConfig,
  InstallationOwnerBot,
  InstallationSkillFilesResponse,
  JsonObject,
  JsonSchema,
  JsonValue,
  LoginRequest,
  Model,
  ModelCatalogItem,
  ModelConfig,
  ModelPickerResponse,
  ModelSelection,
  Operation,
  OperationRequest,
  PackageVersion,
  PairingCaState,
  PairingCodeState,
  PairingCodeStatus,
  Provider,
  ProviderAuthFlow,
  ProviderAuthStatus,
  ProviderCheckRequest,
  ProviderCheckResult,
  PutBotCapability,
  PutInstallationConfig,
  PutInstallationDisplayName,
  PutInstallationSkillFilesRequest,
  RevisionWrite,
  RuntimeApplyStatus,
  SessionInfo,
  SkillPackageEntry,
  SkillVisibilityScope,
  UpdateRequest,
};

export interface CenterTransport {
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T>;
}

export type CenterAdminTab = 'providers' | 'devices' | 'capabilities' | 'google' | 'vault' | 'webhooks' | 'releases';

export interface CenterAdminPanelProps {
  transport: CenterTransport;
  embedded?: boolean;
  initialTab?: CenterAdminTab;
  activeTab?: CenterAdminTab;
  onTabChange?: (tab: CenterAdminTab) => void;
  centerUrl?: string;
  onOpenExternal?: () => void;
  onOpenExternalUrl?: (url: string) => void | Promise<unknown>;
  hideTopbarExternal?: boolean;
  onConfigureBot?: (deviceId: string, botId: string) => void;
  onStartGoogleSetupWizard?: (deviceId: string, botId: string) => void;
  renderQr?: (value: string, label: string) => React.ReactNode;
}

export interface ResolvedModelSummary {
  effectiveModelRef: string | null;
  effectiveModelName: string | null;
  effectiveProviderName: string | null;
  source: 'bot' | 'center_default' | 'local_default' | 'unset';
  available: boolean;
}

export type CenterDevice = Device & {
  oauthAdminEnabled?: boolean;
  platform?: DevicePlatform;
};

export type CenterBotRef = BotRef & {
  resolvedModel?: ResolvedModelSummary;
};

export interface CenterBotSyncResponse extends Omit<BotSyncResponse, 'devices' | 'bots'> {
  devices: CenterDevice[];
  bots?: CenterBotRef[];
}

export interface QrLoginChallengeResponse {
  challengeId: string;
  browserSecret: string;
  qrCode: string;
  expiresAt: string;
  ttlSeconds: number;
}

export interface QrLoginClaimResponse {
  status: 'pending' | 'approved' | 'expired';
  authenticated?: boolean;
  csrfToken?: string | null;
}

export interface ActivePairingCodeInfo {
  id: string;
  code?: string;
  status: PairingCodeStatus;
  createdAt: string;
  expiresAt: string;
  includesCa: boolean;
  target: { deviceId: string; name: string } | null;
}

export interface SetupStatus {
  required: boolean;
  publicUrl?: string;
  linkUrl?: string;
  tlsMode?: 'direct' | 'proxy';
}

export interface SetupRequest {
  setupToken: string;
  ownerPassword: string;
  publicUrl: string;
}

export interface McpOAuthStart {
  flowId: string;
  authorizationUrl: string;
}

export interface McpOAuthStatus {
  status: 'pending' | 'complete' | 'failed';
  error?: string;
}

export type BotLearningPatchConfig = BotLearningSettingsPatch;

export interface BotLearningTriggerResult {
  jobId?: string | null;
  status: string;
  reason?: string;
  mode?: string;
  summary?: string;
}

export interface WebhookRoute {
  id: string;
  name: string;
  deviceId: string;
  botId: string;
  instruction: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface WebhookEvent {
  id: string;
  routeId: string;
  routeName: string;
  deviceId: string;
  botId: string;
  requestId: string;
  idempotencyKey: string;
  status: 'pending' | 'dispatching' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  receivedAt: string;
  expiresAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  admission?: {
    phase: 'queued' | 'checking' | 'synchronizing' | 'failed';
    error?: { code: string; message: string };
  } | null;
  error?: { code: string; message: string } | null;
}

export interface CreateWebhookRequest {
  name: string;
  deviceId: string;
  botId: string;
  instruction: string;
  enabled?: boolean;
}

export interface UpdateWebhookRequest {
  name: string;
  instruction: string;
  enabled: boolean;
  deviceId?: string;
  botId?: string;
}

export interface WebhookTokenReceipt {
  route: WebhookRoute;
  token: string;
}

export type VaultSource = 'local' | 'vaultwarden';

export interface ExternalVaultGrant {
  deviceId: string;
  botId: string;
}

export interface ExternalVaultItemMeta {
  secretRef: string;
  label: string;
  username: string;
  allowedBots: ExternalVaultGrant[];
}

export interface ExternalVaultStatus {
  source: VaultSource;
  revision: number;
  configured: boolean;
  authenticated: boolean;
  locked: boolean;
  expiresAt: string | null;
  serverUrl: string | null;
  email: string | null;
  accountId: string | null;
  lastSyncAt: string | null;
  epoch: string;
}

export type ExternalVaultControlInput =
  | { action: 'status' }
  | { action: 'configure'; expectedRevision: number; source: VaultSource; serverUrl?: string; email?: string }
  | { action: 'check' }
  | { action: 'logout' }
  | { action: 'unlock'; masterPassword: string; expectedEpoch: string }
  | { action: 'lock' }
  | { action: 'sync' }
  | { action: 'list' }
  | { action: 'setGrants'; expectedRevision: number; secretRef: string; allowedBots: ExternalVaultGrant[] };

export interface ExternalVaultListResult {
  revision: number;
  items: ExternalVaultItemMeta[];
}

export interface ExternalVaultCheckResult {
  reachable: boolean;
  status: ExternalVaultStatus;
}

export interface InstallationBotBindingsResponse {
  bindings: Record<string, BotCapabilityConfig>;
}

export type ExternalVaultControlResult =
  | ExternalVaultStatus
  | ExternalVaultListResult
  | ExternalVaultCheckResult;

// Google Workspace Center Control API (/api/google/*)
export type GoogleServiceChoice = 'gmail' | 'calendar' | 'files';

export type GoogleServiceId =
  | 'gmail'
  | 'calendar'
  | 'drive'
  | 'docs'
  | 'sheets'
  | 'contacts'
  | 'people';

export type GoogleServiceState =
  | 'ready'
  | 'needs-permission'
  | 'api-disabled'
  | 'blocked-by-admin'
  | 'error';

export interface GoogleServiceReadiness {
  service: GoogleServiceId;
  state: GoogleServiceState;
  detail?: string;
  enableUrl?: string;
}

export interface GoogleClientStatus {
  configured: boolean;
  clientId?: string;
  projectId?: string;
  redirectUri?: string;
  status?: 'unconfigured' | 'configured' | 'invalid';
  clientKey?: 'works' | 'gone' | 'unknown';
  error?: string;
  updatedAt?: string;
}

export type GoogleAccountConnectionState =
  | 'connected'
  | 'reconnect'
  | 'reconnect_required'
  | 'temp_error';

export interface GoogleAccountStatus {
  id: string;
  email: string;
  status: GoogleAccountConnectionState;
  choices: GoogleServiceChoice[];
  services: GoogleServiceReadiness[];
  reason?: string;
  error?: string;
  connectedAt?: string | number;
  checkedAt?: string | number;
}

export interface GoogleStatusResponse {
  client: GoogleClientStatus;
  accounts: GoogleAccountStatus[];
  clientKey?: 'works' | 'gone' | 'unknown';
  available?: boolean;
  reason?: string;
}

export interface GoogleConfigureRequest {
  clientFile?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface GoogleAuthorizeRequest {
  choices: GoogleServiceChoice[];
  account?: string;
}

export interface GoogleAuthorizeResponse {
  flowId: string;
  authorizationUrl: string;
  expiresAt: string | number;
}

export interface GoogleFlowRequest {
  flowId: string;
}

export type GoogleFlowPhase = 'pending' | 'connected' | 'failed' | 'cancelled';

export interface GoogleFlowResponse {
  phase: GoogleFlowPhase;
  error?: string;
  account?: GoogleAccountStatus;
}

export interface GoogleCancelRequest {
  flowId: string;
}

export interface GoogleCheckRequest {
  account: string;
}

export interface GoogleCheckResponse {
  account?: GoogleAccountStatus;
  status?: GoogleStatusResponse;
  client?: GoogleClientStatus;
  accounts?: GoogleAccountStatus[];
  reachable?: boolean;
  error?: string;
}

export interface GoogleRemoveRequest {
  account: string;
  revoke?: boolean;
}

export interface GoogleRemoveResponse {
  removed?: boolean;
  revoked?: boolean;
  revokeAttempted?: boolean;
  revokeError?: string | null;
  revokeWarning?: string | null;
  error?: string;
}

export type GoogleRuleSource = 'gmail' | 'calendar';

export interface GoogleRule {
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
  status?: string;
  pausedReason?: string | null;
  pauseReason?: string | null;
  lastCheckedAt?: string | number | null;
  lastError?: string | null;
  backoffUntil?: string | number | null;
  createdAt?: string;
  updatedAt?: string;
}

export type GoogleRulesListResponse =
  | GoogleRule[]
  | { items?: GoogleRule[]; rules?: GoogleRule[] };

export interface GoogleRuleRemoveRequest {
  id: string;
  deviceId?: string;
  botId?: string;
}

export type GoogleAssistantMode = 'dedicated' | 'existing';

export interface GoogleAssistantConfig {
  enabled: boolean;
  deviceId: string;
  botId: string;
  mode: GoogleAssistantMode;
  accounts: string[];
  batchWindowMinutes: number;
  digestTimes: string[];
  calendarEnabled: boolean;
  calendarLeadMinutes: number;
  hindsightPrivateMemory: boolean;
  revision: number;
  listeningSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoogleAssistantLastDelivery {
  eventId?: string;
  eventKey?: string;
  kind?: string;
  status?: string;
  deliveredAt?: string | null;
  updatedAt?: string | null;
  error?: { code?: string; message?: string } | null;
}

export interface GoogleAssistantRuntime {
  status: string;
  reason?: string | null;
  detail?: string | null;
  lastCheckedAt?: string | null;
  lastEventAt?: string | null;
  pendingBucketCount: number;
  pendingDeliveryCount: number;
  missedCount: number;
  targetOnline?: boolean | null;
  lastDelivery?: GoogleAssistantLastDelivery | null;
}

export interface GoogleAssistantResponse {
  assistant: GoogleAssistantConfig | null;
  runtime: GoogleAssistantRuntime | null;
}

export interface GoogleAssistantCreateBotInput {
  role?: string;
  description?: string;
  modelRef?: string;
  thinkingLevel?: string;
  cwd?: string;
}

export interface GoogleAssistantBaseOptions {
  accounts?: string[];
  batchWindowMinutes?: number;
  digestTimes?: string[];
  calendarEnabled?: boolean;
  calendarLeadMinutes?: number;
  hindsightPrivateMemory?: boolean;
}

export type GoogleAssistantSetupRequest =
  | (GoogleAssistantBaseOptions & {
      mode: 'dedicated';
      deviceId: string;
      botId?: string;
      createBot?: GoogleAssistantCreateBotInput;
    })
  | (GoogleAssistantBaseOptions & {
      mode: 'existing';
      deviceId: string;
      botId: string;
    });

export interface GoogleAssistantCreatedBot {
  deviceId: string;
  botId: string;
  role: string;
  soulApplied?: boolean;
  modelApplied?: boolean;
}

export interface GoogleAssistantSetupResponse extends GoogleAssistantResponse {
  createdBot?: GoogleAssistantCreatedBot | null;
}

export interface GoogleAssistantSaveRequest extends GoogleAssistantBaseOptions {
  enabled: boolean;
  deviceId: string;
  botId: string;
  mode: GoogleAssistantMode;
  expectedRevision?: number;
}

export interface GoogleAssistantRemoveResponse {
  removed: boolean;
}

export interface GoogleAssistantEventItem {
  id: string;
  eventKey?: string;
  deviceId?: string;
  botId?: string;
  account?: string | null;
  kind?: string;
  status: string;
  requestId?: string;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string | null;
  error?: { code?: string; message?: string } | null;
}

export interface GoogleAssistantEventsResponse {
  items: GoogleAssistantEventItem[];
}
