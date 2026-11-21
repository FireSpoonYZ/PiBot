import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { KeyRound, Lock, RefreshCw, Settings2, Unlock } from 'lucide-react';
import { LabelStack } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  BotTreeSelector,
  CaCardSkeleton,
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

  // Unlock form
  const [masterPassword, setMasterPassword] = useState('');

  // Service settings drawer
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const [sourceDraft, setSourceDraft] = useState<VaultSource>(() => initialCache?.status.source ?? 'local');
  const [serverUrlDraft, setServerUrlDraft] = useState(() => initialCache?.status.serverUrl ?? '');
  const [emailDraft, setEmailDraft] = useState(() => initialCache?.status.email ?? '');

  // Grant drawer for a Vaultwarden item
  const [grantItem, setGrantItem] = useState<ExternalVaultItemMeta | null>(null);
  const [grantBusyKeys, setGrantBusyKeys] = useState<Set<string>>(new Set());

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

  const setSettingsError = useCallback(
    (msg: string) => {
      if (msg) showNotice('settings-error', msg, { tone: 'danger' });
      else clearNotice('settings-error');
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
        const cfg = bindingsRec[key];
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
      const msg = errorMessage(err, t('加载密码库状态失败', 'Failed to load vault status'));
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

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status) return;
    if (sourceDraft === 'vaultwarden' && (!serverUrlDraft.trim() || !emailDraft.trim())) {
      setSettingsError(t('请填写 Vaultwarden 服务地址与账号邮箱', 'Please enter the Vaultwarden server URL and account email'));
      return;
    }
    setBusy(true);
    setSettingsError('');
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
      setSettingsOpen(false);
      await loadAll();
      setNotice(
        sourceDraft === 'local'
          ? t('已切换为内置本地密码库', 'Switched to built-in local vault')
          : t('Vaultwarden 服务配置已保存', 'Vaultwarden settings saved'),
      );
    } catch (err) {
      setSettingsError(errorMessage(err, t('保存密码库配置失败', 'Failed to save vault settings')));
    } finally {
      setBusy(false);
    }
  };

  const handleCheckServer = async () => {
    setBusy(true);
    setSettingsError('');
    try {
      const res = await api.vaultControl<ExternalVaultCheckResult>({ action: 'check' });
      setStatus(res.status);
      if (res.reachable) setNotice(t('Vaultwarden 服务器连接正常', 'Vaultwarden server connection OK'));
      else setSettingsError(t('无法连接到 Vaultwarden 服务器', 'Unable to connect to Vaultwarden server'));
    } catch (err) {
      setSettingsError(errorMessage(err, t('检测连接失败', 'Connection check failed')));
    } finally {
      setBusy(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status || !masterPassword) return;
    setBusy(true);
    setError('');
    try {
      const unlocked = await api.vaultControl<ExternalVaultStatus>({
        action: 'unlock',
        masterPassword,
        expectedEpoch: status.epoch,
      });
      setMasterPassword('');
      setStatus(unlocked);
      await api.vaultControl<ExternalVaultStatus>({ action: 'sync' }).catch(() => null);
      await loadAll();
      setNotice(t('Vaultwarden 已解锁并同步凭据列表', 'Vaultwarden unlocked and credentials synced'));
    } catch (err) {
      setError(errorMessage(err, t('解锁失败，请检查主密码', 'Unlock failed. Please check your master password')));
    } finally {
      setBusy(false);
    }
  };

  const handleSync = async () => {
    setBusy(true);
    setError('');
    try {
      await api.vaultControl<ExternalVaultStatus>({ action: 'sync' });
      await loadAll();
      setNotice(t('凭据目录已同步', 'Credential catalog synced'));
    } catch (err) {
      setError(errorMessage(err, t('同步失败', 'Sync failed')));
    } finally {
      setBusy(false);
    }
  };

  const handleLock = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await api.vaultControl<ExternalVaultStatus>({ action: 'lock' });
      setStatus(next);
      setItems([]);
      setNotice(t('Vaultwarden 已锁定', 'Vaultwarden locked'));
    } catch (err) {
      setError(errorMessage(err, t('锁定失败', 'Lock failed')));
    } finally {
      setBusy(false);
    }
  };

  const handleLogoutVaultwarden = async () => {
    setBusy(true);
    setSettingsError('');
    try {
      const next = await api.vaultControl<ExternalVaultStatus>({ action: 'logout' });
      setStatus(next);
      setItems([]);
      setSettingsOpen(false);
      setNotice(t('已清除 Vaultwarden 会话', 'Vaultwarden session cleared'));
    } catch (err) {
      setSettingsError(errorMessage(err, t('清除会话失败', 'Failed to clear session')));
    } finally {
      setBusy(false);
    }
  };

  // Immediate cross-device grant toggle for Vaultwarden item
  const handleToggleItemGrant = async (
    item: ExternalVaultItemMeta,
    deviceId: string,
    botId: string,
    checked: boolean,
  ) => {
    const key = botKey(deviceId, botId);
    setGrantBusyKeys(prev => new Set(prev).add(key));
    setError('');
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
      const nextSelected = updated.items.find(i => i.secretRef === item.secretRef) ?? null;
      setGrantItem(nextSelected);
    } catch (err) {
      setError(errorMessage(err, t('更新凭据授权失败', 'Failed to update credential authorization')));
    } finally {
      setGrantBusyKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  // Local e-launcher.vault capability toggle per Bot
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
      setError(errorMessage(err, t('更新本地密码库能力授权失败', 'Failed to update local vault capability authorization')));
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
            {initialError || t('加载密码库状态失败', 'Failed to load vault status')}
          </CaNotice>
        </div>
      </section>
    );
  }

  return (
    <div>
      <CaRefreshBar active={refreshing} />

      {/* Top vault source & status card */}
      <section className="ca-section">
        <div className="ca-default-card ca-wrap">
          <div className="ca-row-main">
            <div className="ca-row-title">
              <KeyRound size={15} aria-hidden="true" />
              <span>
                {status.source === 'vaultwarden'
                  ? t('Vaultwarden 集中密码库', 'Vaultwarden Central Vault')
                  : t('内置本地密码库', 'Built-in Local Vault')}
              </span>
              {status.source === 'vaultwarden' ? (
                <span className={`ca-pill ${status.locked ? 'ca-pill-warn' : 'ca-pill-ok'}`}>
                  {status.locked ? t('已锁定', 'Locked') : t('已解锁', 'Unlocked')}
                </span>
              ) : (
                <span className="ca-pill ca-pill-ok">{t('设备本地加密存储', 'Encrypted locally on device')}</span>
              )}
            </div>
            <div className="ca-row-sub">
              {status.source === 'vaultwarden'
                ? `${status.serverUrl || t('未配置地址', 'URL not set')} · ${status.email || t('未配置账号', 'Account not set')}${
                    status.lastSyncAt
                      ? t(` · 最近同步 ${formatTime(status.lastSyncAt, locale)}`, ` · Last synced ${formatTime(status.lastSyncAt, locale)}`)
                      : ''
                  }`
                : t('凭据密文保存于各已绑定设备本地，仅响应明确授权给 Bot 的读取请求', 'Encrypted credentials are stored locally on each bound device and only answer read requests explicitly authorized for a Bot')}
            </div>
          </div>

          <div className="ca-row-actions">
            {status.source === 'vaultwarden' && !status.locked && (
              <>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={busy}
                  onClick={() => void handleSync()}
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  <span>{t('同步', 'Sync')}</span>
                </button>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={busy}
                  onClick={() => void handleLock()}
                >
                  <Lock size={13} aria-hidden="true" />
                  <span>{t('锁定', 'Lock')}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="ca-btn ca-btn-sm"
              onClick={() => {
                setSettingsError('');
                setSettingsOpen(true);
              }}
            >
              <Settings2 size={13} aria-hidden="true" />
              <span>{t('切换服务 / 设置', 'Switch Service / Settings')}</span>
            </button>
          </div>
        </div>
      </section>

      {status.source === 'vaultwarden' ? (
        status.locked ? (
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">{t('解锁 Vaultwarden', 'Unlock Vaultwarden')}</h3>
            </div>
            <form className="ca-section-body ca-form-stack" onSubmit={e => void handleUnlock(e)}>
              {!status.configured ? (
                <CaNotice tone="warn">
                  {t('尚未配置 Vaultwarden 服务器地址与邮箱，请先点击右上角「切换服务 / 设置」完成配置。', 'Vaultwarden server URL and email are not configured yet. Click "Switch Service / Settings" in the top right to set them up.')}
                </CaNotice>
              ) : (
                <>
                  <div className="ca-field ca-field-narrow">
                    <label className="ca-field-label">{t('主密码 (Master Password)', 'Master Password')}</label>
                    <input
                      type="password"
                      className="ca-input"
                      required
                      autoComplete="current-password"
                      placeholder={t('输入 Vaultwarden 主密码以解锁目录', 'Enter Vaultwarden master password to unlock catalog')}
                      value={masterPassword}
                      onChange={e => setMasterPassword(e.target.value)}
                    />
                    <p className="ca-field-help">
                      {t('主密码仅用于解密当前中心会话内存，中心不落盘明文秘密。', 'The master password is only used to decrypt the current center session in memory; plaintext secrets are never written to disk.')}
                    </p>
                  </div>
                  <div className="ca-inline-row">
                    <button type="submit" className="ca-btn ca-btn-primary ca-btn-sm" disabled={busy}>
                      <Unlock size={13} aria-hidden="true" />
                      <LabelStack
                        active={busy ? t('解锁中…', 'Unlocking…') : t('解锁并同步凭据', 'Unlock & Sync')}
                        labels={[t('解锁并同步凭据', 'Unlock & Sync'), t('解锁中…', 'Unlocking…')]}
                      />
                    </button>
                  </div>
                </>
              )}
            </form>
          </section>
        ) : (
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">
                {t(`凭据条目 (${items.length})`, `Credentials (${items.length})`)}
              </h3>
              <input
                type="search"
                className="ca-input ca-search-compact"
                placeholder={t('筛选凭据标题或账号…', 'Filter by title or username…')}
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>

            <div className="ca-list">
              {filteredItems.length === 0 ? (
                <div className="ca-empty">
                  {items.length === 0
                    ? t('Vaultwarden 暂无同步条目，可点击上方「同步」刷新', 'No synced Vaultwarden entries yet. Click "Sync" above to refresh.')
                    : t('没有匹配的凭据条目', 'No matching credentials')}
                </div>
              ) : (
                filteredItems.map(item => (
                  <div key={item.secretRef} className="ca-row ca-row-split">
                    <button
                      type="button"
                      className="ca-row-trigger"
                      onClick={() => setGrantItem(item)}
                    >
                      <span className="ca-row-title">
                        <span>{item.label || item.secretRef}</span>
                        <span
                          className={`ca-pill ${
                            item.allowedBots.length > 0 ? 'ca-pill-ok' : 'ca-pill-muted'
                          } ca-num`}
                        >
                          {t(`已授权 ${item.allowedBots.length} 个 Bot`, `${item.allowedBots.length} ${item.allowedBots.length === 1 ? 'Bot' : 'Bots'} authorized`)}
                        </span>
                      </span>
                      <span className="ca-row-sub">
                        {item.username ? t(`账号：${item.username} · `, `Account: ${item.username} · `) : ''}
                        <span className="ca-mono">{item.secretRef}</span>
                      </span>
                    </button>
                    <div className="ca-row-actions">
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => setGrantItem(item)}
                      >
                        {t('授权 Bot', 'Authorize Bots')}
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
            <h3 className="ca-section-title">{t('本机密码条目与授权', 'Local Credentials & Authorization')}</h3>
          </div>
          <div className="ca-section-body ca-form-stack">
            <CaNotice tone="info">
              {t('内置本地密码库的数据加密保存在各设备本机（桌面/手机端「密码凭据」页面中增删管理）。如需由中心统一保管并向多个设备跨机分发凭据，可在右上角切换为 ', 'Built-in local vault data is stored encrypted on each device (manage entries in the desktop/mobile Vault page). To manage centrally and distribute across devices, switch in the top right to ')}
              <strong>Vaultwarden</strong>
              {t('。', '.')}
            </CaNotice>

            {vaultInstall && (
              <div>
                <div className="ca-field-label ca-mb-2">
                  {t(`允许读取本机密码库的 Bot（${vaultInstall.displayName}）`, `Bots allowed to read local vault (${vaultInstall.displayName})`)}
                </div>
                <BotTreeSelector
                  devices={devices}
                  bots={bots}
                  selectedKeys={localVaultSelectedKeys}
                  busyKeys={capBusyKeys}
                  onToggleBot={(devId, bId, checked) =>
                    void handleToggleLocalVaultBot(devId, bId, checked)
                  }
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* Switch Service / Settings drawer */}
      <CaModal
        open={settingsOpen}
        onOpenChange={open => {
          if (!open) setSettingsError('');
          setSettingsOpen(open);
        }}
        title={t('密码库服务设置', 'Vault Service Settings')}
        description={t('选择中心协同使用的密码库后端', 'Choose the vault backend coordinated by the center')}
        variant="drawer"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSaveSettings(e)}>
          <div className="ca-field">
            <label className="ca-field-label">{t('密码库模式', 'Vault Mode')}</label>
            <CaSegmented
              ariaLabel={t('密码库模式', 'Vault Mode')}
              value={sourceDraft}
              options={[
                { value: 'local', label: t('内置本地密码库', 'Built-in Local Vault') },
                { value: 'vaultwarden', label: 'Vaultwarden' },
              ]}
              onChange={setSourceDraft}
            />
          </div>

          {sourceDraft === 'vaultwarden' && (
            <>
              <div className="ca-field">
                <label className="ca-field-label">
                  {t('服务器地址', 'Server URL')} <span className="ca-req">*</span>
                </label>
                <input
                  type="url"
                  className="ca-input"
                  required
                  placeholder="https://vault.example.com"
                  value={serverUrlDraft}
                  onChange={e => setServerUrlDraft(e.target.value)}
                />
              </div>
              <div className="ca-field">
                <label className="ca-field-label">
                  {t('登录邮箱', 'Login Email')} <span className="ca-req">*</span>
                </label>
                <input
                  type="email"
                  className="ca-input"
                  required
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
                    onClick={() => void handleLogoutVaultwarden()}
                  >
                    {t('清除登录会话', 'Clear Login Session')}
                  </button>
                )}
              </div>
            </>
          )}

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setSettingsOpen(false)}>
              {t('取消', 'Cancel')}
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={busy}>
              <LabelStack
                active={busy ? t('保存中…', 'Saving…') : t('保存设置', 'Save Settings')}
                labels={[t('保存设置', 'Save Settings'), t('保存中…', 'Saving…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Vaultwarden 单条目跨设备 Bot 树形多选授权抽屉（勾选即时生效） */}
      <CaModal
        open={Boolean(grantItem)}
        onOpenChange={open => {
          if (!open) setGrantItem(null);
        }}
        title={t(`授权访问 · ${grantItem?.label || grantItem?.secretRef || ''}`, `Authorize Access · ${grantItem?.label || grantItem?.secretRef || ''}`)}
        description={t('勾选即刻生效，仅授权的 Bot 可在运行期请求此凭据', 'Changes take effect immediately. Only authorized Bots can request this credential at runtime.')}
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

            <BotTreeSelector
              devices={devices}
              bots={bots}
              selectedKeys={grantSelectedKeys}
              busyKeys={grantBusyKeys}
              onToggleBot={(devId, bId, checked) =>
                void handleToggleItemGrant(grantItem, devId, bId, checked)
              }
            />
          </div>
        )}
      </CaModal>
    </div>
  );
}
