// Module 17 desktop client shared types (core-owned). All host-core DTOs are
// imported by type only, never as runtime values.

// 本地绑定：接口/类型别名体内直接引用的名字必须全部 import type
// （export type {...} 不创建本地绑定），与下方 re-export 并存。
import type {
  DesktopClientStatus,
  DesktopConnectionInput,
  DesktopDraftEntry,
  DesktopDraftFileRef,
  DesktopErrorShape,
  DesktopIntentMethod,
  DesktopObservationEvent,
  DesktopOperationMap,
  DesktopUiIntent,
  DesktopUiProfile,
  DesktopUiSnapshot,
  DesktopUiState,
} from '../../../host-core/desktop-client.js';
import type {
  CreateBotInput,
  DevicesDirectoryItem,
  DevicesDirectoryPage,
  HostServiceStatus,
  HostSettings,
  LiveTarget,
  LocalSettingsSnapshot,
  PendingCursor,
  PendingListOptions,
  PendingListPage,
  PendingRecord,
  PendingState,
  PrimarySubmission,
  RemoteControlMethodMap,
  RemoteControlOutcome,
  ScopeCreateInput,
  ScopeUpdateInput,
  ScopeDeleteInput,
  SettingsUpdate,
  TurnAdmissionStatus,
} from '../../../host-core/index.js';

export type {
  DesktopObservationEvent,
  DesktopUiSnapshot,
  DesktopUiState,
  DesktopUiProfile,
  DesktopUiIntent,
  DesktopDraftEntry,
  DesktopDraftFileRef,
  DesktopOperationMap,
  DesktopClientStatus,
  DesktopConnectionInput,
  DesktopErrorShape,
  DesktopIntentMethod,
} from '../../../host-core/desktop-client.js';

export type {
  LiveTarget,
  PrimarySubmission,
  TurnAdmissionStatus,
  RemoteControlMethodMap,
  RemoteControlOutcome,
  PendingRecord,
  PendingState,
  PendingCursor,
  PendingListOptions,
  PendingListPage,
  DevicesDirectoryPage,
  DevicesDirectoryItem,
  LocalSettingsSnapshot,
  HostSettings,
  HostServiceStatus,
  SettingsUpdate,
  CreateBotInput,
  ScopeCreateInput,
  ScopeUpdateInput,
  ScopeDeleteInput,
} from '../../../host-core/index.js';

/** 前端冻结的操作身份：generation 标识连接，目标设备独立路由。 */
export interface DesktopIdentity {
  profileId: string;
  targetDeviceId: string;
  generation: number;
  kind: 'local' | 'relay';
}

export interface ObservationHandle {
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

/**
 * 公共 broker op map：已有 DesktopOperationMap 的公共操作（排除 observe/unobserve）
 * 加本地 observe_ack 的交叉映射；用映射索引取 params/result，避免条件类型无法赋值。
 */
export type BrokerOpMap = Omit<DesktopOperationMap, 'observe' | 'unobserve'> & {
  observe_ack: {
    params: { observationId: string; deliveryId: string };
    result: { acknowledged: boolean };
  };
};

export type PublicBrokerOperation = keyof BrokerOpMap;

export type BrokerOpParams<K extends PublicBrokerOperation> = BrokerOpMap[K]['params'];

export type BrokerOpResult<K extends PublicBrokerOperation> = BrokerOpMap[K]['result'];

export type PendingOperation =
  | 'pending_enqueue'
  | 'pending_get'
  | 'pending_list'
  | 'pending_send'
  | 'pending_reconcile'
  | 'pending_cancel';

/** 共享给功能组件（BotChats/Scopes）的视图 API。 */
export interface DesktopViewApi {
  readonly identity: DesktopIdentity | null;
  identityForTarget(targetDeviceId: string): DesktopIdentity;
  readonly snapshot: DesktopUiSnapshot | null;
  /** 仅表示客户端 transport 连接；不表示目标 Host 在线或 Agent 就绪。 */
  readonly transportConnected: boolean;
  call<M extends keyof RemoteControlMethodMap>(
    identity: DesktopIdentity,
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ): Promise<RemoteControlMethodMap[M]['result']>;
  pending<K extends PendingOperation>(
    identity: DesktopIdentity,
    op: K,
    params: DesktopOperationMap[K]['params'],
  ): Promise<DesktopOperationMap[K]['result']>;
  mutateIntent<M extends DesktopIntentMethod>(
    identity: DesktopIdentity,
    method: M,
    params: RemoteControlMethodMap[M]['params'],
  ): Promise<RemoteControlMethodMap[M]['result']>;
  observe(
    identity: DesktopIdentity,
    target: LiveTarget,
    onEvent: (event: DesktopObservationEvent) => void,
  ): ObservationHandle;
  saveDraft(key: string, draft: DesktopDraftEntry): Promise<void>;
  /**
   * 清空草稿（CAS）：同一 ui_set 串行闭包内比较当前持久草稿，仅当其为空草稿或等于 expected
   * 之一（按 name/path/size 与值顺序比较，不依赖 JSON 键顺序）时写空草稿并取得持久化回执；
   * 否则 DRAFT_CONFLICT/not-sent，绝不清空。
   */
  clearDraft(key: string, expected: readonly DesktopDraftEntry[]): Promise<void>;
  draftKey(
    identity: DesktopIdentity,
    target: { kind: 'primary' | 'room'; id: string },
  ): Promise<string>;
  pickFile(): Promise<DesktopDraftFileRef | null>;
  reportError(error: unknown): void;
}

export interface IntentPatch {
  outcome?: RemoteControlOutcome;
  /** 真实 DTO union（与 DesktopUiIntent.result 一致），不用 unknown 混入持久状态。 */
  result?: DesktopUiIntent['result'];
  error?: { code: string; message?: string; outcome: RemoteControlOutcome };
}

/** core 面板（PendingPanel/SettingsPanel）使用的扩展表面，不属于共享 DesktopViewApi。 */
export interface DesktopPanelApi extends DesktopViewApi {
  subscribe(listener: () => void): () => void;
  init(): Promise<DesktopUiSnapshot>;
  setIdentity(
    base: { profileId: string; targetDeviceId: string; kind: 'local' | 'relay' } | null,
  ): DesktopIdentity | null;
  queueWrite(mutate: (state: DesktopUiState) => DesktopUiState): Promise<DesktopUiSnapshot>;
  /** transport 连接状态变更（仅由 core 内部调用）并 notify 订阅者。 */
  setTransportConnected(connected: boolean): void;
  broker<K extends PublicBrokerOperation>(
    identity: DesktopIdentity,
    op: K,
    params: BrokerOpParams<K>,
  ): Promise<BrokerOpResult<K>>;
  updateIntent(id: string, patch: IntentPatch): Promise<void>;
  deleteIntent(id: string): Promise<void>;
  /** 全局错误可见状态（不再写 console/日志）。 */
  subscribeErrors(listener: (message: string) => void): () => void;
}
