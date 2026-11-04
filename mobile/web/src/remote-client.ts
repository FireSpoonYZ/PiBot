// M20 手机远端页装配：把桌面 DesktopViewApiImpl 接到手机原生 client* 传输（私有同 UID Binder）。
// 只复用 desktop/web 的 API 实现与其面板；Node broker 不在 Web bundle 内（host-core 只 import type）。
// 冷启动不创建 client child：只有用户显式打开远端页时 mobile shell 才调用 createMobileRemoteClient。
import { DesktopRemoteError, createDesktopClient } from '../../../desktop/web/src/api';
import type { DesktopTransport } from '../../../desktop/web/src/api';
import type {
  BrokerOpParams, BrokerOpResult, DesktopPanelApi, PublicBrokerOperation,
} from '../../../desktop/web/src/types';
import type { DesktopObservationEvent } from '../../../host-core/desktop-client.js';
import {
  listenMobileClientFrames, mobileClientObserve, mobileClientRequest, mobileClientUnobserve,
  onMobileStreamFailure,
} from '../../../web/src/native/tauri-host';

export interface MobileRemoteClient {
  api: DesktopPanelApi;
  /** 只释放本页的本地订阅，不关闭原生 client child、不停止任何 Host。 */
  dispose(): void;
  /** 主动重连前同步作废旧身份与观察：保持离线，不自动 connect/重放，也不清任何草稿。 */
  invalidate(): void;
}

/**
 * 一条本页拥有的远端观察：opening/live/closing 都占一个 8 槽名额，直到原生确认取消。
 * stopListener 可立即调用（幂等）；记录身份留到取消被确认。
 */
interface OwnedObservation {
  readonly observationId: string;
  readonly epoch: number;
  readonly connection: boolean;
  readonly emit: (event: DesktopObservationEvent) => void;
  stopListener: () => Promise<void>;
  /** 按 id 合并的取消完成 Promise（在途或已失败待再次关闭）。 */
  closing: Promise<void> | null;
}

/** 本页同时拥有的远端观察上限（与原生观察上限一致）。 */
const MAX_OWNED_OBSERVATIONS = 8;

export function createMobileRemoteClient(): MobileRemoteClient {
  // observationId → 本页拥有的观察：它同时是 8 槽准入与取消责任表。
  const sinks = new Map<string, OwnedObservation>();
  // 会话代：invalidate/dispose/流失败时前进，旧代排队任务执行前据此失效。
  let sessionEpoch = 0;
  // 单一 Promise 链：一次只有一个 native 清理在途（原生只有两个清理额度，串行不会撞上限）。
  let nativeChain: Promise<void> = Promise.resolve();

  const serializeNative = (task: () => Promise<void>): Promise<void> => {
    const run = nativeChain.then(task);
    nativeChain = run.then(() => undefined, () => undefined);
    return run;
  };

  // 按 id 合并取消：同一记录只发一次 native unobserve，重复关闭拿到同一个完成 Promise；
  // 成功才删除记录，失败保留记录（仍占 8 槽）供再次关闭或会话收尾。
  const closeOwned = (record: OwnedObservation): Promise<void> => {
    if (record.closing) return record.closing;
    const { observationId, epoch } = record;
    const owned = (): boolean => epoch === sessionEpoch && sinks.get(observationId) === record;
    // 本地监听立即移除（旧帧不再进页面），记录身份与槽位留到原生确认。
    void record.stopListener();
    const run = serializeNative(async () => {
      // 执行前核对会话代与记录身份：旧代任务不得取消新会话的观察。
      if (!owned()) return;
      await record.stopListener();
      await mobileClientUnobserve(observationId);
      if (owned()) sinks.delete(observationId);
    });
    record.closing = run;
    const settle = (): void => { if (record.closing === run) record.closing = null; };
    run.then(settle, settle);
    return run;
  };

  const transport: DesktopTransport = {
    // 普通 op（含 ui_get/ui_set/pending_*）走唯一 clientRequest；结果可能是 null 或数组。
    request<K extends PublicBrokerOperation>(
      op: K,
      params: BrokerOpParams<K>,
    ): Promise<BrokerOpResult<K>> {
      return mobileClientRequest<BrokerOpResult<K>>(op, params);
    },
    // 手机不提供本机文件 picker：明确未派发，绝不编造路径引用冒充上传。
    async pickFile() {
      throw new DesktopRemoteError({
        code: 'FILE_PICK_UNSUPPORTED',
        message: '手机远端页不支持选择本机文件（跨设备不提供路径引用上传）',
        outcome: 'not-sent',
      });
    },
    async observe(observationId, targetDeviceId, target, onEvent) {
      // 任何 await 之前预占 8 槽之一：opening/已关闭未确认都算，满则明确未派发。
      const connection = target.kind === 'connection';
      if (connection) {
        for (const [id, sink] of sinks.entries()) {
          if (sink.connection && id !== observationId) {
            sinks.delete(id);
            void closeOwned(sink).catch(() => undefined);
          }
        }
      }
      if ((connection ? [...sinks.values()].some((sink) => sink.connection)
        : [...sinks.values()].filter((sink) => !sink.connection).length >= MAX_OWNED_OBSERVATIONS) || sinks.has(observationId)) {
        throw new DesktopRemoteError({
          code: 'RPC_BUSY',
          message: '远端观察数已达上限',
          outcome: 'not-sent',
        });
      }
      const epoch = sessionEpoch;
      const record: OwnedObservation = {
        observationId, epoch, connection, emit: onEvent, stopListener: () => Promise.resolve(), closing: null,
      };
      sinks.set(observationId, record);
      const owned = (): boolean => epoch === sessionEpoch && sinks.get(observationId) === record;
      try {
        // 订阅先就位再发 observe：两者共用本 UI 的唯一事件流（不另 listen）。
        const handle = await listenMobileClientFrames((event) => {
          if (event.observationId === observationId) record.emit(event);
        });
        let stopping: Promise<void> | null = null;
        record.stopListener = () => {
          if (!stopping) stopping = handle.remove().catch(() => undefined);
          return stopping;
        };
        // 监听注册期间本页已换代/记录已收束：不再建立观察。
        if (!owned()) {
          await record.stopListener();
          throw new DesktopRemoteError({
            code: 'CLOSED', message: '观察已作废', outcome: 'not-sent',
          });
        }
        await mobileClientObserve({ observationId, targetDeviceId, target });
      } catch (e) {
        // 未确认是否已建立：保留记录并安排一次幂等取消（重复关闭合并同一 Promise）。
        void closeOwned(record).catch(() => undefined);
        throw e;
      }
    },
    unobserve(observationId) {
      const record = sinks.get(observationId);
      // 未拥有（从未建立或取消已确认）：没有本地责任。
      if (!record) return Promise.resolve();
      // 返回真实完成 Promise：成功才释放槽位，失败保留记录。
      return closeOwned(record);
    },
  };

  const api = createDesktopClient(transport);

  // 流故障与主动重连共用：旧身份立即失效，旧观察收束为错误帧，要求用户显式重新连接；
  // 不重连、不重发观察、不重放变更，也不清草稿（草稿留在本页内存与磁盘）。
  const failStream = (code: string, message: string): void => {
    // 会话代前进：旧代的待取消任务执行前失效，不会取消新会话的观察。
    sessionEpoch += 1;
    for (const record of sinks.values()) {
      record.emit({
        type: 'event',
        observationId: record.observationId,
        error: { code, message, outcome: 'unconfirmed' },
      });
      void record.stopListener();
    }
    // 旧会话已被拆除/作废：其清理责任随之结束（原生在会话关闭/EOF 时释放 client child）。
    sinks.clear();
    api.setTransportConnected(false);
  };

  // 流失败后旧身份立即失效：只做只读收束，要求用户显式重新连接；不重连、不重发观察、不重放变更。
  const stopFailures = onMobileStreamFailure((error) => failStream(error.code, error.message));

  return {
    api,
    // 原生已拆除旧会话（新 broker 未连接）：旧 generation/LIVE 不得继续点击或观察。
    invalidate() {
      failStream('TRANSPORT_RESET', '已主动重连：旧远端身份与观察已作废，请重新选择目标后显式连接。');
    },
    // 必须真正移除每个观察的 clientFrame 监听（只 clear 会让监听器留在原生事件流上）。
    dispose() {
      stopFailures();
      // 页面卸载：会话代前进并释放全部所有权（原生会话随 UI 关闭释放 client child）。
      sessionEpoch += 1;
      for (const record of sinks.values()) void record.stopListener();
      sinks.clear();
    },
  };
}
