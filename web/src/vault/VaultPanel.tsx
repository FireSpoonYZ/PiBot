import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  ExternalVaultControlInput,
  ExternalVaultItemMeta,
  ExternalVaultStatus,
  VaultControlInput,
  VaultItemMeta,
  VaultStatus,
} from '../../../host-core/index.js';
import { Switch } from '../bot-settings/primitives';
import { useText } from '../ui';
import './VaultPanel.css';

export type VaultCall = (input: VaultControlInput) => Promise<unknown>;

type Props = {
  /** Includes Host, connection generation and account; never reuse management state across identities. */
  identityKey: string;
  botId: string;
  /** Target Host device id; required for external (center) per-Bot grants. */
  deviceId?: string;
  hostLabel: string;
  connected: boolean;
  call: VaultCall;
};

export function VaultPanel(props: Props) {
  return <VaultSession key={JSON.stringify([props.identityKey, props.botId, props.deviceId, props.connected])} {...props} />;
}

function isExternalList(value: unknown): value is { revision: number; items: ExternalVaultItemMeta[] } {
  return !!value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items);
}

function VaultSession({ botId, deviceId, hostLabel, connected, call }: Props) {
  const t = useText();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [extItems, setExtItems] = useState<ExternalVaultItemMeta[]>([]);
  const [extRevision, setExtRevision] = useState<number | null>(null);
  const [editor, setEditor] = useState<VaultItemMeta | 'new' | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const root = useRef<HTMLElement>(null);
  const active = useRef(false);
  const inFlight = useRef(false);
  const callRef = useRef(call);
  callRef.current = call;

  function clearForms() {
    root.current?.querySelectorAll('form').forEach(form => form.reset());
  }

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearForms();
    };
  }, []);

  function failure(error: unknown): string {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    switch (code) {
      case 'VAULT_UNLOCK_FAILED': return t('无法登录或解锁，请检查主密码及账号设置。', 'Could not sign in or unlock. Check the master password and account settings.');
      case 'VAULT_LOCKED': return t('密码库已锁定，请刷新后解锁。', 'Vault is locked. Refresh and unlock.');
      case 'VAULT_INVALID_ARGUMENT': return t('密码库输入无效，请刷新后检查并重新输入。', 'Invalid Vault input. Refresh, review and enter it again.');
      case 'VAULT_NOT_FOUND': return t('条目已不可用，请刷新密码库。', 'Entry is unavailable. Refresh Vault.');
      case 'VAULT_NOT_INITIALIZED': return t('密码库尚未创建，请刷新后创建。', 'Vault is not initialized. Refresh to initialize it.');
      case 'VAULT_ALREADY_INITIALIZED': return t('密码库已创建，请刷新后解锁。', 'Vault is already initialized. Refresh and unlock.');
      case 'VAULT_FORBIDDEN': return t('密码库访问未获授权，请刷新并检查 Bot 授权。', 'Vault access is not permitted. Refresh and review Bot permissions.');
      case 'VAULT_NOT_CONFIGURED': return t('外部密码库尚未配置，请先完成服务设置。', 'External Vault is not configured. Finish the service setup first.');
      case 'VAULT_NEEDS_LOGIN': return t('请输入主密码以登录并解锁外部密码库。', 'Enter the master password to sign in and unlock the external Vault.');
      case 'VAULT_LOGIN_CHALLENGE': return t('账号要求额外登录验证，当前尚不支持该验证方式。', 'This account requires additional login verification that is not supported yet.');
      case 'VAULT_CONNECTION_FAILED': return t('无法连接外部密码库服务，请检查地址后刷新。', 'Cannot reach the external Vault service. Check the address and refresh.');
      case 'VAULT_UNSUPPORTED': return t('当前 Host 不支持此密码库操作。', 'This Host does not support that Vault operation.');
      case 'VAULT_STALE_SESSION': return t('密码库会话已过期，请刷新后重新解锁。', 'Vault session expired. Refresh and unlock again.');
      case 'VAULT_REQUEST_EXPIRED': return t('请求已过期，请重试。', 'The request expired. Try again.');
      case 'VAULT_CONFLICT':
      case 'VAULT_REVISION_CONFLICT':
      case 'REVISION_CONFLICT':
      case 'REQUEST_CONFLICT': return t('密码库已变化，请刷新后重新编辑。', 'Vault changed. Refresh before editing again.');
      case 'NOT_CONNECTED':
      case 'OFFLINE':
      case 'CONTROL_UNAVAILABLE':
      case 'CENTER_OFFLINE': return t('目标 Host 离线，未排队或重试。', 'Target Host is offline. Nothing was queued or retried.');
      case 'RUNTIME_BUSY': return t('Host 正在维护，请稍后手动刷新。', 'Host is busy. Refresh manually later.');
      default: return t('操作结果未确认。请刷新核对状态；不会自动重试。', 'Operation unconfirmed. Refresh to review; no automatic retry.');
    }
  }

  async function refreshExternal(statusValue: VaultStatus) {
    const ext = statusValue.external;
    if (statusValue.source === 'vaultwarden' && ext?.configured && ext.authenticated && !ext.locked) {
      const list = await callRef.current({ action: 'external', input: { action: 'list' } });
      if (!active.current) return;
      if (isExternalList(list)) {
        setExtItems(list.items);
        setExtRevision(list.revision);
        return;
      }
    }
    setExtItems([]);
    setExtRevision(null);
  }

  async function execute(input: VaultControlInput) {
    clearForms();
    if (inFlight.current) return;
    setEditor(null);
    setChangingPassword(false);
    setDeleting(null);
    if (!connected) {
      setError(t('目标 Host 离线，未排队或重试。', 'Target Host is offline. Nothing was queued or retried.'));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    // Drop management metadata immediately, including when a lock request is unconfirmed.
    setItems([]);
    setRevision(null);
    setExtItems([]);
    setExtRevision(null);
    setStatus(null);
    try {
      const result = await callRef.current(input);
      if (!active.current) return;
      if (input.action === 'external' && input.input.action === 'check' &&
          result && typeof result === 'object' && 'reachable' in result) {
        setNotice((result as { reachable: unknown }).reachable === true
          ? t('连接正常。', 'Connection OK.')
          : t('无法连接 Vaultwarden 服务。', 'Cannot reach the Vaultwarden service.'));
      }
      const next = (input.action === 'status' || input.action === 'initialize' ||
        input.action === 'unlock' || input.action === 'lock' || input.action === 'changePassword')
        ? result as VaultStatus
        : await callRef.current({ action: 'status' }) as VaultStatus;
      if (!active.current) return;
      if (next.source === 'vaultwarden') {
        await refreshExternal(next);
        if (!active.current) return;
      } else if (next.initialized && !next.locked) {
        const list = await callRef.current({ action: 'list' }) as { revision: number; items: VaultItemMeta[] };
        if (!active.current) return;
        setItems(list.items);
        setRevision(list.revision);
      }
      setStatus(next);
      setConfiguring(false);
    } catch (error) {
      if (!active.current) return;
      setItems([]);
      setRevision(null);
      setExtItems([]);
      setExtRevision(null);
      setStatus(null);
      setError(failure(error));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  const executeExternal = (input: ExternalVaultControlInput) => execute({ action: 'external', input });

  // Only the initial read is automatic. Failed operations are never replayed.
  useEffect(() => {
    if (connected) void execute({ action: 'status' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disabled = busy || !connected;
  const editing = editor && editor !== 'new' ? editor : null;
  const ext: ExternalVaultStatus | undefined = status?.external ?? undefined;
  const external = status?.source === 'vaultwarden';
  const extReady = !!(external && ext?.configured && ext.authenticated && !ext.locked);
  const grantKey = (grant: { deviceId: string; botId: string }) => grant.deviceId + '/' + grant.botId;

  return (
    <section ref={root} className="vault-panel" aria-label={t('密码库', 'Password Vault')} aria-busy={busy}>
      <header>
        <h3>{t('密码库', 'Password Vault')}</h3>
        <p>{t('目标 Host', 'Target Host')}: {hostLabel}</p>
        <p>Bot: {botId}</p>
      </header>
      <p className="vault-hint">{external
        ? t('条目由中心统一的 Vaultwarden 账号提供；密码只经私有通道下发，不进入聊天。授权仅控制当前 Bot；其他 Bot 的授权保持不变。', 'Entries come from the shared Vaultwarden account managed by the center; secrets travel only over the private channel, never chat. Permission changes affect only this Bot; other Bots retain their permissions.')
        : t('密码只保存到此 Host 的加密密码库，不进入聊天。授权仅控制当前 Bot；其他 Bot 的授权保持不变。', 'Passwords stay in this Host’s encrypted vault, not chat. Permission changes affect only this Bot; other Bots retain their permissions.')}</p>
      <div className="vault-actions">
        <button className="bs-btn" type="button" disabled={disabled} onClick={() => void execute({ action: 'status' })}>{t('刷新状态', 'Refresh status')}</button>
        {!external ? <button className="bs-btn" type="button" disabled={disabled || status?.initialized === false} onClick={() => void execute({ action: 'lock' })}>{t('锁定', 'Lock')}</button> : null}
      </div>
      {!connected ? <p role="alert">{t('目标 Host 离线，未排队或重试。', 'Target Host is offline. Nothing was queued or retried.')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status" className="vault-hint">{notice}</p> : null}
      <p role="status">
        {busy ? t('处理中…', 'Working…') : status
          ? external
            ? !ext?.configured ? t('外部密码库未配置', 'External Vault not configured')
              : !ext.authenticated ? t('外部密码库未登录', 'External Vault not signed in')
              : ext.locked ? t('已锁定', 'Locked') : t('已解锁', 'Unlocked')
            : !status.initialized ? t('尚未创建密码库', 'Vault not initialized')
            : status.locked ? t('已锁定', 'Locked') : t('已解锁', 'Unlocked')
          : t('状态未知', 'Status unknown')}
      </p>
      {status ? <p className="vault-hint">{t('来源', 'Source')}: {external ? 'Vaultwarden' : status.source === 'local' ? t('本地密码库', 'Local vault') : t('本地密码库（旧版 Host）', 'Local vault (older Host)')}</p> : null}
      {status?.expiresAt ? <p className="vault-hint">{t('自动锁定时间', 'Auto-lock at')}: {status.expiresAt}</p> : null}
      {external && ext?.expiresAt ? <p className="vault-hint">{t('外部会话自动锁定', 'External session auto-lock')}: {ext.expiresAt}</p> : null}
      {status && !status.source ? <p className="vault-hint">{t('此 Host 版本较旧，不支持外部密码库；如需 Vaultwarden 请升级 Host。', 'This Host is too old for an external vault. Upgrade the Host to use Vaultwarden.')}</p> : null}

      {status?.source ? (
        <div className="vault-actions">
          <button className="bs-btn is-ghost" type="button" disabled={disabled} onClick={() => { clearForms(); setConfiguring(value => !value); }}>
            {t('服务设置', 'Service settings')}
          </button>
          {external && ext?.configured ? (
            <button className="bs-btn" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'check' })}>{t('检查连接', 'Check connection')}</button>
          ) : null}
          {extReady ? (
            <>
              <button className="bs-btn" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'sync' })}>{t('同步', 'Sync')}</button>
              <button className="bs-btn" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'lock' })}>{t('锁定', 'Lock')}</button>
            </>
          ) : null}
          {external && ext?.authenticated ? (
            <button className="bs-btn is-danger" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'logout' })}>{t('退出账号', 'Sign out')}</button>
          ) : null}
        </div>
      ) : null}
      {external && ext?.serverUrl ? (
        <p className="vault-hint">
          <a href={ext.serverUrl} target="_blank" rel="noreferrer">{t('打开 Vaultwarden 管理条目', 'Open Vaultwarden to manage entries')}</a>
          {ext.email ? <> · {ext.email}</> : null}
          {ext.lastSyncAt ? <> · {t('上次同步', 'Last sync')}: {ext.lastSyncAt}</> : null}
        </p>
      ) : null}

      {configuring && status?.source ? (
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const source = (form.elements.namedItem('source') as HTMLSelectElement).value === 'vaultwarden' ? 'vaultwarden' as const : 'local' as const;
          const serverUrl = (form.elements.namedItem('serverUrl') as HTMLInputElement).value.trim();
          const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim().toLowerCase();
          form.reset();
          if (source === 'vaultwarden' && !/^https:\/\//i.test(serverUrl)) {
            setError(t('Vaultwarden 地址必须使用 https://', 'The Vaultwarden address must use https://'));
            return;
          }
          if (source === 'vaultwarden' && !email) {
            setError(t('请填写账号邮箱。', 'Enter the account email.'));
            return;
          }
          const revision = status?.external?.revision;
          if (revision === undefined) return;
          void executeExternal({ action: 'configure', expectedRevision: revision, source, ...(source === 'vaultwarden' ? { serverUrl, email } : {}) });
        }}>
          <fieldset disabled={disabled}>
            <legend>{t('密码库来源', 'Vault source')}</legend>
            <label>{t('来源', 'Source')}
              <select className="bs-input" name="source" defaultValue={external ? 'vaultwarden' : 'local'}>
                <option value="local">{t('本地密码库', 'Local vault')}</option>
                <option value="vaultwarden">Vaultwarden</option>
              </select>
            </label>
            <label>{t('Vaultwarden 地址（https://）', 'Vaultwarden address (https://)')}
              <input className="bs-input" name="serverUrl" defaultValue={ext?.serverUrl ?? ''} inputMode="url" autoComplete="off" placeholder="https://vaultwarden.example.com" />
            </label>
            <label>{t('账号邮箱', 'Account email')}
              <input className="bs-input" name="email" type="email" defaultValue={ext?.email ?? ''} maxLength={320} autoComplete="off" />
            </label>
            <div className="vault-actions">
              <button className="bs-btn is-primary" type="submit">{t('保存来源', 'Save source')}</button>
              <button className="bs-btn is-ghost" type="button" onClick={() => { clearForms(); setConfiguring(false); }}>{t('取消', 'Cancel')}</button>
            </div>
            <p className="vault-hint">{t('切换来源会锁定当前会话；显式切到外部后连接失败不会退回本地。', 'Switching source locks the session; once external is chosen, connection failures never fall back to local.')}</p>
          </fieldset>
        </form>
      ) : null}

      {external && ext?.configured && (!ext.authenticated || ext.locked) ? (
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
          const expectedEpoch = ext?.epoch;
          form.reset();
          if (expectedEpoch === undefined) return;
          void executeExternal({ action: 'unlock', masterPassword, expectedEpoch });
        }}>
          <fieldset disabled={disabled}>
            <legend>{ext.authenticated ? t('解锁外部密码库', 'Unlock external Vault') : t('登录并解锁', 'Sign in and unlock')}</legend>
            <p className="vault-hint">{t('首次使用时会用本次主密码登录已配置账号；主密码不保存、不进入聊天。', 'On first use, this master password signs in to the configured account. It is not saved or sent to chat.')}</p>
            <label>{t('主密码', 'Master password')}<input className="bs-input" name="masterPassword" type="password" autoComplete="off" required /></label>
            <div className="vault-actions">
              <button className="bs-btn is-primary" type="submit">{t('解锁', 'Unlock')}</button>
              <button className="bs-btn is-ghost" type="button" onClick={clearForms}>{t('清空', 'Clear')}</button>
            </div>
          </fieldset>
        </form>
      ) : null}

      {external && ext && !ext.configured ? (
        <p className="vault-hint">{t('尚未配置外部密码库。请在「服务设置」填写 Vaultwarden 地址和账号邮箱，或前往中心管理页的 Vault 插件配置。', 'External Vault is not configured yet. Set the Vaultwarden address and account email under “Service settings”, or use the Vault plugin page in the center console.')}</p>
      ) : null}

      {extReady ? (
        <>
          {!extItems.length ? <p className="vault-hint">{t('暂无条目。请在 Vaultwarden 中新增条目后点击「同步」。', 'No entries. Add entries in Vaultwarden, then “Sync”.')}</p> : null}
          <ul className="vault-items">
            {extItems.map(item => {
              const allowedNow = !!deviceId && item.allowedBots.some(grant => grant.deviceId === deviceId && grant.botId === botId);
              return (
                <li key={item.secretRef}>
                  <div>
                    <strong>{item.label}</strong>
                    <p>{item.username}</p>
                    <p className="vault-hint">{allowedNow ? t('已授权当前 Bot', 'Allowed for this Bot') : t('未授权当前 Bot', 'Not allowed for this Bot')}</p>
                  </div>
                  <div className="vault-permission">
                    <span>{t('授权当前 Bot', 'Allow this Bot')}</span>
                    <Switch
                      checked={allowedNow}
                      disabled={disabled || !deviceId || extRevision === null}
                      label={t('授权当前 Bot', 'Allow this Bot')}
                      onChange={next => {
                        if (!deviceId || extRevision === null) return;
                        const others = item.allowedBots.filter(grant => grantKey(grant) !== grantKey({ deviceId, botId }));
                        const allowedBots = next ? [...others, { deviceId, botId }] : others;
                        void executeExternal({ action: 'setGrants', expectedRevision: extRevision, secretRef: item.secretRef, allowedBots });
                      }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {!deviceId ? <p className="vault-hint">{t('缺少设备标识，无法修改授权。', 'Missing device id; grant changes are unavailable.')}</p> : null}
          <p className="vault-hint">{t('条目的新增与修改请在 Vaultwarden 完成。', 'Add or edit entries in Vaultwarden.')}</p>
        </>
      ) : null}

      {!external && status && (!status.initialized || status.locked) ? (
        <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
          const confirmation = (form.elements.namedItem('confirmation') as HTMLInputElement | null)?.value;
          form.reset();
          if (!status.initialized && masterPassword !== confirmation) {
            setError(t('两次主密码不一致，请重新输入。', 'Master passwords do not match. Enter them again.'));
            return;
          }
          void execute({ action: status.initialized ? 'unlock' : 'initialize', masterPassword });
        }}>
          <fieldset disabled={disabled}>
            <label>{t('主密码', 'Master password')}<input className="bs-input" name="masterPassword" type="password" autoComplete="off" required /></label>
            {!status.initialized ? <label>{t('确认主密码', 'Confirm master password')}<input className="bs-input" name="confirmation" type="password" autoComplete="off" required /></label> : null}
            <div className="vault-actions">
              <button className="bs-btn is-primary" type="submit">{status.initialized ? t('解锁', 'Unlock') : t('创建密码库', 'Create vault')}</button>
              <button className="bs-btn is-ghost" type="button" onClick={clearForms}>{t('清空', 'Clear')}</button>
            </div>
          </fieldset>
        </form>
      ) : null}

      {!external && status?.initialized && !status.locked ? <>
        <div className="vault-actions">
          <button className="bs-btn" type="button" disabled={disabled} onClick={() => { clearForms(); setEditor('new'); setAllowed(false); setChangingPassword(false); setDeleting(null); }}>{t('添加条目', 'Add entry')}</button>
          <button className="bs-btn" type="button" disabled={disabled} onClick={() => { clearForms(); setEditor(null); setChangingPassword(true); setDeleting(null); }}>{t('更改主密码', 'Change master password')}</button>
        </div>
        {!items.length ? <p className="vault-hint">{t('暂无条目。新条目默认不授权任何 Bot。', 'No entries. New entries allow no Bots by default.')}</p> : null}
        <ul className="vault-items">
          {items.map(item => <li key={item.secretRef}>
            <div><strong>{item.label}</strong><p>{item.username}</p><p className="vault-hint">{item.allowedBotIds.includes(botId) ? t('已授权当前 Bot', 'Allowed for this Bot') : t('未授权当前 Bot', 'Not allowed for this Bot')}</p></div>
            <div className="vault-actions">
              <button className="bs-btn" type="button" disabled={disabled} onClick={() => { clearForms(); setEditor(item); setAllowed(item.allowedBotIds.includes(botId)); setChangingPassword(false); setDeleting(null); }}>{t('编辑', 'Edit')}</button>
              <button className="bs-btn is-danger" type="button" disabled={disabled} onClick={() => { clearForms(); setEditor(null); setChangingPassword(false); setDeleting(item.secretRef); }}>{t('删除', 'Delete')}</button>
            </div>
            {deleting === item.secretRef ? <div>
              <p>{t('从此 Host 删除条目？所有 Bot 都将无法再使用它。', 'Delete this entry from this Host? No Bot will be able to use it.')}</p>
              <div className="vault-actions">
                <button className="bs-btn is-danger" type="button" disabled={disabled || revision === null} onClick={() => { if (revision !== null) void execute({ action: 'delete', expectedRevision: revision, secretRef: item.secretRef }); }}>{t('确认删除', 'Confirm delete')}</button>
                <button className="bs-btn is-ghost" type="button" disabled={disabled} onClick={() => setDeleting(null)}>{t('取消', 'Cancel')}</button>
              </div>
            </div> : null}
          </li>)}
        </ul>
        {editor ? <form key={editing?.secretRef ?? 'new'} onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const label = (form.elements.namedItem('label') as HTMLInputElement).value;
          const username = (form.elements.namedItem('username') as HTMLInputElement).value;
          const password = (form.elements.namedItem('password') as HTMLInputElement).value;
          form.reset();
          if (revision === null) return;
          const allowedBotIds = (editing?.allowedBotIds ?? []).filter(id => id !== botId);
          if (allowed) allowedBotIds.push(botId);
          void execute({
            action: 'save', expectedRevision: revision,
            item: { ...(editing ? { secretRef: editing.secretRef } : {}), label, username,
              ...(password ? { password } : {}), allowedBotIds },
          });
        }}>
          <fieldset disabled={disabled}>
            <legend>{editing ? t('编辑条目', 'Edit entry') : t('添加条目', 'Add entry')}</legend>
            <label>{t('名称', 'Label')}<input className="bs-input" name="label" defaultValue={editing?.label ?? ''} required /></label>
            <label>{t('用户名', 'Username')}<input className="bs-input" name="username" defaultValue={editing?.username ?? ''} autoComplete="off" /></label>
            <label>{editing ? t('新密码（留空保持不变）', 'New password (blank keeps existing)') : t('密码', 'Password')}<input className="bs-input" name="password" type="password" autoComplete="off" maxLength={1000} required={!editing} /></label>
            <div className="vault-permission"><span>{t('授权当前 Bot', 'Allow this Bot')}</span><Switch checked={allowed} onChange={setAllowed} label={t('授权当前 Bot', 'Allow this Bot')} disabled={disabled} /></div>
            <div className="vault-actions">
              <button className="bs-btn is-primary" type="submit" disabled={revision === null}>{t('保存', 'Save')}</button>
              <button className="bs-btn is-ghost" type="button" onClick={() => { clearForms(); setEditor(null); }}>{t('取消', 'Cancel')}</button>
            </div>
          </fieldset>
        </form> : null}
        {changingPassword ? <form onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
          const newMasterPassword = (form.elements.namedItem('newMasterPassword') as HTMLInputElement).value;
          const confirmation = (form.elements.namedItem('confirmation') as HTMLInputElement).value;
          form.reset();
          if (newMasterPassword !== confirmation) {
            setError(t('两次主密码不一致，请重新输入。', 'Master passwords do not match. Enter them again.'));
            return;
          }
          void execute({ action: 'changePassword', masterPassword, newMasterPassword });
        }}>
          <fieldset disabled={disabled}>
            <legend>{t('更改主密码', 'Change master password')}</legend>
            <label>{t('当前主密码', 'Current master password')}<input className="bs-input" name="masterPassword" type="password" autoComplete="off" required /></label>
            <label>{t('新主密码', 'New master password')}<input className="bs-input" name="newMasterPassword" type="password" autoComplete="off" required /></label>
            <label>{t('确认新主密码', 'Confirm new master password')}<input className="bs-input" name="confirmation" type="password" autoComplete="off" required /></label>
            <div className="vault-actions">
              <button className="bs-btn is-primary" type="submit">{t('更改主密码', 'Change master password')}</button>
              <button className="bs-btn is-ghost" type="button" onClick={() => { clearForms(); setChangingPassword(false); }}>{t('取消', 'Cancel')}</button>
            </div>
          </fieldset>
        </form> : null}
      </> : null}
    </section>
  );
}
