import type {
  Accepted,
  ActionDescriptor,
  ActionRequest,
  ActionResult,
  ActivePairingCodeInfo,
  ApiError,
  ArtifactUploadReceipt,
  BatchModelsRequest,
  BotCapabilityConfig,
  BotCapabilityEntry,
  BotCwdConfig,
  BotLearningPatchConfig,
  BotLearningStatus,
  BotLearningTriggerResult,
  BotModelConfig,
  CapabilityToolsListResponse,
  CenterBotRef,
  CenterBotSyncResponse,
  CenterCreateBotRequest,
  CenterDevice,
  CenterTransport,
  CenterUpdateBotRequest,
  ClientReleaseListResponse,
  ClientReleaseMetadata,
  ClientReleasePublishRequest,
  ClientReleaseRecord,
  CreatePairingCodeResponse,
  CreateWebhookRequest,
  CredentialInfo,
  CredentialWrite,
  DeleteModelResult,
  DeleteProviderResult,
  DeploymentReceipt,
  DeviceRuntimeStatus,
  DiscoveryResult,
  EnableRequest,
  ExternalVaultCheckResult,
  ExternalVaultControlInput,
  ExternalVaultListResult,
  ExternalVaultStatus,
  InstallRequest,
  Installation,
  InstallationBotBindingsResponse,
  InstallationConfig,
  InstallationSkillFilesResponse,
  JsonValue,
  LoginRequest,
  McpOAuthStart,
  McpOAuthStatus,
  Model,
  ModelConfig,
  ModelPickerResponse,
  ModelSelection,
  Operation,
  OperationRequest,
  PackageVersion,
  PairingCaState,
  PairingCodeState,
  Provider,
  ProviderAuthFlow,
  ProviderAuthStatus,
  ProviderCheckRequest,
  ProviderCheckResult,
  PutBotCapability,
  PutInstallationConfig,
  PutInstallationDisplayName,
  PutInstallationSkillFilesRequest,
  QrLoginChallengeResponse,
  QrLoginClaimResponse,
  RevisionWrite,
  SessionInfo,
  SetupRequest,
  SetupStatus,
  UpdateRequest,
  UpdateWebhookRequest,
  WebhookEvent,
  WebhookRoute,
  WebhookTokenReceipt,
} from './types';

export class CenterApiError extends Error {
  code: string;
  status: number;
  details?: JsonValue;

  constructor(code: string, message: string, status: number, details?: JsonValue) {
    super(message);
    this.name = 'CenterApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function t(zh: string, en: string): string {
  return typeof navigator !== 'undefined' && navigator.language.startsWith('en') ? en : zh;
}

export function errorMessage(err: unknown, fallback = t('操作失败', 'Operation failed')): string {
  if (err instanceof CenterApiError) return err.message || fallback;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

const MAX_BROKER_ADMIN_CONCURRENCY = 5;
let activeBrokerAdminCalls = 0;
const brokerAdminWaiters: Array<() => void> = [];

async function withBrokerAdminSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeBrokerAdminCalls >= MAX_BROKER_ADMIN_CONCURRENCY) {
    await new Promise<void>(resolve => {
      brokerAdminWaiters.push(resolve);
    });
  }
  activeBrokerAdminCalls += 1;
  try {
    return await fn();
  } finally {
    activeBrokerAdminCalls -= 1;
    const next = brokerAdminWaiters.shift();
    if (next) next();
  }
}

export function createBrokerCenterTransport(
  brokerCall: (op: string, params: Record<string, unknown>) => Promise<unknown>,
): CenterTransport {
  return {
    async request<T = unknown>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<T> {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        throw new CenterApiError(
          'UNSUPPORTED_FORM_DATA',
          t('当前应用内通道不支持文件直传，请在浏览器中打开中心管理完成上传', 'In-app channel does not support direct file uploads. Open Center Admin in your browser to upload.'),
          400,
        );
      }
      const params: Record<string, unknown> = { method, path };
      if (body !== undefined) params.body = body;
      try {
        const result = await withBrokerAdminSlot(() => brokerCall('center_admin_request', params));
        if (result && typeof result === 'object' && 'error' in result) {
          const maybeErr = (result as ApiError).error;
          if (maybeErr && typeof maybeErr === 'object' && typeof maybeErr.message === 'string') {
            throw new CenterApiError(maybeErr.code || 'BROKER_ERROR', maybeErr.message, 400, maybeErr.details);
          }
        }
        return result as T;
      } catch (err) {
        if (err instanceof CenterApiError) throw err;
        const rec = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
        const code = typeof rec?.code === 'string' ? rec.code : 'BROKER_ERROR';
        const status = typeof rec?.status === 'number' ? rec.status : 500;
        const message = err instanceof Error ? err.message : typeof rec?.message === 'string' ? rec.message : String(err);
        const details = rec && 'details' in rec ? (rec.details as JsonValue) : undefined;
        throw new CenterApiError(code, message || t('中心请求失败', 'Center request failed'), status, details);
      }
    },
  };
}

export interface FetchCenterTransportOptions {
  baseUrl?: string;
  onUnauthorized?: () => void;
  onOffline?: () => void;
}

export interface FetchCenterTransport extends CenterTransport {
  getCsrfToken(): string | null;
  setCsrfToken(token: string | null): void;
}

export function createFetchCenterTransport(options: FetchCenterTransportOptions = {}): FetchCenterTransport {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  let csrfToken: string | null = null;

  return {
    getCsrfToken() {
      return csrfToken;
    },
    setCsrfToken(token: string | null) {
      csrfToken = token;
    },
    async request<T = unknown>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: string,
      body?: unknown,
    ): Promise<T> {
      const headers = new Headers();
      const isPublicQrAuth =
        path === '/api/session' ||
        path === '/api/session/qr' ||
        (path.startsWith('/api/session/qr/') && path.endsWith('/claim'));
      if (method !== 'GET' && !isPublicQrAuth) {
        if (!csrfToken) {
          throw new CenterApiError('CSRF_INVALID', t('会话令牌不可用，请重新连接中心', 'Session token unavailable. Please reconnect to the center.'), 403);
        }
        headers.set('x-csrf-token', csrfToken);
      }
      const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
      if (body !== undefined && !isFormData) {
        headers.set('content-type', 'application/json');
      }

      let response: Response;
      try {
        response = await fetch(`${baseUrl}${path}`, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers,
          body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
        });
      } catch {
        if (options.onOffline) options.onOffline();
        else if (typeof window !== 'undefined') window.dispatchEvent(new Event('center-offline'));
        throw new CenterApiError('CENTER_OFFLINE', t('无法连接中心', 'Unable to connect to center'), 503);
      }

      if (!response.ok) {
        if (response.status === 401 && path !== '/api/session' && !path.startsWith('/api/session/qr')) {
          if (options.onUnauthorized) options.onUnauthorized();
          else if (typeof window !== 'undefined') window.dispatchEvent(new Event('center-unauthenticated'));
        }
        const payload = (await response.json().catch(() => null)) as ApiError | null;
        if (payload?.error?.code === 'CENTER_OFFLINE') {
          if (options.onOffline) options.onOffline();
          else if (typeof window !== 'undefined') window.dispatchEvent(new Event('center-offline'));
        }
        throw new CenterApiError(
          payload?.error?.code || 'HTTP_ERROR',
          payload?.error?.message || t(`请求失败 (${response.status})`, `Request failed (${response.status})`),
          response.status,
          payload?.error?.details,
        );
      }

      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
    },
  };
}

const enc = encodeURIComponent;
const botPath = (deviceId: string, botId: string) => `/api/devices/${enc(deviceId)}/bots/${enc(botId)}`;
const instPath = (installationId: string) => `/api/installations/${enc(installationId)}`;

export function createCenterApi(transport: CenterTransport) {
  const req = <T,>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
    transport.request<T>(method, path, body);

  return {
    // Session & QR Login
    getSession: () => req<SessionInfo>('GET', '/api/session'),
    login: (body: LoginRequest) => req<SessionInfo>('POST', '/api/session', body),
    logout: () => req<void>('DELETE', '/api/session'),
    createQrLogin: () => req<QrLoginChallengeResponse>('POST', '/api/session/qr', {}),
    claimQrLogin: (challengeId: string, browserSecret: string) =>
      req<QrLoginClaimResponse>('POST', `/api/session/qr/${enc(challengeId)}/claim`, { browserSecret }),

    // Models & Providers
    syncModelCatalog: () => req<{ modelsAdded?: number; error: string | null }>('POST', '/api/model-catalog/sync'),
    getModelPicker: () => req<ModelPickerResponse>('GET', '/api/model-picker'),
    setModelStar: (modelRef: string, starred: boolean) =>
      req<{ starredModels: string[] }>('PUT', '/api/model-stars', { modelRef, starred }),
    getModelConfig: () => req<ModelConfig>('GET', '/api/model-config'),
    putModelConfig: (body: RevisionWrite<ModelSelection>) => req<ModelConfig>('PUT', '/api/model-config', body),

    listProviders: () => req<Provider[]>('GET', '/api/providers'),
    createProvider: (body: Provider) => req<Provider>('POST', '/api/providers', body),
    getProvider: (providerId: string) => req<Provider>('GET', `/api/providers/${enc(providerId)}`),
    putProvider: (providerId: string, body: RevisionWrite<Provider>) =>
      req<Provider>('PUT', `/api/providers/${enc(providerId)}`, body),
    deleteProvider: (providerId: string) => req<DeleteProviderResult>('DELETE', `/api/providers/${enc(providerId)}`),
    validateProvider: (providerId: string, body: ProviderCheckRequest = {}) =>
      req<ProviderCheckResult>('POST', `/api/providers/${enc(providerId)}/validate`, body),
    discoverModels: (providerId: string, body: ProviderCheckRequest = {}) =>
      req<DiscoveryResult>('POST', `/api/providers/${enc(providerId)}/discover`, body),
    discoverDraftModels: (body: ProviderCheckRequest) =>
      req<DiscoveryResult>('POST', '/api/providers/discover', body),

    providerAuthStatuses: async (fallbackProviderIds: string[] = []): Promise<Record<string, ProviderAuthStatus>> => {
      try {
        return await req<Record<string, ProviderAuthStatus>>('GET', '/api/provider-auth-status');
      } catch (err) {
        if (!(err instanceof CenterApiError) || err.status !== 404) throw err;
        if (fallbackProviderIds.length === 0) return {};
        const entries = await Promise.all(
          fallbackProviderIds.map(id =>
            req<ProviderAuthStatus>('GET', `/api/providers/${enc(id)}/auth-status`)
              .then(st => [id, st] as const)
              .catch(() => null),
          ),
        );
        const out: Record<string, ProviderAuthStatus> = {};
        for (const entry of entries) {
          if (entry) out[entry[0]] = entry[1];
        }
        return out;
      }
    },
    providerAuthStatus: (providerId: string) =>
      req<ProviderAuthStatus>('GET', `/api/providers/${enc(providerId)}/auth-status`),
    providerLogin: (providerId: string) =>
      req<{ flowId: string }>('POST', `/api/providers/${enc(providerId)}/login`),
    providerLoginStatus: (providerId: string, flowId: string) =>
      req<ProviderAuthFlow>('GET', `/api/providers/${enc(providerId)}/login/${enc(flowId)}`),
    providerLoginAnswer: (providerId: string, flowId: string, answer: string) =>
      req<{ accepted: boolean }>('POST', `/api/providers/${enc(providerId)}/login/${enc(flowId)}/answer`, { answer }),
    providerLoginCancel: (providerId: string, flowId: string) =>
      req<{ status: string }>('POST', `/api/providers/${enc(providerId)}/login/${enc(flowId)}/cancel`),
    providerLogout: (providerId: string) =>
      req<ProviderAuthStatus>('POST', `/api/providers/${enc(providerId)}/logout`),

    listModels: (providerId: string, includeRemoved = false) =>
      req<Model[]>('GET', `/api/providers/${enc(providerId)}/models${includeRemoved ? '?includeRemoved=1' : ''}`),
    createModel: (providerId: string, body: Model) =>
      req<Model>('POST', `/api/providers/${enc(providerId)}/models`, body),
    createModelsBatch: (providerId: string, body: BatchModelsRequest) =>
      req<{ models: Model[] }>('POST', `/api/providers/${enc(providerId)}/models/batch`, body),
    putModel: (providerId: string, modelId: string, body: RevisionWrite<Model>) =>
      req<Model>('PUT', `/api/providers/${enc(providerId)}/models/${enc(modelId)}`, body),
    deleteModel: (providerId: string, modelId: string) =>
      req<DeleteModelResult>('DELETE', `/api/providers/${enc(providerId)}/models/${enc(modelId)}`),

    // Credentials
    getCredential: (credentialId: string) => req<CredentialInfo>('GET', `/api/credentials/${enc(credentialId)}`),
    putCredential: (credentialId: string, body: CredentialWrite) =>
      req<CredentialInfo>('PUT', `/api/credentials/${enc(credentialId)}`, body),
    deleteCredential: (credentialId: string, body: RevisionWrite<null>) =>
      req<void>('DELETE', `/api/credentials/${enc(credentialId)}`, body),

    // Capabilities & Installations
    uploadArtifact: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return req<ArtifactUploadReceipt>('POST', '/api/artifacts', body);
    },
    listCapabilities: () => req<Installation[]>('GET', '/api/capabilities'),
    install: (body: InstallRequest) => req<Accepted>('POST', '/api/installations', body),
    getInstallation: (installationId: string) => req<Installation>('GET', instPath(installationId)),
    patchInstallation: (installationId: string, body: PutInstallationDisplayName) =>
      req<Installation>('PATCH', instPath(installationId), body),
    getInstallationConfig: (installationId: string) =>
      req<InstallationConfig>('GET', `${instPath(installationId)}/config`),
    putInstallationConfig: (installationId: string, body: PutInstallationConfig) =>
      req<InstallationConfig>('PUT', `${instPath(installationId)}/config`, body),
    getInstallationSkillFiles: (installationId: string) =>
      req<InstallationSkillFilesResponse>('GET', `${instPath(installationId)}/skill-files`),
    putInstallationSkillFiles: (installationId: string, body: PutInstallationSkillFilesRequest) =>
      req<InstallationSkillFilesResponse>('PUT', `${instPath(installationId)}/skill-files`, body),
    validateInstallation: (installationId: string, body: { deviceId: string; botId: string }) =>
      req<ProviderCheckResult>('POST', `${instPath(installationId)}/validate`, body),
    listActions: (installationId: string) => req<ActionDescriptor[]>('GET', `${instPath(installationId)}/actions`),
    runAction: (installationId: string, action: string, body: ActionRequest) =>
      req<ActionResult>('POST', `${instPath(installationId)}/actions/${enc(action)}`, body),
    startMcpOAuth: (installationId: string, body: { deviceId: string; botId: string }) =>
      req<McpOAuthStart>('POST', `${instPath(installationId)}/oauth/start`, body),
    getMcpOAuthFlow: (flowId: string) => req<McpOAuthStatus>('GET', `/api/oauth/mcp/flows/${enc(flowId)}`),
    logoutMcpOAuth: (installationId: string, body: { deviceId: string; botId: string }) =>
      req<void>('POST', `${instPath(installationId)}/oauth/logout`, body),
    listInstallationTools: (installationId: string, body: { deviceId: string; botId: string }) =>
      req<CapabilityToolsListResponse>('POST', `${instPath(installationId)}/tools/list`, body),
    checkUpdates: (installationId: string) => req<PackageVersion[]>('POST', `${instPath(installationId)}/updates/check`),
    updateInstallation: (installationId: string, body: UpdateRequest) =>
      req<Accepted>('POST', `${instPath(installationId)}/update`, body),
    enableInstallation: (installationId: string, body: EnableRequest) =>
      req<Accepted>('POST', `${instPath(installationId)}/enable`, body),
    disableInstallation: (installationId: string, body: OperationRequest) =>
      req<Accepted>('POST', `${instPath(installationId)}/disable`, body),
    uninstallInstallation: (installationId: string, body: OperationRequest) =>
      req<Accepted>('DELETE', instPath(installationId), body),
    listDeployments: (installationId: string) =>
      req<DeploymentReceipt[]>('GET', `${instPath(installationId)}/deployments`),
    getOperation: (operationId: string) => req<Operation>('GET', `/api/operations/${enc(operationId)}`),

    // Devices, Pairing, OAuth Grants & Bots
    listDevices: () => req<CenterDevice[]>('GET', '/api/devices'),
    getDeviceRuntimeStatus: (deviceId: string) =>
      req<DeviceRuntimeStatus>('GET', `/api/devices/${enc(deviceId)}/runtime-status`),
    renameDevice: (deviceId: string, name: string) =>
      req<CenterDevice>('PATCH', `/api/devices/${enc(deviceId)}`, { name }),
    deleteDevice: (deviceId: string) => req<void>('DELETE', `/api/devices/${enc(deviceId)}`),
    setDeviceOAuthGrant: (deviceId: string, enabled: boolean) =>
      req<CenterDevice>('PUT', `/api/devices/${enc(deviceId)}/oauth-grant`, { enabled }),

    listActivePairingCodes: async (): Promise<ActivePairingCodeInfo[]> => {
      try {
        const res = await req<{ items?: ActivePairingCodeInfo[]; codes?: ActivePairingCodeInfo[] } | ActivePairingCodeInfo[]>(
          'GET',
          '/api/pairing-codes/active',
        );
        if (Array.isArray(res)) return res;
        return res.items ?? res.codes ?? [];
      } catch (err) {
        if (err instanceof CenterApiError && err.status === 404) return [];
        throw err;
      }
    },
    createPairingCode: (deviceId?: string) =>
      req<CreatePairingCodeResponse>('POST', '/api/pairing-codes', deviceId === undefined ? {} : { deviceId }),
    getPairingCode: (codeId: string) => req<PairingCodeState>('GET', `/api/pairing-codes/${enc(codeId)}`),
    revokePairingCode: (codeId: string) => req<void>('DELETE', `/api/pairing-codes/${enc(codeId)}`),
    getPairingCa: () => req<PairingCaState>('GET', '/api/pairing/ca'),
    putPairingCa: (ca: string | null) => req<PairingCaState>('PUT', '/api/pairing/ca', { ca }),

    getBotSync: (params?: { epoch?: string; sinceSeq?: number }) => {
      const query = new URLSearchParams();
      if (params?.epoch) query.set('epoch', params.epoch);
      if (params?.sinceSeq !== undefined) query.set('sinceSeq', String(params.sinceSeq));
      const qs = query.toString();
      return req<CenterBotSyncResponse>('GET', `/api/bot-sync${qs ? `?${qs}` : ''}`);
    },
    listBots: (deviceId: string) => req<CenterBotRef[]>('GET', `/api/devices/${enc(deviceId)}/bots`),
    createBot: (deviceId: string, body: CenterCreateBotRequest) =>
      req<CenterBotRef>('POST', `/api/devices/${enc(deviceId)}/bots`, body),
    updateBot: (deviceId: string, botId: string, body: CenterUpdateBotRequest) =>
      req<CenterBotRef>('PATCH', botPath(deviceId, botId), body),
    setPrimaryBot: (deviceId: string, botId: string) => req<CenterBotRef>('POST', `${botPath(deviceId, botId)}/primary`),
    archiveBot: (deviceId: string, botId: string) => req<CenterBotRef>('POST', `${botPath(deviceId, botId)}/archive`),
    unarchiveBot: (deviceId: string, botId: string) => req<CenterBotRef>('POST', `${botPath(deviceId, botId)}/unarchive`),
    deleteBot: (deviceId: string, botId: string) => req<void>('DELETE', botPath(deviceId, botId)),

    getBotCwd: (deviceId: string, botId: string) => req<BotCwdConfig>('GET', `${botPath(deviceId, botId)}/cwd`),
    putBotCwd: (deviceId: string, botId: string, body: RevisionWrite<string>) =>
      req<BotCwdConfig>('PUT', `${botPath(deviceId, botId)}/cwd`, body),
    getBotModelConfig: (deviceId: string, botId: string) =>
      req<BotModelConfig>('GET', `${botPath(deviceId, botId)}/model-config`),
    putBotModelConfig: (deviceId: string, botId: string, body: RevisionWrite<ModelSelection>) =>
      req<BotModelConfig>('PUT', `${botPath(deviceId, botId)}/model-config`, body),

    listBotCapabilities: (deviceId: string, botId: string) =>
      req<BotCapabilityEntry[]>('GET', `${botPath(deviceId, botId)}/capabilities`),
    getInstallationBotBindings: async (
      installationId: string,
      fallbackBots: Array<{ deviceId: string; botId: string }> = [],
    ): Promise<Record<string, BotCapabilityConfig>> => {
      try {
        const res = await req<InstallationBotBindingsResponse>('GET', `${instPath(installationId)}/bot-bindings`);
        return res.bindings ?? {};
      } catch (err) {
        if (!(err instanceof CenterApiError) || err.status !== 404) throw err;
        if (fallbackBots.length === 0) return {};
        const entries = await Promise.all(
          fallbackBots.map(b =>
            req<BotCapabilityConfig>('GET', `${botPath(b.deviceId, b.botId)}/capabilities/${enc(installationId)}`)
              .then(cfg => [`${b.deviceId}:${b.botId}`, cfg] as const)
              .catch(() => null),
          ),
        );
        const out: Record<string, BotCapabilityConfig> = {};
        for (const entry of entries) {
          if (entry) out[entry[0]] = entry[1];
        }
        return out;
      }
    },
    getBotCapability: (deviceId: string, botId: string, installationId: string) =>
      req<BotCapabilityConfig>('GET', `${botPath(deviceId, botId)}/capabilities/${enc(installationId)}`),
    putBotCapability: (deviceId: string, botId: string, installationId: string, body: PutBotCapability) =>
      req<BotCapabilityConfig>('PUT', `${botPath(deviceId, botId)}/capabilities/${enc(installationId)}`, body),

    getBotLearningStatus: (deviceId: string, botId: string) =>
      req<BotLearningStatus>('POST', `${botPath(deviceId, botId)}/learning`, { action: 'status' }),
    configureBotLearning: (deviceId: string, botId: string, expectedRevision: number, config: BotLearningPatchConfig) =>
      req<{ settings: BotLearningStatus['settings'] }>('POST', `${botPath(deviceId, botId)}/learning`, {
        action: 'configure',
        expectedRevision,
        config,
      }),
    triggerBotLearning: (deviceId: string, botId: string, action: 'curate' | 'review', focus?: string) =>
      req<BotLearningTriggerResult>('POST', `${botPath(deviceId, botId)}/learning`, {
        action,
        ...(focus ? { focus } : {}),
      }),
    cancelBotLearning: (deviceId: string, botId: string, jobId: string) =>
      req<{ jobId: string; status: string }>('POST', `${botPath(deviceId, botId)}/learning`, {
        action: 'cancel',
        jobId,
      }),

    // Vault
    vaultControl: <T = ExternalVaultStatus | ExternalVaultListResult | ExternalVaultCheckResult>(
      body: ExternalVaultControlInput,
    ) => req<T>('POST', '/api/vault/control', body),

    // Webhooks
    listWebhooks: () => req<{ items: WebhookRoute[] }>('GET', '/api/webhooks'),
    createWebhook: (body: CreateWebhookRequest) => req<WebhookTokenReceipt>('POST', '/api/webhooks', body),
    updateWebhook: (routeId: string, body: UpdateWebhookRequest) =>
      req<WebhookRoute>('PUT', `/api/webhooks/${enc(routeId)}`, body),
    rotateWebhookToken: (routeId: string) =>
      req<WebhookTokenReceipt>('POST', `/api/webhooks/${enc(routeId)}/rotate-token`, {}),
    deleteWebhook: (routeId: string) => req<void>('DELETE', `/api/webhooks/${enc(routeId)}`),
    listWebhookEvents: (routeId: string) => req<{ items: WebhookEvent[] }>('GET', `/api/webhooks/${enc(routeId)}/events`),

    // Client Releases
    listClientReleases: () => req<ClientReleaseListResponse>('GET', '/api/client-releases'),
    createClientRelease: (metadata: ClientReleaseMetadata, artifact: File) => {
      const body = new FormData();
      body.append('metadata', JSON.stringify(metadata));
      body.append('artifact', artifact);
      return req<ClientReleaseRecord>('POST', '/api/client-releases', body);
    },
    publishClientRelease: (releaseId: string, body: ClientReleasePublishRequest) =>
      req<ClientReleaseRecord>('POST', `/api/client-releases/${enc(releaseId)}/publish`, body),
  };
}

export type CenterApi = ReturnType<typeof createCenterApi>;

export type { SetupStatus, SetupRequest };
