/** Shared wire data only: no Node, Android, React or server imports. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export type JsonSchema = boolean | JsonObject;
export type CapabilityKind = 'plugin' | 'mcp' | 'skill';
export type DeploymentPhase = 'queued' | 'downloading' | 'preparing' | 'waiting-idle' | 'activating' | 'applied' | 'failed' | 'removed';
export type HealthState = 'ready' | 'disconnected' | 'needs-auth' | 'unsupported' | 'disabled';
/** Hosts report applying/waiting-idle/applied/failed; the center derives pending itself. */
export type RuntimeApplyStatus = 'pending' | 'applying' | 'waiting-idle' | 'applied' | 'failed';
/** 'enabling' means the center is still preparing or validating a global enable request. */
export type ActivationStatus = 'disabled' | 'enabling' | 'enabled' | 'failed';
export const CAPABILITY_PROTOCOL: 1;
export const CAPABILITY_KINDS: readonly CapabilityKind[];
export const DEPLOYMENT_PHASES: readonly DeploymentPhase[];
export const HEALTH_STATES: readonly HealthState[];
export const RUNTIME_APPLY_STATUSES: readonly RuntimeApplyStatus[];
export const ACTIVATION_STATUSES: readonly ActivationStatus[];

/** Error messages and details must never contain credentials. */
export interface ApiError { error: { code: string; message: string; details?: JsonValue } }
export interface Accepted { operationId: string }
export interface RevisionWrite<T> { expectedRevision: number; value: T }
export interface CredentialInfo { credentialId: string; configured: boolean; revision: number }
export interface Provider {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  credentialRef: string | null;
  enabled: boolean;
  revision: number;
}
/** Fields retain runtime-models names; model-specific optional values remain JSON. */
export interface Model {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  reasoning: boolean;
  thinkingLevelMap?: JsonObject;
  cost?: JsonObject;
  compat?: JsonObject;
  inputLimits?: JsonObject;
  enabled: boolean;
  revision: number;
}
export interface ModelSelection { modelRef?: string | null; thinkingLevel?: string | null; codemode?: boolean | null; codemodeOnly?: boolean | null }
export interface ModelConfig { global: ModelSelection; revision: number }
export interface BotModelConfig { global: ModelSelection; overrides: ModelSelection; effective: ModelSelection; revision: number }
export interface ActionDescriptor {
  id: string;
  title: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}
export interface NativeManifest {
  manifestVersion: 1;
  id: string;
  version: string;
  kind: 'plugin';
  displayName: string;
  hostApi: string;
  durableApi: string;
  components: { host?: { entry: string }; center?: { entry: string } };
  platforms: ('windows' | 'linux' | 'android')[];
  configSchema: string;
  uiSchema?: string;
  stateVersion?: number;
  skills?: string[];
  actions?: ActionDescriptor[];
  contributions?: ('tools' | 'context' | 'background' | 'actions')[];
}
export interface PackageVersion {
  packageId: string;
  version: string;
  kind: CapabilityKind;
  digest: string;
  artifactRef: string | null;
  manifest: JsonObject;
  configSchema: JsonSchema;
  uiSchema?: JsonObject;
  resolved: string | null;
  integrity: string | null;
}
export interface Installation {
  installationId: string;
  packageId: string;
  displayName: string;
  kind: CapabilityKind;
  source: InstallSource;
  target: 'center' | 'host';
  targetVersion: string;
  /** Global intent; effective authorization also needs `activation.status === 'enabled'`. */
  enabled: boolean;
  revision: number;
  activation: InstallationActivation;
}
/** Center-owned global readiness of an installation: only 'enabled' authorizes Bots. */
export interface InstallationActivation {
  status: ActivationStatus;
  error: ApiError['error'] | null;
  updatedAt: string | null;
}
export interface InstallationConfig {
  globalConfig: JsonObject;
  configSchema: JsonSchema;
  uiSchema?: JsonObject;
  revision: number;
}
export interface PutInstallationConfig { expectedRevision: number; globalConfig: JsonObject }
export interface BotBinding {
  deviceId: string;
  botId: string;
  installationId: string;
  enabled: boolean;
  overrides: JsonObject;
  revision: number;
}
export interface BotCapabilityConfig extends BotBinding {
  globalConfig: JsonObject;
  effectiveConfig: JsonObject;
  configSchema: JsonSchema;
}
export interface PutBotCapability { expectedRevision: number; enabled: boolean; overrides: JsonObject }
export interface Device { deviceId: string; name: string; online: boolean }
export type DevicePlatform = 'windows' | 'linux' | 'macos' | 'android';
/** Owner-only `POST /api/devices` body; displayName is trimmed to 1..64 characters. */
export interface CreateDeviceRequest { displayName: string; platform: DevicePlatform }
/** `201` reply; deviceToken (32 random bytes, base64url) is returned only once. */
export interface CreateDeviceResponse { deviceId: string; deviceToken: string; displayName: string; platform: DevicePlatform }
export interface BotAvatar {
  id: string;
  shape: string;
  color: string;
  rotation: number;
  expressionIndex: number;
  labelZh: string;
  labelEn: string;
}
export interface BotAvatarConfig { value: BotAvatar | null; revision: number }
/**
 * Center-authoritative working directory for a Bot: GET/PUT
 * /api/devices/:deviceId/bots/:botId/cwd ({value,revision} / {expectedRevision,value}).
 * The value is a non-empty absolute path on the target Host; Host directory reports
 * never carry cwd — a missing value is initialized once through the CAS write with
 * expectedRevision:0, and an existing center value is never overwritten by reports.
 * Applies on the Host at the next idle boundary; running turns keep the pinned
 * directory and no files are moved.
 */
export interface BotCwdConfig { value: string | null; revision: number }
export interface BotRef {
  avatar?: BotAvatar | null;
  avatarRevision?: number;
  cwdRevision?: number;
  deviceId: string;
  botId: string;
  name: string;
  description?: string;
  cwd?: string;
  modelRef?: string | null;
  primaryConversationId?: string;
  createdAt?: string;
  isPrimary?: boolean;
  lastActivityAt?: string | null;
  lastPreview?: string | null;
  archivedAt?: string | null;
  deviceName?: string;
  platform?: string;
  online?: boolean;
  seq?: number;
}
export interface BotSyncEvent {
  seq: number;
  deviceId: string;
  botId: string;
  op: 'upsert' | 'delete';
  bot: BotRef | null;
  updatedAt: string;
}
export interface BotSyncResponse {
  epoch: string;
  seq: number;
  mode: 'snapshot' | 'diff';
  devices: Device[];
  bots?: BotRef[];
  events?: BotSyncEvent[];
}
export interface CenterCreateBotRequest {
  requestId?: string;
  role: string;
  description?: string;
  cwd?: string;
  makePrimary?: boolean;
}
export interface CenterUpdateBotRequest {
  name?: string;
  description?: string;
}
export interface DeploymentReceipt {
  /** null denotes the center execution target; otherwise the assigned Host. */
  deviceId: string | null;
  installationId: string;
  operationId: string;
  planId: string;
  desiredRevision: number;
  appliedRevision: number | null;
  actualVersion: string | null;
  phase: DeploymentPhase;
  health: HealthState;
  error: ApiError['error'] | null;
}
export interface Operation {
  operationId: string;
  requestId: string;
  action: 'install' | 'update' | 'enable' | 'disable' | 'uninstall' | 'rollback';
  installationId: string;
  /** Empty for center; Host-targeted operations may have multiple device receipts. */
  deviceIds: string[];
  target: 'center' | 'host';
  phase: DeploymentPhase;
  error: ApiError['error'] | null;
}
export type InstallSource =
  | { type: 'npm'; spec: string }
  | { type: 'artifact'; artifactRef: string }
  | { type: 'http'; url: string };
export interface InstallRequest { requestId: string; displayName: string; kind: CapabilityKind; source: InstallSource; target: 'center' | 'host' }
export interface OperationRequest { requestId: string }
/** Global enable may name an existing Bot as the OAuth validation identity for center MCP. */
export interface EnableRequest extends OperationRequest {
  validationBot?: { deviceId: string; botId: string };
}
export interface UpdateRequest extends OperationRequest {
  targetVersion: string;
  source?: { type: 'artifact'; artifactRef: string };
}
export interface DeploymentPlan {
  protocol: 1;
  target: 'center' | 'host';
  deviceId: string | null;
  operationId: string;
  planId: string;
  desiredRevision: number;
  installationId: string;
  packageId: string;
  manifest: JsonObject;
  kind: CapabilityKind;
  targetVersion: string;
  artifactRef: string | null;
  digest: string | null;
  resolved: string | null;
  integrity: string | null;
  /** npm lockfile contents when target-platform dependency installation is required. */
  lockfile: JsonObject | null;
  action: 'install' | 'update' | 'enable' | 'disable' | 'uninstall' | 'rollback';
}
export interface EffectiveCapability {
  installationId: string;
  kind: CapabilityKind;
  target: 'center' | 'host';
  targetVersion: string;
  enabled: boolean;
  revision: number;
  effectiveConfig: JsonObject;
  /** Credential IDs referenced by this Bot's effective capability config. */
  credentialRefs: string[];
  /**
   * Effective execution authorization: global intent enabled AND Bot binding on AND
   * installation exists — derived independently of transient rollout readiness.
   * Required on new snapshots; legacy readers fall back to `enabled` when absent.
   */
  authorized?: boolean;
  /** Referenced credential IDs → revision for revocation comparison; values are never emitted. */
  credentialRevisions?: Record<string, number>;
}
export interface RuntimeBot {
  botId: string;
  /** Center-authoritative absolute working directory on this Host; absent on legacy centers. */
  cwd?: string;
  model: ModelSelection;
  capabilities: EffectiveCapability[];
}
/** Secrets are available only to the authenticated assigned device, in memory. */
export interface DeviceRuntimeSnapshot {
  protocol: 1;
  deviceId: string;
  revision: number;
  linkUrl: string;
  providers: Provider[];
  models: Record<string, Model[]>;
  bots: RuntimeBot[];
  credentials: Record<string, string>;
}
/** Per-Bot outcome inside a runtime receipt. */
export interface RuntimeBotReceipt {
  botId: string;
  desiredRevision: number;
  appliedRevision: number | null;
  status: RuntimeApplyStatus;
  error: ApiError['error'] | null;
}
export interface RuntimeCapabilityError {
  botId: string;
  installationId: string;
  error: ApiError['error'];
}
/** `revision` is the desired snapshot revision the target is reporting on. */
export interface RuntimeReceipt {
  deviceId: string;
  revision: number;
  status: 'applying' | 'waiting-idle' | 'applied' | 'failed';
  error: ApiError['error'] | null;
  appliedRevision?: number | null;
  bots?: RuntimeBotReceipt[];
  capabilityErrors?: RuntimeCapabilityError[];
}
/** Center-side aggregate of desired configuration and the latest accepted receipt. */
export interface DeviceRuntimeStatus {
  deviceId: string;
  online: boolean;
  desiredRevision: number;
  appliedRevision: number | null;
  status: RuntimeApplyStatus;
  /** Server time when the current desired configuration took effect. */
  updatedAt: string | null;
  /** Server time when the target reported the current desired revision as applied. */
  appliedAt: string | null;
  error: ApiError['error'] | null;
  bots: RuntimeBotReceipt[];
  capabilityErrors: RuntimeCapabilityError[];
}
export interface BotCapabilityEntry {
  installation: Installation;
  config: BotCapabilityConfig;
  uiSchema?: JsonObject;
}

/**
 * Per-turn admission wire types: POST /api/host/turns/{prepare,confirm,restore}.
 * Center is authoritative for the complete per-Bot executable set; no model/tool
 * execution may start before confirm (or an atomic prepare grant) returns a grant.
 */
export interface TurnPrepareRequest {
  botId: string;
  /** Stable request identity; same ID with a different inputDigest is a conflict. */
  requestId: string;
  /** Stable trusted Host scope: 'primary' or an existing work binding/scope key. */
  scopeKey: string;
  inputDigest: string;
  /** Set only when the Host knows the complete set is already locally loaded/ready. */
  knownSetId?: string;
}

export interface TurnConfirmRequest {
  botId: string;
  requestId: string;
  scopeKey: string;
  inputDigest: string;
  setId: string;
}

export interface TurnRestoreRequest {
  botId: string;
  admissionId: string;
}

/** Idempotent admission record; its setId pins the code/config the turn may run. */
export interface TurnAdmissionGrant {
  admissionId: string;
  setId: string;
  admittedAt: string;
}

export interface TurnPreparation {
  protocol: 1;
  botId: string;
  /** Identity of the complete desired per-Bot executable set. */
  setId: string;
  /** Device snapshot with this Bot selected/configured for the set. */
  snapshot: DeviceRuntimeSnapshot;
  /** Exact installation plans this Bot still needs (existing plan shape). */
  plans: DeploymentPlan[];
  /** Present only when prepare could atomically grant because knownSetId was current. */
  admission?: TurnAdmissionGrant;
}
export interface PutInstallationDisplayName { expectedRevision: number; displayName: string }
/**
 * Host directory report entry: BotRef without the center-authoritative fields
 * (cwd/cwdRevision/avatar/avatarRevision). Bootstrap and bots-sync reports carry
 * directory/status fields only; the center keeps its own values and ignores any
 * such fields a legacy Host still sends.
 */
export type HostBotReport = Omit<BotRef, 'cwd' | 'cwdRevision' | 'avatar' | 'avatarRevision'>;
export interface BootstrapRequest { deviceId: string; capabilityProtocol: 1; bots: HostBotReport[] }
export interface BootstrapResponse { snapshot: DeviceRuntimeSnapshot }
export interface CapabilityToolsListRequest { botId: string }
export interface CapabilityTool { name: string; description?: string; inputSchema: JsonObject }
export interface CapabilityToolsListResponse { tools: CapabilityTool[] }
export interface CapabilityToolCallRequest { botId: string; name: string; args: JsonObject; callId: string }
export interface CapabilityToolCallResponse { content: JsonObject[]; isError?: boolean; structuredContent?: JsonObject }
export interface ArtifactUploadReceipt { artifactRef: string; digest: string; size: number }
export interface CenterConnectionStatus {
  state: 'disconnected' | 'connecting' | 'ready';
  centerUrl: string;
  appliedRevision: number | null;
  error: ApiError['error'] | null;
}
export interface SessionInfo { authenticated: boolean; csrfToken: string | null }
export interface LoginRequest { password: string }
export interface CredentialWrite { value: string; expectedRevision: number | null }
export interface ProviderCheckRequest { deviceId: string }
/** Trusted owner-initiated Host probe; credential is transient and never persisted. */
export interface ProviderProbeRequest { provider: Provider; models: Model[]; credential?: string }
export interface InstallationCheckRequest { deviceId: string; botId: string }
export interface OAuthStartRequest { deviceId: string; botId: string }
export interface OAuthStartResponse { flowId: string; authorizationUrl: string }
export interface OAuthFlowState { status: 'pending' | 'complete' | 'failed'; error?: string }
export interface ProviderCheckResult { ok: boolean; message: string }
export interface DiscoveryResult { models: Model[] }
export interface ActionRequest { requestId: string; deviceId: string; botId: string; input: JsonValue }
export interface ActionResult { result: JsonValue }

/**
 * Center-managed client release records (client-releases API, plan §7).
 *
 * POST /api/client-releases takes multipart FormData: field 'metadata' carries a
 * JSON-encoded ClientReleaseMetadata, field 'artifact' the installer file. The
 * server validates the artifact against the metadata, computes sha256, and
 * stores the record as unpublished (draft) until an owner publishes it.
 * GET /api/client-releases returns { releases: ClientReleaseRecord[] }.
 * POST /api/client-releases/:id/publish takes { published: boolean } and returns
 * the updated record. GET /api/client-releases/:id/download streams the
 * installer to authenticated owners via record.downloadUrl.
 */
export type ClientReleasePlatform = 'windows' | 'linux' | 'android';
export type ClientReleaseArch = 'x86_64' | 'aarch64';
export type ClientReleaseFormat = 'nsis' | 'deb' | 'apk';

/**
 * Metadata the CI build exports for import into the center admin UI. The
 * platform/arch/format combination is restricted: windows+x86_64+nsis,
 * linux+x86_64+deb, android+aarch64/x86_64+apk.
 */
export interface ClientReleaseMetadata {
  version: string;
  platform: ClientReleasePlatform;
  arch: ClientReleaseArch;
  format: ClientReleaseFormat;
  /** Installer size in bytes, as reported by CI; must match the uploaded artifact. */
  size: number;
  /** Lowercase hex SHA-256 of the installer. */
  sha256: string;
  /** Optional detached signature text (e.g. .sig contents) for desktop packages. */
  signature?: string;
  /** Optional release notes shown to administrators. */
  notes?: string;
  /** Source commit the build was produced from. */
  sourceCommit: string;
  /** Android-only monotonically increasing versionCode; required for apk. */
  versionCode?: number;
}

/** Stored release record: metadata plus server-assigned fields. */
export interface ClientReleaseRecord extends ClientReleaseMetadata {
  id: string;
  filename: string;
  published: boolean;
  publishedAt: string | null;
  /** Same-origin download path for the installer; owner session required. */
  downloadUrl: string;
}

export interface ClientReleaseListResponse { releases: ClientReleaseRecord[] }
export interface ClientReleasePublishRequest { published: boolean }
