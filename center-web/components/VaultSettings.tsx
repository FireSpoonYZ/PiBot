import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Download, ExternalLink, KeyRound, Lock, Plus, Power, RefreshCw, X } from 'lucide-react';
import type { BotRef, Device, Installation } from '@e-launcher/center-contract';
import {
  api,
  CenterApiError,
  type ExternalVaultCheckResult,
  type ExternalVaultGrant,
  type ExternalVaultItemMeta,
  type ExternalVaultListResult,
  type ExternalVaultStatus,
  type VaultSource,
} from '../api';
import { ActivationBadge, activationUsable } from './ActivationStatus';
import { errorMessage } from './ConfigOperation';

const VAULT_SOURCE_LABEL: Record<VaultSource, string> = {
  local: '本地密码库',
  vaultwarden: 'Vaultwarden',
};

function isListResult(value: unknown): value is ExternalVaultListResult {
  return !!value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items);
}
function isCheckResult(value: unknown): value is ExternalVaultCheckResult {
  return !!value && typeof value === 'object' && typeof (value as { reachable?: unknown }).reachable === 'boolean';
}
function grantKey(grant: ExternalVaultGrant): string {
  return grant.deviceId + '/' + grant.botId;
}

/**
 * Vault errors carry fixed codes; error.message may be an underscored
 * English wire string, so always present a concise prompt keyed by code.
 */
function vaultError(error: unknown): string {
  const code = error instanceof CenterApiError ? error.code : undefined;
  switch (code) {
    case 'VAULT_STALE_SESSION': return '密码库会话已变更或过期，请刷新状态后重试。';
    case 'VAULT_CONFLICT':
    case 'REVISION_CONFLICT':
    case 'REQUEST_CONFLICT': return '密码库配置或授权已被修改，请刷新后重试。';
    case 'VAULT_CONNECTION_FAILED': return '无法连接 Vaultwarden 服务，请检查服务地址与网络。';
    case 'VAULT_NEEDS_LOGIN': return '请输入主密码以登录并解锁外部密码库。';
    case 'VAULT_LOGIN_CHALLENGE': return '账号要求额外登录验证，当前尚不支持该验证方式。';
    case 'VAULT_UNLOCK_FAILED': return '无法登录或解锁，请检查主密码及账号设置。';
    case 'VAULT_NOT_CONFIGURED': return '外部密码库尚未配置。';
    case 'VAULT_FORBIDDEN': return '密码库访问未获授权。';
    case 'VAULT_INVALID_ARGUMENT': return '输入无效，请检查后重试。';
    case 'VAULT_UNSUPPORTED': return '当前中心不支持此密码库操作。';
    default: return errorMessage(error);
  }
}

/**
 * Dedicated settings for the built-in Vault installation (its config schema is
 * intentionally empty). Manages the center-level vault source, account
 * connection, private unlock and per-item Bot grants via POST /api/vault/control.
 */
export default function VaultSettings({ installation }: { installation: Installation }) {
  const [status, setStatus] = useState<ExternalVaultStatus | null>(null);
  const [list, setList] = useState<ExternalVaultListResult | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [bots, setBots] = useState<Record<string, BotRef[]>>({});
  const [drafts, setDrafts] = useState<Record<string, ExternalVaultGrant[]>>({});
  const [pick, setPick] = useState<Record<string, { deviceId: string; botId: string }>>({});
  const [source, setSource] = useState<VaultSource>('local');
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef(false);
  const inFlight = useRef(false);
  // Device ids whose bot list was already requested; avoids refetch loops.
  const requestedBots = useRef(new Set<string>());

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const ensureBots = useCallback(async (deviceId: string) => {
    if (!deviceId || requestedBots.current.has(deviceId)) return;
    requestedBots.current.add(deviceId);
    try {
      const value = await api.listBots(deviceId);
      if (active.current) setBots(prev => (prev[deviceId] ? prev : { ...prev, [deviceId]: value }));
    } catch {
      requestedBots.current.delete(deviceId);
      // Grant labels fall back to raw ids; the next load retries.
    }
  }, []);

  const applyStatus = useCallback((next: ExternalVaultStatus) => {
    setStatus(next);
    setSource(next.source);
    setServerUrl(next.serverUrl ?? '');
    setEmail(next.email ?? '');
  }, []);

  const run = useCallback(async (work: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await work();
    } catch (e) {
      if (active.current) setError(vaultError(e));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }, []);

  const refreshList = useCallback(async () => {
    const result = await api.vaultControl({ action: 'list' });
    if (!active.current || !isListResult(result)) return;
    setList(result);
    setDrafts({});
    for (const item of result.items) {
      for (const grant of item.allowedBots) void ensureBots(grant.deviceId);
    }
  }, [ensureBots]);

  const refresh = useCallback(async () => {
    const result = await api.vaultControl({ action: 'status' });
    if (!active.current || isListResult(result) || isCheckResult(result)) return;
    applyStatus(result);
    if (result.source === 'vaultwarden' && result.configured && result.authenticated && !result.locked) {
      await refreshList();
    } else {
      setList(null);
    }
  }, [applyStatus, refreshList]);

  useEffect(() => {
    void run(async () => {
      const [deviceList] = await Promise.all([api.listDevices(), refresh()]);
      if (active.current) setDevices(deviceList);
    });
  }, [run, refresh]);

  const control = async (input: Parameters<typeof api.vaultControl>[0]) => {
    const result = await api.vaultControl(input);
    if (!active.current) return;
    if (isCheckResult(result)) {
      applyStatus(result.status);
      setMessage(result.reachable ? '连接检查成功' : '无法连接 Vaultwarden 服务');
      return;
    }
    if (isListResult(result)) {
      setList(result);
      return;
    }
    applyStatus(result);
    if (result.source === 'vaultwarden' && result.configured && result.authenticated && !result.locked) {
      await refreshList();
    } else {
      setList(null);
    }
  };

  const saveSource = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const url = source === 'vaultwarden' ? serverUrl.trim() : undefined;
    if (source === 'vaultwarden' && url && !/^https:\/\//i.test(url)) {
      setError('Vaultwarden 地址必须使用 https://');
      return;
    }
    if (source === 'vaultwarden' && !url) {
      setError('请填写 Vaultwarden 服务地址');
      return;
    }
    const accountEmail = email.trim().toLowerCase();
    if (source === 'vaultwarden' && !accountEmail) {
      setError('请填写 Vaultwarden 账号邮箱');
      return;
    }
    void run(async () => {
      if (!status) return;
      await control({ action: 'configure', expectedRevision: status.revision, source, ...(url ? { serverUrl: url, email: accountEmail } : {}) });
      form.reset();
      setMessage('密码库来源已保存');
    });
  };

  const submitUnlock = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
    const expectedEpoch = status?.epoch;
    form.reset();
    void run(async () => {
      if (expectedEpoch === undefined) return;
      await control({ action: 'unlock', masterPassword, expectedEpoch });
      setMessage('已解锁');
    });
  };

  const setDraft = (secretRef: string, base: ExternalVaultGrant[], next: ExternalVaultGrant[]) => {
    setDrafts(prev => {
      const same = next.length === base.length && next.every(g => base.some(b => grantKey(b) === grantKey(g)));
      const copy = { ...prev };
      if (same) delete copy[secretRef];
      else copy[secretRef] = next;
      return copy;
    });
  };

  const addGrant = (item: ExternalVaultItemMeta) => {
    const choice = pick[item.secretRef];
    if (!choice?.deviceId || !choice.botId) return;
    const base = drafts[item.secretRef] ?? item.allowedBots;
    if (base.some(g => grantKey(g) === grantKey(choice))) return;
    setDraft(item.secretRef, item.allowedBots, [...base, choice]);
  };

  const saveGrants = (item: ExternalVaultItemMeta) => {
    const draft = drafts[item.secretRef];
    if (!draft || !list) return;
    void run(async () => {
      await control({ action: 'setGrants', expectedRevision: list.revision, secretRef: item.secretRef, allowedBots: draft });
      setMessage('授权已保存');
    });
  };

  const botLabel = (grant: ExternalVaultGrant) => {
    const bot = bots[grant.deviceId]?.find(value => value.botId === grant.botId);
    const device = devices.find(value => value.deviceId === grant.deviceId);
    return (bot?.name ?? grant.botId) + ' @ ' + (device?.name ?? grant.deviceId);
  };

  const external = status?.source === 'vaultwarden';
  const externalReady = !!(external && status?.configured && status.authenticated && !status.locked);

  return (
    <div className="config-form">
      <div className="summary-bar">
        <p>
          来源：<span className="badge badge-neutral">{status ? VAULT_SOURCE_LABEL[status.source] : '未知'}</span>{' '}
          全局启用：<ActivationBadge status={installation.activation.status} />
          {!activationUsable(installation) && <span className="badge badge-warn">全局未启用，Bot 暂不可用</span>}
        </p>
        {status && (
          <p>
            {status.configured ? '已配置' : '未配置'} ·{' '}
            {status.authenticated ? (status.locked ? '已锁定' : '已解锁') : '未登录'}
            {status.serverUrl ? (
              <>
                {' · '}
                <a href={status.serverUrl} target="_blank" rel="noreferrer">
                  {status.serverUrl} <ExternalLink size={13} aria-hidden="true" />
                </a>
              </>
            ) : null}
          </p>
        )}
        {status?.email && <p>账号：{status.email}</p>}
        <p className="secondary">
          上次同步：{status?.lastSyncAt ?? '无'} · 自动锁定：{status?.expiresAt ?? '无'} · Bot 级启用见「分配」标签页
        </p>
      </div>

      {error && <p role="alert" className="inline-error config-error">{error}</p>}
      {message && <p role="status" className="inline-notice">{message}</p>}

      <div className="action-row">
        <button type="button" className="button secondary-button button-sm" disabled={busy} onClick={() => void run(refresh)}>
          <RefreshCw size={15} aria-hidden="true" />
          刷新状态
        </button>
        {external && status?.configured && (
          <button type="button" className="button secondary-button button-sm" disabled={busy} onClick={() => void run(async () => control({ action: 'check' }))}>
            <Check size={15} aria-hidden="true" />
            检查连接
          </button>
        )}
        {external && status?.authenticated && !status.locked && (
          <>
            <button type="button" className="button secondary-button button-sm" disabled={busy} onClick={() => void run(async () => control({ action: 'sync' }))}>
              <Download size={15} aria-hidden="true" />
              同步
            </button>
            <button type="button" className="button secondary-button button-sm" disabled={busy} onClick={() => void run(async () => control({ action: 'lock' }))}>
              <Lock size={15} aria-hidden="true" />
              锁定
            </button>
          </>
        )}
        {external && status?.authenticated && (
          <button type="button" className="button secondary-button button-sm" disabled={busy} onClick={() => void run(async () => control({ action: 'logout' }))}>
            <Power size={15} aria-hidden="true" />
            退出账号
          </button>
        )}
      </div>

      <form className="form" onSubmit={saveSource}>
        <div className="form-grid">
          <label>
            密码库来源
            <select disabled={busy || !status} value={source} onChange={event => setSource(event.target.value === 'vaultwarden' ? 'vaultwarden' : 'local')}>
              <option value="local">本地密码库（各 Host 独立保存）</option>
              <option value="vaultwarden">Vaultwarden（中心统一账号）</option>
            </select>
          </label>
          {source === 'vaultwarden' && (
            <label>
              服务地址（https://）
              <input
                value={serverUrl}
                disabled={busy || !status}
                onChange={event => setServerUrl(event.target.value)}
                placeholder="https://vaultwarden.example.com"
                inputMode="url"
                autoComplete="off"
              />
            </label>
          )}
          {source === 'vaultwarden' && (
            <label>
              账号邮箱
              <input
                type="email"
                value={email}
                disabled={busy || !status}
                onChange={event => setEmail(event.target.value)}
                autoComplete="off"
                required
                maxLength={320}
              />
            </label>
          )}
        </div>
        <div className="action-row">
          <button type="submit" className="button secondary-button button-sm" disabled={busy || !status || (source === status.source && (serverUrl.trim() || null) === status.serverUrl && (email.trim().toLowerCase() || null) === status.email)}>
            保存来源
          </button>
        </div>
        {source === 'vaultwarden' && <p className="secondary">只保存服务地址与邮箱。首次使用时，在客户端私密解锁界面输入主密码即可登录并解锁。</p>}
      </form>

      {external && status?.configured && (!status.authenticated || status.locked) && (
        <form className="form" onSubmit={submitUnlock}>
          <label>
            主密码
            <input name="masterPassword" type="password" autoComplete="off" required disabled={busy} />
          </label>
          <div className="action-row">
            <button type="submit" className="button" disabled={busy}>
              <KeyRound size={15} aria-hidden="true" />
              {status.authenticated ? '解锁' : '登录并解锁'}
            </button>
          </div>
        </form>
      )}

      {externalReady && (
        <section className="card-group">
          <div className="card-header">
            <h3>外部条目授权</h3>
          </div>
          {!list || list.items.length === 0 ? (
            <p className="empty-state secondary">同步后暂无条目；请在 Vaultwarden 中新增条目后点击「同步」。</p>
          ) : (
            <div className="card-grid">
              {list.items.map(item => {
                const draft = drafts[item.secretRef];
                const grants = draft ?? item.allowedBots;
                const choice = pick[item.secretRef] ?? { deviceId: '', botId: '' };
                return (
                  <article key={item.secretRef} className="resource-card resource-row">
                    <div className="card-header">
                      <strong>{item.label}</strong>
                      <span className="secondary">{item.username}</span>
                    </div>
                    {grants.length === 0 ? (
                      <p className="secondary">未授权任何 Bot。</p>
                    ) : (
                      <div className="filter-bar" role="group" aria-label="已授权 Bot">
                        {grants.map(grant => (
                          <button
                            key={grantKey(grant)}
                            type="button"
                            className="filter-chip"
                            disabled={busy}
                            title="点击移除授权"
                            onClick={() => setDraft(item.secretRef, item.allowedBots, grants.filter(g => grantKey(g) !== grantKey(grant)))}
                          >
                            {botLabel(grant)} <X size={12} aria-hidden="true" />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="form-grid">
                      <label>
                        设备
                        <select
                          disabled={busy}
                          value={choice.deviceId}
                          onChange={event => {
                            const deviceId = event.target.value;
                            setPick(prev => ({ ...prev, [item.secretRef]: { deviceId, botId: '' } }));
                            void ensureBots(deviceId);
                          }}
                        >
                          <option value="">选择设备</option>
                          {devices.map(device => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.name} · {device.online ? '在线' : '离线'}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Bot
                        <select
                          disabled={busy || !choice.deviceId}
                          value={choice.botId}
                          onChange={event => setPick(prev => ({ ...prev, [item.secretRef]: { ...choice, botId: event.target.value } }))}
                        >
                          <option value="">选择 Bot</option>
                          {(bots[choice.deviceId] ?? []).map(bot => (
                            <option key={bot.botId} value={bot.botId}>{bot.name}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="action-row">
                      <button type="button" className="button secondary-button button-sm" disabled={busy || !choice.botId} onClick={() => addGrant(item)}>
                        <Plus size={14} aria-hidden="true" />
                        添加授权
                      </button>
                      {draft && (
                        <>
                          <button type="button" className="button button-sm" disabled={busy} onClick={() => saveGrants(item)}>
                            保存授权
                          </button>
                          <button type="button" className="quiet-button" disabled={busy} onClick={() => setDrafts(prev => { const copy = { ...prev }; delete copy[item.secretRef]; return copy; })}>
                            放弃修改
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
