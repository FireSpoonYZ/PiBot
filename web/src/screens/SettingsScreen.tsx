import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  AudioLines,
  ChevronsUpDown,
  Clock,
  Code2,
  Download,
  ExternalLink,
  Globe,
  LayoutDashboard,
  PanelLeft,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  BotHost,
  openCenterUrl,
  type HostVoiceSaveInput,
  type HostVoiceSettings,
} from '../native';
import { mobileHaptic } from '../native/tauri-host';
import { useCenterConnection } from '../native/CenterGate';
import { OnboardingPanel, OnboardingPermissions, QuickQrScanButton } from '../native/OnboardingPanel';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import type { DesktopConnectionInput, DesktopUiProfile } from '../../../host-core/desktop-client.js';
import type { DevicesDirectoryItem } from '../../../host-core/index.js';
import { CenterAdminPanel, type CenterTransport } from '../center-admin';
import { ErrorNotice, useAction, useCollapseToolOutput, useHideToolOutput, useText } from '../ui';
import { PlatformLogoIcon, uuid } from '../hub/shared';
import { Badge, Disclosure, Row, Section } from '../bot-settings/primitives';
import { ClientUpdateSection, useClientUpdateSummary } from '../ClientUpdateSection';
import { ConfirmDialog, ListRow, Switch } from '../components/ui';
import type { CenterAdminTab, HubSettingsPage } from './types';

export interface SettingsCenterAdminScreenProps {
  transport: CenterTransport;
  initialTab: CenterAdminTab;
  onBack(): void;
  onOpenCenterSettings(): void;
  onConfigureBot(deviceId: string, botId: string): void;
}

export function SettingsCenterAdminScreen({
  transport,
  initialTab,
  onBack,
  onOpenCenterSettings,
  onConfigureBot,
}: SettingsCenterAdminScreenProps) {
  const t = useText();
  const centerConn = useCenterConnection();

  return (
    <main className="grok-subpage grok-page-enter hst-settings" aria-label={t('中心管理', 'Center Admin')}>
      <header className="grok-subpage-topbar">
        <button
          type="button"
          className="grok-floating-circle-btn"
          onClick={onBack}
          aria-label={t('返回', 'Back')}
        >
          <ArrowLeft size={20} />
        </button>
        <h2 className="grok-subpage-header-title">{t('中心管理', 'Center Admin')}</h2>
        {centerConn.ready ? (
          <button
            type="button"
            className="grok-floating-circle-btn"
            onClick={() => void centerConn.openManagement()}
            aria-label={t('在浏览器打开中心管理', 'Open center admin in browser')}
            title={t('在浏览器打开', 'Open in browser')}
          >
            <ExternalLink size={18} />
          </button>
        ) : (
          <span className="grok-topbar-spacer" aria-hidden="true" />
        )}
      </header>
      <div className="grok-subpage-scroll">
        {!centerConn.ready ? (
          <div className="hst-form">
            <Section>
              <div className="hst-row-static">
                <span className="bs-row-sub">
                  {t('尚未连接到中心。请先绑定并连接中心，即可免密管理服务商、模型、能力目录、设备与全局密码库。',
                    'Not connected to the center yet. Connect first to manage providers, models, capabilities, devices, and vault without a password.')}
                </span>
              </div>
              <div className="hst-actions">
                <button type="button" className="hst-btn is-primary" onClick={onOpenCenterSettings}>
                  {t('前往中心连接', 'Connect to center')}
                </button>
              </div>
            </Section>
          </div>
        ) : (
          <CenterAdminPanel
            transport={transport}
            embedded
            hideTopbarExternal
            initialTab={initialTab}
            centerUrl={centerConn.status?.centerUrl || centerConn.saved?.url}
            onOpenExternal={() => void centerConn.openManagement()}
            onOpenExternalUrl={url => openCenterUrl(url)}
            onConfigureBot={onConfigureBot}
          />
        )}
      </div>
    </main>
  );
}

export interface HubSettingsViewProps {
  page: HubSettingsPage;
  onOpenPage(page: HubSettingsPage): void;
  onBack(): void;
  onOpenDrawer?(): void;
  drawerOpen?: boolean;
  ensureRemoteApi(): Promise<DesktopPanelApi | null>;
  remoteProfiles: DesktopUiProfile[];
  remoteIdentity: DesktopIdentity | null;
  remoteConnected: boolean;
  remoteDevices: DevicesDirectoryItem[];
  directoryReadFailed: boolean;
  directoryCurrent: boolean;
  localDeviceId?: string | null;
  onRemoteDevices(items: DevicesDirectoryItem[], identity: DesktopIdentity): void;
  onRemoteUpdated(): Promise<void>;
  archivedCount: number;
  onOpenArchivedBots(): void;
  onOpenPending(): void;
  onOpenCenterAdmin(tab?: CenterAdminTab): void;
  onOpenSystemSettings?(): void;
}

export function HubSettingsView({
  page,
  onOpenPage,
  onBack,
  onOpenDrawer,
  drawerOpen,
  ensureRemoteApi,
  remoteProfiles,
  remoteIdentity,
  remoteConnected,
  remoteDevices,
  directoryReadFailed,
  directoryCurrent,
  localDeviceId,
  onRemoteDevices,
  onRemoteUpdated,
  archivedCount,
  onOpenArchivedBots,
  onOpenPending,
  onOpenCenterAdmin,
  onOpenSystemSettings,
}: HubSettingsViewProps) {
  const t = useText();
  const action = useAction();
  const centerConn = useCenterConnection();
  const updateSummary = useClientUpdateSummary();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollByPage = useRef<Partial<Record<HubSettingsPage, number>>>({});
  const previousPage = useRef<HubSettingsPage | null>(null);

  const [editingCenter, setEditingCenter] = useState(false);
  const [renamingDevice, setRenamingDevice] = useState<{ deviceId: string; generation: number } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [settingsConfirm, setSettingsConfirm] = useState<
    | { kind: 'disconnect-center' }
    | { kind: 'delete-profile'; profileId: string; title: string }
    | { kind: 'exit-client' }
    | null
  >(null);

  const localProfiles = useMemo(
    () => remoteProfiles.filter(profile => profile.kind === 'local'),
    [remoteProfiles],
  );
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(() => {
    const current = remoteIdentity?.profileId;
    return localProfiles.some(p => p.id === current) ? current ?? null : (localProfiles[0]?.id ?? null);
  });
  const [tokensByProfile, setTokensByProfile] = useState<Record<string, string>>({});
  const [addingRemote, setAddingRemote] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formDeviceId, setFormDeviceId] = useState('');

  const [voice, setVoice] = useState<HostVoiceSettings>();
  const [hideToolOutput, setHideToolOutput] = useHideToolOutput();
  const [collapseToolOutput, setCollapseToolOutput] = useCollapseToolOutput();

  useLayoutEffect(() => {
    const previous = previousPage.current;
    if (previous === page) return;
    previousPage.current = page;
    if (previous === 'connection') {
      setEditingCenter(false);
      centerConn.setToken('');
    }
    if (previous === 'devices') setRenamingDevice(null);
    setSettingsConfirm(null);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollByPage.current[page] ?? 0;
    if (previous || page !== 'overview') titleRef.current?.focus({ preventScroll: true });
  }, [page, centerConn.setToken]);

  useEffect(() => {
    void ensureRemoteApi();
    void BotHost.voiceSettings()
      .then(v => setVoice(v))
      .catch(() => {});
  }, [ensureRemoteApi]);

  const activeProfile = localProfiles.find(profile => profile.id === selectedProfileId) ?? localProfiles[0];
  const token = activeProfile ? (tokensByProfile[activeProfile.id] ?? '') : '';
  const setActiveProfileToken = (next: string) => {
    if (!activeProfile) return;
    setTokensByProfile(prev => ({ ...prev, [activeProfile.id]: next }));
  };
  const selectedIsConnected = remoteConnected && Boolean(activeProfile && activeProfile.id === remoteIdentity?.profileId);

  const saveRemoteProfile = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api) throw new Error(t('当前环境不支持远程连接组件', 'Remote client unavailable'));
      const id = `p-${Date.now().toString(36)}-${uuid().slice(0, 6)}`;
      const next: DesktopUiProfile = {
        id,
        title: formTitle.trim() || formUrl.trim(),
        kind: 'local',
        url: formUrl.trim(),
        ...(formDeviceId.trim() ? { expectedDeviceId: formDeviceId.trim() } : {}),
      };
      await api.queueWrite(s => ({
        ...s,
        profiles: [...s.profiles, next],
      }));
      setFormTitle('');
      setFormUrl('');
      setFormDeviceId('');
      setAddingRemote(false);
      setSelectedProfileId(next.id);
    });
  };

  const deleteRemoteProfile = (profileId: string) =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api) return;
      await api.queueWrite(s => ({
        ...s,
        profiles: s.profiles.filter((p: DesktopUiProfile) => p.id !== profileId),
      }));
      setTokensByProfile(prev => {
        if (!(profileId in prev)) return prev;
        const copy = { ...prev };
        delete copy[profileId];
        return copy;
      });
      if (activeProfile?.id === profileId) setSelectedProfileId(null);
    });

  const connectRemoteProfile = () => {
    const profile = activeProfile;
    if (!profile || !token.trim()) return;
    const input: DesktopConnectionInput = {
      kind: 'local',
      url: profile.url,
      token: token.trim(),
      ...(profile.expectedDeviceId ? { expectedDeviceId: profile.expectedDeviceId } : {}),
    };
    return action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api) throw new Error(t('当前环境不支持远程连接组件', 'Remote client unavailable'));
      api.setTransportConnected(false);
      api.setIdentity(null);
      const status = await api.broker(
        { profileId: profile.id, targetDeviceId: '', generation: 0, kind: 'local' },
        'connect',
        { connection: input },
      );
      const targetDeviceId = status.connection?.kind === 'local' ? status.connection.deviceId ?? '' : '';
      const newIdentity = api.setIdentity({ profileId: profile.id, targetDeviceId, kind: 'local' });
      const connected = status.phase === 'connected';
      api.setTransportConnected(connected);
      if (connected && newIdentity) {
        const result = await api.broker(newIdentity, 'devices', { limit: 20, cursor: null });
        if (api.identity?.generation !== newIdentity.generation || !api.transportConnected) return;
        onRemoteDevices(result.items, newIdentity);
        void onRemoteUpdated();
      }
    });
  };

  const disconnectRemote = () =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      if (!api || !remoteIdentity) return;
      api.setTransportConnected(false);
      await api.broker(remoteIdentity, 'disconnect', {});
      void onRemoteUpdated();
    });

  const renameDevice = (deviceId: string) =>
    action.run(async () => {
      const api = await ensureRemoteApi();
      if (!remoteIdentity || !api?.transportConnected || api.identity?.generation !== remoteIdentity.generation) {
        throw new Error(t('设备连接已变化，请刷新后重试。', 'The device connection changed. Refresh and try again.'));
      }
      await api.broker(remoteIdentity, 'rename_device', { deviceId, displayName: renameDraft.trim() });
      setRenamingDevice(null);
      void onRemoteUpdated();
    });

  const saveCenterNetworkAndReconnect = () =>
    action.run(async () => {
      if (!centerConn.url.trim() || !centerConn.deviceId.trim()) {
        throw new Error(t('请先完成中心绑定，或填写中心地址与设备标识', 'Bind to a center first or provide Center URL and Device ID'));
      }
      await centerConn.connect();
      await onRemoteUpdated();
    });

  const showCenterForm = !centerConn.ready || editingCenter;
  const centerAddress = centerConn.status?.centerUrl || centerConn.saved?.url;
  const centerDeviceId = centerConn.saved?.deviceId || (centerConn.ready ? centerConn.deviceId : '');
  const centerClientId = centerConn.status?.clientId;
  const centerStatus = (
    <Badge tone={centerConn.ready ? 'success' : centerConn.connecting ? 'accent' : 'neutral'}>
      {centerConn.ready ? t('已连接', 'Connected')
        : centerConn.connecting ? t('连接中', 'Connecting')
          : centerConn.error ? t('连接异常', 'Connection issue') : t('未连接', 'Disconnected')}
    </Badge>
  );
  const pageTitles: Record<HubSettingsPage, string> = {
    overview: t('设置', 'Settings'),
    connection: t('中心连接', 'Center connection'),
    devices: t('设备', 'Devices'),
    manual: t('局域网直连调试', 'Direct LAN debugging'),
    updates: t('客户端更新', 'Client update'),
    permissions: t('本机与权限', 'Device & permissions'),
  };
  const canRename = directoryCurrent && remoteIdentity?.kind === 'relay';
  const directoryNotice = directoryReadFailed
    ? remoteDevices.length > 0
      ? t('暂时无法刷新目录，显示上次读取的设备。', 'Could not refresh the directory. Showing previously seen devices.')
      : t('暂时无法读取设备目录。', 'Could not read the device directory.')
    : remoteDevices.length > 0 && !directoryCurrent
      ? t('显示上次读取的设备，当前状态待确认。', 'Showing previously seen devices. Their current status is unknown.')
      : '';
  const actionNotice = <ErrorNotice error={action.error} onDismiss={() => action.setError('')} />;

  return (
    <main className="grok-subpage grok-page-enter hst-settings" aria-labelledby={titleId}>
      <header className="grok-subpage-topbar">
        {page === 'overview' && onOpenDrawer ? (
          <button
            type="button"
            className="grok-floating-circle-btn"
            onClick={onOpenDrawer}
            aria-label={t('打开侧边栏', 'Open sidebar')}
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
          >
            <PanelLeft size={20} strokeWidth={2} />
          </button>
        ) : (
          <button type="button" className="grok-floating-circle-btn" onClick={onBack} aria-label={t('返回', 'Back')}>
            <ArrowLeft size={20} />
          </button>
        )}
        <h2 ref={titleRef} id={titleId} tabIndex={-1} className="grok-subpage-header-title">{pageTitles[page]}</h2>
        <span className="hst-topbar-spacer" aria-hidden="true" />
      </header>

      <div
        className="grok-subpage-scroll"
        ref={scrollRef}
        onScroll={event => { scrollByPage.current[page] = event.currentTarget.scrollTop; }}
      >
        {page !== 'overview' && actionNotice}
        {page === 'connection' && (
          <>
            <Section>
              <Row
                icon={<Globe />}
                title={centerConn.ready ? t('当前中心', 'Current center') : t('连接状态', 'Connection status')}
                subtitle={centerAddress}
                trailing={centerStatus}
              />
              {centerConn.ready && !editingCenter && (
                <>
                  <Row icon={<LayoutDashboard />} title={t('打开中心管理', 'Open Center Admin')} onClick={() => onOpenCenterAdmin('providers')} chevron />
                  <Row icon={<ExternalLink />} title={t('在浏览器打开中心管理', 'Open center management in browser')} onClick={centerConn.openManagement} chevron />
                  <Row title={t('更换中心连接', 'Change center')} disabled={centerConn.busy} onClick={() => setEditingCenter(true)} chevron />
                  <Row title={t('断开中心', 'Disconnect from center')} disabled={centerConn.busy} onClick={() => setSettingsConfirm({ kind: 'disconnect-center' })} />
                </>
              )}
            </Section>
            {showCenterForm ? (
              <Section title={editingCenter ? t('更换中心连接', 'Change center') : t('连接中心', 'Connect to center')}>
                <OnboardingPanel onDone={() => setEditingCenter(false)} />
                {editingCenter && centerConn.ready && (
                  <div className="hst-actions">
                    <button type="button" className="hst-btn" disabled={centerConn.busy} onClick={() => {
                      setEditingCenter(false);
                      centerConn.setToken('');
                    }}>
                      {t('取消', 'Cancel')}
                    </button>
                  </div>
                )}
              </Section>
            ) : <ErrorNotice error={centerConn.error} onDismiss={() => centerConn.setError('')} />}
            {(centerDeviceId || centerClientId) && (
              <Disclosure title={t('连接详情', 'Connection details')}>
                <Section>
                  {centerDeviceId && <Row title={t('设备标识', 'Device ID')} subtitle={centerDeviceId} />}
                  {centerClientId && <Row title={t('客户端标识', 'Client ID')} subtitle={centerClientId} />}
                </Section>
              </Disclosure>
            )}
          </>
        )}

        {page === 'devices' && (
          <>
            <Section
              title={t('设备目录', 'Device directory')}
              action={remoteConnected && (
                <button type="button" className="bs-link" disabled={action.busy} onClick={() => void action.run(onRemoteUpdated)}>
                  {t('刷新', 'Refresh')}
                </button>
              )}
            >
              {directoryNotice && <Row title={<span role="status" className="bs-row-sub">{directoryNotice}</span>} />}
              {localDeviceId && !remoteDevices.some(device => device.deviceId === localDeviceId) && (
                <Row icon={<PlatformLogoIcon platform="android" />} title={t('此设备', 'This device')} />
              )}
              {remoteDevices.map(device => {
                const renaming = canRename && renamingDevice?.deviceId === device.deviceId &&
                  renamingDevice.generation === remoteIdentity?.generation;
                return (
                  <div className="hst-device-row" key={device.deviceId}>
                    <span className={'hst-device-badge' + (directoryCurrent && !device.online ? ' is-offline' : '')} aria-hidden="true">
                      <PlatformLogoIcon platform={device.platform} size={14} />
                    </span>
                    {renaming ? (
                      <>
                        <input
                          className="hst-device-name-input"
                          value={renameDraft}
                          onChange={event => setRenameDraft(event.target.value)}
                          aria-label={t('设备名称', 'Device name')}
                          maxLength={120}
                          autoFocus
                        />
                        <button type="button" className="hst-btn is-primary" disabled={action.busy || !renameDraft.trim()} onClick={() => void renameDevice(device.deviceId)}>
                          {t('保存', 'Save')}
                        </button>
                        <button type="button" className="hst-btn" disabled={action.busy} onClick={() => setRenamingDevice(null)}>
                          {t('取消', 'Cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="hst-device-name">
                          {device.displayName || t('未命名设备', 'Unnamed device')}
                          {device.deviceId === localDeviceId && <span className="bs-row-sub">{t('本机', 'This device')}</span>}
                        </span>
                        {directoryCurrent && (
                          <Badge tone={device.online ? 'success' : 'neutral'}>{device.online ? t('在线', 'Online') : t('离线', 'Offline')}</Badge>
                        )}
                        {canRename && remoteIdentity && (
                          <button type="button" className="hst-btn is-ghost" disabled={action.busy} onClick={() => {
                            setRenamingDevice({ deviceId: device.deviceId, generation: remoteIdentity.generation });
                            setRenameDraft(device.displayName || device.deviceId);
                          }}>
                            {t('改名', 'Rename')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              {remoteDevices.length === 0 && !directoryNotice && <Row title={directoryCurrent
                ? t('暂无目录设备', 'No devices in the directory')
                : t('设备目录尚未读取', 'Device directory unavailable')} />}
            </Section>
          </>
        )}

        {page === 'updates' && <ClientUpdateSection variant="mobile" />}
        {page === 'permissions' && <OnboardingPermissions />}

        {page === 'manual' && <Section
          title={t('局域网直连档案（WebSocket）', 'Direct LAN debug profiles (WebSocket)')}
          action={
            localProfiles.length > 0 || addingRemote ? (
              <button type="button" className="bs-link" disabled={action.busy} onClick={() => setAddingRemote(v => !v)}>
                {addingRemote ? t('收起', 'Collapse') : t('新增直连', 'Add direct host')}
              </button>
            ) : undefined
          }
          bare
        >
          {addingRemote && (
            <form className="bs-card" onSubmit={saveRemoteProfile}>
              <label className="hst-input-row">
                <span className="hst-input-label">{t('节点名称', 'Name')}</span>
                <input
                  required
                  className="hst-input"
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder={t('例如：局域网测试机', 'e.g. LAN Dev Host')}
                />
              </label>

              <label className="hst-input-row">
                <span className="hst-input-label">{t('直连地址', 'WebSocket URL')}</span>
                <input
                  required
                  type="url"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="hst-input"
                  value={formUrl}
                  onChange={e => setFormUrl(e.target.value)}
                  placeholder="ws://192.168.x.x:..."
                />
              </label>

              <label className="hst-input-row">
                <span className="hst-input-label">{t('目标设备 ID', 'Target ID')}</span>
                <input
                  className="hst-input"
                  value={formDeviceId}
                  onChange={e => setFormDeviceId(e.target.value)}
                  placeholder={t('选填', 'Optional')}
                />
              </label>

              <div className="hst-actions">
                <button type="submit" className="hst-btn is-primary" disabled={action.busy}>
                  {t('保存节点', 'Save Host')}
                </button>
              </div>
            </form>
          )}

          {localProfiles.length === 0 && !addingRemote ? (
            <div className="bs-card">
              <Row icon={<Server />} title={t('添加局域网直连', 'Add direct LAN host')} onClick={() => setAddingRemote(true)} chevron />
            </div>
          ) : activeProfile && (
            <div className="bs-card">
              {localProfiles.map(profile => (
                <Row
                  key={profile.id}
                  selected={activeProfile.id === profile.id}
                  icon={<Server />}
                  title={profile.title}
                  subtitle={`${t('直连', 'Direct')} · ${profile.url}`}
                  disabled={action.busy}
                  onClick={() => setSelectedProfileId(profile.id)}
                  trailing={
                    <>
                      {remoteConnected && remoteIdentity?.profileId === profile.id && <Badge tone="success">{t('已连接', 'Connected')}</Badge>}
                      <button
                        type="button"
                        className="hst-btn is-ghost"
                        disabled={action.busy}
                        aria-label={t('删除直连档案', 'Remove direct profile') + ' · ' + profile.title}
                        onClick={e => {
                          e.stopPropagation();
                          setSettingsConfirm({ kind: 'delete-profile', profileId: profile.id, title: profile.title });
                        }}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </>
                  }
                />
              ))}

              <label className="hst-input-row">
                <span className="hst-input-label">{t('连接令牌', 'Token')}</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  className="hst-input"
                  disabled={action.busy}
                  value={token}
                  onChange={e => setActiveProfileToken(e.target.value)}
                  placeholder={t('输入访问令牌', 'Enter access token')}
                />
              </label>

              <div className="hst-actions">
                {remoteConnected && (
                  <button type="button" className="hst-btn" disabled={action.busy} onClick={() => void disconnectRemote()}>
                    {t('断开当前连接', 'Disconnect current connection')}
                  </button>
                )}
                <button type="button" className="hst-btn is-primary" disabled={action.busy || !token.trim()} onClick={() => void connectRemoteProfile()}>
                  {selectedIsConnected ? t('重新连接', 'Reconnect') : t('连接', 'Connect')}
                </button>
              </div>
            </div>
          )}
        </Section>}

        <div className="hst-overview" hidden={page !== 'overview'}>
          {/* 1. 中心与管理 */}
          <Section title={t('中心与管理', 'Center & Admin')}>
            <ListRow
              leading={<Globe />}
              title={
                <span className="hst-entry-label">
                  <span>{pageTitles.connection}</span>
                  {centerStatus}
                </span>
              }
              subtitle={centerAddress || undefined}
              onClick={() => onOpenPage('connection')}
              trailing={
                <QuickQrScanButton
                  className="hst-btn"
                  disabled={centerConn.busy}
                  onPaired={() => void onRemoteUpdated()}
                />
              }
            />
            <Row
              icon={<LayoutDashboard />}
              title={t('中心管理', 'Center Admin')}
              subtitle={centerConn.ready
                ? t('服务商、模型、能力目录、设备与全局密码库', 'Providers, models, capabilities, devices & global vault')
                : t('连接中心后免密管理服务商、模型与设备', 'Connect to center for passwordless management')}
              chevron
              onClick={() => onOpenCenterAdmin('providers')}
            />
          </Section>

          {/* 2. 本机与权限 */}
          <Section title={t('本机与权限', 'Device & Permissions')}>
            <Row
              icon={<ShieldCheck />}
              title={t('通知、后台与节点自检', 'Alerts, background & local host')}
              subtitle={t('通知权限、电池优化、Shizuku 与本机节点状态', 'Notifications, battery optimization, Shizuku & local host status')}
              onClick={() => onOpenPage('permissions')}
              chevron
            />
          </Section>

          <Disclosure title={t('高级网络与排障', 'Advanced network & troubleshooting')}>
            <div className="hst-form">
              <Section bare>
                <div className="bs-card">
                  <Row
                    icon={<Server />}
                    title={t('局域网直连调试', 'Direct LAN debugging')}
                    subtitle={t('本地/局域网 WebSocket 调试连接', 'Direct local/LAN WebSocket debug profiles')}
                    onClick={() => onOpenPage('manual')}
                    chevron
                  />
                </div>
              </Section>

              <Section title={t('中心证书与节点令牌', 'Center TLS & Host Token')} bare>
                <div className="bs-card">
                  <label className="hst-input-row">
                    <span className="hst-input-label">{t('本机节点令牌', 'Host Token')}</span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      className="hst-input"
                      disabled={centerConn.busy || action.busy}
                      value={centerConn.hostToken}
                      onChange={e => centerConn.setHostToken(e.target.value)}
                      placeholder={t('选填，留空保持不变', 'Optional; blank keeps current')}
                    />
                  </label>
                  <label className="hst-textarea-row">
                    <span className="hst-input-label">{t('CA 证书', 'CA PEM')}</span>
                    <textarea
                      rows={4}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="hst-textarea hst-ca-textarea"
                      disabled={centerConn.busy || action.busy}
                      value={centerConn.ca}
                      onChange={e => centerConn.setCa(e.target.value)}
                      placeholder={t('自签名证书 PEM（选填）', 'Optional self-signed PEM')}
                    />
                  </label>
                  {centerConn.error && (
                    <div className="hst-row-static">
                      <ErrorNotice error={centerConn.error} compact onDismiss={() => centerConn.setError('')} />
                    </div>
                  )}
                  <div className="hst-actions">
                    <button
                      type="button"
                      className="hst-btn is-primary"
                      disabled={centerConn.busy || action.busy || !centerConn.url.trim() || !centerConn.deviceId.trim()}
                      onClick={() => void saveCenterNetworkAndReconnect()}
                    >
                      {centerConn.busy ? t('重连中…', 'Reconnecting…') : t('保存并重连', 'Save & Reconnect')}
                    </button>
                  </div>
                </div>
              </Section>
            </div>
          </Disclosure>

          {/* 3. 对话与语音 */}
          <Section title={t('对话与语音', 'Chat & Voice')}>
            <Row
              icon={<Code2 />}
              title={t('隐藏工具输出', 'Hide Tool Output')}
              subtitle={t('只显示回复与待操作请求', 'Show replies and prompts that need your input')}
              trailing={(
                <Switch
                  label={t('隐藏工具输出', 'Hide Tool Output')}
                  checked={hideToolOutput}
                  onCheckedChange={setHideToolOutput}
                />
              )}
            />
            {!hideToolOutput && (
              <Row
                icon={<Code2 />}
                title={t('默认折叠工具输出', 'Collapse Tool Output by Default')}
                subtitle={t('保留工具调用摘要，点击可展开详情', 'Show tool summaries that can be expanded')}
                trailing={(
                  <Switch
                    label={t('默认折叠工具输出', 'Collapse Tool Output by Default')}
                    checked={collapseToolOutput}
                    onCheckedChange={setCollapseToolOutput}
                  />
                )}
              />
            )}
            <div className="hst-row-static">
              <span className="bs-row-icon" aria-hidden="true"><AudioLines size={17} /></span>
              <span className="bs-row-text"><span className="bs-row-title">{t('语音朗读倍速', 'Speech Rate')}</span></span>
              <span className="hst-select-wrap">
                <select
                  value={String(voice?.speechRate ?? 1)}
                  onChange={e =>
                    void action.run(async () => {
                      const current = voice ?? (await BotHost.voiceSettings());
                      const next = { ...current, speechRate: Number(e.target.value) };
                      await BotHost.saveVoiceSettings({ settings: next as HostVoiceSaveInput });
                      setVoice(await BotHost.voiceSettings());
                    })
                  }
                >
                  {[0.75, 1, 1.25, 1.5, 2].map(r => (
                    <option key={r} value={String(r)}>
                      {r}×
                    </option>
                  ))}
                </select>
                <ChevronsUpDown size={14} />
              </span>
            </div>
          </Section>

          {/* 4. 资料库 */}
          <Section title={t('资料库', 'Library')}>
            <Row
              icon={<Archive />}
              title={t(`已归档 Bot (${archivedCount})`, `Archived Bots (${archivedCount})`)}
              subtitle={t('14 天后自动清理', '14d auto-delete')}
              chevron
              onClick={onOpenArchivedBots}
            />
            <Row
              icon={<Clock />}
              title={t('待发消息', 'Pending messages')}
              subtitle={t('离线时保留、尚未确认送达的消息', 'Messages kept offline or not yet confirmed')}
              chevron
              onClick={onOpenPending}
            />
          </Section>

          {/* 5. 系统与更新 */}
          <Section title={t('系统与更新', 'System & Updates')}>
            {onOpenSystemSettings && (
              <Row
                icon={<Settings />}
                title={t('外观主题、唤醒词与系统权限', 'Theme, wake word & system settings')}
                subtitle={t('浅色/深色外观主题、语音唤醒词与后台保护权限', 'Light/dark theme, voice wake word, and OS background permissions')}
                chevron
                onClick={onOpenSystemSettings}
              />
            )}
            <Row
              icon={<Download />}
              title={pageTitles.updates}
              trailing={updateSummary ? <span className="bs-row-sub">{updateSummary}</span> : undefined}
              onClick={() => onOpenPage('updates')}
              chevron
            />
          </Section>

          <div className="hst-exit">
            <button
              type="button"
              className="hst-btn is-danger"
              disabled={centerConn.busy}
              onClick={() => setSettingsConfirm({ kind: 'exit-client' })}
            >
              {t('退出客户端', 'Exit Client')}
            </button>
          </div>
        </div>

        {page === 'overview' && actionNotice}
      </div>

      <ConfirmDialog
        open={settingsConfirm !== null}
        title={
          settingsConfirm?.kind === 'disconnect-center'
            ? t('断开中心连接', 'Disconnect from Center')
            : settingsConfirm?.kind === 'delete-profile'
              ? t('删除局域网直连档案', 'Remove Direct LAN Profile')
              : t('退出客户端', 'Exit Client')
        }
        description={
          settingsConfirm?.kind === 'disconnect-center'
            ? t('确定要断开与当前中心的连接吗？断开后将无法访问远端设备与中心管理，需要重新连接或配对。',
                'Disconnect from the current center? Remote devices and center management will be unavailable until you reconnect.')
            : settingsConfirm?.kind === 'delete-profile'
              ? t(`确定要删除局域网直连档案「${settingsConfirm.title}」吗？此操作不可恢复。`,
                  `Remove the direct LAN profile "${settingsConfirm.title}"? This cannot be undone.`)
              : t('确定要退出客户端并停止本机后台服务吗？运行中的本机 Bot 任务将被中断。',
                  'Exit the client and stop the local background service? Running local Bot tasks will be interrupted.')
        }
        danger
        onCancel={() => setSettingsConfirm(null)}
        onConfirm={() => {
          const current = settingsConfirm;
          setSettingsConfirm(null);
          if (!current) return;
          mobileHaptic('confirm');
          if (current.kind === 'disconnect-center') {
            centerConn.disconnect();
          } else if (current.kind === 'delete-profile') {
            void deleteRemoteProfile(current.profileId);
          } else {
            void centerConn.stopLocalHost();
          }
        }}
      />
    </main>
  );
}
