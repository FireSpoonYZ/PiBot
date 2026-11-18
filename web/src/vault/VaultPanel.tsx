// 单 Bot 密码库面板：零闪烁乐观授权、主密码解锁/创建、+ 新增凭据并授权、全局操作收纳于底部。
import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Lock, Plus, RefreshCw } from 'lucide-react';
import type {
  ExternalVaultControlInput,
  ExternalVaultGrant,
  ExternalVaultItemMeta,
  ExternalVaultStatus,
  VaultControlInput,
  VaultItemMeta,
  VaultStatus,
} from '../../../host-core/index.js';
import { Badge, Disclosure, Switch } from '../bot-settings/primitives';
import { ErrorNotice, useText } from '../ui';
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
  variant?: 'mobile' | 'desktop';
  onOpenGlobalVault?: () => void;
};

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function VaultPanel(props: Props) {
  return <VaultSession key={props.identityKey} {...props} />;
}

function VaultSession({
  botId,
  deviceId,
  hostLabel,
  connected,
  call,
  variant,
  onOpenGlobalVault,
}: Props) {
  const t = useText();
  const desktop = variant === 'desktop';

  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [extItems, setExtItems] = useState<ExternalVaultItemMeta[]>([]);
  const [extRevision, setExtRevision] = useState<number | null>(null);

  const [editor, setEditor] = useState<VaultItemMeta | 'new' | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [sourceChoice, setSourceChoice] = useState<'local' | 'vaultwarden'>('local');
  const [checkNote, setCheckNote] = useState('');

  const [busy, setBusy] = useState(false);
  const [togglingRef, setTogglingRef] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const active = useRef(true);
  const inFlight = useRef(false);
  const root = useRef<HTMLElement>(null);
  const callRef = useRef(call);
  const revisionRef = useRef<number | null>(null);
  const extRevisionRef = useRef<number | null>(null);
  callRef.current = call;
  revisionRef.current = revision;
  extRevisionRef.current = extRevision;

  function clearForms() {
    if (!root.current) return;
    for (const form of root.current.querySelectorAll('form')) form.reset();
  }

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      clearForms();
    };
  }, []);

  function failureMessage(err: unknown): string {
    const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
    switch (code) {
      case 'VAULT_UNLOCK_FAILED':
        return t('无法登录或解锁，请检查主密码及账号设置。', 'Could not sign in or unlock. Check the master password and account settings.');
      case 'VAULT_LOCKED':
        return t('密码库已锁定，请解锁后重试。', 'Vault is locked. Unlock and retry.');
      case 'VAULT_INVALID_ARGUMENT':
        return t('密码库输入无效，请检查后重试。', 'Invalid Vault input. Check and retry.');
      case 'VAULT_CONFLICT':
      case 'VAULT_REVISION_CONFLICT':
        return t('密码库内容刚刚发生变化，已为您保留当前视图，请刷新后重试。', 'Vault changed recently. Please refresh and retry.');
      case 'VAULT_NOT_INITIALIZED':
        return t('密码库尚未创建，请先设置主密码。', 'Vault is not initialized yet.');
      case 'VAULT_NOT_FOUND':
        return t('该条目已不存在，请刷新列表。', 'Entry no longer exists. Please refresh.');
      case 'VAULT_EXTERNAL_UNREACHABLE':
        return t('无法连接 Vaultwarden 服务，请检查地址和网络。', 'Vaultwarden server is unreachable. Check URL and network.');
      case 'VAULT_EXTERNAL_UNCONFIGURED':
        return t('尚未配置 Vaultwarden 服务。', 'Vaultwarden is not configured yet.');
      default:
        return err instanceof Error ? err.message : String(err);
    }
  }

  function clearLocalItems() {
    setItems([]);
    setRevision(null);
  }

  function clearExternalItems() {
    setExtItems([]);
    setExtRevision(null);
  }

  async function refreshExternal(nextStatus: VaultStatus) {
    if (nextStatus.source !== 'vaultwarden') {
      clearExternalItems();
      return;
    }
    const ext = nextStatus.external;
    if (ext?.configured && ext.authenticated && !ext.locked) {
      const list = await callRef.current({ action: 'external', input: { action: 'list' } }) as {
        revision: number;
        items: ExternalVaultItemMeta[];
      };
      if (!active.current) return;
      setExtItems(list.items);
      setExtRevision(list.revision);
      return;
    }
    clearExternalItems();
  }

  async function execute(input: VaultControlInput) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setCheckNote('');

    const isLockOrLogout =
      input.action === 'lock'
      || (input.action === 'external' && (input.input.action === 'lock' || input.input.action === 'logout'));

    try {
      let next: VaultStatus;
      if (input.action === 'external') {
        if (input.input.action === 'check') {
          const result = await callRef.current(input) as { reachable: boolean; status: ExternalVaultStatus };
          if (!active.current) return;
          setCheckNote(result.reachable
            ? t('Vaultwarden 服务连接正常。', 'Vaultwarden server is reachable.')
            : t('无法连接到 Vaultwarden 服务。', 'Vaultwarden server is unreachable.'));
          next = await callRef.current({ action: 'status' }) as VaultStatus;
        } else {
          await callRef.current(input);
          if (!active.current) return;
          next = await callRef.current({ action: 'status' }) as VaultStatus;
        }
        if (!active.current) return;
        await refreshExternal(next);
        if (!active.current) return;
      } else {
        const result = await callRef.current(input);
        if (!active.current) return;
        if (input.action === 'status' || input.action === 'initialize' || input.action === 'unlock' || input.action === 'lock') {
          next = result as VaultStatus;
        } else {
          next = await callRef.current({ action: 'status' }) as VaultStatus;
        }
        if (!active.current) return;

        if (next.source === 'vaultwarden') {
          await refreshExternal(next);
          if (!active.current) return;
          clearLocalItems();
        } else if (next.initialized && !next.locked) {
          const list = await callRef.current({ action: 'list' }) as { revision: number; items: VaultItemMeta[] };
          if (!active.current) return;
          setItems(list.items);
          setRevision(list.revision);
        } else {
          clearLocalItems();
        }
      }

      if (!active.current) return;
      setStatus(next);
      if (next.source) setSourceChoice(next.source);
      clearForms();
      setEditor(null);
      setChangingPassword(false);
      setDeleting(null);
      setConfiguring(false);
      if (isLockOrLogout) {
        clearLocalItems();
        clearExternalItems();
        setNotice(t('密码库已锁定', 'Vault locked'));
      }
    } catch (err) {
      if (!active.current) return;
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
      if (code === 'VAULT_LOCKED') {
        clearLocalItems();
        clearExternalItems();
        setStatus(prev => prev ? { ...prev, locked: true } : prev);
      }
      setError(failureMessage(err));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  const executeExternal = (input: ExternalVaultControlInput) => execute({ action: 'external', input });

  useEffect(() => {
    if (connected) void execute({ action: 'status' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLocalGrant = async (item: VaultItemMeta, nextAllowed: boolean) => {
    if (revisionRef.current === null || togglingRef !== null) return;
    const prevItems = items;
    const baseRevision = revisionRef.current;
    const nextBotIds = item.allowedBotIds.filter(id => id !== botId);
    if (nextAllowed) nextBotIds.push(botId);

    setTogglingRef(item.secretRef);
    setError('');
    setNotice('');
    // 乐观更新单行，列表不清空不闪烁
    setItems(curr => curr.map(row => (row.secretRef === item.secretRef ? { ...row, allowedBotIds: nextBotIds } : row)));

    try {
      const res = await callRef.current({
        action: 'save',
        expectedRevision: baseRevision,
        item: {
          secretRef: item.secretRef,
          label: item.label,
          username: item.username,
          allowedBotIds: nextBotIds,
        },
      }) as { revision?: number; item?: VaultItemMeta };
      if (!active.current) return;
      if (typeof res?.revision === 'number') {
        setRevision(res.revision);
      } else {
        setRevision(baseRevision + 1);
      }
      if (res?.item) {
        setItems(curr => curr.map(row => (row.secretRef === item.secretRef ? res.item! : row)));
      }
    } catch (err) {
      if (!active.current) return;
      setItems(prevItems);
      setError(failureMessage(err));
    } finally {
      if (active.current) setTogglingRef(null);
    }
  };

  const toggleExternalGrant = async (item: ExternalVaultItemMeta, nextAllowed: boolean) => {
    if (!deviceId || extRevisionRef.current === null || togglingRef !== null) return;
    const prevExtItems = extItems;
    const baseRevision = extRevisionRef.current;
    const nextBots: ExternalVaultGrant[] = item.allowedBots.filter(
      g => !(g.deviceId === deviceId && g.botId === botId),
    );
    if (nextAllowed) nextBots.push({ deviceId, botId });

    setTogglingRef(item.secretRef);
    setError('');
    setNotice('');
    setExtItems(curr => curr.map(row => (row.secretRef === item.secretRef ? { ...row, allowedBots: nextBots } : row)));

    try {
      const res = await callRef.current({
        action: 'external',
        input: {
          action: 'setGrants',
          expectedRevision: baseRevision,
          secretRef: item.secretRef,
          allowedBots: nextBots,
        },
      }) as { revision?: number; items?: ExternalVaultItemMeta[] };
      if (!active.current) return;
      if (typeof res?.revision === 'number' && Array.isArray(res.items)) {
        setExtRevision(res.revision);
        setExtItems(res.items);
      } else {
        const refreshed = await callRef.current({ action: 'external', input: { action: 'list' } }) as {
          revision: number;
          items: ExternalVaultItemMeta[];
        };
        if (!active.current) return;
        setExtRevision(refreshed.revision);
        setExtItems(refreshed.items);
      }
    } catch (err) {
      if (!active.current) return;
      setExtItems(prevExtItems);
      setError(failureMessage(err));
    } finally {
      if (active.current) setTogglingRef(null);
    }
  };

  const disabled = busy || !connected;
  const editing = editor && editor !== 'new' ? editor : null;
  const ext = status?.external;
  const external = status?.source === 'vaultwarden';
  const localReady = !external && Boolean(status?.initialized && !status.locked);
  const extReady = external && Boolean(ext?.configured && ext.authenticated && !ext.locked);

  const statusBadgeText = (() => {
    if (!connected) return t('未连接 Host', 'Host disconnected');
    if (!status) return busy ? t('读取中...', 'Loading...') : t('状态未知', 'Unknown');
    if (external) {
      if (!ext?.configured) return t('未配置 Vaultwarden', 'Vaultwarden unconfigured');
      if (!ext.authenticated) return t('需登录解锁', 'Sign-in required');
      if (ext.locked) return t('已锁定', 'Locked');
      return t('Vaultwarden 已解锁', 'Vaultwarden unlocked');
    }
    if (!status.initialized) return t('尚未创建', 'Not created');
    return status.locked ? t('已锁定', 'Locked') : t('已解锁', 'Unlocked');
  })();

  const formattedExpiresAt = formatDateTime(external ? ext?.expiresAt : status?.expiresAt);
  const formattedSyncAt = formatDateTime(ext?.lastSyncAt);

  const renderGlobalManagementBody = () => (
    <div className="vault-global-section">
      <p className="vault-hint">
        {t('以下操作会影响当前 Host 上的全部智能体，请谨慎调整。', 'These settings affect all Bots on this Host.')}
      </p>

      <div className="vault-actions">
        {status?.source ? (
          <button
            className="bs-btn is-small"
            type="button"
            disabled={disabled}
            onClick={() => {
              clearForms();
              setSourceChoice(status.source ?? 'local');
              setConfiguring(v => !v);
            }}
          >
            {configuring ? t('取消配置来源', 'Cancel source config') : t('切换密码库来源', 'Switch vault source')}
          </button>
        ) : null}
        {external && ext?.configured ? (
          <button className="bs-btn is-small" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'check' })}>
            {t('测试连接', 'Check connection')}
          </button>
        ) : null}
        {external && extReady ? (
          <button className="bs-btn is-small" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'sync' })}>
            {t('同步条目', 'Sync entries')}
          </button>
        ) : null}
        {external && ext?.authenticated ? (
          <button className="bs-btn is-danger is-small" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'logout' })}>
            {t('退出 Vaultwarden 登录', 'Sign out Vaultwarden')}
          </button>
        ) : null}
        {localReady ? (
          <button
            className="bs-btn is-small"
            type="button"
            disabled={disabled}
            onClick={() => {
              clearForms();
              setEditor(null);
              setDeleting(null);
              setChangingPassword(v => !v);
            }}
          >
            {t('更改主密码', 'Change master password')}
          </button>
        ) : null}
      </div>

      {configuring && status?.source ? (
        <form
          className="vault-form-card"
          onSubmit={event => {
            event.preventDefault();
            if (!ext) return;
            const form = event.currentTarget;
            const source = (form.elements.namedItem('source') as HTMLSelectElement).value as 'local' | 'vaultwarden';
            const serverUrl = (form.elements.namedItem('serverUrl') as HTMLInputElement | null)?.value.trim() ?? '';
            const email = (form.elements.namedItem('email') as HTMLInputElement | null)?.value.trim() ?? '';
            void executeExternal({
              action: 'configure',
              expectedRevision: ext.revision,
              source,
              ...(source === 'vaultwarden' ? { serverUrl, email } : {}),
            });
          }}
        >
          <fieldset disabled={disabled}>
            <label>
              {t('密码库来源', 'Vault source')}
              <select
                className="bs-select"
                name="source"
                value={sourceChoice}
                onChange={e => setSourceChoice(e.currentTarget.value as 'local' | 'vaultwarden')}
              >
                <option value="local">{t('本地密码库', 'Local vault')}</option>
                <option value="vaultwarden">Vaultwarden</option>
              </select>
            </label>
            {sourceChoice === 'vaultwarden' ? (
              <>
                <label>
                  {t('Vaultwarden 地址（https://）', 'Vaultwarden URL (https://)')}
                  <input className="bs-input" name="serverUrl" type="url" defaultValue={ext?.serverUrl ?? ''} required />
                </label>
                <label>
                  {t('账号邮箱', 'Account email')}
                  <input className="bs-input" name="email" type="email" defaultValue={ext?.email ?? ''} required />
                </label>
              </>
            ) : null}
            <div className="vault-actions">
              <button className="bs-btn is-primary is-small" type="submit">{t('保存来源设置', 'Save source')}</button>
              <button className="bs-btn is-ghost is-small" type="button" onClick={() => setConfiguring(false)}>{t('取消', 'Cancel')}</button>
            </div>
          </fieldset>
        </form>
      ) : null}

      {changingPassword && localReady ? (
        <form
          className="vault-form-card"
          onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
            const newMasterPassword = (form.elements.namedItem('newMasterPassword') as HTMLInputElement).value;
            const confirmation = (form.elements.namedItem('confirmation') as HTMLInputElement).value;
            form.reset();
            if (newMasterPassword !== confirmation) {
              setError(t('两次主密码不一致，请重新输入。', 'Master passwords do not match.'));
              return;
            }
            void execute({ action: 'changePassword', masterPassword, newMasterPassword });
          }}
        >
          <fieldset disabled={disabled}>
            <legend>{t('更改本地密码库主密码', 'Change local master password')}</legend>
            <label>{t('当前主密码', 'Current master password')}<input className="bs-input" name="masterPassword" type="password" autoComplete="off" required /></label>
            <label>{t('新主密码', 'New master password')}<input className="bs-input" name="newMasterPassword" type="password" autoComplete="off" required /></label>
            <label>{t('确认新主密码', 'Confirm new master password')}<input className="bs-input" name="confirmation" type="password" autoComplete="off" required /></label>
            <div className="vault-actions">
              <button className="bs-btn is-primary is-small" type="submit">{t('更新主密码', 'Update password')}</button>
              <button className="bs-btn is-ghost is-small" type="button" onClick={() => setChangingPassword(false)}>{t('取消', 'Cancel')}</button>
            </div>
          </fieldset>
        </form>
      ) : null}
    </div>
  );

  return (
    <section
      ref={root}
      className={desktop ? 'vault-panel vault-panel-desktop' : 'vault-panel'}
      aria-label={t('密码库', 'Password Vault')}
      aria-busy={busy}
    >
      <header className="vault-header-bar">
        <div className="vault-header-titles">
          <h3>{t('密码库', 'Password Vault')}</h3>
          <div className="vault-status-row">
            <Badge tone={localReady || extReady ? 'accent' : 'warning'}>{statusBadgeText}</Badge>
            <span className="vault-hint">{hostLabel}</span>
            {formattedExpiresAt ? (
              <span className="vault-hint">{t('自动锁定：', 'Auto-lock: ')}{formattedExpiresAt}</span>
            ) : null}
            {external && formattedSyncAt ? (
              <span className="vault-hint">{t('上次同步：', 'Synced: ')}{formattedSyncAt}</span>
            ) : null}
          </div>
        </div>

        <div className="vault-actions">
          <button
            className="bs-btn is-small"
            type="button"
            disabled={disabled}
            onClick={() => void execute({ action: 'status' })}
          >
            <RefreshCw aria-hidden="true" className={busy ? 'bs-spin' : undefined} />
            {t('刷新', 'Refresh')}
          </button>
          {localReady ? (
            <button
              className="bs-btn is-small"
              type="button"
              disabled={disabled}
              onClick={() => void execute({ action: 'lock' })}
            >
              <Lock aria-hidden="true" />
              {t('锁定', 'Lock')}
            </button>
          ) : null}
          {extReady ? (
            <button
              className="bs-btn is-small"
              type="button"
              disabled={disabled}
              onClick={() => void executeExternal({ action: 'lock' })}
            >
              <Lock aria-hidden="true" />
              {t('锁定', 'Lock')}
            </button>
          ) : null}
          {localReady ? (
            <button
              className="bs-btn is-primary is-small"
              type="button"
              disabled={disabled}
              onClick={() => {
                clearForms();
                setEditor('new');
                setAllowed(true);
                setDeleting(null);
              }}
            >
              <Plus aria-hidden="true" />
              {t('+ 新增凭据并授权', '+ Add & authorize')}
            </button>
          ) : null}
        </div>
      </header>

      <ErrorNotice error={error} onDismiss={() => setError('')} />
      {notice ? <ErrorNotice error={notice} tone="success" compact onDismiss={() => setNotice('')} /> : null}
      {checkNote ? <ErrorNotice error={checkNote} tone="success" compact onDismiss={() => setCheckNote('')} /> : null}

      {/* 外部密码库解锁 */}
      {external && ext?.configured && (!ext.authenticated || ext.locked) ? (
        <form
          className="vault-form-card"
          onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
            const expectedEpoch = ext.epoch;
            form.reset();
            void executeExternal({ action: 'unlock', masterPassword, expectedEpoch });
          }}
        >
          <fieldset disabled={disabled}>
            <legend>{ext.authenticated ? t('解锁 Vaultwarden', 'Unlock Vaultwarden') : t('登录并解锁 Vaultwarden', 'Sign in & unlock Vaultwarden')}</legend>
            <p className="vault-hint">
              {t('主密码仅用于当前会话解锁，不保存、不进入对话上下文。', 'Master password is never saved or sent to chat.')}
            </p>
            <label>
              {t('主密码', 'Master password')}
              <input className="bs-input" name="masterPassword" type="password" autoComplete="off" required />
            </label>
            <div className="vault-actions">
              <button className="bs-btn is-primary" type="submit">{t('解锁密码库', 'Unlock')}</button>
            </div>
          </fieldset>
        </form>
      ) : null}

      {/* 外部密码库列表（支持零闪烁单行授权） */}
      {extReady ? (
        <>
          <div className="vault-actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="vault-hint">
              {t('凭据来自全局 Vaultwarden，可在此单独授权本智能体使用。', 'Entries from global Vaultwarden; toggle access for this Bot below.')}
            </span>
            <button className="bs-btn is-small" type="button" disabled={disabled} onClick={() => void executeExternal({ action: 'sync' })}>
              {t('同步条目', 'Sync')}
            </button>
          </div>
          {!deviceId ? (
            <p className="vault-hint">{t('当前视图缺少设备标识，暂无法修改外部条目授权。', 'Device ID missing; external grants unavailable.')}</p>
          ) : null}
          {extItems.length === 0 ? (
            <p className="vault-hint">{t('暂无可用条目，可在全局 Vaultwarden 中新增后点击「同步条目」。', 'No entries yet; add entries in Vaultwarden and click Sync.')}</p>
          ) : (
            <ul className="vault-items">
              {extItems.map(item => {
                const isAllowed = Boolean(deviceId && item.allowedBots.some(g => g.deviceId === deviceId && g.botId === botId));
                return (
                  <li key={item.secretRef}>
                    <div className="vault-permission">
                      <div>
                        <strong>{item.label}</strong>
                        {item.username ? <p className="vault-hint">{item.username}</p> : null}
                      </div>
                      <div className="vault-switch-wrap">
                        <span className="vault-hint">{t('允许本智能体使用', 'Allow this Bot')}</span>
                        <Switch
                          checked={isAllowed}
                          label={`${t('允许本智能体使用', 'Allow this Bot')}: ${item.label}`}
                          disabled={disabled || !deviceId || togglingRef === item.secretRef}
                          onChange={next => void toggleExternalGrant(item, next)}
                        />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}

      {/* 本地密码库初始化 / 解锁 */}
      {!external && status && (!status.initialized || status.locked) ? (
        <form
          className="vault-form-card"
          onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
            const confirmation = (form.elements.namedItem('confirmation') as HTMLInputElement | null)?.value;
            form.reset();
            if (!status.initialized && masterPassword !== confirmation) {
              setError(t('两次主密码不一致，请重新输入。', 'Master passwords do not match.'));
              return;
            }
            void execute({ action: status.initialized ? 'unlock' : 'initialize', masterPassword });
          }}
        >
          <fieldset disabled={disabled}>
            <legend>{status.initialized ? t('解锁本地密码库', 'Unlock local vault') : t('创建本地密码库', 'Create local vault')}</legend>
            <p className="vault-hint">
              {t('主密码不保存、不进入聊天上下文；解锁后可选择向当前智能体授权哪些凭据。', 'Master password is never stored or shared in chat.')}
            </p>
            <label>
              {t('主密码', 'Master password')}
              <input className="bs-input" name="masterPassword" type="password" autoComplete="off" required />
            </label>
            {!status.initialized ? (
              <label>
                {t('确认主密码', 'Confirm master password')}
                <input className="bs-input" name="confirmation" type="password" autoComplete="off" required />
              </label>
            ) : null}
            <div className="vault-actions">
              <button className="bs-btn is-primary" type="submit">
                {status.initialized ? t('解锁', 'Unlock') : t('创建密码库', 'Create vault')}
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}

      {/* 新增 / 编辑本地凭据表单 */}
      {localReady && editor ? (
        <form
          className="vault-form-card"
          onSubmit={event => {
            event.preventDefault();
            const form = event.currentTarget;
            const label = (form.elements.namedItem('label') as HTMLInputElement).value.trim();
            const username = (form.elements.namedItem('username') as HTMLInputElement).value.trim();
            const password = (form.elements.namedItem('password') as HTMLInputElement).value;
            if (revision === null) return;
            const allowedBotIds = (editing?.allowedBotIds ?? []).filter(id => id !== botId);
            if (allowed) allowedBotIds.push(botId);
            void execute({
              action: 'save',
              expectedRevision: revision,
              item: {
                ...(editing ? { secretRef: editing.secretRef } : {}),
                label,
                username,
                ...(password ? { password } : {}),
                allowedBotIds,
              },
            });
          }}
        >
          <fieldset disabled={disabled}>
            <legend>{editing ? t('编辑凭据', 'Edit credential') : t('新增凭据并授权', 'Add credential & authorize')}</legend>
            <label>
              {t('名称（例如 GitHub、内部后台）', 'Label')}
              <input className="bs-input" name="label" defaultValue={editing?.label ?? ''} required />
            </label>
            <label>
              {t('用户名（可选）', 'Username (optional)')}
              <input className="bs-input" name="username" defaultValue={editing?.username ?? ''} />
            </label>
            <label>
              {editing ? t('密码（留空保持不变）', 'Password (leave blank to keep current)') : t('密码 / Token', 'Password / Token')}
              <input className="bs-input" name="password" type="password" autoComplete="off" required={!editing} />
            </label>
            <div className="vault-permission">
              <span>{t('允许本智能体使用', 'Allow this Bot to use')}</span>
              <Switch checked={allowed} label={t('允许本智能体使用', 'Allow this Bot to use')} disabled={disabled} onChange={setAllowed} />
            </div>

            <div className="vault-actions">
              <button className="bs-btn is-primary is-small" type="submit" disabled={disabled || revision === null}>
                {editing ? t('保存修改', 'Save') : t('保存并授权', 'Save & authorize')}
              </button>
              <button className="bs-btn is-ghost is-small" type="button" onClick={() => setEditor(null)}>
                {t('取消', 'Cancel')}
              </button>
              {editing ? (
                <button
                  className="bs-btn is-danger is-small"
                  type="button"
                  disabled={disabled}
                  onClick={() => setDeleting(editing.secretRef)}
                >
                  {t('删除条目', 'Delete entry')}
                </button>
              ) : null}
            </div>

            {editing && deleting === editing.secretRef ? (
              <div className="vault-delete-confirm">
                <p className="vault-hint">
                  {t('删除后此 Host 上所有智能体都将无法再使用该凭据，确认删除？', 'Deleting removes this entry for all Bots on this Host. Confirm?')}
                </p>
                <div className="vault-actions">
                  <button
                    className="bs-btn is-danger is-small"
                    type="button"
                    disabled={disabled || revision === null}
                    onClick={() => {
                      if (revision !== null) {
                        void execute({ action: 'delete', expectedRevision: revision, secretRef: editing.secretRef });
                      }
                    }}
                  >
                    {t('确认删除', 'Confirm delete')}
                  </button>
                  <button className="bs-btn is-ghost is-small" type="button" onClick={() => setDeleting(null)}>
                    {t('取消', 'Cancel')}
                  </button>
                </div>
              </div>
            ) : null}
          </fieldset>
        </form>
      ) : null}

      {/* 本地密码库凭据列表（零闪烁单行授权） */}
      {localReady ? (
        items.length === 0 ? (
          <p className="vault-hint">
            {t('当前暂无凭据，点击右上角「+ 新增凭据并授权」添加第一条。', 'No credentials yet. Click "+ Add & authorize" above to add one.')}
          </p>
        ) : (
          <ul className="vault-items">
            {items.map(item => {
              const isAllowed = item.allowedBotIds.includes(botId);
              return (
                <li key={item.secretRef}>
                  <div className="vault-permission">
                    <div>
                      <strong>{item.label}</strong>
                      {item.username ? <p className="vault-hint">{item.username}</p> : null}
                    </div>
                    <div className="vault-switch-wrap">
                      <button
                        className="bs-btn is-ghost is-small"
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          clearForms();
                          setEditor(item);
                          setAllowed(isAllowed);
                          setDeleting(null);
                        }}
                      >
                        {t('编辑', 'Edit')}
                      </button>
                      <Switch
                        checked={isAllowed}
                        label={`${t('允许本智能体使用', 'Allow this Bot')}: ${item.label}`}
                        disabled={disabled || revision === null || togglingRef === item.secretRef}
                        onChange={next => void toggleLocalGrant(item, next)}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {/* 底部全局密码库管理入口（外部跳转优先，否则折叠收纳） */}
      {onOpenGlobalVault ? (
        <div className="vault-footer-link">
          <button type="button" className="bs-link" onClick={onOpenGlobalVault}>
            {t('管理全局密码库服务 →', 'Manage global vault service →')}
            <ExternalLink aria-hidden="true" />
          </button>
        </div>
      ) : status ? (
        <Disclosure title={t('▸ 全局密码库服务管理', 'Global vault service settings')} defaultOpen={false}>
          {renderGlobalManagementBody()}
        </Disclosure>
      ) : null}
    </section>
  );
}
