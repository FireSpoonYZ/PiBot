// Module 17 待发送面板（core-owned，stage1 修正）：pending 列表/分页/筛选、显式发送、
// 只读 reconcile、仅 pending 本地 cancel；冻结创建/成员变更 intents 展示与对账。
// 断开后保留队列 identity/目标，本面板仍可离线 list/get/enqueue/cancel。
// 桌面重构（5.7）：中文用户语言 + 状态筛选 + 对账卡片 + 折叠回执；技术术语与业务 ID
// 收进「处理说明 / 技术详情」，不默认铺满卡片。新样式仅在 .desktop-shell 作用域生效，
// 手机端（grok-pending-mobile-container / 共享样式）继续命中原有结构类。
import { Component } from 'react';
import type { ReactNode } from 'react';
import type { PendingCursor, PendingRecord, PendingState } from '../../../host-core/index.js';
import type { DesktopUiIntent } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';
import './PendingPanel.css';

interface Props {
  api: DesktopPanelApi;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
}

interface State {
  items: PendingRecord[];
  cursor: PendingCursor | null;
  filter: PendingState | null;
  intents: DesktopUiIntent[];
  error: string | null;
  busyId: string | null;
}

const STATE_LABELS: Record<PendingState, string> = {
  pending: '待发送',
  sending: '发送中',
  unconfirmed: '待确认',
  accepted: '已受理',
  rejected: '已拒绝',
};

const INTENT_METHOD_LABELS: Record<DesktopUiIntent['method'], string> = {
  createBot: '创建助手',
  createScope: '创建群聊',
  updateScope: '更新群聊',
  deleteScope: '解散群聊',
};

/** 回执/结果 JSON 统一收进折叠 <details>，避免长 payload 直接铺满对账列表。 */
function RawBlock({ label, value }: { label: string; value: unknown }): ReactNode {
  return (
    <details className="pending-raw raw-history">
      <summary>{label}</summary>
      <pre className="raw-history-content">{JSON.stringify(value ?? null, null, 2)}</pre>
    </details>
  );
}

/** 业务 ID 与技术元数据统一进「技术详情」折叠块，卡片首屏只留用户语言。 */
function TechDetails({ rows, rawLabel, rawValue }: {
  rows: string[];
  rawLabel?: string;
  rawValue?: unknown;
}): ReactNode {
  return (
    <details className="pending-tech">
      <summary>技术详情</summary>
      <div className="pending-tech-body">
        {rows.map((r) => (
          <span key={r} className="metadata pending-mono">{r}</span>
        ))}
        {rawLabel !== undefined && <RawBlock label={rawLabel} value={rawValue} />}
      </div>
    </details>
  );
}

export class PendingPanel extends Component<Props, State> {
  state: State = {
    items: [],
    cursor: null,
    filter: null,
    intents: [],
    error: null,
    busyId: null,
  };

  private unsub: (() => void) | null = null;
  private mounted = false;
  private identityEpoch = 0;
  private loadEpoch = 0;

  private isCurrent(identity: DesktopIdentity, epoch: number): boolean {
    const current = this.props.identity;
    return this.mounted && this.identityEpoch === epoch && !!current &&
      current.profileId === identity.profileId && current.targetDeviceId === identity.targetDeviceId &&
      current.kind === identity.kind && current.generation === identity.generation;
  }
  /** 同步在途标记：state.busyId 在重渲染前不能防双击。 */
  private inFlight = false;

  componentDidMount(): void {
    this.mounted = true;
    this.unsub = this.props.api.subscribe(() => {
      if (!this.mounted) return;
      const snap = this.props.api.snapshot;
      this.setState({ intents: snap ? snap.state.intents : [] });
    });
    this.setState({ intents: this.props.api.snapshot ? this.props.api.snapshot.state.intents : [] });
    void this.load();
  }

  componentWillUnmount(): void {
    this.mounted = false;
    this.identityEpoch += 1;
    this.loadEpoch += 1;
    if (this.unsub) this.unsub();
  }

  componentDidUpdate(prev: Props): void {
    const a = prev.identity;
    const b = this.props.identity;
    if (
      a?.generation !== b?.generation ||
      a?.profileId !== b?.profileId ||
      a?.kind !== b?.kind ||
      a?.targetDeviceId !== b?.targetDeviceId
    ) {
      this.identityEpoch += 1;
      this.loadEpoch += 1;
      this.setState({ items: [], cursor: null, error: null, busyId: null });
      void this.load();
    }
  }

  private async load(): Promise<void> {
    const identity = this.props.identity;
    if (!identity) return;
    const epoch = this.identityEpoch;
    const loadEpoch = ++this.loadEpoch;
    const filter = this.state.filter;
    try {
      const page = await this.props.api.pending(identity, 'pending_list', {
        options: { ...(filter ? { state: filter } : {}), limit: 50, cursor: null },
      });
      // 旧请求结果不得覆盖新目标/新筛选。
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState({
        items: page.items,
        cursor: page.nextCursor,
        error: null,
      });
    } catch (e) {
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState({ error: toError(e).message });
    }
  }

  private async loadMore(): Promise<void> {
    const identity = this.props.identity;
    if (!identity || !this.state.cursor) return;
    const epoch = this.identityEpoch;
    const loadEpoch = ++this.loadEpoch;
    const filter = this.state.filter;
    try {
      // 保留完整 PendingCursor 原样回传，不手工伪造。
      const page = await this.props.api.pending(identity, 'pending_list', {
        options: { ...(filter ? { state: filter } : {}), limit: 50, cursor: this.state.cursor },
      });
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState((s) => ({
        items: [...s.items, ...page.items],
        cursor: page.nextCursor,
      }));
    } catch (e) {
      if (!this.isCurrent(identity, epoch) || this.loadEpoch !== loadEpoch || this.state.filter !== filter) {
        return;
      }
      this.setState({ error: toError(e).message });
    }
  }

  private async run(
    id: string,
    op: 'pending_send' | 'pending_reconcile' | 'pending_cancel',
  ): Promise<void> {
    const identity = this.props.identity;
    if (!identity || this.inFlight) return;
    if ((op === 'pending_send' || op === 'pending_reconcile') && !this.props.transportConnected) {
      this.setState({ error: '客户端未连接：发送/对账需先重新连接；本地取消仍可用' });
      return;
    }
    const epoch = this.identityEpoch;
    this.inFlight = true;
    this.setState({ busyId: id, error: null });
    try {
      const updated = await this.props.api.pending(identity, op, { id });
      if (!this.isCurrent(identity, epoch)) return;
      this.setState((s) => ({
        items: s.items.map((it) => (it.id === id ? updated : it)),
        busyId: null,
      }));
    } catch (e) {
      if (!this.isCurrent(identity, epoch)) return;
      this.setState({ busyId: null, error: toError(e).message });
    } finally {
      this.inFlight = false;
    }
  }

  private async reconcileBotIntent(intent: DesktopUiIntent): Promise<void> {
    const identity = this.props.identity;
    if (!identity || !this.canReconcile(intent) || this.inFlight || !this.props.transportConnected) return;
    const epoch = this.identityEpoch;
    this.inFlight = true;
    this.setState({ busyId: intent.id, error: null });
    try {
      // Bot create 只读 findByRequest，使用原 requestId/原目标；查到才保存结果，null 保持未确认。
      const params = intent.params as { requestId: string };
      const bot = await this.props.api.call(identity, 'findByRequest', { requestId: params.requestId });
      if (!this.isCurrent(identity, epoch)) return;
      if (bot) {
        await this.props.api.updateIntent(intent.id, { outcome: 'responded', result: bot });
      }
      if (!this.isCurrent(identity, epoch)) return;
      this.setState({ busyId: null });
    } catch (e) {
      if (!this.isCurrent(identity, epoch)) return;
      this.setState({ busyId: null, error: toError(e).message });
    } finally {
      this.inFlight = false;
    }
  }

  private canReconcile(intent: DesktopUiIntent): boolean {
    const identity = this.props.identity;
    return (
      !!identity &&
      intent.method === 'createBot' &&
      intent.outcome === 'unconfirmed' &&
      identity.profileId === intent.profileId &&
      identity.targetDeviceId === intent.targetDeviceId
    );
  }

  private renderItem(item: PendingRecord): ReactNode {
    const busy = this.state.busyId === item.id;
    const offline = !this.props.transportConnected;
    const canSend = item.state === 'pending';
    const canReconcileRow =
      item.state === 'unconfirmed' || item.state === 'pending' || item.state === 'rejected';
    const canCancel = item.state === 'pending';
    const title =
      item.kind === 'primary' ? '发给助手的消息' : '发到群聊的消息';
    const target =
      item.kind === 'primary' ? item.botId : item.scopeId;
    return (
      <div key={item.id} className="entity-row pending-card">
        <div className="entity-main">
          <div className="pending-card-head">
            <span className="entity-title">{title + ' · ' + target}</span>
            <span className={'status pending-state-' + item.state}>{STATE_LABELS[item.state]}</span>
          </div>
          {item.text && <p className="pending-text">{item.text}</p>}
          {item.lastError && (
            <span className="metadata error-banner">
              {item.lastError.code + ' · ' + item.lastError.outcome}
            </span>
          )}
          <TechDetails
            rows={[
              '目标设备 ' + item.targetDeviceId,
              'requestId' in item
                ? 'requestId ' + item.requestId
                : 'messageId ' + item.messageId,
            ]}
            rawLabel="回执 JSON"
            rawValue={item.receipt}
          />
        </div>
        <div className="toolbar pending-actions">
          {canSend && (
            <button
              className="pending-action-primary"
              onClick={() => void this.run(item.id, 'pending_send')}
              disabled={busy || offline}
            >
              发送
            </button>
          )}
          {canReconcileRow && (
            <button
              onClick={() => void this.run(item.id, 'pending_reconcile')}
              disabled={busy || offline}
            >
              核对结果
            </button>
          )}
          {canCancel && (
            <button onClick={() => void this.run(item.id, 'pending_cancel')} disabled={busy}>
              取消
            </button>
          )}
          {!canSend && !canReconcileRow && (
            <span className="metadata">已结束，无需操作</span>
          )}
        </div>
      </div>
    );
  }

  private renderIntent(intent: DesktopUiIntent): ReactNode {
    const busy = this.state.busyId === intent.id;
    const offline = !this.props.transportConnected;
    const canDelete = intent.outcome === 'responded' || intent.outcome === 'not-sent';
    const canReconcileNow = this.canReconcile(intent);
    const outcomeLabel =
      intent.outcome === 'responded'
        ? '已生效'
        : intent.outcome === 'unconfirmed'
          ? '待确认'
          : '未发送';
    return (
      <div key={intent.id} className="entity-row pending-card pending-intent">
        <div className="entity-main">
          <div className="pending-card-head">
            <span className="entity-title">{INTENT_METHOD_LABELS[intent.method]}</span>
            <span className={'status pending-outcome-' + intent.outcome}>{outcomeLabel}</span>
          </div>
          {intent.error && (
            <span className="metadata error-banner">
              {intent.error.code + ' · ' + intent.error.outcome}
            </span>
          )}
          <TechDetails
            rows={[
              '目标设备 ' + intent.targetDeviceId,
              'profile ' + intent.profileId,
              'requestId ' + ((intent.params as { requestId?: string }).requestId ?? '—'),
            ]}
            rawLabel="结果 JSON"
            rawValue={intent.result}
          />
        </div>
        <div className="toolbar pending-actions">
          {intent.method === 'createBot' && (
            <button
              onClick={() => void this.reconcileBotIntent(intent)}
              disabled={busy || !canReconcileNow || offline}
            >
              核对结果
            </button>
          )}
          {canDelete && (
            <button onClick={() => void this.props.api.deleteIntent(intent.id)} disabled={busy}>
              删除
            </button>
          )}
          {!canDelete && !canReconcileNow && (
            <span className="metadata">待确认期间不可删除</span>
          )}
        </div>
      </div>
    );
  }

  render(): ReactNode {
    const identity = this.props.identity;
    if (!identity) {
      return <div className="empty-state">未配置队列，请先连接目标设备</div>;
    }
    const offline = !this.props.transportConnected;
    const FILTERS: Array<{ key: PendingState | null; label: string }> = [
      { key: null, label: '全部' },
      { key: 'pending', label: STATE_LABELS.pending },
      { key: 'sending', label: STATE_LABELS.sending },
      { key: 'unconfirmed', label: STATE_LABELS.unconfirmed },
      { key: 'accepted', label: STATE_LABELS.accepted },
      { key: 'rejected', label: STATE_LABELS.rejected },
    ];
    return (
      <div className="pending-panel">
        <div className="pending-panel-head">
          <h3>待发送</h3>
          {/* 桌面壳内用胶囊筛选；移动容器隐藏本控件，改用下方 select（见 PendingPanel.css）。 */}
          <div className="pending-filter-tabs pill-tabs" role="tablist" aria-label="状态筛选">
            {FILTERS.map((f) => (
              <button
                key={f.key ?? 'all'}
                type="button"
                className={this.state.filter === f.key ? 'active' : ''}
                aria-pressed={this.state.filter === f.key}
                onClick={() => this.setState({ filter: f.key }, () => void this.load())}
              >
                {f.label}
              </button>
            ))}
          </div>
          {/* 移动容器内的单一筛选控件；桌面壳内由 CSS 隐藏。 */}
          <label className="pending-filter-select">
            筛选
            <select
              value={this.state.filter ?? ''}
              onChange={(e) =>
                this.setState(
                  { filter: (e.target.value || null) as PendingState | null },
                  () => void this.load(),
                )
              }
            >
              <option value="">全部</option>
              {(Object.keys(STATE_LABELS) as PendingState[]).map((s) => (
                <option key={s} value={s}>
                  {STATE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <details className="pending-howto">
            <summary>处理说明</summary>
            <p className="pending-hint">
              发送失败或回执丢失的消息不会自动重发，需手动点「发送」或「核对结果」。
              「创建助手」支持按原编号只读查询结果；群聊的创建/更新无此查询，结果未知时
              保持「待确认」，不会伪造结果。已生效或未发送的变更可删除；待确认期间不可删除。
            </p>
          </details>
        </div>
        <div className="chat-pane pending-panel-body">
          {offline && (
            <p className="status error">
              客户端未连接：队列仍可查看或取消；发送与核对已禁用，重连后再操作。
            </p>
          )}
          {this.state.error && (
            <div className="error-banner" role="alert">
              {'操作失败：' + this.state.error}
              <button onClick={() => void this.load()}>重试</button>
            </div>
          )}
          <h3>消息队列</h3>
          {this.state.items.length === 0 ? (
            this.state.error ? null : (
              <p className="empty-state">
                {this.state.filter ? '该状态下暂无消息' : '暂无待发送消息'}
              </p>
            )
          ) : (
            this.state.items.map((it) => this.renderItem(it))
          )}
          {this.state.cursor && (
            <button onClick={() => void this.loadMore()} disabled={!!this.state.busyId}>
              加载更多
            </button>
          )}
          <h3>待确认的变更</h3>
          {this.state.intents.length === 0 ? (
            <p className="empty-state">暂无待确认的变更</p>
          ) : (
            this.state.intents.map((it) => this.renderIntent(it))
          )}
        </div>
      </div>
    );
  }
}
