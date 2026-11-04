// Lane 7 mobile：本机 Bot 通信的只读浏览适配器。
// 真能力只走 BotHost.call/observe（本地 Host ledger / work 观察），不连远端、不伪造写操作。
// 写入口（pending/mutateIntent/草稿/文件）一律不存在于本对象——Scopes 以 readOnly 渲染时
// 不会触碰它们；若被误调用即抛 NOT_CONNECTED，绝不假装成功。
import { BotHost } from './native';
import type { HostFrameEvent, HostLiveFrame, PluginListenerHandle } from './native';
import type { MobileHostError } from './native/tauri-host';
import type {
  DesktopErrorShape,
  DesktopIdentity,
  DesktopObservationEvent,
  DesktopUiSnapshot,
  LiveTarget,
  ObservationHandle,
  RemoteControlMethodMap,
  RemoteControlOutcome,
} from '../../desktop/web/src/types';
// DesktopLiveFrame 的真实导出在 host-core/desktop-client（types.ts 不 re-export 该名字）。
import type { DesktopLiveFrame } from '../../host-core/desktop-client.js';
import type { RemoteLiveEnd } from '../../host-core/index.js';
import type { ScopeReadApi } from '../../desktop/web/src/scope-api';

export interface LocalScopeApiOptions {
  /** 本机设备 ID（Host snapshot.deviceId；变化即换 sessionKey，旧响应被丢弃）。 */
  deviceId: string;
  /** 打开页面的单调代际：每次构建自增，跨页面/重启不串。 */
  generation: number;
  /** Host 是否运行：false 时 transportConnected=false，组件离线展示、不发请求。
      必须从最新 Host 状态读取（调用方传 ref.getter），不能闭包捕获旧快照。 */
  hostRunning(): boolean;
  reportError?(error: unknown): void;
}

/**
 * 由 createLocalScopeReadApi 返回的适配器：除 ScopeReadApi 外还暴露 dispose()。
 * Scopes 只调用 ScopeReadApi 方法/属性，dispose 由创建方（Host cleanup）在适配器
 * 被替换/卸载时调用：置 disposed 旗标使所有在途/后续操作立即拒绝并停止投递，
 * 移除共享原生 listener，取消全部在途观察，不泄漏。
 */
export interface LocalScopeReadApi extends ScopeReadApi {
  dispose(): Promise<void>;
}

const KNOWN_OUTCOMES = new Set<RemoteControlOutcome>(['not-sent', 'unconfirmed', 'responded']);

/** 从任意错误恢复 RemoteControlOutcome：只承认三值枚举，缺省 unconfirmed，不编造 outcome。 */
function outcomeOf(error: unknown): RemoteControlOutcome {
  const raw = (error as MobileHostError | undefined)?.outcome;
  return typeof raw === 'string' && KNOWN_OUTCOMES.has(raw as RemoteControlOutcome)
    ? (raw as RemoteControlOutcome)
    : 'unconfirmed';
}

function toErrorShape(code: string, message: string, outcome: RemoteControlOutcome): DesktopErrorShape {
  return { code, message, outcome };
}

/**
 * 把本机 Host 帧包装为桌面 DesktopLiveFrame，按 type 分别保留真实字段、不伪造。
 * 'snapshot' 带 state、'update' 带 changes、'end' 带真实 BotWatchEndReason reason。
 * update 帧的 changes 缺省为空对象（partial merge 语义，非伪造）；
 * 数据帧经 type 判别后原样透传，不做 unknown-as 转换。
 */
function adaptHostFrame(frame: HostLiveFrame): DesktopLiveFrame {
  if (frame.type === 'end') {
    // BotLiveEnd/WorkLiveEnd.reason 已是真实 BotWatchEndReason，原样收敛为 RemoteLiveEnd。
    const end: RemoteLiveEnd = { type: 'end', reason: frame.reason };
    return end;
  }
  if (frame.type === 'update') {
    // 只保留 changes（合法 update 不依赖 state）。
    return { ...frame, changes: frame.changes ?? {} } as DesktopLiveFrame;
  }
  // 'snapshot'：保留 state（真实快照字段）。
  return frame as DesktopLiveFrame;
}

export function createLocalScopeReadApi(options: LocalScopeApiOptions): LocalScopeReadApi {
  const identity: DesktopIdentity = {
    profileId: 'local',
    kind: 'local',
    generation: options.generation,
    targetDeviceId: options.deviceId,
  };

  let obsSeq = 0;
  const listeners = new Map<string, (event: DesktopObservationEvent) => void>();
  /** 适配器失效旗标：dispose 后所有在途/新操作拒绝、停止投递，不读旧代际。 */
  let disposed = false;
  /** 在途的 dispose 承诺：dispose 期间 listener/observe 完成也要最终释放。 */
  let disposePromise: Promise<void> | null = null;
  /** 共享 hostFrame listener 的注册句柄（异步 addListener 完成前的取消用 pendingRemove）。 */
  let hostListenerHandle: PluginListenerHandle | null = null;
  let hostListenerPromise: Promise<void> | null = null;
  let hostListenerPendingRemove = false;

  const dispatchFrame = (ev: HostFrameEvent): void => {
    if (disposed) return;
    const cb = listeners.get(ev.observationId);
    if (!cb) return;
    if (ev.error) {
      cb({
        type: 'event',
        observationId: ev.observationId,
        error: toErrorShape(ev.error.code, ev.error.message, outcomeOf(ev.error)),
      });
      return;
    }
    if (ev.frame) {
      cb({ type: 'event', observationId: ev.observationId, frame: adaptHostFrame(ev.frame) });
    }
  };

  const removeHostListener = async (): Promise<void> => {
    const handle = hostListenerHandle;
    hostListenerHandle = null;
    hostListenerPromise = null;
    if (handle) {
      try {
        await handle.remove();
      } catch {
        // 已结束/未建立的移除失败无害，不外溢为 dispose 错误。
      }
    } else {
      hostListenerPendingRemove = true;
    }
  };

  /**
   * 在第一次 observe 前确保共享原生 hostFrame listener 已注册；
   * 只注册一次。disposed 时立即拒绝，不发起注册。dispose 期间完成的注册
   * 由 hostListenerPendingRemove 保证最终 remove，不泄漏。
   */
  const ensureHostListener = (): Promise<void> => {
    if (disposed) {
      return Promise.reject(Object.assign(new Error('已关闭'), toErrorShape('DISPOSED', '已关闭', 'not-sent')));
    }
    if (!hostListenerPromise) {
      hostListenerPromise = BotHost.addListener('hostFrame', dispatchFrame)
        .then((handle) => {
          if (hostListenerPendingRemove) {
            hostListenerPendingRemove = false;
            void handle.remove();
            return;
          }
          hostListenerHandle = handle;
        })
        .catch((e: unknown) => {
          hostListenerPromise = null;
          throw e;
        });
    }
    return hostListenerPromise;
  };

  const api: LocalScopeReadApi = {
    identity,
    identityForTarget(targetDeviceId: string): DesktopIdentity {
      return { profileId: 'local', kind: 'local', generation: options.generation, targetDeviceId };
    },
    snapshot: null as DesktopUiSnapshot | null,
    get transportConnected(): boolean {
      return !disposed && options.hostRunning();
    },
    async call<M extends keyof RemoteControlMethodMap>(
      id: DesktopIdentity,
      method: M,
      params: RemoteControlMethodMap[M]['params'],
    ): Promise<RemoteControlMethodMap[M]['result']> {
      if (disposed || !options.hostRunning()) {
        throw Object.assign(new Error('Host 未运行'), toErrorShape('NOT_CONNECTED', 'Host 未运行', 'not-sent'));
      }
      // 代际 fence：页面切换/重启后旧身份不得再下发请求。
      if (id.generation !== options.generation) {
        throw Object.assign(new Error('会话已过期'), toErrorShape('SESSION_EXPIRED', '会话已过期', 'not-sent'));
      }
      let reply;
      try {
        reply = await BotHost.call({ method: method as string, params: (params ?? {}) as Record<string, unknown> });
      } catch (e) {
        // 保留真实 code/outcome；缺省 unconfirmed，不假装已送达。
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), {
          outcome: outcomeOf(e),
        });
      }
      // call 返回后再次 fence：等待期间适配器可能被 dispose，拒绝已失效代际。
      if (disposed) {
        throw Object.assign(new Error('已关闭'), toErrorShape('DISPOSED', '已关闭', 'not-sent'));
      }
      return reply.result as RemoteControlMethodMap[M]['result'];
    },
    observe(
      id: DesktopIdentity,
      target: LiveTarget,
      onEvent: (event: DesktopObservationEvent) => void,
    ): ObservationHandle {
      const observationId = 'lscope-' + options.generation + '-' + (++obsSeq);
      // 只支持已有两类 target；其余类型立即报错，不假装订阅成功。
      const valid = !!target && (target.kind === 'primary' || target.kind === 'work');
      let closed = false;
      // 回调只在确认未 closed/disposed 时注册（ensureHostListener 之后、BotHost.observe 之前）：
      // 任何时刻 close/dispose 都让 callback 不再投递，且原生观察被取消。
      const ready = valid
        ? (async () => {
            await ensureHostListener();
            if (closed || disposed) throw Object.assign(new Error('已关闭'), toErrorShape('DISPOSED', '已关闭', 'not-sent'));
            listeners.set(observationId, onEvent);
            try {
              await BotHost.observe({
                observationId,
                target: target as { kind: 'primary'; botId: string } | { kind: 'work'; botId: string; scopeId: string },
              });
            } catch (e) {
              listeners.delete(observationId);
              throw e;
            }
            // observe resolve 后才算建立；若期间已被 close/dispose，清 callback 并补发取消，不留观察。
            if (closed || disposed) {
              listeners.delete(observationId);
              try { await BotHost.cancelObservation({ observationId }); } catch { /* 已结束/未建立 */ }
            }
          })()
        : Promise.reject(Object.assign(new Error('unsupported observe target'), toErrorShape('INVALID_ARGUMENT', 'unsupported observe target', 'not-sent')));
      // ready 自身失败也要清 callback，不让孤儿回调残留。
      void ready.catch(() => { listeners.delete(observationId); });
      return {
        ready,
        close: async () => {
          if (closed) return;
          closed = true;
          listeners.delete(observationId);
          try { await BotHost.cancelObservation({ observationId }); } catch { /* 已结束/未建立 */ }
        },
      };
    },
    reportError(error: unknown): void {
      options.reportError?.(error);
    },
    async dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        // 先停投递/拒绝新请求（disposed 已置），再移除共享 listener；
        // 若注册仍在途（hostListenerHandle 未就绪），pendingRemove 保证完成后 remove。
        await removeHostListener();
        // 释放剩余观察：组件卸载后不再收帧，也通知原生取消在途观察。
        for (const observationId of [...listeners.keys()]) {
          listeners.delete(observationId);
          try { await BotHost.cancelObservation({ observationId }); } catch { /* 已结束/未建立 */ }
        }
      })();
      return disposePromise;
    },
  };
  return api;
}
