// 发送记录从当前档案的本机账本读取。发送、核对与取消仍绑定原记录和设备。
import { Component, createRef, type ReactNode } from 'react';
import type { PendingCursor, PendingListPage, PendingRecord, PendingState } from '../../../host-core/index.js';
import type { DesktopUiIntent } from '../../../host-core/desktop-client.js';
import type { SendRecordsTarget } from './BotChats';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';
import './PendingPanel.css';

type RecordsView = 'attention' | 'history';
type Cursors = Partial<Record<PendingState, PendingCursor | null>>;

interface Props {
  api: DesktopPanelApi;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  target?: SendRecordsTarget;
  onClearTarget(): void;
  conversationName?: (target: SendRecordsTarget) => string | undefined;
  onOpenConversation?: (target: SendRecordsTarget) => void;
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
}

const VIEW_STATES: Record<RecordsView, readonly PendingState[]> = {
  attention: ['pending', 'sending', 'unconfirmed'],
  history: ['accepted', 'rejected'],
};

const INTENT_LABELS: Record<DesktopUiIntent['method'], string> = {
  createBot: '创建智能体',
  createScope: '创建群聊',
  updateScope: '更新群聊',
  deleteScope: '解散群聊',
};

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

function recordStatus(item: PendingRecord): string {
  switch (item.state) {
    case 'pending': return item.lastError?.outcome === 'not-sent' ? '未发出' : '等待发送';
    case 'sending': return '发送中';
    case 'unconfirmed': return '结果未知';
    case 'accepted': return '已接收';
    case 'rejected': return isCancelled(item) ? '已取消' : '已拒绝';
  }
}

function recordTarget(item: PendingRecord): SendRecordsTarget {
  return item.kind === 'primary'
    ? { deviceId: item.targetDeviceId, recordId: item.id, botId: item.botId }
    : { deviceId: item.targetDeviceId, recordId: item.id, scopeId: item.scopeId };
}

function TechDetails({ rows, raw }: { rows: string[]; raw?: unknown }) {
  return (
    <details className="pending-tech">
      <summary>技术详情</summary>
      <div className="pending-tech-body">
        {rows.map((row) => <span key={row} className="metadata pending-mono">{row}</span>)}
        {raw != null && (
          <details className="pending-raw raw-history">
            <summary>原始回执</summary>
            <pre className="raw-history-content">{JSON.stringify(raw, null, 2)}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

function RecordRow({ title, status, statusClass, createdAt, preview, action, extraActions, details, raw }: {
  title: string;
  status: string;
  statusClass: string;
  createdAt?: string;
  preview?: ReactNode;
  action?: ReactNode;
  extraActions?: ReactNode;
  details: string[];
  raw?: unknown;
}) {
  const created = createdAt ? new Date(createdAt) : null;
  const technicalDetails = <TechDetails rows={details} raw={raw} />;
  return (
    <article className="pending-record">
      <div className="pending-record-copy">
        <strong className="entity-title">{title}</strong>
        <div className="pending-record-meta">
          <span className={'status ' + statusClass}>{status}</span>
          {created && !Number.isNaN(created.getTime()) && (
            <time className="metadata" dateTime={createdAt}>{created.toLocaleString()}</time>
          )}
        </div>
        {preview && <p className="pending-text">{preview}</p>}
      </div>
      {action}
      {extraActions ? (
        <details className="pending-record-more">
          <summary>更多</summary>
          <div className="pending-more-content">
            <div className="pending-extra-actions">{extraActions}</div>
            {technicalDetails}
          </div>
        </details>
      ) : technicalDetails}
    </article>
  );
}

export class PendingPanel extends Component<Props, State> {
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

  componentDidUpdate(prev: Props): void {
    const a = prev.identity;
    const b = this.props.identity;
    const sameDevice = a?.profileId === b?.profileId && a?.kind === b?.kind && a?.targetDeviceId === b?.targetDeviceId;
    if (!sameDevice || prev.target !== this.props.target) {
      this.identityEpoch += 1;
      this.loadedPages = 1;
      this.setState({ view: 'attention', items: [], cursors: {}, focused: undefined, busyId: null, notice: null }, () => {
        void this.load();
        void this.loadFocused();
      });
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
      notice: recordStatus(item),
    }));
  }

  private async run(item: PendingRecord, op: 'pending_send' | 'pending_reconcile' | 'pending_cancel'): Promise<void> {
    const { identity, api, transportConnected } = this.props;
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
          this.setState({ notice: '该记录已不可用。' });
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
    const { identity, api, transportConnected } = this.props;
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
      if (this.isCurrent(identity, epoch)) this.setState({ notice: bot ? '已找到创建结果。' : '暂时无法确认创建结果。' });
    } catch (error) {
      if (this.isCurrent(identity, epoch)) this.setState({ error: toError(error).message });
    } finally {
      this.inFlight = false;
      if (this.isCurrent(identity, epoch)) this.setState({ busyId: null });
    }
  }

  private renderItem(item: PendingRecord): ReactNode {
    const { conversationName, onOpenConversation, transportConnected } = this.props;
    const target = recordTarget(item);
    const name = conversationName?.(target);
    const busy = this.state.busyId !== null;
    const canCheck = item.state === 'unconfirmed' || item.state === 'sending';
    const canSend = canSendRecord(item);
    const canCancel = item.state === 'pending';
    const canOpen = Boolean(name && onOpenConversation);
    const action = canCheck ? (
      <button type="button" className="primary-button pending-primary-action" onClick={() => void this.run(item, 'pending_reconcile')} disabled={busy || !transportConnected}>
        核对结果
      </button>
    ) : canSend ? (
      <button type="button" className="primary-button pending-primary-action" onClick={() => void this.run(item, 'pending_send')} disabled={busy || !transportConnected}>
        {item.lastError || item.state === 'rejected' ? '重新发送' : '发送'}
      </button>
    ) : undefined;
    return (
      <RecordRow
        key={'message:' + item.id}
        title={name ?? (item.kind === 'primary' ? '智能体对话' : '群聊')}
        status={recordStatus(item)}
        statusClass={'pending-state-' + (isCancelled(item) ? 'cancelled' : item.state)}
        createdAt={item.createdAt}
        preview={item.text || (item.kind === 'primary' && item.attachments?.length ? `${item.attachments.length} 张图片` : undefined)}
        action={action}
        extraActions={(canCancel || canOpen) ? (
          <>
            {canCancel && <button type="button" className="secondary-button" onClick={() => void this.run(item, 'pending_cancel')} disabled={busy}>取消发送</button>}
            {canOpen && <button type="button" className="secondary-button" onClick={() => onOpenConversation?.(target)}>打开对话</button>}
          </>
        ) : undefined}
        details={[
          '目标设备 ' + item.targetDeviceId,
          item.kind === 'primary' ? '智能体 ' + item.botId : '群聊 ' + item.scopeId,
          item.kind === 'primary' ? 'requestId ' + item.requestId : 'messageId ' + item.messageId,
          ...(item.lastError ? [item.lastError.code + ' · ' + item.lastError.outcome] : []),
        ]}
        raw={item.receipt}
      />
    );
  }

  private renderIntent(intent: DesktopUiIntent): ReactNode {
    const { conversationName, onOpenConversation, transportConnected, api } = this.props;
    const params = intent.params as { requestId?: string; role?: string; scopeId?: string };
    const target = params.scopeId ? { deviceId: intent.targetDeviceId, scopeId: params.scopeId } : undefined;
    const name = target && conversationName?.(target);
    const waiting = intent.outcome === 'unconfirmed';
    const canCheck = waiting && intent.method === 'createBot';
    const canOpen = Boolean(target && name && onOpenConversation);
    const subject = params.role || name;
    const failed = intent.outcome === 'responded' && !!intent.error && !intent.result;
    const status = waiting ? '结果未知' : intent.outcome === 'not-sent' ? '未发出' : failed ? '操作失败' : '已完成';
    return (
      <RecordRow
        key={'intent:' + intent.id}
        title={INTENT_LABELS[intent.method] + (subject ? ' · ' + subject : '')}
        status={status}
        statusClass={failed ? 'pending-state-rejected' : 'pending-outcome-' + intent.outcome}
        action={canCheck && (
          <button type="button" className="primary-button pending-primary-action" onClick={() => void this.reconcileBotIntent(intent)} disabled={!!this.state.busyId || !transportConnected}>
            核对结果
          </button>
        )}
        extraActions={(canOpen || !waiting) ? (
          <>
            {target && canOpen && <button type="button" className="secondary-button" onClick={() => onOpenConversation?.(target)}>打开群聊</button>}
            {!waiting && (
              <button type="button" className="secondary-button" onClick={() => void api.deleteIntent(intent.id).catch((error) => this.setState({ error: toError(error).message }))} disabled={!!this.state.busyId}>
                删除记录
              </button>
            )}
          </>
        ) : undefined}
        details={[
          '目标设备 ' + intent.targetDeviceId,
          'requestId ' + (params.requestId ?? '—'),
          ...(intent.error ? [intent.error.code + ' · ' + intent.error.outcome] : []),
        ]}
        raw={intent.result}
      />
    );
  }

  private switchView(): void {
    const view = this.state.view === 'attention' ? 'history' : 'attention';
    this.loadedPages = 1;
    if (this.bodyRef.current) this.bodyRef.current.scrollTop = 0;
    this.setState({ view, items: [], cursors: {}, error: null, notice: null, loading: true }, () => void this.load());
  }

  render(): ReactNode {
    const { identity, transportConnected, target, conversationName, onClearTarget } = this.props;
    const { view, loading, error, notice, focused, cursors } = this.state;
    if (!identity) return <p className="empty-state">连接设备后查看发送记录。</p>;
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
            <div>
              <h3>{showingHistory ? '历史记录' : '待处理'}</h3>
              {target && (
                <div className="pending-context">
                  <span className="metadata">{conversationName?.(target) ?? (target.scopeId ? '当前群聊' : '当前会话')}</span>
                  <button type="button" className="pending-context-link" onClick={onClearTarget}>查看设备全部记录</button>
                </div>
              )}
            </div>
            <button type="button" className="secondary-button pending-quiet-button" onClick={() => this.switchView()}>
              {showingHistory ? '返回待处理' : '查看历史'}
            </button>
          </div>
        </header>
        <div className="chat-pane pending-panel-body" ref={this.bodyRef}>
          {!transportConnected && <p className="status">设备连接不可用。可查看或取消待发记录，恢复后可发送和核对。</p>}
          {notice && <p className="status" role="status">{notice}</p>}
          {error && (
            <div className="error-banner" role="alert">
              操作暂未完成
              <button type="button" onClick={() => { void this.load(false, this.loadedPages); void this.loadFocused(); }}>重新读取记录</button>
              <TechDetails rows={[error]} />
            </div>
          )}
          {target?.recordId && (
            <section className="pending-focused" aria-label="指定记录">
              <h4>指定记录</h4>
              {focused ? this.renderItem(focused) : <p className="empty-state">{focused === null ? '找不到这条记录。' : '正在读取记录…'}</p>}
            </section>
          )}
          <section className="pending-records" aria-label={showingHistory ? '历史记录' : '待处理记录'} aria-busy={loading}>
            {items.map((item) => this.renderItem(item))}
            {!showingHistory && intents.map((intent) => this.renderIntent(intent))}
          </section>
          {noRecords && !error && (
            <p className="empty-state">{loading ? '正在读取记录…' : hasMore ? '当前页暂无匹配记录，可继续加载。' : showingHistory ? '暂无历史记录。' : '没有待处理的记录。'}</p>
          )}
          {hasMore && <button type="button" className="secondary-button" onClick={() => void this.load(true)} disabled={loading || !!this.state.busyId}>加载更多</button>}
          {showingHistory && intents.length > 0 && (
            <details className="pending-receipts">
              <summary>操作回执（{intents.length}）</summary>
              <div className="pending-records">{intents.map((intent) => this.renderIntent(intent))}</div>
            </details>
          )}
        </div>
      </div>
    );
  }
}
