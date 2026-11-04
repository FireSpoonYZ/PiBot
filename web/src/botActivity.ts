// Shared pure helpers for the unified Bot work-state contract.
// live.activity is authoritative once present (wire boundary validates it);
// busy/queuedCount/turnAdmission are the legacy fallback for older Hosts.
// No bridge, storage, or React dependencies here.

export type BotActivityPhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'running'
  | 'compacting'
  | 'interrupting'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type BotActivitySource = 'primary' | 'room' | 'dm' | 'background' | null;

export type BotActivity = {
  phase: BotActivityPhase;
  source: BotActivitySource;
  scopeId: string | null;
  requestId: string | null;
  /** ISO timestamp; null when unknown. */
  startedAt: string | null;
  /** 仅 phase 'failed' 时 Host 附带的有界失败诊断；旧 Host 及其他相缺省。 */
  error?: { code: string; message: string };
};

const IDLE_ACTIVITY: BotActivity = {
  phase: 'idle',
  source: null,
  scopeId: null,
  requestId: null,
  startedAt: null,
};

function fallbackActivity(phase: BotActivityPhase): BotActivity {
  return { ...IDLE_ACTIVITY, phase };
}

export function resolveBotActivity(
  live?: {
    busy?: boolean;
    queuedCount?: number;
    activity?: BotActivity;
    turnAdmission?: { phase: string } | null;
  } | null,
): BotActivity {
  if (live?.activity) return live.activity;
  if (!live) return IDLE_ACTIVITY;
  if (live.busy) return fallbackActivity('running');
  const admissionPhase = live.turnAdmission?.phase;
  if (admissionPhase === 'failed') return fallbackActivity('failed');
  if (admissionPhase === 'checking' || admissionPhase === 'synchronizing') {
    return fallbackActivity('preparing');
  }
  if ((live.queuedCount ?? 0) > 0) return fallbackActivity('queued');
  return IDLE_ACTIVITY;
}

export function isBotActivityBusy(activity: BotActivity): boolean {
  return (
    activity.phase === 'queued' ||
    activity.phase === 'preparing' ||
    activity.phase === 'running' ||
    activity.phase === 'compacting' ||
    activity.phase === 'interrupting' ||
    activity.phase === 'stopping'
  );
}

export function canStopBotActivity(activity: BotActivity): boolean {
  return (
    activity.phase === 'queued' ||
    activity.phase === 'preparing' ||
    activity.phase === 'running' ||
    activity.phase === 'compacting' ||
    activity.phase === 'interrupting' ||
    activity.phase === 'failed'
  );
}

export function botActivityText(
  activity: BotActivity,
  t: (zh: string, en: string) => string,
): string {
  const phaseText = (() => {
    switch (activity.phase) {
      case 'queued':
        return t('排队中', 'Queued');
      case 'preparing':
        return t('准备中', 'Preparing');
      case 'running':
        return t('工作中', 'Working');
      case 'compacting':
        return t('整理上下文中', 'Compacting');
      case 'interrupting':
        return t('正在让位', 'Yielding');
      case 'stopping':
        return t('正在停止', 'Stopping');
      case 'stopped':
        return t('已停止', 'Stopped');
      case 'failed':
        return t('执行失败', 'Failed');
      default:
        return t('空闲', 'Idle');
    }
  })();
  if (activity.phase === 'idle' || !activity.source) return phaseText;
  const sourceText =
    activity.source === 'room'
      ? t('群聊', 'room')
      : activity.source === 'dm'
        ? t('私信', 'DM')
        : activity.source === 'background'
          ? t('后台', 'background')
          : t('主聊天', 'main chat');
  return `${phaseText} · ${sourceText}`;
}

export function parseBotActivityStartedAt(
  activity: Pick<BotActivity, 'startedAt'> | null | undefined,
): number | null {
  const raw = activity?.startedAt;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// 当前轮计时的唯一权威入口：Host activity.startedAt（冻结执行轮起点，自动压缩不断线）优先；
// 旧 Host 缺该字段时返回 null，由显示组件在首次观测到忙碌时落锚并在终态清除，禁止回退历史用户轮。
export function resolveActiveActivityStartedAt(
  activity: BotActivity | null | undefined,
): number | null {
  if (!activity || !isBotActivityBusy(activity)) return null;
  return parseBotActivityStartedAt(activity);
}
