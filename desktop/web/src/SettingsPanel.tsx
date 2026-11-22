// 桌面客户端全画布设置工作区（.desktop-settings-view）：左侧导航栏 + 右侧 720px 单列内容。
import {
  Archive,
  ArrowLeft,
  Check,
  ChevronRight,
  ClipboardCheck,
  Copy,
  Download,
  Globe,
  Monitor,
  RefreshCw,
  RotateCcw,
  Sliders,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { DesktopClientStatus, DesktopUiProfile } from '../../../host-core/desktop-client.js';
import type { BotDirectoryEntry, DevicesDirectoryItem } from '../../../host-core/index.js';
import type { DesktopIdentity } from './types';
import type { DesktopTheme } from './CenterGate';
import { HostServiceSection, useHostService } from './HostServiceSection';
import { ClientUpdateSection } from '../../../web/src/ClientUpdateSection';
import { ClipboardSyncSection } from '../../../web/src/ClipboardSyncSection';
import { Switch } from '../../../web/src/bot-settings/primitives';
import { ActionBar, Button, Dialog, InlineNotice, Segmented } from '../../../web/src/components/ui';
import { GrokBotAvatar } from '../../../web/src/GrokBotAvatar';
import { botAvatarKey } from '../../../web/src/botAvatarSync';
import { ErrorNotice, useCollapseToolOutput, useHideToolOutput, useText } from '../../../web/src/ui';
import { archiveExpiryAt, type BotChatsArchiveBridge } from './BotChats';
import type { CenterAdminTab } from '../../../web/src/center-admin/types';

export type SettingsTab = 'connection' | 'general' | 'clipboard' | 'updates' | 'advanced';
export type { CenterAdminTab } from '../../../web/src/center-admin/types';

const SPEECH_RATE_STORAGE_KEY = 'pibot-speech-rate:v1';
const SPEECH_RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;

function parseSpeechRate(raw: string | null): number {
  const num = Number(raw);
  return SPEECH_RATE_OPTIONS.some((rate) => rate === num) ? num : 1;
}

function useSpeechRatePreference(): [number, (rate: number) => void] {
  const changeEvent = SPEECH_RATE_STORAGE_KEY + ':change';
  const read = useCallback(() => {
    try {
      return parseSpeechRate(localStorage.getItem(SPEECH_RATE_STORAGE_KEY));
    } catch {
      return 1;
    }
  }, []);
  const [rate, setRate] = useState<number>(read);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<number>).detail;
      setRate(typeof detail === 'number' ? parseSpeechRate(String(detail)) : read());
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === SPEECH_RATE_STORAGE_KEY) setRate(read());
    };
    window.addEventListener(changeEvent, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(changeEvent, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [changeEvent, read]);

  const write = useCallback((next: number) => {
    const valid = parseSpeechRate(String(next));
    try {
      localStorage.setItem(SPEECH_RATE_STORAGE_KEY, String(valid));
    } catch {
      // Keep the preference in memory if storage is unavailable.
    }
    setRate(valid);
    try {
      window.dispatchEvent(new CustomEvent(changeEvent, { detail: valid }));
    } catch {
      // Local state is already updated.
    }
  }, [changeEvent]);

  return [rate, write];
}

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
  activeTab: SettingsTab;
  onTabChange(tab: SettingsTab): void;
  onBack(): void;
  onOpenCenterAdmin(tab?: CenterAdminTab): void;
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
  centerStatus: CenterStatusLite | undefined;
  onDisconnectCenter(): Promise<void>;
  onSaveCenterCa(ca: string): Promise<void>;
  devices: DevicesSectionState;
  currentDeviceId: string;
  theme: DesktopTheme;
  onThemeChange(theme: DesktopTheme): void;
  actionError: string | null;
  onDismissActionError(): void;
  archiveBridge?: BotChatsArchiveBridge | null;
  onOpenArchivedBotHistory?(bot: BotDirectoryEntry): void;
}

function ArchivedBots({
  bridge,
  transportConnected,
  onOpenHistory,
}: {
  bridge?: BotChatsArchiveBridge | null;
  transportConnected: boolean;
  onOpenHistory?: (bot: BotDirectoryEntry) => void;
}) {
  const t = useText();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDeleteBot, setConfirmDeleteBot] = useState<BotDirectoryEntry | null>(null);
  const [error, setError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const mountedRef = useRef(true);
  const liveRef = useRef({ bridge, transportConnected });
  liveRef.current = { bridge, transportConnected };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const items = bridge?.archivedBots ?? [];
  const bridgeOnline = Boolean(transportConnected && bridge?.online);

  const deviceNameOf = (bot: BotDirectoryEntry) =>
    bridge?.devices.find((item) => item.deviceId === bot.deviceId)?.displayName
    || bot.deviceName
    || t('未命名设备', 'Unnamed device');

  const run = async (bot: BotDirectoryEntry, action: 'restore' | 'delete') => {
    if (busy) return;
    const { bridge: currentBridge, transportConnected: currentConnected } = liveRef.current;
    const currentBot = currentBridge?.archivedBots.find(
      (item) => item.deviceId === bot.deviceId && item.botId === bot.botId,
    ) ?? null;

    if (action === 'delete') {
      setDeleteError('');
      if (!currentConnected || !currentBridge?.online) {
        setDeleteError(t('永久删除失败 · 当前连接已断开，请恢复连接后再试。', 'Permanent delete failed · Connection is offline. Reconnect and try again.'));
        return;
      }
      if (!currentBot) {
        setDeleteError(t('永久删除失败 · 未在当前归档列表中找到该智能体，请刷新确认。', 'Permanent delete failed · Target agent is no longer in the archived list. Refresh to verify.'));
        return;
      }
      if (!currentBot.online) {
        setDeleteError(t('永久删除失败 · 目标设备当前离线，请待设备恢复在线后再试。', 'Permanent delete failed · Target device is currently offline. Retry when it is back online.'));
        return;
      }
      if (currentBot.isPrimary) {
        setDeleteError(t('永久删除失败 · 主智能体不可永久删除。', 'Permanent delete failed · Primary agent cannot be permanently deleted.'));
        return;
      }
    } else {
      setError('');
      if (!currentConnected || !currentBridge?.online || !currentBot || !currentBot.online) {
        setError(t('恢复失败 · 当前连接或目标设备离线，请恢复在线后重试。', 'Restore failed · Connection or target device is offline. Reconnect and try again.'));
        return;
      }
    }

    const key = JSON.stringify([currentBot.deviceId, currentBot.botId]);
    setBusy(key);
    try {
      if (action === 'restore') {
        await currentBridge.unarchiveBot(currentBot);
      } else {
        const result = (await currentBridge.deleteBot(currentBot)) as unknown;
        if (!mountedRef.current) return;
        const { bridge: afterBridge, transportConnected: afterConnected } = liveRef.current;
        const afterBot = afterBridge?.archivedBots.find(
          (item) => item.deviceId === currentBot.deviceId && item.botId === currentBot.botId,
        ) ?? null;
        if (result === false || !afterConnected || !afterBridge || !afterBridge.online || (afterBot && !afterBot.online)) {
          setDeleteError(t('永久删除失败 · 连接已断开，未能确认删除结果，请恢复连接后刷新归档列表确认。', 'Permanent delete failed · Connection dropped before deletion could be confirmed. Reconnect and refresh the archive list to verify.'));
          return;
        }
        setDeleteError('');
        setConfirmDeleteBot(null);
      }
    } catch (failure) {
      if (!mountedRef.current) return;
      const message = failure instanceof Error ? failure.message : String(failure);
      if (action === 'restore') {
        setError(t('恢复失败 · ', 'Restore failed · ') + message);
      } else {
        setDeleteError(t('永久删除失败 · ', 'Permanent delete failed · ') + message);
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const liveDeleteBot = confirmDeleteBot
    ? items.find(
        (item) =>
          item.deviceId === confirmDeleteBot.deviceId &&
          item.botId === confirmDeleteBot.botId,
      ) ?? null
    : null;
  const targetDeleteBot = liveDeleteBot ?? confirmDeleteBot;
  const deleteTargetMissing = Boolean(confirmDeleteBot && !liveDeleteBot);
  const deleteTargetOnline = Boolean(
    bridgeOnline && liveDeleteBot && liveDeleteBot.online && !liveDeleteBot.isPrimary,
  );
  const confirmDeleteBusy = Boolean(
    confirmDeleteBot &&
      busy === JSON.stringify([confirmDeleteBot.deviceId, confirmDeleteBot.botId]),
  );
  const confirmDeleteDevice = targetDeleteBot ? deviceNameOf(targetDeleteBot) : '';

  return (
    <section className="settings-section">
      <div className="section-head">
        <h4>{t(`已归档智能体（${items.length}）`, `Archived agents (${items.length})`)}</h4>
        <button
          type="button"
          className="secondary-button"
          disabled={!bridgeOnline || bridge?.loading}
          onClick={() => bridge?.refresh()}
        >
          <RefreshCw size={13} aria-hidden />
          {t('刷新归档', 'Refresh')}
        </button>
      </div>
      <p className="metadata" style={{ marginBottom: 'var(--space-2)' }}>
        {t('归档后的智能体将在 14 天后自动清理。', 'Archived agents are automatically cleaned up after 14 days.')}
      </p>
      <ErrorNotice compact error={error} onDismiss={() => setError('')} />
      <ErrorNotice compact error={bridge?.error} />
      {items.length === 0 ? (
        <p className="empty-state">
          {bridge?.loading ? t('正在读取已归档智能体…', 'Loading archived agents…') : t('暂无已归档的智能体。', 'No archived agents.')}
        </p>
      ) : (
        <div className="settings-row-group">
          {items.map((bot) => {
            const key = JSON.stringify([bot.deviceId, bot.botId]);
            const online = Boolean(bridgeOnline && bot.online);
            const device = deviceNameOf(bot);
            const expiry = archiveExpiryAt(bot.archivedAt);
            return (
              <div
                className="settings-row"
                key={key}
                style={{ flexWrap: 'wrap', paddingBlock: 'var(--space-3)' }}
              >
                <GrokBotAvatar
                  botKey={botAvatarKey(bot)}
                  roleName={bot.role}
                  isPrimary={false}
                  platformBadge={bot.platform || 'host'}
                  size={34}
                />
                <span className="settings-row-label">
                  <strong style={{ display: 'block', fontSize: '14px', fontWeight: 600 }}>{bot.role}</strong>
                  <span className="metadata" style={{ display: 'block' }}>
                    {device} · {online ? t('在线', 'Online') : t('离线', 'Offline')} · {expiry === null
                      ? t('清理日期未知', 'Expiry unknown')
                      : t(`自动清理于 ${new Date(expiry).toLocaleDateString()}`, `Auto-deletes ${new Date(expiry).toLocaleDateString()}`)}
                  </span>
                </span>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', flexShrink: 0 }}>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onOpenHistory?.(bot)}
                  >
                    {t('查看对话', 'View chat')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!online || busy !== null}
                    onClick={() => void run(bot, 'restore')}
                  >
                    <RotateCcw size={13} aria-hidden />
                    {busy === key ? t('处理中…', 'Working…') : t('恢复', 'Restore')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button danger-outline"
                    disabled={!online || busy !== null}
                    onClick={() => {
                      setError('');
                      setDeleteError('');
                      setConfirmDeleteBot(bot);
                    }}
                  >
                    <Trash2 size={13} aria-hidden />
                    {t('永久删除', 'Delete permanently')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={confirmDeleteBot !== null}
        onOpenChange={(open) => {
          if (!open && !confirmDeleteBusy) {
            setConfirmDeleteBot(null);
            setDeleteError('');
          }
        }}
        title={t('永久删除智能体', 'Permanently delete agent')}
        overlayClassName="bs-confirm-overlay"
        className="bs-confirm-dialog"
        closeDisabled={confirmDeleteBusy}
      >
        <p className="secondary">
          {targetDeleteBot
            ? t(`将永久删除 ${confirmDeleteDevice} 上的「${targetDeleteBot.role}」及其全部聊天历史，此操作无法撤销。`, `Permanently delete "${targetDeleteBot.role}" on ${confirmDeleteDevice} and all its chat history? This cannot be undone.`)
            : ''}
        </p>
        {confirmDeleteBot && !deleteTargetOnline && (
          <InlineNotice
            tone="warning"
            title={
              deleteTargetMissing
                ? t('未在当前归档列表中找到该智能体', 'Agent not found in current archived list')
                : !bridgeOnline
                  ? t('当前连接已断开，无法永久删除', 'Connection lost — cannot permanently delete')
                  : liveDeleteBot?.isPrimary
                    ? t('主智能体不可永久删除', 'Primary agent cannot be permanently deleted')
                    : t('目标设备当前离线，无法永久删除', 'Target device is offline — cannot permanently delete')
            }
            description={
              deleteTargetMissing
                ? t('该智能体可能已被恢复或删除，请关闭后刷新归档列表确认。', 'It may have already been restored or deleted. Close this dialog and refresh the archived list to verify.')
                : liveDeleteBot?.isPrimary
                  ? undefined
                  : t('请待中心连接与目标设备恢复在线后再执行删除。', 'Wait until both the center connection and target device are online before deleting.')
            }
          />
        )}
        <ErrorNotice compact error={deleteError} onDismiss={() => setDeleteError('')} />
        <ActionBar align="end" className="ui-confirm-actions">
          <Button
            variant="secondary"
            disabled={confirmDeleteBusy}
            onClick={() => {
              setConfirmDeleteBot(null);
              setDeleteError('');
            }}
          >
            {t('取消', 'Cancel')}
          </Button>
          <Button
            variant="danger"
            loading={confirmDeleteBusy}
            disabled={confirmDeleteBusy || !deleteTargetOnline}
            onClick={() => {
              if (targetDeleteBot) void run(targetDeleteBot, 'delete');
            }}
          >
            {t('确认永久删除', 'Delete permanently')}
          </Button>
        </ActionBar>
      </Dialog>
    </section>
  );
}

function LocalDebugProfiles(props: SettingsPanelProps) {
  const t = useText();
  const { profiles, profilesBusy, profilesError, form, selectedProfile, transportConnected, identity, status } = props;
  // 剔除与主中心连接重复混淆的 Center Relay 档案，仅保留局域网直连调试档案。
  const localProfiles = profiles.filter((profile) => profile.kind === 'local');
  const activeLocalProfile = selectedProfile?.kind === 'local' ? selectedProfile : localProfiles[0] ?? null;
  const activeId = identity?.kind === 'local' ? identity.profileId : null;
  const selectedIsActive = Boolean(activeLocalProfile && activeId === activeLocalProfile.id && transportConnected);

  return (
    <div className="diagnostics-block">
      <p className="metadata">
        {t('仅用于无中心网络下的局域网直连调试。切换档案时保留当前已填令牌。', 'For LAN direct debugging without a center server. Entered tokens are kept when switching profiles.')}
      </p>
      <ErrorNotice compact error={profilesError} />
      {localProfiles.length > 0 ? (
        <ul className="profile-list" style={{ marginTop: 'var(--space-2)' }}>
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
                {transportConnected && activeId === profile.id && (
                  <span className="status online">{t('当前直连', 'Connected')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="metadata" style={{ marginTop: 'var(--space-2)' }}>
          {t('暂无局域网直连调试档案。', 'No LAN direct debug profiles saved.')}
        </p>
      )}

      {activeLocalProfile && (
        <div className="settings-connect" style={{ marginTop: 'var(--space-2)' }}>
          {selectedIsActive ? (
            <button type="button" className="secondary-button" onClick={props.onDisconnect} disabled={profilesBusy}>
              {t('断开直连', 'Disconnect direct link')}
            </button>
          ) : (
            <>
              <label>
                {t(`本机直连令牌（${activeLocalProfile.title}）`, `Direct access token (${activeLocalProfile.title})`)}
                <input
                  type="password"
                  autoComplete="off"
                  value={props.token}
                  onChange={(event) => props.onTokenChange(event.target.value)}
                  placeholder={t('输入目标设备的直连令牌', 'Enter target device direct token')}
                />
              </label>
              <div className="dialog-actions">
                <button type="button" className="primary-button" onClick={props.onConnect} disabled={profilesBusy}>
                  {transportConnected ? t('切换到此直连', 'Switch to this direct link') : t('连接直连档案', 'Connect profile')}
                </button>
              </div>
            </>
          )}
          {status && (
            <div className="metadata">
              {t('连接代次', 'Generation')} {status.generation} · {status.phase}{status.errorCode ? ' · ' + status.errorCode : ''}
            </div>
          )}
        </div>
      )}

      <details className="settings-disclosure" style={{ marginTop: 'var(--space-3)' }}>
        <summary>{t('新增局域网直连档案', 'Add LAN direct profile')}</summary>
        <form className="form-grid" onSubmit={props.onSaveProfile}>
          <label>
            {t('名称（可选）', 'Name (optional)')}
            <input
              value={form.title}
              onChange={(event) => props.onFormChange({ title: event.target.value, kind: 'local' })}
              placeholder={t('例如：办公室台式机', 'e.g. Office desktop')}
            />
          </label>
          <label>
            {t('期望设备 ID（可选）', 'Expected device ID (optional)')}
            <input
              value={form.expectedDeviceId}
              onChange={(event) => props.onFormChange({ expectedDeviceId: event.target.value, kind: 'local' })}
            />
          </label>
          <label className="form-grid-full">
            {t('设备局域网地址', 'Device LAN URL')}
            <input
              required
              type="url"
              value={form.url}
              onChange={(event) => props.onFormChange({ url: event.target.value, kind: 'local' })}
              placeholder="http://192.168.1.x:port"
            />
          </label>
          <div className="form-grid-full">
            <button type="submit" className="primary-button" disabled={profilesBusy}>
              {t('保存直连档案', 'Save direct profile')}
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}

function CustomCaSection({
  centerStatus,
  onSaveCenterCa,
}: Pick<SettingsPanelProps, 'centerStatus' | 'onSaveCenterCa'>) {
  const t = useText();
  const savedCa = centerStatus?.savedConnection?.ca ?? '';
  const [caDraft, setCaDraft] = useState(savedCa);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [error, setError] = useState('');
  const mountedRef = useRef(true);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current !== null) {
        clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, []);

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
      if (!mountedRef.current) return;
      setDirty(false);
      setSavedOk(true);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        savedTimerRef.current = null;
        if (mountedRef.current) setSavedOk(false);
      }, 2000);
    } catch (failure) {
      if (!mountedRef.current) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  return (
    <div className="diagnostics-block">
      <p id="desktop-custom-ca-pem-hint" className="metadata">
        {t('仅用于自建 HTTPS 中心的私有根证书（PEM 格式）。', 'Only needed for self-hosted HTTPS centers using a private root certificate (PEM format).')}
      </p>
      <div className="settings-connect" style={{ marginTop: 'var(--space-2)' }}>
        <label htmlFor="desktop-custom-ca-pem">
          {t('自定义 CA 根证书（PEM）', 'Custom CA root certificate (PEM)')}
        </label>
        <textarea
          id="desktop-custom-ca-pem"
          aria-describedby="desktop-custom-ca-pem-hint"
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
            {busy ? t('正在保存…', 'Saving…') : t('保存 CA 证书', 'Save CA certificate')}
          </button>
          {savedOk && <span className="status online">{t('已保存并生效', 'Saved and applied')}</span>}
        </div>
        <ErrorNotice compact error={error} onDismiss={() => setError('')} />
      </div>
    </div>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const t = useText();
  const { activeTab, onTabChange, onBack, onOpenCenterAdmin, centerStatus, devices, identity } = props;
  const [hideToolOutput, setHideToolOutput] = useHideToolOutput();
  const [collapseToolOutput, setCollapseToolOutput] = useCollapseToolOutput();
  const [speechRate, setSpeechRate] = useSpeechRatePreference();
  const [copiedClientId, setCopiedClientId] = useState(false);
  const [centerBusy, setCenterBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const copyClientIdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostService = useHostService(activeTab === 'connection');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyClientIdTimerRef.current !== null) {
        clearTimeout(copyClientIdTimerRef.current);
        copyClientIdTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [activeTab]);

  const centerReady = centerStatus?.state === 'ready';
  const centerConnecting = centerStatus?.state === 'connecting';
  const centerLabel = centerReady
    ? t('已连接', 'Connected')
    : centerConnecting
      ? t('正在恢复连接', 'Reconnecting')
      : t('未连接', 'Disconnected');
  const centerTone = centerReady ? 'online' : centerConnecting ? 'warn' : 'muted';

  const localDeviceId = identity?.kind === 'local'
    ? props.currentDeviceId
    : (hostService.host?.configured ? hostService.host.deviceId : null) || props.currentDeviceId || null;

  const currentDevice = devices.items.find((item) => item.deviceId === localDeviceId);
  const currentDeviceName = currentDevice?.displayName
    || hostService.host?.displayName
    || hostService.host?.hostname
    || localDeviceId
    || t('本机设备', 'This device');

  const deviceCount = devices.items.length > 0
    ? devices.items.length
    : (props.archiveBridge?.devices.length ?? 0);
  const hasMoreDevices = devices.nextCursor !== null;

  const handleDisconnectCenter = async () => {
    if (centerBusy) return;
    setCenterBusy(true);
    try {
      await props.onDisconnectCenter();
    } finally {
      if (mountedRef.current) setCenterBusy(false);
    }
  };

  const copyClientId = () => {
    if (!centerStatus?.clientId) return;
    void navigator.clipboard?.writeText(centerStatus.clientId).then(() => {
      if (!mountedRef.current) return;
      setCopiedClientId(true);
      if (copyClientIdTimerRef.current !== null) clearTimeout(copyClientIdTimerRef.current);
      copyClientIdTimerRef.current = setTimeout(() => {
        copyClientIdTimerRef.current = null;
        if (mountedRef.current) setCopiedClientId(false);
      }, 1500);
    }).catch(() => {});
  };

  const navItems: Array<{ id: SettingsTab; label: string }> = [
    { id: 'connection', label: t('连接与本机服务', 'Connection & Service') },
    { id: 'general', label: t('外观与对话', 'Appearance & Chat') },
    { id: 'clipboard', label: t('剪贴板同步', 'Clipboard Sync') },
    { id: 'updates', label: t('客户端更新', 'Client Updates') },
    { id: 'advanced', label: t('高级与归档', 'Advanced & Archive') },
  ];

  const renderTabIcon = (id: SettingsTab) => {
    if (id === 'connection') return <Globe size={16} aria-hidden />;
    if (id === 'general') return <Sliders size={16} aria-hidden />;
    if (id === 'clipboard') return <ClipboardCheck size={16} aria-hidden />;
    if (id === 'updates') return <Download size={16} aria-hidden />;
    return <Archive size={16} aria-hidden />;
  };

  return (
    <div className="desktop-settings-view">
      <aside className="desktop-settings-sidebar">
        <div className="desktop-settings-sidebar-head">
          <button type="button" className="quiet-button" onClick={onBack}>
            <ArrowLeft size={15} aria-hidden />
            <span>{t('返回', 'Back')}</span>
          </button>
          <h2 className="desktop-settings-title">{t('设置', 'Settings')}</h2>
        </div>

        <nav className="desktop-settings-nav" aria-label={t('设置分栏', 'Settings sections')}>
          {navItems.map((tab) => {
            const active = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                className={'desktop-settings-nav-item' + (active ? ' active' : '')}
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
      </aside>

      <div className="desktop-settings-main" ref={bodyRef}>
        <div className="desktop-settings-inner">
          {props.actionError && (
            <ErrorNotice compact error={props.actionError} onDismiss={props.onDismissActionError} />
          )}

          {activeTab === 'connection' && (
            <>
              <div className="settings-pane-header">
                <h3>{t('连接与本机服务', 'Connection & Local Service')}</h3>
                <p className="metadata">
                  {t('查看 PiBot 中心连接状态、已接入设备概览与本机后台服务。', 'Monitor PiBot Center connection, connected devices, and the local background service.')}
                </p>
              </div>

              <div
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--surface)',
                  padding: 'var(--space-4)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-3)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-3)',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                      <span className={`host-status-pill ${centerTone}`}>
                        <span className="host-status-dot" aria-hidden />
                        {centerLabel}
                      </span>
                      <strong style={{ fontSize: '15px', fontWeight: 600 }}>
                        {t('PiBot 中心', 'PiBot Center')}
                      </strong>
                    </div>
                    <span className="metadata">
                      {centerStatus?.centerUrl || t('未绑定中心地址', 'Not bound to a center')}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={centerBusy}
                    onClick={() => void handleDisconnectCenter()}
                  >
                    {centerBusy ? t('正在断开…', 'Disconnecting…') : t('切换或断开中心', 'Switch or disconnect center')}
                  </button>
                </div>

                <div
                  style={{
                    borderTop: '1px solid var(--line-subtle)',
                    paddingTop: 'var(--space-3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 'var(--space-3)',
                    flexWrap: 'wrap',
                  }}
                >
                  <span className="metadata">{t('当前设备', 'Current device')}</span>
                  <span style={{ fontSize: '13.5px', fontWeight: 500, color: 'var(--text)' }}>
                    {currentDeviceName}
                  </span>
                </div>
              </div>

              <section className="settings-section">
                <div className="settings-row-group">
                  <div className="settings-row">
                    <span className="settings-row-icon" aria-hidden>
                      <Monitor size={16} />
                    </span>
                    <span className="settings-row-label">
                      <span>
                        {devices.busy && !devices.loaded && deviceCount === 0
                          ? t('正在读取设备…', 'Loading devices…')
                          : hasMoreDevices
                            ? t(`已接入 ${deviceCount}+ 台设备`, `${deviceCount}+ connected devices`)
                            : t(`已接入 ${deviceCount} 台设备`, `${deviceCount} connected ${deviceCount === 1 ? 'device' : 'devices'}`)}
                      </span>
                      <span className="metadata" style={{ display: 'block' }}>
                        {t('配对新设备、重命名或移除设备请前往中心管理', 'Pair, rename, or remove devices in Center Admin')}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => onOpenCenterAdmin('devices')}
                    >
                      {t('前往中心管理', 'Open Center Admin')}
                      <ChevronRight size={14} aria-hidden />
                    </button>
                  </div>
                </div>
              </section>

              <HostServiceSection
                service={hostService}
                active={activeTab === 'connection'}
                diagnosticExtra={{
                  centerState: centerStatus?.state ?? null,
                  centerUrl: centerStatus?.centerUrl ?? null,
                  clientId: centerStatus?.clientId ?? null,
                  brokerPhase: props.status?.phase ?? null,
                  brokerGeneration: props.status?.generation ?? null,
                  brokerErrorCode: props.status?.errorCode ?? null,
                }}
              />

              {centerStatus?.clientId && (
                <section className="settings-section">
                  <details className="settings-disclosure">
                    <summary>{t('连接详情', 'Connection details')}</summary>
                    <div className="settings-client-id">
                      <span>{t('客户端标识', 'Client ID')} {centerStatus.clientId}</span>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={copyClientId}
                        aria-label={copiedClientId ? t('已复制客户端标识', 'Client ID copied') : t('复制客户端标识', 'Copy client ID')}
                      >
                        {copiedClientId ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                      </button>
                    </div>
                  </details>
                </section>
              )}
            </>
          )}

          {activeTab === 'general' && (
            <>
              <div className="settings-pane-header">
                <h3>{t('外观与对话', 'Appearance & Chat')}</h3>
                <p className="metadata">
                  {t('设置界面主题、工具输出展示方式与语音朗读倍速。', 'Configure interface theme, tool output visibility, and speech rate.')}
                </p>
              </div>

              <section className="settings-section">
                <h4>{t('外观主题', 'Appearance theme')}</h4>
                <Segmented<DesktopTheme>
                  aria-label={t('外观主题', 'Appearance theme')}
                  value={props.theme}
                  onChange={props.onThemeChange}
                  options={[
                    { value: 'system', label: t('跟随系统', 'System') },
                    { value: 'light', label: t('浅色', 'Light') },
                    { value: 'dark', label: t('深色', 'Dark') },
                  ]}
                />
              </section>

              <section className="settings-section">
                <h4>{t('对话与语音', 'Chat & Speech')}</h4>
                <div className="settings-row-group">
                  <label className="settings-row settings-row-link">
                    <span className="settings-row-label">
                      <span>{t('隐藏工具输出', 'Hide Tool Output')}</span>
                      <span className="metadata" style={{ display: 'block' }}>
                        {t('只显示回复与待操作请求', 'Show replies and prompts that need your input')}
                      </span>
                    </span>
                    <Switch
                      label={t('隐藏工具输出', 'Hide Tool Output')}
                      checked={hideToolOutput}
                      onChange={setHideToolOutput}
                    />
                  </label>
                  {!hideToolOutput && (
                    <label className="settings-row settings-row-link">
                      <span className="settings-row-label">
                        <span>{t('默认折叠工具输出', 'Collapse Tool Output by Default')}</span>
                        <span className="metadata" style={{ display: 'block' }}>
                          {t('保留工具调用摘要，点击可展开详情', 'Show tool summaries that can be expanded')}
                        </span>
                      </span>
                      <Switch
                        label={t('默认折叠工具输出', 'Collapse Tool Output by Default')}
                        checked={collapseToolOutput}
                        onChange={setCollapseToolOutput}
                      />
                    </label>
                  )}
                  <label className="settings-row">
                    <span className="settings-row-label">
                      <span>{t('语音朗读倍速', 'Speech Rate')}</span>
                      <span className="metadata" style={{ display: 'block' }}>
                        {t('调整回复朗读的默认语速', 'Adjust default playback speed for spoken replies')}
                      </span>
                    </span>
                    <select
                      aria-label={t('语音朗读倍速', 'Speech Rate')}
                      value={String(speechRate)}
                      onChange={(event) => setSpeechRate(Number(event.target.value))}
                      style={{
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--surface-elevated)',
                        color: 'var(--text)',
                        padding: '6px 10px',
                        fontSize: '13px',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {SPEECH_RATE_OPTIONS.map((rate) => (
                        <option key={rate} value={String(rate)}>
                          {rate}×
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
            </>
          )}

          {activeTab === 'clipboard' && (
            <>
              <div className="settings-pane-header">
                <h3>{t('剪贴板同步', 'Clipboard Sync')}</h3>
                <p className="metadata">
                  {t('按设备独立开关，与加入同一邀请组的设备同步文本剪贴板。', 'Per-device toggle to sync text clipboard across devices in the same group.')}
                </p>
              </div>
              <ClipboardSyncSection variant="desktop" />
            </>
          )}

          {activeTab === 'updates' && (
            <>
              <div className="settings-pane-header">
                <h3>{t('客户端更新', 'Client Updates')}</h3>
                <p className="metadata">
                  {t('查看当前版本、检查更新并安装桌面客户端新版本。', 'Check your current version and install desktop client updates.')}
                </p>
              </div>
              <ClientUpdateSection variant="desktop" />
            </>
          )}

          {activeTab === 'advanced' && (
            <>
              <div className="settings-pane-header">
                <h3>{t('高级与归档', 'Advanced & Archive')}</h3>
                <p className="metadata">
                  {t('管理已归档智能体、私有根证书与局域网直连调试档案。', 'Manage archived agents, custom root certificates, and LAN direct debug profiles.')}
                </p>
              </div>

              <ArchivedBots
                bridge={props.archiveBridge}
                transportConnected={props.transportConnected}
                onOpenHistory={props.onOpenArchivedBotHistory}
              />

              <section className="settings-section">
                <details className="settings-disclosure">
                  <summary>{t('自定义 CA 证书', 'Custom CA certificate')}</summary>
                  <CustomCaSection
                    centerStatus={centerStatus}
                    onSaveCenterCa={props.onSaveCenterCa}
                  />
                </details>
              </section>

              <section className="settings-section">
                <details className="settings-disclosure">
                  <summary>{t('局域网 IP 直连调试', 'LAN direct IP debugging')}</summary>
                  <LocalDebugProfiles {...props} />
                </details>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
