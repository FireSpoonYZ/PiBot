import type {
  BotRecord,
  BotBoardParams,
  BotBoardSnapshot,
  CreateBotInput,
  UpdateBotProfileInput,
  PrimarySubmission,
  SubmissionInput,
  AttachmentUploadInput,
  ImageAttachment,
  ImageAttachmentData,
  BotFileChunkInput,
  BotFileReceipt,
  HistoryOptions,
  HistoryPage,
  ClearHistoryResult,
  CompactResult,
  ContextStatus,
  WorkContextRecord,
  WorkSyncOptions,
  WorkSyncResult,
  WorkHistoryCursor,
  WorkHistoryPage,
  WorkContextStatus,
  WorkActivity,
  ControlHostInfo,
  BotLiveFrame,
  ScopeCreateInput,
  ScopeUpdateInput,
  ScopeDeleteInput,
  ScopeInfo,
  ScopeListOptions,
  ScopeListPage,
  ReplicaListOptions,
  ReplicaListPage,
  UserMessageInput,
  StoredMessage,
  MemoryStatusInput,
  MemoryStatus,
  MemoryQueryInput,
  MemoryRecallResult,
  MemoryReflectResult,
  MemoryRetainInput,
  MemoryRetainReceipt,
  MemoryLookupInput,
  MemoryGetResult,
  MemorySourceInput,
  MemorySourceResult,
  MemoryCorrectionInput,
  MemoryCorrectionReceipt,
  MemoryRetryInput,
  MemoryReceipt,
  MessageHistoryCursor,
  ScopeHistoryOptions,
  MessageHistoryPage,
  MessageDeliveryStatus,
  ModelCatalog,
  LocalSettingsSnapshot,
  SettingsUpdate,
  HostServiceStatus,
  CenterProviderProbe,
  CenterActionCall,
  BotSoul,
  BotSoulUpdate,
  BotLearningInput,
  WorkLiveFrame,
  ShowerCreateOptions,
  ShowerFrame,
  ShowerFrameLimits,
  ShowerInput,
  ShowerSession,
  ShowerTarget
} from './index.js';

export class ControlApiError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  constructor(message: string, options?: { status?: number; code?: string });
}

export interface ControlClientOptions {
  /** http(s) control server base URL; must not contain userinfo, a fragment, or a token query parameter. */
  url: string;
  /** Opaque URL-safe bearer token. */
  token: string;
  /** Injectable native fetch; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface ControlClientCallOptions {
  /** Cancels only HTTP; does not abort inference or roll back accepted imports/stop/resume operations. */
  signal?: AbortSignal;
}

export interface HistoryClientOptions extends HistoryOptions {
  signal?: AbortSignal;
}

export interface WorkHistoryClientOptions extends ControlClientCallOptions {
  limit?: number;
  cursor?: WorkHistoryCursor | null;
}

export interface LiveClientOptions {
  signal?: AbortSignal;
}

export interface ScopeListClientOptions extends ScopeListOptions {
  signal?: AbortSignal;
}

export interface ReplicaListClientOptions extends ReplicaListOptions {
  signal?: AbortSignal;
}

export interface ScopeHistoryClientOptions extends ControlClientCallOptions, ScopeHistoryOptions {}

export interface ControlClient {
  validateCenterProvider(input: CenterProviderProbe, options?: ControlClientCallOptions): Promise<import('../center-contract/index.js').ProviderCheckResult>;
  discoverCenterProviderModels(input: CenterProviderProbe, options?: ControlClientCallOptions): Promise<import('../center-contract/index.js').DiscoveryResult>;
  callCapabilityAction(input: CenterActionCall, options?: ControlClientCallOptions): Promise<import('../center-contract/index.js').ActionResult>;
  getHostInfo(options?: ControlClientCallOptions): Promise<ControlHostInfo>;
  listBots(options?: ControlClientCallOptions): Promise<BotRecord[]>;
  createBot(input: CreateBotInput, options?: ControlClientCallOptions): Promise<BotRecord>;
  updateBotProfile(input: UpdateBotProfileInput, options?: ControlClientCallOptions): Promise<BotRecord>;
  getBot(botId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  findByRequest(requestId: string, options?: ControlClientCallOptions): Promise<BotRecord>;
  submit(botId: string, input: SubmissionInput, options?: ControlClientCallOptions): Promise<PrimarySubmission>;
  getSubmission(botId: string, requestId: string, options?: ControlClientCallOptions): Promise<PrimarySubmission>;
  uploadAttachment(botId: string, input: AttachmentUploadInput, options?: ControlClientCallOptions): Promise<ImageAttachment>;
  getAttachment(botId: string, attachmentId: string, options?: ControlClientCallOptions): Promise<ImageAttachmentData>;
  putBotFileChunk(botId: string, input: BotFileChunkInput, options?: ControlClientCallOptions): Promise<BotFileReceipt>;
  history(botId: string, options?: HistoryClientOptions): Promise<HistoryPage>;
  getBotBoard(params: BotBoardParams, options?: ControlClientCallOptions): Promise<BotBoardSnapshot>;
  clearHistory(botId: string, options?: ControlClientCallOptions): Promise<ClearHistoryResult>;
  compact(botId: string, options?: ControlClientCallOptions): Promise<CompactResult>;
  abort(botId: string, options?: ControlClientCallOptions): Promise<{ botId: string }>;
  contextStatus(botId: string, options?: ControlClientCallOptions): Promise<ContextStatus>;
  getWorkContext(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkContextRecord>;
  syncWorkContext(botId: string, scopeId: string, input?: WorkSyncOptions, options?: ControlClientCallOptions): Promise<WorkSyncResult>;
  workHistory(botId: string, scopeId: string, options?: WorkHistoryClientOptions): Promise<WorkHistoryPage>;
  workContextStatus(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkContextStatus>;
  /** Passive query; an authorized unbound scope returns status:'unbound'. */
  getWorkActivity(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  /** Persistent stop for this work context; does not affect primary/other scopes. */
  stopWork(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  /** Explicit resume for a current member; posts {}, not a global Runtime.resume(). */
  resumeWork(botId: string, scopeId: string, options?: ControlClientCallOptions): Promise<WorkActivity>;
  /* Module 12: six managed-scope methods; also exposed via the module 14 remote v2 table. */
  listScopeStates(options?: ScopeListClientOptions): Promise<ScopeListPage>;
  createScope(input: ScopeCreateInput, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  /** Latest state; a missing scope rejects with ControlApiError (404 SCOPE_NOT_FOUND), never null success. */
  getScopeState(scopeId: string, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  updateScope(scopeId: string, input: ScopeUpdateInput, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  /** Authority-only room dissolve; resolves with the deletedAt tombstone ScopeInfo. */
  deleteScope(scopeId: string, input: ScopeDeleteInput, options?: ControlClientCallOptions): Promise<ScopeInfo>;
  /** Room-public user message ledger receipt; not delivery/inference completion. */
  publishUserMessage(scopeId: string, input: UserMessageInput, options?: ControlClientCallOptions): Promise<StoredMessage>;
  listScopeReplicas(scopeId: string, options?: ReplicaListClientOptions): Promise<ReplicaListPage>;
  /* Module 13: eight Hindsight memory methods; also exposed via the module 14 remote v2 table. */
  memoryStatus(botId: string, input?: MemoryStatusInput, options?: ControlClientCallOptions): Promise<MemoryStatus>;
  recallMemory(botId: string, input: MemoryQueryInput, options?: ControlClientCallOptions): Promise<MemoryRecallResult>;
  reflectMemory(botId: string, input: MemoryQueryInput, options?: ControlClientCallOptions): Promise<MemoryReflectResult>;
  retainMemory(botId: string, input: MemoryRetainInput, options?: ControlClientCallOptions): Promise<MemoryRetainReceipt>;
  getMemory(botId: string, input: MemoryLookupInput, options?: ControlClientCallOptions): Promise<MemoryGetResult>;
  getMemorySource(botId: string, input: MemorySourceInput, options?: ControlClientCallOptions): Promise<MemorySourceResult>;
  correctMemory(botId: string, input: MemoryCorrectionInput, options?: ControlClientCallOptions): Promise<MemoryCorrectionReceipt>;
  retryMemory(botId: string, input: MemoryRetryInput, options?: ControlClientCallOptions): Promise<MemoryReceipt>;
  /** Consume the authenticated live SSE stream for a bot; ends on an end frame, break/return, or signal abort. */
  live(botId: string, options?: LiveClientOptions): AsyncIterable<BotLiveFrame>;
  /* Module 14: model catalog, scope message queries, settings and service status. */
  getModelCatalog(options?: ControlClientCallOptions): Promise<ModelCatalog>;
  scopeHistory(scopeId: string, options?: ScopeHistoryClientOptions): Promise<MessageHistoryPage>;
  getScopeMessage(scopeId: string, messageId: string, options?: ControlClientCallOptions): Promise<StoredMessage>;
  getScopeMessageDelivery(scopeId: string, messageId: string, options?: ControlClientCallOptions): Promise<MessageDeliveryStatus>;
  /** Work-context live SSE; full snapshots plus the transport end frame. */
  workLive(botId: string, scopeId: string, options?: LiveClientOptions): AsyncIterable<WorkLiveFrame>;
  getLocalSettings(options?: ControlClientCallOptions): Promise<LocalSettingsSnapshot>;
  replaceLocalSettings(input: SettingsUpdate, options?: ControlClientCallOptions): Promise<LocalSettingsSnapshot>;
  getServiceStatus(options?: ControlClientCallOptions): Promise<HostServiceStatus>;
  /* Per-Bot SOUL; set methods are CAS and never replayed. */
  getBotSoul(botId: string, options?: ControlClientCallOptions): Promise<BotSoul>;
  setBotSoul(botId: string, input: BotSoulUpdate, options?: ControlClientCallOptions): Promise<BotSoul>;
  manageBotLearning(botId: string, input: BotLearningInput, options?: ControlClientCallOptions): Promise<Record<string, unknown>>;
  /*
   * Unified Shower (Android/Windows/Linux): same argument order as the Runtime
   * methods, with this client's trailing {signal} options. The body stays the
   * remote v2 params {botId, scopeId?, ...}; Actor/targetDeviceId are never
   * client supplied. takeover/release are not replayed.
   */
  getShowerStatus(target: ShowerTarget, options?: ControlClientCallOptions): Promise<ShowerSession>;
  createShowerSession(
    target: ShowerTarget,
    input?: ShowerCreateOptions,
    options?: ControlClientCallOptions
  ): Promise<ShowerSession>;
  getShowerFrame(
    target: ShowerTarget,
    sessionId: string,
    limits?: ShowerFrameLimits,
    options?: ControlClientCallOptions
  ): Promise<ShowerFrame>;
  sendShowerInput(
    target: ShowerTarget,
    sessionId: string,
    input: ShowerInput,
    options?: ControlClientCallOptions
  ): Promise<Record<string, unknown>>;
  /** Aborts the matching conversation; resolves with the current status. */
  takeoverShower(
    target: ShowerTarget,
    sessionId: string,
    options?: ControlClientCallOptions
  ): Promise<ShowerSession>;
  releaseShowerSession(
    target: ShowerTarget,
    sessionId: string,
    options?: ControlClientCallOptions
  ): Promise<Record<string, unknown>>;
}

export function createControlClient(options: ControlClientOptions): ControlClient;
