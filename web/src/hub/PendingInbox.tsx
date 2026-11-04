// 移动端「待发送」收件箱：合并所有目标设备的 pending 队列与创建/群聊变更 intents，
// 一个列表、无状态筛选、无设备选择。数据面与 desktop PendingPanel 相同
//（pending_list/send/reconcile/cancel + snapshot.state.intents 订阅），呈现层重写为
// 用户语言（不写 requestId/messageId/回执/对账 等术语）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, Inbox, MessageSquare, Users } from 'lucide-react';
import type { PendingRecord } from '../../../host-core/index.js';
import type { DesktopUiIntent } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import type { DevicesDirectoryItem } from '../../../host-core/index.js';
import type { ScopeConversation } from '../gbot-ui';
import type { UnifiedBotItem } from './shared';
import { GrokBotAvatar, resolveBotAvatarPreset } from '../GrokBotAvatar';
import { botAvatarKey } from '../botAvatarSync';
import { errorText, humanizeError, useText } from '../ui';
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
function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const now = new Date();
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days <= 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return '昨天';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], {
    month: 'numeric',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' as const }),
  });
}

export function PendingInbox({ api, identity, transportConnected, devices, bots, rooms, onOpenSettings }: Props): ReactNode {
  const t = useText();
  const [items, setItems] = useState<PendingRecord[]>([]);
  const [intents, setIntents] = useState<DesktopUiIntent[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
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
  useEffect(() => {
    const epoch = ++epochRef.current;
    setItems([]);
    setErrors({});
    if (!api || !identity) return;
    // relay 覆盖目录全部设备；local 只有本机目标。
    const targets: DesktopIdentity[] = identity.kind === 'relay'
      ? devices.map(d => api.identityForTarget(d.deviceId))
      : [identity];
    if (targets.length === 0) return;
    let cancelled = false;
    // shortcut: 每台设备只取前 50 条，队列很长时再加分页
    void Promise.all(targets.map(target =>
      api.pending(target, 'pending_list', { options: { limit: 50, cursor: null } }).catch(() => null),
    )).then(pages => {
      // 旧身份（epoch 已推进）或已卸载的结果直接丢弃，同 PendingPanel.isCurrent。
      if (cancelled || epochRef.current !== epoch) return;
      const merged = pages.flatMap(p => p?.items ?? []);
      merged.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      setItems(merged);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, identityKey, devices]);

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
    return <p className="pending-card-error">{parsed?.title ?? raw}</p>;
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
      ? (bot?.role || t('已删除的智能体', 'Deleted assistant'))
      : (room?.title || t('群聊', 'Group chat'));
    const time = formatWhen(item.updatedAt || item.createdAt);
    const subtitle = deviceName(item.targetDeviceId) + (time ? ' · ' + time : '');

    let statusLine = '';
    let primaryBtn: ReactNode = null;
    let secondaryBtn: ReactNode = null;
    let reason: ReactNode = null;
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
          onClick={() => void run(item, 'pending_cancel')}>
          {t('删除', 'Delete')}
        </button>
      );
    } else if (item.state === 'sending') {
      statusLine = t('正在发送…', 'Sending…');
    } else if (item.state === 'unconfirmed') {
      statusLine = t('可能已经送达，暂时无法确认', 'Probably delivered, unconfirmed');
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
          onClick={() => void run(item, 'pending_reconcile')}>
          {t('检查是否送达', 'Check delivery')}
        </button>
      );
    } else if (item.state === 'rejected') {
      statusLine = t('发送失败', 'Send failed');
      if (item.lastError) {
        const parsed = humanizeError(item.lastError.code + ': ' + item.lastError.outcome, t);
        if (parsed?.title) reason = <p className="pending-card-reason">{parsed.title}</p>;
      }
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
          onClick={() => void run(item, 'pending_reconcile')}>
          {t('再检查一次', 'Check again')}
        </button>
      );
    } else {
      statusLine = t('已送达', 'Delivered');
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
              <span className="pending-card-fallback-icon"><MessageSquare size={22} /></span>
            )
          ) : (
            <span className="pending-card-fallback-icon"><Users size={22} /></span>
          )}
        </div>
        <div className="pending-card-main">
          <div className="pending-card-head">
            <span className="pending-card-title">{title}</span>
            <span className="pending-card-subtitle">{subtitle}</span>
          </div>
          {item.text && <p className="pending-card-text">{item.text}</p>}
          <p className="pending-card-status">{statusLine}</p>
          {reason}
          {(primaryBtn || secondaryBtn) && (
            <div className="pending-card-actions">{primaryBtn}{secondaryBtn}</div>
          )}
          {renderError(item.id)}
        </div>
      </div>
    );
  };

  const renderIntent = (intent: DesktopUiIntent): ReactNode => {
    const anyBusy = busyId !== null;
    const params = intent.params as { role?: string; title?: string; input?: { title?: string } };
    const name =
      intent.method === 'createBot' ? (params.role || t('智能体', 'Assistant'))
      : intent.method === 'deleteScope' ? t('群聊', 'Group chat')
      : (params.title || params.input?.title || t('群聊', 'Group chat'));
    const title =
      intent.method === 'createBot' ? t('创建智能体「' + name + '」', 'Create assistant "' + name + '"')
      : intent.method === 'createScope' ? t('创建群聊「' + name + '」', 'Create group "' + name + '"')
      : intent.method === 'updateScope' ? t('更新群聊「' + name + '」', 'Update group "' + name + '"')
      : t('解散群聊', 'Dissolve group');

    let statusLine = '';
    let primaryBtn: ReactNode = null;
    let hint: ReactNode = null;
    if (intent.outcome === 'unconfirmed') {
      statusLine = t('可能已经完成，暂时无法确认', 'Probably done, unconfirmed');
      if (intent.method === 'createBot') {
        primaryBtn = (
          <button type="button" className="grok-done-pill-btn" disabled={anyBusy || offline}
            onClick={() => void reconcileBotIntent(intent)}>
            {t('检查是否完成', 'Check if done')}
          </button>
        );
      } else {
        hint = <p className="pending-card-hint">{t('请稍后到群聊里确认', 'Please confirm in the group chat later')}</p>;
      }
    } else if (intent.outcome === 'not-sent') {
      statusLine = t('没有发出', 'Not sent');
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy}
          onClick={() => void removeIntent(intent)}>
          {t('移除', 'Remove')}
        </button>
      );
    } else {
      statusLine = t('已完成', 'Done');
      primaryBtn = (
        <button type="button" className="grok-done-pill-btn" disabled={anyBusy}
          onClick={() => void removeIntent(intent)}>
          {t('移除', 'Remove')}
        </button>
      );
    }
    return (
      <div key={intent.id} className="pending-card">
        <div className="pending-card-avatar">
          <span className="pending-card-fallback-icon"><Users size={22} /></span>
        </div>
        <div className="pending-card-main">
          <div className="pending-card-head">
            <span className="pending-card-title">{title}</span>
            <span className="pending-card-subtitle">{deviceName(intent.targetDeviceId)}</span>
          </div>
          <p className="pending-card-status">{statusLine}</p>
          {hint}
          {primaryBtn && <div className="pending-card-actions">{primaryBtn}</div>}
          {renderError(intent.id)}
        </div>
      </div>
    );
  };

  if (!api || isEmpty) {
    return (
      <section className="pending-inbox-empty grok-card-group grok-schedule-empty">
        <Inbox size={36} className="grok-row-icon" />
        <h4>{t('没有待发送的消息', 'Nothing waiting to send')}</h4>
        <p>{api
          ? t('离线时发出的消息会暂存在这里，联网后可以继续发送。',
               'Messages written while offline stay here and can be sent once you are back online.')
          : t('连接中心后，这里会显示没有发出的消息。',
               'Connect to Center and unsent messages will show up here.')}</p>
        {!api && (
          <button type="button" className="grok-done-pill-btn" onClick={onOpenSettings}>
            {t('去设置', 'Open Settings')}
          </button>
        )}
      </section>
    );
  }

  return (
    <div className="pending-inbox">
      {offline && (
        <p className="pending-inbox-offline">
          {t('当前未联网。可以删除消息，联网后才能发送。',
             'You are offline. Messages can be deleted now and sent once you are back online.')}
        </p>
      )}
      {needItems.map(renderRecord)}
      {needIntents.map(renderIntent)}
      {doneCount > 0 && (
        <section className="pending-done">
          <button type="button" className="pending-done-toggle" onClick={() => setDoneOpen(o => !o)}
            aria-expanded={doneOpen}>
            {doneOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            <span>{t('已完成', 'Done')}（{doneCount}）</span>
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
