import type { BotDirectoryEntry, BotLiveState, LiveHistoryItem } from '../../../../host-core/index.js';
import { canStopBotActivity, isBotActivityBusy, resolveBotActivity } from '../../../../web/src/botActivity.ts';
import { resolveGrokMascotState } from '../../../../web/src/grokMascotEngine.ts';
import { toError } from '../api.ts';
import { hostStatus, type HostStatus } from '../hostService.ts';
import type { DesktopIdentity, DesktopPanelApi, ObservationHandle } from '../types';
import {
  INITIAL_PET_SNAPSHOT,
  type DesktopPetAction,
  type DesktopPetResult,
  type DesktopPetSnapshot,
  type PetMessage,
} from './protocol.ts';

export interface DesktopPetControllerDependencies {
  hostStatus?: () => Promise<Pick<HostStatus, 'configured' | 'deviceId'>>;
}

/** The pet shows a small recent transcript; full history stays in the main chat. */
export function projectPetMessages(history: readonly LiveHistoryItem[]): PetMessage[] {
  const cutoff = history.reduce((last, item) => item.kind === 'pi.reset' ? Math.max(last, item.id) : last, 0);
  const messages: PetMessage[] = [];
  for (const item of history) {
    if (item.id <= cutoff) continue;
    item.messages.forEach((message, index) => {
      if ((message.role === 'user' || message.role === 'assistant') && message.text.trim()) {
        messages.push({ id: item.id + ':' + index, role: message.role, text: message.text });
      }
    });
  }
  return messages.slice(-12);
}

/** Relay target selection belongs to the main UI, not the pet's local Bot binding. */
function connectionKey(api: DesktopPanelApi): string {
  const id = api.identity;
  return id
    ? JSON.stringify([id.profileId, id.kind, id.generation, id.kind === 'local' ? id.targetDeviceId : '', api.transportConnected])
    : '';
}

export function createDesktopPetController(
  api: DesktopPanelApi,
  onSnapshot: (snapshot: DesktopPetSnapshot) => void,
  dependencies: DesktopPetControllerDependencies = {},
) {
  const readHost = dependencies.hostStatus ?? hostStatus;
  let value: DesktopPetSnapshot = { ...INITIAL_PET_SNAPSHOT, hostSessionId: crypto.randomUUID() };
  let active = false;
  let unsubscribe: (() => void) | null = null;
  let observedConnection = '';
  let refreshEpoch = 0;
  let observationEpoch = 0;
  let observation: ObservationHandle | null = null;
  let identity: DesktopIdentity | null = null;
  let bot: BotDirectoryEntry | null = null;
  let live: BotLiveState | null = null;
  let generationSerial = 0;
  let sending = false;

  function publish(patch: Partial<DesktopPetSnapshot> = {}): void {
    value = { ...value, ...patch, sending, revision: value.revision + 1 };
    if (active) onSnapshot(value);
  }

  function closeObservation(): void {
    observationEpoch += 1;
    const previous = observation;
    observation = null;
    if (previous) void previous.close();
  }

  function clearTarget(): void {
    closeObservation();
    identity = null;
    bot = null;
    live = null;
    publish({
      botId: null, botName: 'PiBot', avatar: null, messages: [],
      activity: resolveBotActivity(null), mascotState: 'idle',
      streamingText: '', generationId: null, canStop: false,
    });
  }

  function markOffline(message: string): void {
    closeObservation();
    publish({
      connection: 'offline', error: message, canStop: false,
      activity: resolveBotActivity(null), mascotState: 'idle', streamingText: '',
    });
  }

  function applyLive(next: BotLiveState): void {
    const previous = live;
    live = next;
    const activity = resolveBotActivity(next);
    const text = next.generation?.text ?? '';
    let generationId = value.generationId;
    if (next.generation && (!previous?.generation || !text.startsWith(previous.generation.text))) {
      generationSerial += 1;
      generationId = value.deviceId + ':' + value.botId + ':' + generationSerial;
    }
    const activeTool = next.tools.find(tool => tool.status === 'running')
      ?? next.tools.find(tool => tool.status === 'pending');
    publish({
      connection: 'ready',
      activity,
      canStop: canStopBotActivity(activity),
      mascotState: resolveGrokMascotState({
        isBusy: isBotActivityBusy(activity),
        isStreaming: Boolean(text),
        activeToolName: activeTool?.name,
        settlementOutcome: activity.phase === 'failed' ? 'error' : null,
      }),
      messages: projectPetMessages(next.history),
      streamingText: text,
      generationId,
      error: activity.error?.message ?? null,
    });
  }

  function watch(target: DesktopIdentity, primary: BotDirectoryEntry): void {
    closeObservation();
    live = null;
    const epoch = observationEpoch;
    const key = observedConnection;
    const current = () => active && epoch === observationEpoch && key === connectionKey(api);
    try {
      const handle = api.observe(target, { kind: 'primary', botId: primary.botId }, event => {
        if (!current()) return;
        if ('error' in event) {
          markOffline(toError(event.error).message);
          return;
        }
        const frame = event.frame;
        if (frame.type === 'end') {
          markOffline('实时连接已结束，点击刷新重新连接。');
          return;
        }
        if (!('botId' in frame) || 'scopeId' in frame || frame.botId !== primary.botId) return;
        if (frame.type === 'snapshot') {
          applyLive(frame.state);
        } else if (live) {
          applyLive({ ...live, ...frame.changes });
        }
      });
      observation = handle;
      void handle.ready.catch(error => {
        if (current()) markOffline(toError(error).message);
      });
    } catch (error) {
      if (current()) markOffline(toError(error).message);
    }
  }

  async function refresh(): Promise<void> {
    if (!active) return;
    const epoch = ++refreshEpoch;
    const key = connectionKey(api);
    const current = () => active && epoch === refreshEpoch && key === connectionKey(api);
    if (!observation) publish({ connection: 'connecting', error: null });
    try {
      const host = await readHost();
      if (!current()) return;
      if (!host.configured || !host.deviceId) {
        clearTarget();
        publish({ connection: 'unconfigured', deviceId: null, error: '请先在主界面配置本机 Host。' });
        return;
      }
      if (value.deviceId && value.deviceId !== host.deviceId) clearTarget();
      publish({ deviceId: host.deviceId });
      if (!api.identity || !api.transportConnected) {
        markOffline('客户端尚未连接，请在主界面连接本机 Host。');
        return;
      }
      const target = api.identityForTarget(host.deviceId);
      const directory = await api.broker(target, 'bot_directory', {});
      if (!current()) return;
      const primary = directory.bots.find(item =>
        item.deviceId === host.deviceId && item.isPrimary && !item.archivedAt);
      if (!primary) {
        clearTarget();
        const failure = directory.errors.find(item => item.deviceId === host.deviceId);
        const offline = directory.devices.find(item => item.deviceId === host.deviceId)?.online === false;
        publish({
          connection: failure || offline ? 'offline' : 'unconfigured',
          error: failure?.message ?? (failure || offline ? '本机 Host 暂不可用。' : '本机还没有 main bot，请在主界面创建或指定。'),
        });
        return;
      }
      const changed = !bot || bot.botId !== primary.botId || bot.deviceId !== primary.deviceId;
      if (changed) clearTarget();
      bot = primary;
      identity = target;
      publish({
        deviceId: primary.deviceId, botId: primary.botId, botName: primary.role,
        avatar: primary.avatar ?? null, error: null,
      });
      if (!primary.online) {
        markOffline('本机 Host 离线，连接恢复后可继续对话。');
      } else if (!observation) {
        watch(target, primary);
      }
    } catch (error) {
      if (current()) markOffline(toError(error).message);
    }
  }

  function onConnectionChange(): void {
    const key = connectionKey(api);
    if (key === observedConnection) return;
    observedConnection = key;
    refreshEpoch += 1;
    clearTarget();
    void refresh();
  }

  function start(): void {
    if (active) {
      publish();
      return;
    }
    active = true;
    observedConnection = connectionKey(api);
    unsubscribe = api.subscribe(onConnectionChange);
    void refresh();
  }

  function stop(): void {
    active = false;
    refreshEpoch += 1;
    unsubscribe?.();
    unsubscribe = null;
    closeObservation();
    live = null;
  }

  async function send(action: Extract<DesktopPetAction, { kind: 'send' }>): Promise<DesktopPetResult> {
    const text = action.text.trim();
    if (!text) return { id: action.id, ok: false, message: '请输入消息。' };
    if (sending) return { id: action.id, ok: false, message: '消息正在发送。' };
    if (!active || value.connection !== 'ready' || !identity || !bot) {
      return { id: action.id, ok: false, message: '本机 main bot 尚未连接，消息未发送。' };
    }
    const target = { ...identity };
    const botId = bot.botId;
    const requestId = action.id;
    let pendingId: string | undefined;
    sending = true;
    publish();
    try {
      const record = await api.pending(target, 'pending_enqueue', {
        input: { kind: 'primary', targetDeviceId: target.targetDeviceId, botId, requestId, text },
      });
      pendingId = record.id;
      const result = await api.pending(target, 'pending_send', { id: record.id });
      if (result.state === 'accepted') return { id: action.id, ok: true, pendingId };
      return {
        id: action.id, ok: false, pendingId,
        message: result.state === 'rejected'
          ? '消息未被接受，已保留在主界面的发送记录中。'
          : '发送结果尚未确认，请在主界面的发送记录中查看，勿重复发送。',
      };
    } catch (error) {
      const failure = toError(error);
      return {
        id: action.id, ok: false, ...(pendingId ? { pendingId } : {}),
        message: pendingId
          ? '消息已加入发送记录，请在主界面查看处理状态。'
          : failure.outcome === 'not-sent'
            ? failure.message
            : '入队结果尚未确认，请先检查主界面的发送记录，勿重复发送。',
      };
    } finally {
      sending = false;
      publish();
    }
  }

  async function handleAction(action: DesktopPetAction): Promise<DesktopPetResult> {
    if (action.kind === 'ready') {
      if (!active) start();
      else publish();
      return { id: action.id, ok: true };
    }
    if (action.kind === 'refresh') {
      await refresh();
      return { id: action.id, ok: true };
    }
    if (action.deviceId !== value.deviceId || action.botId !== value.botId) {
      return { id: action.id, ok: false, message: '本机 main bot 已变化，请确认后重新操作。' };
    }
    if (action.kind === 'send') return send(action);
    if (!active || value.connection !== 'ready' || !identity || !bot) {
      return { id: action.id, ok: false, message: '本机 main bot 尚未连接。' };
    }
    const target = { ...identity };
    const botId = bot.botId;
    try {
      await api.call(target, 'abort', { botId });
      return { id: action.id, ok: true };
    } catch (error) {
      return { id: action.id, ok: false, message: toError(error).message };
    }
  }

  return { start, stop, handleAction, snapshot: () => value };
}
