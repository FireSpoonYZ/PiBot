// 发送记录从当前档案的本机账本读取。发送、核对与取消仍绑定原记录和设备。
import { Component, createRef, type ContextType, type ReactNode } from 'react';
import { CheckCircle2, Filter, History, Inbox, RefreshCw } from 'lucide-react';
import type { PendingCursor, PendingListPage, PendingRecord, PendingState } from '../../../host-core/index.js';
import type { DesktopUiIntent } from '../../../host-core/desktop-client.js';
import { ActionBar, EmptyState, ErrorState, InlineNotice, Segmented, type InlineNoticeTone } from '../../../web/src/components/ui';
import { LanguageOverride, useText } from '../../../web/src/ui';
import type { SendRecordsTarget } from './BotChats';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';
import './PendingPanel.css';

type RecordsView = 'attention' | 'history';
type Cursors = Partial<Record<PendingState, PendingCursor | null>>;
type BusyOp = 'pending_send' | 'pending_reconcile' | 'pending_cancel' | 'reconcile_intent' | 'delete_intent';
type Translate = (zh: string, en: string) => string;

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
  noticeTone: InlineNoticeTone;
  loading: boolean;
  busyId: string | null;
  busyOp: BusyOp | null;
}

const VIEW_STATES: Record<RecordsView, readonly PendingState[]> = {
  attention: ['pending', 'sending', 'unconfirmed'],
  history: ['accepted', 'rejected'],
};

function intentLabel(method: DesktopUiIntent['method'], t: Translate): string {
  switch (method) {
    case 'createBot': return t('创建智能体', 'Create agent');
    case 'createScope': return t('创建群聊', 'Create group chat');
    case 'updateScope': return t('更新群聊', 'Update group chat');
    case 'deleteScope': return t('解散群聊', 'Delete group chat');
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

function recordStatus(item: PendingRecord, t: Translate): string {
  switch (item.state) {
    case 'pending': return item.lastError?.outcome === 'not-sent' ? t('未发出', 'Not sent') : t('等待发送', 'Queued');
    case 'sending': return t('发送中', 'Sending');
    case 'unconfirmed': return t('结果未知', 'Unconfirmed');
    case 'accepted': return t('已接收', 'Accepted');
    case 'rejected': return isCancelled(item) ? t('已取消', 'Cancelled') : t('已拒绝', 'Rejected');
  }
}

function recordGuidance(item: PendingRecord, transportConnected: boolean, t: Translate): string | undefined {
  if (item.state === 'unconfirmed' || item.state === 'sending') {
    return transportConnected
      ? t('尚未收到明确回执，请先核对发送结果，避免重复发送。', 'No final receipt yet; verify status before retrying.')
      : t('设备当前离线，恢复连接后可核对发送结果。', 'Device is offline; reconnect to verify send status.');
  }
  if (item.state === 'pending' && !transportConnected) {
    return t('设备当前离线，恢复连接后可继续发送，或先取消此记录。', 'Device is offline; reconnect to send, or cancel this queued message.');
  }
  if (item.state === 'rejected' && !isCancelled(item)) {
    if (item.lastError?.code === 'REQUEST_CONFLICT') {
      return t('请求与远端更新冲突，无法直接重发。', 'This request conflicted with a newer update and cannot be resent directly.');
    }
    if (canSendRecord(item) && !transportConnected) {
      return t('设备当前离线，恢复连接后可重新发送。', 'Device is offline; reconnect to resend.');
    }
  }
  return undefined;
}

function recordTarget(item: PendingRecord): SendRecordsTarget {
  return item.kind === 'primary'
    ? { deviceId: item.targetDeviceId, recordId: item.id, botId: item.botId }
    : { deviceId: item.targetDeviceId, recordId: item.id, scopeId: item.scopeId };
}

function TechDetails({ rows, raw }: { rows: string[]; raw?: unknown }) {
  const t = useText();
  return (
    <details className="pending-tech">
      <summary>{t('技术详情', 'Technical details')}</summary>
      <div className="pending-tech-body">
        {rows.map((row) => <span key={row} className="metadata pending-mono">{row}</span>)}
        {raw != null && (
          <div className="pending-raw" style={{ marginTop: 4 }}>
            <span className="metadata" style={{ display: 'block', marginBottom: 4 }}>{t('原始回执', 'Raw receipt')}</span>
            <pre className="raw-history-content">{JSON.stringify(raw, null, 2)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

function RecordRow({ title, status, statusClass, createdAt, preview, guidance, actions, details, raw }: {
  title: string;
  status: string;
  statusClass: string;
  createdAt?: string;
  preview?: ReactNode;
  guidance?: string;
  actions?: ReactNode;
  details: string[];
  raw?: unknown;
}) {
  const created = createdAt ? new Date(createdAt) : null;
  return (
    <article
      className="pending-record"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-elevated)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '8px 12px',
        }}
      >
        <div className="pending-record-copy" style={{ flex: '1 1 220px', minWidth: 0 }}>
          <strong className="entity-title">{title}</strong>
          <div className="pending-record-meta">
            <span className={'status ' + statusClass}>{status}</span>
            {created && !Number.isNaN(created.getTime()) && (
              <time className="metadata" dateTime={createdAt}>{created.toLocaleString()}</time>
            )}
          </div>
          {preview && <p className="pending-text">{preview}</p>}
          {guidance && <p className="metadata" style={{ margin: '4px 0 0' }}>{guidance}</p>}
        </div>
        {actions ? (
          <ActionBar align="end" style={{ flexWrap: 'wrap' }}>
            {actions}
          </ActionBar>
        ) : null}
      </div>
      <TechDetails rows={details} raw={raw} />
    </article>
  );
}

export class PendingPanel extends Component<Props, State> {
  static contextType = LanguageOverride;
  declare context: ContextType<typeof LanguageOverride>;

  state: State = {
    view: 'attention',
    items: [],
    cursors: {},
    focused: undefined,
    intents: [],
    error: null,
    notice: null,
    noticeTone: 'info',
    loading: true,
    busyId: null,
    busyOp: null,
  };

  private t = (zh: string, en: string): string => {
    const language = this.context;
    const isEn =
      language === 'en' ||
      ((language === 'system' || language === undefined) &&
        typeof navigator !== 'undefined' &&
        navigator.language.startsWith('en'));
    return isEn ? en : zh;
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
      this.setState({ view: 'attention', items: [], cursors: {}, focused: undefined, busyId: null, busyOp: null, notice: null }, () => {
        void this.load();
        void this.loadFocused();
      });
    } else if (a?.generation !== b?.generation || (!prev.transportConnected && this.props.transportConnected)) {
      // 同一账本换代时保留已加载页和视口，旧代回执仍作废。
      if (a?.generation !== b?.generation) {
        this.identityEpoch += 1;
        this.setState({ busyId: null, busyOp: null });
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
    const noticeTone: InlineNoticeTone =
      isCancelled(item) || item.state === 'accepted' ? 'success' : 'info';
    this.setState((state) => ({
      items: state.items.map((old) => old.id === item.id ? item : old),
      focused: this.props.target?.recordId === item.id ? item : state.focused,
      notice: this.t(`当前记录状态：${recordStatus(item, this.t)}`, `Record status: ${recordStatus(item, this.t)}`),
      noticeTone,
    }));
  }

  private async run(item: PendingRecord, op: 'pending_send' | 'pending_reconcile' | 'pending_cancel'): Promise<void> {
    const { identity, api, transportConnected } = this.props;
    if (!identity || this.inFlight || (op !== 'pending_cancel' && !transportConnected)) return;
    const epoch = this.identityEpoch;
    this.inFlight = true;
    let refresh = true;
    this.setState({ busyId: item.id, busyOp: op, error: null, notice: null, noticeTone: 'info' });
    try {
      if (op === 'pending_send') {
        const latest = await api.pending(identity, 'pending_get', { id: item.id });
        if (!this.isCurrent(identity, epoch) || !this.props.transportConnected) return;
        if (!latest) {
          this.setState({ notice: this.t('该记录已不可用。', 'This record is no longer available.'), noticeTone: 'info' });
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
      if (this.isCurrent(identity, epoch)) this.setState({ busyId: null, busyOp: null });
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
    this.setState({ busyId: intent.id, busyOp: 'reconcile_intent', error: null, notice: null });
    try {
      const { requestId } = intent.params as { requestId: string };
      const bot = await api.call(identity, 'findByRequest', { requestId });
      if (!this.isCurrent(identity, epoch)) return;
      if (bot) await api.updateIntent(intent.id, { outcome: 'responded', result: bot, error: undefined });
      if (this.isCurrent(identity, epoch)) {
        this.setState({
          notice: bot
            ? this.t('已找到智能体创建结果。', 'Found agent creation result.')
            : this.t('暂时无法确认创建结果，请稍后再核对。', 'Could not confirm creation result yet; verify again later.'),
          noticeTone: bot ? 'success' : 'info',
        });
      }
    } catch (error) {
      if (this.isCurrent(identity, epoch)) this.setState({ error: toError(error).message });
    } finally {
      this.inFlight = false;
      if (this.isCurrent(identity, epoch)) this.setState({ busyId: null, busyOp: null });
    }
  }

  private async deleteIntentRecord(intent: DesktopUiIntent): Promise<void> {
    const { identity, api } = this.props;
    if (!identity || this.inFlight) return;
    const epoch = this.identityEpoch;
    this.inFlight = true;
    this.setState({ busyId: intent.id, busyOp: 'delete_intent', error: null, notice: null, noticeTone: 'info' });
    try {
      await api.deleteIntent(intent.id);
      if (this.isCurrent(identity, epoch)) {
        this.setState({ notice: this.t('已移除操作记录。', 'Action record removed.'), noticeTone: 'success' });
      }
    } catch (error) {
      if (this.isCurrent(identity, epoch)) this.setState({ error: toError(error).message });
    } finally {
      this.inFlight = false;
      if (this.isCurrent(identity, epoch)) this.setState({ busyId: null, busyOp: null });
    }
  }

  private renderItem(item: PendingRecord): ReactNode {
    const { conversationName, onOpenConversation, transportConnected } = this.props;
    const target = recordTarget(item);
    const name = conversationName?.(target);
    const busy = this.state.busyId !== null;
    const busyThis = this.state.busyId === item.id;
    const busyOp = busyThis ? this.state.busyOp : null;
    const canCheck = item.state === 'unconfirmed' || item.state === 'sending';
    const canSend = canSendRecord(item);
    const canCancel = item.state === 'pending';
    const canOpen = Boolean(name && onOpenConversation);
    const hasActions = canCheck || canSend || canCancel || canOpen;
    const actions = hasActions ? (
      <>
        {canCheck && (
          <button
            type="button"
            className="primary-button pending-primary-action"
            onClick={() => void this.run(item, 'pending_reconcile')}
            disabled={busy || !transportConnected}
          >
            {busyOp === 'pending_reconcile' ? this.t('正在核对…', 'Verifying…') : this.t('核对发送结果', 'Verify send status')}
          </button>
        )}
        {!canCheck && canSend && (
          <button
            type="button"
            className="primary-button pending-primary-action"
            onClick={() => void this.run(item, 'pending_send')}
            disabled={busy || !transportConnected}
          >
            {busyOp === 'pending_send'
              ? this.t('正在发送…', 'Sending…')
              : item.lastError || item.state === 'rejected'
                ? this.t('重新发送消息', 'Resend message')
                : this.t('发送消息', 'Send message')}
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            className="secondary-button pending-quiet-button"
            onClick={() => void this.run(item, 'pending_cancel')}
            disabled={busy}
          >
            {busyOp === 'pending_cancel' ? this.t('正在取消…', 'Cancelling…') : this.t('取消发送', 'Cancel send')}
          </button>
        )}
        {canOpen && (
          <button
            type="button"
            className="secondary-button pending-quiet-button"
            onClick={() => onOpenConversation?.(target)}
          >
            {item.kind === 'primary' ? this.t('打开所属对话', 'Open conversation') : this.t('打开所属群聊', 'Open group chat')}
          </button>
        )}
      </>
    ) : undefined;
    return (
      <RecordRow
        key={'message:' + item.id}
        title={name ?? (item.kind === 'primary' ? this.t('智能体对话', 'Agent conversation') : this.t('群聊', 'Group chat'))}
        status={recordStatus(item, this.t)}
        statusClass={'pending-state-' + (isCancelled(item) ? 'cancelled' : item.state)}
        createdAt={item.createdAt}
        preview={item.text || (item.kind === 'primary' && item.attachments?.length ? this.t(`${item.attachments.length} 张图片`, `${item.attachments.length} images`) : undefined)}
        guidance={recordGuidance(item, transportConnected, this.t)}
        actions={actions}
        details={[
          this.t('目标设备 ', 'Target device ') + item.targetDeviceId,
          item.kind === 'primary' ? this.t('智能体 ', 'Agent ') + item.botId : this.t('群聊 ', 'Group ') + item.scopeId,
          item.kind === 'primary' ? 'requestId ' + item.requestId : 'messageId ' + item.messageId,
          ...(item.lastError ? [item.lastError.code + ' · ' + item.lastError.outcome] : []),
        ]}
        raw={item.receipt}
      />
    );
  }

  private renderIntent(intent: DesktopUiIntent): ReactNode {
    const { conversationName, onOpenConversation, transportConnected } = this.props;
    const params = intent.params as { requestId?: string; role?: string; scopeId?: string };
    const target = params.scopeId ? { deviceId: intent.targetDeviceId, scopeId: params.scopeId } : undefined;
    const name = target && conversationName?.(target);
    const waiting = intent.outcome === 'unconfirmed';
    const canCheck = waiting && intent.method === 'createBot';
    const canOpen = Boolean(target && name && onOpenConversation);
    const canRemove = !waiting;
    const subject = params.role || name;
    const failed = intent.outcome === 'responded' && !!intent.error && !intent.result;
    const status = waiting
      ? this.t('结果未知', 'Unconfirmed')
      : intent.outcome === 'not-sent'
        ? this.t('未发出', 'Not sent')
        : failed
          ? this.t('操作失败', 'Failed')
          : this.t('已完成', 'Completed');
    const busy = this.state.busyId !== null;
    const busyThis = this.state.busyId === intent.id;
    const busyOp = busyThis ? this.state.busyOp : null;
    const guidance = waiting && !transportConnected
      ? this.t('设备当前离线，恢复连接后可核对操作结果。', 'Device is offline; reconnect to verify action status.')
      : undefined;
    const actions = (canCheck || canOpen || canRemove) ? (
      <>
        {canCheck && (
          <button
            type="button"
            className="primary-button pending-primary-action"
            onClick={() => void this.reconcileBotIntent(intent)}
            disabled={busy || !transportConnected}
          >
            {busyOp === 'reconcile_intent' ? this.t('正在核对…', 'Verifying…') : this.t('核对创建结果', 'Verify creation')}
          </button>
        )}
        {target && canOpen && (
          <button
            type="button"
            className="secondary-button pending-quiet-button"
            onClick={() => onOpenConversation?.(target)}
          >
            {this.t('打开所属群聊', 'Open group chat')}
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            className="secondary-button pending-quiet-button"
            onClick={() => void this.deleteIntentRecord(intent)}
            disabled={busy}
          >
            {busyOp === 'delete_intent' ? this.t('正在移除…', 'Removing…') : this.t('移除此记录', 'Remove record')}
          </button>
        )}
      </>
    ) : undefined;
    return (
      <RecordRow
        key={'intent:' + intent.id}
        title={intentLabel(intent.method, this.t) + (subject ? ' · ' + subject : '')}
        status={status}
        statusClass={failed ? 'pending-state-rejected' : 'pending-outcome-' + intent.outcome}
        guidance={guidance}
        actions={actions}
        details={[
          this.t('目标设备 ', 'Target device ') + intent.targetDeviceId,
          'requestId ' + (params.requestId ?? '—'),
          ...(intent.error ? [intent.error.code + ' · ' + intent.error.outcome] : []),
        ]}
        raw={intent.result}
      />
    );
  }

  private switchView = (view: RecordsView): void => {
    if (view === this.state.view) return;
    this.loadedPages = 1;
    if (this.bodyRef.current) this.bodyRef.current.scrollTop = 0;
    this.setState({ view, items: [], cursors: {}, error: null, notice: null, loading: true }, () => void this.load());
  };

  private refreshRecords = (): void => {
    if (!this.props.identity || this.state.loading || this.state.busyId) return;
    void this.load(false, this.loadedPages);
    void this.loadFocused();
  };

  render(): ReactNode {
    const { identity, transportConnected, target, conversationName, onClearTarget } = this.props;
    const { view, loading, error, notice, noticeTone, focused, cursors, busyId } = this.state;
    if (!identity) {
      return (
        <div className="pending-panel">
          <div className="chat-pane pending-panel-body">
            <EmptyState
              icon={<Inbox />}
              title={this.t('尚未连接设备', 'No device connected')}
              description={this.t('连接中心或本机服务并选择设备后，即可查看本机发送账本与待处理记录。', 'Connect to a center or local service and select a device to view local send records.')}
            />
          </div>
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

    // 单一优先级状态栏：有列表项时的操作错误 > 新鲜操作结果反馈（离线时折叠提示连接状态） > 持久离线只读提示；空态错误交由 ErrorState 统一呈现，避免双重报错。
    let statusBanner: ReactNode = null;
    if (error && !noRecords) {
      statusBanner = (
        <InlineNotice
          tone="error"
          title={this.t('记录操作未能完成', 'Could not complete record action')}
          description={
            error + ' ' + (
              transportConnected
                ? this.t('请重新读取账本确认最新状态，避免重复发送。', 'Reload the ledger to verify the latest status before retrying.')
                : this.t('当前设备离线，请先检查设备连接后再重试。', 'Device is currently offline; check connection before retrying.')
            )
          }
          onDismiss={() => this.setState({ error: null })}
          action={(
            <ActionBar align="start">
              <button
                type="button"
                className="secondary-button pending-quiet-button"
                onClick={this.refreshRecords}
                disabled={loading || !!busyId}
              >
                {this.t('重新读取记录', 'Reload records')}
              </button>
            </ActionBar>
          )}
        />
      );
    } else if (notice) {
      statusBanner = (
        <InlineNotice
          tone={noticeTone}
          title={notice}
          description={
            !transportConnected
              ? this.t('当前设备离线：仍可浏览本地账本或取消待发送消息；设备恢复在线后可继续发送与核对结果。', 'Device is currently offline: you can still inspect the local ledger or cancel queued messages; reconnect to send or verify.')
              : undefined
          }
          onDismiss={() => this.setState({ notice: null })}
          action={
            !transportConnected ? (
              <ActionBar align="start">
                <button
                  type="button"
                  className="secondary-button pending-quiet-button"
                  onClick={this.refreshRecords}
                  disabled={loading || !!busyId}
                >
                  {this.t('刷新本地账本', 'Refresh local ledger')}
                </button>
              </ActionBar>
            ) : undefined
          }
        />
      );
    } else if (!transportConnected) {
      statusBanner = (
        <InlineNotice
          tone="warning"
          title={this.t('当前设备连接不可用', 'Device connection unavailable')}
          description={this.t('离线时仍可浏览本地账本或取消待发送消息；设备恢复在线后可继续发送与核对结果。', 'You can still inspect the local ledger or cancel queued messages while offline; reconnect to send or verify.')}
          action={(
            <ActionBar align="start">
              <button
                type="button"
                className="secondary-button pending-quiet-button"
                onClick={this.refreshRecords}
                disabled={loading || !!busyId}
              >
                {this.t('刷新本地账本', 'Refresh local ledger')}
              </button>
            </ActionBar>
          )}
        />
      );
    }

    return (
      <div className="pending-panel">
        <header className="pending-panel-head">
          <div className="pending-panel-heading">
            <div>
              <h3>{showingHistory ? this.t('历史发送记录', 'Send history') : this.t('待处理记录', 'Needs attention')}</h3>
              {target && (
                <div className="pending-context">
                  <span className="metadata">
                    {conversationName?.(target) ?? (target.scopeId ? this.t('当前群聊', 'Current group') : this.t('当前会话', 'Current conversation'))}
                  </span>
                  <button type="button" className="pending-context-link" onClick={onClearTarget}>
                    {this.t('查看设备全部记录', 'View all device records')}
                  </button>
                </div>
              )}
            </div>
            <ActionBar align="end">
              <Segmented<RecordsView>
                aria-label={this.t('发送记录视图', 'Send records view')}
                value={view}
                disabled={!!busyId}
                onChange={this.switchView}
                options={[
                  { value: 'attention', label: this.t('待处理', 'Needs attention') },
                  { value: 'history', label: this.t('历史记录', 'History') },
                ]}
              />
              <button
                type="button"
                className="secondary-button pending-quiet-button"
                onClick={this.refreshRecords}
                disabled={loading || !!busyId}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {loading ? this.t('正在刷新…', 'Refreshing…') : this.t('刷新记录', 'Refresh records')}
              </button>
            </ActionBar>
          </div>
        </header>
        <div className="chat-pane pending-panel-body" ref={this.bodyRef}>
          {statusBanner}
          {target?.recordId && (
            <section className="pending-focused" aria-label={this.t('指定记录', 'Pinned record')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h4>{this.t('指定记录', 'Pinned record')}</h4>
              {focused ? this.renderItem(focused) : (
                <p className="empty-state">
                  {focused === null
                    ? this.t('在当前设备账本中未找到这条记录。', 'This record was not found in the current device ledger.')
                    : this.t('正在读取指定记录…', 'Loading pinned record…')}
                </p>
              )}
            </section>
          )}
          <section
            className="pending-records"
            aria-label={showingHistory ? this.t('历史记录', 'History records') : this.t('待处理记录', 'Pending records')}
            aria-busy={loading}
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          >
            {items.map((item) => this.renderItem(item))}
            {!showingHistory && intents.map((intent) => this.renderIntent(intent))}
          </section>
          {noRecords && error && (
            <ErrorState
              title={this.t('无法读取发送记录', 'Could not load send records')}
              description={error}
              action={(
                <ActionBar align="start" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="primary-button pending-primary-action"
                    onClick={this.refreshRecords}
                    disabled={loading || !!busyId}
                  >
                    {this.t('重新读取记录', 'Reload records')}
                  </button>
                  {target ? (
                    <button type="button" className="secondary-button pending-quiet-button" onClick={onClearTarget}>
                      {this.t('查看设备全部记录', 'View all device records')}
                    </button>
                  ) : null}
                </ActionBar>
              )}
            />
          )}
          {noRecords && !error && loading && (
            <EmptyState
              icon={<RefreshCw />}
              title={this.t('正在读取发送记录…', 'Loading send records…')}
              description={this.t('正在从当前档案的本机账本读取最新状态。', 'Reading the latest status from this profile’s local ledger.')}
            />
          )}
          {noRecords && !error && !loading && hasMore && (
            <EmptyState
              icon={<Filter />}
              title={this.t('当前页暂无匹配记录', 'No matching records on this page')}
              description={this.t('当前筛选条件下本页为空，可以向后加载更多账本记录，或查看设备全部记录。', 'No records match this filter on the current page. Load more pages or view all device records.')}
              action={(
                <ActionBar align="start" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="primary-button pending-primary-action"
                    onClick={() => void this.load(true)}
                    disabled={loading || !!busyId}
                  >
                    {this.t('加载更多记录', 'Load more records')}
                  </button>
                  {target ? (
                    <button type="button" className="secondary-button pending-quiet-button" onClick={onClearTarget}>
                      {this.t('查看设备全部记录', 'View all device records')}
                    </button>
                  ) : null}
                </ActionBar>
              )}
            />
          )}
          {noRecords && !error && !loading && !hasMore && !showingHistory && (
            <EmptyState
              icon={<CheckCircle2 />}
              title={target ? this.t('当前会话没有待处理记录', 'No pending records for this conversation') : this.t('所有消息均已处理完成', 'All clear — nothing needs attention')}
              description={this.t('当前没有等待发送、发送中或结果待核对的记录。已受理、被拒绝或已取消的记录均保留在历史记录中。', 'No queued, in-flight, or unconfirmed records remain. Accepted, rejected, and cancelled records are kept in History.')}
              action={(
                <ActionBar align="start" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="secondary-button pending-quiet-button"
                    onClick={() => this.switchView('history')}
                  >
                    {this.t('查看历史记录', 'View history')}
                  </button>
                  {target ? (
                    <button type="button" className="secondary-button pending-quiet-button" onClick={onClearTarget}>
                      {this.t('查看设备全部记录', 'View all device records')}
                    </button>
                  ) : null}
                </ActionBar>
              )}
            />
          )}
          {noRecords && !error && !loading && !hasMore && showingHistory && (
            <EmptyState
              icon={<History />}
              title={target ? this.t('当前会话暂无历史发送记录', 'No send history for this conversation') : this.t('暂无历史发送记录', 'No send history yet')}
              description={this.t('已受理、被拒绝或已取消的消息记录，以及已完成的操作回执会在这里留档备查。', 'Accepted, rejected, or cancelled messages and completed action receipts will appear here for reference.')}
              action={(
                <ActionBar align="start" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="secondary-button pending-quiet-button"
                    onClick={() => this.switchView('attention')}
                  >
                    {this.t('返回待处理', 'Back to needs attention')}
                  </button>
                  {target ? (
                    <button type="button" className="secondary-button pending-quiet-button" onClick={onClearTarget}>
                      {this.t('查看设备全部记录', 'View all device records')}
                    </button>
                  ) : null}
                </ActionBar>
              )}
            />
          )}
          {hasMore && !noRecords && (
            <ActionBar align="start">
              <button
                type="button"
                className="secondary-button pending-quiet-button"
                onClick={() => void this.load(true)}
                disabled={loading || !!busyId}
              >
                {loading ? this.t('正在加载更多…', 'Loading more…') : this.t('加载更多记录', 'Load more records')}
              </button>
            </ActionBar>
          )}
          {showingHistory && intents.length > 0 && (
            <details className="pending-receipts">
              <summary>{this.t(`操作回执（${intents.length}）`, `Action receipts (${intents.length})`)}</summary>
              <div className="pending-records" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {intents.map((intent) => this.renderIntent(intent))}
              </div>
            </details>
          )}
        </div>
      </div>
    );
  }
}
