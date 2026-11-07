import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { VaultControlInput, VaultItemMeta, VaultStatus } from '../../../host-core/index.js';
import { Switch } from '../bot-settings/primitives';
import { useText } from '../ui';
import './VaultPanel.css';

export type VaultCall = (input: VaultControlInput) => Promise<unknown>;

type Props = {
  /** Includes Host, connection generation and account; never reuse management state across identities. */
  identityKey: string;
  botId: string;
  hostLabel: string;
  connected: boolean;
  call: VaultCall;
};

export function VaultPanel(props: Props) {
  return <VaultSession key={JSON.stringify([props.identityKey, props.botId, props.connected])} {...props} />;
}

function VaultSession({ botId, hostLabel, connected, call }: Props) {
  const t = useText();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [editor, setEditor] = useState<VaultItemMeta | 'new' | null>(null);
  const [allowed, setAllowed] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
      case 'VAULT_UNLOCK_FAILED': return t('主密码不正确。', 'Incorrect master password.');
      case 'VAULT_LOCKED': return t('密码库已锁定，请刷新后解锁。', 'Vault is locked. Refresh and unlock.');
      case 'VAULT_INVALID_ARGUMENT': return t('密码库输入无效，请刷新后检查并重新输入。', 'Invalid Vault input. Refresh, review and enter it again.');
      case 'VAULT_NOT_FOUND': return t('条目已不可用，请刷新密码库。', 'Entry is unavailable. Refresh Vault.');
      case 'VAULT_NOT_INITIALIZED': return t('密码库尚未创建，请刷新后创建。', 'Vault is not initialized. Refresh to initialize it.');
      case 'VAULT_ALREADY_INITIALIZED': return t('密码库已创建，请刷新后解锁。', 'Vault is already initialized. Refresh and unlock.');
      case 'VAULT_FORBIDDEN': return t('密码库访问未获授权，请刷新并检查 Bot 授权。', 'Vault access is not permitted. Refresh and review Bot permissions.');
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
    // Drop management metadata immediately, including when a lock request is unconfirmed.
    setItems([]);
    setRevision(null);
    setStatus(null);
    try {
      const result = await callRef.current(input);
      if (!active.current) return;
      const next = (input.action === 'status' || input.action === 'initialize' ||
        input.action === 'unlock' || input.action === 'lock' || input.action === 'changePassword')
        ? result as VaultStatus
        : await callRef.current({ action: 'status' }) as VaultStatus;
      if (!active.current) return;
      if (next.initialized && !next.locked) {
        const list = await callRef.current({ action: 'list' }) as { revision: number; items: VaultItemMeta[] };
        if (!active.current) return;
        setItems(list.items);
        setRevision(list.revision);
      }
      setStatus(next);
    } catch (error) {
      if (!active.current) return;
      setItems([]);
      setRevision(null);
      setStatus(null);
      setError(failure(error));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  // Only the initial read is automatic. Failed operations are never replayed.
  useEffect(() => {
    if (connected) void execute({ action: 'status' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disabled = busy || !connected;
  const editing = editor && editor !== 'new' ? editor : null;

  return (
    <section ref={root} className="vault-panel" aria-label={t('密码库', 'Password Vault')} aria-busy={busy}>
      <header>
        <h3>{t('密码库', 'Password Vault')}</h3>
        <p>{t('目标 Host', 'Target Host')}: {hostLabel}</p>
        <p>Bot: {botId}</p>
      </header>
      <p className="vault-hint">{t('密码只保存到此 Host 的加密密码库，不进入聊天。授权仅控制当前 Bot；其他 Bot 的授权保持不变。', 'Passwords stay in this Host’s encrypted vault, not chat. Permission changes affect only this Bot; other Bots retain their permissions.')}</p>
      <div className="vault-actions">
        <button className="bs-btn" type="button" disabled={disabled} onClick={() => void execute({ action: 'status' })}>{t('刷新状态', 'Refresh status')}</button>
        <button className="bs-btn" type="button" disabled={disabled || status?.initialized === false} onClick={() => void execute({ action: 'lock' })}>{t('锁定', 'Lock')}</button>
      </div>
      {!connected ? <p role="alert">{t('目标 Host 离线，未排队或重试。', 'Target Host is offline. Nothing was queued or retried.')}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <p role="status">{busy ? t('处理中…', 'Working…') : status ? !status.initialized ? t('尚未创建密码库', 'Vault not initialized') : status.locked ? t('已锁定', 'Locked') : t('已解锁', 'Unlocked') : t('状态未知', 'Status unknown')}</p>
      {status?.expiresAt ? <p className="vault-hint">{t('自动锁定时间', 'Auto-lock at')}: {status.expiresAt}</p> : null}

      {status && (!status.initialized || status.locked) ? (
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

      {status?.initialized && !status.locked ? <>
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
