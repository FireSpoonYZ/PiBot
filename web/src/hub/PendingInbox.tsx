// 移动端「待发送」收件箱：合并所有目标设备的 pending 队列与创建/群聊变更 intents，
// 一个列表、无状态筛选、无设备选择。数据面与 desktop PendingPanel 相同
//（pending_list/send/reconcile/cancel + snapshot.state.intents 订阅），呈现层重写为
// 用户语言（不写 requestId/messageId/回执/对账 等术语）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, Inbox, MessageSquare, Users, Bot } from 'lucide-react';
import type { PendingRecord } from '../../../host-core/index.js';
import type { DesktopUiIntent } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import type { DevicesDirectoryItem } from '../../../host-core/index.js';
import type { ScopeConversation } from '../gbot-ui';
import type { UnifiedBotItem } from './shared';
import { GrokBotAvatar, resolveBotAvatarPreset } from '../GrokBotAvatar';
import { botAvatarKey } from '../botAvatarSync';
import { Button, ConfirmDialog, InlineBanner } from '../components/ui';
import { errorText, humanizeError, splitErrorCode, useText } from '../ui';
import './pending.css';

interface Props {
  api: DesktopPanelApi | null;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  devices: DevicesDirectoryItem[];
  bots: UnifiedBotItem[];
  rooms: ScopeConversation[];
  onOpenSettings(): void;
}

type PendingOp = 'pending_send' | 'pending_reconcile' | 'pending_cancel';

const NEED_STATES = new Set(['pending', 'unconfirmed', 'rejected', 'sending']);

/** 卡片副标题时间：当天时:分、昨天、7 天内星期、其余月/日（沿用 ConversationRow 约定）。 */
function formatWhen(iso: string, yesterday: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const now = new Date();
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return yesterday;
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], {
    month: 'numeric',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' as const }),
  });
}

export function PendingInbox({ api, identity, transportConnected, devices, bots, rooms, onOpenSettings }: Props): ReactNode {
  const text = useText();
  const textRef = useRef(text);
  textRef.current = text;
  const t = useCallback((zh: string, en: string) => textRef.current(zh, en), []);
  const [items, setItems] = useState<PendingRecord[]>([]);
  const [intents, setIntents] = useState<DesktopUiIntent[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [settled, setSettled] = useState<{ api: DesktopPanelApi | null; key: string }>({ api: null, key: '' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PendingRecord | null>(null);
  const epochRef = useRef(0);
  const inFlightRef = useRef(false);

  // 订阅 snapshot.state.intents（同 PendingPanel.componentDidMount）。
  useEffect(() => {
    if (!api) { setIntents([]); return; }
    setIntents(api.snapshot ? api.snapshot.state.intents : []);
    return api.subscribe(() => {
      const snap = api.snapshot;
      setIntents(snap ? snap.state.intents : []);
    });
  }, [api]);

  // 身份变化（profile/kind/device/generation）时清空并按全部目标设备重载。
  const identityKey = identity
    ? [identity.profileId, identity.kind, identity.targetDeviceId, identity.generation].join('|')
    : '';
  const devicesKey = identity?.kind === 'relay' ? devices.map(d => d.deviceId).join(',') : '';
  const fetchKey = api && identity && (identity.kind !== 'relay' || devices.length > 0)
    ? `${identityKey}|${devicesKey}|${reloadTick}`
    : '';
  const loading = Boolean(fetchKey) && (settled.api !== api || settled.key !== fetchKey);
  const retry = useCallback(() => {
    setLoadError('');
    setReloadTick(v => v + 1);
  }, []);

  useEffect(() => {
    const epoch = ++epochRef.current;
    setItems([]);
    setErrors({});
    setLoadError('');
    setDeleteTarget(null);
    if (!api || !identity || !fetchKey) {
      setSettled({ api, key: fetchKey });
      return;
    }
    // relay 覆盖目录全部设备；local 只有本机目标。
    const targets: DesktopIdentity[] = identity.kind === 'relay'
      ? devices.map(d => api.identityForTarget(d.deviceId))
      : [identity];
    if (targets.length === 0) {
      setSettled({ api, key: fetchKey });
      return;
    }
    let cancelled = false;
    // shortcut: 每台设备只取前 50 条，队列很长时再加分页
    void Promise.allSettled(targets.map(target =>
      Promise.resolve().then(() => api.pending(target, 'pending_list', { options: { limit: 50, cursor: null } })),
    )).then(results => {
      // 旧身份（epoch 已推进）或已卸载的结果直接丢弃，同 PendingPanel.isCurrent。
      if (cancelled || epochRef.current !== epoch) return;
      const merged: PendingRecord[] = [];
      const failures: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          merged.push(...(result.value?.items ?? []));
        } else {
          const reason = result.reason;
          let msg = '';
          if (reason instanceof Error && reason.message) {
            msg = reason.message;
          } else if (typeof reason === 'string' && reason.trim()) {
            msg = reason.trim();
          } else if (typeof reason === 'object' && reason !== null) {
            const parsed = splitErrorCode(reason);
            msg = parsed.code && parsed.message ? `${parsed.code}: ${parsed.message}` : (parsed.message || parsed.code || '');
          }
          failures.push(msg || t('加载待发送消息失败', 'Failed to load pending messages'));
        }
      }
      merged.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      setItems(merged);
      setLoadError(failures.length > 0 ? failures[0] : '');
      setSettled({ api, key: fetchKey });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, fetchKey]);

  /** 每条记录用它自己的 targetDeviceId 对应 identity 执行操作。 */
  const identityForRecord = useCallback((record: { targetDeviceId: string }): DesktopIdentity | null => {
    if (!api || !identity) return null;
    return identity.kind === 'relay' ? api.identityForTarget(record.targetDeviceId) : identity;
  }, [api, identity]);

  const run = useCallback(async (record: PendingRecord, op: PendingOp): Promise<void> => {
    const target = identityForRecord(record);
    if (!api || !target || inFlightRef.current) return;
    const epoch = epochRef.current;
    inFlightRef.current = true;
    setBusyId(record.id);
    setErrors(prev => { const next = { ...prev }; delete next[record.id]; return next; });
    try {
      const updated = await api.pending(target, op, { id: record.id });
      if (epochRef.current !== epoch) return;
      setItems(prev => prev.map(it => (it.id === record.id ? updated : it)));
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setErrors(prev => ({ ...prev, [record.id]: errorText(e) }));
    } finally {
      inFlightRef.current = false;
      setBusyId(null);
    }
  }, [api, identityForRecord]);

  // 照搬 PendingPanel.reconcileBotIntent：findByRequest 只读查询，查到才写 responded。
  const reconcileBotIntent = useCallback(async (intent: DesktopUiIntent): Promise<void> => {
    const target = identityForRecord(intent);
    if (!api || !target || inFlightRef.current || !transportConnected) return;
    const epoch = epochRef.current;
    inFlightRef.current = true;
    setBusyId(intent.id);
    setErrors(prev => { const next = { ...prev }; delete next[intent.id]; return next; });
    try {
      const params = intent.params as { requestId: string };
      const bot = await api.call(target, 'findByRequest', { requestId: params.requestId });
      if (epochRef.current !== epoch) return;
      if (bot) await api.updateIntent(intent.id, { outcome: 'responded', result: bot });
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setErrors(prev => ({ ...prev, [intent.id]: errorText(e) }));
    } finally {
      inFlightRef.current = false;
      setBusyId(null);
    }
  }, [api, identityForRecord, transportConnected]);

  const removeIntent = useCallback(async (intent: DesktopUiIntent): Promise<void> => {
    if (!api || inFlightRef.current) return;
    const epoch = epochRef.current;
    inFlightRef.current = true;
    setBusyId(intent.id);
    setErrors(prev => { const next = { ...prev }; delete next[intent.id]; return next; });
    try {
      await api.deleteIntent(intent.id);
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setErrors(prev => ({ ...prev, [intent.id]: errorText(e) }));
    } finally {
      inFlightRef.current = false;
      setBusyId(null);
    }
  }, [api]);

  const deviceName = useCallback((deviceId: string): string => {
    return devices.find(d => d.deviceId === deviceId)?.displayName || t('本机', 'Local');
  }, [devices, t]);

  const offline = !transportConnected;
  const needIntents = intents.filter(i => i.outcome !== 'responded');
  const doneIntents = intents.filter(i => i.outcome === 'responded');
  const needItems = items.filter(i => NEED_STATES.has(i.state));
  const doneItems = items.filter(i => i.state === 'accepted');
  const doneCount = doneItems.length + doneIntents.length;
  const isEmpty = needItems.length === 0 && needIntents.length === 0 && doneCount === 0;

  const renderError = (id: string): ReactNode => {
    const raw = errors[id];
    if (!raw) return null;
    const parsed = humanizeError(raw, t);
    return <p className="pending-card-error" role="alert">{parsed?.title ?? raw}</p>;
  };

  const renderRecord = (item: PendingRecord): ReactNode => {
    const anyBusy = busyId !== null;
    const bot = item.kind === 'primary'
      ? bots.find(b => b.deviceId === item.targetDeviceId && b.botId === item.botId)
      : undefined;
    const room = item.kind === 'room'
      ? rooms.find(r => r.scope.scope.scopeId === item.scopeId)
      : undefined;
    const title = item.kind === 'primary'
      ? (bot?.role || t('已删除的 Bot', 'Deleted Bot'))
      : (room?.title || t('群聊', 'Group chat'));
    const time = formatWhen(item.updatedAt || item.createdAt, t('昨天', 'Yesterday'));
    const subtitle = deviceName(item.targetDeviceId) + (time ? ' · ' + time : '');

    let statusLine = '';
    let primaryBtn: ReactNode = null;
    let secondaryBtn: ReactNode = null;
    let tone: 'todo' | 'warn' | 'error' | 'ok' = 'todo';
    if (item.state === 'pending') {
      statusLine = t('还没发出', 'Not sent yet');
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
          onClick={() => void run(item, 'pending_send')}>
          {t('发送', 'Send')}
        </button>
      );
      secondaryBtn = (
        <button type="button" className="hub-outline-btn" disabled={anyBusy}
          onClick={() => setDeleteTarget(item)}>
          {t('删除', 'Delete')}
        </button>
      );
    } else if (item.state === 'sending') {
      statusLine = t('正在发送…', 'Sending…');
      tone = 'warn';
    } else if (item.state === 'unconfirmed') {
      statusLine = t('可能已送达，待确认', 'Maybe delivered');
      tone = 'warn';
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
          onClick={() => void run(item, 'pending_reconcile')}>
          {t('检查是否送达', 'Check delivery')}
        </button>
      );
    } else if (item.state === 'rejected') {
      tone = 'error';
      const parsed = item.lastError ? humanizeError(item.lastError.code + ': ' + item.lastError.outcome, t) : null;
      statusLine = parsed?.title ? t('发送失败：', 'Failed: ') + parsed.title : t('发送失败', 'Send failed');
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
          onClick={() => void run(item, 'pending_reconcile')}>
          {t('再检查一次', 'Check again')}
        </button>
      );
    } else {
      statusLine = t('已送达', 'Delivered');
      tone = 'ok';
    }

    return (
      <div key={item.id} className="pending-card">
        <div className="pending-card-avatar">
          {item.kind === 'primary' ? (
            bot ? (
              <GrokBotAvatar
                preset={resolveBotAvatarPreset(botAvatarKey(bot), bot.role, bot.isPrimary)}
                roleName={bot.role}
                isPrimary={bot.isPrimary}
                size={44}
              />
            ) : (
              <span className="pending-card-fallback-icon" aria-hidden="true"><MessageSquare size={22} /></span>
            )
          ) : (
            <span className="pending-card-fallback-icon" aria-hidden="true"><Users size={22} /></span>
          )}
        </div>
        <div className="pending-card-main">
          <div className="pending-card-head">
            <span className="pending-card-title">{title}</span>
            <span className="pending-card-subtitle tabular-nums">{subtitle}</span>
          </div>
          {item.text && <p className="pending-card-text">{item.text}</p>}
          <div className="pending-card-foot">
            <span className={'pending-card-status is-' + tone} role={tone === 'error' ? 'alert' : 'status'}>{statusLine}</span>
            {(primaryBtn || secondaryBtn) && <div className="pending-card-actions">{secondaryBtn}{primaryBtn}</div>}
          </div>
          {renderError(item.id)}
        </div>
      </div>
    );
  };

  const renderIntent = (intent: DesktopUiIntent): ReactNode => {
    const anyBusy = busyId !== null;
    const params = intent.params as { role?: string; title?: string; input?: { title?: string } };
    const name =
      intent.method === 'createBot' ? (params.role || t('Bot', 'Bot'))
      : intent.method === 'deleteScope' ? t('群聊', 'Group chat')
      : (params.title || params.input?.title || t('群聊', 'Group chat'));
    const title =
      intent.method === 'createBot' ? t('创建 Bot「' + name + '」', 'Create Bot "' + name + '"')
      : intent.method === 'createScope' ? t('创建群聊「' + name + '」', 'Create group "' + name + '"')
      : intent.method === 'updateScope' ? t('更新群聊「' + name + '」', 'Update group "' + name + '"')
      : t('解散群聊', 'Dissolve group');

    let statusLine = '';
    let primaryBtn: ReactNode = null;
    let hint: ReactNode = null;
    if (intent.outcome === 'unconfirmed') {
      statusLine = t('可能已完成，待确认', 'Maybe done');
      if (intent.method === 'createBot') {
        primaryBtn = (
          <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
            onClick={() => void reconcileBotIntent(intent)}>
            {t('检查是否完成', 'Check if done')}
          </button>
        );
      } else {
        hint = <span className="pending-card-hint">{t('稍后到群聊里看看', 'Check the group later')}</span>;
      }
    } else if (intent.outcome === 'not-sent') {
      statusLine = t('没有发出', 'Not sent');
      primaryBtn = (
        <button type="button" className="hub-outline-btn" disabled={anyBusy}
          onClick={() => void removeIntent(intent)}>
          {t('移除', 'Remove')}
        </button>
      );
    } else {
      statusLine = t('已完成', 'Done');
      primaryBtn = (
        <button type="button" className="hub-outline-btn" disabled={anyBusy}
          onClick={() => void removeIntent(intent)}>
          {t('移除', 'Remove')}
        </button>
      );
    }
    return (
      <div key={intent.id} className="pending-card">
        <div className="pending-card-avatar">
          <span className="pending-card-fallback-icon" aria-hidden="true">{intent.method === 'createBot' ? <Bot size={22} /> : <Users size={22} />}</span>
        </div>
        <div className="pending-card-main">
          <div className="pending-card-head">
            <span className="pending-card-title">{title}</span>
            <span className="pending-card-subtitle">{deviceName(intent.targetDeviceId)}</span>
          </div>
          <div className="pending-card-foot">
            <span
              className={'pending-card-status is-' + (intent.outcome === 'responded' ? 'ok' : intent.outcome === 'unconfirmed' ? 'warn' : 'error')}
              role={intent.outcome === 'not-sent' ? 'alert' : 'status'}
            >
              {statusLine}
            </span>
            {hint}
            {primaryBtn && <div className="pending-card-actions">{primaryBtn}</div>}
          </div>
          {renderError(intent.id)}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div
        className="pending-inbox"
        role="status"
        aria-busy="true"
        aria-label={t('正在加载待发送消息…', 'Loading pending messages…')}
      >
        {[0, 1, 2].map(idx => (
          <div key={idx} className="pending-card is-skeleton" aria-hidden="true">
            <div className="pending-card-avatar">
              <span className="pending-skeleton-avatar" />
            </div>
            <div className="pending-card-main">
              <span className="pending-skeleton-line is-title" />
              <span className="pending-skeleton-line is-body" />
              <span className="pending-skeleton-line is-foot" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (api && loadError && isEmpty) {
    const parsedLoadError = humanizeError(loadError, t);
    return (
      <div className="pending-inbox">
        <InlineBanner
          tone="danger"
          role="alert"
          title={t('加载待发送消息失败', 'Failed to load pending messages')}
          detail={parsedLoadError?.title ?? loadError}
          actions={
            <Button variant="secondary" size="sm" onClick={retry}>
              {t('重试', 'Retry')}
            </Button>
          }
        />
      </div>
    );
  }

  if (!api || isEmpty) {
    return (
      <section className="pending-inbox-empty grok-card-group grok-schedule-empty" role="status">
        <Inbox size={36} className="grok-row-icon" aria-hidden="true" />
        <h4>{t('没有待发送的消息', 'Nothing waiting to send')}</h4>
        <p>{api
          ? t('离线时发出的消息会暂存在这里，联网后可以继续发送。', 'Messages written while offline stay here and can be sent once you are back online.')
          : t('连接中心后，这里会显示没有发出的消息。', 'Connect to Center and unsent messages will show up here.')}</p>
        {!api && (
          <button type="button" className="grok-done-pill-btn" onClick={onOpenSettings}>
            {t('去设置', 'Open Settings')}
          </button>
        )}
      </section>
    );
  }

  const parsedLoadError = loadError ? humanizeError(loadError, t) : null;
  const activeDeleteTarget = deleteTarget
    ? needItems.find(it => it.id === deleteTarget.id && it.state === 'pending') ?? null
    : null;
  const deletePreview = (() => {
    const raw = activeDeleteTarget?.text?.trim().replace(/\s+/g, ' ') ?? '';
    if (!raw) return '';
    const chars = Array.from(raw);
    return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : raw;
  })();

  return (
    <div className="pending-inbox">
      {loadError && (
        <InlineBanner
          tone="danger"
          role="alert"
          compact
          title={t('部分待发送消息加载失败', 'Some pending messages failed to load')}
          detail={parsedLoadError?.title ?? loadError}
          actions={
            <Button variant="secondary" size="sm" onClick={retry}>
              {t('重试', 'Retry')}
            </Button>
          }
        />
      )}
      {offline && (
        <InlineBanner
          tone="attention"
          role="status"
          compact
          title={t('当前未联网', 'Offline')}
          detail={t('可以删除消息，联网后才能发送。', 'Messages can be deleted now and sent once you are back online.')}
        />
      )}
      {needItems.map(renderRecord)}
      {needIntents.map(renderIntent)}
      {doneCount > 0 && (
        <section className="pending-done">
          <button type="button" className="pending-done-toggle" onClick={() => setDoneOpen(o => !o)}
            aria-expanded={doneOpen}>
            {doneOpen ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
            <span>{t(`已完成（${doneCount}）`, `Done (${doneCount})`)}</span>
          </button>
          {doneOpen && (
            <>
              {doneItems.map(renderRecord)}
              {doneIntents.map(renderIntent)}
            </>
          )}
        </section>
      )}
      <ConfirmDialog
        open={activeDeleteTarget !== null}
        title={t('删除待发送消息？', 'Delete pending message?')}
        description={
          deletePreview
            ? t(`确定要删除「${deletePreview}」吗？删除后不会发送且无法恢复。`, `Delete "${deletePreview}"? It will not be sent and cannot be undone.`)
            : t('确定要删除这条未发出的消息吗？删除后不会发送且无法恢复。', 'Delete this unsent message? It will not be sent and cannot be undone.')
        }
        danger
        busy={busyId !== null}
        confirmLabel={t('删除', 'Delete')}
        cancelLabel={t('取消', 'Cancel')}
        onCancel={() => {
          if (busyId === null) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (!activeDeleteTarget || busyId !== null) return;
          const target = activeDeleteTarget;
          setDeleteTarget(null);
          void run(target, 'pending_cancel');
        }}
      />
    </div>
  );
}
