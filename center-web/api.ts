import type {
  Accepted, ActionRequest, ActionResult, ApiError, ArtifactUploadReceipt, BatchModelsRequest, BotCapabilityConfig, BotCwdConfig, CapabilityToolsListResponse,
  BotCapabilityEntry, BotLearningStatus, BotModelConfig, BotRef, BotSyncResponse, CenterCreateBotRequest, CenterUpdateBotRequest, CredentialInfo, CredentialWrite, DeleteModelResult, DeleteProviderResult, DeploymentReceipt, Device, DeviceRuntimeStatus, DiscoveryResult,
  EnableRequest,
  InstallRequest, Installation, InstallationConfig, LoginRequest, Model, ModelConfig, ModelPickerResponse, ModelSelection,
  Operation, OperationRequest, PackageVersion, Provider, ProviderAuthStatus, ProviderAuthFlow, ProviderCheckRequest, ProviderCheckResult, JsonSchema,
  ClientReleaseListResponse, ClientReleaseMetadata, ClientReleasePublishRequest, ClientReleaseRecord,
  CreatePairingCodeResponse, PairingCaState, PairingCodeState,
  PutBotCapability, PutInstallationConfig, PutInstallationDisplayName, RevisionWrite, SessionInfo, UpdateRequest,
} from '@e-launcher/center-contract';

export interface BotLearningPatchConfig {
  reviewModelRef?: string | null;
  curatorModelRef?: string | null;
  review?: { memoryEvery?: number; skillEvery?: number };
  curator?: {
    intervalHours?: number;
    minIdleHours?: number;
    staleAfterDays?: number;
    archiveAfterDays?: number;
    consolidate?: boolean;
  };
}
export interface BotLearningTriggerResult {
  jobId?: string | null;
  status: string;
  reason?: string;
  mode?: string;
  summary?: string;
}

export interface InstallationCheckRequest { deviceId: string; botId: string }
export interface ActionDescriptor { id: string; title: string; inputSchema: JsonSchema; outputSchema?: JsonSchema }
export interface McpOAuthStart { flowId: string; authorizationUrl: string }
export interface McpOAuthStatus { status: 'pending' | 'complete' | 'failed'; error?: string }
export interface SetupStatus { required: boolean; publicUrl?: string; linkUrl?: string; tlsMode?: 'direct' | 'proxy' }
export interface SetupRequest { setupToken: string; ownerPassword: string; publicUrl: string }

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

// POST /api/vault/control wire contract (center-server vault routes). Secrets
// only ever travel inside these request bodies; responses never contain them.
export type VaultSource = 'local' | 'vaultwarden';
export interface ExternalVaultGrant { deviceId: string; botId: string }
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
export interface ExternalVaultListResult { revision: number; items: ExternalVaultItemMeta[] }
export interface ExternalVaultCheckResult { reachable: boolean; status: ExternalVaultStatus }
export type ExternalVaultControlResult = ExternalVaultStatus | ExternalVaultListResult | ExternalVaultCheckResult;
export interface UpdateWebhookRequest { name: string; instruction: string; enabled: boolean }
export interface WebhookTokenReceipt { route: WebhookRoute; token: string }

let csrfToken: string | null = null;
export class CenterApiError extends Error {
  constructor(public code: string, message: string, public status: number, public details?: ApiError['error']['details']) {
    super(message);
  }
}
const id = encodeURIComponent;
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers = new Headers();
  if (method !== 'GET') {
    if (!csrfToken) throw new CenterApiError('CSRF_INVALID', '会话令牌不可用，请重新连接中心', 403);
    headers.set('x-csrf-token', csrfToken);
  }
  if (body !== undefined && !(body instanceof FormData)) headers.set('content-type', 'application/json');
  let response: Response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), cache: 'no-store' });
  } catch {
    window.dispatchEvent(new Event('center-offline'));
    throw new CenterApiError('CENTER_OFFLINE', '无法连接中心', 503);
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/session') window.dispatchEvent(new Event('center-unauthenticated'));
    const payload = await response.json().catch(() => null) as ApiError | null;
    if (payload?.error?.code === 'CENTER_OFFLINE') window.dispatchEvent(new Event('center-offline'));
    throw new CenterApiError(payload?.error?.code || 'HTTP_ERROR', payload?.error?.message || `请求失败 (${response.status})`, response.status, payload?.error?.details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
// Onboarding runs before any session exists, so /api/setup uses a raw fetch:
// no CSRF token is required or available yet. A 404 on GET means an older
// center without onboarding — already configured; POST 404 is a real error.
// Every request is bounded by SETUP_REQUEST_TIMEOUT_MS; a caller-provided
// signal is merged in, so an earlier caller abort (wait deadline) still wins.
const SETUP_REQUEST_TIMEOUT_MS = 10_000;
async function setupRequest<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort);
  const timer = setTimeout(() => controller.abort(), SETUP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/setup', {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (method === 'GET' && response.status === 404) return { required: false } as T;
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as ApiError | null;
      throw new CenterApiError(payload?.error?.code || 'HTTP_ERROR', payload?.error?.message || '请求失败 (' + response.status + ')', response.status, payload?.error?.details);
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
const botPath = (deviceId: string, botId: string) => `/api/devices/${id(deviceId)}/bots/${id(botId)}`;
const installationPath = (installationId: string) => `/api/installations/${id(installationId)}`;
export const api = {
  getSetup: (signal?: AbortSignal) => setupRequest<SetupStatus>('GET', undefined, signal),
  submitSetup: (body: SetupRequest) => setupRequest<{ configured: boolean }>('POST', body),
  async session() { const result = await request<SessionInfo>('/api/session'); csrfToken = result.csrfToken; return result; },
  async login(body: LoginRequest) { const result = await request<SessionInfo>('/api/session', 'POST', body); csrfToken = result.csrfToken; return result; },
  async logout() { await request<void>('/api/session', 'DELETE'); csrfToken = null; },
  syncModelCatalog: () => request<{ modelsAdded?: number; error: string | null }>('/api/model-catalog/sync', 'POST'),
  getModelPicker: () => request<ModelPickerResponse>('/api/model-picker'),
  setModelStar: (modelRef: string, starred: boolean) => request<{ starredModels: string[] }>('/api/model-stars', 'PUT', { modelRef, starred }),
  listProviders: () => request<Provider[]>('/api/providers'),
  createProvider: (body: Provider) => request<Provider>('/api/providers', 'POST', body),
  discoverDraftModels: (body: ProviderCheckRequest) => request<DiscoveryResult>('/api/providers/discover', 'POST', body),
  getProvider: (providerId: string) => request<Provider>(`/api/providers/${id(providerId)}`),
  providerAuthStatus: (providerId: string) => request<ProviderAuthStatus>(`/api/providers/${id(providerId)}/auth-status`),
  providerLogin: (providerId: string) => request<{ flowId: string }>(`/api/providers/${id(providerId)}/login`, 'POST'),
  providerLoginStatus: (providerId: string, flowId: string) => request<ProviderAuthFlow>(`/api/providers/${id(providerId)}/login/${id(flowId)}`),
  providerLoginAnswer: (providerId: string, flowId: string, answer: string) => request<{accepted:boolean}>(`/api/providers/${id(providerId)}/login/${id(flowId)}/answer`, 'POST', {answer}),
  providerLoginCancel: (providerId: string, flowId: string) => request<{status:string}>(`/api/providers/${id(providerId)}/login/${id(flowId)}/cancel`, 'POST'),
  providerLogout: (providerId: string) => request<ProviderAuthStatus>(`/api/providers/${id(providerId)}/logout`, 'POST'),
  putProvider: (providerId: string, body: RevisionWrite<Provider>) => request<Provider>(`/api/providers/${id(providerId)}`, 'PUT', body),
  deleteProvider: (providerId: string) => request<DeleteProviderResult>(`/api/providers/${id(providerId)}`, 'DELETE'),
  validateProvider: (providerId: string, body: ProviderCheckRequest = {}) => request<ProviderCheckResult>(`/api/providers/${id(providerId)}/validate`, 'POST', body),
  discoverModels: (providerId: string, body: ProviderCheckRequest = {}) => request<DiscoveryResult>(`/api/providers/${id(providerId)}/discover`, 'POST', body),
  listModels: (providerId: string, includeRemoved = false) => request<Model[]>(`/api/providers/${id(providerId)}/models${includeRemoved ? '?includeRemoved=1' : ''}`),
  createModel: (providerId: string, body: Model) => request<Model>(`/api/providers/${id(providerId)}/models`, 'POST', body),
  createModelsBatch: (providerId: string, body: BatchModelsRequest) => request<{ models: Model[] }>(`/api/providers/${id(providerId)}/models/batch`, 'POST', body),
  putModel: (providerId: string, modelId: string, body: RevisionWrite<Model>) => request<Model>(`/api/providers/${id(providerId)}/models/${id(modelId)}`, 'PUT', body),
  deleteModel: (providerId: string, modelId: string) => request<DeleteModelResult>(`/api/providers/${id(providerId)}/models/${id(modelId)}`, 'DELETE'),
  getModelConfig: () => request<ModelConfig>('/api/model-config'),
  putModelConfig: (body: RevisionWrite<ModelSelection>) => request<ModelConfig>('/api/model-config', 'PUT', body),
  listWebhooks: () => request<{ items: WebhookRoute[] }>('/api/webhooks'),
  createWebhook: (body: CreateWebhookRequest) => request<WebhookTokenReceipt>('/api/webhooks', 'POST', body),
  updateWebhook: (routeId: string, body: UpdateWebhookRequest) => request<WebhookRoute>(`/api/webhooks/${id(routeId)}`, 'PUT', body),
  rotateWebhookToken: (routeId: string) => request<WebhookTokenReceipt>(`/api/webhooks/${id(routeId)}/rotate-token`, 'POST', {}),
  deleteWebhook: (routeId: string) => request<void>(`/api/webhooks/${id(routeId)}`, 'DELETE'),
  listWebhookEvents: (routeId: string) => request<{ items: WebhookEvent[] }>(`/api/webhooks/${id(routeId)}/events`),
  listDevices: () => request<Device[]>('/api/devices'),
  getDeviceRuntimeStatus: (deviceId: string) => request<DeviceRuntimeStatus>(`/api/devices/${id(deviceId)}/runtime-status`),
  renameDevice: (deviceId: string, name: string) => request<Device>(`/api/devices/${id(deviceId)}`, 'PATCH', { name }),
  deleteDevice: (deviceId: string) => request<void>(`/api/devices/${id(deviceId)}`, 'DELETE'),
  /** With `deviceId` the code re-binds that one existing device; without it, it registers a new one. */
  createPairingCode: (deviceId?: string) => request<CreatePairingCodeResponse>('/api/pairing-codes', 'POST', deviceId === undefined ? {} : { deviceId }),
  getPairingCode: (codeId: string) => request<PairingCodeState>(`/api/pairing-codes/${id(codeId)}`),
  revokePairingCode: (codeId: string) => request<void>(`/api/pairing-codes/${id(codeId)}`, 'DELETE'),
  getPairingCa: () => request<PairingCaState>('/api/pairing/ca'),
  putPairingCa: (ca: string | null) => request<PairingCaState>('/api/pairing/ca', 'PUT', { ca }),
  getBotSync: (params?: { epoch?: string; sinceSeq?: number }) => {
    const query = new URLSearchParams();
    if (params?.epoch) query.set('epoch', params.epoch);
    if (params?.sinceSeq !== undefined) query.set('sinceSeq', String(params.sinceSeq));
    const qs = query.toString();
    return request<BotSyncResponse>(`/api/bot-sync${qs ? `?${qs}` : ''}`);
  },
  listBots: (deviceId: string) => request<BotRef[]>(`/api/devices/${id(deviceId)}/bots`),
  createBot: (deviceId: string, body: CenterCreateBotRequest) => request<BotRef>(`/api/devices/${id(deviceId)}/bots`, 'POST', body),
  updateBot: (deviceId: string, botId: string, body: CenterUpdateBotRequest) => request<BotRef>(botPath(deviceId, botId), 'PATCH', body),
  setPrimaryBot: (deviceId: string, botId: string) => request<BotRef>(`${botPath(deviceId, botId)}/primary`, 'POST'),
  archiveBot: (deviceId: string, botId: string) => request<BotRef>(`${botPath(deviceId, botId)}/archive`, 'POST'),
  unarchiveBot: (deviceId: string, botId: string) => request<BotRef>(`${botPath(deviceId, botId)}/unarchive`, 'POST'),
  deleteBot: (deviceId: string, botId: string) => request<void>(botPath(deviceId, botId), 'DELETE'),
  getBotCwd: (deviceId: string, botId: string) => request<BotCwdConfig>(`${botPath(deviceId, botId)}/cwd`),
  putBotCwd: (deviceId: string, botId: string, body: RevisionWrite<string>) => request<BotCwdConfig>(`${botPath(deviceId, botId)}/cwd`, 'PUT', body),
  getBotModelConfig: (deviceId: string, botId: string) => request<BotModelConfig>(`${botPath(deviceId, botId)}/model-config`),
  putBotModelConfig: (deviceId: string, botId: string, body: RevisionWrite<ModelSelection>) => request<BotModelConfig>(`${botPath(deviceId, botId)}/model-config`, 'PUT', body),
  getCredential: (credentialId: string) => request<CredentialInfo>(`/api/credentials/${id(credentialId)}`),
  putCredential: (credentialId: string, body: CredentialWrite) => request<CredentialInfo>(`/api/credentials/${id(credentialId)}`, 'PUT', body),
  deleteCredential: (credentialId: string, body: RevisionWrite<null>) => request<void>(`/api/credentials/${id(credentialId)}`, 'DELETE', body),
  uploadArtifact: (file: File) => { const body = new FormData(); body.append('file', file); return request<ArtifactUploadReceipt>('/api/artifacts', 'POST', body); },
  listCapabilities: () => request<Installation[]>('/api/capabilities'),
  install: (body: InstallRequest) => request<Accepted>('/api/installations', 'POST', body),
  getInstallation: (installationId: string) => request<Installation>(installationPath(installationId)),
  renameInstallation: (installationId: string, body: PutInstallationDisplayName) => request<Installation>(installationPath(installationId), 'PATCH', body),
  patchInstallation: (installationId: string, body: PutInstallationDisplayName) => request<Installation>(installationPath(installationId), 'PATCH', body),
  getBotLearningStatus: (deviceId: string, botId: string) => request<BotLearningStatus>(`${botPath(deviceId, botId)}/learning`, 'POST', { action: 'status' }),
  configureBotLearning: (deviceId: string, botId: string, expectedRevision: number, config: BotLearningPatchConfig) =>
    request<{ settings: BotLearningStatus['settings'] }>(`${botPath(deviceId, botId)}/learning`, 'POST', { action: 'configure', expectedRevision, config }),
  triggerBotLearning: (deviceId: string, botId: string, action: 'curate' | 'review', focus?: string) =>
    request<BotLearningTriggerResult>(`${botPath(deviceId, botId)}/learning`, 'POST', { action, ...(focus ? { focus } : {}) }),
  cancelBotLearning: (deviceId: string, botId: string, jobId: string) =>
    request<{ jobId: string; status: string }>(`${botPath(deviceId, botId)}/learning`, 'POST', { action: 'cancel', jobId }),
  getInstallationConfig: (installationId: string) => request<InstallationConfig>(`${installationPath(installationId)}/config`),
  putInstallationConfig: (installationId: string, body: PutInstallationConfig) => request<InstallationConfig>(`${installationPath(installationId)}/config`, 'PUT', body),
  listBotCapabilities: (deviceId: string, botId: string) => request<BotCapabilityEntry[]>(`${botPath(deviceId, botId)}/capabilities`),
  getBotCapability: (deviceId: string, botId: string, installationId: string) => request<BotCapabilityConfig>(`${botPath(deviceId, botId)}/capabilities/${id(installationId)}`),
  putBotCapability: (deviceId: string, botId: string, installationId: string, body: PutBotCapability) => request<BotCapabilityConfig>(`${botPath(deviceId, botId)}/capabilities/${id(installationId)}`, 'PUT', body),
  validateInstallation: (installationId: string, body: InstallationCheckRequest) => request<ProviderCheckResult>(`${installationPath(installationId)}/validate`, 'POST', body),
  listActions: (installationId: string) => request<ActionDescriptor[]>(`${installationPath(installationId)}/actions`),
  startMcpOAuth: (installationId: string, body: InstallationCheckRequest) => request<McpOAuthStart>(`${installationPath(installationId)}/oauth/start`, 'POST', body),
  getMcpOAuthFlow: (flowId: string) => request<McpOAuthStatus>(`/api/oauth/mcp/flows/${id(flowId)}`),
  logoutMcpOAuth: (installationId: string, body: InstallationCheckRequest) => request<void>(`${installationPath(installationId)}/oauth/logout`, 'POST', body),
  listInstallationTools: (installationId: string, body: InstallationCheckRequest) => request<CapabilityToolsListResponse>(`${installationPath(installationId)}/tools/list`, 'POST', body),
  checkUpdates: (installationId: string) => request<PackageVersion[]>(`${installationPath(installationId)}/updates/check`, 'POST'),
  updateInstallation: (installationId: string, body: UpdateRequest) => request<Accepted>(`${installationPath(installationId)}/update`, 'POST', body),
  rollbackInstallation: (installationId: string, body: OperationRequest) => request<Accepted>(`${installationPath(installationId)}/rollback`, 'POST', body),
  disableInstallation: (installationId: string, body: OperationRequest) => request<Accepted>(`${installationPath(installationId)}/disable`, 'POST', body),
  enableInstallation: (installationId: string, body: EnableRequest) => request<Accepted>(`${installationPath(installationId)}/enable`, 'POST', body),
  uninstallInstallation: (installationId: string, body: OperationRequest) => request<Accepted>(installationPath(installationId), 'DELETE', body),
  runAction: (installationId: string, action: string, body: ActionRequest) => request<ActionResult>(`${installationPath(installationId)}/actions/${id(action)}`, 'POST', body),
  listDeployments: (installationId: string) => request<DeploymentReceipt[]>(`${installationPath(installationId)}/deployments`),
  getOperation: (operationId: string) => request<Operation>(`/api/operations/${id(operationId)}`),
  vaultControl: (body: ExternalVaultControlInput) => request<ExternalVaultControlResult>('/api/vault/control', 'POST', body),
  listClientReleases: () => request<ClientReleaseListResponse>('/api/client-releases'),
  createClientRelease: (metadata: ClientReleaseMetadata, artifact: File) => {
    const body = new FormData();
    body.append('metadata', JSON.stringify(metadata));
    body.append('artifact', artifact);
    return request<ClientReleaseRecord>('/api/client-releases', 'POST', body);
  },
  publishClientRelease: (releaseId: string, body: ClientReleasePublishRequest) =>
    request<ClientReleaseRecord>(`/api/client-releases/${id(releaseId)}/publish`, 'POST', body),
};
