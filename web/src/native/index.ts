import type {
  BotSoul,
  HindsightOptions as SharedHindsightOptions,
  HistoryEntryChunk,
  RuntimeExtensionsConfig,
} from '../../../host-core/index.js';
import type {
  AbortBotResult,
  Attribution,
  BotActivity,
  BotLiveEnd,
  BotLiveSnapshot,
  BotLiveState,
  BotLiveUpdate,
  LiveGeneration,
  QueuedTurnItem,
  RemoteControlOutcome,
  SteerQueuedResult,
  TurnDeliveryMode,
  WithdrawQueuedResult,
  WithdrawnTurnItem,
  WorkLiveEnd,
  WorkLiveSnapshot,
} from '../../../host-core/index.js';
import { createTauriBotHost, mobileLocalRequest } from './tauri-host';

export interface PluginListenerHandle { remove(): Promise<void>; readonly removed?: Promise<void> }
type ListenerPromise = Promise<PluginListenerHandle>;

export type HostPhase = 'stopped'|'starting'|'running'|'stopping'|'failed';
export type HostSnapshot = { phase: HostPhase; deviceId: string|null; lastUpdated: number; errorCode: string|null; restartRequired: boolean; workspace?: string|null };
export type CenterConnectionStatus = { state: 'disconnected' | 'connecting' | 'ready'; centerUrl: string; appliedRevision: number | null; error: {code: string; message: string} | null };
export type CenterSettings = { url: string; ca: string; tokenConfigured: boolean };
/** C7 首启配对（mobileLocalRequest('pairCenter')）：owner 密码只经原生换绑定，结果不含任何 token。 */
export type PairCenterResult = {
  centerUrl: string;
  deviceId: string;
  displayName: string;
  /** 原生已完成设备登记并保存 Host/client 凭据；true 时可用已存凭据重连，不得重复登记。 */
  hostConfigured: boolean;
  /** 原生已请求既有连接入口；不等于已就绪，真实状态仍由 center_status 轮询判定。 */
  connectionRequested: boolean;
  warnings?: { code: string; message: string }[];
};
/** C7 权限/后台真实状态（mobileLocalRequest('onboardingStatus')）：只查询，不启动服务或授权。 */
export type OnboardingStatus = {
  notificationsGranted: boolean;
  batteryUnrestricted: boolean;
  shizukuInstalled: boolean;
  shizukuRunning: boolean;
  shizukuGranted: boolean;
};
/** C7 权限动作（mobileLocalRequest('onboardingAction')）：仅发起系统请求/页面，requested 不代表已授权。 */
export type OnboardingActionName = 'notifications' | 'battery-settings' | 'shizuku-permission' | 'shizuku-manager';
export type HostStatus = HostSnapshot & { center?: CenterConnectionStatus };
export type HostSettingsModel = {
  id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number;
  /** Pass-through 字段原样交给 SDK/原生工具，Host 回读时可能已按规范补全默认值。 */
  input?: ('text'|'image')[];
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string|null>;
  inputLimits?: Record<string, unknown>;
};
export type HostProviderConfig = { id: string; name?: string; api?: string; baseUrl: string; apiKeyEnv?: string; models: HostSettingsModel[] };
export type HostRelayConfig = { url: string; tokenEnv: string; caFile?: string };
// Canonical SOUL/extension DTOs are declared once in host-core/index.d.ts and
// re-exported here for the local Host UI (types only, no runtime import).
export type { BotSoul, RuntimeExtensionsConfig };
/** Connection config; unset timeouts keep the Host defaults (30s / reflect 120s). */
export type HostHindsightConfig = SharedHindsightOptions & { timeoutMs?: number; reflectTimeoutMs?: number };
export type HostRuntimeSettings = {
  providers: HostProviderConfig[];
  defaultModel?: string | null;
  /** 默认思考档位；缺省/null 交给 SDK 默认值。 */
  thinkingLevel?: string | null;
  /** Canonical extension config; legacy `hindsight` may still appear on readback. */
  extensions?: RuntimeExtensionsConfig;
  hindsight?: HostHindsightConfig;
  bashPath?: string;
  toolPaths?: {rg?: string; fd?: string};
};
export type HostSettings = { runtime: HostRuntimeSettings; relay: HostRelayConfig|null };
export type HostSettingsPayload = { deviceId: string; revision: number; settings: HostSettings; activeRevision?: number; restartRequired?: boolean };
export interface HostBot {
  botId: string;
  deviceId: string;
  role: string;
  description?: string;
  cwd: string;
  /** Center CAS revision for the authoritative cwd (absent on legacy/local records). */
  cwdRevision?: number;
  modelRef: string | null;
  primaryConversationId: string;
  createdAt: string;
  isPrimary?: boolean;
  lastActivityAt?: string | null;
  lastPreview?: string | null;
  archivedAt?: string | null;
}
export type TurnAdmissionStatus = {
  requestId: string;
  phase: 'queued'|'checking'|'synchronizing'|'failed';
  source?: 'primary' | 'background';
  error?: { code: string; message: string };
};
// A queued receipt is acceptance, not execution: conversationId/submissionId are
// null while the turn waits on Center admission.
export type HostSubmission = { botId: string; conversationId: string|null; requestId: string; submissionId: number|null; status: 'queued'|'placed'|'done'|'unanswered'; admission?: TurnAdmissionStatus|null; answerText: string|null; reason: string|null };
export type HostHistoryPage = { botId: string; conversationId: string; items: Array<Record<string, unknown>>; nextCursor: Record<string, unknown>|null; entryChunk?: HistoryEntryChunk };
export type HostCallResult = { type: 'result'; id: string; result: unknown };
// 本地 Host live 帧：真实共享帧联合（与 DesktopLiveFrame 同形），不伪造字段。
// primary 快照/更新（BotLiveSnapshot/BotLiveUpdate）、work 快照（WorkLiveSnapshot，携带 scopeId）、
// 以及各自的终态帧 BotLiveEnd/WorkLiveEnd。update 臂只有 changes 没有 state，
// end 臂只有 type/reason/ids 没有 state——按 type 分别取对应字段。
export type HostLiveFrame = BotLiveSnapshot | BotLiveUpdate | WorkLiveSnapshot | BotLiveEnd | WorkLiveEnd;
export type HostFrameEvent = { observationId: string; frame?: HostLiveFrame; error?: {code:string; outcome:string; message:string} };
// Re-export shared live types so Host.tsx / local-scope-api.ts use the same DTO names.
export type {
  AbortBotResult,
  Attribution,
  BotActivity,
  BotLiveEnd,
  BotLiveSnapshot,
  BotLiveState,
  BotLiveUpdate,
  LiveGeneration,
  QueuedTurnItem,
  RemoteControlOutcome,
  SteerQueuedResult,
  TurnDeliveryMode,
  WithdrawQueuedResult,
  WithdrawnTurnItem,
  WorkLiveEnd,
  WorkLiveSnapshot,
};
export type HostVoiceEngine = 'system'|'remote';
export type HostVoiceRemote = { baseUrl: string; model: string; voice: string; configured: boolean; hasApiKey?: boolean };
export type HostVoiceSettings = { sttEngine: HostVoiceEngine; ttsEngine: HostVoiceEngine; language: string; speechRate: number; stt: HostVoiceRemote; tts: HostVoiceRemote };
/** Write shape: apiKey omitted keeps the stored key, empty string clears it, a value replaces it. */
export type HostVoiceSaveInput = { sttEngine?: HostVoiceEngine; ttsEngine?: HostVoiceEngine; language?: string; speechRate?: number; stt?: HostVoiceRemote & {apiKey?: string}; tts?: HostVoiceRemote & {apiKey?: string} };
export type HostVoiceEvent = { type: 'partial'|'submitted'|'error'; botId: string; requestId: string; text?: string; receipt?: Record<string, unknown>; code?: string; outcome?: string; message?: string };

/** 系统选图/拍照返回的单张图片：data 为纯 base64（不含 dataURL），mimeType 限定 JPEG/PNG。 */
export type BotHostImage = { name: string; mimeType: 'image/jpeg'|'image/png'; data: string; size: number; width: number; height: number };
/** 最多 16 张，每张最长边 ≤16384 且 ≤16MB；取消返回 {images:[],cancelled:true}；失败 reject。 */
export type BotHostPickImagesResult = { images: BotHostImage[]; cancelled?: boolean };

export interface BotHostPlugin {
  snapshot(): Promise<HostSnapshot>;
  status(): Promise<HostStatus>;
  centerSettings(): Promise<CenterSettings>;
  saveCenterSettings(options: {input: {url: string; deviceToken: string; ca: string}}): Promise<CenterSettings>;
  start(): Promise<{requested: boolean}>;
  stop(): Promise<{requested: boolean}>;
  settingsGet(): Promise<HostSettingsPayload>;
  settingsSet(options: {input: {expectedRevision: number; settings: HostSettings}}): Promise<HostSettingsPayload>;
  saveCredentials(options: {aliases: Record<string, unknown>}): Promise<Record<string, never>>;
  call(options: {method: string; params: Record<string, unknown>}): Promise<HostCallResult>;
  observe(options: {observationId: string; target: {kind:'primary'; botId:string} | {kind:'work'; botId:string; scopeId:string}}): Promise<{observationId: string}>;
  cancelObservation(options: {observationId: string}): Promise<Record<string, never>>;
  addListener(event: 'hostFrame', listener: (event: HostFrameEvent) => void): ListenerPromise;
  voiceSettings(): Promise<HostVoiceSettings>;
  saveVoiceSettings(options: {settings: HostVoiceSaveInput}): Promise<Record<string, never>>;
  startVoice(options: {botId: string; requestId: string}): Promise<Record<string, never>>;
  finishVoice(): Promise<Record<string, never>>;
  cancelVoice(): Promise<Record<string, never>>;
  addListener(event: 'voiceEvent', listener: (event: HostVoiceEvent) => void): ListenerPromise;
  pickImages(options: {source: 'photos'|'camera'}): Promise<BotHostPickImagesResult>;}
export const BotHost: BotHostPlugin = createTauriBotHost();

export async function openCenterUrl(url: string): Promise<void> {
  if (!url) throw new Error('请先配置中心地址');
  await mobileLocalRequest('openCenter', { url });
}

export async function openCenterManagement(): Promise<void> {
  const { url } = await BotHost.centerSettings();
  await openCenterUrl(localStorage.getItem('active-center-url') ?? url);
}
