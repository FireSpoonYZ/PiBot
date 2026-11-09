// 设置和归档均由 App 提供对话框。连接凭据只保存在输入态。
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, ExternalLink, Pencil, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { DesktopClientStatus, DesktopUiProfile } from '../../../host-core/desktop-client.js';
import type { BotDirectoryEntry, DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity } from './types';
import { openCenterManagement, type DesktopTheme } from './CenterGate';
import { HostServiceSection } from './HostServiceSection';
import { ClientUpdateSection } from '../../../web/src/ClientUpdateSection';
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

interface DevicesSectionState {
  items: DevicesDirectoryItem[];
  nextCursor: { afterDeviceId: string } | null;
  error: string | null;
  busy: boolean;
  loadedAt: string | null;
  loaded: boolean;
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
  online: boolean;
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
    <li>
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
        <div className="settings-device">
          <div className="card-row">
            <strong>{item.displayName || '未命名设备'}</strong>
            {local && <span className="metadata">本机</span>}
            <span className={'status ' + (online ? 'ok' : 'muted')}>{online ? '在线' : '离线'}</span>
            {isRelay && (
              <button type="button" className="icon-button" onClick={() => { setValue(item.displayName); setEditing(true); }} disabled={busy} aria-label="重命名设备">
                <Pencil size={14} aria-hidden />
              </button>
            )}
          </div>
          <details className="settings-diagnostics">
            <summary>设备详情</summary>
            <div className="metadata">设备 ID {item.deviceId}</div>
            {isRelay && <div className="metadata">控制协议 {item.controlProtocol} · 群聊协议 {item.scopeProtocol}</div>}
            {lastObservedAt && <div className="metadata">最近读取 {lastObservedAt}</div>}
          </details>
        </div>
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
        <p className="status">{activeProfile ? activeProfile.title + ' · ' + props.phaseLabel : '尚未连接'}</p>
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

export function SettingsPanel(props: SettingsPanelProps) {
  const [tab, setTab] = useState<'general' | 'profiles'>('general');
  const [copied, setCopied] = useState(false);
  const [centerError, setCenterError] = useState('');
  const [hostDeviceId, setHostDeviceId] = useState('');
  const { centerStatus, devices, transportConnected, devicesIsRelay, identity } = props;
  const centerLabel = centerStatus?.state === 'ready' ? '已连接中心' : centerStatus?.state === 'connecting' ? '正在恢复连接' : '中心未连接';
  const localDeviceId = identity?.kind === 'local' ? props.currentDeviceId : hostDeviceId;
  const deviceSummary = devices.busy && !devices.loaded ? '正在读取' : devices.loaded ? '已知 ' + devices.items.length + ' 台' : '等待连接';

  const copyClientId = () => {
    if (!centerStatus?.clientId) return;
    void navigator.clipboard.writeText(centerStatus.clientId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <>
      <div className="dialog-head">
        <Dialog.Title className="dialog-title">{props.archiveOpen ? '已归档智能体' : '设置'}</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="icon-button" aria-label="关闭"><X size={16} aria-hidden /></button></Dialog.Close>
      </div>
      <Dialog.Description className="dialog-desc">
        {props.archiveOpen ? '归档后的智能体将在 14 天后自动清理。' : '管理中心连接、设备和客户端。'}
      </Dialog.Description>
      {!props.archiveOpen && (
        <div className="dialog-tabs pill-tabs" role="group" aria-label="设置分类">
          <button type="button" aria-pressed={tab === 'general'} className={tab === 'general' ? 'active' : undefined} onClick={() => setTab('general')}>常规</button>
          <button type="button" aria-pressed={tab === 'profiles'} className={tab === 'profiles' ? 'active' : undefined} onClick={() => setTab('profiles')}>高级连接</button>
        </div>
      )}
      <div className="dialog-body">
        {props.archiveOpen ? <ArchivedBots bridge={props.archiveBridge} onOpenHistory={props.onOpenArchivedBotHistory} /> : tab === 'profiles' ? (
          <ConnectionProfiles {...props} />
        ) : (
          <>
            <details className="settings-section settings-disclosure">
              <summary><strong>连接</strong><span className="status">{centerLabel}</span></summary>
              {centerStatus?.centerUrl && <p className="metadata">{centerStatus.centerUrl}</p>}
              <div className="dialog-actions">
                <button type="button" className="secondary-button" onClick={() => {
                  setCenterError('');
                  void openCenterManagement(centerStatus?.centerUrl).catch(() => setCenterError('暂时无法打开中心管理。'));
                }}>
                  <ExternalLink size={13} aria-hidden /> 在浏览器打开中心管理
                </button>
                <button type="button" className="secondary-button" onClick={props.onDisconnectCenter}>更换中心连接</button>
              </div>
              {centerError && <p className="error-banner" role="alert">{centerError}</p>}
              {centerStatus?.clientId && (
                <details className="settings-diagnostics">
                  <summary>连接诊断</summary>
                  <div className="client-pill">
                    客户端 {centerStatus.clientId}
                    <button type="button" className="icon-button" onClick={copyClientId} aria-label="复制客户端标识">
                      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                    </button>
                  </div>
                </details>
              )}
            </details>
            <details className="settings-section settings-disclosure">
              <summary><strong>设备</strong><span className="metadata">{deviceSummary}</span></summary>
              <HostServiceSection onDeviceId={setHostDeviceId} />
              <div className="dialog-actions">
                <button type="button" className="secondary-button" onClick={props.onRefreshDevices} disabled={devices.busy || !transportConnected}>刷新设备</button>
              </div>
              {devices.error && <p className="error-banner" role="alert">设备列表暂未更新。<span className="metadata">{devices.error}</span></p>}
              {!transportConnected && devices.loaded && <p className="status">正在查看上次读取的设备。</p>}
              {devices.loaded && devices.items.length === 0 ? <p className="empty-state">暂无设备。</p> : (
                <ul className="device-list">
                  {devices.items.map((item) => (
                    <DeviceRow key={item.deviceId} item={item} isRelay={devicesIsRelay}
                      local={item.deviceId === localDeviceId} online={transportConnected && item.online} busy={devices.busy || !transportConnected}
                      lastObservedAt={props.lastObservedAt ?? devices.loadedAt} onRename={props.onRenameDevice} onError={props.onDeviceError} />
                  ))}
                </ul>
              )}
              {devicesIsRelay && devices.nextCursor && (
                <button type="button" className="secondary-button" onClick={props.onLoadMoreDevices} disabled={devices.busy || !transportConnected}>加载更多</button>
              )}
            </details>
            <ClientUpdateSection variant="desktop" />
            <section className="settings-section">
              <div className="section-head"><h4>外观</h4></div>
              <div className="pill-tabs" role="group" aria-label="外观主题">
                {(Object.keys(THEMES) as DesktopTheme[]).map((theme) => (
                  <button key={theme} type="button" aria-pressed={props.theme === theme} className={props.theme === theme ? 'active' : undefined} onClick={() => props.onThemeChange(theme)}>
                    {THEMES[theme]}
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
