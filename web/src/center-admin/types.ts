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

export type CenterAdminTab = 'providers' | 'capabilities' | 'devices' | 'vault' | 'ops';

export interface CenterAdminPanelProps {
  transport: CenterTransport;
  embedded?: boolean;
  initialTab?: CenterAdminTab;
  activeTab?: CenterAdminTab;
  onTabChange?: (tab: CenterAdminTab) => void;
  centerUrl?: string;
  onOpenExternal?: () => void;
  hideTopbarExternal?: boolean;
  onConfigureBot?: (deviceId: string, botId: string) => void;
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

export interface BotLearningPatchConfig {
  enabled?: boolean;
  reviewModelRef?: string | null;
  curatorModelRef?: string | null;
  review?: { memoryEvery?: number; skillEvery?: number };
  curator?: {
    intervalHours?: number;
    minIdleHours?: number;
    staleAfterDays?: number;
    archiveAfterDays?: number;
    consolidate?: boolean;
    enabled?: boolean;
    paused?: boolean;
  };
}

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

export type ExternalVaultControlResult =
  | ExternalVaultStatus
  | ExternalVaultListResult
  | ExternalVaultCheckResult;
