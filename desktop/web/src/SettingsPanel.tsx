// 设置和归档均由 App 提供对话框。连接凭据只保存在输入态。
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowLeft, Check, ChevronRight, Copy, Download, ExternalLink, Globe, Monitor, Pencil,
  RefreshCw, RotateCcw, Server, SunMoon, Trash2, X,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { DesktopClientStatus, DesktopUiProfile } from '../../../host-core/desktop-client.js';
import type { BotDirectoryEntry, DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity } from './types';
import { openCenterManagement, type DesktopTheme } from './CenterGate';
import { HostServiceSection, useHostService } from './HostServiceSection';
import { ClientUpdateSection, useClientUpdateSummary } from '../../../web/src/ClientUpdateSection';
import { GrokBotAvatar } from '../../../web/src/GrokBotAvatar';
import { botAvatarKey } from '../../../web/src/botAvatarSync';
import { archiveExpiryAt, type BotChatsArchiveBridge } from './BotChats';

interface ProfileFormState {
  title: string;
  kind: 'local' | 'relay';
  url: string;
  expectedDeviceId: string;
  deviceId: string;
}

export interface DevicesSectionState {
  items: DevicesDirectoryItem[];
  nextCursor: { afterDeviceId: string } | null;
  error: string | null;
  busy: boolean;
  /** 成功读取过目录的时间；失败或加载中仍保留上次结果。 */
  loadedAt: string | null;
  loaded: boolean;
  stale: boolean;
}

interface CenterStatusLite {
  state: 'disconnected' | 'connecting' | 'ready';
  centerUrl: string;
  clientId: string;
}

export interface SettingsPanelProps {
  profiles: DesktopUiProfile[];
  profilesError: string | null;
  profilesBusy: boolean;
  selectedProfile: DesktopUiProfile | null;
  onSelectProfile(profile: DesktopUiProfile): void;
  form: ProfileFormState;
  onFormChange(patch: Partial<ProfileFormState>): void;
  onSaveProfile(event: FormEvent): void;
  token: string;
  ca: string;
  onTokenChange(value: string): void;
  onCaChange(value: string): void;
  onConnect(): void;
  onDisconnect(): void;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  status: DesktopClientStatus | null;
  phaseLabel: string;
  centerStatus: CenterStatusLite | undefined;
  onDisconnectCenter(): Promise<void>;
  devices: DevicesSectionState;
  devicesIsRelay: boolean;
  lastObservedAt: string | null;
  currentDeviceId: string;
  theme: DesktopTheme;
  onThemeChange(theme: DesktopTheme): void;
  onRefreshDevices(): void;
  onLoadMoreDevices(): void;
  onRenameDevice(item: DevicesDirectoryItem, displayName: string): void;
  onDeviceError(message: string): void;
  actionError: string | null;
  onDismissActionError(): void;
  archiveOpen: boolean;
  archiveBridge?: BotChatsArchiveBridge | null;
  onOpenArchivedBotHistory?(bot: BotDirectoryEntry): void;
}

const CONNECTION_TYPES = { local: '直连设备', relay: '经中心连接' } as const;
const THEMES: Record<DesktopTheme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

function DeviceRow({ item, isRelay, local, online, busy, lastObservedAt, onRename, onError }: {
  item: DevicesDirectoryItem;
  isRelay: boolean;
  local: boolean;
  online: boolean | null;
  busy: boolean;
  lastObservedAt: string | null;
  onRename(item: DevicesDirectoryItem, displayName: string): void;
  onError(message: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const commit = () => {
    if (busy) return;
    const name = value.trim();
    if (!name || name.length > 120) {
      onError('设备名称须为 1–120 字符。');
      return;
    }
    if (name !== item.displayName) onRename(item, name);
    setEditing(false);
  };

  return (
    <li className="settings-device-item">
      {editing ? (
        <div className="rename-inline">
          <input
            autoFocus
            value={value}
            maxLength={120}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') {
                event.stopPropagation();
                setEditing(false);
              }
            }}
            aria-label="设备名称"
          />
          <button type="button" className="icon-button" onClick={commit} disabled={busy} aria-label="保存名称"><Check size={14} aria-hidden /></button>
          <button type="button" className="icon-button" onClick={() => setEditing(false)} aria-label="取消改名"><X size={14} aria-hidden /></button>
        </div>
      ) : (
        <>
          <details className="settings-disclosure settings-device">
            <summary>
              <span className="settings-device-name">
                <strong>{item.displayName || '未命名设备'}</strong>
                {local && <span className="metadata">本机</span>}
              </span>
              <span className={online ? 'status online' : 'metadata'}>{online === null ? '状态未知' : online ? '在线' : '离线'}</span>
            </summary>
            <div className="settings-device-details">
              <div className="metadata">设备 ID {item.deviceId}</div>
              {isRelay && <div className="metadata">控制协议 {item.controlProtocol} · 群聊协议 {item.scopeProtocol}</div>}
              {lastObservedAt && <div className="metadata">最近读取 {lastObservedAt}</div>}
            </div>
          </details>
          {isRelay && (
            <button type="button" className="icon-button" onClick={() => { setValue(item.displayName); setEditing(true); }} disabled={busy} aria-label={'重命名设备 ' + (item.displayName || '未命名设备')}>
              <Pencil size={14} aria-hidden />
            </button>
          )}
        </>
      )}
    </li>
  );
}

function ArchivedBots({ bridge, onOpenHistory }: {
  bridge?: BotChatsArchiveBridge | null;
  onOpenHistory?: (bot: BotDirectoryEntry) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState('');
  const items = bridge?.archivedBots ?? [];

  const run = async (bot: BotDirectoryEntry, action: 'restore' | 'delete') => {
    if (!bridge || busy) return;
    const key = JSON.stringify([bot.deviceId, bot.botId]);
    setBusy(key);
    setError('');
    try {
      if (action === 'restore') await bridge.unarchiveBot(bot);
      else {
        await bridge.deleteBot(bot);
        setConfirmDelete(null);
      }
    } catch (failure) {
      setError((action === 'restore' ? '恢复失败 · ' : '永久删除失败 · ') +
        (failure instanceof Error ? failure.message : String(failure)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section archived-bots-subpage">
      <div className="section-head">
        <h4>已归档 {items.length} 个</h4>
        <button type="button" className="secondary-button" disabled={!bridge?.online || bridge.loading} onClick={() => bridge?.refresh()}>
          <RefreshCw size={13} aria-hidden /> 刷新
        </button>
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {bridge?.error && <p className="error-banner" role="alert">{bridge.error}</p>}
      {items.length === 0 ? (
        <p className="empty-state">{bridge?.loading ? '正在读取归档…' : '暂无已归档的智能体。'}</p>
      ) : (
        <ul className="archived-bot-list">
          {items.map((bot) => {
            const key = JSON.stringify([bot.deviceId, bot.botId]);
            const online = Boolean(bridge?.online && bot.online);
            const device = bridge?.devices.find((item) => item.deviceId === bot.deviceId)?.displayName || bot.deviceName || '未命名设备';
            const expiry = archiveExpiryAt(bot.archivedAt);
            return (
              <li className="archived-bot-card" key={key}>
                <div className="archived-bot-row">
                  <button type="button" className="archived-bot-open" onClick={() => onOpenHistory?.(bot)} aria-label={'查看' + bot.role + '的历史'}>
                    <GrokBotAvatar botKey={botAvatarKey(bot)} roleName={bot.role} isPrimary={false} platformBadge={bot.platform || 'host'} size={36} />
                    <span className="archived-bot-info">
                      <strong>{bot.role}</strong>
                      <span className="metadata">{device} · {online ? '在线' : '离线'}</span>
                      <span className="metadata">{expiry === null ? '清理日期未知' : '自动清理于 ' + new Date(expiry).toLocaleDateString()}</span>
                    </span>
                  </button>
                  <div className="archived-bot-actions">
                    <button type="button" className="primary-button" disabled={!online || busy !== null} onClick={() => void run(bot, 'restore')}>
                      <RotateCcw size={13} aria-hidden /> {busy === key ? '处理中…' : '恢复'}
                    </button>
                    <details className="archive-more settings-diagnostics">
                      <summary>更多</summary>
                      <button type="button" className="secondary-button danger-outline" disabled={!online || busy !== null} onClick={() => { setError(''); setConfirmDelete(key); }}>
                        <Trash2 size={13} aria-hidden /> 永久删除
                      </button>
                    </details>
                  </div>
                </div>
                {confirmDelete === key && (
                  <div className="confirm-delete-banner archived-confirm-banner" role="alert">
                    <span>永久删除 {device} 上的「{bot.role}」及其聊天历史？</span>
                    <div className="confirm-delete-actions">
                      <button type="button" className="secondary-button" disabled={busy !== null} onClick={() => setConfirmDelete(null)}>取消</button>
                      <button type="button" className="primary-button danger-button" disabled={!online || busy !== null} onClick={() => void run(bot, 'delete')}>
                        {busy === key ? '删除中…' : '确认永久删除'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ConnectionProfiles(props: SettingsPanelProps) {
  const { profiles, profilesBusy, profilesError, form, selectedProfile, transportConnected, identity, status } = props;
  const activeProfile = profiles.find((profile) => profile.id === identity?.profileId);
  const selectedIsActive = Boolean(selectedProfile && activeProfile?.id === selectedProfile.id && transportConnected);
  return (
    <>
      <section className="settings-section">
        <div className="section-head"><h4>连接档案</h4></div>
        {activeProfile && <p className="status">{activeProfile.title} · {props.phaseLabel}</p>}
        {profilesError && <p className="error-banner" role="alert">{profilesError}</p>}
        {profiles.length > 0 ? (
          <ul className="profile-list">
            {profiles.map((profile) => (
              <li key={profile.id} className={profile.id === selectedProfile?.id ? 'selected' : undefined}>
                <button type="button" className="profile-row" aria-pressed={profile.id === selectedProfile?.id} onClick={() => props.onSelectProfile(profile)}>
                  <strong>{profile.title}</strong>
                  <span className="metadata">{CONNECTION_TYPES[profile.kind]}</span>
                  {transportConnected && activeProfile?.id === profile.id && <span className="status ok">当前连接</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="empty-state">暂无连接档案。</p>}
        <details className="settings-disclosure">
          <summary>新增连接</summary>
          <form className="form-grid" onSubmit={props.onSaveProfile}>
            <label>
              名称（可选）
              <input value={form.title} onChange={(event) => props.onFormChange({ title: event.target.value })} />
            </label>
            <label>
              连接方式
              <select value={form.kind} onChange={(event) => props.onFormChange({ kind: event.target.value as 'local' | 'relay' })}>
                <option value="local">直连设备</option>
                <option value="relay">经中心连接</option>
              </select>
            </label>
            <label className="form-grid-full">
              {form.kind === 'local' ? '设备地址' : '中继地址'}
              <input required type="url" value={form.url} onChange={(event) => props.onFormChange({ url: event.target.value })} />
            </label>
            {form.kind === 'local' ? (
              <label className="form-grid-full">
                期望设备 ID（可选）
                <input value={form.expectedDeviceId} onChange={(event) => props.onFormChange({ expectedDeviceId: event.target.value })} />
              </label>
            ) : (
              <label className="form-grid-full">
                设备 ID
                <input required value={form.deviceId} onChange={(event) => props.onFormChange({ deviceId: event.target.value })} />
              </label>
            )}
            <div className="form-grid-full">
              <button type="submit" className="primary-button" disabled={profilesBusy}>保存档案</button>
            </div>
          </form>
        </details>
      </section>
      {selectedProfile && (
        <section className="settings-section">
          <div className="section-head"><h4>{selectedProfile.title}</h4></div>
          <p className="metadata">{CONNECTION_TYPES[selectedProfile.kind]} · {selectedProfile.url}</p>
          {selectedIsActive ? (
            <button type="button" className="secondary-button" onClick={props.onDisconnect} disabled={profilesBusy}>断开连接</button>
          ) : (
            <div className="settings-connect">
              <label>
                {selectedProfile.kind === 'local' ? '本机连接令牌' : '中心设备令牌'}
                <input type="password" autoComplete="off" value={props.token} onChange={(event) => props.onTokenChange(event.target.value)} />
              </label>
              {selectedProfile.kind === 'relay' && (
                <details className="settings-diagnostics">
                  <summary>自签证书（可选）</summary>
                  <label>
                    CA 证书
                    <textarea value={props.ca} onChange={(event) => props.onCaChange(event.target.value)} />
                  </label>
                </details>
              )}
              <div className="dialog-actions">
                <button type="button" className="primary-button" onClick={props.onConnect} disabled={profilesBusy}>
                  {transportConnected ? '切换到此连接' : '连接'}
                </button>
              </div>
            </div>
          )}
          {status && (
            <details className="settings-diagnostics">
              <summary>连接诊断</summary>
              <div className="metadata">连接代次 {status.generation} · {status.phase}{status.errorCode ? ' · ' + status.errorCode : ''}</div>
            </details>
          )}
        </section>
      )}
    </>
  );
}

const SETTINGS_TITLES = {
  overview: '设置',
  connection: '中心连接',
  devices: '设备',
  update: '客户端更新',
  appearance: '外观',
  runtime: '本机服务',
  profiles: '手动连接设备',
} as const;

type SettingsPage = keyof typeof SETTINGS_TITLES;

function SettingsLink({ page, icon, summary, tone, onOpen }: {
  page: Exclude<SettingsPage, 'overview'>;
  icon: ReactNode;
  summary?: ReactNode;
  tone?: 'online' | 'busy';
  onOpen(page: SettingsPage): void;
}) {
  return (
    <button type="button" className="settings-row settings-row-link" data-settings-page={page} onClick={() => onOpen(page)}>
      <span className="settings-row-icon" aria-hidden="true">{icon}</span>
      <span className="settings-row-label">{SETTINGS_TITLES[page]}</span>
      {summary && <span className={tone ? 'status ' + tone : 'metadata'}>{summary}</span>}
      <ChevronRight className="settings-row-chevron" size={15} aria-hidden />
    </button>
  );
}

function CenterConnectionSettings({ centerStatus, onDisconnectCenter }: Pick<SettingsPanelProps, 'centerStatus' | 'onDisconnectCenter'>) {
  const [copied, setCopied] = useState(false);
  const [managementError, setManagementError] = useState('');
  const clientId = centerStatus?.clientId;

  const copyClientId = () => {
    if (!clientId) return;
    void navigator.clipboard.writeText(clientId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <>
      <div className="settings-row-group">
        {centerStatus?.centerUrl && (
          <div className="settings-row">
            <span className="settings-row-label">中心地址</span>
            <span className="metadata">{centerStatus.centerUrl}</span>
          </div>
        )}
        <button type="button" className="settings-row settings-row-link" onClick={() => {
          setManagementError('');
          void openCenterManagement(centerStatus?.centerUrl).catch(() => setManagementError('暂时无法打开中心管理。'));
        }}>
          <span className="settings-row-label">在浏览器打开中心管理</span>
          <ExternalLink className="settings-row-chevron" size={15} aria-hidden />
        </button>
        <button type="button" className="settings-row settings-row-link" onClick={() => void onDisconnectCenter()}>
          <span className="settings-row-label">更换中心连接</span>
          <ChevronRight className="settings-row-chevron" size={15} aria-hidden />
        </button>
      </div>
      {managementError && <p className="error-banner" role="alert">{managementError}</p>}
      {clientId && (
        <details className="settings-section settings-diagnostics">
          <summary>连接详情</summary>
          <div className="settings-client-id">
            <span>客户端 {clientId}</span>
            <button type="button" className="icon-button" onClick={copyClientId} aria-label={copied ? '已复制客户端标识' : '复制客户端标识'}>
              {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
            </button>
          </div>
        </details>
      )}
    </>
  );
}

function ClientSettings(props: SettingsPanelProps) {
  const [page, setPage] = useState<SettingsPage>('overview');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const nextFocus = useRef<SettingsPage | 'title' | null>(null);
  const hostService = useHostService();
  const updateSummary = useClientUpdateSummary();
  const { centerStatus, devices, transportConnected, devicesIsRelay, identity } = props;
  const centerReady = centerStatus?.state === 'ready';
  const centerConnecting = centerStatus?.state === 'connecting';
  const centerLabel = centerReady ? '已连接' : centerConnecting ? '正在恢复连接' : '未连接';
  const centerTone = centerReady ? 'online' : centerConnecting ? 'busy' : undefined;
  const localDeviceId = identity?.kind === 'local' ? props.currentDeviceId
    : hostService.host?.configured ? hostService.host.deviceId : null;

  const deviceStatusCurrent = transportConnected && !devices.stale;
  const showingLastDirectory = devices.loaded && !deviceStatusCurrent;
  let deviceSummary = devices.busy ? '正在读取' : '尚未读取';
  if (showingLastDirectory) deviceSummary = '上次读取';
  else if (!transportConnected) deviceSummary = '等待连接';
  else if (devices.loaded) {
    deviceSummary = devices.nextCursor ? '已读取 ' + devices.items.length + ' 台'
      : devices.items.length ? devices.items.filter((item) => item.online).length + ' 台在线' : '暂无设备';
  } else if (devices.error) deviceSummary = '读取失败';

  const openPage = (next: SettingsPage) => {
    nextFocus.current = 'title';
    setPage(next);
  };

  const goBack = () => {
    nextFocus.current = page;
    setPage(page === 'runtime' || page === 'profiles' ? 'devices' : 'overview');
  };

  useLayoutEffect(() => {
    const focus = nextFocus.current;
    if (!focus) return;
    nextFocus.current = null;
    const body = bodyRef.current;
    if (body) body.scrollTop = 0;
    const link = focus === 'title' ? null : body?.querySelector<HTMLButtonElement>(`[data-settings-page="${focus}"]`);
    (link ?? titleRef.current)?.focus();
  }, [page]);

  return (
    <>
      <div className="dialog-head">
        {page !== 'overview' && (
          <button type="button" className="icon-button" onClick={goBack} aria-label={page === 'runtime' || page === 'profiles' ? '返回设备' : '返回设置'}>
            <ArrowLeft size={16} aria-hidden />
          </button>
        )}
        <Dialog.Title className="dialog-title" ref={titleRef} tabIndex={-1}>{SETTINGS_TITLES[page]}</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="icon-button" aria-label="关闭"><X size={16} aria-hidden /></button></Dialog.Close>
      </div>
      <Dialog.Description className={page === 'connection' ? 'dialog-desc' : 'sr-only'}>
        {page === 'connection' ? centerLabel : '管理中心连接、设备和客户端。'}
      </Dialog.Description>
      <div className="dialog-body" ref={bodyRef}>
        {props.actionError && (page === 'connection' || page === 'profiles') && (
          <div className="error-banner" role="alert">
            <span className="error-banner-text">{props.actionError}</span>
            <div className="error-banner-actions">
              <button type="button" onClick={props.onDismissActionError}>关闭</button>
            </div>
          </div>
        )}
        {page === 'overview' && (
          <div className="settings-row-group">
            <SettingsLink page="connection" icon={<Globe size={17} />} summary={centerLabel} tone={centerTone} onOpen={openPage} />
            <SettingsLink page="devices" icon={<Monitor size={17} />} summary={deviceSummary} onOpen={openPage} />
            <SettingsLink page="update" icon={<Download size={17} />} summary={updateSummary} onOpen={openPage} />
            <SettingsLink page="appearance" icon={<SunMoon size={17} />} summary={THEMES[props.theme]} onOpen={openPage} />
          </div>
        )}
        {page === 'connection' && <CenterConnectionSettings centerStatus={centerStatus} onDisconnectCenter={props.onDisconnectCenter} />}
        {page === 'devices' && (
          <>
            <section className="settings-section">
              <div className="section-head">
                <h4>设备列表</h4>
                <button type="button" className="icon-button" onClick={props.onRefreshDevices} disabled={devices.busy || !transportConnected} aria-label="刷新设备">
                  <RefreshCw size={15} aria-hidden />
                </button>
              </div>
              {devices.error && <p className="error-banner" role="alert">{devices.error}</p>}
              {showingLastDirectory && <p className="metadata">正在查看上次读取的设备。</p>}
              {devices.items.length ? (
                <ul className="device-list settings-directory">
                  {devices.items.map((item) => (
                    <DeviceRow key={item.deviceId} item={item} isRelay={devicesIsRelay}
                      local={item.deviceId === localDeviceId} online={deviceStatusCurrent ? item.online : null} busy={devices.busy || !transportConnected}
                      lastObservedAt={props.lastObservedAt ?? devices.loadedAt} onRename={props.onRenameDevice} onError={props.onDeviceError} />
                  ))}
                </ul>
              ) : <p className="metadata">{deviceSummary}</p>}
              {devicesIsRelay && devices.nextCursor && (
                <button type="button" className="secondary-button" onClick={props.onLoadMoreDevices} disabled={devices.busy || !transportConnected}>加载更多</button>
              )}
            </section>
            <div className="settings-row-group">
              <SettingsLink page="runtime" icon={<Server size={17} />} summary={hostService.summary} onOpen={openPage} />
              <SettingsLink page="profiles" icon={<Monitor size={17} />} onOpen={openPage} />
            </div>
          </>
        )}
        {page === 'runtime' && <HostServiceSection service={hostService} />}
        {page === 'profiles' && <ConnectionProfiles {...props} />}
        {page === 'update' && <ClientUpdateSection variant="desktop" />}
        {page === 'appearance' && (
          <div className="settings-row-group" role="group" aria-label="外观主题">
            {(Object.keys(THEMES) as DesktopTheme[]).map((theme) => (
              <label key={theme} className="settings-row settings-row-link">
                <span className="settings-row-label">{THEMES[theme]}</span>
                <input type="radio" name="desktop-theme" checked={props.theme === theme} onChange={() => props.onThemeChange(theme)} />
              </label>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  if (!props.archiveOpen) return <ClientSettings {...props} />;
  return (
    <>
      <div className="dialog-head">
        <Dialog.Title className="dialog-title">已归档智能体</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="icon-button" aria-label="关闭"><X size={16} aria-hidden /></button></Dialog.Close>
      </div>
      <Dialog.Description className="dialog-desc">归档后的智能体将在 14 天后自动清理。</Dialog.Description>
      <div className="dialog-body">
        <ArchivedBots bridge={props.archiveBridge} onOpenHistory={props.onOpenArchivedBotHistory} />
      </div>
    </>
  );
}
