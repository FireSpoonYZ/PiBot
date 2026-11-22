// 发送记录从当前档案的本机账本读取。发送、核对与取消仍绑定原记录和设备。
import { Component, createRef, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Inbox } from 'lucide-react';
import type { PendingCursor, PendingListPage, PendingRecord, PendingState } from '../../../host-core/index.js';
import type { DesktopUiIntent } from '../../../host-core/desktop-client.js';
import { Button, InlineBanner } from '../../../web/src/components/ui';
import { useText } from '../../../web/src/ui';
import type { SendRecordsTarget } from './BotChats';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';
import './PendingPanel.css';

type RecordsView = 'attention' | 'history';
type Cursors = Partial<Record<PendingState, PendingCursor | null>>;
type TextFn = (zh: string, en: string) => string;

export interface PendingPanelProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  target?: SendRecordsTarget;
  onClearTarget(): void;
  conversationName?: (target: SendRecordsTarget) => string | undefined;
  onOpenConversation?: (target: SendRecordsTarget) => void;
}

interface InnerProps extends PendingPanelProps {
  t: TextFn;
}

interface State {
  view: RecordsView;
  items: PendingRecord[];
  cursors: Cursors;
  focused: PendingRecord | null | undefined;
  intents: DesktopUiIntent[];
  error: string | null;
  notice: string | null;
  loading: boolean;
  busyId: string | null;
  receiptsOpen: boolean;
}

const VIEW_STATES: Record<RecordsView, readonly PendingState[]> = {
  attention: ['pending', 'sending', 'unconfirmed'],
  history: ['accepted', 'rejected'],
};

function intentLabel(method: DesktopUiIntent['method'], t: TextFn): string {
  switch (method) {
    case 'createBot': return t('创建智能体', 'Create Bot');
    case 'createScope': return t('创建群聊', 'Create group');
    case 'updateScope': return t('更新群聊', 'Update group');
    case 'deleteScope': return t('解散群聊', 'Dissolve group');
  }
}

function isCancelled(item: PendingRecord): boolean {
  return item.state === 'rejected' && item.receipt === null &&
    item.lastError?.code === 'CANCELLED' && item.lastError.outcome === 'not-sent';
}

function canSendRecord(item: PendingRecord): boolean {
  return item.state === 'pending' || (
    item.state === 'rejected' && !isCancelled(item) && item.lastError?.code !== 'REQUEST_CONFLICT' &&
    (item.lastError?.outcome === 'not-sent' || item.lastError?.outcome === 'responded')
  );
}

function recordStatus(item: PendingRecord, t: TextFn): string {
  switch (item.state) {
    case 'pending': return item.lastError?.outcome === 'not-sent' ? t('还没发出', 'Not sent yet') : t('等待发送', 'Waiting to send');
    case 'sending': return t('正在发送…', 'Sending…');
    case 'unconfirmed': return t('可能已送达，待确认', 'Maybe delivered');
    case 'accepted': return t('已送达', 'Delivered');
    case 'rejected': return isCancelled(item) ? t('已取消', 'Cancelled') : t('发送失败', 'Send failed');
  }
}

function recordTarget(item: PendingRecord): SendRecordsTarget {
  return item.kind === 'primary'
    ? { deviceId: item.targetDeviceId, recordId: item.id, botId: item.botId }
    : { deviceId: item.targetDeviceId, recordId: item.id, scopeId: item.scopeId };
}

function TechDetails({ rows, raw, t }: { rows: string[]; raw?: unknown; t: TextFn }) {
  if (rows.length === 0 && raw == null) return null;
  return (
    <details className="pending-tech">
      <summary>
        <ChevronRight size={13} className="pending-tech-chevron" aria-hidden="true" />
        <span>{t('技术详情', 'Technical details')}</span>
      </summary>
      <div className="pending-tech-body">
        {rows.map((row, index) => (
          <span key={`${index}:${row}`} className="pending-mono">
            {row}
          </span>
        ))}
        {raw != null && (
          <div className="pending-raw-block">
            <span className="pending-raw-label">{t('原始回执', 'Raw receipt')}</span>
            <pre className="pending-raw-content">{JSON.stringify(raw, null, 2)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function RecordRow({
  title,
  status,
  statusClass,
  statusRole,
  createdAt,
  preview,
  action,
  extraActions,
  details,
  raw,
  t,
}: {
  title: string;
  status: string;
  statusClass: string;
  statusRole: 'alert' | 'status';
  createdAt?: string;
  preview?: ReactNode;
  action?: ReactNode;
  extraActions?: ReactNode;
  details: string[];
  raw?: unknown;
  t: TextFn;
}) {
  const created = createdAt ? new Date(createdAt) : null;
  const hasActions = Boolean(action || extraActions);
  return (
    <article className="pending-record">
      <div className="pending-record-head">
        <strong className="pending-record-title">{title}</strong>
        {created && !Number.isNaN(created.getTime()) && (
          <time className="pending-record-time tabular-nums" dateTime={createdAt}>
            {created.toLocaleString()}
          </time>
        )}
      </div>
      {preview && <p className="pending-text">{preview}</p>}
      <div className="pending-record-foot">
        <span className={'pending-record-status ' + statusClass} role={statusRole}>
          {status}
        </span>
        {hasActions && (
          <div className="pending-record-actions">
            {extraActions}
            {action}
          </div>
        )}
      </div>
      <TechDetails rows={details} raw={raw} t={t} />
    </article>
  );
}

class PendingPanelInner extends Component<InnerProps, State> {
  state: State = {
    view: 'attention',
    items: [],
    cursors: {},
    focused: undefined,
    intents: [],
    error: null,
    notice: null,
    loading: true,
    busyId: null,
    receiptsOpen: false,
  };

  private unsub?: () => void;
  private unsubPending?: () => void;
  private mounted = false;
  private inFlight = false;
  private identityEpoch = 0;
  private loadEpoch = 0;
  private focusEpoch = 0;
  private loadedPages = 1;
  private bodyRef = createRef<HTMLDivElement>();

  private isCurrent(identity: DesktopIdentity, epoch: number): boolean {
    const current = this.props.identity;
    return this.mounted && this.identityEpoch === epoch && !!current &&
      current.profileId === identity.profileId && current.targetDeviceId === identity.targetDeviceId &&
      current.kind === identity.kind && current.generation === identity.generation;
  }

  componentDidMount(): void {
    this.mounted = true;
    const readIntents = () => {
      if (this.mounted) this.setState({ intents: this.props.api.snapshot?.state.intents ?? [] });
    };
    this.unsub = this.props.api.subscribe(readIntents);
    this.unsubPending = this.props.api.subscribePending(() => {
      if (!this.mounted || this.inFlight) return;
      void this.load(false, this.loadedPages);
      void this.loadFocused();
    });
    readIntents();
    void this.load();
    void this.loadFocused();
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.unsub?.();
    this.unsubPending?.();
  }

  componentDidUpdate(prev: InnerProps): void {
    const a = prev.identity;
    const b = this.props.identity;
    const sameDevice = a?.profileId === b?.profileId && a?.kind === b?.kind && a?.targetDeviceId === b?.targetDeviceId;
    if (!sameDevice || prev.target !== this.props.target) {
      this.identityEpoch += 1;
      this.loadedPages = 1;
      this.setState(
        { view: 'attention', items: [], cursors: {}, focused: undefined, busyId: null, notice: null, receiptsOpen: false },
        () => {
          void this.load();
          void this.loadFocused();
        },
      );
    } else if (a?.generation !== b?.generation || (!prev.transportConnected && this.props.transportConnected)) {
      // 同一账本换代时保留已加载页和视口，旧代回执仍作废。
      if (a?.generation !== b?.generation) {
        this.identityEpoch += 1;
        this.setState({ busyId: null });
      }
      void this.load(false, this.loadedPages);
      void this.loadFocused();
    }
  }

  private async load(more = false, pages = 1): Promise<void> {
    const { identity, api } = this.props;
    if (!identity) return;
    const epoch = this.identityEpoch;
    const loadEpoch = ++this.loadEpoch;
    const { view, cursors } = this.state;
    const current = () => this.isCurrent(identity, epoch) && loadEpoch === this.loadEpoch && this.state.view === view;
    this.setState({ loading: true, error: null });
    try {
      const batches = await Promise.all(VIEW_STATES[view].map(async (state) => {
        const items: PendingRecord[] = [];
        let cursor = more ? cursors[state] ?? null : null;
        for (let i = 0; i < pages; i += 1) {
          if (more && !cursor) break;
          const page: PendingListPage = await api.pending(identity, 'pending_list', { options: { state, limit: 50, cursor } });
          if (!current()) return null;
          items.push(...page.items);
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        return { state, items, cursor };
      }));
      if (!current()) return;
      const nextCursors: Cursors = {};
      const incoming: PendingRecord[] = [];
      for (const batch of batches) {
        if (!batch) continue;
        nextCursors[batch.state] = batch.cursor;
        incoming.push(...batch.items);
      }
      this.loadedPages = more ? this.loadedPages + 1 : pages;
      this.setState((state) => {
        const merged = new Map((more ? state.items : []).map((item) => [item.id, item]));
        for (const item of incoming) merged.set(item.id, item);
        return {
          items: Array.from(merged.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          cursors: nextCursors,
        };
      });
    } catch (error) {
      if (current()) this.setState({ error: toError(error).message });
    } finally {
      if (current()) this.setState({ loading: false });
    }
  }

  private async loadFocused(): Promise<void> {
    const { api, identity, target } = this.props;
    if (!identity || !target?.recordId) return;
    const epoch = this.identityEpoch;
    const read = ++this.focusEpoch;
    const current = () => this.isCurrent(identity, epoch) && read === this.focusEpoch && this.props.target === target;
    try {
      const item = await api.pending(identity, 'pending_get', { id: target.recordId });
      if (current()) this.setState({ focused: item && this.matchesConversation(item) ? item : null });
    } catch (error) {
      if (current()) this.setState({ focused: null, error: toError(error).message });
    }
  }

  private matchesConversation(item: PendingRecord): boolean {
    const target = this.props.target;
    if (target?.botId) return item.kind === 'primary' && item.botId === target.botId;
    if (target?.scopeId) return item.kind === 'room' && item.scopeId === target.scopeId;
    return true;
  }

  private applyRecord(item: PendingRecord): void {
    if (this.props.target?.recordId === item.id) this.focusEpoch += 1;
    this.setState((state) => ({
      items: state.items.map((old) => old.id === item.id ? item : old),
      focused: this.props.target?.recordId === item.id ? item : state.focused,
      notice: recordStatus(item, this.props.t),
    }));
  }

  private async run(item: PendingRecord, op: 'pending_send' | 'pending_reconcile' | 'pending_cancel'): Promise<void> {
    const { identity, api, transportConnected, t } = this.props;
    if (!identity || this.inFlight || (op !== 'pending_cancel' && !transportConnected)) return;
    const epoch = this.identityEpoch;
    this.inFlight = true;
    let refresh = true;
    this.setState({ busyId: item.id, error: null, notice: null });
    try {
      if (op === 'pending_send') {
        const latest = await api.pending(identity, 'pending_get', { id: item.id });
        if (!this.isCurrent(identity, epoch) || !this.props.transportConnected) return;
        if (!latest) {
          this.setState({ notice: t('该记录已不可用。', 'This record is no longer available.') });
          return;
        }
        if (!canSendRecord(latest)) {
          this.applyRecord(latest);
          return;
        }
      }
      const updated = await api.pending(identity, op, { id: item.id });
      if (this.isCurrent(identity, epoch)) this.applyRecord(updated);
    } catch (error) {
      if (this.isCurrent(identity, epoch)) {
        refresh = false;
        this.setState({ error: toError(error).message });
      }
    } finally {
      this.inFlight = false;
      if (this.isCurrent(identity, epoch)) this.setState({ busyId: null });
      if (this.mounted && refresh) void this.load(false, this.loadedPages);
    }
  }

  private async reconcileBotIntent(intent: DesktopUiIntent): Promise<void> {
    const { identity, api, transportConnected, t } = this.props;
    if (!identity || this.inFlight || !transportConnected || intent.method !== 'createBot' ||
        intent.outcome !== 'unconfirmed' || intent.profileId !== identity.profileId ||
        intent.targetDeviceId !== identity.targetDeviceId) return;
    const epoch = this.identityEpoch;
    this.inFlight = true;
    this.setState({ busyId: intent.id, error: null, notice: null });
    try {
      const { requestId } = intent.params as { requestId: string };
      const bot = await api.call(identity, 'findByRequest', { requestId });
      if (!this.isCurrent(identity, epoch)) return;
      if (bot) await api.updateIntent(intent.id, { outcome: 'responded', result: bot, error: undefined });
      if (this.isCurrent(identity, epoch)) {
        this.setState({
          notice: bot
            ? t('已找到创建结果。', 'Creation result confirmed.')
            : t('暂时无法确认创建结果。', 'Could not confirm creation result yet.'),
        });
      }
    } catch (error) {
      if (this.isCurrent(identity, epoch)) this.setState({ error: toError(error).message });
    } finally {
      this.inFlight = false;
      if (this.isCurrent(identity, epoch)) this.setState({ busyId: null });
    }
  }

  private renderItem(item: PendingRecord): ReactNode {
    const { conversationName, onOpenConversation, transportConnected, t } = this.props;
    const target = recordTarget(item);
    const name = conversationName?.(target);
    const busy = this.state.busyId !== null;
    const cancelled = isCancelled(item);
    const canCheck = item.state === 'unconfirmed' || item.state === 'sending';
    const canSend = canSendRecord(item);
    const canCancel = item.state === 'pending';
    const canOpen = Boolean(name && onOpenConversation);
    const action = canCheck ? (
      <button
        type="button"
        className="primary-button pending-primary-action"
        onClick={() => void this.run(item, 'pending_reconcile')}
        disabled={busy || !transportConnected}
      >
        {t('核对结果', 'Check delivery')}
      </button>
    ) : canSend ? (
      <button
        type="button"
        className="primary-button pending-primary-action"
        onClick={() => void this.run(item, 'pending_send')}
        disabled={busy || !transportConnected}
      >
        {item.lastError || item.state === 'rejected' ? t('重新发送', 'Resend') : t('发送', 'Send')}
      </button>
    ) : undefined;
    const attachmentCount = item.kind === 'primary' ? (item.attachments?.length ?? 0) : 0;
    return (
      <RecordRow
        key={'message:' + item.id}
        title={name ?? (item.kind === 'primary' ? t('智能体对话', 'Agent chat') : t('群聊', 'Group chat'))}
        status={recordStatus(item, t)}
        statusClass={'pending-state-' + (cancelled ? 'cancelled' : item.state)}
        statusRole={item.state === 'rejected' && !cancelled ? 'alert' : 'status'}
        createdAt={item.createdAt}
        preview={
          item.text ||
          (attachmentCount > 0
            ? t(`${attachmentCount} 张图片`, attachmentCount === 1 ? '1 image' : `${attachmentCount} images`)
            : undefined)
        }
        action={action}
        extraActions={(canCancel || canOpen) ? (
          <>
            {canCancel && (
              <button
                type="button"
                className="secondary-button pending-secondary-action"
                onClick={() => void this.run(item, 'pending_cancel')}
                disabled={busy}
              >
                {t('取消发送', 'Cancel')}
              </button>
            )}
            {canOpen && (
              <button
                type="button"
                className="secondary-button pending-secondary-action"
                onClick={() => onOpenConversation?.(target)}
              >
                {t('打开对话', 'Open chat')}
              </button>
            )}
          </>
        ) : undefined}
        details={[
          t('目标设备 ', 'Target device ') + item.targetDeviceId,
          item.kind === 'primary' ? t('智能体 ', 'Bot ') + item.botId : t('群聊 ', 'Group ') + item.scopeId,
          item.kind === 'primary' ? 'requestId ' + item.requestId : 'messageId ' + item.messageId,
          ...(item.lastError ? [item.lastError.code + ' · ' + item.lastError.outcome] : []),
        ]}
        raw={item.receipt}
        t={t}
      />
    );
  }

  private renderIntent(intent: DesktopUiIntent): ReactNode {
    const { conversationName, onOpenConversation, transportConnected, api, t } = this.props;
    const params = intent.params as { requestId?: string; role?: string; scopeId?: string };
    const target = params.scopeId ? { deviceId: intent.targetDeviceId, scopeId: params.scopeId } : undefined;
    const name = target && conversationName?.(target);
    const waiting = intent.outcome === 'unconfirmed';
    const canCheck = waiting && intent.method === 'createBot';
    const canOpen = Boolean(target && name && onOpenConversation);
    const subject = params.role || name;
    const failed = intent.outcome === 'responded' && !!intent.error && !intent.result;
    const status = waiting
      ? t('可能已完成，待确认', 'Maybe done')
      : intent.outcome === 'not-sent'
        ? t('没有发出', 'Not sent')
        : failed
          ? t('操作失败', 'Action failed')
          : t('已完成', 'Done');
    return (
      <RecordRow
        key={'intent:' + intent.id}
        title={intentLabel(intent.method, t) + (subject ? ' · ' + subject : '')}
        status={status}
        statusClass={failed ? 'pending-state-rejected' : 'pending-outcome-' + intent.outcome}
        statusRole={failed || intent.outcome === 'not-sent' ? 'alert' : 'status'}
        action={canCheck && (
          <button
            type="button"
            className="primary-button pending-primary-action"
            onClick={() => void this.reconcileBotIntent(intent)}
            disabled={!!this.state.busyId || !transportConnected}
          >
            {t('检查是否完成', 'Check if done')}
          </button>
        )}
        extraActions={(canOpen || !waiting) ? (
          <>
            {target && canOpen && (
              <button
                type="button"
                className="secondary-button pending-secondary-action"
                onClick={() => onOpenConversation?.(target)}
              >
                {t('打开群聊', 'Open group')}
              </button>
            )}
            {!waiting && (
              <button
                type="button"
                className="secondary-button pending-secondary-action"
                onClick={() => void api.deleteIntent(intent.id).catch((error) => this.setState({ error: toError(error).message }))}
                disabled={!!this.state.busyId}
              >
                {t('删除记录', 'Remove')}
              </button>
            )}
          </>
        ) : undefined}
        details={[
          t('目标设备 ', 'Target device ') + intent.targetDeviceId,
          'requestId ' + (params.requestId ?? '—'),
          ...(intent.error ? [intent.error.code + ' · ' + intent.error.outcome] : []),
        ]}
        raw={intent.result}
        t={t}
      />
    );
  }

  private switchView(): void {
    const view = this.state.view === 'attention' ? 'history' : 'attention';
    this.loadedPages = 1;
    if (this.bodyRef.current) this.bodyRef.current.scrollTop = 0;
    this.setState(
      { view, items: [], cursors: {}, error: null, notice: null, loading: true, receiptsOpen: false },
      () => void this.load(),
    );
  }

  render(): ReactNode {
    const { identity, transportConnected, target, conversationName, onClearTarget, t } = this.props;
    const { view, loading, error, notice, focused, cursors, receiptsOpen } = this.state;
    if (!identity) {
      return (
        <div className="pending-empty-state">
          <Inbox size={26} aria-hidden="true" />
          <p>{t('连接设备后查看发送记录。', 'Connect to a device to view send records.')}</p>
        </div>
      );
    }
    const items = this.state.items.filter((item) =>
      item.id !== focused?.id && VIEW_STATES[view].includes(item.state) && this.matchesConversation(item),
    );
    const intents = this.state.intents.filter((intent) =>
      intent.profileId === identity.profileId && intent.targetDeviceId === identity.targetDeviceId &&
      (view === 'attention' ? intent.outcome === 'unconfirmed' : intent.outcome !== 'unconfirmed') &&
      !target?.botId && (!target?.scopeId || (intent.params as { scopeId?: string }).scopeId === target.scopeId),
    );
    const hasMore = Object.values(cursors).some(Boolean);
    const showingHistory = view === 'history';
    const noRecords = !items.length && !intents.length && !target?.recordId;
    return (
      <div className="pending-panel">
        <header className="pending-panel-head">
          <div className="pending-panel-heading">
            <div className="pending-panel-title-group">
              <h3>{showingHistory ? t('历史记录', 'History') : t('待处理', 'Pending')}</h3>
              {target && (
                <div className="pending-context">
                  <span className="pending-context-name">
                    {conversationName?.(target) ?? (target.scopeId ? t('当前群聊', 'Current group') : t('当前会话', 'Current chat'))}
                  </span>
                  <button type="button" className="pending-context-link" onClick={onClearTarget}>
                    {t('查看设备全部记录', 'Show all on device')}
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="secondary-button pending-quiet-button" onClick={() => this.switchView()}>
              {showingHistory ? t('返回待处理', 'Back to pending') : t('查看历史', 'View history')}
            </button>
          </div>
        </header>
        <div className="chat-pane pending-panel-body" ref={this.bodyRef}>
          {!transportConnected && (
            <InlineBanner
              tone="attention"
              role="status"
              compact
              title={t('当前未联网', 'Offline')}
              detail={t('设备连接不可用。可查看或取消待发记录，恢复后可发送和核对。', 'Device connection unavailable. You can view or cancel queued items now, and send or verify once back online.')}
            />
          )}
          {notice && (
            <InlineBanner
              tone="info"
              role="status"
              compact
              title={notice}
              onDismiss={() => this.setState({ notice: null })}
            />
          )}
          {error && (
            <InlineBanner
              tone="danger"
              role="alert"
              title={t('操作暂未完成', 'Action could not be completed')}
              detail={error}
              actions={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void this.load(false, this.loadedPages);
                    void this.loadFocused();
                  }}
                >
                  {t('重试', 'Retry')}
                </Button>
              }
            />
          )}
          {target?.recordId && (
            <section className="pending-focused" aria-label={t('指定记录', 'Focused record')}>
              <h4>{t('指定记录', 'Focused record')}</h4>
              {focused ? (
                this.renderItem(focused)
              ) : (
                <p className="pending-focused-empty">
                  {focused === null ? t('找不到这条记录。', 'This record could not be found.') : t('正在读取记录…', 'Loading record…')}
                </p>
              )}
            </section>
          )}
          <section
            className="pending-records"
            aria-label={showingHistory ? t('历史记录', 'History') : t('待处理记录', 'Pending records')}
            aria-busy={loading}
          >
            {items.map((item) => this.renderItem(item))}
            {!showingHistory && intents.map((intent) => this.renderIntent(intent))}
          </section>
          {noRecords && !error && (
            <div className="pending-empty-state" role="status">
              <Inbox size={26} aria-hidden="true" />
              <h4>
                {loading
                  ? t('正在读取记录…', 'Loading records…')
                  : hasMore
                    ? t('当前页暂无匹配记录，可继续加载。', 'No matching records on this page.')
                    : showingHistory
                      ? t('暂无历史记录', 'No history yet')
                      : t('没有待处理的记录', 'Nothing waiting to send')}
              </h4>
              {!loading && !hasMore && !showingHistory && (
                <p>
                  {t('离线或未确认的消息会暂存在这里，恢复后可继续发送或核对。', 'Unsent or unconfirmed messages appear here so you can send or verify them once back online.')}
                </p>
              )}
            </div>
          )}
          {hasMore && (
            <button
              type="button"
              className="secondary-button pending-load-more"
              onClick={() => void this.load(true)}
              disabled={loading || !!this.state.busyId}
            >
              {t('加载更多', 'Load more')}
            </button>
          )}
          {showingHistory && intents.length > 0 && (
            <section className="pending-receipts">
              <button
                type="button"
                className="pending-receipts-toggle tabular-nums"
                aria-expanded={receiptsOpen}
                onClick={() => this.setState((state) => ({ receiptsOpen: !state.receiptsOpen }))}
              >
                {receiptsOpen ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
                <span>{t(`操作回执（${intents.length}）`, `Operation receipts (${intents.length})`)}</span>
              </button>
              {receiptsOpen && (
                <div className="pending-records">
                  {intents.map((intent) => this.renderIntent(intent))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    );
  }
}

export function PendingPanel(props: PendingPanelProps): ReactNode {
  const t = useText();
  return <PendingPanelInner {...props} t={t} />;
}
