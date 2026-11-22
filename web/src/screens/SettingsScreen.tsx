import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Archive,
  ArrowLeft,
  AudioLines,
  ChevronsUpDown,
  ClipboardCheck,
  Clock,
  Code2,
  Download,
  ExternalLink,
  Globe,
  LayoutDashboard,
  Loader2,
  PanelLeft,
  ScanLine,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  Wrench,
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
import { humanizeError, useAction, useCollapseToolOutput, useHideToolOutput, useText } from '../ui';
import { useNotice, type NoticeTone } from '../notice';
import { useConnectionPhaseContext } from '../connection';
import { LabelStack, ReservedSlot, Skeleton } from '../layout';
import { uuid } from '../hub/shared';
import { Badge, Disclosure, Row, Section } from '../bot-settings/primitives';
import { ClientUpdateSection, useClientUpdateSummary } from '../ClientUpdateSection';
import { ClipboardSyncSection } from '../ClipboardSyncSection';
import { ConfirmDialog, ListRow, Switch, type ListRowStatusTone } from '../components/ui';
import type { CenterAdminTab, HubSettingsPage } from './types';

export interface SettingsCenterAdminScreenProps {
  transport: CenterTransport;
  initialTab: CenterAdminTab;
  onBack(): void;
  onOpenCenterSettings(): void;
  onConfigureBot(deviceId: string, botId: string): void;
  onStartGoogleSetupWizard(deviceId: string, botId: string): void;
}

export function SettingsCenterAdminScreen({
  transport,
  initialTab,
  onBack,
  onOpenCenterSettings,
  onConfigureBot,
  onStartGoogleSetupWizard,
}: SettingsCenterAdminScreenProps) {
  const t = useText();
  const centerConn = useCenterConnection();
  const [everMountedAdmin, setEverMountedAdmin] = useState(() => centerConn.ready || centerConn.displayReady);

  useEffect(() => {
    if (centerConn.ready || centerConn.displayReady) {
      setEverMountedAdmin(true);
    } else if (!centerConn.hasSavedCenter && !centerConn.connecting && !centerConn.reconnecting) {
      setEverMountedAdmin(false);
    }
  }, [centerConn.ready, centerConn.displayReady, centerConn.hasSavedCenter, centerConn.connecting, centerConn.reconnecting]);

  // 仅用于界面展示保活：曾经就绪过或 displayReady 为真时不卸载面板，业务操作仍严格以 centerConn.ready 为准。
  const showAdminPanel =
    centerConn.ready ||
    centerConn.displayReady ||
    (everMountedAdmin && (centerConn.hasSavedCenter || centerConn.connecting || centerConn.reconnecting));
  const isReconnectingOverlay = showAdminPanel && !centerConn.ready;

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
        {showAdminPanel ? (
          <button
            type="button"
            className="grok-floating-circle-btn"
            disabled={!centerConn.ready}
            onClick={() => {
              if (centerConn.ready) void centerConn.openManagement();
            }}
            aria-label={t('在浏览器打开中心管理', 'Open center admin in browser')}
            title={t('在浏览器打开', 'Open in browser')}
          >
            <ExternalLink size={18} />
          </button>
        ) : (
          <span className="grok-topbar-spacer" aria-hidden="true" />
        )}
      </header>
      <div className="hst-admin-body">
        <div className="grok-subpage-scroll" aria-busy={isReconnectingOverlay || undefined}>
          {!showAdminPanel ? (
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
            <div
              className={`hst-admin-panel-wrap${isReconnectingOverlay ? ' is-disabled' : ''}`}
              aria-disabled={isReconnectingOverlay || undefined}
            >
              <CenterAdminPanel
                transport={transport}
                embedded
                hideTopbarExternal
                initialTab={initialTab}
                centerUrl={centerConn.status?.centerUrl || centerConn.saved?.url}
                onOpenExternal={() => {
                  if (centerConn.ready) void centerConn.openManagement();
                }}
                onOpenExternalUrl={url => openCenterUrl(url)}
                onConfigureBot={onConfigureBot}
                onStartGoogleSetupWizard={onStartGoogleSetupWizard}
              />
            </div>
          )}
        </div>
        {isReconnectingOverlay && (
          <div className="hst-admin-overlay" role="status" aria-live="polite">
            <div className="hst-admin-overlay-pill">
              <Loader2 size={15} className="hst-spin" aria-hidden="true" />
              <span>
                {centerConn.connecting || centerConn.reconnecting
                  ? t('正在重新连接中心…', 'Reconnecting to center…')
                  : t('中心连接暂不可用，等待恢复…', 'Center connection unavailable, waiting to reconnect…')}
              </span>
            </div>
          </div>
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
  const connPhase = useConnectionPhaseContext();
  const { notify, dismiss } = useNotice();
  const updateSummary = useClientUpdateSummary();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollByPage = useRef<Partial<Record<HubSettingsPage, number>>>({});
  const previousPage = useRef<HubSettingsPage | null>(null);
  const pendingScrollRestoreRef = useRef<{ page: HubSettingsPage; targetTop: number } | null>(null);
  const programmaticScrollTopRef = useRef<number | null>(null);

  const [editingCenter, setEditingCenter] = useState(false);
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
  const [voiceLoaded, setVoiceLoaded] = useState(false);
  const [remoteApiReady, setRemoteApiReady] = useState(false);
  const [hideToolOutput, setHideToolOutput] = useHideToolOutput();
  const [collapseToolOutput, setCollapseToolOutput] = useCollapseToolOutput();

  const pageHydrated =
    page === 'overview'
      ? centerConn.initialized || voiceLoaded
      : page === 'connection'
        ? centerConn.initialized
        : page === 'manual'
          ? remoteApiReady
          : page === 'updates'
            ? Boolean(updateSummary) || centerConn.initialized
            : true;

  useLayoutEffect(() => {
    const previous = previousPage.current;
    if (previous === page) return;
    previousPage.current = page;
    if (previous === 'connection') {
      setEditingCenter(false);
      centerConn.setToken('');
    }
    setSettingsConfirm(null);
    const targetTop = scrollByPage.current[page] ?? 0;
    const el = scrollRef.current;
    if (targetTop <= 0 || pageHydrated) {
      pendingScrollRestoreRef.current = null;
      if (el && Math.round(el.scrollTop) !== Math.round(targetTop)) {
        programmaticScrollTopRef.current = Math.round(targetTop);
        el.scrollTop = targetTop;
      }
    } else {
      pendingScrollRestoreRef.current = { page, targetTop };
      if (el && Math.round(el.scrollTop) !== 0) {
        programmaticScrollTopRef.current = 0;
        el.scrollTop = 0;
      }
    }
    if (previous || page !== 'overview') titleRef.current?.focus({ preventScroll: true });
  }, [page, pageHydrated, centerConn.setToken]);

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (!pending || pending.page !== page || !pageHydrated) return;
    pendingScrollRestoreRef.current = null;
    const el = scrollRef.current;
    if (el && Math.round(el.scrollTop) !== Math.round(pending.targetTop)) {
      programmaticScrollTopRef.current = Math.round(pending.targetTop);
      el.scrollTop = pending.targetTop;
    }
  }, [page, pageHydrated]);

  useEffect(() => {
    let active = true;
    void ensureRemoteApi().finally(() => {
      if (active) setRemoteApiReady(true);
    });
    void BotHost.voiceSettings()
      .then(v => {
        if (active) setVoice(v);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setVoiceLoaded(true);
      });
    return () => {
      active = false;
    };
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

  const saveCenterNetworkAndReconnect = () =>
    action.run(async () => {
      if (!centerConn.url.trim() || !centerConn.deviceId.trim()) {
        throw new Error(t('尚未绑定中心，无法保存证书与令牌。请先在「中心连接」完成绑定。', 'No center is bound yet. Bind to a center in Center connection before saving TLS or token settings.'));
      }
      await centerConn.connect();
      await onRemoteUpdated();
    });

  // S1: 展示层按是否保存过中心 + displayReady 决定表单或操作列表，避免暂态重连把页面切回表单。
  // 业务操作与授权门槛仍严格依赖 centerConn.ready。
  const hasCenterConfigured = centerConn.hasSavedCenter || centerConn.displayReady;
  const showCenterForm = !hasCenterConfigured || editingCenter;
  const showCenterActions = hasCenterConfigured && !editingCenter;
  const centerAddress = centerConn.status?.centerUrl || centerConn.saved?.url || (hasCenterConfigured ? centerConn.url : '');
  const centerDeviceId = centerConn.saved?.deviceId || (centerConn.ready || centerConn.displayReady ? centerConn.deviceId : '');
  const centerClientId = centerConn.status?.clientId;
  const statusLabelOnline = t('已连接', 'Connected');
  const statusLabelConnecting = t('连接中', 'Connecting');
  const statusLabelError = t('连接异常', 'Connection issue');
  const statusLabelOffline = t('未连接', 'Disconnected');
  const centerBadgePhase = centerConn.ready
    ? 'online'
    : centerConn.error
      ? 'error'
      : centerConn.connecting || centerConn.reconnecting || (hasCenterConfigured && connPhase.phase === 'connecting')
        ? 'connecting'
        : 'offline';
  const centerBadgeTone = centerBadgePhase === 'online'
    ? 'success'
    : centerBadgePhase === 'connecting'
      ? 'accent'
      : centerBadgePhase === 'error'
        ? 'danger'
        : 'neutral';
  const centerDotTone: ListRowStatusTone = centerBadgePhase === 'online'
    ? 'ok'
    : centerBadgePhase === 'connecting'
      ? 'accent'
      : centerBadgePhase === 'error'
        ? 'error'
        : 'idle';
  const centerBadgeLabel = centerBadgePhase === 'online'
    ? statusLabelOnline
    : centerBadgePhase === 'connecting'
      ? statusLabelConnecting
      : centerBadgePhase === 'error'
        ? statusLabelError
        : statusLabelOffline;
  const centerOverviewSummary = centerBadgePhase === 'online'
    ? (centerAddress || statusLabelOnline)
    : centerBadgePhase === 'connecting'
      ? (centerAddress ? t(`连接中 · ${centerAddress}`, `Connecting · ${centerAddress}`) : t('连接中…', 'Connecting…'))
      : centerBadgePhase === 'error'
        ? (centerAddress ? t(`连接异常 · ${centerAddress}`, `Connection issue · ${centerAddress}`) : statusLabelError)
        : (centerAddress ? t(`未连接 · ${centerAddress}`, `Disconnected · ${centerAddress}`) : statusLabelOffline);
  const centerStatus = (
    <span className="hst-status-badge-slot">
      <Badge tone={centerBadgeTone}>
        <LabelStack
          active={centerBadgeLabel}
          labels={[statusLabelOnline, statusLabelConnecting, statusLabelError, statusLabelOffline]}
        />
      </Badge>
    </span>
  );
  const pageTitles: Record<HubSettingsPage, string> = {
    overview: t('设置', 'Settings'),
    connection: t('中心连接', 'Center connection'),
    devices: t('设备', 'Devices'),
    manual: t('局域网直连调试', 'Direct LAN debugging'),
    updates: t('客户端更新', 'Client update'),
    permissions: t('通知与后台权限', 'Notifications & background'),
    clipboard: t('剪贴板同步', 'Clipboard sync'),
    advanced: t('高级网络与排障', 'Advanced network & troubleshooting'),
  };

  useEffect(() => {
    if (!action.error) {
      dismiss('settings:action-error');
      return;
    }
    if (action.errorStale) return;
    const humanized = humanizeError(action.error, t);
    const tone: NoticeTone =
      humanized?.tone === 'warning'
        ? 'warning'
        : humanized?.tone === 'success'
          ? 'success'
          : humanized?.tone === 'info' || humanized?.tone === 'progress'
            ? 'info'
            : 'error';
    const title = humanized
      ? humanized.description
        ? `${humanized.title} — ${humanized.description}`
        : humanized.title
      : action.error;
    notify({
      id: 'settings:action-error',
      tone,
      title,
      detail: humanized?.detail,
    });
  }, [action.error, action.errorStale, t, notify, dismiss]);

  useEffect(() => {
    if (!centerConn.error) {
      dismiss('center:connection-error');
      return;
    }
    notify({
      id: 'center:connection-error',
      tone: 'error',
      title: centerConn.error,
      detail: centerConn.errorCode || undefined,
    });
  }, [centerConn.error, centerConn.errorCode, notify, dismiss]);

  useEffect(() => {
    return () => {
      dismiss('settings:action-error');
      dismiss('center:connection-error');
    };
  }, [dismiss]);

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
          <button
            type="button"
            className="grok-floating-circle-btn"
            onClick={onBack}
            aria-label={t('返回', 'Back')}
          >
            <ArrowLeft size={20} />
          </button>
        )}
        <h2 ref={titleRef} id={titleId} tabIndex={-1} className="grok-subpage-header-title">
          {pageTitles[page]}
        </h2>
        <span className="hst-topbar-spacer" aria-hidden="true" />
      </header>

      <div
        className="grok-subpage-scroll"
        ref={scrollRef}
        onScroll={event => {
          const top = event.currentTarget.scrollTop;
          if (programmaticScrollTopRef.current !== null && Math.abs(top - programmaticScrollTopRef.current) <= 2) {
            programmaticScrollTopRef.current = null;
            return;
          }
          programmaticScrollTopRef.current = null;
          if (pendingScrollRestoreRef.current?.page === page) {
            pendingScrollRestoreRef.current = null;
          }
          scrollByPage.current[page] = top;
        }}
      >
        {page === 'clipboard' && <ClipboardSyncSection variant="mobile" />}
        {page === 'connection' && (
          <>
            <Section>
              <Row
                icon={<Globe />}
                title={hasCenterConfigured ? t('当前中心', 'Current center') : t('连接状态', 'Connection status')}
                subtitle={
                  <ReservedSlot minHeight={18} inline align="center" className="hst-row-sub-slot">
                    {centerAddress ? (
                      centerAddress
                    ) : hasCenterConfigured ? (
                      <Skeleton variant="text" width={160} height={12} inline />
                    ) : (
                      t('尚未绑定中心', 'No center connected')
                    )}
                  </ReservedSlot>
                }
                trailing={centerStatus}
              />
              {showCenterActions && (
                <>
                  <Row
                    icon={<ScanLine />}
                    title={t('扫码配对与登录', 'Scan QR code')}
                    subtitle={t('确认网页端登录或绑定新中心', 'Approve browser sign-in or pair a center')}
                    trailing={
                      <QuickQrScanButton
                        className="hst-btn"
                        disabled={centerConn.busy}
                        onPaired={() => void onRemoteUpdated()}
                      />
                    }
                  />
                  <Row icon={<LayoutDashboard />} title={t('打开中心管理', 'Open Center Admin')} disabled={!centerConn.ready} onClick={() => onOpenCenterAdmin('providers')} chevron />
                  <Row icon={<ExternalLink />} title={t('在浏览器打开中心管理', 'Open center management in browser')} disabled={!centerConn.ready} onClick={centerConn.openManagement} chevron />
                  <Row title={t('更换中心连接', 'Change center')} disabled={centerConn.busy} onClick={() => setEditingCenter(true)} chevron />
                  <Row title={t('断开中心', 'Disconnect from center')} disabled={centerConn.busy} onClick={() => setSettingsConfirm({ kind: 'disconnect-center' })} />
                </>
              )}
            </Section>
            {showCenterForm && (
              <Section title={editingCenter ? t('更换中心连接', 'Change center') : t('连接中心', 'Connect to center')}>
                <OnboardingPanel onDone={() => setEditingCenter(false)} />
                {editingCenter && hasCenterConfigured && (
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
            )}
            <ReservedSlot minHeight={44} align="start">
              {(hasCenterConfigured || centerDeviceId || centerClientId) ? (
                <Disclosure title={t('连接详情', 'Connection details')}>
                  <Section bare>
                    <Row
                      title={t('设备标识', 'Device ID')}
                      subtitle={
                        <ReservedSlot minHeight={18} inline align="center" className="hst-row-sub-slot">
                          {centerDeviceId ? (
                            centerDeviceId
                          ) : centerConn.connecting || !centerConn.initialized ? (
                            <Skeleton variant="text" width={140} height={12} inline />
                          ) : (
                            '—'
                          )}
                        </ReservedSlot>
                      }
                    />
                    <Row
                      title={t('客户端标识', 'Client ID')}
                      subtitle={
                        <ReservedSlot minHeight={18} inline align="center" className="hst-row-sub-slot">
                          {centerClientId ? (
                            centerClientId
                          ) : centerConn.connecting || !centerConn.initialized ? (
                            <Skeleton variant="text" width={140} height={12} inline />
                          ) : (
                            '—'
                          )}
                        </ReservedSlot>
                      }
                    />
                  </Section>
                </Disclosure>
              ) : null}
            </ReservedSlot>
          </>
        )}

        {page === 'updates' && <ClientUpdateSection variant="mobile" />}
        {page === 'permissions' && <OnboardingPermissions />}

        {page === 'advanced' && (
          <>
            <Section title={t('局域网调试', 'LAN debugging')}>
              <Row
                icon={<Server />}
                title={t('局域网直连调试', 'Direct LAN debugging')}
                subtitle={t('本地或局域网 WebSocket 调试节点', 'Direct local or LAN WebSocket debug profiles')}
                onClick={() => onOpenPage('manual')}
                chevron
              />
            </Section>

            <Section
              title={t('中心证书与节点令牌', 'Center TLS & Host Token')}
              hint={
                !centerConn.url.trim() || !centerConn.deviceId.trim()
                  ? t('请先在「中心连接」绑定中心，再保存节点令牌或自签名 CA 证书。', 'Bind to a center in Center connection before saving a host token or custom CA certificate.')
                  : t('保存后会使用更新后的令牌或 CA 证书重新连接当前中心。', 'Saving reconnects to the current center using the updated token or CA certificate.')
              }
            >
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
              <label className="hst-input-row ob-textarea-row">
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
              <div className="hst-actions">
                <button
                  type="button"
                  className="hst-btn is-primary"
                  disabled={centerConn.busy || action.busy || !centerConn.url.trim() || !centerConn.deviceId.trim()}
                  onClick={() => void saveCenterNetworkAndReconnect()}
                >
                  <LabelStack
                    active={centerConn.busy ? t('重连中…', 'Reconnecting…') : t('保存并重连', 'Save & Reconnect')}
                    labels={[t('重连中…', 'Reconnecting…'), t('保存并重连', 'Save & Reconnect')]}
                  />
                </button>
              </div>
            </Section>
          </>
        )}

        {page === 'manual' && <Section
          title={t('局域网直连档案（WebSocket）', 'Direct LAN debug profiles (WebSocket)')}
          action={
            localProfiles.length > 0 || addingRemote ? (
              <button type="button" className="bs-link" disabled={action.busy} onClick={() => setAddingRemote(v => !v)}>
                <LabelStack
                  active={addingRemote ? t('收起', 'Collapse') : t('新增直连', 'Add direct host')}
                  labels={[t('收起', 'Collapse'), t('新增直连', 'Add direct host')]}
                  align="end"
                />
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
                  <LabelStack
                    active={selectedIsConnected ? t('重新连接', 'Reconnect') : t('连接', 'Connect')}
                    labels={[t('重新连接', 'Reconnect'), t('连接', 'Connect')]}
                  />
                </button>
              </div>
            </div>
          )}
        </Section>}

        <div className="hst-overview" hidden={page !== 'overview'}>
          {/* 1. 中心 */}
          <Section title={t('中心', 'Center')}>
            <ListRow
              leading={<Globe />}
              title={t('中心连接', 'Center connection')}
              statusTone={centerDotTone}
              subtitle={
                <ReservedSlot minHeight={18} inline align="center" className="hst-row-sub-slot">
                  {!centerConn.initialized && !centerAddress ? (
                    <Skeleton variant="text" width={140} height={12} inline />
                  ) : (
                    centerOverviewSummary
                  )}
                </ReservedSlot>
              }
              chevron
              onClick={() => onOpenPage('connection')}
            />
            <ListRow
              leading={<LayoutDashboard />}
              title={t('中心管理', 'Center admin')}
              subtitle={hasCenterConfigured
                ? t('服务商、模型、能力目录、设备与密码库', 'Providers, models, capabilities, devices & vault')
                : t('连接中心后免密管理服务商、模型与设备', 'Connect to manage providers, models & devices')}
              chevron
              onClick={() => onOpenCenterAdmin('providers')}
            />
          </Section>

          {/* 2. 本机与同步 */}
          <Section title={t('本机与同步', 'Device & Sync')}>
            <ListRow
              leading={<ShieldCheck />}
              title={t('通知与后台权限', 'Notifications & background')}
              subtitle={t('通知、电池优化、Shizuku 与本机节点状态', 'Alerts, battery optimization, Shizuku & local host')}
              chevron
              onClick={() => onOpenPage('permissions')}
            />
            <ListRow
              leading={<ClipboardCheck />}
              title={t('剪贴板同步', 'Clipboard sync')}
              subtitle={t('本机开关、同步组配对与立即发送剪贴板', 'Device toggle, group pairing & send clipboard now')}
              chevron
              onClick={() => onOpenPage('clipboard')}
            />
          </Section>

          {/* 3. 偏好与资料 */}
          <Section title={t('偏好与资料', 'Preferences & Library')}>
            <ListRow
              leading={<Code2 />}
              title={t('隐藏工具输出', 'Hide tool output')}
              subtitle={t('只显示回复与待操作请求', 'Show only replies and action prompts')}
              trailing={(
                <Switch
                  label={t('隐藏工具输出', 'Hide tool output')}
                  checked={hideToolOutput}
                  onCheckedChange={setHideToolOutput}
                />
              )}
            />
            {!hideToolOutput && (
              <ListRow
                leading={<Code2 />}
                title={t('默认折叠工具输出', 'Collapse tool output')}
                subtitle={t('保留工具摘要，点击可展开详情', 'Show tool summaries that expand on tap')}
                trailing={(
                  <Switch
                    label={t('默认折叠工具输出', 'Collapse tool output')}
                    checked={collapseToolOutput}
                    onCheckedChange={setCollapseToolOutput}
                  />
                )}
              />
            )}
            <ListRow
              leading={<AudioLines />}
              title={t('语音朗读倍速', 'Speech rate')}
              trailing={(
                <span className="hst-select-wrap">
                  <select
                    aria-label={t('语音朗读倍速', 'Speech rate')}
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
                  <ChevronsUpDown size={14} aria-hidden="true" />
                </span>
              )}
            />
            {onOpenSystemSettings && (
              <ListRow
                leading={<Settings />}
                title={t('外观与系统设置', 'Theme & system settings')}
                subtitle={t('浅色/深色外观主题、语音唤醒词与系统权限', 'Light/dark theme, wake word & OS permissions')}
                chevron
                onClick={onOpenSystemSettings}
              />
            )}
            <ListRow
              leading={<Archive />}
              title={t('已归档 Bot', 'Archived bots')}
              subtitle={t('14 天后自动清理', '14d auto-delete')}
              value={<Badge tone="neutral">{archivedCount}</Badge>}
              chevron
              onClick={onOpenArchivedBots}
            />
            <ListRow
              leading={<Clock />}
              title={t('待发消息', 'Pending messages')}
              subtitle={t('离线时保留或尚未确认送达的消息', 'Messages kept offline or awaiting delivery')}
              chevron
              onClick={onOpenPending}
            />
          </Section>

          {/* 4. 更新与排障 */}
          <Section title={t('更新与排障', 'Updates & Advanced')}>
            <ListRow
              leading={<Download />}
              title={t('客户端更新', 'Client update')}
              value={
                updateSummary ||
                (hasCenterConfigured ? <Skeleton variant="text" width={56} height={12} inline /> : undefined)
              }
              chevron
              onClick={() => onOpenPage('updates')}
            />
            <ListRow
              leading={<Wrench />}
              title={t('高级网络与排障', 'Advanced network & troubleshooting')}
              subtitle={t('局域网直连调试、节点令牌与自签名 CA 证书', 'Direct LAN debugging, host token & custom CA PEM')}
              chevron
              onClick={() => onOpenPage('advanced')}
            />
          </Section>

          <div className="hst-exit">
            <button
              type="button"
              className="hst-btn is-danger"
              disabled={centerConn.busy}
              onClick={() => setSettingsConfirm({ kind: 'exit-client' })}
            >
              {t('退出客户端', 'Exit client')}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={settingsConfirm !== null}
        title={
          settingsConfirm?.kind === 'disconnect-center'
            ? t('断开中心连接', 'Disconnect from center')
            : settingsConfirm?.kind === 'delete-profile'
              ? t('删除局域网直连档案', 'Remove direct LAN profile')
              : t('退出客户端', 'Exit client')
        }
        description={
          settingsConfirm?.kind === 'disconnect-center'
            ? t('确定要断开与当前中心的连接吗？断开后将无法访问远端设备与中心管理，需要重新连接或配对。',
                'Disconnect from the current center? Remote devices and center management will be unavailable until you reconnect.')
            : settingsConfirm?.kind === 'delete-profile'
              ? t(`确定要删除局域网直连档案「${settingsConfirm.title}」吗？此操作不可恢复。`,
                  `Remove the direct LAN profile "${settingsConfirm.title}"? This cannot be undone.`)
              : t('确定要退出客户端并停止本机后台服务吗？运行中的本机 Bot 任务将被中断，且无法再接收远端调度。',
                  'Exit the client and stop the local background service? Running local Bot tasks will be interrupted and remote dispatch to this device will stop.')
        }
        confirmLabel={
          settingsConfirm?.kind === 'disconnect-center'
            ? t('断开中心', 'Disconnect center')
            : settingsConfirm?.kind === 'delete-profile'
              ? t('删除档案', 'Remove profile')
              : t('退出客户端', 'Exit client')
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
