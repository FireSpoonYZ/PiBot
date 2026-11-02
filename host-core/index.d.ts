import type { Models, ModelCost, ModelInputLimits, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import type { CenterConnectionStatus, Provider, Model as CenterModel, ProviderCheckResult, DiscoveryResult, ActionRequest, ActionResult } from '../center-contract/index.js';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { BotAvatar } from '../center-contract/index.js';
import type {
  ShowerCreateOptions,
  ShowerFrame,
  ShowerFrameLimits,
  ShowerInput,
  ShowerSession,
  ShowerTarget,
} from './shower-protocol.js';

export interface BotRecord {
  botId: string;
  deviceId: string;
  role: string;
  description: string;
  cwd: string;
  modelRef: string | null;
  primaryConversationId: string;
  createdAt: string;
  isPrimary: boolean;
  lastActivityAt: string | null;
  lastPreview: string | null;
  archivedAt: string | null;
}

export interface CreateBotInput {
  requestId: string;
  role: string;
  description?: string;
  cwd?: string;
  modelRef?: string | null;
  makePrimary?: boolean;
}

export interface UpdateBotProfileInput {
  botId: string;
  name?: string;
  description?: string;
}

export interface HostProfile {
  deviceId: string;
  primaryBotId: string | null;
  updatedAt: string;
}

export interface DeleteBotResult {
  botId: string;
  deleted: true;
}

export interface BotActivityInput {
  lastActivityAt?: string;
  lastPreview?: string | null;
}

export interface Host {
  readonly deviceId: string;
  readonly dataRoot: string;
  readonly defaultWorkspace: string;
  createBot(input: CreateBotInput): BotRecord;
  updateBotProfile(input: UpdateBotProfileInput): BotRecord;
  getHostProfile(): HostProfile;
  setPrimaryBot(input: { botId: string }): BotRecord;
  archiveBot(input: { botId: string }): BotRecord;
  unarchiveBot(input: { botId: string }): BotRecord;
  deleteBot(input: { botId: string }): DeleteBotResult;
  recordBotActivity(botId: string, activity?: BotActivityInput): BotRecord | null;
  listExpiredArchivedBots(cutoffIso: string): BotRecord[];
  getBot(botId: string): BotRecord | null;
  /** Validates an absolute, existing directory path on this Host; returns the normalized path. */
  assertBotCwd(input: { cwd: string }): string;
  /**
   * Internal center-driven cwd switch; only the runtime apply boundary calls this.
   * Not a remote method — the center remains the only write path for cwd.
   */
  setBotCwd(botId: string, input: { cwd: string }): BotRecord;
  findByRequest(requestId: string): BotRecord | null;
  listBots(): BotRecord[];
  /** Internal row snapshot; null when not initialized (callers distinguish unknown Bots via getBot). */
  getBotExtensions(botId: string): BotExtensionState | null;
  /** Create SOUL.md once from the persisted role; existing content is never overwritten. */
  ensureBotSoul(botId: string): BotSoul;
  /** Reading also idempotently bootstraps a missing legacy document. */
  getBotSoul(botId: string): BotSoul;
  /** CAS on the file SHA-256; a stale revision rejects without overwriting. */
  setBotSoul(botId: string, input: BotSoulUpdate): BotSoul;
  close(): void;
}

export function openHost(options: { dataRoot: string }): Host;

export interface PrimarySubmission {
  botId: string;
  /** null when the turn is queued Host-side and no conversation/submission exists yet. */
  conversationId: string | null;
  requestId: string;
  /** null while the turn waits on Center admission; the queued receipt is acceptance, not model execution. */
  submissionId: number | null;
  status: 'queued' | 'placed' | 'done' | 'unanswered';
  /** Present on a Host-queued receipt while the turn is being admitted; absent after native submission. */
  admission?: TurnAdmissionStatus | null;
  /** Metadata only (no base64) echoing the submitted image attachments; lets UI render attachment-only pending turns. */
  attachments?: ImageAttachment[];
  answerText: string | null;
  reason: string | null;
}

export interface SubmissionInput {
  requestId: string;
  /** With attachments present this may be an empty/blank string; text-only submits still require non-empty text. */
  text: string;
  /** Ordered previously-uploaded image attachment IDs (lowercase hex SHA-256), at most 16. */
  attachments?: string[];
}

/** Uploaded image attachment record; `id` is the decoded bytes' lowercase hex SHA-256. */
export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: 'image/jpeg' | 'image/png';
  size: number;
  width: number;
  height: number;
}

export interface AttachmentUploadInput {
  name: string;
  mimeType: 'image/jpeg' | 'image/png';
  /** Canonical base64 of one image <= 16 MiB decoded, max edge 16384px. */
  data: string;
}

/** A content-addressed file transferred to a Bot in chunks. */
export interface BotFileChunkInput {
  id: string;
  name: string;
  size: number;
  offset: number;
  /** Canonical base64, at most 256 KiB decoded; no whole-file size cap. */
  data: string;
}
export interface BotFileReceipt {
  id: string;
  name: string;
  size: number;
  received: number;
  complete: boolean;
  /** Recipient-local path, present only after complete SHA-256 verification. */
  path?: string;
}

/** Attachment metadata plus the canonical base64 payload. */
export interface ImageAttachmentData extends ImageAttachment {
  data: string;
}

export interface HistoryOptions {
  limit?: number;
  cursor?: Record<string, unknown> | null;
  /** Wire-safe pages and lossless JSON fragments for entries larger than one frame. */
  chunked?: boolean;
}

export interface HistoryEntryChunk {
  entryId: number;
  /** UTF-16 offset within the serialized entry, not a byte offset. */
  offset: number;
  json: string;
  complete: boolean;
}

export interface HistoryPage {
  botId: string;
  conversationId: string;
  items: readonly EntryRecord[];
  nextCursor: Record<string, unknown> | null;
  entryChunk?: HistoryEntryChunk;
}

/** /clear 结果：SDK 用 pi.reset 开新上下文，conversationId 不变。 */
export interface ClearHistoryResult {
  botId: string;
  conversationId: string;
  /** reset 条目 id；无会话时为 0。所有客户端据此隐藏更早的可见历史。 */
  clearedThroughEntryId: number;
}

/** /compact 结果：只等待一次手动压缩任务终态并确认摘要 write 已落地；无可压内容时 compacted 为 false。 */
export interface CompactResult {
  botId: string;
  conversationId: string;
  compacted: boolean;
}

/** Billion Context plugin status, returned only when the capability is enabled. */
interface CompressionBlock {
  blockId: string;
  runId: string;
  tier: 1 | 2 | 3;
  topic?: string;
  summary: string;
  directMessageIds: string[];
  effectiveMessageIds: string[];
  directBlockIds: string[];
  compressedTokens: number;
  createdAt: number;
  survivedCount: number;
  generation: 'young' | 'old';
  active: boolean;
  expanded?: boolean;
  restoredInline?: boolean;
  durationMs?: number;
  compressCallId?: string;
  startRef?: string;
  endRef?: string;
}

interface StatusReport {
  contextUsage: number;
  tokenCount: number;
  modelContextLimit: number;
  activeBlocks: number;
  totalBlocks: number;
  tokensCompressed: number;
  breakdown: Record<string, number>;
}

export interface ContextStatus {
  botId: string;
  conversationId: string;
  kernelVersion: string;
  status: StatusReport | null;
  blocks: readonly CompressionBlock[];
  messageRefs: {
    byRaw: Record<string, string>;
    byRef: Record<string, string>;
  };
  prepared: {
    key: string;
    taskId: string;
    cutoff: number;
    contextWindow: number;
    tokenCount: number;
  } | null;
}

/** Module 10: passive, isolated room/DM contexts; importing never starts inference. */
export interface WorkContextRecord {
  deviceId: string;
  botId: string;
  scopeId: string;
  kind: 'room' | 'dm';
  /** Public UUID, distinct from the Bot's primary conversation and SDK numeric ID. */
  conversationId: string;
  createdAt: string;
  lastImportedLocalId: number;
  importedCount: number;
}

export interface WorkSyncOptions {
  /** One page per explicit sync; default 50, maximum 200, positive safe integer. */
  limit?: number;
}

export interface WorkSyncResult {
  context: WorkContextRecord;
  imported: number;
  hasMore: boolean;
}

/** Exact wrapper bound to one public work-context UUID; never a raw/primary cursor. */
export interface WorkHistoryCursor {
  conversationId: string;
  position: Record<string, unknown>;
}

export interface WorkHistoryPage {
  botId: string;
  scopeId: string;
  conversationId: string | null;
  items: readonly EntryRecord[];
  nextCursor: WorkHistoryCursor | null;
}

export interface WorkContextStatus extends Omit<ContextStatus, 'conversationId'> {
  scopeId: string;
  conversationId: string | null;
}

/** Module 11: passive activity DTO for one local Bot/scope; no native task IDs. */
export interface WorkActivity {
  botId: string;
  scopeId: string;
  /** Public work-context UUID; null when authorized but not yet bound. */
  conversationId: string | null;
  isMember: boolean;
  /** Priority: unbound, stopped, error, inactive (nonmember), thinking, idle. */
  status: 'unbound' | 'idle' | 'thinking' | 'stopped' | 'inactive' | 'error';
  /** Owner stop persists across restart; only explicit resumeWork clears it. */
  stopped: boolean;
  lastImportedLocalId: number;
  /** Policy-consumed source watermark, including ignored echoes/notices/replies; not an ACK. */
  handledLocalId: number;
  pending: {
    requestId: string;
    submissionId: number | null;
    startedAt: string;
    /** Source watermark in the actual frozen model request, not the latest imported watermark. */
    preparedThroughLocalId: number | null;
  } | null;
  /** Model-decision outcome, not delivery confirmation or proof of no earlier side effects. */
  lastDecision: {
    requestId: string;
    outcome: 'silent' | 'published' | 'replan' | 'aborted' | 'failed';
    throughLocalId: number | null;
    completedAt: string;
  } | null;
  error: { code: string; message: string } | null;
  /**
   * Request-local failure diagnostic (work lane, contract C): the latest
   * request's bounded safe failure, kept visible after settle without gating
   * new requests — unlike `error`, which remains the legacy scope gate.
   */
  lastError: { code: string; message: string } | null;
}

/**
 * Module 13: Hindsight long-term memory (Pi Durable adapter). Fact storage,
 * extraction, recall and curation live on the configured Hindsight service;
 * the local adapter only tracks inputs, outbox, recall cache, provenance and
 * correction audit. Automatic extraction follows completed inference only;
 * explicit tool/control notes are durable tool history and never auto-source.
 */

/** Selected memory bank target; scope requires read authorization via work context. */
export type MemoryTarget =
  | { kind: 'primary' }
  | { kind: 'scope'; scopeId: string }
  | { kind: 'shared' };

/** Host config; apiKeyEnv names an environment variable, never an inline value. */
export interface HindsightOptions {
  baseUrl: string;
  apiKeyEnv?: string;
  /** Opt-in shared bank; accepts explicit notes only, never automatic transcripts. */
  sharedMemory?: boolean;
  /** Ordinary operation deadline in ms (default 30000, max 120000). */
  timeoutMs?: number;
  /** Reflect deadline in ms (default 120000, max 120000). */
  reflectTimeoutMs?: number;
}

export type MemoryJobState = 'pending' | 'accepted' | 'completed' | 'failed';

/** Job receipt; never exposes token or raw backend error bodies. */
export interface MemoryReceipt {
  operationId: string;
  documentId: string;
  botId: string;
  target: MemoryTarget;
  bankId: string;
  state: MemoryJobState;
  createdAt: string;
  updatedAt: string;
  lastErrorCode: string | null;
}

export interface MemoryRetainReceipt {
  botId: string;
  target: MemoryTarget;
  bankId: string;
  jobs: MemoryReceipt[];
}

export type MemoryCorrectionState = 'pending' | 'applied' | 'rejected' | 'unconfirmed';
export type MemoryCorrectionOutcome = 'not-sent' | 'responded' | 'unconfirmed';

export interface MemoryCorrectionReceipt {
  requestId: string;
  botId: string;
  target: MemoryTarget;
  bankId: string;
  memoryId: string;
  state: MemoryCorrectionState;
  outcome: MemoryCorrectionOutcome;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
}

export type MemoryRecallOutcome = 'injected' | 'empty' | 'budget' | 'unavailable';

export interface MemoryLastRecall {
  at: string;
  outcome: MemoryRecallOutcome;
}

/** Paged job-list continuation; bound to the derived bank/filter, never selects a target. */
export interface MemoryCursor {
  bankId: string;
  state: MemoryJobState | null;
  afterOperationId: string;
}

export interface MemoryStatusInput {
  target?: MemoryTarget;
  state?: MemoryJobState;
  /** 1..200, default 20. */
  limit?: number;
  cursor?: MemoryCursor | null;
}

/**
 * Memory status. Counts always cover the whole context; only jobs obey the
 * state filter. jobs/nextCursor are null when disabled (unknown); a configured
 * empty store returns [] with nextCursor null.
 */
export interface MemoryStatus {
  botId: string;
  target: MemoryTarget;
  enabled: boolean;
  sharedMemory: boolean;
  bankId: string | null;
  pending: number | null;
  accepted: number | null;
  completed: number | null;
  failed: number | null;
  lastErrorCode: string | null;
  lastRecall: MemoryLastRecall | null;
  jobs: MemoryReceipt[] | null;
  nextCursor: MemoryCursor | null;
}

export interface MemoryQueryInput {
  target?: MemoryTarget;
  query: string;
  maxTokens?: number;
}

export interface MemoryRetainInput {
  requestId: string;
  target?: MemoryTarget;
  text: string;
}

export interface MemoryLookupInput {
  target?: MemoryTarget;
  memoryId: string;
}

export interface MemorySourceInput {
  target?: MemoryTarget;
  documentId: string;
}

export interface MemoryCorrectionInput {
  requestId: string;
  target?: MemoryTarget;
  memoryId: string;
  text?: string;
  state?: 'valid' | 'invalidated';
  reason?: string;
}

export interface MemoryRetryInput {
  target?: MemoryTarget;
  operationId: string;
}

/** Backend recall/reflect/get result; opaque unknown shape, no invented DTO. */
export interface MemoryBankResult {
  botId: string;
  target: MemoryTarget;
  bankId: string;
  result: Record<string, unknown>;
}

export type MemoryRecallResult = MemoryBankResult;
export type MemoryReflectResult = MemoryBankResult;
export type MemoryGetResult = MemoryBankResult;

/** Source fetch result; externally created documents may have no local provenance/receipt. */
export interface MemorySourceResult {
  botId: string;
  target: MemoryTarget;
  bankId: string;
  document: Record<string, unknown>;
  source: Record<string, unknown> | null;
  receipt: MemoryReceipt | null;
}

/** Raw runtime JSON configuration (module 14); strict fields, credentials only as env names. */
export interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Optional input modalities; omitted stays text-only, explicit arrays require text and may add image. */
  input?: ('text' | 'image')[];
  /** Pi 计费费率；四档必填于 SDK，缺省补 0，可选按输入量分档。 */
  cost?: ModelCost;
  /** Pi 按 api 读取的兼容开关；只校验对象边界，原样交给 SDK。 */
  compat?: Record<string, unknown>;
  /** pi 思考档位到 provider 原生档位的映射；null 表示该档不受支持。 */
  thinkingLevelMap?: ThinkingLevelMap;
  /** 图像/请求输入上限与缓存安全预处理；原样交给 SDK 与原生工具。 */
  inputLimits?: ModelInputLimits;
}

export interface ProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  /** 该 provider 全部模型共用的 API；缺省 openai-completions，其他值显式拒绝。 */
  api?: 'openai-completions' | 'openai-responses' | 'pi-messages' | 'anthropic-messages';
  apiKeyEnv?: string;
  models: ModelConfig[];
}

export interface RuntimeConfig {
  providers: ProviderConfig[];
  defaultModel?: string | null;
  /** 默认思考档位；缺省/null 交给 SDK 默认值。 */
  thinkingLevel?: ModelThinkingLevel | null;
  hindsight?: HindsightOptions;
  /** Canonical Host extension config; ambiguous with legacy hindsight, never both. */
  extensions?: RuntimeExtensionsConfig;
  bashPath?: string;
  toolPaths?: { rg?: string; fd?: string };
}

/**
 * Module 15: trusted local Android native-bridge callback. Installed only as
 * an in-process JS function on runtime/control/host-service options; never
 * persisted or accepted as a JSON settings field.
 */
export interface NativeBridgeActorPrimary {
  deviceId: string;
  botId: string;
  /** Host-public conversation UUID, distinct from SDK numeric IDs. */
  conversationId: string;
  scopeId: null;
  kind: 'primary';
}

export interface NativeBridgeActorScope {
  deviceId: string;
  botId: string;
  /** Host-public conversation UUID, distinct from SDK numeric IDs. */
  conversationId: string;
  scopeId: string;
  kind: 'room' | 'dm';
}

/** Actor discriminates primary (scopeId null) vs room/DM scope (scopeId string). */
export type NativeBridgeActor = NativeBridgeActorPrimary | NativeBridgeActorScope;

/**
 * Trusted native tools. schedule_task manages only the current Bot's primary
 * private-chat tasks and runs only while the user has explicitly started this
 * Host; it never trusts model-declared ownership fields.
 */
export type NativeBridgeTool = 'android_apps' | 'android_shower' | 'android_speak' | 'schedule_task';

export interface NativeBridgeRequest {
  tool: NativeBridgeTool;
  actor: NativeBridgeActor;
  /** Durable numeric task id of the active primary/work generation. */
  taskId: number;
  arguments: Record<string, unknown>;
}

/** Trusted JS bridge; resolves to a plain JSON object or array. */
export type NativeBridge = (
  request: NativeBridgeRequest,
  options?: { signal?: AbortSignal },
) => Promise<Record<string, unknown> | unknown[]>;

export interface OpenRuntimeOptions {
  dataRoot: string;
  models?: Models;
  defaultModel?: string | null;
  /** 默认思考档位，与 runtime 配置同义；缺省/null 交给 SDK 默认值。 */
  thinkingLevel?: ModelThinkingLevel | null;
  /** Optional explicit bash (Git Bash on Windows) executable; when omitted, HostEnv probes fixed Git install directories (Windows) or /bin/bash and /usr/bin/bash (Linux), never PATH. */
  bashPath?: string;
  /** Optional explicit search binaries for grep (rg) and find (fd); existence is checked at use. */
  toolPaths?: { rg?: string; fd?: string };
  /** Optional Hindsight memory config; absent leaves memory disabled. */
  hindsight?: HindsightOptions;
  /** Effective managed-extension config forwarded from parseRuntimeConfig; absent means legacy/unconfigured. */
  extensions?: RuntimeExtensionsConfig;
  /** Optional trusted JS native bridge for Android tools; never persisted as a settings field. */
  nativeBridge?: NativeBridge;
  /** Optional callback invoked when the Bot inventory structurally changes (create/delete/purge). */
  onBotsChanged?: () => void | Promise<void>;
  /** Optional callback invoked on lightweight Bot metadata updates (primary, archive, profile, activity). */
  onBotsSync?: () => void | Promise<void>;
}

export interface Runtime {
  getCurrentDevice(): Promise<{ deviceId: string; displayName: string; platform: string; arch: string }>;
  createBot(input: CreateBotInput): Promise<BotRecord>;
  setPrimaryBot(botId: string): Promise<BotRecord>;
  archiveBot(botId: string): Promise<BotRecord>;
  unarchiveBot(botId: string): Promise<BotRecord>;
  deleteBot(botId: string): Promise<DeleteBotResult>;
  submit(botId: string, input: SubmissionInput): Promise<PrimarySubmission>;
  wait(botId: string, requestId: string): Promise<PrimarySubmission>;
  getSubmission(botId: string, requestId: string): Promise<PrimarySubmission | null>;
  /** Persist one validated image into the Bot's private attachment dir; resolves the content-addressed record. */
  uploadAttachment(botId: string, input: AttachmentUploadInput): Promise<ImageAttachment>;
  /** Rejects ATTACHMENT_NOT_FOUND when the ID is unknown to this Bot. */
  getAttachment(botId: string, attachmentId: string): Promise<ImageAttachmentData>;
  putBotFileChunk(botId: string, input: BotFileChunkInput): Promise<BotFileReceipt>;
  history(botId: string, options?: HistoryOptions): Promise<HistoryPage>;
  /** /clear：清空主私聊可见历史并重置模型上下文（pi.reset，不新建 conversationId）。 */
  clearHistory(botId: string): Promise<ClearHistoryResult>;
  /** /compact：跑一次手动压缩并等待任务终态；失败抛 COMPACTION_FAILED。 */
  compact(botId: string): Promise<CompactResult>;
  /** Abort only the primary conversation; does not stop room/DM work contexts. */
  abort(botId: string): Promise<void>;
  contextStatus(botId: string): Promise<ContextStatus>;
  getWorkContext(botId: string, scopeId: string): Promise<WorkContextRecord | null>;
  syncWorkContext(botId: string, scopeId: string, options?: WorkSyncOptions): Promise<WorkSyncResult>;
  workHistory(botId: string, scopeId: string, options?: { limit?: number; cursor?: WorkHistoryCursor | null }): Promise<WorkHistoryPage>;
  workContextStatus(botId: string, scopeId: string): Promise<WorkContextStatus>;
  /** Passive, authorized query; creates neither a binding nor model work. */
  getWorkActivity(botId: string, scopeId: string): Promise<WorkActivity>;
  /** Persist stop, abort only this work conversation and await quiescence; committed effects remain. */
  stopWork(botId: string, scopeId: string): Promise<WorkActivity>;
  /** Current member only; clear stop/error without consuming input. Does not activate a passive Runtime's scheduler. */
  resumeWork(botId: string, scopeId: string): Promise<WorkActivity>;
  /** Module 12: six managed-scope methods; exposed locally and via the module 14 remote v2 table. */
  createScope(input: ScopeCreateInput): Promise<ScopeInfo>;
  updateScope(scopeId: string, input: ScopeUpdateInput): Promise<ScopeInfo>;
  /** Latest state; rejects SCOPE_NOT_FOUND when the scope is missing, never resolves null. */
  getScopeState(scopeId: string): Promise<ScopeInfo>;
  listScopeStates(options?: ScopeListOptions): Promise<ScopeListPage>;
  /** Room-public user message; returns the stored ledger receipt, not a delivery/inference completion. */
  publishUserMessage(scopeId: string, input: UserMessageInput): Promise<StoredMessage>;
  listScopeReplicas(scopeId: string, options?: ReplicaListOptions): Promise<ReplicaListPage>;
  /** Module 13: eight Hindsight memory methods; exposed locally and via the module 14 remote v2 table. */
  memoryStatus(botId: string, input?: MemoryStatusInput): Promise<MemoryStatus>;
  recallMemory(botId: string, input: MemoryQueryInput): Promise<MemoryRecallResult>;
  reflectMemory(botId: string, input: MemoryQueryInput): Promise<MemoryReflectResult>;
  retainMemory(botId: string, input: MemoryRetainInput): Promise<MemoryRetainReceipt>;
  getMemory(botId: string, input: MemoryLookupInput): Promise<MemoryGetResult>;
  getMemorySource(botId: string, input: MemorySourceInput): Promise<MemorySourceResult>;
  correctMemory(botId: string, input: MemoryCorrectionInput): Promise<MemoryCorrectionReceipt>;
  retryMemory(botId: string, input: MemoryRetryInput): Promise<MemoryReceipt>;
  watch(botId: string, options?: { signal?: AbortSignal }): Promise<BotWatch>;
  /** Module 14: work-context live preview; same handle shape as primary watch, full snapshots only. */
  watchWork(botId: string, scopeId: string, options?: { signal?: AbortSignal }): Promise<WorkWatch>;
  /**
   * Publish the next waiting primary-turn admission on every live watch for the Bot.
   * status null clears it (nothing Host-queued/waiting/failed). queuedCount counts only
   * Host-side queued primary inputs not yet submitted to the SDK — pi.inbox items are
   * added by the projection, so the two never double count.
   */
  setTurnAdmission(botId: string, status: TurnAdmissionStatus | null, queuedCount?: number): void;
  /**
   * Cold-start recovery: re-register pinned old bindings/profile for admitted turns
   * before global resume. Missing or unrestorable pins leave the scheduler paused with
   * a bounded error instead of resuming on undefined code.
   */
  restoreTurns(): Promise<void>;
  /** Passive, authorized scope history; strict paging with the shared message cursor. */
  scopeHistory(scopeId: string, options?: ScopeHistoryOptions): Promise<MessageHistoryPage>;
  /** Exact stored message; foreign-scope IDs reject MESSAGE_NOT_FOUND. */
  getScopeMessage(scopeId: string, messageId: string): Promise<StoredMessage>;
  getScopeMessageDelivery(scopeId: string, messageId: string): Promise<MessageDeliveryStatus>;
  /** Read-only chat model whitelist; no credentials/base URLs/env names. */
  getModelCatalog(): Promise<ModelCatalog>;
  /** Idempotent Bot initialization (SOUL.md); retried by create/startup. */
  initializeBot(botId: string): Promise<void>;
  getBotSoul(botId: string): Promise<BotSoul>;
  /** CAS on the file SHA-256; conflict rejects REQUEST_CONFLICT without overwriting. */
  setBotSoul(botId: string, input: BotSoulUpdate): Promise<BotSoul>;
  scheduleTask(botId: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /* Unified Shower environment (host.shower): the same six methods on every platform. */
  getShowerStatus(target: ShowerTarget): Promise<ShowerSession>;
  createShowerSession(target: ShowerTarget, input?: ShowerCreateOptions): Promise<ShowerSession>;
  getShowerFrame(target: ShowerTarget, sessionId: string, limits?: ShowerFrameLimits): Promise<ShowerFrame>;
  /** Never retried automatically; the receipt reports the real outcome. */
  sendShowerInput(target: ShowerTarget, sessionId: string, input: ShowerInput): Promise<Record<string, unknown>>;
  /** Aborts the matching conversation, then returns the current session status. */
  takeoverShower(target: ShowerTarget, sessionId: string): Promise<ShowerSession>;
  releaseShowerSession(target: ShowerTarget, sessionId: string): Promise<Record<string, unknown>>;
  /** Idempotently resume native tasks AND activate automatic room/DM processing; may submit new work. */
  resume(): void;
  close(): Promise<void>;
}

/** Opens passively; automatic room/DM processing starts only through Runtime.resume(). */
export function openRuntime(options: OpenRuntimeOptions): Promise<Runtime>;

/**
 * Unified Shower public data (identical on Android/Windows/Linux). The shapes
 * and normalizers live in shower-protocol so UI/tool/backend code imports them
 * once instead of copying the protocol.
 */
export type {
  ShowerActor,
  ShowerCapabilities,
  ShowerCreateOptions,
  ShowerErrorCode,
  ShowerFrame,
  ShowerFrameLimits,
  ShowerInput,
  ShowerLaunch,
  ShowerPlatform,
  ShowerPhase,
  ShowerSession,
  ShowerTarget,
} from './shower-protocol.js';

/**
 * Tool presentation contract shared by the tool-result UI lane: the only
 * structure a tool may publish via result.details.presentation. Runtime and
 * the remote wire normalize against these shapes (tool-presentation.js);
 * LiveTool/LiveMessage carry them read-only for UI rendering.
 */
export interface TodoTaskPresentation {
  id: number;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoPresentation {
  kind: 'todo';
  version: 1;
  installationId: string;
  tasks: TodoTaskPresentation[];
}

export interface QuestionnaireOptionPresentation {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionnaireQuestionPresentation {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: QuestionnaireOptionPresentation[];
}

export interface QuestionnaireAnswerPresentation {
  questionIndex: number;
  question: string;
  kind: 'option' | 'custom' | 'multi';
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

export interface QuestionnaireResultPresentation {
  answers: QuestionnaireAnswerPresentation[];
  cancelled: boolean;
  globalNote?: string;
  unanswered?: number[];
}

export interface QuestionnairePresentation {
  kind: 'questionnaire';
  version: 1;
  installationId: string;
  conversationId: number;
  requestId: string;
  status: 'pending' | 'answered' | 'cancelled';
  questions: QuestionnaireQuestionPresentation[];
  result?: QuestionnaireResultPresentation;
}

export type ToolPresentation = TodoPresentation | QuestionnairePresentation;

/**
 * Live preview types (module 6): bounded, non-durable projection frames for a
 * Bot's primary conversation over authenticated local SSE. Previews are
 * transient progress; the raw history API remains the full source of truth.
 */

export interface LiveMessageToolCall {
  callId: string;
  name: string;
}

/**
 * Safe UI attribution for a history/live item: frozen turn origin and message
 * identity only. Never carries native control IDs, tool parameters, unrelated
 * documents or credentials; names are display only.
 */
export interface Attribution {
  kind: 'user' | 'bot' | 'host';
  botId?: string;
  deviceId?: string;
  /** Display-only sender name; never an identity or routing key. */
  name?: string;
  channel: 'primary' | 'dm' | 'room';
  scopeId?: string;
  messageId?: string;
  replyTo?: string;
  rootId?: string;
  category?: 'public' | 'notice' | 'request' | 'reply';
  direction?: 'incoming' | 'outgoing';
  createdAt?: string;
}

export interface LiveMessage {
  role: 'user' | 'assistant' | 'toolResult';
  text: string;
  truncated: boolean;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  durationMs?: number;
  toolCalls?: LiveMessageToolCall[];
  /** Whitelist projection of the toolResult details.presentation; read-only. */
  presentation?: ToolPresentation;
  /** Metadata only (no base64) on user messages carrying image attachments. */
  attachments?: ImageAttachment[];
}

export interface LiveHistoryItem {
  id: number;
  kind: string;
  messages: LiveMessage[];
  /** Frozen turn origin of the entry; absent on older Hosts and unattributed host entries. */
  attribution?: Attribution;
}

export interface LiveTool {
  callId: string;
  name: string;
  status: 'pending' | 'running' | 'done';
  output: string;
  truncated: boolean;
  droppedBytes: number;
  droppedLines: number;
  entryId?: number;
  parentCallId?: string;
  /** Whitelist projection of the running tool's slot.details.presentation; read-only. */
  presentation?: ToolPresentation;
}

export interface LiveGeneration {
  text: string;
  truncated: boolean;
  /** Frozen origin of the running generation; absent on older Hosts. */
  attribution?: Attribution;
}

/**
 * Admission phase of the next Host-queued primary turn awaiting Center sync.
 * Carries no message text or credentials; null when nothing is queued/waiting/failed.
 */
export interface TurnAdmissionStatus {
  requestId: string;
  phase: 'queued' | 'checking' | 'synchronizing' | 'failed';
  error?: { code: string; message: string };
}

/**
 * Unified Bot work activity for live watches. Metadata only (phase/source enums,
 * bounded IDs, ISO startedAt); never message text, credentials or tool args.
 * phase 'stopped' is the explicit manual-stop settlement, not idle; 'failed' is a
 * failed admission pending cancellation, not a history error; 'compacting' is a
 * blocking or idle/manual context compaction — it counts active/busy like
 * 'running', while a nonblocking background compaction keeps phase 'running'.
 * Optional on the wire: older Hosts omit it and clients fall back to
 * busy/queuedCount; a host emitting 'compacting' requires a client that
 * recognizes the value (strict wire validation rejects unknown phases).
 */
export interface BotActivity {
  phase: 'idle' | 'queued' | 'preparing' | 'running' | 'compacting' | 'interrupting' | 'stopping' | 'stopped' | 'failed';
  /** 'primary' | 'room' | 'dm' are real sources; 'background' marks a primary-kind background work continuation. */
  source: 'primary' | 'room' | 'dm' | 'background' | null;
  scopeId: string | null;
  requestId: string | null;
  /** ISO 8601 timestamp of the current activity start; null when unknown. */
  startedAt: string | null;
  /**
   * Bounded safe diagnostic of the failed phase only — the Host-authored
   * generation-failure family record or a fixed safe fallback, never a raw
   * provider error body. Absent on every other phase; wire validation rejects
   * it elsewhere.
   */
  error?: { code: string; message: string };
}

export interface BotLiveState {
  history: LiveHistoryItem[];
  historyTruncated: boolean;
  lastEntryId: number | null;
  generation: LiveGeneration | null;
  tools: LiveTool[];
  toolsTruncated: boolean;
  busy: boolean;
  /** pi.inbox items plus Host-side queued primary inputs (disjoint sets, never double counted). */
  queuedCount: number;
  /** Next waiting admission; optional — frames from older Hosts omit it. Never present on work watches. */
  turnAdmission?: TurnAdmissionStatus | null;
  /** Unified work activity; optional — frames from older Hosts omit it. The single UI authority for working status. */
  activity?: BotActivity;
}

/** Whole-field replacement of selected BotLiveState fields; never append/delta. */
export type BotLiveChanges = Partial<BotLiveState>;

export interface BotLiveSnapshot {
  type: 'snapshot';
  botId: string;
  conversationId: string;
  sequence: number;
  state: BotLiveState;
}

export interface BotLiveUpdate {
  type: 'update';
  botId: string;
  conversationId: string;
  sequence: number;
  changes: BotLiveChanges;
}

type BotWatchEndReason =
  | 'stopped'
  | 'cancelled'
  | 'session_closed'
  | 'retired'
  | 'listener_error'
  | 'session_failed';

export interface BotLiveEnd {
  type: 'end';
  botId: string;
  conversationId: string;
  sequence: number;
  reason: BotWatchEndReason;
}

/** Frames delivered to Runtime.watch listeners (snapshot first, then updates). */
export type BotLiveDataFrame = BotLiveSnapshot | BotLiveUpdate;

/** All wire frames including the transport-only end frame. */
export type BotLiveFrame = BotLiveDataFrame | BotLiveEnd;

export interface BotWatchEnd {
  reason: BotWatchEndReason;
}

export interface BotWatch {
  readonly value: BotLiveSnapshot;
  start(listener: (frame: BotLiveDataFrame) => void | Promise<void>): void;
  stop(): Promise<BotWatchEnd>;
  readonly closed: Promise<BotWatchEnd>;
}

/** Module 14: work-context live preview; full snapshots only, never deltas. */
export interface WorkLiveSnapshot {
  type: 'snapshot';
  botId: string;
  scopeId: string;
  conversationId: string | null;
  sequence: number;
  state: BotLiveState;
}

/** Transport-only end frame carried on the work live SSE stream. */
export interface WorkLiveEnd {
  type: 'end';
  botId: string;
  scopeId: string;
  conversationId: string | null;
  sequence: number;
  reason: BotWatchEndReason;
}

export type WorkLiveFrame = WorkLiveSnapshot | WorkLiveEnd;

export interface WorkWatch {
  readonly value: WorkLiveSnapshot;
  start(listener: (frame: WorkLiveSnapshot) => void | Promise<void>): void;
  stop(): Promise<BotWatchEnd>;
  readonly closed: Promise<BotWatchEnd>;
}

/** Chat model catalog projection; ordered by modelRef UTF-8 bytes. */
export interface ModelCatalogEntry {
  modelRef: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface ModelCatalog {
  defaultModel: string | null;
  models: ModelCatalogEntry[];
}

export interface ControlHostInfo {
  displayName: string;
  protocolVersion: 1;
  deviceId: string;
  defaultWorkspace: string;
  platform: string;
  arch: string;
}

export interface OpenControlServerOptions extends OpenRuntimeOptions {
  token: string;
  port?: number;
  /** Optional local settings store backing /v1/settings; when absent those routes return CONTROL_UNAVAILABLE. */
  settings?: { store: HostSettingsStore; activeRevision: number };
  getServiceStatus?: () => HostServiceStatus;
}

export interface ControlServer {
  deviceId: string;
  url: string;
  close(): Promise<void>;
  /** Forwards runtime.restoreTurns(): cold-start pinned-turn recovery before resume. */
  restoreTurns(): Promise<void>;
}

export function openControlServer(options: OpenControlServerOptions): Promise<ControlServer>;

export interface ControlClientCallOptions {
  signal?: AbortSignal;
}

export interface ControlClient {
  getHostInfo(options?: ControlClientCallOptions): Promise<ControlHostInfo>;
  listBots(options?: ControlClientCallOptions): Promise<BotRecord[]>;
  createBot(input: CreateBotInput, options?: ControlClientCallOptions): Promise<BotRecord>;
  updateBotProfile(input: UpdateBotProfileInput, options?: ControlClientCallOptions): Promise<BotRecord>;
  setPrimaryBot(botId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  archiveBot(botId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  unarchiveBot(botId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  deleteBot(botId: string, options?: ControlClientCallOptions): Promise<DeleteBotResult>;
  getBot(botId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  findByRequest(requestId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  submit(botId: string, input: SubmissionInput, options?: ControlClientCallOptions): Promise<PrimarySubmission>;
  getSubmission(botId: string, requestId: string, options?: ControlClientCallOptions): Promise<PrimarySubmission>;
  uploadAttachment(botId: string, input: AttachmentUploadInput, options?: ControlClientCallOptions): Promise<ImageAttachment>;
  getAttachment(botId: string, attachmentId: string, options?: ControlClientCallOptions): Promise<ImageAttachmentData>;
  putBotFileChunk(botId: string, input: BotFileChunkInput, options?: ControlClientCallOptions): Promise<BotFileReceipt>;
  history(botId: string, options?: HistoryOptions & ControlClientCallOptions): Promise<HistoryPage>;
  clearHistory(botId: string, options?: ControlClientCallOptions): Promise<ClearHistoryResult>;
  compact(botId: string, options?: ControlClientCallOptions): Promise<CompactResult>;
  abort(botId: string, options?: ControlClientCallOptions): Promise<{ botId: string }>;
  contextStatus(botId: string, options?: ControlClientCallOptions): Promise<ContextStatus>;
  memoryStatus(botId: string, input?: MemoryStatusInput, options?: ControlClientCallOptions): Promise<MemoryStatus>;
  recallMemory(botId: string, input: MemoryQueryInput, options?: ControlClientCallOptions): Promise<MemoryRecallResult>;
  reflectMemory(botId: string, input: MemoryQueryInput, options?: ControlClientCallOptions): Promise<MemoryReflectResult>;
  retainMemory(botId: string, input: MemoryRetainInput, options?: ControlClientCallOptions): Promise<MemoryRetainReceipt>;
  getMemory(botId: string, input: MemoryLookupInput, options?: ControlClientCallOptions): Promise<MemoryGetResult>;
  getMemorySource(botId: string, input: MemorySourceInput, options?: ControlClientCallOptions): Promise<MemorySourceResult>;
  correctMemory(botId: string, input: MemoryCorrectionInput, options?: ControlClientCallOptions): Promise<MemoryCorrectionReceipt>;
  retryMemory(botId: string, input: MemoryRetryInput, options?: ControlClientCallOptions): Promise<MemoryReceipt>;
  getWorkContext(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkContextRecord>;
  syncWorkContext(botId: string, scopeId: string, input?: WorkSyncOptions, options?: ControlClientCallOptions): Promise<WorkSyncResult>;
  workHistory(botId: string, scopeId: string, options?: { limit?: number; cursor?: WorkHistoryCursor | null } & ControlClientCallOptions): Promise<WorkHistoryPage>;
  workContextStatus(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkContextStatus>;
  getWorkActivity(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  stopWork(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  resumeWork(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  listScopeStates(options?: ScopeListOptions & ControlClientCallOptions): Promise<ScopeListPage>;
  createScope(input: ScopeCreateInput, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  getScopeState(scopeId: string, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  updateScope(scopeId: string, input: ScopeUpdateInput, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  publishUserMessage(scopeId: string, input: UserMessageInput, options?: ControlClientCallOptions): Promise<StoredMessage>;
  listScopeReplicas(scopeId: string, options?: ReplicaListOptions & ControlClientCallOptions): Promise<ReplicaListPage>;
  live(botId: string, options?: ControlClientCallOptions): AsyncIterable<BotLiveFrame>;
  workLive(botId: string, scopeId: string, options?: ControlClientCallOptions): AsyncIterable<WorkLiveFrame>;
  getModelCatalog(options?: ControlClientCallOptions): Promise<ModelCatalog>;
  scopeHistory(scopeId: string, options?: ScopeHistoryOptions & ControlClientCallOptions): Promise<MessageHistoryPage>;
  getScopeMessage(scopeId: string, messageId: string, options?: ControlClientCallOptions): Promise<StoredMessage>;
  getScopeMessageDelivery(scopeId: string, messageId: string, options?: ControlClientCallOptions): Promise<MessageDeliveryStatus>;
  getLocalSettings(options?: ControlClientCallOptions): Promise<LocalSettingsSnapshot>;
  replaceLocalSettings(input: SettingsUpdate, options?: ControlClientCallOptions): Promise<LocalSettingsSnapshot>;
  getServiceStatus(options?: ControlClientCallOptions): Promise<HostServiceStatus>;
  getBotSoul(botId: string, options?: ControlClientCallOptions): Promise<BotSoul>;
  setBotSoul(botId: string, input: BotSoulUpdate, options?: ControlClientCallOptions): Promise<BotSoul>;
  scheduleTask(botId: string, input: Record<string, unknown>, options?: ControlClientCallOptions): Promise<Record<string, unknown>>;
  getShowerStatus(target: ShowerTarget, options?: ControlClientCallOptions): Promise<ShowerSession>;
  createShowerSession(target: ShowerTarget, input?: ShowerCreateOptions, options?: ControlClientCallOptions): Promise<ShowerSession>;
  getShowerFrame(target: ShowerTarget, sessionId: string, limits?: ShowerFrameLimits, options?: ControlClientCallOptions): Promise<ShowerFrame>;
  sendShowerInput(target: ShowerTarget, sessionId: string, input: ShowerInput, options?: ControlClientCallOptions): Promise<Record<string, unknown>>;
  takeoverShower(target: ShowerTarget, sessionId: string, options?: ControlClientCallOptions): Promise<ShowerSession>;
  releaseShowerSession(target: ShowerTarget, sessionId: string, options?: ControlClientCallOptions): Promise<Record<string, unknown>>;
}

/**
 * Module 14 types: host settings store, unified local service and runtime config helpers.
 */

export interface HostRelayConfig {
  url: string;
  tokenEnv: string;
  caFile?: string;
}

export interface HostSettings {
  runtime: RuntimeConfig;
  relay: HostRelayConfig | null;
}

export interface SettingsSnapshot {
  deviceId: string;
  revision: number;
  settings: HostSettings;
}

export interface SettingsUpdate {
  expectedRevision: number;
  settings: HostSettings;
}

/** Synchronous persistent settings facade; replace() is CAS on expectedRevision. */
export interface HostSettingsStore {
  readonly deviceId: string;
  get(): SettingsSnapshot;
  replace(update: SettingsUpdate): SettingsSnapshot;
  close(): void;
}

export function openHostSettings(options: { dataRoot: string; deviceId: string; initialSettings?: HostSettings }): HostSettingsStore;
export function normalizeHostSettings(value: unknown): HostSettings;

/** Local HTTP /v1/settings DTO; restartRequired compares the persisted vs active revision. */
export interface LocalSettingsSnapshot extends SettingsSnapshot {
  activeRevision: number;
  restartRequired: boolean;
}

export interface HostServiceOptions {
  dataRoot: string;
  token: string;
  port?: number;
  initialSettings?: HostSettings;
  center: { url: string; deviceToken: string; ca?: string };
  npmPath?: string;
  displayName?: string;
  platform?: string;
  /** Optional trusted JS native bridge for Android tools; never persisted as a settings field. */
  nativeBridge?: NativeBridge;
}

export interface HostServiceStatus {
  deviceId: string;
  phase: 'starting' | 'running' | 'closing' | 'closed';
  control: { url: string; listening: boolean };
  relay: DeviceLinkStatus | null;
  activeSettingsRevision: number;
  settingsRevision: number;
  restartRequired: boolean;
  center: CenterConnectionStatus;
}

export interface CenterProviderProbe { provider: Provider; models: CenterModel[]; credential?: string }
export interface CenterActionCall { installationId: string; action: string; request: ActionRequest }

export interface HostService {
  readonly deviceId: string;
  readonly url: string;
  getStatus(): HostServiceStatus;
  close(): Promise<void>;
}

export function openHostService(options: HostServiceOptions): Promise<HostService>;

export interface ParsedRuntimeConfig {
  models: Models;
  defaultModel: string | null;
  thinkingLevel?: ModelThinkingLevel;
  bashPath?: string;
  toolPaths?: { rg?: string; fd?: string };
  hindsight?: HindsightOptions;
  /** Effective extension config; hindsight above carries only an effectively enabled config. */
  extensions?: RuntimeExtensionsConfig;
}

export function normalizeRuntimeConfig(raw: unknown): RuntimeConfig;
export function parseRuntimeConfig(raw: unknown): ParsedRuntimeConfig;
export function describeModelCatalog(models: Models, defaultModel?: string | null): ModelCatalog;
export function loadRuntimeConfig(file: string): Promise<ParsedRuntimeConfig>;

/** Real UTF-8 SOUL.md at dataRoot/bots/<botId>/SOUL.md; path is relative, revision its SHA-256. */
export interface BotSoul {
  botId: string;
  path: string;
  revision: string;
  text: string;
}

/** CAS input for setBotSoul and PUT /v1/bots/:botId/soul; text is at most 64 KiB. */
export interface BotSoulUpdate {
  expectedRevision: string;
  text: string;
}

/** Canonical Host config `runtime.extensions`; legacy `runtime.hindsight` is still accepted. */
export interface HindsightExtensionConfig {
  enabled: boolean;
  /** Copied to a Bot only on its first initialization. */
  defaultEnabled: boolean;
  /** Required when enabled; may be retained while disabled. */
  config?: HindsightOptions;
}

export interface RuntimeExtensionsConfig {
  hindsight?: HindsightExtensionConfig;
}

/** Strict canonical map; undefined input stays undefined (unconfigured). */
export function normalizeRuntimeExtensions(value: unknown): RuntimeExtensionsConfig | undefined;
/** Effective map: explicit extensions win; legacy runtime.hindsight falls back to enabled+default. */
export function resolveRuntimeExtensions(input: {
  extensions?: RuntimeExtensionsConfig;
  hindsight?: HindsightOptions;
}): RuntimeExtensionsConfig;

/** Internal Bot extension row snapshot (legacy schema kept for the persisted retentionFloor). */
export interface BotExtensionState {
  botId: string;
  revision: number;
  extensions: Record<string, unknown>;
  retentionFloor: number;
}

/**
 * Module 7 types: host-owned persistent message ledger (messages.sqlite) on
 * this Host. Local-only storage plus a privileged offline CLI; no network
 * authentication, tunnel, center, LLM call, inference, or wakeup.
 */

/** A Bot member of a scope; members are always Bots, never the human owner. */
export interface MessageMember {
  deviceId: string;
  botId: string;
}

/** Message author: a Bot, or the single human owner (room public messages only). */
export type MessageAuthor =
  | { kind: 'bot'; botId: string }
  | { kind: 'user' };

export interface MessageScope {
  scopeId: string;
  kind: 'dm' | 'room';
  revision: number;
  members: MessageMember[];
}

export interface PublishMessageInput {
  messageId: string;
  scopeId: string;
  author: MessageAuthor;
  category: 'public' | 'notice' | 'request' | 'reply';
  text: string;
  replyTo?: string | null;
}

/** Optional local publication fence; not part of the message envelope or fingerprint. */
export interface MessagePublishGuard {
  /** Origin work scope whose input was observed; may differ from the publication target. */
  scopeId: string;
  /** Non-negative safe integer source localId watermark, not a token count or native EntryId. */
  afterLocalId: number;
}

export interface MessageEnvelope {
  protocolVersion: 1;
  messageId: string;
  sourceDeviceId: string;
  streamId: string;
  sequence: number;
  scopeId: string;
  revision: number;
  author: MessageAuthor;
  category: 'public' | 'notice' | 'request' | 'reply';
  rootId: string;
  replyTo: string | null;
  text: string;
  /** Whole canonical scope-revision member list, frozen with the message; not caller-chosen. */
  targets: MessageMember[];
  createdAt: string;
}

export interface MessagePeer {
  deviceId: string;
}

export interface MessageAck {
  protocolVersion: 1;
  messageId: string;
  sourceDeviceId: string;
  recipientDeviceId: string;
  digest: string;
  storedAt: string;
}

export interface StoredMessage {
  localId: number;
  message: MessageEnvelope;
  digest: string;
  storedAt: string;
  /** Unique rootId/replyTo IDs (excluding own root) not yet stored in the same scope, computed at read time. */
  missingRefs: string[];
}

export interface MessageCursor {
  deviceId: string;
  kind: 'history' | 'inbox' | 'outbox';
  key: string;
  afterLocalId: number;
  afterTargetDeviceId?: string;
}

/** Descending scope-history cursor; continues a 'descending' page toward older localIds. */
export interface MessageHistoryBeforeCursor {
  deviceId: string;
  kind: 'history-before';
  key: string;
  beforeLocalId: number;
}

export type MessageHistoryCursor = MessageCursor | MessageHistoryBeforeCursor;

export interface MessagePageOptions {
  limit?: number;
  cursor?: MessageCursor | null;
}

/** scopeHistory only; default order is 'ascending'. */
export interface ScopeHistoryOptions {
  limit?: number;
  cursor?: MessageHistoryCursor | null;
  order?: 'ascending' | 'descending';
}

export interface MessageInboxOptions extends MessagePageOptions {
  /** Filter frozen Bot targets by scope before paging; omission preserves the legacy inbox. */
  scopeId?: string;
}

export interface MessageOutboxOptions extends MessagePageOptions {
  scopeId?: string;
  targetDeviceId?: string;
}

export interface MessageStreamStatus {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  streamId: string;
  contiguous: number;
  highest: number;
  gaps: { from: number; to: number }[];
  gapsTruncated: boolean;
}

export interface MessageHistoryPage {
  deviceId: string;
  scopeId: string;
  /** Follow the requested order (default ascending). */
  items: StoredMessage[];
  /** Continues the requested order; 'history-before' variant for descending pages. */
  nextCursor: MessageHistoryCursor | null;
  /** Ascending 'history' cursor at the highest localId returned; null only when no items. */
  tailCursor: MessageCursor | null;
  /** Only streams represented by items on this page. */
  streams: MessageStreamStatus[];
}

export interface MessageInboxItem extends StoredMessage {
  selfEcho: boolean;
}

export interface MessageInboxPage {
  deviceId: string;
  botId: string;
  items: MessageInboxItem[];
  nextCursor: MessageCursor | null;
}

/** Direct counterpart replies to this local Bot's DM request; full immutable messages, not previews. */
export interface MessageRepliesPage {
  botId: string;
  requestMessageId: string;
  scopeId: string;
  items: MessageInboxItem[];
  /** kind:'inbox', key bound to this Bot/request and device; not a normal inbox cursor. */
  nextCursor: MessageCursor | null;
}

export interface MessageOutboxPage {
  deviceId: string;
  items: { targetDeviceId: string; message: MessageEnvelope }[];
  nextCursor: MessageCursor | null;
}

export interface MessageDeliveryStatus {
  messageId: string;
  targets: {
    deviceId: string;
    state: 'stored' | 'pending' | 'acked';
    acknowledgedAt: string | null;
  }[];
}

/**
 * Module 12 types: managed scope metadata (one authority Host creates/updates
 * the membership revision), metadata deliveries, and authenticated replica
 * repair. History is served only to known scope peers at a frozen revision;
 * peer stream observations never imply global completeness or online liveness.
 */

/** Managed scope create input; the store generates the scopeId inside its transaction. */
export interface ScopeCreateInput {
  requestId: string;
  kind: 'room' | 'dm';
  members: MessageMember[];
}

/** Managed scope update input; scopeId is a separate argument. */
export interface ScopeUpdateInput {
  requestId: string;
  expectedRevision: number;
  members: MessageMember[];
}

/** Canonical fixed-order record; authorityDeviceId is null only for legacy unmanaged scopes. */
export interface ScopeRecord {
  scope: MessageScope;
  authorityDeviceId: string | null;
}

/**
 * Managed scope state. delivery is present only when this Host is the authority
 * for the current/requested revision AND a local create/update operation exists
 * for that revision; a peer-recovered authority revision has no original
 * operation/delivery rows, so delivery is null even though isAuthority remains
 * true (no receipts are inferred or rebuilt). fullyAcknowledged is metadata
 * receipt only, not model/message completion.
 */
export interface ScopeInfo {
  scope: MessageScope;
  authorityDeviceId: string | null;
  isAuthority: boolean;
  delivery: {
    fullyAcknowledged: boolean;
    targets: {
      deviceId: string;
      state: 'pending' | 'acked';
      acknowledgedAt: string | null;
      lastErrorCode: string | null;
    }[];
  } | null;
}

export interface ScopeListCursor {
  deviceId: string;
  afterScopeId: string;
}

export interface ScopeListOptions {
  limit?: number;
  cursor?: ScopeListCursor | null;
}

export interface ScopeListPage {
  deviceId: string;
  items: ScopeInfo[];
  nextCursor: ScopeListCursor | null;
}

/** Scope revision acknowledgement; lowercase SHA-256 hex digest, peer identity supplied separately. */
export interface ScopeAck {
  scopeId: string;
  revision: number;
  digest: string;
}

export interface ScopeOfferCursor {
  scopeId: string;
  revision: number;
  targetDeviceId: string;
}

export interface ScopeOfferOptions {
  limit?: number;
  cursor?: ScopeOfferCursor | null;
}

export interface ScopeOfferPage {
  items: { targetDeviceId: string; record: ScopeRecord; digest: string }[];
  nextCursor: ScopeOfferCursor | null;
}

export interface InventoryCursor {
  deviceId: string;
  requesterDeviceId: string;
  scopeId: string;
  afterSourceDeviceId: string;
  afterStreamId: string;
}

export interface InventoryQuery {
  scopeId: string;
  limit?: number;
  cursor?: InventoryCursor | null;
}

/** Peer-observed stream holdings; contiguous <= count <= highest, never a global completeness guarantee. */
export interface ReplicaStream {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  streamId: string;
  contiguous: number;
  highest: number;
  count: number;
}

export interface InventoryPage {
  scopeId: string;
  items: ReplicaStream[];
  nextCursor: InventoryCursor | null;
}

/** Replica history query; pagination is by source sequence, not localId. */
export interface ReplicaHistoryQuery {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  afterSequence?: number;
  throughSequence: number;
  limit?: number;
}

/**
 * Authenticated known-peer history page for one frozen revision. Envelopes are
 * canonical and strict-ascending by source sequence; nextAfterSequence is null
 * on empty or exhausted pages and otherwise equals the last returned envelope.
 */
export interface ReplicaHistoryPage {
  record: ScopeRecord;
  sourceDeviceId: string;
  afterSequence: number;
  throughSequence: number;
  items: MessageEnvelope[];
  nextAfterSequence: number | null;
}

/** Missing-range query; no limit field. */
export interface MissingRangeQuery {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  afterSequence: number;
  throughSequence: number;
}

export interface MissingRange {
  from: number;
  to: number;
}

export interface ReplicaListCursor {
  deviceId: string;
  scopeId: string;
  afterPeerDeviceId: string;
  afterSourceDeviceId: string;
  afterStreamId: string;
}

export interface ReplicaListOptions {
  limit?: number;
  cursor?: ReplicaListCursor | null;
}

/**
 * Observed peer replica rows; no row means unknown, never inferred complete/offline.
 */
export interface ReplicaListPage {
  deviceId: string;
  scopeId: string;
  items: {
    peerDeviceId: string;
    stream: ReplicaStream;
    observedAt: string;
    lastScannedAt: string | null;
    lastErrorCode: string | null;
  }[];
  nextCursor: ReplicaListCursor | null;
}

/** Atomic replica history import result; nextAfterSequence echoes the imported page. */
export interface ImportReplicaHistoryResult {
  scopeId: string;
  revision: number;
  sourceDeviceId: string;
  imported: number;
  duplicates: number;
  nextAfterSequence: number | null;
}

/** Room-public user message input; author/category/source are injected by the normalizer. */
export interface UserMessageInput {
  messageId: string;
  text: string;
  replyTo?: string | null;
}

export interface MessageLog {
  readonly deviceId: string;
  readonly dataRoot: string;
  installScope(input: MessageScope): MessageScope;
  getScope(scopeId: string, revision?: number): MessageScope | null;
  listScopes(): MessageScope[];
  /**
   * Bot-only guard: atomically check origin membership; newer targeted non-self events cause STALE_INPUT.
   * Same-ID/fingerprint retries return the stored receipt before DB guard checks.
   * Omit guard for legacy behavior; null is invalid.
   */
  publish(input: PublishMessageInput, guard?: MessagePublishGuard): StoredMessage;
  getMessage(messageId: string): StoredMessage | null;
  receive(
    peer: MessagePeer,
    envelope: MessageEnvelope,
  ): { message: StoredMessage; ack: MessageAck; duplicate: boolean };
  acknowledge(peer: MessagePeer, ack: MessageAck): MessageDeliveryStatus;
  history(scopeId: string, options?: ScopeHistoryOptions): MessageHistoryPage;
  inbox(botId: string, options?: MessageInboxOptions): MessageInboxPage;
  /** Passive, authorized direct replyTo query; default limit 50, maximum 200. */
  replies(botId: string, requestMessageId: string, options?: MessagePageOptions): MessageRepliesPage;
  outbox(options?: MessageOutboxOptions): MessageOutboxPage;
  deliveryStatus(messageId: string): MessageDeliveryStatus;
  streamStatus(scopeId: string, revision: number, sourceDeviceId: string): MessageStreamStatus | null;
  /* Module 12: managed scope and replica facade methods. */
  createScope(input: ScopeCreateInput): ScopeInfo;
  updateScope(scopeId: string, input: ScopeUpdateInput): ScopeInfo;
  /** Latest/requested state; rejects SCOPE_NOT_FOUND when missing, never returns null. */
  getScopeState(scopeId: string, revision?: number): ScopeInfo;
  listScopeStates(options?: ScopeListOptions): ScopeListPage;
  getScopeRecord(scopeId: string, revision?: number): ScopeRecord | null;
  /** Commits the offer and returns the ScopeAck to send back to the peer. */
  acceptScopeOffer(peer: MessagePeer, record: ScopeRecord): ScopeAck;
  acknowledgeScope(peer: MessagePeer, ack: ScopeAck): void;
  recordScopeError(peer: MessagePeer, ack: ScopeAck, code: string): void;
  scopeOffers(options?: ScopeOfferOptions): ScopeOfferPage;
  replicaInventory(peer: MessagePeer, query: InventoryQuery): InventoryPage;
  /** Authenticated known-peer, frozen-revision history page. */
  replicaHistory(peer: MessagePeer, query: ReplicaHistoryQuery): ReplicaHistoryPage;
  nextMissingRange(query: MissingRangeQuery): MissingRange | null;
  listScopeReplicas(scopeId: string, options?: ReplicaListOptions): ReplicaListPage;
  listReplicaPeers(scopeId: string): string[];
  recordReplicaInventory(peer: MessagePeer, query: InventoryQuery, page: InventoryPage): void;
  importReplicaHistory(peer: MessagePeer, query: ReplicaHistoryQuery, page: ReplicaHistoryPage): ImportReplicaHistoryResult;
  /** code null or a stable uppercase/underscore code; records a requested-interval scan only. */
  recordReplicaScan(peer: MessagePeer, query: ReplicaHistoryQuery, code?: string | null): void;
  close(): void;
}

export function openMessageLog(options: { dataRoot: string }): MessageLog;

/**
 * Module 8 types: authenticated device relay + Host message delivery. The
 * centre stores device registration only (relay.sqlite); delivery reuses the
 * module 7 durable outbox. MessageDeliveryStatus above remains the module 7
 * ledger DTO; DeliveryPumpStatus is separate volatile diagnostics.
 */

export interface RelayDevice {
  deviceId: string;
  credentialVersion: number;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  displayName: string | null;
  platform: string | null;
}

export interface RelayListActiveOptions {
  limit?: number;
  cursor?: { afterDeviceId: string } | null;
}

export interface RelayListActivePage {
  items: RelayDevice[];
  nextCursor: { afterDeviceId: string } | null;
}

export interface RelayRegistryInput {
  deviceId: string;
  token: string;
}

export interface RelayRegistry {
  readonly dataRoot: string;
  register(input: RelayRegistryInput & { displayName?: string }): RelayDevice;
  rotate(input: RelayRegistryInput): RelayDevice;
  revoke(deviceId: string): RelayDevice;
  rename(deviceId: string, displayName: string): RelayDevice;
  updateMetadata(deviceId: string, metadata: { displayName?: string; platform?: string }): RelayDevice;
  get(deviceId: string): RelayDevice | null;
  list(): RelayDevice[];
  /** Active registrations only, keyset-paged by UTF-8 BINARY deviceId. */
  listActive(options?: RelayListActiveOptions): RelayListActivePage;
  authenticate(deviceId: string, token: string): RelayDevice | null;
  close(): void;
}

export function openRelayRegistry(options: { dataRoot: string }): RelayRegistry;

export interface RelayServerStatus {
  onlineDeviceIds: string[];
  pendingConnections: number;
}

export interface OpenRelayServerOptions {
  dataRoot: string;
  port?: number;
  listenHost?: string;
  tls?: { cert: string; key: string };
}

export interface RelayServer {
  readonly url: string;
  getStatus(): RelayServerStatus;
  close(): Promise<void>;
}

export function openRelayServer(options: OpenRelayServerOptions): Promise<RelayServer>;

export interface DeliveryPumpProblem {
  code: string;
  targetDeviceId: string | null;
  messageId: string | null;
  at: string;
}

export interface DeliveryPumpStatus {
  inFlight: number;
  lastProblem: DeliveryPumpProblem | null;
}

export type DeviceLinkPhase = 'connecting' | 'online' | 'backoff' | 'blocked' | 'closed';

export interface ScopeDeliveryStatus {
  online: boolean;
  inFlight: number;
  /** Transient diagnostics; scopeId/targetDeviceId are null on general storage failure; no timestamp field. */
  lastProblem: { scopeId: string | null; targetDeviceId: string | null; code: string } | null;
}

export interface ReplicaSyncStatus {
  online: boolean;
  inFlight: number;
  activePairs: number;
  /** Transient diagnostics; scopeId/peerDeviceId are null on general storage failure; no timestamp field. */
  lastProblem: { scopeId: string | null; peerDeviceId: string | null; code: string } | null;
}

export interface DeviceLinkStatus {
  deviceId: string;
  phase: DeviceLinkPhase;
  attempt: number;
  lastError: string | null;
  delivery: DeliveryPumpStatus;
  scopeDelivery: ScopeDeliveryStatus;
  replicaSync: ReplicaSyncStatus;
}

export interface OpenDeviceLinkOptions {
  displayName?: string;
  platform?: string;
  dataRoot: string;
  url: string;
  token: string;
  ca?: string;
  /** Optional local loopback Control API pair; when set, hello carries role:'host',controlProtocol:2 and the ready echo must carry controlProtocol:2. */
  control?: { url: string; token: string };
  onStatus?: (status: DeviceLinkStatus) => void;
}

export interface DeviceLink {
  readonly deviceId: string;
  getStatus(): DeviceLinkStatus;
  wake(): void;
  close(): Promise<void>;
}

export function openDeviceLink(options: OpenDeviceLinkOptions): Promise<DeviceLink>;

/**
 * Module 9 types: authenticated remote Host JSON control over the module 8
 * relay. The Node client opens an explicit 'client' role connection; the
 * target Host remains the sole authority for Bot cwd/create, inference,
 * tools and history. Module 14 extends the fixed v1 ten with the v2 additions
 * (work-context, scope, memory, model catalog); the managed-extension/SOUL
 * methods and the unified Shower six are additive v2 on the same table.
 */

export type RemoteControlOutcome = 'not-sent' | 'unconfirmed' | 'responded';

/**
 * Fixed JSON method table: the legacy v1 ten plus additive v2 methods (see
 * CONTROL_METHODS in remote-control-protocol.js for the authoritative list and
 * count); params/results reuse the DTOs above.
 */
export interface RemoteControlMethodMap {
  getHostInfo: { params: Record<string, never>; result: ControlHostInfo };
  getServiceStatus: { params: Record<string, never>; result: HostServiceStatus };
  listBots: { params: Record<string, never>; result: BotRecord[] };
  createBot: { params: CreateBotInput; result: BotRecord };
  updateBotProfile: { params: UpdateBotProfileInput; result: BotRecord };
  setPrimaryBot: { params: { botId: string }; result: BotRecord };
  archiveBot: { params: { botId: string }; result: BotRecord };
  unarchiveBot: { params: { botId: string }; result: BotRecord };
  deleteBot: { params: { botId: string }; result: DeleteBotResult };
  getBot: { params: { botId: string }; result: BotRecord };
  findByRequest: { params: { requestId: string }; result: BotRecord };
  submit: { params: { botId: string; requestId: string; text: string; attachments?: string[] }; result: PrimarySubmission };
  getSubmission: { params: { botId: string; requestId: string }; result: PrimarySubmission };
  history: { params: HistoryOptions & { botId: string }; result: HistoryPage };
  clearHistory: { params: { botId: string }; result: ClearHistoryResult };
  compact: { params: { botId: string }; result: CompactResult };
  abort: { params: { botId: string }; result: { botId: string } };
  contextStatus: { params: { botId: string }; result: ContextStatus };
  /* Module 14 v2 additions; memory wire params are always {botId,input}. */
  getModelCatalog: { params: Record<string, never>; result: ModelCatalog };
  getWorkContext: { params: { botId: string; scopeId: string }; result: WorkContextRecord };
  syncWorkContext: { params: { botId: string; scopeId: string; input?: WorkSyncOptions }; result: WorkSyncResult };
  workHistory: { params: { botId: string; scopeId: string; limit?: number; cursor?: WorkHistoryCursor | null }; result: WorkHistoryPage };
  workContextStatus: { params: { botId: string; scopeId: string }; result: WorkContextStatus };
  getWorkActivity: { params: { botId: string; scopeId: string }; result: WorkActivity };
  stopWork: { params: { botId: string; scopeId: string }; result: WorkActivity };
  resumeWork: { params: { botId: string; scopeId: string }; result: WorkActivity };
  listScopeStates: { params: { limit?: number; cursor?: ScopeListCursor | null }; result: ScopeListPage };
  createScope: { params: { input: ScopeCreateInput }; result: ScopeInfo };
  getScopeState: { params: { scopeId: string }; result: ScopeInfo };
  updateScope: { params: { scopeId: string; input: ScopeUpdateInput }; result: ScopeInfo };
  publishUserMessage: { params: { scopeId: string; input: UserMessageInput }; result: StoredMessage };
  listScopeReplicas: { params: { scopeId: string; limit?: number; cursor?: ReplicaListCursor | null }; result: ReplicaListPage };
  scopeHistory: { params: { scopeId: string; limit?: number; cursor?: MessageHistoryCursor | null; order?: 'ascending' | 'descending' }; result: MessageHistoryPage };
  getScopeMessage: { params: { scopeId: string; messageId: string }; result: StoredMessage };
  getScopeMessageDelivery: { params: { scopeId: string; messageId: string }; result: MessageDeliveryStatus };
  memoryStatus: { params: { botId: string; input?: MemoryStatusInput }; result: MemoryStatus };
  recallMemory: { params: { botId: string; input: MemoryQueryInput }; result: MemoryRecallResult };
  reflectMemory: { params: { botId: string; input: MemoryQueryInput }; result: MemoryReflectResult };
  retainMemory: { params: { botId: string; input: MemoryRetainInput }; result: MemoryRetainReceipt };
  getMemory: { params: { botId: string; input: MemoryLookupInput }; result: MemoryGetResult };
  getMemorySource: { params: { botId: string; input: MemorySourceInput }; result: MemorySourceResult };
  correctMemory: { params: { botId: string; input: MemoryCorrectionInput }; result: MemoryCorrectionReceipt };
  retryMemory: { params: { botId: string; input: MemoryRetryInput }; result: MemoryReceipt };
  /* Per-Bot SOUL; setters are CAS and never replayed. */
  getBotSoul: { params: { botId: string }; result: BotSoul };
  setBotSoul: { params: { botId: string; input: BotSoulUpdate }; result: BotSoul };
  /* Unified Shower: same names/shapes on every platform; no platform handles or credentials. */
  getShowerStatus: { params: { botId: string; scopeId?: string }; result: ShowerSession };
  createShowerSession: {
    params: { botId: string; scopeId?: string; input?: ShowerCreateOptions };
    result: ShowerSession;
  };
  getShowerFrame: {
    params: { botId: string; scopeId?: string; sessionId: string; limits?: ShowerFrameLimits };
    result: ShowerFrame;
  };
  sendShowerInput: {
    params: { botId: string; scopeId?: string; sessionId: string; input: ShowerInput };
    result: Record<string, unknown>;
  };
  takeoverShower: { params: { botId: string; scopeId?: string; sessionId: string }; result: ShowerSession };
  releaseShowerSession: {
    params: { botId: string; scopeId?: string; sessionId: string };
    result: Record<string, unknown>;
  };
  scheduleTask: { params: { botId: string; input: Record<string, unknown> }; result: Record<string, unknown> };
  /* Image attachments: upload is per-Bot and content-addressed; read returns metadata + base64 data. */
  uploadAttachment: { params: AttachmentUploadInput & { botId: string }; result: ImageAttachment };
  getAttachment: { params: { botId: string; attachmentId: string }; result: ImageAttachmentData };
  putBotFileChunk: { params: BotFileChunkInput & { botId: string }; result: BotFileReceipt };
  validateCenterProvider: { params: CenterProviderProbe; result: ProviderCheckResult };
  discoverCenterProviderModels: { params: CenterProviderProbe; result: DiscoveryResult };
  callCapabilityAction: { params: CenterActionCall; result: ActionResult };
  discoverProviderModels: {
    params: {
      input: {
        baseUrl?: string;
        apiKey?: string;
        apiKeyEnv?: string;
        api?: string;
        syncEnvOnly?: boolean;
      };
    };
    result: {
      models: { id: string; name: string; reasoning: boolean; contextWindow: number }[];
    };
  };
}

export interface OpenRemoteControlOptions {
  deviceId: string;
  url: string;
  token: string;
  ca?: string;
  /** Startup AbortSignal; applies only until open() resolves. */
  signal?: AbortSignal;
  /** Called once after an established connection ends unexpectedly. */
  onClose?: (error: RemoteControlError) => void;
}

export interface DevicesDirectoryItem {
  deviceId: string;
  displayName: string;
  platform?: string;
  online: boolean;
  controlProtocol: 0 | 1 | 2;
  scopeProtocol: 0 | 1;
}

export interface BotDirectoryEntry extends BotRecord {
  avatar?: BotAvatar | null;
  avatarRevision?: number;
  /** Center CAS revision for the authoritative cwd; absent on legacy centers/local-only records. */
  cwdRevision?: number;
  deviceName: string;
  platform?: string;
  online: boolean;
}

export interface BotDirectorySnapshot {
  devices: DevicesDirectoryItem[];
  bots: BotDirectoryEntry[];
  errors: Array<{ deviceId: string; code: string; message?: string }>;
}

export function collectBotDirectory(options: {
  listDevices(options: { limit?: number; cursor?: { afterDeviceId: string } | null }): Promise<DevicesDirectoryPage>;
  listBots(deviceId: string): Promise<BotRecord[]>;
}): Promise<BotDirectorySnapshot>;

export interface DevicesDirectoryPage {
  items: DevicesDirectoryItem[];
  nextCursor: { afterDeviceId: string } | null;
}

export type LiveTarget =
  | { kind: 'primary'; botId: string }
  | { kind: 'work'; botId: string; scopeId: string };

/**
 * Remote live snapshot: strictly a primary snapshot (no scopeId, non-null
 * conversationId) or a work snapshot; an illegal primary-null blend is never
 * representable. The primary arm is discriminated by the absence of scopeId
 * (scopeId?: never), so consumers can branch on the presence of scopeId.
 */
export type RemoteLiveSnapshot = (BotLiveSnapshot & { scopeId?: never }) | WorkLiveSnapshot;

export interface RemoteLiveEnd {
  type: 'end';
  reason: BotWatchEndReason;
}

export interface RemoteControl {
  readonly deviceId: string;
  call<K extends keyof RemoteControlMethodMap>(
    targetDeviceId: string,
    method: K,
    params: RemoteControlMethodMap[K]['params'],
    options?: { signal?: AbortSignal },
  ): Promise<RemoteControlMethodMap[K]['result']>;
  /** Active device directory over the same authenticated relay connection; reads only. */
  listDevices(options?: { limit?: number; cursor?: { afterDeviceId: string } | null; signal?: AbortSignal }): Promise<DevicesDirectoryPage>;
  renameDevice(input: { deviceId: string; displayName: string }, options?: { signal?: AbortSignal }): Promise<DevicesDirectoryItem>;
  /** Live preview subscription; error ends throw RemoteControlError instead of being yielded. */
  live(targetDeviceId: string, target: LiveTarget, options?: { signal?: AbortSignal }): AsyncIterable<RemoteLiveSnapshot | RemoteLiveEnd>;
  close(): void;
}

export function openRemoteControl(options: OpenRemoteControlOptions): Promise<RemoteControl>;

export class RemoteControlError extends Error {
  constructor(code: string, outcome: RemoteControlOutcome);
  readonly code: string;
  readonly outcome: RemoteControlOutcome;
}

export interface LocalControlAdapterOptions {
  /** Loopback HTTP base URL (http://127.0.0.1 or http://[::1], path /). */
  url: string;
  /** Opaque URL-safe bearer token (32-512 chars). */
  token: string;
}

export interface LocalControlAdapterCallOptions {
  signal?: AbortSignal;
}

export interface LocalControlAdapter {
  <K extends keyof RemoteControlMethodMap>(
    expectedDeviceId: string,
    method: K,
    params?: RemoteControlMethodMap[K]['params'],
    options?: LocalControlAdapterCallOptions,
  ): Promise<RemoteControlMethodMap[K]['result']>;
  live(
    expectedDeviceId: string,
    target: LiveTarget,
    options?: LocalControlAdapterCallOptions,
  ): AsyncIterable<BotLiveFrame | WorkLiveFrame>;
  getHostInfo(options?: LocalControlAdapterCallOptions): Promise<ControlHostInfo>;
  getSettings(expectedDeviceId: string, options?: LocalControlAdapterCallOptions): Promise<LocalSettingsSnapshot>;
  setSettings(
    expectedDeviceId: string,
    input: SettingsUpdate,
    options?: LocalControlAdapterCallOptions,
  ): Promise<LocalSettingsSnapshot>;
  getServiceStatus(expectedDeviceId: string, options?: LocalControlAdapterCallOptions): Promise<HostServiceStatus>;
}

/**
 * Module 14 types: client-side pending outbox for fixed business operations.
 */

export type PendingState = 'pending' | 'sending' | 'unconfirmed' | 'accepted' | 'rejected';

export type PendingEnqueueInput =
  | {
      kind: 'primary';
      targetDeviceId: string;
      botId: string;
      requestId: string;
      /** Blank text is allowed only together with a non-empty attachments list. */
      text: string;
      /** Ordered previously-uploaded image attachment IDs (lowercase hex SHA-256), at most 16. */
      attachments?: string[];
    }
  | { kind: 'room'; targetDeviceId: string; scopeId: string; messageId: string; text: string; replyTo?: string | null };

export interface PendingRecordBase {
  id: string;
  deviceId: string;
  targetDeviceId: string;
  text: string;
  state: PendingState;
  receipt: Record<string, unknown> | null;
  lastError: { code: string; outcome: RemoteControlOutcome } | null;
  createdAt: string;
  updatedAt: string;
}

export type PendingRecord =
  | (PendingRecordBase & { kind: 'primary'; botId: string; requestId: string; attachments?: string[] })
  | (PendingRecordBase & { kind: 'room'; scopeId: string; messageId: string; replyTo: string | null });

export interface PendingCursor {
  deviceId: string;
  state: PendingState | null;
  afterId: string;
}

export interface PendingListOptions {
  state?: PendingState | null;
  limit?: number;
  cursor?: PendingCursor | null;
}

export interface PendingListPage {
  items: PendingRecord[];
  nextCursor: PendingCursor | null;
}

/** Fixed injected transport: four business operations only, never an arbitrary proxy. */
export interface PendingCall {
  (targetDeviceId: string, method: 'submit', params: { botId: string; requestId: string; text: string; attachments?: string[] }, options?: { signal?: AbortSignal }): Promise<PrimarySubmission>;
  (targetDeviceId: string, method: 'getSubmission', params: { botId: string; requestId: string }, options?: { signal?: AbortSignal }): Promise<PrimarySubmission | null>;
  (targetDeviceId: string, method: 'publishUserMessage', params: { scopeId: string; input: UserMessageInput }, options?: { signal?: AbortSignal }): Promise<StoredMessage>;
  (targetDeviceId: string, method: 'getScopeMessage', params: { scopeId: string; messageId: string }, options?: { signal?: AbortSignal }): Promise<StoredMessage | null>;
}

export interface PendingClient {
  enqueue(input: PendingEnqueueInput): Promise<PendingRecord>;
  get(id: string): Promise<PendingRecord | null>;
  list(options?: PendingListOptions): Promise<PendingListPage>;
  send(id: string, options?: { signal?: AbortSignal }): Promise<PendingRecord>;
  reconcile(id: string, options?: { signal?: AbortSignal }): Promise<PendingRecord>;
  /** Locally withdraw a queued record only; never aborts or stops remote Host work. */
  cancel(id: string): Promise<PendingRecord>;
  close(): Promise<void>;
}

export function openPendingClient(options: { dataRoot: string; deviceId: string; call: PendingCall }): PendingClient;
