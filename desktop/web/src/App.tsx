// Module 17 desktop 应用装配（core-owned，stage1 修正）：连接管理、设备目录、
// 导航与面板渲染。token/CA 仅输入态存在，连接尝试结束后立即清空。
import { Component } from 'react';
import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft,
  FolderInput,
  LayoutDashboard,
  MessageSquare,
  Settings,
} from 'lucide-react';
import { DesktopRemoteError, request, toError } from './api';
import type {
  DesktopClientStatus,
  DesktopConnectionInput,
  DesktopUiProfile,
} from '../../../host-core/desktop-client.js';
import type { BotDirectoryEntry, DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { PendingPanel } from './PendingPanel';
import { SettingsPanel } from './SettingsPanel';
import { BotChats, type BotChatsArchiveBridge, type SendRecordsTarget } from './BotChats';
import {
  CenterGate,
  useCenterConnection,
  useDesktopTheme,
} from './CenterGate';
import { targetApi } from './targetApi';
import type { DesktopViewApi } from './types';
import './DesktopShell.css';

interface ProfileFormState {
  title: string;
  kind: 'local' | 'relay';
  url: string;
  expectedDeviceId: string;
  deviceId: string;
}

interface DevicesSectionState {
  items: DevicesDirectoryItem[];
  nextCursor: { afterDeviceId: string } | null;
  error: string | null;
  busy: boolean;
  /** 成功读取过目录的时间；仅用于展示，失败/加载中不得冒充为空目录。 */
  loadedAt: string | null;
  loaded: boolean;
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
  view: 'chat' | 'board' | 'pending';
  token: string;
  ca: string;
  form: ProfileFormState;
  globalError: string | null;
  bannerError: string | null;
  /** transport/relay 断开提示（可恢复）；与请求级 bannerError 分离，目标 OFFLINE 不会进入此横幅。 */
  connectionError: string | null;
  selectedDeviceId: string;
  pendingTarget?: SendRecordsTarget;
  pendingReturnView: 'chat' | 'board';
  pendingAttention: { identity: DesktopIdentity; deviceId: string } | null;
  settingsOpen: boolean;
  settingsPage: 'general' | 'archive';
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
}

function runId(): string {
  return 'p-' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8);
}

const emptyDevices: DevicesSectionState = {
  items: [],
  nextCursor: null,
  error: null,
  busy: false,
  loadedAt: null,
  loaded: false,
};

/** 实际连接状态统一口径：transport 已断开/身份已作废时，缓存的 connected 不得再当在线。
 * connecting 仍是当前正在连接，failed 指上次连接失败；纯展示，不新增 broker 调用、不自动重连。 */
function phaseText(status: DesktopClientStatus | null, transportConnected: boolean): string {
  if (!status) return '未连接';
  if (status.phase === 'connecting') return '连接中';
  if (status.phase === 'failed') return '连接失败';
  return status.phase === 'connected' && transportConnected ? '已连接' : '未连接';
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
  private refreshingProfiles = false;
  private settingsButtonRef: HTMLButtonElement | null = null;
  /** 显式断开/connect 进行中不做恢复采纳：不得违背用户意图把 transport 重新置真。 */
  private suppressRecovery = false;
  /** 已应用的 broker generation；变化表示后端已重连，旧 UI 身份代次必须作废。 */
  private lastBrokerGeneration: number | undefined;

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
    const { api, centerConnection } = this.props;
    const identity = api.identity;
    if (!identity) return;
    if (centerConnection.status?.state !== 'ready') {
      await centerConnection.checkCenter();
      return;
    }
    try {
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
            ? '已断开：请在设置中选择 profile 后显式连接。'
            : st.phase === 'connecting'
              ? '连接已中断，正在恢复中…'
              : '连接不可用：请检查中心与设备后重试。',
      });
    } catch (e) {
      if (this.devicesMounted) this.setState({ connectionError: '检查连接失败：' + toError(e).message });
    }
  };

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
      token: '',
      ca: '',
      form: { title: '', kind: 'local', url: '', expectedDeviceId: '', deviceId: '' },
      globalError: null,
      bannerError: null,
      connectionError: null,
      selectedDeviceId: '',
      pendingReturnView: 'chat',
      pendingAttention: null,
      settingsOpen: false,
      settingsPage: 'general',
      devices: emptyDevices,
      archiveBridge: null,
    };
  }

  private handleArchiveBridge = (archiveBridge: BotChatsArchiveBridge | null): void => {
    this.setState({ archiveBridge });
  };

  private handleOpenArchivedBotHistory = (bot: BotDirectoryEntry): void => {
    this.state.archiveBridge?.openBotHistory(bot);
    this.setState({ view: 'chat', settingsOpen: false });
  };

  private handleOpenArchived = (): void => {
    this.setState({ settingsOpen: true, settingsPage: 'archive' });
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
      pendingReturnView: state.view === 'pending' ? state.pendingReturnView : state.view,
      selectedDeviceId: target?.deviceId || attentionDevice || state.selectedDeviceId || identity.targetDeviceId,
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
      this.setState({ bannerError: message });
    });
    this.unsubPending = this.props.api.subscribePending(this.schedulePendingRefresh);
    void this.refreshProfiles();
    void this.loadDevices();
    this.schedulePendingRefresh();
  }

  componentWillUnmount(): void {
    this.devicesMounted = false;
    if (this.unsub) this.unsub();
    if (this.unsubErrors) this.unsubErrors();
    if (this.unsubPending) this.unsubPending();
    clearTimeout(this.pendingRefreshTimer);
  }

  componentDidUpdate(prev: AppProps, prevState: AppState): void {
    const a = prevState.identity;
    const b = this.state.identity;
    if (a?.profileId !== b?.profileId || a?.kind !== b?.kind) {
      this.setState({ devices: emptyDevices, pendingTarget: undefined }, () => void this.loadDevices());
    } else if (!prevState.transportConnected && this.state.transportConnected) {
      this.setState({ connectionError: null });
      void this.loadDevices();
    } else if (prevState.transportConnected && !this.state.transportConnected) {
      this.setState((s) => ({
        devices: { ...s.devices, busy: false },
        connectionError: s.identity
          ? '连接已中断：远程操作不可用，目录为只读缓存。'
          : s.connectionError,
      }));
    }
    if (a?.generation !== b?.generation || a?.profileId !== b?.profileId || a?.kind !== b?.kind ||
        (!prevState.transportConnected && this.state.transportConnected)) {
      this.schedulePendingRefresh();
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
    // 群聊/待发送需要目标设备：目录读完后自动选中第一台在线设备；不强行选离线节点。
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
      this.setState({ busy: false, profilesError: '无法读取配置：' + toError(e).message });
    } finally {
      this.refreshingProfiles = false;
    }
  }

  /* ---------- 设备目录（与连接同生同灭；群聊/待发送选择器与弹窗共享一份读取） ---------- */

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
    this.setState((s) => ({ devices: { ...s.devices, busy: true, error: null } }));
    try {
      const page = await this.props.api.broker(identity, 'devices', { limit: 20, cursor: null });
      if (!this.devicesMounted || !this.sameConnection(profileId, kind, generation)) return;
      this.setState({
        devices: {
          items: page.items,
          nextCursor: page.nextCursor,
          busy: false,
          error: null,
          loaded: true,
          loadedAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      if (!this.devicesMounted || !this.sameConnection(profileId, kind, generation)) return;
      // 同一连接内换目标产生的迟到身份错误不作目录失败展示。
      const err = toError(e);
      this.setState((s) => ({
        devices: {
          ...s.devices,
          error: err.code === 'IDENTITY_CHANGED' ? null : err.message,
          busy: false,
        },
      }));
    }
  }

  private async loadMoreDevices(): Promise<void> {
    const identity = this.state.identity;
    if (!identity || !this.state.transportConnected || !this.state.devices.nextCursor) return;
    const { profileId, kind, generation } = identity;
    this.setState((s) => ({ devices: { ...s.devices, busy: true } }));
    try {
      const page = await this.props.api.broker(identity, 'devices', {
        limit: 20,
        cursor: this.state.devices.nextCursor,
      });
      if (!this.devicesMounted || !this.sameConnection(profileId, kind, generation)) return;
      this.setState((s) => ({
        devices: {
          ...s.devices,
          items: [...s.devices.items, ...page.items],
          nextCursor: page.nextCursor,
          busy: false,
          loadedAt: new Date().toISOString(),
        },
      }));
    } catch (e) {
      if (!this.devicesMounted || !this.sameConnection(profileId, kind, generation)) return;
      const err = toError(e);
      this.setState((s) => ({
        devices: {
          ...s.devices,
          error: err.code === 'IDENTITY_CHANGED' ? null : err.message,
          busy: false,
        },
      }));
    }
  }

  /** 行内改名（仅 relay）：成功后重读目录；失败明确提示核对，不冒充已改。 */
  private async renameDevice(item: DevicesDirectoryItem, displayName: string): Promise<void> {
    const identity = this.state.identity;
    if (!identity || identity.kind !== 'relay' || !this.state.transportConnected || this.state.devices.busy) return;
    this.setState((s) => ({ devices: { ...s.devices, busy: true, error: null } }));
    try {
      await this.props.api.broker(identity, 'rename_device', { deviceId: item.deviceId, displayName });
      if (!this.devicesMounted || !this.sameConnection(identity.profileId, identity.kind, identity.generation)) return;
      await this.loadDevices();
    } catch (e) {
      if (!this.devicesMounted || !this.sameConnection(identity.profileId, identity.kind, identity.generation)) return;
      this.setState((s) => ({
        devices: {
          ...s.devices,
          busy: false,
          error: '改名失败或结果未确认：' + toError(e).message + '；请刷新目录核对。',
        },
      }));
    }
  }

  /** 更换中心连接：保留 Promise；gate reject 转可见错误而不是被吞。 */
  private async disconnectCenter(): Promise<void> {
    if (this.actionInFlight) return;
    this.actionInFlight = true;
    try {
      await this.props.centerConnection.disconnectCenter();
    } catch (e) {
      this.setState({ globalError: '更换中心连接失败：' + toError(e).message });
    } finally {
      this.actionInFlight = false;
    }
  }

  /* ---------- 连接档案 ---------- */

  private selectProfile(profile: DesktopUiProfile): void {
    if (profile.id === this.state.selectedProfileId) return;
    this.setState({ selectedProfileId: profile.id, token: '', ca: '', globalError: null });
  }

  private async connect(): Promise<void> {
    const profile = this.state.profiles.find((p) => p.id === this.state.selectedProfileId);
    const token = this.state.token;
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
      this.setState({ busy: false, status, bannerError: null, selectedDeviceId: targetDeviceId || (previousIdentity?.profileId === profile.id ? previousDeviceId : '') });
    } catch (e) {
      this.setState({ busy: false, globalError: '连接失败：' + toError(e).message });
    } finally {
      // 无论成败都清输入，不保存 token/CA 副本。
      this.actionInFlight = false;
      this.setState({ token: '', ca: '' });
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
      this.setState({ globalError: 'profile 已达上限 16' });
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
      this.setState({
        form: { title: '', kind: 'local', url: '', expectedDeviceId: '', deviceId: '' },
        selectedProfileId: next.id,
        token: '',
        ca: '',
      });
    } catch (e) {
      this.setState({ globalError: '保存 profile 失败：' + toError(e).message });
    } finally {
      this.actionInFlight = false;
    }
  }

  /* ---------- 渲染 ---------- */

  render(): ReactNode {
    const identity = this.state.identity;
    const transportConnected = this.state.transportConnected;
    const status = this.state.status;
    const phaseLabel = phaseText(status, transportConnected);
    const center = this.props.centerConnection.status;
    const centerInterrupted = center?.state !== 'ready' && !this.suppressRecovery;
    const selectedProfile = this.state.profiles.find((p) => p.id === this.state.selectedProfileId) ?? null;
    const showDeviceSelector = this.state.view === 'pending' && !!identity;
    const attentionDevice = this.pendingAttentionDevice();
    return (
      <div className="desktop-shell">
        <aside className="desktop-rail">
          <div className="rail-group">
            {(
              [
                { key: 'chat', label: '对话', Icon: MessageSquare },
                { key: 'board', label: '看板', Icon: LayoutDashboard },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                className={'rail-item' + (this.state.view === key ? ' active' : '')}
                onClick={() => this.setState({ view: key })}
                aria-pressed={this.state.view === key}
              >
                <Icon size={18} aria-hidden />
                <span className="rail-label">{label}</span>
              </button>
            ))}
            {(attentionDevice || this.state.view === 'pending') && (
              <button
                type="button"
                className={'rail-item' + (this.state.view === 'pending' ? ' active' : '')}
                onClick={() => this.openSendRecords()}
                aria-pressed={this.state.view === 'pending'}
                title={attentionDevice ? '有待处理的发送记录' : '发送记录'}
              >
                <span className="rail-icon-wrap">
                  <FolderInput size={18} aria-hidden />
                  {attentionDevice && <span className="conn-dot needs-attention" />}
                </span>
                <span className="rail-label">发送记录</span>
              </button>
            )}
          </div>
          <div className="rail-spacer" />
          <div className="rail-group">
            <button
              type="button"
              className="rail-item"
              ref={(el) => { this.settingsButtonRef = el; }}
              onClick={() => this.setState({ settingsOpen: true, settingsPage: 'general' })}
              title={identity ? '当前：' + phaseLabel : '打开连接与节点设置'}
            >
              <span className="rail-icon-wrap">
                <Settings size={18} aria-hidden />
                <span className={'conn-dot ' + (transportConnected ? 'online' : 'offline')} />
              </span>
              <span className="rail-label">设置</span>
            </button>
          </div>
        </aside>
        <main className="app-workspace">
          {this.state.globalError && (
            <div className="error-banner" role="alert">
              <span className="error-banner-text">{this.state.globalError}</span>
              <div className="error-banner-actions">
                <button type="button" onClick={() => this.setState({ globalError: null })}>关闭</button>
              </div>
            </div>
          )}
          {this.state.bannerError && (
            <div className="error-banner" role="alert">
              <span className="error-banner-text">{this.state.bannerError}</span>
              <div className="error-banner-actions">
                <button type="button" onClick={() => this.setState({ bannerError: null })}>关闭</button>
              </div>
            </div>
          )}
          {centerInterrupted && (
            <div className="center-recovery">
              <span role="status">{center?.state === 'disconnected' ? '中心连接不可用' : '正在恢复中心连接…'}</span>
              <button type="button" className="secondary-button" onClick={() => void this.disconnectCenter()}>
                更换中心连接
              </button>
            </div>
          )}
          {!centerInterrupted && this.state.connectionError && identity && !transportConnected && (
            <div className="error-banner" role="alert">
              <span className="error-banner-text">
                {this.state.connectionError}
                {status?.errorCode ? (
                  <details>
                    <summary>技术详情</summary>
                    <code>{'phase=' + status.phase + ' · errorCode=' + status.errorCode}</code>
                  </details>
                ) : null}
              </span>
              <div className="error-banner-actions">
                <button type="button" onClick={() => void this.checkConnection()}>检查连接</button>
                <button type="button" onClick={() => this.setState({ connectionError: null })}>关闭</button>
              </div>
            </div>
          )}
          <div className="workspace-body">
            {showDeviceSelector ? this.renderDeviceSelector() : null}
            {this.renderWorkspace(centerInterrupted)}
          </div>
        </main>
        <Dialog.Root open={this.state.settingsOpen} onOpenChange={(open) => this.setState({ settingsOpen: open })}>
          <Dialog.Portal>
            <Dialog.Overlay className="desktop-dialog-overlay settings-dialog-overlay" />
            <Dialog.Content className="desktop-dialog settings-dialog" onCloseAutoFocus={(e) => { e.preventDefault(); this.settingsButtonRef?.focus(); }}>
              <SettingsPanel
                profiles={this.state.profiles}
                profilesError={this.state.profilesError}
                profilesBusy={this.state.busy}
                selectedProfile={selectedProfile}
                onSelectProfile={(p) => this.selectProfile(p)}
                form={this.state.form}
                onFormChange={(patch) => this.setState((s) => ({ form: { ...s.form, ...patch } }))}
                onSaveProfile={(e) => void this.saveProfile(e)}
                token={this.state.token}
                ca={this.state.ca}
                onTokenChange={(token) => this.setState({ token })}
                onCaChange={(ca) => this.setState({ ca })}
                onConnect={() => void this.connect()}
                onDisconnect={() => void this.disconnect()}
                identity={identity}
                transportConnected={transportConnected}
                status={this.state.status}
                phaseLabel={phaseLabel}
                centerStatus={center}
                onDisconnectCenter={() => this.disconnectCenter()}
                devices={this.state.devices}
                devicesIsRelay={identity?.kind === 'relay'}
                lastObservedAt={status?.lastObservedAt ?? null}
                currentDeviceId={status?.connection?.deviceId ?? ''}
                theme={this.props.theme}
                onThemeChange={this.props.setTheme}
                onRefreshDevices={() => void this.loadDevices()}
                onLoadMoreDevices={() => void this.loadMoreDevices()}
                onRenameDevice={(item, name) => void this.renameDevice(item, name)}
                onDeviceError={(message) => this.setState((s) => ({ devices: { ...s.devices, error: message } }))}
                archiveBridge={this.state.archiveBridge}
                archiveOpen={this.state.settingsPage === 'archive'}
                onOpenArchivedBotHistory={this.handleOpenArchivedBotHistory}
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    );
  }

  /** 发送记录可查看当前档案下已知的离线设备。 */
  private renderDeviceSelector(): ReactNode {
    const { devices, pendingTarget, selectedDeviceId, archiveBridge, pendingReturnView } = this.state;
    const choices = devices.items.length > 0 ? devices.items : archiveBridge?.devices ?? [];
    return (
      <div className="device-selector">
        <button type="button" className="secondary-button" onClick={() => this.setState({ view: pendingReturnView, pendingTarget: undefined })}>
          <ArrowLeft size={14} aria-hidden /> {pendingTarget ? '返回原会话' : '返回'}
        </button>
        <label className="pending-device-picker">
          <span className="device-selector-label">设备</span>
          <select
            value={selectedDeviceId}
            onChange={(e) => this.setState({ selectedDeviceId: e.target.value, pendingTarget: undefined })}
          >
            <option value="">{devices.busy ? '正在读取设备…' : '选择设备'}</option>
            {selectedDeviceId && !choices.some((device) => device.deviceId === selectedDeviceId) &&
              <option value={selectedDeviceId}>目标设备</option>}
            {choices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {(device.displayName || '未命名设备') + (device.online && this.state.transportConnected ? '' : '（离线）')}
              </option>
            ))}
          </select>
        </label>
        {devices.error && <button type="button" className="secondary-button" onClick={() => void this.loadDevices()}>刷新设备</button>}
      </div>
    );
  }

  private renderWorkspace(centerInterrupted: boolean): ReactNode {
    const view = this.state.view;
    const api = this.props.api;
    const identity = this.state.identity;
    const transportConnected = this.state.transportConnected;
    const pageActive = this.props.pageActive !== false;
    const snapshot = api.snapshot;
    if (!identity || !snapshot) return <div className="empty-state">请先连接 Host 或中继（左下角「设置」）。</div>;
    let pendingNode: ReactNode = null;
    if (view === 'pending') {
      const deviceId = this.state.selectedDeviceId;
      if (!deviceId || (identity.kind === 'local' && deviceId !== identity.targetDeviceId)) {
        pendingNode = <div className="empty-state">选择设备后查看发送记录。</div>;
      } else {
        const viewKey = JSON.stringify([identity.profileId, identity.kind, deviceId]);
        const key = JSON.stringify([viewKey, identity.generation]);
        if (this.scopedKey !== key) {
          this.scopedKey = key;
          this.scopedApi = targetApi(api, deviceId);
        }
        const device = this.state.devices.items.find((item) => item.deviceId === deviceId)
          ?? this.state.archiveBridge?.devices.find((item) => item.deviceId === deviceId);
        pendingNode = (
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
                this.setState({ view: 'chat', pendingTarget: undefined });
              }}
            />
          </div>
        );
      }
    }
    return (
      <>
        <div className={view !== 'pending' ? 'chat-workspace-host' : 'chat-workspace-host workspace-hidden'}>
          <BotChats
            api={api}
            currentDeviceId={this.state.status?.connection?.deviceId ?? ''}
            pageActive={pageActive && (view !== 'pending' || this.state.settingsOpen)}
            workspaceActive={pageActive && view !== 'pending' && !this.state.settingsOpen}
            boardActive={view === 'board'}
            centerInterrupted={centerInterrupted}
            onOpenBoardChat={() => this.setState({ view: 'chat' })}
            onArchiveBridge={this.handleArchiveBridge}
            onOpenSendRecords={this.openSendRecords}
            onOpenArchived={this.handleOpenArchived}
          />
        </div>
        {pendingNode}
      </>
    );
  }
}

/** CenterGate 就绪后注入 hook 状态到 class App；App 保持类组件（大量既有生命周期逻辑）。 */
function AppShell({ api, pageActive }: { api: DesktopPanelApi; pageActive?: boolean }) {
  const centerConnection = useCenterConnection();
  const { theme, setTheme } = useDesktopTheme();
  return (
    <App
      api={api}
      pageActive={pageActive}
      centerConnection={centerConnection}
      theme={theme}
      setTheme={setTheme}
    />
  );
}

/** 应用装配 ErrorBoundary：
 * 加载失败显示明确错误，提供只读重试。 */
export class DesktopApp extends Component<{ api: DesktopPanelApi; pageActive?: boolean }, { failed: string | null }> {
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
          <div className="error-banner" role="alert">{this.state.failed}</div>
          <button onClick={() => this.setState({ failed: null })}>重试</button>
        </div>
      );
    }
    return (
      <CenterGate onInterrupted={this.centerInterrupted} onDisconnected={this.centerDisconnected}>
        <AppShell api={this.props.api} pageActive={this.props.pageActive} />
      </CenterGate>
    );
  }
}
