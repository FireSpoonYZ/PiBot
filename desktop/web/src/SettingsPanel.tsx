// 桌面客户端设置分栏。
import * as Dialog from '@radix-ui/react-dialog';
import {
  Archive, Check, ChevronDown, Copy, Download, Globe, Pencil, RefreshCw, RotateCcw, Server, ShieldCheck, Sliders, Trash2, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DesktopClientStatus, DesktopUiProfile } from '../../../host-core/desktop-client.js';
import type { BotDirectoryEntry, DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { openCenterManagement, type DesktopTheme } from './CenterGate';
import { HostServiceSection, useHostService } from './HostServiceSection';
import { ClientUpdateSection } from '../../../web/src/ClientUpdateSection';
import { Switch } from '../../../web/src/bot-settings/primitives';
import { CenterAdminPanel, createBrokerCenterTransport, createCenterApi } from '../../../web/src/center-admin';
import { RemoveDeviceDialog } from '../../../web/src/center-admin/RemoveDeviceDialog';
import { GrokBotAvatar } from '../../../web/src/GrokBotAvatar';
import { botAvatarKey } from '../../../web/src/botAvatarSync';
import { ErrorNotice, useCollapseToolOutput, useHideToolOutput, useText } from '../../../web/src/ui';
import { archiveExpiryAt, type BotChatsArchiveBridge } from './BotChats';

export type SettingsTab = 'connection' | 'center-admin' | 'runtime' | 'general' | 'archive' | 'updates';
import type { CenterAdminTab } from '../../../web/src/center-admin/types';
export type { CenterAdminTab } from '../../../web/src/center-admin/types';

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
  savedConnection?: { url: string; deviceId: string; ca: string };
}

export interface SettingsPanelProps {
  api: DesktopPanelApi;
  activeTab: SettingsTab;
  onTabChange(tab: SettingsTab): void;
  centerAdminTab?: CenterAdminTab;
  profiles: DesktopUiProfile[];
  profilesError: string | null;
  profilesBusy: boolean;
  selectedProfile: DesktopUiProfile | null;
  onSelectProfile(profile: DesktopUiProfile): void;
  form: ProfileFormState;
  onFormChange(patch: Partial<ProfileFormState>): void;
  onSaveProfile(event: FormEvent): void;
  token: string;
  onTokenChange(value: string): void;
  onConnect(): void;
  onDisconnect(): void;
  identity: DesktopIdentity | null;
  transportConnected: boolean;
  status: DesktopClientStatus | null;
  phaseLabel: string;
  centerStatus: CenterStatusLite | undefined;
  onDisconnectCenter(): Promise<void>;
  onSaveCenterCa(ca: string): Promise<void>;
  onConfigureBot?(deviceId: string, botId: string): void;
  onStartGoogleSetupWizard?(deviceId: string, botId: string): void;
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
  archiveBridge?: BotChatsArchiveBridge | null;
  onOpenArchivedBotHistory?(bot: BotDirectoryEntry): void;
}

const THEMES: Record<DesktopTheme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

const TAB_META: Array<{ id: SettingsTab; label: string; desc: string }> = [
  { id: 'connection', label: '中心连接', desc: '查看中心连接状态、当前设备或更换绑定' },
  { id: 'center-admin', label: '中心管理', desc: '免密管理模型服务商、扩展插件、设备与全局密码库' },
  { id: 'runtime', label: '本机与权限', desc: '本机后台服务状态、开机自启与高级排障' },
  { id: 'general', label: '外观与通用', desc: '主题模式与对话显示' },
  { id: 'archive', label: '已归档智能体', desc: '查看历史对话、恢复或删除已归档的智能体' },
  { id: 'updates', label: '客户端更新', desc: '查看当前版本、检查并安装更新' },
];

function DeviceRow({ item, isRelay, local, online, busy, lastObservedAt, onRename, onError, onRemove }: {
  item: DevicesDirectoryItem;
  isRelay: boolean;
  local: boolean;
  online: boolean | null;
  busy: boolean;
  lastObservedAt: string | null;
  onRename(item: DevicesDirectoryItem, displayName: string): void;
  onError(message: string): void;
  onRemove?(): void;
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
              {lastObservedAt && <div className="metadata">最近读取 {lastObservedAt}</div>}
            </div>
          </details>
          {isRelay && (
            <button type="button" className="icon-button" onClick={() => { setValue(item.displayName); setEditing(true); }} disabled={busy} aria-label={'重命名设备 ' + (item.displayName || '未命名设备')}>
              <Pencil size={14} aria-hidden />
            </button>
          )}
          {onRemove && (
            <button type="button" className="icon-button danger-outline" onClick={onRemove} disabled={busy} title="移除设备" aria-label={'移除设备 ' + (item.displayName || item.deviceId)}>
              <Trash2 size={14} aria-hidden />
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
    <section className="settings-pane">
      <div className="settings-pane-header">
        <div className="section-head">
          <h3>已归档智能体（{items.length}）</h3>
          <button type="button" className="secondary-button" disabled={!bridge?.online || bridge.loading} onClick={() => bridge?.refresh()}>
            <RefreshCw size={13} aria-hidden /> 刷新
          </button>
        </div>
        <p className="metadata">归档后的智能体将在 14 天后自动清理。</p>
      </div>
      <ErrorNotice compact error={error} onDismiss={() => setError('')} />
      <ErrorNotice compact error={bridge?.error} />
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
                    <details className="archive-more">
                      <summary className="secondary-button"><ChevronDown size={13} aria-hidden /> 更多</summary>
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

function LocalDebugProfiles(props: SettingsPanelProps) {
  const { profiles, profilesBusy, profilesError, form, selectedProfile, transportConnected, identity, status } = props;
  // 剔除与主中心连接重复混淆的 Center Relay 档案，仅保留局域网直连调试档案。
  const localProfiles = profiles.filter((profile) => profile.kind === 'local');
  const activeLocalProfile = selectedProfile?.kind === 'local' ? selectedProfile : localProfiles[0] ?? null;
  const activeId = identity?.kind === 'local' ? identity.profileId : null;
  const selectedIsActive = Boolean(activeLocalProfile && activeId === activeLocalProfile.id && transportConnected);

  return (
    <div className="diagnostics-block">
      <h5>局域网 IP 直连调试</h5>
      <p className="metadata">仅用于无中心网络下的局域网直连调试。切换档案时保留当前已填令牌。</p>
      <ErrorNotice compact error={profilesError} />
      {localProfiles.length > 0 ? (
        <ul className="profile-list">
          {localProfiles.map((profile) => (
            <li key={profile.id} className={profile.id === activeLocalProfile?.id ? 'selected' : undefined}>
              <button
                type="button"
                className="profile-row"
                aria-pressed={profile.id === activeLocalProfile?.id}
                onClick={() => props.onSelectProfile(profile)}
              >
                <strong>{profile.title}</strong>
                <span className="metadata">{profile.url}</span>
                {transportConnected && activeId === profile.id && <span className="status ok">当前直连</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="metadata">暂无局域网直连调试档案。</p>
      )}

      {activeLocalProfile && (
        <div className="settings-connect" style={{ marginTop: 8 }}>
          {selectedIsActive ? (
            <button type="button" className="secondary-button" onClick={props.onDisconnect} disabled={profilesBusy}>断开直连</button>
          ) : (
            <>
              <label>
                本机直连令牌（{activeLocalProfile.title}）
                <input
                  type="password"
                  autoComplete="off"
                  value={props.token}
                  onChange={(event) => props.onTokenChange(event.target.value)}
                  placeholder="输入目标设备的直连令牌"
                />
              </label>
              <div className="dialog-actions">
                <button type="button" className="primary-button" onClick={props.onConnect} disabled={profilesBusy}>
                  {transportConnected ? '切换到此直连' : '连接'}
                </button>
              </div>
            </>
          )}
          {status && (
            <div className="metadata">连接代次 {status.generation} · {status.phase}{status.errorCode ? ' · ' + status.errorCode : ''}</div>
          )}
        </div>
      )}

      <details className="settings-disclosure" style={{ marginTop: 10 }}>
        <summary>新增局域网直连档案</summary>
        <form className="form-grid" onSubmit={props.onSaveProfile}>
          <label>
            名称（可选）
            <input value={form.title} onChange={(event) => props.onFormChange({ title: event.target.value, kind: 'local' })} placeholder="例如：办公室台式机" />
          </label>
          <label>
            期望设备 ID（可选）
            <input value={form.expectedDeviceId} onChange={(event) => props.onFormChange({ expectedDeviceId: event.target.value, kind: 'local' })} />
          </label>
          <label className="form-grid-full">
            设备局域网地址
            <input required type="url" value={form.url} onChange={(event) => props.onFormChange({ url: event.target.value, kind: 'local' })} placeholder="http://192.168.1.x:port" />
          </label>
          <div className="form-grid-full">
            <button type="submit" className="primary-button" disabled={profilesBusy}>保存直连档案</button>
          </div>
        </form>
      </details>
    </div>
  );
}

function CustomCaSection({ centerStatus, onSaveCenterCa }: Pick<SettingsPanelProps, 'centerStatus' | 'onSaveCenterCa'>) {
  const savedCa = centerStatus?.savedConnection?.ca ?? '';
  const [caDraft, setCaDraft] = useState(savedCa);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dirty) {
      setCaDraft(savedCa);
    }
  }, [savedCa, dirty]);

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setSavedOk(false);
    try {
      await onSaveCenterCa(caDraft);
      setDirty(false);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="diagnostics-block">
      <h5>自定义 CA 证书</h5>
      <p className="metadata">仅用于自建 HTTPS 中心的私有根证书（PEM 格式）。</p>
      <div className="settings-connect" style={{ marginTop: 4 }}>
        <textarea
          value={caDraft}
          disabled={busy || !centerStatus?.savedConnection}
          onChange={(event) => {
            setCaDraft(event.target.value);
            setDirty(true);
            setSavedOk(false);
          }}
          placeholder="-----BEGIN CERTIFICATE-----"
          rows={4}
        />
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button"
            disabled={busy || !centerStatus?.savedConnection || !dirty}
            onClick={() => void handleSave()}
          >
            {busy ? '正在保存…' : '保存 CA 证书'}
          </button>
          {savedOk && <span className="status online">✓ 已保存并生效</span>}
        </div>
        <ErrorNotice compact error={error} onDismiss={() => setError('')} />
      </div>
    </div>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const t = useText();
  const { activeTab, onTabChange, centerStatus, devices, transportConnected, devicesIsRelay, identity, api } = props;
  const [hideToolOutput, setHideToolOutput] = useHideToolOutput();
  const [collapseToolOutput, setCollapseToolOutput] = useCollapseToolOutput();
  const [copiedClientId, setCopiedClientId] = useState(false);
  const [centerBusy, setCenterBusy] = useState<'rebind' | 'disconnect' | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ item: DevicesDirectoryItem; identity: DesktopIdentity } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hostService = useHostService();

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [activeTab]);

  const centerReady = centerStatus?.state === 'ready';
  const centerConnecting = centerStatus?.state === 'connecting';
  const centerLabel = centerReady ? '已连接' : centerConnecting ? '正在恢复连接' : '未连接';
  const centerTone = centerReady ? 'online' : centerConnecting ? 'warn' : 'muted';

  const localDeviceId = identity?.kind === 'local'
    ? props.currentDeviceId
    : (hostService.host?.configured ? hostService.host.deviceId : null) || props.currentDeviceId || null;

  const currentDevice = devices.items.find((item) => item.deviceId === localDeviceId);
  const currentDeviceName = currentDevice?.displayName
    || hostService.host?.displayName
    || hostService.host?.hostname
    || localDeviceId
    || '本机设备';

  const deviceStatusCurrent = transportConnected && !devices.stale;
  const showingLastDirectory = devices.loaded && !deviceStatusCurrent;

  const centerTransport = useMemo(() => {
    if (!identity || !centerReady) return null;
    return createBrokerCenterTransport((op, params) =>
      (api.broker as (id: DesktopIdentity, op: string, params: Record<string, unknown>) => Promise<unknown>)(
        identity,
        op,
        params,
      ),
    );
  }, [api, identity, centerReady]);

  const activeMeta = TAB_META.find((tab) => tab.id === activeTab) ?? TAB_META[0];

  const handleDisconnectAction = async (kind: 'rebind' | 'disconnect') => {
    if (centerBusy) return;
    setCenterBusy(kind);
    try {
      await props.onDisconnectCenter();
    } finally {
      setCenterBusy(null);
    }
  };

  const copyClientId = () => {
    if (!centerStatus?.clientId) return;
    void navigator.clipboard?.writeText(centerStatus.clientId).then(() => {
      setCopiedClientId(true);
      setTimeout(() => setCopiedClientId(false), 1500);
    }).catch(() => {});
  };

  const renderTabIcon = (id: SettingsTab) => {
    if (id === 'connection') return <Globe size={15} aria-hidden />;
    if (id === 'center-admin') return <ShieldCheck size={15} aria-hidden />;
    if (id === 'runtime') return <Server size={15} aria-hidden />;
    if (id === 'archive') return <Archive size={15} aria-hidden />;
    if (id === 'updates') return <Download size={15} aria-hidden />;
    return <Sliders size={15} aria-hidden />;
  };

  return (
    <div className="settings-shell-wrap">
      <div className="dialog-head settings-shell-head">
        <Dialog.Title className="dialog-title">设置</Dialog.Title>
        <Dialog.Description className="sr-only">{activeMeta.desc}</Dialog.Description>
        <Dialog.Close asChild>
          <button type="button" className="icon-button" aria-label="关闭"><X size={16} aria-hidden /></button>
        </Dialog.Close>
      </div>

      <div className="settings-shell-layout">
        <nav className="settings-shell-nav" aria-label="设置分栏">
          {TAB_META.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                className={'settings-nav-item' + (active ? ' active' : '')}
                aria-current={active ? 'page' : undefined}
                onClick={() => onTabChange(tab.id)}
              >
                {renderTabIcon(tab.id)}
                <span>{tab.label}</span>
                {tab.id === 'connection' && (
                  <span className={`nav-status-dot ${centerTone}`} aria-hidden />
                )}
              </button>
            );
          })}
        </nav>

        <div className={'settings-shell-body' + (activeTab === 'center-admin' ? ' center-admin-body' : '')} ref={bodyRef}>
          {props.actionError && activeTab !== 'center-admin' && (
            <ErrorNotice compact error={props.actionError} onDismiss={props.onDismissActionError} />
          )}

          {activeTab === 'connection' && (
            <div className="settings-pane">
              <div className="settings-pane-header">
                <h3>中心连接</h3>
                <p className="metadata">通过加密通道与您的 PiBot 中心保持同步。</p>
              </div>
              <div className="settings-row-group">
                <div className="settings-row">
                  <span className="settings-row-label">连接状态</span>
                  <span className={`host-status-pill ${centerTone}`}>
                    <span className="host-status-dot" aria-hidden />
                    {centerLabel}
                  </span>
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">中心地址</span>
                  <span className="metadata">{centerStatus?.centerUrl || '未绑定'}</span>
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">当前设备名</span>
                  <span className="metadata">{currentDeviceName}</span>
                </div>
              </div>
              <div className="dialog-actions" style={{ marginTop: 14 }}>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={centerBusy !== null}
                  onClick={() => void handleDisconnectAction('rebind')}
                >
                  {centerBusy === 'rebind' ? '正在切换…' : '重新绑定'}
                </button>
                <button
                  type="button"
                  className="secondary-button danger-outline"
                  disabled={centerBusy !== null}
                  onClick={() => void handleDisconnectAction('disconnect')}
                >
                  {centerBusy === 'disconnect' ? '正在断开…' : '断开连接'}
                </button>
              </div>
              {centerStatus?.clientId && (
                <details className="settings-diagnostics" style={{ marginTop: 16 }}>
                  <summary>连接详情</summary>
                  <div className="settings-client-id">
                    <span>客户端标识 {centerStatus.clientId}</span>
                    <button type="button" className="icon-button" onClick={copyClientId} aria-label={copiedClientId ? '已复制客户端标识' : '复制客户端标识'}>
                      {copiedClientId ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    </button>
                  </div>
                </details>
              )}
            </div>
          )}

          {activeTab === 'center-admin' && (
            centerTransport ? (
              <div className="settings-center-admin-embed">
                <CenterAdminPanel
                  key={props.centerAdminTab ?? 'default'}
                  transport={centerTransport}
                  embedded
                  initialTab={props.centerAdminTab}
                  centerUrl={centerStatus?.centerUrl}
                  onOpenExternal={() => void openCenterManagement(centerStatus?.centerUrl)}
                  onOpenExternalUrl={url => openCenterManagement(url)}
                  onConfigureBot={props.onConfigureBot}
                  onStartGoogleSetupWizard={props.onStartGoogleSetupWizard}
                />
              </div>
            ) : (
              <div className="settings-pane">
                <div className="settings-empty-card">
                  <h4>尚未连接到 PiBot 中心</h4>
                  <p className="metadata">绑定并连接中心后，可在此直接免密管理模型服务商、扩展插件、设备与全局密码库。</p>
                  <button type="button" className="primary-button" onClick={() => onTabChange('connection')}>
                    前往中心连接
                  </button>
                </div>
              </div>
            )
          )}

          {activeTab === 'runtime' && (
            <div className="settings-pane">
              <div className="settings-pane-header">
                <h3>本机与权限</h3>
                <p className="metadata">查看本机后台服务健康状态、管理自启项与高级网络排障。</p>
              </div>
              <HostServiceSection
                service={hostService}
                diagnosticExtra={{
                  centerState: centerStatus?.state ?? null,
                  centerUrl: centerStatus?.centerUrl ?? null,
                  clientId: centerStatus?.clientId ?? null,
                  brokerPhase: props.status?.phase ?? null,
                  brokerGeneration: props.status?.generation ?? null,
                  brokerErrorCode: props.status?.errorCode ?? null,
                }}
                advancedNetwork={(
                  <>
                    <CustomCaSection centerStatus={centerStatus} onSaveCenterCa={props.onSaveCenterCa} />
                    <LocalDebugProfiles {...props} />
                  </>
                )}
              />

              <section className="settings-section" style={{ marginTop: 8 }}>
                <div className="section-head">
                  <h4>已接入设备</h4>
                  <button type="button" className="icon-button" onClick={props.onRefreshDevices} disabled={devices.busy || !transportConnected} aria-label="刷新设备">
                    <RefreshCw size={15} aria-hidden />
                  </button>
                </div>
                <ErrorNotice compact error={devices.error} />
                {showingLastDirectory && <p className="metadata">正在查看上次读取的设备。</p>}
                {devices.items.length > 0 ? (
                  <ul className="device-list settings-directory">
                    {devices.items.map((item) => (
                      <DeviceRow
                        key={item.deviceId}
                        item={item}
                        isRelay={devicesIsRelay}
                        local={item.deviceId === localDeviceId}
                        online={deviceStatusCurrent ? item.online : null}
                        busy={devices.busy || !transportConnected}
                        lastObservedAt={props.lastObservedAt ?? devices.loadedAt}
                        onRename={props.onRenameDevice}
                        onError={props.onDeviceError}
                        onRemove={centerTransport && identity && devicesIsRelay && deviceStatusCurrent &&
                          item.deviceId !== localDeviceId && item.deviceId !== centerStatus?.savedConnection?.deviceId
                          ? () => setRemoveTarget({ item, identity })
                          : undefined}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="metadata">{devices.busy ? '正在读取设备…' : '暂无其他在线设备'}</p>
                )}
                {devicesIsRelay && devices.nextCursor && (
                  <button type="button" className="secondary-button" onClick={props.onLoadMoreDevices} disabled={devices.busy || !transportConnected}>加载更多</button>
                )}
              </section>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="settings-pane">
              <div className="settings-pane-header">
                <h3>外观与通用</h3>
                <p className="metadata">设置界面主题与对话显示偏好。</p>
              </div>

              <section className="settings-section">
                <h4>主题模式</h4>
                <div className="settings-row-group" role="group" aria-label="外观主题">
                  {(Object.keys(THEMES) as DesktopTheme[]).map((theme) => (
                    <label key={theme} className="settings-row settings-row-link">
                      <span className="settings-row-label">{THEMES[theme]}</span>
                      <input type="radio" name="desktop-theme" checked={props.theme === theme} onChange={() => props.onThemeChange(theme)} />
                    </label>
                  ))}
                </div>
              </section>

              <section className="settings-section">
                <h4>对话显示</h4>
                <div className="settings-row-group">
                  <label className="settings-row settings-row-link">
                    <span className="settings-row-label">
                      <span>{t('隐藏工具输出', 'Hide Tool Output')}</span>
                      <span className="metadata" style={{ display: 'block', fontSize: 12 }}>{t('只显示回复与待操作请求', 'Show replies and prompts that need your input')}</span>
                    </span>
                    <Switch label={t('隐藏工具输出', 'Hide Tool Output')} checked={hideToolOutput} onChange={setHideToolOutput} />
                  </label>
                  {!hideToolOutput && (
                    <label className="settings-row settings-row-link">
                      <span className="settings-row-label">
                        <span>{t('默认折叠工具输出', 'Collapse Tool Output by Default')}</span>
                        <span className="metadata" style={{ display: 'block', fontSize: 12 }}>{t('保留工具调用摘要，点击可展开详情', 'Show tool summaries that can be expanded')}</span>
                      </span>
                      <Switch label={t('默认折叠工具输出', 'Collapse Tool Output by Default')} checked={collapseToolOutput} onChange={setCollapseToolOutput} />
                    </label>
                  )}
                </div>
              </section>
            </div>
          )}

          {activeTab === 'archive' && (
            <ArchivedBots bridge={props.archiveBridge} onOpenHistory={props.onOpenArchivedBotHistory} />
          )}

          {removeTarget && centerTransport && identity === removeTarget.identity && (
            <RemoveDeviceDialog
              name={removeTarget.item.displayName || removeTarget.item.deviceId}
              onClose={() => setRemoveTarget(null)}
              onRemove={async () => {
                await createCenterApi(centerTransport).deleteDevice(removeTarget.item.deviceId);
                props.onRefreshDevices();
              }}
            />
          )}

          {activeTab === 'updates' && (
            <div className="settings-pane">
              <div className="settings-pane-header">
                <h3>客户端更新</h3>
              </div>
              <ClientUpdateSection variant="desktop" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
