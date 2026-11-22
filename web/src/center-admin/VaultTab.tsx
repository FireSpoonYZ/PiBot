import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { Lock, RefreshCw, Settings2, Unlock } from 'lucide-react';
import { LabelStack, ReservedSlot } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  BotTreeSelector,
  CaCardSkeleton,
  CaConfirmDialog,
  CaModal,
  CaNotice,
  CaRefreshBar,
  CaSectionSkeleton,
  CaSegmented,
  botKey,
  formatTime,
  useCaTabNotices,
  useUiLocale,
} from './primitives';
import type {
  BotCapabilityConfig,
  CenterBotRef,
  CenterDevice,
  ExternalVaultCheckResult,
  ExternalVaultGrant,
  ExternalVaultItemMeta,
  ExternalVaultListResult,
  ExternalVaultStatus,
  Installation,
  VaultSource,
} from './types';

interface VaultCacheData {
  status: ExternalVaultStatus;
  items: ExternalVaultItemMeta[];
  listRevision: number;
  devices: CenterDevice[];
  bots: CenterBotRef[];
  vaultInstall: Installation | null;
  vaultCapBindings: Array<[string, BotCapabilityConfig]>;
}

type VaultModal =
  | null
  | { kind: 'settings' }
  | { kind: 'unlock' }
  | { kind: 'grant'; secretRef: string }
  | { kind: 'confirm-logout' };

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'muted' }): React.JSX.Element {
  const bg =
    tone === 'ok'
      ? 'var(--ca-ok)'
      : tone === 'warn'
        ? 'var(--ca-warn)'
        : 'var(--ca-text-subtle)';
  return <span className="ca-dot" style={{ background: bg }} aria-hidden="true" />;
}

export function VaultTab({
  api,
  active = true,
  cacheKey = 'default',
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
}): React.JSX.Element {
  const t = useText();
  const locale = useUiLocale();

  const initialCache = useMemo(
    () => readTabCache<VaultCacheData>(cacheKey, 'vault')?.data ?? null,
    [cacheKey],
  );
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [initialError, setInitialError] = useState('');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [status, setStatus] = useState<ExternalVaultStatus | null>(() => initialCache?.status ?? null);
  const [items, setItems] = useState<ExternalVaultItemMeta[]>(() => initialCache?.items ?? []);
  const [listRevision, setListRevision] = useState(() => initialCache?.listRevision ?? 0);
  const [query, setQuery] = useState('');

  const [devices, setDevices] = useState<CenterDevice[]>(() => initialCache?.devices ?? []);
  const [bots, setBots] = useState<CenterBotRef[]>(() => initialCache?.bots ?? []);

  // Local vault capability (`e-launcher.vault`) if installed
  const [vaultInstall, setVaultInstall] = useState<Installation | null>(
    () => initialCache?.vaultInstall ?? null,
  );
  const [vaultCapBindings, setVaultCapBindings] = useState<Map<string, BotCapabilityConfig>>(
    () => new Map(initialCache?.vaultCapBindings ?? []),
  );
  const [capBusyKeys, setCapBusyKeys] = useState<Set<string>>(new Set());

  // Mutually exclusive modal state
  const [modal, setModal] = useState<VaultModal>(null);
  const settingsOpenRef = useRef(false);
  settingsOpenRef.current = modal?.kind === 'settings';

  // Unlock modal state
  const [masterPassword, setMasterPassword] = useState('');
  const [unlockError, setUnlockError] = useState('');

  // Settings modal state
  const [sourceDraft, setSourceDraft] = useState<VaultSource>(() => initialCache?.status.source ?? 'local');
  const [serverUrlDraft, setServerUrlDraft] = useState(() => initialCache?.status.serverUrl ?? '');
  const [emailDraft, setEmailDraft] = useState(() => initialCache?.status.email ?? '');
  const [settingsError, setSettingsError] = useState('');
  const [checkFeedback, setCheckFeedback] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  // Grant modal state
  const [grantBusyKeys, setGrantBusyKeys] = useState<Set<string>>(new Set());
  const [grantError, setGrantError] = useState('');

  const hasLoadedRef = useRef(hasLoaded);
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);

  const { showNotice, clearNotice } = useCaTabNotices('vault', active);

  const setError = useCallback(
    (msg: string) => {
      if (msg) showNotice('error', msg, { tone: 'danger' });
      else clearNotice('error');
    },
    [clearNotice, showNotice],
  );

  const setNotice = useCallback(
    (msg: string) => {
      if (msg) showNotice('notice', msg, { tone: 'ok' });
      else clearNotice('notice');
    },
    [clearNotice, showNotice],
  );

  const loadAll = useCallback(async () => {
    const [st, sync, caps] = await Promise.all([
      api.vaultControl<ExternalVaultStatus>({ action: 'status' }),
      api.getBotSync(),
      api.listCapabilities().catch(() => [] as Installation[]),
    ]);
    setStatus(st);
    if (!settingsOpenRef.current) {
      setSourceDraft(st.source);
      setServerUrlDraft(st.serverUrl ?? '');
      setEmailDraft(st.email ?? '');
    }
    setDevices(sync.devices);
    setBots(sync.bots ?? []);

    const vCap = caps.find(c => c.packageId === 'e-launcher.vault') ?? null;
    setVaultInstall(vCap);
    const activeBots = (sync.bots ?? []).filter(b => !b.archivedAt);

    const [listRes, bindingsRec] = await Promise.all([
      st.source === 'vaultwarden' && !st.locked
        ? api.vaultControl<ExternalVaultListResult>({ action: 'list' }).catch(() => null)
        : Promise.resolve(null),
      vCap
        ? api
            .getInstallationBotBindings(vCap.installationId, activeBots)
            .catch(() => ({} as Record<string, BotCapabilityConfig>))
        : Promise.resolve(null),
    ]);

    if (st.source === 'vaultwarden' && !st.locked) {
      if (listRes) {
        setItems(listRes.items);
        setListRevision(listRes.revision);
      }
    } else {
      setItems([]);
    }

    if (vCap && bindingsRec) {
      const map = new Map<string, BotCapabilityConfig>();
      for (const b of activeBots) {
        const key = botKey(b.deviceId, b.botId);
        const cfg = bindingsRec[key] ?? bindingsRec[`${b.deviceId}:${b.botId}`];
        if (cfg) map.set(key, cfg);
      }
      setVaultCapBindings(map);
    } else {
      setVaultCapBindings(new Map());
    }
    hasLoadedRef.current = true;
    cacheKeyRef.current = cacheKey;
    setHasLoaded(true);
    setInitialError('');
    clearNotice('load-error');
  }, [api, cacheKey, clearNotice]);

  const runLoad = useCallback(async () => {
    const gen = ++loadGenRef.current;
    if (hasLoadedRef.current) setRefreshing(true);
    try {
      await loadAll();
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      const t = tRef.current;
      const msg = errorMessage(err, t('加载密码库状态失败，请检查中心连接后重试', 'Failed to load vault status. Check center connectivity and try again.'));
      if (hasLoadedRef.current) {
        if (activeRef.current) {
          showNotice('load-error', msg, {
            tone: 'danger',
            action: {
              label: t('重试', 'Retry'),
              onClick: () => void runLoad(),
            },
          });
        }
      } else {
        setInitialError(msg);
      }
    } finally {
      if (gen === loadGenRef.current) setRefreshing(false);
    }
  }, [loadAll, showNotice]);

  useEffect(() => {
    void runLoad();
  }, [runLoad]);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!wasActive && active && (hasLoadedRef.current || initialError)) {
      void runLoad();
    }
  }, [active, initialError, runLoad]);

  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
      setMasterPassword('');
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || !status || cacheKeyRef.current !== cacheKey) return;
    writeTabCache<VaultCacheData>(cacheKey, 'vault', {
      status,
      items,
      listRevision,
      devices,
      bots,
      vaultInstall,
      vaultCapBindings: Array.from(vaultCapBindings.entries()),
    });
  }, [bots, cacheKey, devices, hasLoaded, items, listRevision, status, vaultCapBindings, vaultInstall]);

  const openSettingsModal = () => {
    if (status) {
      setSourceDraft(status.source);
      setServerUrlDraft(status.serverUrl ?? '');
      setEmailDraft(status.email ?? '');
    }
    setSettingsError('');
    setCheckFeedback(null);
    setModal({ kind: 'settings' });
  };

  const openUnlockModal = () => {
    setMasterPassword('');
    setUnlockError('');
    setModal({ kind: 'unlock' });
  };

  const openGrantModal = (secretRef: string) => {
    setGrantError('');
    setModal({ kind: 'grant', secretRef });
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status || busy) return;
    if (sourceDraft === 'vaultwarden' && (!serverUrlDraft.trim() || !emailDraft.trim())) {
      setSettingsError(t('请填写 Vaultwarden 服务器地址与登录邮箱后重试', 'Enter both the Vaultwarden server URL and login email, then try again.'));
      return;
    }
    setBusy(true);
    setSettingsError('');
    setCheckFeedback(null);
    try {
      const next = await api.vaultControl<ExternalVaultStatus>({
        action: 'configure',
        expectedRevision: status.revision,
        source: sourceDraft,
        ...(sourceDraft === 'vaultwarden'
          ? { serverUrl: serverUrlDraft.trim(), email: emailDraft.trim() }
          : {}),
      });
      setStatus(next);
      setModal(null);
      await loadAll();
      setNotice(
        sourceDraft === 'local'
          ? t('已切换为本地密码库', 'Switched to Local Vault')
          : t('Vaultwarden 数据源设置已保存', 'Vaultwarden source settings saved'),
      );
    } catch (err) {
      const detail = errorMessage(err, t('中心拒绝了配置变更', 'Center rejected the configuration'));
      setSettingsError(t(`保存数据源设置失败：${detail}。请检查地址与网络后重试。`, `Failed to save source settings: ${detail}. Verify the URL and try again.`));
    } finally {
      setBusy(false);
    }
  };

  const handleCheckServer = async () => {
    if (busy) return;
    setBusy(true);
    setSettingsError('');
    setCheckFeedback(null);
    try {
      const res = await api.vaultControl<ExternalVaultCheckResult>({ action: 'check' });
      setStatus(res.status);
      if (res.reachable) {
        setCheckFeedback({
          tone: 'ok',
          text: t('Vaultwarden 服务器连接正常', 'Vaultwarden server is reachable'),
        });
      } else {
        setCheckFeedback({
          tone: 'danger',
          text: t('无法连接到 Vaultwarden 服务器，请确认地址与 TLS 证书配置后重试', 'Cannot reach Vaultwarden server. Verify the server URL and TLS settings, then try again.'),
        });
      }
    } catch (err) {
      const detail = errorMessage(err, t('连接检测失败', 'Connection check failed'));
      setCheckFeedback({
        tone: 'danger',
        text: t(`检测连接失败：${detail}`, `Connection check failed: ${detail}`),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status || !masterPassword || busy) return;
    setBusy(true);
    setUnlockError('');
    setError('');
    try {
      const unlocked = await api.vaultControl<ExternalVaultStatus>({
        action: 'unlock',
        masterPassword,
        expectedEpoch: status.epoch,
      });
      setMasterPassword('');
      setStatus(unlocked);
      setModal(null);
      await api.vaultControl<ExternalVaultStatus>({ action: 'sync' }).catch(() => null);
      await loadAll();
      setNotice(t('Vaultwarden 已解锁并同步凭据目录', 'Vaultwarden unlocked and credentials synced'));
    } catch (err) {
      const detail = errorMessage(err, t('主密码验证未通过', 'Master password verification failed'));
      setUnlockError(
        t(`解锁失败：${detail}。请核对主密码并确认服务可达后重试。`, `Unlock failed: ${detail}. Check your master password and server connectivity, then try again.`),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    if (busy || syncing) return;
    setSyncing(true);
    setError('');
    try {
      await api.vaultControl<ExternalVaultStatus>({ action: 'sync' });
      await loadAll();
      setNotice(t('凭据目录已同步', 'Credential catalog synced'));
    } catch (err) {
      const detail = errorMessage(err, t('同步请求失败', 'Sync request failed'));
      setError(t(`同步凭据失败：${detail}。请稍后重试。`, `Failed to sync credentials: ${detail}. Try again in a moment.`));
    } finally {
      setSyncing(false);
    }
  };

  const handleLock = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.vaultControl<ExternalVaultStatus>({ action: 'lock' });
      setStatus(next);
      setItems([]);
      setModal(null);
      setNotice(t('Vaultwarden 已锁定', 'Vaultwarden locked'));
    } catch (err) {
      const detail = errorMessage(err, t('锁定请求失败', 'Lock request failed'));
      setError(t(`锁定密码库失败：${detail}。请重试。`, `Failed to lock vault: ${detail}. Please try again.`));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmLogoutVaultwarden = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await api.vaultControl<ExternalVaultStatus>({ action: 'logout' });
      setStatus(next);
      setItems([]);
      setModal(null);
      setNotice(t('已清除 Vaultwarden 登录会话', 'Vaultwarden login session cleared'));
    } catch (err) {
      setModal({ kind: 'settings' });
      setSettingsError(errorMessage(err, t('清除登录会话失败，请重试', 'Failed to clear login session. Try again.')));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleItemGrant = async (
    item: ExternalVaultItemMeta,
    deviceId: string,
    botId: string,
    checked: boolean,
  ) => {
    const key = botKey(deviceId, botId);
    setGrantBusyKeys(prev => new Set(prev).add(key));
    setGrantError('');
    try {
      const current = items.find(i => i.secretRef === item.secretRef) ?? item;
      const filtered = current.allowedBots.filter(
        g => !(g.deviceId === deviceId && g.botId === botId),
      );
      const nextGrants: ExternalVaultGrant[] = checked
        ? [...filtered, { deviceId, botId }]
        : filtered;

      const updated = await api.vaultControl<ExternalVaultListResult>({
        action: 'setGrants',
        expectedRevision: listRevision,
        secretRef: item.secretRef,
        allowedBots: nextGrants,
      });
      setItems(updated.items);
      setListRevision(updated.revision);
    } catch (err) {
      const detail = errorMessage(err, t('中心未接受授权变更', 'Center rejected grant update'));
      setGrantError(t(`更新凭据授权失败：${detail}。请刷新后重试。`, `Failed to update access: ${detail}. Refresh and try again.`));
    } finally {
      setGrantBusyKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleToggleLocalVaultBot = async (deviceId: string, botId: string, checked: boolean) => {
    if (!vaultInstall) return;
    const key = botKey(deviceId, botId);
    setCapBusyKeys(prev => new Set(prev).add(key));
    setError('');
    try {
      const cur =
        vaultCapBindings.get(key) ??
        (await api.getBotCapability(deviceId, botId, vaultInstall.installationId));
      const updated = await api.putBotCapability(deviceId, botId, vaultInstall.installationId, {
        expectedRevision: cur.revision,
        enabled: checked,
        overrides: cur.overrides ?? {},
      });
      setVaultCapBindings(prev => {
        const next = new Map(prev);
        next.set(key, updated);
        return next;
      });
    } catch (err) {
      const detail = errorMessage(err, t('更新授权失败', 'Failed to update access'));
      setError(t(`更新本地密码库访问权限失败：${detail}。请重试。`, `Failed to update local vault access: ${detail}. Please try again.`));
    } finally {
      setCapBusyKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      item =>
        item.label.toLowerCase().includes(q) ||
        item.username.toLowerCase().includes(q) ||
        item.secretRef.toLowerCase().includes(q),
    );
  }, [items, query]);

  const grantItem = useMemo(
    () => (modal?.kind === 'grant' ? items.find(i => i.secretRef === modal.secretRef) ?? null : null),
    [items, modal],
  );

  const grantSelectedKeys = useMemo(() => {
    const set = new Set<string>();
    if (!grantItem) return set;
    for (const g of grantItem.allowedBots) {
      set.add(botKey(g.deviceId, g.botId));
    }
    return set;
  }, [grantItem]);

  const localVaultSelectedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const [key, cfg] of vaultCapBindings.entries()) {
      if (cfg.enabled) set.add(key);
    }
    return set;
  }, [vaultCapBindings]);

  if (!hasLoaded && !initialError) {
    return (
      <div className="ca-form-stack">
        <CaCardSkeleton height={58} label={t('正在加载密码库…', 'Loading vault…')} />
        <CaSectionSkeleton rows={4} headWidth={148} trailingWidth={132} />
      </div>
    );
  }

  if (!status) {
    return (
      <section className="ca-section">
        <div className="ca-section-body">
          <CaNotice
            tone="danger"
            action={
              <button type="button" className="ca-btn ca-btn-sm" onClick={() => void runLoad()}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重试', 'Retry')}</span>
              </button>
            }
          >
            {initialError || t('加载密码库状态失败，请重试', 'Failed to load vault status. Please retry.')}
          </CaNotice>
        </div>
      </section>
    );
  }

  const isVaultwarden = status.source === 'vaultwarden';
  const statusDotTone: 'ok' | 'warn' | 'muted' = !isVaultwarden
    ? 'ok'
    : status.configured && !status.locked
      ? 'ok'
      : 'warn';

  const readinessSummary = isVaultwarden
    ? status.configured
      ? `${status.serverUrl || t('未配置地址', 'URL unset')} · ${status.email || t('未配置账号', 'Account unset')}${
          status.lastSyncAt
            ? t(` · 最近同步 ${formatTime(status.lastSyncAt, locale)}`, ` · Synced ${formatTime(status.lastSyncAt, locale)}`)
            : ''
        }`
      : t('尚未配置服务器地址与登录邮箱，请先完成数据源设置', 'Server URL and login email are not set. Open Source Settings to configure.')
    : vaultInstall
      ? t(`凭据加密保存在各设备本地 · 已授权 ${localVaultSelectedKeys.size} 个 Bot`, `Encrypted on each device · ${localVaultSelectedKeys.size} ${localVaultSelectedKeys.size === 1 ? 'Bot' : 'Bots'} authorized`)
      : t('凭据加密保存在各设备本地（请在桌面或手机端「密码凭据」页面管理条目）', 'Encrypted locally on each device (manage entries in the desktop or mobile Vault page)');

  return (
    <div>
      <CaRefreshBar active={refreshing} />

      {/* Live Readiness Card */}
      <section className="ca-section" aria-label={t('密码库状态', 'Vault readiness')}>
        <div className="ca-default-card ca-wrap">
          <div className="ca-row-main">
            <div className="ca-row-title">
              <StatusDot tone={statusDotTone} />
              <span>{isVaultwarden ? 'Vaultwarden' : t('本地密码库', 'Local')}</span>
              {isVaultwarden ? (
                !status.configured ? (
                  <span className="ca-pill ca-pill-warn">{t('未配置', 'Unconfigured')}</span>
                ) : status.locked ? (
                  <span className="ca-pill ca-pill-warn">{t('已锁定', 'Locked')}</span>
                ) : (
                  <span className="ca-pill ca-pill-ok">{t('已解锁', 'Unlocked')}</span>
                )
              ) : (
                <span className="ca-pill ca-pill-ok">{t('本地加密', 'On-device')}</span>
              )}
            </div>
            <span className="ca-row-sub">{readinessSummary}</span>
          </div>

          <div className="ca-row-actions">
            {isVaultwarden && status.configured && status.locked && (
              <button
                type="button"
                className="ca-btn ca-btn-primary ca-btn-sm"
                disabled={busy}
                onClick={openUnlockModal}
              >
                <Unlock size={13} aria-hidden="true" />
                <span>{t('解锁密码库', 'Unlock')}</span>
              </button>
            )}
            {isVaultwarden && status.configured && !status.locked && (
              <button
                type="button"
                className="ca-btn ca-btn-primary ca-btn-sm"
                disabled={busy}
                onClick={() => void handleLock()}
              >
                <Lock size={13} aria-hidden="true" />
                <span>{t('锁定', 'Lock')}</span>
              </button>
            )}
            <button
              type="button"
              className={`ca-btn ca-btn-sm${isVaultwarden && !status.configured ? ' ca-btn-primary' : ''}`}
              disabled={busy}
              onClick={openSettingsModal}
            >
              <Settings2 size={13} aria-hidden="true" />
              <span>{t('数据源设置', 'Source Settings')}</span>
            </button>
          </div>
        </div>
      </section>

      {isVaultwarden ? (
        status.locked ? (
          <section className="ca-section">
            <div className="ca-empty">
              <div className="ca-google-empty-stack">
                <p style={{ margin: 0 }}>
                  {status.configured
                    ? t('Vaultwarden 当前已锁定。输入主密码解锁后即可同步目录并为 Bot 分配凭据访问权限。', 'Vaultwarden is locked. Unlock with your master password to view credentials and manage Bot access.')
                    : t('请先在数据源设置中填写 Vaultwarden 服务器地址与账号邮箱。', 'Configure your Vaultwarden server URL and email in Source Settings first.')}
                </p>
                <button
                  type="button"
                  className="ca-btn ca-btn-primary ca-btn-sm"
                  disabled={busy}
                  onClick={status.configured ? openUnlockModal : openSettingsModal}
                >
                  {status.configured ? (
                    <>
                      <Unlock size={13} aria-hidden="true" />
                      <span>{t('解锁密码库', 'Unlock')}</span>
                    </>
                  ) : (
                    <>
                      <Settings2 size={13} aria-hidden="true" />
                      <span>{t('数据源设置', 'Source Settings')}</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">
                {t(`凭据条目 (${items.length})`, `Credentials (${items.length})`)}
              </h3>
              <div className="ca-toolbar-group">
                <input
                  type="search"
                  className="ca-input ca-search-compact"
                  placeholder={t('筛选凭据标题或账号…', 'Filter by title or username…')}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={busy || syncing}
                  onClick={() => void handleSync()}
                >
                  <RefreshCw size={13} className={syncing ? 'ca-spin' : undefined} aria-hidden="true" />
                  <LabelStack
                    active={syncing ? t('同步中…', 'Syncing…') : t('同步目录', 'Sync')}
                    labels={[t('同步目录', 'Sync'), t('同步中…', 'Syncing…')]}
                  />
                </button>
              </div>
            </div>

            <div className="ca-list">
              {filteredItems.length === 0 ? (
                <div className="ca-empty">
                  {items.length === 0
                    ? t('Vaultwarden 暂无同步条目，点击上方「同步目录」拉取最新凭据。', 'No synced Vaultwarden entries yet. Click "Sync" above to fetch credentials.')
                    : t('没有匹配的凭据条目', 'No matching credentials')}
                </div>
              ) : (
                filteredItems.map(item => (
                  <div key={item.secretRef} className="ca-row">
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <StatusDot tone={item.allowedBots.length > 0 ? 'ok' : 'muted'} />
                        <span>{item.label || item.secretRef}</span>
                        <span
                          className={`ca-pill ${
                            item.allowedBots.length > 0 ? 'ca-pill-ok' : 'ca-pill-muted'
                          } ca-num`}
                        >
                          {t(`${item.allowedBots.length} 个 Bot`, `${item.allowedBots.length} ${item.allowedBots.length === 1 ? 'Bot' : 'Bots'}`)}
                        </span>
                      </div>
                      <span className="ca-row-sub">
                        {item.username ? `${item.username} · ` : ''}
                        <span className="ca-mono">{item.secretRef}</span>
                      </span>
                    </div>
                    <div className="ca-row-actions">
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => openGrantModal(item.secretRef)}
                      >
                        {t('管理授权', 'Manage Access')}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        )
      ) : (
        <section className="ca-section">
          <div className="ca-section-head">
            <h3 className="ca-section-title">{t('本地密码库 Bot 访问权限', 'Local Vault Bot Access')}</h3>
            {vaultInstall && (
              <span className="ca-muted ca-num">
                {t(`已授权 ${localVaultSelectedKeys.size} 个 Bot`, `${localVaultSelectedKeys.size} authorized`)}
              </span>
            )}
          </div>
          <div className="ca-section-body">
            {vaultInstall ? (
              <BotTreeSelector
                devices={devices}
                bots={bots}
                selectedKeys={localVaultSelectedKeys}
                busyKeys={capBusyKeys}
                onToggleBot={(devId, bId, checked) =>
                  void handleToggleLocalVaultBot(devId, bId, checked)
                }
              />
            ) : (
              <div className="ca-empty-hint">
                {t('如需由中心统一托管凭据并跨设备授权给 Bot，请点击上方「数据源设置」切换为 Vaultwarden。', 'To manage credentials centrally across devices, click "Source Settings" above and switch to Vaultwarden.')}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Modal 1: Unlock Vaultwarden */}
      <CaModal
        open={modal?.kind === 'unlock'}
        onOpenChange={open => {
          if (!open && !busy) {
            setMasterPassword('');
            setUnlockError('');
            setModal(null);
          }
        }}
        title={t('解锁 Vaultwarden', 'Unlock Vaultwarden')}
        description={t('主密码仅用于解密当前中心内存会话，明文秘密不会写入磁盘。', 'Used only to decrypt the active center session in memory; plaintext secrets are never written to disk.')}
        variant="modal"
      >
        <form className="ca-form-stack" onSubmit={e => void handleUnlock(e)}>
          <div className="ca-field">
            <label className="ca-field-label" htmlFor="ca-vault-master-password">
              {t('主密码', 'Master Password')} <span className="ca-req">*</span>
            </label>
            <input
              id="ca-vault-master-password"
              type="password"
              className="ca-input"
              required
              autoFocus
              autoComplete="current-password"
              disabled={busy}
              placeholder={t('输入 Vaultwarden 主密码', 'Enter Vaultwarden master password')}
              value={masterPassword}
              onChange={e => {
                setMasterPassword(e.target.value);
                if (unlockError) setUnlockError('');
              }}
            />
          </div>

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {unlockError ? (
              <p className="ca-error-text" role="alert">
                {unlockError}
              </p>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions" style={{ flexWrap: 'nowrap' }}>
            <button
              type="button"
              className="ca-btn"
              disabled={busy}
              onClick={() => {
                setMasterPassword('');
                setUnlockError('');
                setModal(null);
              }}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={busy || !masterPassword}
              aria-busy={busy}
            >
              <Unlock size={13} aria-hidden="true" />
              <LabelStack
                active={busy ? t('解锁中…', 'Unlocking…') : t('解锁密码库', 'Unlock')}
                labels={[t('解锁密码库', 'Unlock'), t('解锁中…', 'Unlocking…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Modal 2: Source Settings */}
      <CaModal
        open={modal?.kind === 'settings'}
        onOpenChange={open => {
          if (!open && !busy) {
            setSettingsError('');
            setCheckFeedback(null);
            setModal(null);
          }
        }}
        title={t('密码库数据源设置', 'Vault Source Settings')}
        description={t('选择中心使用的密码库后端', 'Choose the vault backend managed by this center')}
        variant="drawer"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSaveSettings(e)}>
          <div className="ca-field">
            <label className="ca-field-label">{t('密码库数据源', 'Vault Source')}</label>
            <CaSegmented
              ariaLabel={t('密码库数据源', 'Vault Source')}
              value={sourceDraft}
              options={[
                { value: 'local', label: t('本地密码库', 'Local') },
                { value: 'vaultwarden', label: 'Vaultwarden' },
              ]}
              onChange={next => {
                setSourceDraft(next);
                setSettingsError('');
                setCheckFeedback(null);
              }}
            />
          </div>

          {sourceDraft === 'vaultwarden' && (
            <>
              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-vault-server-url">
                  {t('服务器地址', 'Server URL')} <span className="ca-req">*</span>
                </label>
                <input
                  id="ca-vault-server-url"
                  type="url"
                  className="ca-input"
                  required
                  disabled={busy}
                  placeholder="https://vault.example.com"
                  value={serverUrlDraft}
                  onChange={e => setServerUrlDraft(e.target.value)}
                />
              </div>
              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-vault-email">
                  {t('登录邮箱', 'Login Email')} <span className="ca-req">*</span>
                </label>
                <input
                  id="ca-vault-email"
                  type="email"
                  className="ca-input"
                  required
                  disabled={busy}
                  placeholder="admin@example.com"
                  value={emailDraft}
                  onChange={e => setEmailDraft(e.target.value)}
                />
              </div>

              <div className="ca-inline-row ca-wrap">
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={busy || !status.configured}
                  onClick={() => void handleCheckServer()}
                >
                  {t('检测连接', 'Check Connection')}
                </button>
                {status.authenticated && (
                  <button
                    type="button"
                    className="ca-btn ca-btn-danger ca-btn-sm"
                    disabled={busy}
                    onClick={() => setModal({ kind: 'confirm-logout' })}
                  >
                    {t('清除登录会话', 'Clear Session')}
                  </button>
                )}
              </div>

              {checkFeedback && (
                <CaNotice tone={checkFeedback.tone}>{checkFeedback.text}</CaNotice>
              )}
            </>
          )}

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {settingsError ? (
              <p className="ca-error-text" role="alert">
                {settingsError}
              </p>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions" style={{ flexWrap: 'nowrap' }}>
            <button
              type="button"
              className="ca-btn"
              disabled={busy}
              onClick={() => setModal(null)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={busy} aria-busy={busy}>
              <LabelStack
                active={busy ? t('保存中…', 'Saving…') : t('保存数据源设置', 'Save Settings')}
                labels={[t('保存数据源设置', 'Save Settings'), t('保存中…', 'Saving…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Modal 3: Manage Access for a Vaultwarden item */}
      <CaModal
        open={modal?.kind === 'grant' && Boolean(grantItem)}
        onOpenChange={open => {
          if (!open) {
            setGrantError('');
            setModal(null);
          }
        }}
        title={t(`管理授权 · ${grantItem?.label || grantItem?.secretRef || ''}`, `Manage Access · ${grantItem?.label || grantItem?.secretRef || ''}`)}
        description={t('勾选即刻生效，仅授权的 Bot 可在运行时读取此凭据。', 'Changes apply immediately. Only authorized Bots can read this credential at runtime.')}
        variant="drawer"
      >
        {grantItem && (
          <div className="ca-form-stack">
            <div className="ca-cred-box">
              <div className="ca-muted">
                {t(`账号：${grantItem.username || '（无）'}`, `Account: ${grantItem.username || '(none)'}`)}
              </div>
              <div className="ca-muted ca-mono">
                {t(`引用 ID：${grantItem.secretRef}`, `Ref ID: ${grantItem.secretRef}`)}
              </div>
            </div>

            {grantError && (
              <p className="ca-error-text" role="alert" style={{ margin: 0 }}>
                {grantError}
              </p>
            )}

            <BotTreeSelector
              devices={devices}
              bots={bots}
              selectedKeys={grantSelectedKeys}
              busyKeys={grantBusyKeys}
              onToggleBot={(devId, bId, checked) =>
                void handleToggleItemGrant(grantItem, devId, bId, checked)
              }
            />

            <div className="ca-form-actions" style={{ flexWrap: 'nowrap' }}>
              <button type="button" className="ca-btn" onClick={() => setModal(null)}>
                {t('完成', 'Done')}
              </button>
            </div>
          </div>
        )}
      </CaModal>

      {/* Modal 4: Confirm Clear Vaultwarden Session */}
      <CaConfirmDialog
        open={modal?.kind === 'confirm-logout'}
        title={t('清除 Vaultwarden 登录会话', 'Clear Vaultwarden Session')}
        description={t('清除后中心将锁定并断开当前 Vaultwarden 会话，Bot 将无法读取凭据，直到重新输入主密码解锁。', 'Clearing the session locks and disconnects Vaultwarden. Bots cannot read credentials until you unlock with your master password again.')}
        confirmLabel={t('清除会话', 'Clear Session')}
        cancelLabel={t('返回设置', 'Back to Settings')}
        danger
        busy={busy}
        onCancel={() => {
          if (!busy) setModal({ kind: 'settings' });
        }}
        onConfirm={() => void handleConfirmLogoutVaultwarden()}
      />
    </div>
  );
}
