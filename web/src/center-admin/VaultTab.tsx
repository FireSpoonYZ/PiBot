import { useCallback, useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { KeyRound, Lock, RefreshCw, Settings2, Unlock } from 'lucide-react';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  BotTreeSelector,
  CaModal,
  CaNotice,
  CaSegmented,
  botKey,
  formatTime,
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

export function VaultTab({ api }: { api: CenterApi }): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [status, setStatus] = useState<ExternalVaultStatus | null>(null);
  const [items, setItems] = useState<ExternalVaultItemMeta[]>([]);
  const [listRevision, setListRevision] = useState(0);
  const [query, setQuery] = useState('');

  const [devices, setDevices] = useState<CenterDevice[]>([]);
  const [bots, setBots] = useState<CenterBotRef[]>([]);

  // Local vault capability (`e-launcher.vault`) if installed
  const [vaultInstall, setVaultInstall] = useState<Installation | null>(null);
  const [vaultCapBindings, setVaultCapBindings] = useState<Map<string, BotCapabilityConfig>>(new Map());
  const [capBusyKeys, setCapBusyKeys] = useState<Set<string>>(new Set());

  // Unlock form
  const [masterPassword, setMasterPassword] = useState('');

  // Service settings drawer
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceDraft, setSourceDraft] = useState<VaultSource>('local');
  const [serverUrlDraft, setServerUrlDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [settingsError, setSettingsError] = useState('');

  // Grant drawer for a Vaultwarden item
  const [grantItem, setGrantItem] = useState<ExternalVaultItemMeta | null>(null);
  const [grantBusyKeys, setGrantBusyKeys] = useState<Set<string>>(new Set());

  const loadAll = useCallback(async () => {
    const [st, sync, caps] = await Promise.all([
      api.vaultControl<ExternalVaultStatus>({ action: 'status' }),
      api.getBotSync(),
      api.listCapabilities().catch(() => [] as Installation[]),
    ]);
    setStatus(st);
    setSourceDraft(st.source);
    setServerUrlDraft(st.serverUrl ?? '');
    setEmailDraft(st.email ?? '');
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
  }, [api]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadAll()
      .catch(err => {
        if (active) setError(errorMessage(err, '加载密码库状态失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadAll]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!status) return;
    if (sourceDraft === 'vaultwarden' && (!serverUrlDraft.trim() || !emailDraft.trim())) {
      setSettingsError('请填写 Vaultwarden 服务地址与账号邮箱');
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
      setNotice(sourceDraft === 'local' ? '已切换为内置本地密码库' : 'Vaultwarden 服务配置已保存');
    } catch (err) {
      setSettingsError(errorMessage(err, '保存密码库配置失败'));
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
      if (res.reachable) setNotice('Vaultwarden 服务器连接正常');
      else setSettingsError('无法连接到 Vaultwarden 服务器');
    } catch (err) {
      setSettingsError(errorMessage(err, '检测连接失败'));
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
      setNotice('Vaultwarden 已解锁并同步凭据列表');
    } catch (err) {
      setError(errorMessage(err, '解锁失败，请检查主密码'));
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
      setNotice('凭据目录已同步');
    } catch (err) {
      setError(errorMessage(err, '同步失败'));
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
      setNotice('Vaultwarden 已锁定');
    } catch (err) {
      setError(errorMessage(err, '锁定失败'));
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
      setNotice('已清除 Vaultwarden 会话');
    } catch (err) {
      setSettingsError(errorMessage(err, '清除会话失败'));
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
      setError(errorMessage(err, '更新凭据授权失败'));
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
      setError(errorMessage(err, '更新本地密码库能力授权失败'));
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

  if (loading || !status) {
    return <div className="ca-empty">正在加载密码库…</div>;
  }

  return (
    <div>
      {error && <CaNotice tone="danger">{error}</CaNotice>}
      {notice && (
        <CaNotice
          tone="ok"
          action={
            <button type="button" className="ca-btn ca-btn-ghost ca-btn-sm" onClick={() => setNotice('')}>
              关闭
            </button>
          }
        >
          {notice}
        </CaNotice>
      )}

      {/* 顶部密码源与状态卡片 */}
      <section className="ca-section">
        <div className="ca-default-card" style={{ flexWrap: 'wrap' }}>
          <div className="ca-row-main">
            <div className="ca-row-title">
              <KeyRound size={15} />
              <span>{status.source === 'vaultwarden' ? 'Vaultwarden 集中密码库' : '内置本地密码库'}</span>
              {status.source === 'vaultwarden' ? (
                <span className={`ca-pill ${status.locked ? 'ca-pill-warn' : 'ca-pill-ok'}`}>
                  {status.locked ? '已锁定' : '已解锁'}
                </span>
              ) : (
                <span className="ca-pill ca-pill-ok">设备本地加密存储</span>
              )}
            </div>
            <div className="ca-row-sub">
              {status.source === 'vaultwarden'
                ? `${status.serverUrl || '未配置地址'} · ${status.email || '未配置账号'}${
                    status.lastSyncAt ? ` · 最近同步 ${formatTime(status.lastSyncAt)}` : ''
                  }`
                : '凭据密文保存于各已绑定设备本地，仅响应明确授权给智能体的读取请求'}
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
                  <RefreshCw size={13} />
                  <span>同步</span>
                </button>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={busy}
                  onClick={() => void handleLock()}
                >
                  <Lock size={13} />
                  <span>锁定</span>
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
              <Settings2 size={13} />
              <span>切换服务 / 设置</span>
            </button>
          </div>
        </div>
      </section>

      {status.source === 'vaultwarden' ? (
        status.locked ? (
          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">解锁 Vaultwarden</h3>
            </div>
            <form className="ca-section-body ca-form-stack" onSubmit={e => void handleUnlock(e)}>
              {!status.configured ? (
                <CaNotice tone="warn">
                  尚未配置 Vaultwarden 服务器地址与邮箱，请先点击右上角「切换服务 / 设置」完成配置。
                </CaNotice>
              ) : (
                <>
                  <div className="ca-field" style={{ maxWidth: 420 }}>
                    <label className="ca-field-label">主密码 (Master Password)</label>
                    <input
                      type="password"
                      className="ca-input"
                      required
                      autoComplete="current-password"
                      placeholder="输入 Vaultwarden 主密码以解锁目录"
                      value={masterPassword}
                      onChange={e => setMasterPassword(e.target.value)}
                    />
                    <p className="ca-field-help">主密码仅用于解密当前中心会话内存，中心不落盘明文秘密。</p>
                  </div>
                  <div className="ca-inline-row">
                    <button type="submit" className="ca-btn ca-btn-primary ca-btn-sm" disabled={busy}>
                      <Unlock size={13} />
                      <span>{busy ? '解锁中…' : '解锁并同步凭据'}</span>
                    </button>
                  </div>
                </>
              )}
            </form>
          </section>
        ) : (
          <section className="ca-section">
            <div className="ca-section-head" style={{ flexWrap: 'wrap' }}>
              <h3 className="ca-section-title">凭据条目 ({items.length})</h3>
              <input
                type="search"
                className="ca-input"
                style={{ width: 220, paddingTop: 4, paddingBottom: 4 }}
                placeholder="筛选凭据标题或账号…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>

            <div className="ca-list">
              {filteredItems.length === 0 ? (
                <div className="ca-empty">
                  {items.length === 0 ? 'Vaultwarden 暂无同步条目，可点击上方「同步」刷新' : '没有匹配的凭据条目'}
                </div>
              ) : (
                filteredItems.map(item => (
                  <div
                    key={item.secretRef}
                    className="ca-row is-clickable"
                    onClick={() => setGrantItem(item)}
                  >
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <span>{item.label || item.secretRef}</span>
                        <span
                          className={`ca-pill ${
                            item.allowedBots.length > 0 ? 'ca-pill-ok' : 'ca-pill-muted'
                          } ca-num`}
                        >
                          已授权 {item.allowedBots.length} 个 Bot
                        </span>
                      </div>
                      <div className="ca-row-sub">
                        {item.username ? `账号：${item.username} · ` : ''}
                        <span className="ca-mono">{item.secretRef}</span>
                      </div>
                    </div>
                    <div className="ca-row-actions">
                      <button type="button" className="ca-btn ca-btn-sm">
                        授权 Bot
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
            <h3 className="ca-section-title">本机密码条目与授权</h3>
          </div>
          <div className="ca-section-body ca-form-stack">
            <CaNotice tone="info">
              内置本地密码库的数据加密保存在各设备本机（桌面/手机端「密码凭据」页面中增删管理）。
              如需由中心统一保管并向多个设备跨机分发凭据，可在右上角切换为 <strong>Vaultwarden</strong>。
            </CaNotice>

            {vaultInstall && (
              <div>
                <div className="ca-field-label" style={{ marginBottom: 8 }}>
                  允许读取本机密码库的智能体（{vaultInstall.displayName}）
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

      {/* 切换服务 / 设置抽屉 */}
      <CaModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="密码库服务设置"
        description="选择中心协同使用的密码库后端"
        variant="drawer"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSaveSettings(e)}>
          {settingsError && <CaNotice tone="danger">{settingsError}</CaNotice>}
          <div className="ca-field">
            <label className="ca-field-label">密码库模式</label>
            <CaSegmented
              value={sourceDraft}
              options={[
                { value: 'local', label: '内置本地密码库' },
                { value: 'vaultwarden', label: 'Vaultwarden' },
              ]}
              onChange={setSourceDraft}
            />
          </div>

          {sourceDraft === 'vaultwarden' && (
            <>
              <div className="ca-field">
                <label className="ca-field-label">
                  服务器地址 <span className="ca-req">*</span>
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
                  登录邮箱 <span className="ca-req">*</span>
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

              <div className="ca-inline-row" style={{ flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={busy || !status.configured}
                  onClick={() => void handleCheckServer()}
                >
                  检测连接
                </button>
                {status.authenticated && (
                  <button
                    type="button"
                    className="ca-btn ca-btn-danger ca-btn-sm"
                    disabled={busy}
                    onClick={() => void handleLogoutVaultwarden()}
                  >
                    清除登录会话
                  </button>
                )}
              </div>
            </>
          )}

          <div className="ca-form-actions">
            <button type="button" className="ca-btn" onClick={() => setSettingsOpen(false)}>
              取消
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={busy}>
              {busy ? '保存中…' : '保存设置'}
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
        title={`授权访问 · ${grantItem?.label || grantItem?.secretRef || ''}`}
        description="勾选即刻生效，仅授权的智能体可在运行期请求此凭据"
        variant="drawer"
      >
        {grantItem && (
          <div className="ca-form-stack">
            <div className="ca-cred-box">
              <div className="ca-muted">账号：{grantItem.username || '（无）'}</div>
              <div className="ca-muted ca-mono">引用 ID：{grantItem.secretRef}</div>
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
