import type {
  BotLiveFrame,
  WorkLiveFrame,
  RemoteLiveSnapshot,
  RemoteLiveEnd,
  RemoteControlMethodMap,
  RemoteControlOutcome,
  DevicesDirectoryPage,
  DevicesDirectoryItem,
  BotDirectorySnapshot,
  LocalSettingsSnapshot,
  SettingsUpdate,
  HostServiceStatus,
  PendingEnqueueInput,
  PendingRecord,
  ImageAttachment,
  PendingListOptions,
  PendingListPage,
  LiveTarget,
} from './index.js';
import type { BotAvatar, BotAvatarConfig, BotCapabilityConfig, Installation, JsonObject } from '../center-contract/index.js';

/** Re-exported contract shapes so UI files only need this module. */
export type { BotCapabilityConfig, Installation, JsonObject, JsonSchema, JsonValue } from '../center-contract/index.js';

export const DESKTOP_MAX_IN_FLIGHT_REQUESTS: 8;
export const DESKTOP_MAX_OBSERVATIONS: 8;
export const DESKTOP_CALL_TIMEOUT_MS: 25000;
export const INTENT_METHODS: ReadonlySet<DesktopIntentMethod>;

export type DesktopConnectionInput =
  | {
      kind: 'local';
      url: string;
      token: string;
      expectedDeviceId?: string;
    }
  | {
      kind: 'relay';
      url: string;
      deviceId: string;
      token: string;
      /** PEM certificate string <= 64 KiB, session only. */
      ca?: string;
    };

export type DesktopRedactedConnection =
  | {
      kind: 'local';
      url: string;
      expectedDeviceId?: string;
      deviceId?: string;
    }
  | {
      kind: 'relay';
      url: string;
      deviceId: string;
    };

export type DesktopClientPhase = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface DesktopClientStatus {
  clientId: string;
  phase: DesktopClientPhase;
  connection: DesktopRedactedConnection | null;
  generation: number;
  lastObservedAt: string | null;
  errorCode: string | null;
}

export interface DesktopErrorShape {
  code: string;
  message: string;
  outcome: RemoteControlOutcome;
}

export function normalizeDesktopError(err: unknown, fallbackOutcome?: RemoteControlOutcome): DesktopErrorShape;
export function derivePendingProfileKey(connection: DesktopConnectionInput): string;

export type DesktopUiProfile =
  | {
      id: string;
      title: string;
      kind: 'local';
      url: string;
      expectedDeviceId?: string;
    }
  | {
      id: string;
      title: string;
      kind: 'relay';
      url: string;
      deviceId: string;
    };

export interface DesktopDraftFileRef {
  name: string;
  path: string;
  size: number;
}

export interface DesktopDraftEntry {
  text: string;
  files: DesktopDraftFileRef[];
  /** Previously-uploaded image attachment metadata; sending uses the `id` list only. */
  attachments?: ImageAttachment[];
}

export type DesktopIntentMethod =
  | 'createBot'
  | 'createScope'
  | 'updateScope';

export interface DesktopUiIntent<M extends DesktopIntentMethod = DesktopIntentMethod> {
  id: string;
  profileId: string;
  targetDeviceId: string;
  method: M;
  params: RemoteControlMethodMap[M]['params'];
  outcome: RemoteControlOutcome;
  result?: RemoteControlMethodMap[M]['result'];
  error?: {
    code: string;
    message?: string;
    outcome: RemoteControlOutcome;
  };
}

export interface DesktopUiState {
  version: 1;
  profiles: DesktopUiProfile[];
  drafts: Record<string, DesktopDraftEntry>;
  intents: DesktopUiIntent[];
}

export interface DesktopUiSnapshot {
  clientId: string;
  revision: number;
  state: DesktopUiState;
}

export interface DesktopUiUpdateInput {
  expectedRevision: number;
  state: DesktopUiState;
}

export interface DesktopUiStore {
  readonly clientId: string;
  get(): DesktopUiSnapshot;
  replace(input: DesktopUiUpdateInput): DesktopUiSnapshot;
  close(): void;
}

export type DesktopLiveFrame = BotLiveFrame | WorkLiveFrame | RemoteLiveSnapshot | RemoteLiveEnd;

export type DesktopObservationEvent =
  | {
      type: 'event';
      observationId: string;
      frame: DesktopLiveFrame;
    }
  | {
      type: 'event';
      observationId: string;
      error: DesktopErrorShape;
    };

export interface DesktopCenterStatus {
  state: 'disconnected' | 'connecting' | 'ready';
  centerUrl: string;
  appliedRevision: null;
  error: { code: string; message: string } | null;
  clientId: string;
  savedConnection?: { url: string; deviceId: string; ca: string };
}

export interface CenterModelSelection { modelRef?: string | null; thinkingLevel?: string | null; codemode?: boolean | null; codemodeOnly?: boolean | null }
export interface CenterBotModelConfig { global: CenterModelSelection; overrides: CenterModelSelection; effective: CenterModelSelection; revision: number }

/** Center-reported apply status; `pending` is synthesized by the center and never sent by a Host. */
export type CenterRuntimeApplyStatus = 'pending' | 'applying' | 'waiting-idle' | 'applied' | 'failed';
export interface CenterRuntimeError { code: string; message: string }
export interface CenterRuntimeBotReceipt {
  botId: string;
  desiredRevision: number;
  appliedRevision: number | null;
  status: CenterRuntimeApplyStatus;
  error: CenterRuntimeError | null;
}
export interface CenterRuntimeCapabilityError {
  botId: string;
  installationId: string;
  error: CenterRuntimeError;
}
/** GET /api/devices/:deviceId/runtime-status: center-time fields, offline expressed by `online` alone. */
export interface CenterDeviceRuntimeStatus {
  deviceId: string;
  online: boolean;
  desiredRevision: number | null;
  appliedRevision: number | null;
  status: CenterRuntimeApplyStatus;
  updatedAt: string | null;
  appliedAt: string | null;
  error: CenterRuntimeError | null;
  bots: CenterRuntimeBotReceipt[];
  capabilityErrors: CenterRuntimeCapabilityError[];
}
/** One installed capability with this Bot's binding and effective config. */
export type CenterCapabilityActivationStatus = 'disabled' | 'enabling' | 'enabled' | 'failed';
/** Global activation of an installation; a Bot may only be switched on when this is `enabled`. */
export interface CenterCapabilityActivation {
  status: CenterCapabilityActivationStatus;
  error: CenterRuntimeError | null;
  updatedAt: string | null;
}
export interface CenterBotCapabilityEntry {
  installation: Installation & { activation: CenterCapabilityActivation };
  config: BotCapabilityConfig;
  uiSchema?: JsonObject;
}

export interface DesktopOperationMap {
  center_connect: {
    params: { url: string; deviceId: string; deviceToken: string; ca?: string };
    result: DesktopCenterStatus;
  };
  center_status: {
    /** Probe both links when ready, or request an immediate retry while connecting. */
    params: { probe?: boolean };
    result: DesktopCenterStatus;
  };
  center_disconnect: {
    params: Record<string, never>;
    result: DesktopCenterStatus;
  };
  center_owner_session: { params: Record<string, never>; result: { authenticated: boolean } };
  center_owner_login: { params: { password: string }; result: { authenticated: boolean } };
  center_bot_model_get: { params: { deviceId: string; botId: string }; result: CenterBotModelConfig };
  center_bot_model_set: { params: { deviceId: string; botId: string; expectedRevision: number; value: CenterModelSelection }; result: CenterBotModelConfig };
  center_bot_avatar_get: { params: { deviceId: string; botId: string }; result: BotAvatarConfig };
  center_bot_avatar_set: { params: { deviceId: string; botId: string; expectedRevision: number; value: BotAvatar | null }; result: BotAvatarConfig };
  center_bot_capabilities_get: { params: { deviceId: string; botId: string }; result: CenterBotCapabilityEntry[] };
  center_bot_capability_set: {
    params: {
      deviceId: string;
      botId: string;
      installationId: string;
      expectedRevision: number;
      enabled: boolean;
      overrides: JsonObject;
    };
    result: BotCapabilityConfig;
  };
  center_runtime_status: { params: { deviceId: string }; result: CenterDeviceRuntimeStatus };
  connect: {
    params: { connection: DesktopConnectionInput };
    result: DesktopClientStatus;
  };
  disconnect: {
    params: Record<string, never>;
    result: DesktopClientStatus;
  };
  status: {
    params: Record<string, never>;
    result: DesktopClientStatus;
  };
  devices: {
    params: { limit?: number; cursor?: { afterDeviceId: string } | null };
    result: DevicesDirectoryPage;
  };
  bot_directory: { params: Record<string, never>; result: BotDirectorySnapshot };
  rename_device: { params: { deviceId: string; displayName: string }; result: DevicesDirectoryItem };
  call: {
    params: {
      [K in keyof RemoteControlMethodMap]: {
        targetDeviceId: string;
        method: K;
        params: RemoteControlMethodMap[K]['params'];
      };
    }[keyof RemoteControlMethodMap];
    result: RemoteControlMethodMap[keyof RemoteControlMethodMap]['result'];
  };
  settings_get: {
    params: { targetDeviceId: string };
    result: LocalSettingsSnapshot;
  };
  settings_set: {
    params: { targetDeviceId: string; input: SettingsUpdate };
    result: LocalSettingsSnapshot;
  };
  service_status: {
    params: { targetDeviceId: string };
    result: HostServiceStatus;
  };
  pending_enqueue: {
    params: { input: PendingEnqueueInput };
    result: PendingRecord;
  };
  pending_get: {
    params: { id: string };
    result: PendingRecord | null;
  };
  pending_list: {
    params: { options?: PendingListOptions };
    result: PendingListPage;
  };
  pending_send: {
    params: { id: string };
    result: PendingRecord;
  };
  pending_reconcile: {
    params: { id: string };
    result: PendingRecord;
  };
  pending_cancel: {
    params: { id: string };
    result: PendingRecord;
  };
  ui_get: {
    params: Record<string, never>;
    result: DesktopUiSnapshot;
  };
  ui_set: {
    params: DesktopUiUpdateInput;
    result: DesktopUiSnapshot;
  };
  observe: {
    params: { observationId: string; targetDeviceId: string; target: LiveTarget };
    result: { observationId: string };
  };
  unobserve: {
    params: { observationId: string };
    result: { observationId: string };
  };
}

export interface OpenDesktopClientOptions {
  dataRoot: string;
  onEvent?: (event: DesktopObservationEvent) => void | Promise<void>;
  persistCenterCredentials?: boolean;
}

export interface DesktopClient {
  request<K extends keyof DesktopOperationMap>(
    op: K,
    params: DesktopOperationMap[K]['params'],
  ): Promise<DesktopOperationMap[K]['result']>;
  close(): Promise<void>;
}

export function openDesktopClient(options: OpenDesktopClientOptions): DesktopClient;

export type DesktopWireRequest = {
  type: 'request';
  id: string;
  op: string;
  params: Record<string, unknown>;
};

export type DesktopWireResponse =
  | {
      type: 'response';
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: 'response';
      id: string;
      ok: false;
      error: DesktopErrorShape;
    };

export interface DesktopClientCliOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  diagnostics?: NodeJS.WritableStream;
  exitOnClose?: boolean;
  onExit?: (code: number) => void;
}

export interface DesktopClientCli {
  run(): Promise<void>;
}
