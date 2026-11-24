import type {
  BotDirectoryEntry,
  BotLiveState,
  LiveHistoryItem,
  QuestionnairePresentation,
  TodoPresentation,
} from '../../../../host-core/index.js';
import {
  canStopBotActivity,
  isBotActivityBusy,
  resolveBotActivity,
  type BotActivity,
} from '../../../../web/src/botActivity.ts';
import { resolveGrokMascotState } from '../../../../web/src/grokMascotEngine.ts';
import { toError } from '../api.ts';
import { hostStatus, type HostStatus } from '../hostService.ts';
import type { DesktopIdentity, DesktopPanelApi, ObservationHandle } from '../types';
import {
  INITIAL_PET_SNAPSHOT,
  type DesktopPetAction,
  type DesktopPetResult,
  type DesktopPetSnapshot,
  type PetActiveQuestionnaire,
  type PetHandoffCard,
  type PetMessage,
  type PetTaskCard,
} from './protocol.ts';

export interface DesktopPetControllerDependencies {
  hostStatus?: () => Promise<Pick<HostStatus, 'configured' | 'deviceId'>>;
}

export interface PetProjectedCards {
  activeToolName: string | null;
  questionnaire: PetActiveQuestionnaire | null;
  settledQuestionnaire: QuestionnairePresentation | null;
  todo: TodoPresentation | null;
  task: PetTaskCard | null;
  handoff: PetHandoffCard | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isSafeInt = (value: unknown): value is number => Number.isSafeInteger(value);

function readQuestionnaire(value: unknown): QuestionnairePresentation | null {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'questionnaire') return null;
  if (!isNonEmpty(value.installationId) || !isNonEmpty(value.requestId)) return null;
  if (!isSafeInt(value.conversationId) || value.conversationId < 0) return null;
  if (value.status !== 'pending' && value.status !== 'answered' && value.status !== 'cancelled') return null;
  if (!Array.isArray(value.questions) || value.questions.length < 1) return null;
  const validQuestions = value.questions.every((q) =>
    isRecord(q) &&
    isNonEmpty(q.question) &&
    isNonEmpty(q.header) &&
    Array.isArray(q.options) &&
    q.options.length >= 1 &&
    q.options.every((opt) => isRecord(opt) && isNonEmpty(opt.label) && isNonEmpty(opt.description)),
  );
  return validQuestions ? (value as unknown as QuestionnairePresentation) : null;
}

function readTodo(value: unknown): TodoPresentation | null {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'todo') return null;
  if (!isNonEmpty(value.installationId) || !Array.isArray(value.tasks) || value.tasks.length === 0) return null;
  const valid = value.tasks.every((task) =>
    isRecord(task) &&
    isSafeInt(task.id) &&
    task.id >= 0 &&
    isNonEmpty(task.subject) &&
    (task.status === 'pending' || task.status === 'in_progress' || task.status === 'completed'),
  );
  return valid ? (value as unknown as TodoPresentation) : null;
}

function readTask(value: unknown): PetTaskCard | null {
  if (!isRecord(value) || value.version !== 1 || value.kind !== 'task') return null;
  if (!isNonEmpty(value.taskId) || !isNonEmpty(value.title) || !isNonEmpty(value.cardLabel)) return null;
  if (
    value.status !== 'triaging' &&
    value.status !== 'working' &&
    value.status !== 'waiting' &&
    value.status !== 'done' &&
    value.status !== 'cancelled'
  ) {
    return null;
  }
  if (
    !isRecord(value.stepCount) ||
    !isSafeInt(value.stepCount.done) ||
    value.stepCount.done < 0 ||
    !isSafeInt(value.stepCount.total) ||
    value.stepCount.total < 0
  ) {
    return null;
  }
  return {
    taskId: value.taskId,
    title: value.title,
    status: value.status,
    cardLabel: value.cardLabel,
    ...(typeof value.summary === 'string' && value.summary ? { summary: value.summary } : {}),
    stepCount: { done: value.stepCount.done, total: value.stepCount.total },
  };
}

function readHandoff(value: unknown, fallbackId: string): PetHandoffCard | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.kind === 'vault-unlock') {
    if (value.status !== 'pending' || !isNonEmpty(value.requestId)) return null;
    const initializing = value.mode === 'initialize';
    return {
      id: `vault:${value.requestId}`,
      kind: 'vault-unlock',
      title: initializing ? '需要创建并解锁密码库' : '需要解锁本机密码库',
      detail: '主助手请求读取已授权凭据。为保障安全，主密码仅在主窗口专用通道输入。',
      tone: 'attention',
      actionLabel: initializing ? '在主窗口创建' : '在主窗口解锁',
    };
  }
  if (value.kind === 'google-browser-takeover') {
    const phase = typeof value.phase === 'string' ? value.phase : '';
    if (phase === 'done' || phase === 'completed' || phase === 'closed' || phase === 'cancelled') return null;
    return {
      id: `gbt:${typeof value.pageId === 'string' && value.pageId ? value.pageId : fallbackId}`,
      kind: 'google-browser-takeover',
      title: '需要接管浏览器操作',
      detail:
        (typeof value.reason === 'string' && value.reason) ||
        (typeof value.step === 'string' && value.step) ||
        '请在主窗口中完成登录或页面操作。',
      tone: 'attention',
      actionLabel: '在主窗口接管',
    };
  }
  if (value.kind === 'google-account-select') {
    if (value.status !== 'pending') return null;
    return {
      id: `gas:${typeof value.requestId === 'string' && value.requestId ? value.requestId : fallbackId}`,
      kind: 'google-account-select',
      title: '需要选择 Google 账号',
      detail:
        (typeof value.reason === 'string' && value.reason) ||
        (typeof value.actionLabel === 'string' && value.actionLabel) ||
        '请在主窗口中选择本次操作使用的账号。',
      tone: 'info',
      actionLabel: '在主窗口选择',
    };
  }
  if (value.kind === 'google-readiness') {
    const state = typeof value.state === 'string' ? value.state : '';
    if (!state || state === 'ready') return null;
    return {
      id: `gr:${fallbackId}`,
      kind: 'google-readiness',
      title: 'Google 服务需要处理',
      detail: (typeof value.detail === 'string' && value.detail) || '请打开主窗口查看授权或连接状态。',
      tone: 'attention',
      actionLabel: '在主窗口查看',
    };
  }
  if (value.kind === 'google-setup') {
    if (value.state !== 'running') return null;
    return {
      id: `gs:${typeof value.runId === 'string' && value.runId ? value.runId : fallbackId}`,
      kind: 'google-setup',
      title: (typeof value.title === 'string' && value.title) || 'Google 配置向导等待确认',
      detail: (typeof value.summary === 'string' && value.summary) || '请打开主窗口继续完成配置。',
      tone: 'info',
      actionLabel: '在主窗口继续',
    };
  }
  return null;
}

function questionnaireIdentityKey(q: Pick<QuestionnairePresentation, 'installationId' | 'conversationId' | 'requestId'>): string {
  return `${q.installationId}:${q.conversationId}:${q.requestId}`;
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

/** Project active interactive cards (questionnaire, todo, task, security handoff) for pet bubbles. */
export function projectPetCards(
  live: BotLiveState,
  activity: BotActivity,
  connectionReady: boolean,
): PetProjectedCards {
  const history = Array.isArray(live.history) ? live.history : [];
  const tools = Array.isArray(live.tools) ? live.tools : [];
  const cutoff = history.reduce((last, item) => item.kind === 'pi.reset' ? Math.max(last, item.id) : last, 0);
  const canSubmitQuestionnaire =
    connectionReady &&
    activity.phase !== 'stopping' &&
    activity.phase !== 'interrupting' &&
    activity.source !== 'room' &&
    activity.source !== 'dm';

  const durableSet = Array.isArray(live.durableWaits)
    ? new Set(live.durableWaits.map((w) => `${w.installationId}:${w.conversationId}:${w.requestId}`))
    : null;

  let questionnaire: PetActiveQuestionnaire | null = null;
  let settledQuestionnaire: QuestionnairePresentation | null = null;
  let todo: TodoPresentation | null = null;
  let task: PetTaskCard | null = null;
  let handoff: PetHandoffCard | null = null;
  let activeToolName: string | null = null;

  // 1) Scan live tool slots (newest first) for active presentations & tool names.
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const tool = tools[i];
    if (!tool) continue;
    if (!activeToolName && tool.status !== 'done' && tool.name && tool.name !== 'ask_user_question') {
      activeToolName = tool.name;
    }
    const pres = tool.presentation;
    if (!pres) continue;

    if (!questionnaire) {
      const q = readQuestionnaire(pres);
      if (q && q.status === 'pending') {
        const key = questionnaireIdentityKey(q);
        const isDurable = durableSet !== null ? durableSet.has(key) : tool.durableWait === true;
        const interrupted =
          tool.outcome === 'error' || tool.outcome === 'cancelled' || tool.outcome === 'interrupted';
        if (tool.status === 'running' || isDurable) {
          questionnaire = {
            toolCallId: tool.callId,
            presentation: q,
            interactive: canSubmitQuestionnaire && !interrupted,
            interrupted,
          };
        }
      }
    }
    if (!handoff && tool.status === 'running') {
      handoff = readHandoff(pres, tool.callId);
    }
    if (!todo) {
      todo = readTodo(pres);
    }
    if (!task) {
      const parsedTask = readTask(pres);
      if (parsedTask && (parsedTask.status === 'triaging' || parsedTask.status === 'working' || parsedTask.status === 'waiting')) {
        task = parsedTask;
      }
    }
  }

  // 2) Scan post-reset history (newest first) for durable pending questionnaires,
  //    recently settled questionnaires, and fallback todo/task/google-setup cards.
  const seenGoogleSetupRuns = new Set<string>();
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i];
    if (!item || item.id <= cutoff) continue;
    const msgs = Array.isArray(item.messages) ? item.messages : [];
    for (let j = msgs.length - 1; j >= 0; j -= 1) {
      const msg = msgs[j];
      if (!msg || msg.role !== 'toolResult' || !msg.presentation) continue;
      const rawPres: unknown = msg.presentation;

      const q = readQuestionnaire(rawPres);
      if (q) {
        if (q.status === 'pending' && !questionnaire) {
          const key = questionnaireIdentityKey(q);
          const isDurable = durableSet !== null ? durableSet.has(key) : msg.durableWait === true;
          if (isDurable) {
            questionnaire = {
              toolCallId: msg.toolCallId ?? `history:${item.id}:${j}`,
              presentation: q,
              interactive: canSubmitQuestionnaire,
              interrupted: false,
            };
          }
        } else if ((q.status === 'answered' || q.status === 'cancelled') && !settledQuestionnaire) {
          settledQuestionnaire = q;
        }
      }

      if (isRecord(rawPres) && rawPres.kind === 'google-setup' && typeof rawPres.runId === 'string') {
        if (!seenGoogleSetupRuns.has(rawPres.runId)) {
          seenGoogleSetupRuns.add(rawPres.runId);
          if (!handoff && rawPres.state === 'running') {
            handoff = readHandoff(rawPres, `history:${item.id}:${j}`);
          }
        }
      }

      if (!todo) {
        todo = readTodo(rawPres);
      }
      if (!task) {
        const parsedTask = readTask(rawPres);
        if (parsedTask && (parsedTask.status === 'triaging' || parsedTask.status === 'working' || parsedTask.status === 'waiting')) {
          task = parsedTask;
        }
      }
    }
  }

  return {
    activeToolName,
    questionnaire,
    settledQuestionnaire,
    todo,
    task,
    handoff,
  };
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
      activeToolName: null, questionnaire: null, settledQuestionnaire: null,
      todo: null, task: null, handoff: null,
    });
  }

  function markOffline(message: string): void {
    closeObservation();
    publish({
      connection: 'offline', error: message, canStop: false,
      activity: resolveBotActivity(null), mascotState: 'idle', streamingText: '',
      activeToolName: null,
      questionnaire: value.questionnaire
        ? { ...value.questionnaire, interactive: false }
        : null,
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
    const cards = projectPetCards(next, activity, true);
    const activeTool = next.tools.find((tool) => tool.status === 'running')
      ?? next.tools.find((tool) => tool.status === 'pending');
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
      activeToolName: cards.activeToolName,
      questionnaire: cards.questionnaire,
      settledQuestionnaire: cards.settledQuestionnaire,
      todo: cards.todo,
      task: cards.task,
      handoff: cards.handoff,
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
      const handle = api.observe(target, { kind: 'primary', botId: primary.botId }, (event) => {
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
      void handle.ready.catch((error) => {
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
      const primary = directory.bots.find((item) =>
        item.deviceId === host.deviceId && item.isPrimary && !item.archivedAt);
      if (!primary) {
        clearTarget();
        const failure = directory.errors.find((item) => item.deviceId === host.deviceId);
        const offline = directory.devices.find((item) => item.deviceId === host.deviceId)?.online === false;
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

  async function answerQuestionnaire(
    action: Extract<DesktopPetAction, { kind: 'answer-questionnaire' }>,
  ): Promise<DesktopPetResult> {
    if (!active || value.connection !== 'ready' || !identity || !bot) {
      return { id: action.id, ok: false, message: '本机 main bot 尚未连接，无法提交问卷。' };
    }
    const target = { ...identity };
    const botId = bot.botId;
    try {
      const reply = await api.call(target, 'callCapabilityAction', {
        installationId: action.installationId,
        action: 'answerQuestionnaire',
        request: {
          requestId: action.id,
          deviceId: target.targetDeviceId,
          botId,
          input: action.input,
        },
      });
      return { id: action.id, ok: true, data: reply?.result };
    } catch (error) {
      return { id: action.id, ok: false, message: toError(error).message };
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
    if (action.kind === 'answer-questionnaire') return answerQuestionnaire(action);
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
