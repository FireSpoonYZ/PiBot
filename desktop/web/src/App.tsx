// Module 17 desktop 应用装配（core-owned）：连接管理、设备目录、
// 导航与全画布工作区渲染。token/CA 仅输入态存在，连接尝试结束后立即清空。
import { Component, createRef } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  ClipboardCheck,
  Download,
  FolderInput,
  LayoutDashboard,
  MessageSquare,
  ServerCog,
  Settings,
} from 'lucide-react';
import { DesktopRemoteError, request, toError } from './api';
import type {
  DesktopClientStatus,
  DesktopConnectionInput,
  DesktopUiProfile,
} from '../../../host-core/desktop-client.js';
import type { BotDirectoryEntry, DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi, DesktopViewApi } from './types';
import { PendingPanel } from './PendingPanel';
import { SettingsPanel, type CenterAdminTab, type DevicesSectionState, type SettingsTab } from './SettingsPanel';
import { BotChats, type BotChatsArchiveBridge, type SendRecordsTarget } from './BotChats';
import {
  CenterGate,
  openCenterManagement,
  useCenterConnection,
  useDesktopTheme,
} from './CenterGate';
import { targetApi } from './targetApi';
import './DesktopShell.css';
import {
  CenterAdminPanel,
  createBrokerCenterTransport,
  type CenterTransport,
} from '../../../web/src/center-admin';
import { humanizeError, useText } from '../../../web/src/ui';
import { InlineBanner, Select, type SelectOption } from '../../../web/src/components/ui';
import { hasOpenFloatingPopover } from '../../../web/src/components/ui/Overlay';
import { ConnectionStatusPopover, type ConnectionPhase } from '../../../web/src/connection';
import { useClientUpdate } from '../../../web/src/ClientUpdateProvider';
import { useNotice, type NoticeContextValue, type NoticeTone } from '../../../web/src/notice';

type PrimaryView = 'chat' | 'tasks' | 'board';
type AppView = PrimaryView | 'pending' | 'settings' | 'center-admin';

function isPrimaryView(view: AppView): view is PrimaryView {
  return view === 'chat' || view === 'tasks' || view === 'board';
}

interface ProfileFormState {
  title: string;
  kind: 'local' | 'relay';
  url: string;
  expectedDeviceId: string;
  deviceId: string;
}

type BotInspectorPanel = 'profile' | 'google-setup';

interface PendingBotNavigation {
  deviceId: string;
  botId: string;
  panel?: BotInspectorPanel;
  fromCenterAdminTab?: CenterAdminTab;
}

interface AppState {
  busy: boolean;
  profiles: DesktopUiProfile[];
  profilesError: string | null;
  selectedProfileId: string | null;
  status: DesktopClientStatus | null;
  /** 不可变快照：与 api 可变 getter 分离，供子面板按 props 旧值检测变化。 */
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  view: AppView;
  returnView: PrimaryView;
  token: string;
  ca: string;
  form: ProfileFormState;
  globalError: string | null;
  globalErrorSeq: number;
  /** transport/relay 断开提示（可恢复）；供左栏 ConnectionStatusPopover 呈现。 */
  connectionError: string | null;
  checkingConnection: boolean;
  selectedDeviceId: string;
  pendingTarget?: SendRecordsTarget;
  pendingBotTarget?: PendingBotNavigation;
  pendingAttention: { identity: DesktopIdentity; deviceId: string } | null;
  taskWaitingCount: number;
  settingsTab: SettingsTab;
  centerAdminTab: CenterAdminTab;
  profileTokens: Record<string, string>;
  devices: DevicesSectionState;
  archiveBridge: BotChatsArchiveBridge | null;
}

interface AppProps {
  api: DesktopPanelApi;
  /** false = 页面不可见（手机切回本机页）：停止面板观察/只读轮询，不断连、不释放会话。 */
  pageActive?: boolean;
  /** CenterGate hook 桥接：中心会话状态与断开（浏览器标签条目不离开页面）。 */
  centerConnection: ReturnType<typeof useCenterConnection>;
  /** 主题三档（由 useDesktopTheme 注入）。 */
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  /** 全局统一通知层（useNotice / NoticeProvider）。 */
  notice: NoticeContextValue;
  t: (zh: string, en: string) => string;
  /** 桌宠点击主动提醒时由宿主桥接切换到目标 Bot 会话。 */
  onRegisterOpenBot?: (handler: ((deviceId: string, botId: string) => void) | null) => void;
}

function runId(): string {
  return 'p-' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8);
}

function mapNoticeTone(tone: 'danger' | 'warning' | 'info' | 'success' | 'progress'): NoticeTone {
  if (tone === 'danger') return 'error';
  if (tone === 'warning') return 'warning';
  if (tone === 'success') return 'success';
  return 'info';
}

const emptyDevices: DevicesSectionState = {
  items: [],
  nextCursor: null,
  error: null,
  busy: false,
  loadedAt: null,
  loaded: false,
  stale: false,
};

/** 实际连接状态统一口径：transport 已断开/身份已作废时，缓存的 connected 不得再当在线。
 * connecting 仍是当前正在连接，failed 指上次连接失败；纯展示，不新增 broker 调用、不自动重连。 */
function phaseText(
  status: DesktopClientStatus | null,
  transportConnected: boolean,
  t: (zh: string, en: string) => string,
): string {
  if (!status) return t('未连接', 'Disconnected');
  if (status.phase === 'connecting') return t('连接中', 'Connecting');
  if (status.phase === 'failed') return t('连接失败', 'Connection failed');
  return status.phase === 'connected' && transportConnected ? t('已连接', 'Connected') : t('未连接', 'Disconnected');
}

function ClientUpdateRailButton({ active, onOpen }: { active: boolean; onOpen(): void }) {
  const t = useText();
  const update = useClientUpdate();
  const status = update?.status;
  if (!update?.ready || !status?.release ||
      !['available', 'downloading', 'downloaded', 'waiting-tasks', 'installing'].includes(status.phase)) return null;
  const label = t('客户端更新 · ', 'Client update · ') + status.release.version;
  return (
    <button
      type="button"
      className={'rail-item' + (active ? ' active' : '')}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onOpen}
    >
      <span className="rail-icon-wrap rail-update-icon"><Download size={16} aria-hidden="true" /></span>
      <span className="rail-label">{t('更新', 'Update')}</span>
    </button>
  );
}

class App extends Component<AppProps, AppState> {
  private unsub: (() => void) | null = null;
  private unsubErrors: (() => void) | null = null;
  private unsubPending: (() => void) | null = null;
  private pendingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRead = 0;
  /** 同步在途标记：state.busy 在重渲染前不能防双击。 */
  private actionInFlight = false;
  private scopedKey = '';
  private scopedApi: DesktopViewApi | null = null;
  private devicesMounted = true;
  private devicesRequestId = 0;
  private refreshingProfiles = false;
  private lastRuntimeError: string | null = null;
  private pendingBotErrorShown = false;
  private lastPendingBotError: string | null = null;
  private centerAdminOpenerRef = createRef<HTMLButtonElement>();
  private settingsOpenerRef = createRef<HTMLButtonElement>();
  private workspaceReturnFocusEl: HTMLElement | null = null;
  private centerTransportCache: {
    api: DesktopPanelApi;
    identity: DesktopIdentity;
    transport: CenterTransport;
  } | null = null;
  /** 显式断开/connect 进行中不做恢复采纳：不得违背用户意图把 transport 重新置真。 */
  private suppressRecovery = false;
  /** 已应用的 broker generation；变化表示后端已重连，旧 UI 身份代次必须作废。 */
  private lastBrokerGeneration: number | undefined;

  private isTextInputFocused(): boolean {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return active.isContentEditable;
  }

  private hasOpenDialog(): boolean {
    return Boolean(
      document.querySelector(
        '[role="dialog"][data-state="open"], [data-ui-dialog="open"], [role="alertdialog"][data-state="open"]',
      ),
    );
  }

  private handleWorkspaceKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (this.state.view !== 'settings' && this.state.view !== 'center-admin') return;
    if (this.hasOpenDialog() || hasOpenFloatingPopover() || this.isTextInputFocused()) return;
    e.preventDefault();
    this.returnToWorkspace();
  };

  private reportActionError(message: string): void {
    if (this.state.view === 'settings') {
      this.setState((s) => ({
        globalError: message,
        globalErrorSeq: s.globalErrorSeq + 1,
      }));
    } else {
      this.pushErrorNotice('desktop-action-error', message);
    }
  }

  private getCenterTransport(): CenterTransport | null {
    const { api, centerConnection } = this.props;
    const identity = this.state.identity;
    if (!identity || centerConnection.status?.state !== 'ready') {
      this.centerTransportCache = null;
      return null;
    }
    if (
      this.centerTransportCache &&
      this.centerTransportCache.api === api &&
      this.centerTransportCache.identity === identity
    ) {
      return this.centerTransportCache.transport;
    }
    const transport = createBrokerCenterTransport((op, params) =>
      (api.broker as (id: DesktopIdentity, op: string, params: Record<string, unknown>) => Promise<unknown>)(
        identity,
        op,
        params,
      ),
    );
    this.centerTransportCache = { api, identity, transport };
    return transport;
  }

  /**
   * 与 broker transport 快照对齐（来自 Gate 普通轮询或手动检查）：
   * - phase 非 connected → transport 置 false；
   * - generation 变化（含 UI 一直 true 期间的后端重连）→ 先置 false 作废旧身份代次与观察，
   *   再重新置 true 安装新连接观察，组件按新 sess 重建只读观察；
   * - 仅当身份端点与当前 profile 的 relay url/deviceId 一致、且非显式断开/切换中时采纳。
   * 不发起 connect、不重放写入；显式断开（suppressRecovery）保持离线。
   */
  private applyBrokerSnapshot(broker: DesktopClientStatus | null | undefined): void {
    if (!broker || this.props.centerConnection.status?.state !== 'ready' || this.actionInFlight ||
        (this.lastBrokerGeneration !== undefined && broker.generation < this.lastBrokerGeneration)) return;
    const api = this.props.api;
    const identity = api.identity;
    if (!identity) return;
    const genChanged =
      this.lastBrokerGeneration !== undefined && broker.generation !== this.lastBrokerGeneration;
    this.lastBrokerGeneration = broker.generation;
    const conn = broker.connection;
    const profile = api.snapshot?.state.profiles.find((p) => p.id === identity.profileId);
    if (identity.kind === 'local') {
      // 中心可能接管原 transport；本机档案仅由显式连接置为在线。
      if (api.transportConnected && (genChanged || broker.phase !== 'connected' || conn?.kind !== 'local' ||
          conn.deviceId !== identity.targetDeviceId || profile?.url !== conn.url)) {
        api.setTransportConnected(false);
      }
      return;
    }
    if (broker.phase !== 'connected' || conn?.kind !== 'relay' || profile?.kind !== 'relay' ||
        profile.url !== conn.url || profile.deviceId !== conn.deviceId) {
      if (api.transportConnected) api.setTransportConnected(false);
      return;
    }
    if (this.suppressRecovery) return;
    if (genChanged && api.transportConnected) api.setTransportConnected(false);
    if (!api.transportConnected) {
      this.setState({ status: broker });
      api.setTransportConnected(true);
    }
  }

  /** 手动「检查连接」：只读 status 后走同一采纳路径；显式断开明确提示回设置重连。 */
  private checkConnection = async (): Promise<void> => {
    const { api, centerConnection, t } = this.props;
    const identity = api.identity;
    this.setState({ checkingConnection: true });
    try {
      if (centerConnection.status?.state !== 'ready') {
        await centerConnection.checkCenter();
        return;
      }
      if (!identity) {
        await this.refreshProfiles();
        return;
      }
      const st = await request('status', {});
      if (!this.devicesMounted || api.identity !== identity ||
          this.props.centerConnection.status?.state !== 'ready' ||
          this.props.centerConnection.status.broker !== centerConnection.status.broker) return;
      this.setState({ status: st });
      this.applyBrokerSnapshot(st);
      if (this.props.api.transportConnected) return;
      this.setState({
        connectionError:
          st.phase === 'disconnected'
            ? t('连接已断开：请在「设置」中重新连接中心或局域网直连档案。', 'Disconnected: reconnect to the center or a LAN direct profile in Settings.')
            : st.phase === 'connecting'
              ? t('连接已中断，正在恢复中…', 'Connection interrupted, recovering…')
              : t('连接不可用：请检查中心与网络后重试。', 'Connection unavailable: check the center and network, then retry.'),
      });
    } catch (e) {
      if (this.devicesMounted) {
        this.setState({
          connectionError: t('检查连接失败：', 'Connection check failed: ') + toError(e).message,
        });
      }
    } finally {
      if (this.devicesMounted) this.setState({ checkingConnection: false });
    }
  };

  private pushErrorNotice(id: string, message: string | null): void {
    const trimmed = message?.trim() ?? '';
    if (!trimmed) {
      this.props.notice.dismiss(id);
      return;
    }
    const parsed = humanizeError(trimmed, this.props.t);
    const title = parsed?.title || trimmed;
    const detailParts = [parsed?.description, parsed?.detail].filter(
      (part): part is string => Boolean(part && part.trim() && part.trim() !== title),
    );
    this.props.notice.notify({
      id,
      tone: parsed ? mapNoticeTone(parsed.tone) : 'error',
      title,
      detail: detailParts.length > 0 ? detailParts.join('\n') : undefined,
    });
  }

  constructor(props: AppProps) {
    super(props);
    this.state = {
      busy: true,
      profiles: [],
      profilesError: null,
      selectedProfileId: null,
      status: null,
      identity: null,
      transportConnected: false,
      view: 'chat',
      returnView: 'chat',
      token: '',
      ca: '',
      form: { title: '', kind: 'local', url: '', expectedDeviceId: '', deviceId: '' },
      globalError: null,
      globalErrorSeq: 0,
      connectionError: null,
      checkingConnection: false,
      selectedDeviceId: '',
      pendingAttention: null,
      taskWaitingCount: 0,
      settingsTab: 'connection',
      centerAdminTab: 'providers',
      profileTokens: {},
      devices: emptyDevices,
      archiveBridge: null,
    };
  }

  private handleArchiveBridge = (archiveBridge: BotChatsArchiveBridge | null): void => {
    this.setState({ archiveBridge });
  };

  private handleOpenArchivedBotHistory = (bot: BotDirectoryEntry): void => {
    this.state.archiveBridge?.openBotHistory(bot);
    this.setState({
      view: 'chat',
      returnView: 'chat',
      pendingTarget: undefined,
      pendingBotTarget: undefined,
      globalError: null,
    });
  };

  private captureWorkspaceOpener(fallback: HTMLElement | null): void {
    if (!isPrimaryView(this.state.view)) return;
    const active = document.activeElement;
    this.workspaceReturnFocusEl =
      active instanceof HTMLElement && active !== document.body ? active : fallback;
  }

  private openSettingsView = (tab?: SettingsTab): void => {
    this.captureWorkspaceOpener(this.settingsOpenerRef.current);
    this.setState((s) => ({
      view: 'settings',
      settingsTab: tab ?? s.settingsTab,
      returnView: isPrimaryView(s.view) ? s.view : s.returnView,
      pendingTarget: undefined,
    }));
  };

  private openCenterAdminSettings = (tab?: CenterAdminTab): void => {
    this.captureWorkspaceOpener(this.centerAdminOpenerRef.current);
    this.props.notice.dismiss('desktop-bot-deeplink');
    this.setState((s) => ({
      view: 'center-admin',
      centerAdminTab: tab ?? 'providers',
      returnView: isPrimaryView(s.view) ? s.view : s.returnView,
      pendingTarget: undefined,
      globalError: null,
    }));
  };

  private returnToWorkspace = (): void => {
    const fromView = this.state.view;
    const opener = this.workspaceReturnFocusEl;
    this.workspaceReturnFocusEl = null;
    this.setState(
      (s) => ({
        view: s.returnView,
        pendingTarget: undefined,
        globalError: null,
      }),
      () => {
        if (!this.devicesMounted) return;
        const fallback =
          fromView === 'center-admin'
            ? this.centerAdminOpenerRef.current
            : fromView === 'settings'
              ? this.settingsOpenerRef.current
              : null;
        const target = opener && opener.isConnected ? opener : fallback;
        target?.focus();
      },
    );
  };

  private openBotConversationPanel(
    bridge: BotChatsArchiveBridge,
    target: SendRecordsTarget,
    panel?: BotInspectorPanel,
  ): void {
    (bridge.openConversation as (target: SendRecordsTarget, panel?: BotInspectorPanel) => void)(target, panel);
  }

  private retryPendingBotNavigation = (): void => {
    const pendingTarget = this.state.pendingBotTarget;
    if (!pendingTarget) {
      this.props.notice.dismiss('desktop-bot-deeplink');
      return;
    }
    const bridge = this.state.archiveBridge;
    if (bridge?.conversationName(pendingTarget)) {
      this.openBotConversationPanel(
        bridge,
        { deviceId: pendingTarget.deviceId, botId: pendingTarget.botId },
        pendingTarget.panel,
      );
      this.pendingBotErrorShown = false;
      this.lastPendingBotError = null;
      this.props.notice.dismiss('desktop-bot-deeplink');
      this.setState({ pendingBotTarget: undefined });
      return;
    }
    this.pendingBotErrorShown = false;
    this.lastPendingBotError = null;
    this.props.notice.dismiss('desktop-bot-deeplink');
    if (bridge?.online && this.state.transportConnected) {
      bridge.refresh();
    } else {
      void this.checkConnection().then(() => {
        if (this.devicesMounted && this.state.pendingBotTarget && this.state.archiveBridge?.online) {
          this.state.archiveBridge.refresh();
        }
      });
    }
  };

  private notifyPendingBotError(errorMessage: string | null): void {
    const { t } = this.props;
    const parsed = errorMessage ? humanizeError(errorMessage, t) : null;
    const detail = parsed
      ? [parsed.title, parsed.description, parsed.detail].filter(Boolean).join('\n')
      : (errorMessage || undefined);
    this.props.notice.notify({
      id: 'desktop-bot-deeplink',
      tone: 'warning',
      title: t('暂无法同步智能体目录，请重试以打开目标智能体', 'Unable to sync agent directory — retry to open the target agent'),
      detail,
      sticky: true,
      action: {
        label: t('重试', 'Retry'),
        onClick: this.retryPendingBotNavigation,
      },
    });
  }

  private notifyPendingBotMissing(fromCenterAdminTab?: CenterAdminTab): void {
    const { t } = this.props;
    this.props.notice.notify({
      id: 'desktop-bot-deeplink',
      tone: 'warning',
      title: t('未找到目标智能体，可能已删除或尚未同步', 'Target agent not found — it may have been deleted or not yet synced'),
      sticky: true,
      action: {
        label: t('返回中心管理', 'Back to Center Admin'),
        onClick: () => {
          this.props.notice.dismiss('desktop-bot-deeplink');
          this.openCenterAdminSettings(fromCenterAdminTab ?? this.state.centerAdminTab);
        },
      },
    });
  }

  private handleOpenBotFromPet = (deviceId: string, botId: string): void => {
    this.handleOpenBotConversation(deviceId, botId);
  };

  private handleOpenBotConversation = (
    deviceId: string,
    botId: string,
    panel?: BotInspectorPanel,
  ): void => {
    const target: SendRecordsTarget = { deviceId, botId };
    this.pendingBotErrorShown = false;
    this.lastPendingBotError = null;
    this.props.notice.dismiss('desktop-bot-deeplink');
    if (this.state.archiveBridge?.conversationName(target)) {
      this.openBotConversationPanel(this.state.archiveBridge, target, panel);
      this.setState({
        view: 'chat',
        returnView: 'chat',
        pendingTarget: undefined,
        pendingBotTarget: undefined,
        globalError: null,
      });
    } else {
      const wasAlreadyChat = this.state.view === 'chat';
      const fromCenterAdminTab = this.state.view === 'center-admin' ? this.state.centerAdminTab : undefined;
      this.setState(
        {
          view: 'chat',
          returnView: 'chat',
          pendingTarget: undefined,
          pendingBotTarget: { deviceId, botId, panel, fromCenterAdminTab },
          globalError: null,
        },
        () => {
          if (!this.devicesMounted || !this.state.pendingBotTarget) return;
          const bridge = this.state.archiveBridge;
          if (!this.state.transportConnected || (bridge && !bridge.online)) {
            this.pendingBotErrorShown = true;
            this.lastPendingBotError = bridge?.error ?? null;
            this.notifyPendingBotError(bridge?.error ?? null);
          } else if (wasAlreadyChat && bridge && !bridge.loading) {
            bridge.refresh();
          }
        },
      );
    }
  };

  private pendingAttentionDevice(): string | undefined {
    const { api } = this.props;
    const identity = api.identity;
    if (!identity) return undefined;
    const message = this.state.pendingAttention;
    if (message?.identity === identity) return message.deviceId;
    return api.snapshot?.state.intents.find((intent) =>
      intent.profileId === identity.profileId && intent.outcome === 'unconfirmed' &&
      (identity.kind === 'relay' || intent.targetDeviceId === identity.targetDeviceId),
    )?.targetDeviceId;
  }

  private schedulePendingRefresh = (): void => {
    clearTimeout(this.pendingRefreshTimer);
    const identity = this.props.api.identity;
    const read = ++this.pendingRead;
    if (!identity) return;
    this.pendingRefreshTimer = setTimeout(async () => {
      const { api } = this.props;
      if (api.identity !== identity) return;
      try {
        const [unknown, queued] = await Promise.all([
          api.broker(identity, 'pending_list', { options: { state: 'unconfirmed', limit: 1 } }),
          api.broker(identity, 'pending_list', { options: { state: 'pending', limit: 1 } }),
        ]);
        if (!this.devicesMounted || read !== this.pendingRead || api.identity !== identity) return;
        const record = [...unknown.items, ...queued.items].find((item) =>
          identity.kind === 'relay' || item.targetDeviceId === identity.targetDeviceId,
        );
        this.setState({ pendingAttention: record ? { identity, deviceId: record.targetDeviceId } : null });
      } catch {
        if (this.devicesMounted && read === this.pendingRead && api.identity === identity) {
          this.setState({ pendingAttention: null });
        }
      }
    }, 180);
  };

  private openSendRecords = (target?: SendRecordsTarget): void => {
    if (!target && this.state.view === 'pending') return;
    const identity = this.props.api.identity;
    if (!identity || (target && identity.kind === 'local' && target.deviceId !== identity.targetDeviceId)) return;
    const attentionDevice = this.pendingAttentionDevice();
    this.setState((state) => ({
      view: 'pending',
      pendingTarget: target,
      returnView: isPrimaryView(state.view) ? state.view : state.returnView,
      selectedDeviceId: target?.deviceId || attentionDevice || state.selectedDeviceId || identity.targetDeviceId,
      globalError: null,
    }));
  };

  componentDidMount(): void {
    this.unsub = this.props.api.subscribe(() => {
      this.setState({
        profiles: this.props.api.snapshot ? this.props.api.snapshot.state.profiles : [],
        identity: this.props.api.identity,
        transportConnected: this.props.api.transportConnected,
      });
    });
    this.unsubErrors = this.props.api.subscribeErrors((message) => {
      if (message === this.lastRuntimeError) return;
      this.lastRuntimeError = message;
      this.pushErrorNotice('desktop-runtime-error', message);
    });
    this.unsubPending = this.props.api.subscribePending(this.schedulePendingRefresh);
    this.props.onRegisterOpenBot?.(this.handleOpenBotFromPet);
    window.addEventListener('keydown', this.handleWorkspaceKeyDown);
    void this.refreshProfiles();
    void this.loadDevices();
    this.schedulePendingRefresh();
  }

  componentWillUnmount(): void {
    this.devicesMounted = false;
    this.workspaceReturnFocusEl = null;
    this.props.onRegisterOpenBot?.(null);
    if (this.unsub) this.unsub();
    if (this.unsubErrors) this.unsubErrors();
    if (this.unsubPending) this.unsubPending();
    window.removeEventListener('keydown', this.handleWorkspaceKeyDown);
    clearTimeout(this.pendingRefreshTimer);
    this.props.notice.dismiss('desktop-global-error');
    this.props.notice.dismiss('desktop-runtime-error');
    this.props.notice.dismiss('desktop-action-error');
    this.props.notice.dismiss('desktop-bot-deeplink');
  }

  componentDidUpdate(prev: AppProps, prevState: AppState): void {
    if (prev.onRegisterOpenBot !== this.props.onRegisterOpenBot) {
      prev.onRegisterOpenBot?.(null);
      this.props.onRegisterOpenBot?.(this.handleOpenBotFromPet);
    }
    if (
      prevState.globalError !== this.state.globalError ||
      prevState.globalErrorSeq !== this.state.globalErrorSeq
    ) {
      this.pushErrorNotice('desktop-global-error', this.state.globalError);
    }
    const a = prevState.identity;
    const b = this.state.identity;
    if (a?.profileId !== b?.profileId || a?.kind !== b?.kind) {
      this.devicesRequestId += 1;
      this.pendingBotErrorShown = false;
      this.lastPendingBotError = null;
      this.props.notice.dismiss('desktop-bot-deeplink');
      this.setState(
        { devices: emptyDevices, pendingTarget: undefined, pendingBotTarget: undefined },
        () => void this.loadDevices(),
      );
    } else if (!prevState.transportConnected && this.state.transportConnected) {
      this.setState({ connectionError: null });
      void this.loadDevices();
    } else if (prevState.transportConnected && !this.state.transportConnected) {
      this.setState((s) => ({
        devices: { ...s.devices, busy: false, stale: s.devices.loaded },
        connectionError: s.identity
          ? this.props.t('连接已中断：远程操作暂不可用，目录为只读缓存。', 'Connection interrupted: remote actions are unavailable and the directory is read-only.')
          : s.connectionError,
      }));
    }
    if (a?.generation !== b?.generation || a?.profileId !== b?.profileId || a?.kind !== b?.kind ||
        (!prevState.transportConnected && this.state.transportConnected)) {
      this.schedulePendingRefresh();
    }
    // 从中心管理跳转到新建或尚未刷新的 Bot 会话：待 BotChats 目录刷新到目标后立即打开；
    // 区分目录错误（保留目标并提示重试）与确认缺失（提示未找到并提供返回中心管理入口）。
    if (this.state.pendingBotTarget) {
      const pendingTarget = this.state.pendingBotTarget;
      const bridge = this.state.archiveBridge;
      if (this.state.view !== 'chat') {
        this.pendingBotErrorShown = false;
        this.lastPendingBotError = null;
        this.props.notice.dismiss('desktop-bot-deeplink');
        this.setState({ pendingBotTarget: undefined });
      } else if (bridge?.conversationName(pendingTarget)) {
        const { deviceId, botId, panel } = pendingTarget;
        this.openBotConversationPanel(bridge, { deviceId, botId }, panel);
        this.pendingBotErrorShown = false;
        this.lastPendingBotError = null;
        this.props.notice.dismiss('desktop-bot-deeplink');
        this.setState({ pendingBotTarget: undefined });
      } else if (prevState.archiveBridge?.loading && bridge && !bridge.loading) {
        if (bridge.error) {
          if (!this.pendingBotErrorShown || this.lastPendingBotError !== bridge.error) {
            this.pendingBotErrorShown = true;
            this.lastPendingBotError = bridge.error;
            this.notifyPendingBotError(bridge.error);
          }
        } else {
          this.pendingBotErrorShown = false;
          this.lastPendingBotError = null;
          this.setState({ pendingBotTarget: undefined });
          this.notifyPendingBotMissing(pendingTarget.fromCenterAdminTab);
        }
      } else if (bridge && !bridge.loading && (!bridge.online || !this.state.transportConnected)) {
        const err = bridge.error ?? null;
        if (!this.pendingBotErrorShown || this.lastPendingBotError !== err) {
          this.pendingBotErrorShown = true;
          this.lastPendingBotError = err;
          this.notifyPendingBotError(err);
        }
      }
    }
    // 只采纳新快照，避免观察失败后被同一份过期 connected 快照反复激活。
    const center = this.props.centerConnection.status;
    if (prev.centerConnection.status?.state === 'ready' && center?.state !== 'ready') {
      this.lastBrokerGeneration = undefined;
    }
    if (prev.centerConnection.status?.broker !== center?.broker) {
      this.applyBrokerSnapshot(center?.broker);
      if (!this.props.api.identity && !this.actionInFlight && center?.broker?.phase === 'connected') {
        void this.refreshProfiles();
      }
    }
    // 待发送需要目标设备：目录读完后自动选中第一台在线设备；不强行选离线节点。
    if (this.state.identity && !this.state.selectedDeviceId) {
      const firstOnline = this.state.devices.items.find((d) => d.online);
      if (firstOnline) this.setState({ selectedDeviceId: firstOnline.deviceId });
    }
  }

  private async refreshProfiles(): Promise<void> {
    if (this.refreshingProfiles) return;
    this.refreshingProfiles = true;
    try {
      await this.props.api.init();
      const snap = this.props.api.snapshot;
      let profiles = snap ? snap.state.profiles : [];
      let adoptedProfileId: string | null = null;
      let adoptedStatus: DesktopClientStatus | null = null;
      if (!this.props.api.identity && !this.actionInFlight && this.props.centerConnection.status?.state === 'ready') {
        try {
          const st = this.props.centerConnection.status.broker ?? await request('status', {});
          const conn = st?.connection;
          if (st?.phase === 'connected' && conn?.kind === 'relay') {
            let relayProf = profiles.find((p) => p.kind === 'relay' && p.url === conn.url && p.deviceId === conn.deviceId);
            if (!relayProf) {
              const next: DesktopUiProfile = {
                id: runId(),
                title: 'Center Relay',
                kind: 'relay',
                url: conn.url,
                deviceId: conn.deviceId ?? '',
              };
              const updated = await this.props.api.queueWrite((state) => ({ ...state, profiles: [...state.profiles, next] }));
              profiles = updated.state.profiles;
              relayProf = profiles.find((p) => p.id === next.id) ?? next;
            }
            const center = this.props.centerConnection.status;
            const current = center?.broker;
            if (this.devicesMounted && !this.actionInFlight && !this.props.api.identity && center?.state === 'ready' &&
                (!current || (current.generation === st.generation && current.phase === 'connected' &&
                  current.connection?.kind === 'relay' && current.connection.url === conn.url &&
                  current.connection.deviceId === conn.deviceId))) {
              this.lastBrokerGeneration = st.generation;
              this.props.api.setIdentity({ profileId: relayProf.id, targetDeviceId: '', kind: 'relay' });
              this.props.api.setTransportConnected(true);
              adoptedProfileId = relayProf.id;
              adoptedStatus = st;
            }
          }
        } catch {
          /* ignore status read failure on cold init */
        }
      }
      this.setState((s) => ({
        busy: false,
        profiles,
        selectedProfileId: adoptedProfileId ?? (s.selectedProfileId && profiles.some((p) => p.id === s.selectedProfileId) ? s.selectedProfileId : (profiles.find((p) => p.kind === 'relay')?.id ?? profiles[0]?.id ?? null)),
        status: adoptedStatus ?? s.status,
        profilesError: null,
      }));
    } catch (e) {
      this.setState({
        busy: false,
        profilesError: this.props.t('无法读取配置：', 'Failed to read profiles: ') + toError(e).message,
      });
    } finally {
      this.refreshingProfiles = false;
    }
  }

  /* ---------- 设备目录（与连接同生同灭；待发送选择器与设置摘要共享一份读取） ---------- */

  /** 目录只属于一个连接（profile+kind+transport）；generation 变化不影响已读分页。 */
  private sameConnection(profileId: string, kind: 'local' | 'relay', generation: number): boolean {
    const identity = this.state.identity;
    return (
      !!identity &&
      this.state.transportConnected &&
      identity.profileId === profileId &&
      identity.kind === kind &&
      identity.generation === generation
    );
  }

  private async loadDevices(): Promise<void> {
    const identity = this.state.identity;
    if (!identity || !this.state.transportConnected || !this.devicesMounted) return;
    const { profileId, kind, generation } = identity;
    const reqId = ++this.devicesRequestId;
    this.setState((s) => ({ devices: { ...s.devices, busy: true, error: null } }));
    try {
      const page = await this.props.api.broker(identity, 'devices', { limit: 20, cursor: null });
      if (!this.devicesMounted || this.devicesRequestId !== reqId || !this.sameConnection(profileId, kind, generation)) return;
      this.setState({
        devices: {
          items: page.items,
          nextCursor: page.nextCursor,
          busy: false,
          error: null,
          loaded: true,
          loadedAt: new Date().toISOString(),
          stale: false,
        },
      });
    } catch (e) {
      if (!this.devicesMounted || this.devicesRequestId !== reqId || !this.sameConnection(profileId, kind, generation)) return;
      // 同一连接内换目标产生的迟到身份错误不作目录失败展示。
      const err = toError(e);
      this.setState((s) => ({
        devices: {
          ...s.devices,
          error: err.code === 'IDENTITY_CHANGED' ? null : err.message,
          busy: false,
          stale: s.devices.stale || (s.devices.loaded && err.code !== 'IDENTITY_CHANGED'),
        },
      }));
    }
  }

  private onLoadMoreDevices = async (): Promise<void> => {
    const identity = this.state.identity;
    const cursor = this.state.devices.nextCursor;
    if (!identity || !this.state.transportConnected || !this.devicesMounted || this.state.devices.busy || !cursor) {
      return;
    }
    const { profileId, kind, generation } = identity;
    const reqId = ++this.devicesRequestId;
    this.setState((s) => ({ devices: { ...s.devices, busy: true, error: null } }));
    try {
      const page = await this.props.api.broker(identity, 'devices', { limit: 20, cursor });
      if (!this.devicesMounted || this.devicesRequestId !== reqId || !this.sameConnection(profileId, kind, generation)) return;
      this.setState((s) => {
        const merged = new Map(s.devices.items.map((item) => [item.deviceId, item]));
        for (const item of page.items) merged.set(item.deviceId, item);
        return {
          devices: {
            items: Array.from(merged.values()),
            nextCursor: page.nextCursor,
            busy: false,
            error: null,
            loaded: true,
            loadedAt: new Date().toISOString(),
            stale: false,
          },
        };
      });
    } catch (e) {
      if (!this.devicesMounted || this.devicesRequestId !== reqId || !this.sameConnection(profileId, kind, generation)) return;
      const err = toError(e);
      this.setState((s) => ({
        devices: {
          ...s.devices,
          error: err.code === 'IDENTITY_CHANGED' ? null : err.message,
          busy: false,
          stale: s.devices.stale || (s.devices.loaded && err.code !== 'IDENTITY_CHANGED'),
        },
      }));
    }
  };

  /** 切换或断开中心连接：保留 Promise；gate reject 转可见错误而不是被吞。 */
  private async disconnectCenter(): Promise<void> {
    if (this.actionInFlight) return;
    this.actionInFlight = true;
    try {
      await this.props.centerConnection.disconnectCenter();
    } catch (e) {
      this.reportActionError(
        this.props.t('更换中心连接失败：', 'Failed to switch center connection: ') + toError(e).message,
      );
    } finally {
      this.actionInFlight = false;
    }
  }

  /* ---------- 连接档案 ---------- */

  private selectProfile(profile: DesktopUiProfile): void {
    if (profile.id === this.state.selectedProfileId) return;
    this.setState((s) => ({
      selectedProfileId: profile.id,
      token: s.profileTokens[profile.id] ?? '',
      globalError: null,
    }));
  }

  private async connect(): Promise<void> {
    const selected = this.state.profiles.find((p) => p.id === this.state.selectedProfileId);
    const profile = selected?.kind === 'local'
      ? selected
      : this.state.profiles.find((p) => p.kind === 'local') ?? selected;
    const token = profile ? (this.state.profileTokens[profile.id] ?? this.state.token) : this.state.token;
    const previousIdentity = this.state.identity;
    const previousDeviceId = this.state.selectedDeviceId;
    if (this.actionInFlight || !profile) return;
    let input: DesktopConnectionInput;
    if (profile.kind === 'local') {
      input = { kind: 'local', url: profile.url, token };
      if (profile.expectedDeviceId) input.expectedDeviceId = profile.expectedDeviceId;
    } else {
      input = { kind: 'relay', url: profile.url, deviceId: profile.deviceId, token };
      if (this.state.ca.trim()) input.ca = this.state.ca.trim();
    }
    this.actionInFlight = true;
    this.suppressRecovery = false;
    // 连接开始即封住旧身份并标记 transport 断开；迟到旧结果不能覆盖新选择。
    this.props.api.setTransportConnected(false);
    this.props.api.setIdentity(null);
    this.setState({ busy: true, globalError: null });
    try {
      const status = await this.props.api.broker(
        { profileId: profile.id, targetDeviceId: '', generation: 0, kind: profile.kind },
        'connect',
        { connection: input },
      );
      this.lastBrokerGeneration = status.generation;
      let targetDeviceId = '';
      if (status.connection && status.connection.kind === 'local') {
        targetDeviceId = status.connection.deviceId ?? '';
      }
      this.props.api.setIdentity({
        profileId: profile.id,
        targetDeviceId,
        kind: profile.kind,
      });
      // transport 连接以 status.phase === 'connected' 为准；不代表目标 Host 在线。
      this.props.api.setTransportConnected(status.phase === 'connected');
      this.lastRuntimeError = null;
      this.props.notice.dismiss('desktop-runtime-error');
      this.setState({
        busy: false,
        status,
        selectedDeviceId: targetDeviceId || (previousIdentity?.profileId === profile.id ? previousDeviceId : ''),
      });
    } catch (e) {
      this.setState((s) => ({
        busy: false,
        globalError: this.props.t('连接失败：', 'Connection failed: ') + toError(e).message,
        globalErrorSeq: s.globalErrorSeq + 1,
      }));
    } finally {
      // 保留各局域网调试档案输入态令牌，切换/重试不无故清空。
      this.actionInFlight = false;
      this.setState({ ca: '' });
    }
  }

  private async disconnect(): Promise<void> {
    const identity = this.state.identity;
    if (this.actionInFlight || !identity) return;
    this.actionInFlight = true;
    // 显式断开：禁止恢复探测在用户意图之外重新置真 transport。
    this.suppressRecovery = true;
    // 断开开始即封住旧身份（generation 增）并标记 transport 断开；保留队列 identity/目标。
    this.props.api.setTransportConnected(false);
    this.props.api.setIdentity({
      profileId: identity.profileId,
      targetDeviceId: identity.targetDeviceId,
      kind: identity.kind,
    });
    this.setState({ busy: true });
    try {
      const status = await this.props.api.broker(this.props.api.identity ?? identity, 'disconnect', {});
      this.setState({ busy: false, status });
    } catch (e) {
      this.props.api.reportError(e);
      this.setState({ busy: false });
    } finally {
      this.actionInFlight = false;
    }
  }

  private async saveProfile(e: { preventDefault(): void }): Promise<void> {
    e.preventDefault();
    const { form, profiles } = this.state;
    if (this.actionInFlight) return;
    if (profiles.length >= 16) {
      this.setState((s) => ({
        globalError: this.props.t('直连档案数量已达上限（16）。', 'Profile limit reached (16).'),
        globalErrorSeq: s.globalErrorSeq + 1,
      }));
      return;
    }
    let next: DesktopUiProfile;
    if (form.kind === 'local') {
      next = { id: runId(), title: form.title.trim() || form.url, kind: 'local', url: form.url.trim() };
      if (form.expectedDeviceId.trim()) next.expectedDeviceId = form.expectedDeviceId.trim();
    } else {
      next = {
        id: runId(),
        title: form.title.trim() || form.url,
        kind: 'relay',
        url: form.url.trim(),
        deviceId: form.deviceId.trim(),
      };
    }
    this.actionInFlight = true;
    try {
      await this.props.api.init();
      await this.props.api.queueWrite((s) => ({
        ...s,
        profiles: [...s.profiles, next],
      }));
      this.setState((s) => ({
        form: { title: '', kind: 'local', url: '', expectedDeviceId: '', deviceId: '' },
        selectedProfileId: next.id,
        token: s.profileTokens[next.id] ?? '',
        ca: '',
      }));
    } catch (e) {
      this.setState((s) => ({
        globalError: this.props.t('保存直连档案失败：', 'Failed to save profile: ') + toError(e).message,
        globalErrorSeq: s.globalErrorSeq + 1,
      }));
    } finally {
      this.actionInFlight = false;
    }
  }

  private deriveRailConnectionPhase(centerInterrupted: boolean): {
    phase: ConnectionPhase;
    reason: string | null;
  } {
    const { t } = this.props;
    const center = this.props.centerConnection.status;
    const { status, identity, transportConnected, connectionError } = this.state;
    if (centerInterrupted) {
      if (center?.state === 'connecting') {
        return { phase: 'connecting', reason: t('正在恢复中心连接…', 'Reconnecting to center…') };
      }
      return { phase: 'error', reason: t('中心连接不可用', 'Center connection unavailable') };
    }
    if (status?.phase === 'connecting') {
      return { phase: 'connecting', reason: connectionError ?? t('正在建立连接…', 'Connecting…') };
    }
    const techSuffix = status?.errorCode ? ` (phase=${status.phase} · errorCode=${status.errorCode})` : '';
    if (status?.phase === 'failed' || (connectionError && identity && !transportConnected)) {
      return {
        phase: 'error',
        reason: (connectionError ?? t('连接不可用：请检查中心与设备后重试。', 'Connection unavailable: check the center and devices, then retry.')) + techSuffix,
      };
    }
    if (!identity || !transportConnected) {
      return { phase: 'offline', reason: connectionError ?? null };
    }
    return { phase: 'online', reason: null };
  }

  /* ---------- 渲染 ---------- */

  render(): ReactNode {
    const { t } = this.props;
    const identity = this.state.identity;
    const transportConnected = this.state.transportConnected;
    const status = this.state.status;
    const phaseLabel = phaseText(status, transportConnected, t);
    const center = this.props.centerConnection.status;
    const centerInterrupted = center?.state !== 'ready' && !this.suppressRecovery;
    const selectedProfile = this.state.profiles.find((p) => p.id === this.state.selectedProfileId) ?? null;
    const showDeviceSelector = this.state.view === 'pending' && !!identity;
    const attentionDevice = this.pendingAttentionDevice();
    const railConn = this.deriveRailConnectionPhase(centerInterrupted);
    const endpointLabel = center?.centerUrl || selectedProfile?.url || null;
    return (
      <div className="desktop-shell">
        <aside className="desktop-rail" aria-label={t('主导航', 'Main navigation')}>
          <div className="rail-group">
            {(
              [
                { key: 'chat', label: t('对话', 'Chat'), Icon: MessageSquare },
                { key: 'tasks', label: t('任务', 'Tasks'), Icon: ClipboardCheck },
                { key: 'board', label: t('看板', 'Board'), Icon: LayoutDashboard },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                className={'rail-item' + (this.state.view === key ? ' active' : '')}
                onClick={() => {
                  this.workspaceReturnFocusEl = null;
                  this.setState({ view: key, returnView: key, pendingTarget: undefined, globalError: null });
                }}
                aria-pressed={this.state.view === key}
              >
                <span className="rail-icon-wrap">
                  <Icon size={18} aria-hidden="true" />
                  {key === 'tasks' && identity && this.state.taskWaitingCount > 0 && (
                    <span className="conn-dot needs-attention" aria-hidden="true" />
                  )}
                </span>
                <span className="rail-label">{label}</span>
              </button>
            ))}
            {(attentionDevice || this.state.view === 'pending') && (
              <button
                type="button"
                className={'rail-item' + (this.state.view === 'pending' ? ' active' : '')}
                onClick={() => this.openSendRecords()}
                aria-pressed={this.state.view === 'pending'}
                title={attentionDevice ? t('有待处理的发送记录', 'Pending deliveries require attention') : t('发送记录', 'Pending')}
              >
                <span className="rail-icon-wrap">
                  <FolderInput size={18} aria-hidden="true" />
                  {attentionDevice && <span className="conn-dot needs-attention" aria-hidden="true" />}
                </span>
                <span className="rail-label">{t('发送记录', 'Pending')}</span>
              </button>
            )}
          </div>
          <div className="rail-spacer" />
          <div className="rail-group">
            <ConnectionStatusPopover
              phase={railConn.phase}
              reason={railConn.reason}
              endpointLabel={endpointLabel}
              onRetry={() => this.checkConnection()}
              retrying={this.state.checkingConnection}
              onOpenSettings={() => this.openSettingsView('connection')}
              compact
              align="start"
              side="top"
              className="rail-conn-status"
            />
            <ClientUpdateRailButton
              active={this.state.view === 'settings' && this.state.settingsTab === 'updates'}
              onOpen={() => this.openSettingsView('updates')}
            />
            <button
              ref={this.centerAdminOpenerRef}
              type="button"
              className={'rail-item' + (this.state.view === 'center-admin' ? ' active' : '')}
              onClick={() => this.openCenterAdminSettings(this.state.centerAdminTab ?? 'providers')}
              aria-pressed={this.state.view === 'center-admin'}
              title={t('打开中心管理', 'Open Center Admin')}
            >
              <span className="rail-icon-wrap">
                <ServerCog size={18} aria-hidden="true" />
              </span>
              <span className="rail-label">{t('中心管理', 'Center')}</span>
            </button>
            <button
              ref={this.settingsOpenerRef}
              type="button"
              className={'rail-item' + (this.state.view === 'settings' ? ' active' : '')}
              onClick={() => this.openSettingsView()}
              aria-pressed={this.state.view === 'settings'}
              title={identity ? t('当前：', 'Status: ') + phaseLabel : t('打开设置', 'Open Settings')}
            >
              <span className="rail-icon-wrap">
                <Settings size={18} aria-hidden="true" />
              </span>
              <span className="rail-label">{t('设置', 'Settings')}</span>
            </button>
          </div>
        </aside>
        <main className="app-workspace">
          {centerInterrupted ? (
            <InlineBanner
              compact
              tone="attention"
              role="status"
              className="center-recovery-banner"
              title={
                center?.state === 'disconnected'
                  ? t('中心连接不可用', 'Center connection unavailable')
                  : t('正在恢复中心连接…', 'Reconnecting to center…')
              }
              detail={t('当前为只读离线缓存，草稿已保留；恢复连接后可继续操作。', 'Read-only offline cache; drafts are preserved until reconnected.')}
              actions={
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={this.state.checkingConnection}
                    onClick={() => void this.checkConnection()}
                  >
                    {this.state.checkingConnection ? t('重连中…', 'Reconnecting…') : t('重试连接', 'Retry connection')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void this.disconnectCenter()}
                  >
                    {t('更换中心连接', 'Switch center')}
                  </button>
                </>
              }
            />
          ) : null}
          <div className="workspace-body">
            {showDeviceSelector ? this.renderDeviceSelector() : null}
            {this.renderWorkspace(centerInterrupted)}
          </div>
        </main>
      </div>
    );
  }

  /** 发送记录可查看当前档案下已知的离线设备。 */
  private renderDeviceSelector(): ReactNode {
    const { t } = this.props;
    const { devices, pendingTarget, selectedDeviceId, archiveBridge, returnView } = this.state;
    const choiceMap = new Map<string, DevicesDirectoryItem>();
    for (const device of devices.items) {
      choiceMap.set(device.deviceId, device);
    }
    for (const device of archiveBridge?.devices ?? []) {
      if (!choiceMap.has(device.deviceId)) {
        choiceMap.set(device.deviceId, device);
      }
    }
    const choices = Array.from(choiceMap.values());
    const options: SelectOption<string>[] = [
      ...(selectedDeviceId && !choices.some((device) => device.deviceId === selectedDeviceId)
        ? [{ value: selectedDeviceId, label: t('目标设备', 'Target device') }]
        : []),
      ...choices.map((device) => ({
        value: device.deviceId,
        label:
          (device.displayName || t('未命名设备', 'Unnamed device')) +
          (device.online && this.state.transportConnected ? '' : t('（离线）', ' (offline)')),
      })),
    ];
    return (
      <div className="device-selector">
        <button
          type="button"
          className="secondary-button"
          onClick={() => this.setState({ view: returnView, pendingTarget: undefined })}
        >
          <ArrowLeft size={14} aria-hidden="true" /> {pendingTarget ? t('返回原会话', 'Back to chat') : t('返回', 'Back')}
        </button>
        <div className="pending-device-picker">
          <span className="device-selector-label">{t('设备', 'Device')}</span>
          <Select
            size="sm"
            className="pending-device-select"
            value={selectedDeviceId}
            onChange={(next) => this.setState({ selectedDeviceId: next, pendingTarget: undefined })}
            options={options}
            placeholder={devices.busy ? t('正在读取设备…', 'Loading devices…') : t('选择设备', 'Select device')}
            ariaLabel={t('选择设备', 'Select device')}
          />
        </div>
        {devices.nextCursor !== null && (
          <button
            type="button"
            className="secondary-button"
            disabled={devices.busy || !this.state.transportConnected}
            onClick={() => void this.onLoadMoreDevices()}
          >
            {devices.busy ? t('正在加载设备…', 'Loading devices…') : t('加载更多设备', 'Load more devices')}
          </button>
        )}
        {devices.error && (
          <button type="button" className="secondary-button" onClick={() => void this.loadDevices()}>
            {t('刷新设备', 'Refresh devices')}
          </button>
        )}
      </div>
    );
  }

  private renderSettingsView(): ReactNode {
    const identity = this.state.identity;
    const selectedProfile = this.state.profiles.find((p) => p.id === this.state.selectedProfileId) ?? null;
    const localSel = selectedProfile?.kind === 'local'
      ? selectedProfile
      : this.state.profiles.find((p) => p.kind === 'local') ?? selectedProfile;

    return (
      <SettingsPanel
        activeTab={this.state.settingsTab}
        onTabChange={(settingsTab) => this.setState({ settingsTab })}
        onBack={this.returnToWorkspace}
        onOpenCenterAdmin={this.openCenterAdminSettings}
        profiles={this.state.profiles}
        profilesError={this.state.profilesError}
        profilesBusy={this.state.busy}
        selectedProfile={selectedProfile}
        onSelectProfile={(p) => this.selectProfile(p)}
        form={this.state.form}
        onFormChange={(patch) => this.setState((s) => ({ form: { ...s.form, ...patch } }))}
        onSaveProfile={(e) => void this.saveProfile(e)}
        token={localSel ? (this.state.profileTokens[localSel.id] ?? this.state.token) : this.state.token}
        onTokenChange={(token) => this.setState((s) => {
          const curSel = s.profiles.find((p) => p.id === s.selectedProfileId) ?? null;
          const targetLocal = curSel?.kind === 'local'
            ? curSel
            : s.profiles.find((p) => p.kind === 'local') ?? curSel;
          return {
            token,
            profileTokens: targetLocal ? { ...s.profileTokens, [targetLocal.id]: token } : s.profileTokens,
          };
        })}
        onConnect={() => void this.connect()}
        onDisconnect={() => void this.disconnect()}
        identity={identity}
        transportConnected={this.state.transportConnected}
        status={this.state.status}
        centerStatus={this.props.centerConnection.status}
        onDisconnectCenter={() => this.disconnectCenter()}
        onSaveCenterCa={(ca) => this.props.centerConnection.saveCenterCa(ca)}
        devices={this.state.devices}
        currentDeviceId={this.state.status?.connection?.deviceId ?? ''}
        theme={this.props.theme}
        onThemeChange={this.props.setTheme}
        actionError={this.state.globalError}
        onDismissActionError={() => this.setState({ globalError: null })}
        archiveBridge={this.state.archiveBridge}
        onOpenArchivedBotHistory={this.handleOpenArchivedBotHistory}
      />
    );
  }

  private renderCenterAdminView(): ReactNode {
    const { t } = this.props;
    const center = this.props.centerConnection.status;
    const centerTransport = this.getCenterTransport();

    const headerBar = (
      <header
        className="desktop-center-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-3) var(--space-6)',
          borderBottom: '1px solid var(--line)',
          flexShrink: 0,
        }}
      >
        <button type="button" className="quiet-button" onClick={this.returnToWorkspace}>
          <ArrowLeft size={15} aria-hidden />
          <span>{t('返回', 'Back')}</span>
        </button>
        <h2 className="desktop-settings-title">{t('中心管理', 'Center Admin')}</h2>
        {center?.centerUrl ? (
          <span
            className="metadata"
            style={{
              marginLeft: 'auto',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {center.centerUrl}
          </span>
        ) : null}
      </header>
    );

    if (!centerTransport) {
      return (
        <div className="desktop-center-view">
          {headerBar}
          <div className="desktop-center-inner">
            <div className="settings-empty-card">
              <h4>{t('尚未连接到 PiBot 中心', 'Not connected to PiBot Center')}</h4>
              <p className="metadata">
                {t(
                  '绑定并连接中心后，可在此直接管理模型服务商、设备、扩展能力、密码库、Webhook 与版本发布。',
                  'Connect to a center to manage model providers, devices, capabilities, vault, webhooks, and releases.',
                )}
              </p>
              <button
                type="button"
                className="primary-button"
                onClick={() => this.openSettingsView('connection')}
              >
                {t('前往连接与本机服务', 'Open Connection & Service')}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="desktop-center-view">
        {headerBar}
        <CenterAdminPanel
          transport={centerTransport}
          activeTab={this.state.centerAdminTab}
          onTabChange={(centerAdminTab) => this.setState({ centerAdminTab })}
          centerUrl={center?.centerUrl}
          onOpenExternal={() => void openCenterManagement(center?.centerUrl)}
          onOpenExternalUrl={(url) => openCenterManagement(url)}
          onConfigureBot={(deviceId, botId) => this.handleOpenBotConversation(deviceId, botId, 'profile')}
          onStartGoogleSetupWizard={
            this.state.archiveBridge
              ? (deviceId, botId) => this.handleOpenBotConversation(deviceId, botId, 'google-setup')
              : undefined
          }
        />
      </div>
    );
  }

  private renderWorkspace(centerInterrupted: boolean): ReactNode {
    const { t } = this.props;
    const view = this.state.view;
    const api = this.props.api;
    const identity = this.state.identity;
    const transportConnected = this.state.transportConnected;
    const pageActive = this.props.pageActive !== false;
    const snapshot = api.snapshot;

    const isBotChatsView = isPrimaryView(view);
    const primaryView: AppView =
      view === 'settings' || view === 'center-admin' ? this.state.returnView : view;
    const needsArchiveBridge = view === 'settings' && this.state.settingsTab === 'advanced';

    let overlayWorkspaceNode: ReactNode = null;
    if (view === 'settings') {
      overlayWorkspaceNode = this.renderSettingsView();
    } else if (view === 'center-admin') {
      overlayWorkspaceNode = this.renderCenterAdminView();
    } else if (view === 'pending' && identity && snapshot) {
      const deviceId = this.state.selectedDeviceId;
      if (!deviceId || (identity.kind === 'local' && deviceId !== identity.targetDeviceId)) {
        overlayWorkspaceNode = <div className="empty-state">{t('选择设备后查看发送记录。', 'Select a device to view pending records.')}</div>;
      } else {
        const viewKey = JSON.stringify([identity.profileId, identity.kind, deviceId]);
        const key = JSON.stringify([viewKey, identity.generation]);
        if (this.scopedKey !== key) {
          this.scopedKey = key;
          this.scopedApi = targetApi(api, deviceId);
        }
        const device = this.state.devices.items.find((item) => item.deviceId === deviceId)
          ?? this.state.archiveBridge?.devices.find((item) => item.deviceId === deviceId);
        overlayWorkspaceNode = (
          <div className="device-view">
            <PendingPanel
              key={viewKey}
              api={api}
              identity={this.scopedApi!.identity}
              transportConnected={transportConnected && device?.online !== false}
              target={this.state.pendingTarget}
              onClearTarget={() => this.setState({ pendingTarget: undefined })}
              conversationName={this.state.archiveBridge?.conversationName}
              onOpenConversation={(target) => {
                this.state.archiveBridge?.openConversation(target);
                this.setState({ view: 'chat', returnView: 'chat', pendingTarget: undefined });
              }}
            />
          </div>
        );
      }
    }

    if (!identity || !snapshot) {
      if (overlayWorkspaceNode) return overlayWorkspaceNode;
      return (
        <div className="empty-state">
          <p>{t('请先连接中心或本机服务（左下角「设置」）。', 'Connect to a center or local service in Settings first.')}</p>
        </div>
      );
    }

    return (
      <>
        <div className={isBotChatsView ? 'chat-workspace-host' : 'chat-workspace-host workspace-hidden'}>
          <BotChats
            api={api}
            currentDeviceId={this.state.status?.connection?.deviceId ?? ''}
            pageActive={pageActive && (isBotChatsView || needsArchiveBridge)}
            workspaceActive={pageActive && isBotChatsView}
            boardActive={primaryView === 'board'}
            tasksActive={primaryView === 'tasks'}
            centerInterrupted={centerInterrupted}
            onOpenBoardChat={() => this.setState({ view: 'chat', returnView: 'chat' })}
            onSwitchView={(next) => this.setState({ view: next, returnView: next })}
            onTaskWaitingCountChange={(count) => {
              if (this.state.taskWaitingCount !== count) {
                this.setState({ taskWaitingCount: count });
              }
            }}
            onArchiveBridge={this.handleArchiveBridge}
            onOpenSendRecords={this.openSendRecords}
            onOpenCenterAdmin={this.openCenterAdminSettings}
          />
        </div>
        {overlayWorkspaceNode}
      </>
    );
  }
}

/** CenterGate 就绪后注入 hook 状态到 class App；App 保持类组件（大量既有生命周期逻辑）。 */
function AppShell({
  api,
  pageActive,
  onRegisterOpenBot,
}: {
  api: DesktopPanelApi;
  pageActive?: boolean;
  onRegisterOpenBot?: (handler: ((deviceId: string, botId: string) => void) | null) => void;
}) {
  const centerConnection = useCenterConnection();
  const { theme, setTheme } = useDesktopTheme();
  const notice = useNotice();
  const t = useText();
  return (
    <App
      api={api}
      pageActive={pageActive}
      centerConnection={centerConnection}
      theme={theme}
      setTheme={setTheme}
      notice={notice}
      t={t}
      onRegisterOpenBot={onRegisterOpenBot}
    />
  );
}

/** 应用装配 ErrorBoundary：
 * 加载失败显示明确错误，提供只读重试。 */
export class DesktopApp extends Component<
  {
    api: DesktopPanelApi;
    pageActive?: boolean;
    onRegisterOpenBot?: (handler: ((deviceId: string, botId: string) => void) | null) => void;
  },
  { failed: string | null }
> {
  state = { failed: null as string | null };

  private centerInterrupted = () => {
    this.props.api.setTransportConnected(false);
  };

  private centerDisconnected = () => {
    this.props.api.setTransportConnected(false);
    this.props.api.setIdentity(null);
  };

  static getDerivedStateFromError(error: unknown): { failed: string } {
    return { failed: error instanceof DesktopRemoteError ? error.message : String(error) };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="desktop-shell error-shell">
          <InlineBanner
            tone="danger"
            title={this.state.failed}
            actions={
              <button type="button" className="primary-button" onClick={() => this.setState({ failed: null })}>
                重试
              </button>
            }
          />
        </div>
      );
    }
    return (
      <CenterGate onInterrupted={this.centerInterrupted} onDisconnected={this.centerDisconnected}>
        <AppShell
          api={this.props.api}
          pageActive={this.props.pageActive}
          onRegisterOpenBot={this.props.onRegisterOpenBot}
        />
      </CenterGate>
    );
  }
}
