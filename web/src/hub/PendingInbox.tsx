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
import { ActionBar, Button, EmptyState } from '../components/ui';
import { ErrorNotice, errorText, humanizeError, splitErrorCode, useText } from '../ui';
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
  const [busyAction, setBusyAction] = useState<{ id: string; op: string } | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
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
    setBusyAction({ id: record.id, op });
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
      setBusyAction(null);
    }
  }, [api, identityForRecord]);

  // 照搬 PendingPanel.reconcileBotIntent：findByRequest 只读查询，查到才写 responded。
  const reconcileBotIntent = useCallback(async (intent: DesktopUiIntent): Promise<void> => {
    const target = identityForRecord(intent);
    if (!api || !target || inFlightRef.current || !transportConnected) return;
    const epoch = epochRef.current;
    inFlightRef.current = true;
    setBusyAction({ id: intent.id, op: 'reconcile_intent' });
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
      setBusyAction(null);
    }
  }, [api, identityForRecord, transportConnected]);

  const removeIntent = useCallback(async (intent: DesktopUiIntent): Promise<void> => {
    if (!api || inFlightRef.current) return;
    const epoch = epochRef.current;
    inFlightRef.current = true;
    setBusyAction({ id: intent.id, op: 'remove_intent' });
    setErrors(prev => { const next = { ...prev }; delete next[intent.id]; return next; });
    try {
      await api.deleteIntent(intent.id);
    } catch (e) {
      if (epochRef.current !== epoch) return;
      setErrors(prev => ({ ...prev, [intent.id]: errorText(e) }));
    } finally {
      inFlightRef.current = false;
      setBusyAction(null);
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
    const message = parsed?.title
      ? (parsed.description && parsed.description !== parsed.title ? `${parsed.title} · ${parsed.description}` : parsed.title)
      : raw;
    return <p className="pending-card-error" role="alert">{message}</p>;
  };

  const renderRecord = (item: PendingRecord): ReactNode => {
    const anyBusy = busyAction !== null;
    const isBusyOp = (op: PendingOp) => busyAction?.id === item.id && busyAction.op === op;
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
          aria-busy={isBusyOp('pending_send') || undefined}
          onClick={() => void run(item, 'pending_send')}>
          {isBusyOp('pending_send') ? t('发送中…', 'Sending…') : t('发送消息', 'Send message')}
        </button>
      );
      secondaryBtn = (
        <button type="button" className="hub-outline-btn" disabled={anyBusy}
          aria-busy={isBusyOp('pending_cancel') || undefined}
          onClick={() => void run(item, 'pending_cancel')}>
          {isBusyOp('pending_cancel') ? t('删除中…', 'Deleting…') : t('删除消息', 'Delete message')}
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
          aria-busy={isBusyOp('pending_reconcile') || undefined}
          onClick={() => void run(item, 'pending_reconcile')}>
          {isBusyOp('pending_reconcile') ? t('检查中…', 'Checking…') : t('检查送达状态', 'Check delivery')}
        </button>
      );
    } else if (item.state === 'rejected') {
      tone = 'error';
      const parsed = item.lastError ? humanizeError(item.lastError.code + ': ' + item.lastError.outcome, t) : null;
      statusLine = parsed?.title ? t('发送失败：', 'Failed: ') + parsed.title : t('发送失败', 'Send failed');
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
          aria-busy={isBusyOp('pending_reconcile') || undefined}
          onClick={() => void run(item, 'pending_reconcile')}>
          {isBusyOp('pending_reconcile') ? t('检查中…', 'Checking…') : t('重新检查送达', 'Recheck delivery')}
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
            <span className="pending-card-subtitle">{subtitle}</span>
          </div>
          {item.text && <p className="pending-card-text">{item.text}</p>}
          <div className="pending-card-foot">
            <span className={'pending-card-status is-' + tone}>{statusLine}</span>
            {(primaryBtn || secondaryBtn) && (
              <ActionBar align="end" className="pending-card-actions">
                {secondaryBtn}
                {primaryBtn}
              </ActionBar>
            )}
          </div>
          {renderError(item.id)}
        </div>
      </div>
    );
  };

  const renderIntent = (intent: DesktopUiIntent): ReactNode => {
    const anyBusy = busyAction !== null;
    const isReconciling = busyAction?.id === intent.id && busyAction.op === 'reconcile_intent';
    const isRemoving = busyAction?.id === intent.id && busyAction.op === 'remove_intent';
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
            aria-busy={isReconciling || undefined}
            onClick={() => void reconcileBotIntent(intent)}>
            {isReconciling ? t('检查中…', 'Checking…') : t('检查创建状态', 'Check status')}
          </button>
        );
      } else {
        hint = <span className="pending-card-hint">{t('稍后到群聊里看看', 'Check the group later')}</span>;
      }
    } else if (intent.outcome === 'not-sent') {
      statusLine = t('没有发出', 'Not sent');
      primaryBtn = (
        <button type="button" className="hub-outline-btn" disabled={anyBusy}
          aria-busy={isRemoving || undefined}
          onClick={() => void removeIntent(intent)}>
          {isRemoving ? t('移除中…', 'Removing…') : t('移除记录', 'Remove record')}
        </button>
      );
    } else {
      statusLine = t('已完成', 'Done');
      primaryBtn = (
        <button type="button" className="hub-outline-btn" disabled={anyBusy}
          aria-busy={isRemoving || undefined}
          onClick={() => void removeIntent(intent)}>
          {isRemoving ? t('移除中…', 'Removing…') : t('移除记录', 'Remove record')}
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
            <span className={'pending-card-status is-' + (intent.outcome === 'responded' ? 'ok' : intent.outcome === 'unconfirmed' ? 'warn' : 'error')}>{statusLine}</span>
            {hint}
            {primaryBtn && (
              <ActionBar align="end" className="pending-card-actions">
                {primaryBtn}
              </ActionBar>
            )}
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
        aria-label={t('正在加载待发送消息', 'Loading pending messages')}
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
    return (
      <div className="pending-inbox">
        <ErrorNotice
          error={loadError}
          actionLabel={t('重新加载', 'Reload list')}
          onAction={retry}
          secondaryActionLabel={t('检查连接设置', 'Check settings')}
          onSecondaryAction={onOpenSettings}
        />
      </div>
    );
  }

  if (!api) {
    return (
      <EmptyState
        className="pending-inbox-empty"
        icon={<Inbox aria-hidden="true" />}
        title={t('尚未连接中心', 'Not connected to Center')}
        description={t('连接中心后，离线暂存或待确认的消息会显示在这里。', 'Connect to Center to view and manage offline or unconfirmed messages here.')}
        actionLabel={t('前往连接设置', 'Open connection settings')}
        onAction={onOpenSettings}
      />
    );
  }

  if (isEmpty) {
    return (
      <EmptyState
        className="pending-inbox-empty"
        icon={<Inbox aria-hidden="true" />}
        title={t('没有待发送的消息', 'Nothing waiting to send')}
        description={offline
          ? t('当前未联网，新发出的消息会暂存在这里，恢复联网后可立即发送。', 'You are currently offline. New messages will queue here until you reconnect.')
          : t('所有消息都已处理，离线时暂存的消息会显示在这里。', 'All messages are caught up. Messages queued while offline will appear here.')}
        action={offline ? undefined : (
          <Button variant="secondary" size="sm" onClick={retry}>
            {t('刷新列表', 'Refresh list')}
          </Button>
        )}
      />
    );
  }

  return (
    <div className="pending-inbox">
      {loadError ? (
        <ErrorNotice
          error={loadError}
          actionLabel={t('重新加载', 'Reload list')}
          onAction={retry}
          secondaryActionLabel={offline ? t('检查连接设置', 'Check settings') : undefined}
          onSecondaryAction={offline ? onOpenSettings : undefined}
          onDismiss={() => setLoadError('')}
          compact
        />
      ) : offline ? (
        <p className="pending-inbox-offline" role="status">
          {t('当前未联网。可以删除暂存消息，恢复联网后即可发送。', 'You are offline. Queued messages can be deleted now and sent once you reconnect.')}
        </p>
      ) : null}
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
    </div>
  );
}
