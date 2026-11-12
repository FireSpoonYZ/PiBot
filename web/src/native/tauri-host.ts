// M18 mobile（Tauri 辅助进程）Host 传输：Tauri 命令 → android-host 插件的同进程私有 Binder 会话。
// 4 个命令：mobile_host_request(method,params) / mobile_host_listen(onEvent) /
// mobile_host_ack(deliveryId) / mobile_host_unlisten()；事件帧
// {deliveryId, event:'hostFrame'|'voiceEvent'|'clientFrame', data:<DTO>}；
// listen 结果必须为 {listening:true, streamId:'<uuid>:<generation>'}，deliveryId = streamId + ':' + sequence。
// M20 远端页（其他设备）复用同一个 mobile_host_request，method 为 clientRequest/clientObserve/
// clientUnobserve，事件为同一流上的 clientFrame（不是公开 listener 名）。
// native/index.ts 装配此 Tauri 适配器。
// 本适配器只转发 start/stop 原生动作；客户端生命周期负责自动启动 Host，snapshot 仅读状态。
import { Channel, invoke } from '@tauri-apps/api/core';
import type { DesktopObservationEvent } from '../../../host-core/desktop-client.js';
import type { LiveTarget } from '../../../host-core/index.js';
import type {
  BotHostPickImagesResult, BotHostPlugin, CenterSettings, HostCallResult, HostFrameEvent,
  HostSettings, HostSettingsPayload, HostSnapshot, HostStatus, HostVoiceEvent,
  HostVoiceSaveInput, HostVoiceSettings, OnboardingActionName, OnboardingStatus,
  PairCenterResult, PluginListenerHandle,
} from './index';

// clientFrame 只给手机远端页内部使用。
type HostEvent = 'hostFrame' | 'voiceEvent' | 'clientFrame';
type EnvelopeEvent = HostEvent | 'streamError';
type Envelope = { deliveryId: string; event: EnvelopeEvent; data: unknown };
type StreamFailure = (error: MobileHostError) => void;
type ListenResult = { listening?: boolean; streamId?: string };
type Capture = { botId: string; requestId: string };
// 一条已打开的传输：epoch 与 channel 身份用于 generation fence。
type Stream = {
  epoch: number;
  channel: Channel<Envelope>;
  streamId: string;
  admitted: boolean;
  dead: boolean;
  buffer: Envelope[];
  bufferBytes: number;
};

const STREAM_CLOSED = 'EVENT_STREAM_CLOSED';
const PRE_ADMISSION_FRAMES = 8;
const PRE_ADMISSION_BYTES = 80 * 1024 * 1024;

/** 原生 SDK reject 的固定错误形状；消息不含凭据或原始请求体。 */
export class MobileHostError extends Error {
  readonly code: string;
  readonly outcome: string;
  constructor(shape: { code: string; message: string; outcome: string }) {
    super(shape.message ? `${shape.code}: ${shape.message}` : shape.code);
    this.name = 'MobileHostError';
    this.code = shape.code;
    this.outcome = shape.outcome;
  }
}

function toError(error: unknown): MobileHostError {
  if (error instanceof MobileHostError) return error;
  if (typeof error === 'object' && error !== null) {
    // Capacitor reject 把固定 outcome 放在 data.outcome；Rust 已按 NativeReply 展开则直接带 outcome。
    const shape = error as { code?: unknown; message?: unknown; outcome?: unknown; data?: { outcome?: unknown } };
    const outcome = typeof shape.outcome === 'string' ? shape.outcome
      : typeof shape.data?.outcome === 'string' ? shape.data.outcome : 'unconfirmed';
    return new MobileHostError({
      code: typeof shape.code === 'string' ? shape.code : 'INTERNAL',
      message: typeof shape.message === 'string' ? shape.message : '',
      outcome,
    });
  }
  return new MobileHostError({ code: 'INTERNAL', message: typeof error === 'string' ? error : '', outcome: 'unconfirmed' });
}

const streamClosed = () => new MobileHostError({ code: STREAM_CLOSED, message: '事件流未就绪，请显式重连', outcome: 'not-sent' });

/** 准入前缓冲的字节数（UTF8 JSON），失败时按上限计算，不抛给事件线程。 */
function envelopeBytes(envelope: Envelope): number {
  try { return new TextEncoder().encode(JSON.stringify(envelope)).length; } catch { return PRE_ADMISSION_BYTES; }
}

/**
 * 私有 streamError 信封 → 可收敛的错误：固定码、有界通用消息、保守 unconfirmed。
 * 不读也不传 cause/凭据；消息只用于桌面提示。
 */
function streamErrorOf(data: unknown): MobileHostError {
  const shape = data && typeof data === 'object' ? data as { code?: unknown; message?: unknown; outcome?: unknown } : {};
  return new MobileHostError({
    code: typeof shape.code === 'string' && shape.code ? shape.code : STREAM_CLOSED,
    message: typeof shape.message === 'string' ? shape.message.slice(0, 200) : '',
    outcome: typeof shape.outcome === 'string' && shape.outcome ? shape.outcome : 'unconfirmed',
  });
}

// 流控失败通知（观察/语音错误 DTO 之外的可视化入口，供 mobile 工具栏显示）；只通知，不重连不重发。
const streamFailures = new Set<StreamFailure>();

export function onMobileStreamFailure(listener: StreamFailure): () => void {
  streamFailures.add(listener);
  return () => { streamFailures.delete(listener); };
}

let active: MobileBotHost | undefined;

/**
 * UI-local 原生动作（Bot 屏幕覆盖层 screen*）：不经 Host 桥，也不参与事件流失败锁定；
 * 失败只规范化，不重试。
 */
export async function mobileLocalRequest<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  try {
    return (await invoke('mobile_host_request', { method, params })) as T;
  } catch (error) {
    throw toError(error);
  }
}

/** 单条请求：params 与 BotHostPlugin 的调用参数同形；失败只规范化，不重试、不重放 mutation。 */
async function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  // 派发时记录连接代际：只有仍是当前代的失败才允许锁死事件流。
  const epoch = active?.currentEpoch;
  try {
    return (await invoke('mobile_host_request', { method, params })) as T;
  } catch (error) {
    const failure = toError(error);
    if (failure.code === STREAM_CLOSED) active?.failStream(failure, epoch);
    throw failure;
  }
}

class MobileBotHost implements BotHostPlugin {
  // 监听器注册在流失败后保留，直到各自的 remove 句柄运行；显式重连只为其修复传输。
  private readonly listeners: Record<HostEvent, Set<(event: any) => void>> = {
    hostFrame: new Set(), voiceEvent: new Set(), clientFrame: new Set(),
  };
  // 本 UI 预占/打开的观察 id：流失败时据此分发既有 hostFrame error DTO。
  private readonly observations = new Set<string>();
  private capture?: Capture;
  private stream?: Stream;
  private starting?: Promise<void>;
  // 原生槽位是否仍持有本 UI 的订阅：避免重复 unlisten 与重复代际前进。
  private attached = false;
  // 单调传输代际：每次开流/关流都前进，旧完成/旧 ACK/旧请求失败一律被 fence。
  private generation = 0;
  private failed = false;
  // last-remove/unlisten 与新的 listen 串行，避免旧完成事件踩掉新通道。
  private queue: Promise<unknown> = Promise.resolve();

  get currentEpoch(): number { return this.generation; }

  snapshot(): Promise<HostSnapshot> { return request('snapshot'); }
  status(): Promise<HostStatus> { return request('status'); }
  centerSettings(): Promise<CenterSettings> { return request('centerSettings'); }
  saveCenterSettings(options: {input: {url: string; deviceToken: string; ca: string}}): Promise<CenterSettings> {
    return request('saveCenterSettings', options);
  }
  /** UI-local：经 Service 入口请求启动，返回仅为“已请求”。 */
  start(): Promise<{ requested: boolean }> { return request('start'); }
  /** UI-local：用户显式退出客户端。 */
  stop(): Promise<{ requested: boolean }> { return request('stop'); }
  settingsGet(): Promise<HostSettingsPayload> { return request('settingsGet'); }
  settingsSet(options: { input: { expectedRevision: number; settings: HostSettings } }): Promise<HostSettingsPayload> {
    return request('settingsSet', options);
  }
  saveCredentials(options: { aliases: Record<string, unknown> }): Promise<Record<string, never>> {
    return request('saveCredentials', options);
  }
  call(options: { method: string; params: Record<string, unknown> }): Promise<HostCallResult> {
    return request('call', options);
  }
  async observe(options: {
    observationId: string;
    target: { kind: 'primary'; botId: string } | { kind: 'work'; botId: string; scopeId: string };
  }): Promise<{ observationId: string }> {
    // 显式观察要求就绪流；id 在异步请求前预占，失败/终态帧移除。
    // 失败闩锁不裸拒绝：先经单飞行重连重建传输，仍不就绪才按未就绪拒绝。
    if (!this.live && this.failed) await mobileReconnect().catch(() => {});
    if (!this.live) throw streamClosed();
    this.observations.add(options.observationId);
    try {
      return await request<{ observationId: string }>('observe', options);
    } catch (error) {
      this.observations.delete(options.observationId);
      throw error;
    }
  }
  async cancelObservation(options: { observationId: string }): Promise<Record<string, never>> {
    const result = await request<Record<string, never>>('cancelObservation', options);
    this.observations.delete(options.observationId);
    return result;
  }
  voiceSettings(): Promise<HostVoiceSettings> { return request('voiceSettings'); }
  saveVoiceSettings(options: { settings: HostVoiceSaveInput }): Promise<Record<string, never>> {
    return request('saveVoiceSettings', options);
  }
  async startVoice(options: { botId: string; requestId: string }): Promise<Record<string, never>> {
    // 显式录音要求就绪流；原始 botId/requestId 在请求前冻结，供流失败对账。
    if (!this.live) throw streamClosed();
    const capture: Capture = { botId: options.botId, requestId: options.requestId };
    this.capture = capture;
    try {
      return await request<Record<string, never>>('startVoice', options);
    } catch (error) {
      const failure = toError(error);
      // 只有平台明确未派发才撤销本条记录；未知结果保留原 id，不冒充 not-sent。
      if (this.capture === capture && failure.outcome === 'not-sent') this.capture = undefined;
      throw failure;
    }
  }
  finishVoice(): Promise<Record<string, never>> { return request('finishVoice'); }
  /** UI-local：系统选图/拍照，原生端限为单会话、限尺寸/字节后返回 base64。 */
  pickImages(options: {source: 'photos'|'camera'}): Promise<BotHostPickImagesResult> {
    return request('pickImages', options);
  }
  async cancelVoice(): Promise<Record<string, never>> {
    // 记录本条的归属：完成回调只清自己那一次，绝不擦掉期间新建的 capture。
    const owner = this.capture;
    const result = await request<Record<string, never>>('cancelVoice');
    if (this.capture === owner) this.capture = undefined;
    return result;
  }
  addListener(event: 'hostFrame', listener: (event: HostFrameEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'voiceEvent', listener: (event: HostVoiceEvent) => void): Promise<PluginListenerHandle>;
  /** 远端观察帧：与 hostFrame/voiceEvent 共用同一个原生事件流（内部，不扩公共插件接口）。 */
  addListener(event: 'clientFrame', listener: (event: DesktopObservationEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: HostEvent, listener: (event: any) => void): Promise<PluginListenerHandle> {
    const set = this.listeners[event];
    set.add(listener);
    // 失败闩锁期间登记先占位，再经单飞行重连修复传输；恢复失败回滚登记并按原样拒绝。
    const ready = this.failed
      ? mobileReconnect().then(() => this.subscribe())
      : this.subscribe();
    return ready.then(() => ({
      remove: async () => {
        set.delete(listener);
        // 只有没有其它本地注册时才取消本 UI 的订阅；取消在队列内复查注册数。
        await this.unlistenIfUnused();
      },
    }), error => {
      set.delete(listener);
      throw error;
    });
  }

  /** 显式重连后清 latch 并只为保留的注册重建事件传输；不重发观察/提交、不重放 mutation。 */
  async resetStream(): Promise<void> {
    this.failed = false;
    // 先作废旧代身份：旧 listen 的晚完成、旧 ACK、旧请求失败都不能接管或锁死新流。
    const stale = this.stream;
    if (stale) stale.dead = true;
    this.stream = undefined;
    this.starting = undefined;
    this.generation += 1;
    this.observations.clear();
    this.capture = undefined;
    if (this.listeners.hostFrame.size === 0 && this.listeners.voiceEvent.size === 0
      && this.listeners.clientFrame.size === 0) return;
    // 在同一个串行转换里直接开新流：不 await 旧的 starting，也不把自己排回队列后面。
    await this.serialize(() => this.openStream());
  }

  /**
   * 流失败收敛（ack/listen/request 三处共用，只生效一次）。
   * epoch 是派发时的代际：与当前代不一致的失败不得锁死已经重建的新流。
   */
  failStream(error: MobileHostError, epoch?: number): void {
    if (epoch !== undefined && epoch !== this.generation) return;
    if (this.failed) return;
    this.failed = true;
    const stream = this.stream;
    if (stream) stream.dead = true;
    this.stream = undefined;
    const detail = { code: error.code, outcome: error.outcome, message: error.message };
    // 既有 hostFrame error DTO：让已注册观察收束并可见（不新增事件名）。
    const observations = [...this.observations];
    this.observations.clear();
    for (const observationId of observations) {
      for (const listener of this.listeners.hostFrame) {
        try { listener({ observationId, error: detail }); } catch { /* 监听器自身错误不外溢 */ }
      }
    }
    // 已开始的语音保留原始 id 与 unconfirmed，绝不编造转写文本。
    const capture = this.capture;
    this.capture = undefined;
    if (capture) {
      const voice: HostVoiceEvent = {
        type: 'error', botId: capture.botId, requestId: capture.requestId,
        code: error.code, outcome: 'unconfirmed', message: error.message,
      };
      for (const listener of this.listeners.voiceEvent) {
        try { listener(voice); } catch { /* 监听器自身错误不外溢 */ }
      }
    }
    for (const listener of streamFailures) {
      try { listener(error); } catch { /* 通知方自身错误不外溢 */ }
    }
  }

  private get live(): boolean { return !this.failed && this.stream?.admitted === true; }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private subscribe(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.live) return Promise.resolve();
    const started = this.serialize(() => this.openStream());
    this.starting = started;
    const clear = () => { if (this.starting === started) this.starting = undefined; };
    void started.then(clear, clear);
    return started;
  }

  private async openStream(): Promise<void> {
    if (this.failed) throw streamClosed();
    if (this.live) return;
    const epoch = ++this.generation;
    const channel = new Channel<Envelope>(envelope => this.receive(epoch, envelope));
    const stream: Stream = { epoch, channel, streamId: '', admitted: false, dead: false, buffer: [], bufferBytes: 0 };
    const previous = this.stream;
    if (previous) previous.dead = true;
    this.stream = stream;
    // 即使 listen 回应丢失，原生槽位也可能已建立，因此先标记为需清理。
    this.attached = true;
    let result: ListenResult;
    try {
      result = await invoke('mobile_host_listen', { onEvent: channel }) as ListenResult;
    } catch (error) {
      const failure = toError(error);
      if (this.stream === stream) this.stream = undefined;
      // 只有本代仍是当前流时失败才锁死；被更新的开流取代时静默丢弃本次完成。
      this.failStream(failure, epoch);
      throw failure;
    }
    // 已被更新的 listen/unlisten 取代：本次完成只丢弃，不接管身份。
    if (this.stream !== stream || stream.dead) return;
    // 传输契约要求 listening:true 与非空 streamId；缺失按协议失败处理，不降级为弱前缀校验。
    if (result?.listening !== true || typeof result.streamId !== 'string' || result.streamId.length === 0) {
      const failure = new MobileHostError({ code: 'INTERNAL', message: 'listen 回应缺少 listening/streamId', outcome: 'unconfirmed' });
      if (this.stream === stream) this.stream = undefined;
      this.failStream(failure, epoch);
      throw failure;
    }
    stream.streamId = result.streamId;
    stream.admitted = true;
    // 准入前的帧已按帧数与字节上限缓冲，仅在身份确定后投递。
    const buffered = stream.buffer.splice(0);
    stream.bufferBytes = 0;
    for (const envelope of buffered) this.admit(stream, envelope);
  }

  /** 最后一个本地注册移除后的清理：执行时复查注册数，期间新增的注册不会被删掉。 */
  private unlistenIfUnused(): Promise<void> {
    return this.serialize(async () => {
      if (this.listeners.hostFrame.size > 0 || this.listeners.voiceEvent.size > 0
        || this.listeners.clientFrame.size > 0) return;
      await this.closeLocked();
    });
  }

  /** 可见故障时的强制清理（例如准入前缓冲溢出）：关闭本 UI 的原生流，不清 latch。 */
  private closeOwnStream(): Promise<void> {
    return this.serialize(() => this.closeLocked());
  }

  /** 串行队列内执行：作废旧身份、关闭原生流、清本 UI 簿记；unlisten 幂等并始终 resolve。 */
  private async closeLocked(): Promise<void> {
    const stream = this.stream;
    if (!stream && !this.attached) return;
    if (stream) stream.dead = true;
    this.stream = undefined;
    this.starting = undefined;
    this.attached = false;
    this.generation += 1;
    this.observations.clear();
    this.capture = undefined;
    await invoke('mobile_host_unlisten').catch(() => undefined);
  }

  private receive(epoch: number, envelope: Envelope): void {
    const stream = this.stream;
    if (!stream || stream.epoch !== epoch || stream.dead) { void this.ack(envelope?.deliveryId, undefined); return; }
    if (!stream.admitted) {
      const bytes = envelopeBytes(envelope);
      if (stream.buffer.length >= PRE_ADMISSION_FRAMES || stream.bufferBytes + bytes > PRE_ADMISSION_BYTES) {
        // 准入前溢出：可见失败并清理本 UI 的原生流，绝不静默丢弃活帧。
        this.failStream(new MobileHostError({
          code: STREAM_CLOSED, message: '准入前事件缓冲溢出', outcome: 'unconfirmed',
        }), stream.epoch);
        void this.closeOwnStream();
        return;
      }
      stream.buffer.push(envelope);
      stream.bufferBytes += bytes;
      return;
    }
    this.admit(stream, envelope);
  }

  private admit(stream: Stream, envelope: Envelope): void {
    const deliveryId = envelope?.deliveryId;
    if (this.stream !== stream || stream.dead) { void this.ack(deliveryId, undefined); return; }
    // 身份前缀（streamId:sequence）必须匹配本条流；旧代/无关帧只做无害回执后丢弃。
    if (typeof deliveryId !== 'string' || !deliveryId.startsWith(`${stream.streamId}:`)) {
      if (typeof deliveryId === 'string') void this.ack(deliveryId, undefined);
      return;
    }
    try {
      // 私有终结信封：只在当前 epoch/streamId 准入后收敛一次；不新增 JavaScript listener 名。
      if (envelope.event === 'streamError') {
        this.failStream(streamErrorOf(envelope.data), stream.epoch);
        return;
      }
      // 接下来只能是已注册的事件名：hostFrame/voiceEvent 为本机公开 listener，clientFrame 只给远端页。
      const set = envelope.event === 'hostFrame' ? this.listeners.hostFrame
        : envelope.event === 'voiceEvent' ? this.listeners.voiceEvent
          : this.listeners.clientFrame;
      for (const listener of set) {
        try { listener(envelope.data); } catch { /* 监听器自身错误不外溢成传输故障 */ }
      }
      this.forget(envelope);
    } finally {
      // 监听器返回后立即回执（终结帧也只回执一次）；不等待监听器的异步承诺。
      void this.ack(deliveryId, stream);
    }
  }

  /** 终态帧移除观察/语音簿记，避免把已结束的 id 当作仍在途。 */
  private forget(envelope: Envelope): void {
    // 远端观察不参与本机观察/语音簿记。
    if (envelope.event === 'clientFrame') return;
    if (envelope.event === 'hostFrame') {
      const frame = envelope.data as HostFrameEvent | undefined;
      if (typeof frame?.observationId === 'string' && (frame.error || frame.frame?.type === 'end')) {
        this.observations.delete(frame.observationId);
      }
      return;
    }
    const voice = envelope.data as HostVoiceEvent | undefined;
    if ((voice?.type === 'submitted' || voice?.type === 'error') && this.capture
      && this.capture.botId === voice.botId && this.capture.requestId === voice.requestId) {
      this.capture = undefined;
    }
  }

  private async ack(deliveryId: string | undefined, stream: Stream | undefined): Promise<void> {
    if (typeof deliveryId !== 'string') return;
    try {
      // 过期/重复/无关 deliveryId 由原生返回 {acknowledged:false}，属无害；不重试。
      await invoke('mobile_host_ack', { deliveryId });
    } catch (error) {
      // 只有当前流代的在途帧回执被拒才收束；旧代 ACK 失败不得杀死新流。
      if (!stream || this.stream !== stream || stream.dead) return;
      this.failStream(toError(error), stream.epoch);
    }
  }
}

/** 由 native/index.ts 装配 Tauri Host 适配器。 */
export function createTauriBotHost(): BotHostPlugin {
  active = new MobileBotHost();
  return active;
}

/** uiSettings 只有界面语言与外观：同一偏好键/类型，不含 Pi 配置或凭据。 */
export type MobileUiSettings = { language: 'system'|'zh'|'en'; appearance: 'system'|'light'|'dark' };

export function mobileUiSettings(): Promise<MobileUiSettings> {
  return request<MobileUiSettings>('uiSettings');
}

/** hide：只把本 UI 任务移到后台，不停止 Host。 */
export function mobileHide(): Promise<unknown> {
  return request('hide');
}

/**
 * C7 首启配对：中心 URL + owner 密码由原生换取设备绑定并保存 Host/client 凭据；
 * token 不进入 JS。UI-local 前台动作；connectionRequested 非就绪，仍需 center_status 轮询。
 */
export function pairCenter(input: {
  url: string; password: string; displayName?: string; ca?: string; force?: boolean;
}): Promise<PairCenterResult> {
  const params: Record<string, unknown> = { url: input.url, password: input.password };
  if (input.displayName) params.displayName = input.displayName;
  if (input.ca) params.ca = input.ca;
  if (input.force) params.force = true;
  return mobileLocalRequest<PairCenterResult>('pairCenter', params);
}

/**
 * C7 失败恢复：原生复用已存安全凭据重试 Host saveCenterSettings + client_connect；
 * 不需要 owner 密码、不注册新设备、不回 token。UI-local 前台动作；结果同样非就绪语义。
 */
export function repairCenterBinding(): Promise<PairCenterResult> {
  return mobileLocalRequest<PairCenterResult>('repairCenterBinding');
}

/**
 * 配对码配对：整串配对码交给原生解码——中心地址、一次性密钥与私有 CA 都不经 JS 状态，
 * 这里只传用户粘贴/扫到的原文。兑换后的持久化与连接同 pairCenter；token 不回 JS。
 * UI-local 前台动作；connectionRequested 非就绪，仍需 center_status 轮询。
 */
export function pairCenterWithCode(input: {
  code: string; displayName?: string; force?: boolean;
}): Promise<PairCenterResult> {
  const params: Record<string, unknown> = { code: input.code };
  if (input.displayName) params.displayName = input.displayName;
  if (input.force) params.force = true;
  return mobileLocalRequest<PairCenterResult>('pairCenterWithCode', params);
}

/**
 * 应用内扫码（ZXing，不依赖 Google 服务）：返回扫到的二维码原文，用户返回/取消时 cancelled=true。
 * 相机权限被拒以 CAMERA_DENIED 拒绝，界面应退回粘贴配对码。UI-local 前台动作。
 */
export function scanPairingCode(): Promise<{ text?: string; cancelled?: boolean }> {
  return mobileLocalRequest<{ text?: string; cancelled?: boolean }>('scanPairingCode');
}

/** C7 权限/后台真实状态查询；不启动服务或授权流程。 */
export function onboardingStatus(): Promise<OnboardingStatus> {
  return mobileLocalRequest<OnboardingStatus>('onboardingStatus');
}

/** C7 权限动作：仅前台显式发起系统请求/页面，返回的 requested 不代表已授权。 */
export function onboardingAction(action: OnboardingActionName): Promise<{ requested: boolean }> {
  return mobileLocalRequest<{ requested: boolean }>('onboardingAction', { action });
}

// 恢复单飞行：并发触发共享同一次原生桥重建与事件传输重开；结算后下一次调用重新发起。
let reconnectFlight: Promise<{ connected: boolean }> | undefined;

/** 显式重建 IPC 会话并修复已保留监听器的事件传输；不重发观察或 mutation。 */
export function mobileReconnect(): Promise<{ connected: boolean }> {
  if (!reconnectFlight) {
    const run = (async () => {
      const result = await request<{ connected: boolean }>('reconnect');
      await active?.resetStream();
      return result;
    })();
    reconnectFlight = run;
    const clear = () => { if (reconnectFlight === run) reconnectFlight = undefined; };
    void run.then(clear, clear);
  }
  return reconnectFlight;
}

/**
 * 远端 broker 普通操作（broker 的 16 个普通 op，不含 observe/unobserve）；
 * 原生把结果包在 {value} 里（可能是 null 或数组），这里只解包。
 */
export async function mobileClientRequest<T>(op: string, params: unknown): Promise<T> {
  const reply = await request<{ value: T }>('clientRequest', { op, params });
  return reply.value;
}

/** 远端观察用专有方法；事件从同一条流上的 clientFrame 到达。 */
export function mobileClientObserve(input: {
  observationId: string;
  targetDeviceId: string;
  target: LiveTarget | { kind: 'connection' };
}): Promise<{ observationId: string }> {
  return request('clientObserve', input);
}

export function mobileClientUnobserve(observationId: string): Promise<Record<string, never>> {
  return request('clientUnobserve', { observationId });
}

/** 远端观察帧订阅：复用本 UI 唯一事件流，不另 listen 抢占本机帧；handle.remove 只减本地订阅。 */
export function listenMobileClientFrames(
  listener: (event: DesktopObservationEvent) => void,
): Promise<PluginListenerHandle> {
  if (!active) return Promise.reject(streamClosed());
  return active.addListener('clientFrame', listener);
}
