import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { VaultUnlockPresentation } from '../../../host-core/index.js';
import type { VaultUnlockSubmitPayload } from '../ToolPresentation';
import { useText } from '../ui';
import '../tool-presentation.css';
import './VaultUnlockCard.css';

export interface VaultUnlockCardProps {
  presentation: VaultUnlockPresentation;
  active: boolean;
  disabled?: boolean;
  onSubmit?: (input: VaultUnlockSubmitPayload) => Promise<unknown>;
}

export function VaultUnlockCard(props: VaultUnlockCardProps) {
  const { presentation, active } = props;
  // The outer tool card keys Host/account scope; this key isolates each live request.
  const key = JSON.stringify([presentation.installationId, presentation.conversationId, presentation.requestId, presentation.mode, presentation.status, active, Boolean(props.onSubmit)]);
  return <VaultUnlockSession key={key} {...props} />;
}

function VaultUnlockSession({ presentation, active, disabled = false, onSubmit }: VaultUnlockCardProps) {
  const t = useText();
  const descriptionId = useId();
  const errorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [localStatus, setLocalStatus] = useState<'unlocked' | 'cancelled' | 'interrupted' | null>(null);
  const [error, setError] = useState('');

  // Secrets stay only in uncontrolled password inputs, never React state or chat drafts.
  useLayoutEffect(() => {
    mounted.current = true;
    const form = formRef.current;
    return () => {
      mounted.current = false;
      form?.reset();
    };
  }, []);

  useLayoutEffect(() => { formRef.current?.reset(); }, [disabled]);

  const status = presentation.status !== 'pending'
    ? presentation.status
    : localStatus ?? (active ? 'pending' : 'interrupted');
  const canRespond = status === 'pending' && Boolean(onSubmit);
  const editable = canRespond && !disabled && !submitting;
  const initializing = presentation.mode === 'initialize';

  function failure(code: unknown): string {
    switch (code) {
      case 'VAULT_UNLOCK_FAILED': return t('无法解锁密码库，请检查主密码后重新输入。', 'Could not unlock Vault. Check the master password and enter it again.');
      case 'VAULT_REQUEST_EXPIRED': return t('解锁请求已结束或过期，请发起新的请求。', 'This unlock request ended or expired. Start a new request.');
      case 'VAULT_REQUEST_BUSY': return t('该请求正在处理，请等待状态更新后再操作。', 'This request is being processed. Wait for a status update before trying again.');
      case 'VAULT_INVALID_ARGUMENT': return t('输入无效，请检查并重新输入主密码。', 'Invalid input. Check and re-enter the master password.');
      case 'VAULT_NOT_INITIALIZED': return t('密码库尚未创建，请发起新的解锁请求。', 'Vault is not initialized. Start a new unlock request.');
      case 'VAULT_ALREADY_INITIALIZED': return t('密码库已创建，请发起新的解锁请求。', 'Vault is already initialized. Start a new unlock request.');
      case 'VAULT_FORBIDDEN': return t('密码库访问未获授权，请检查 Bot 授权。', 'Vault access is not permitted. Review Bot permissions.');
      case 'NOT_CONNECTED':
      case 'OFFLINE':
      case 'CONTROL_UNAVAILABLE':
      case 'CENTER_OFFLINE': return t('目标 Host 离线，未排队或自动重试。', 'Target Host is offline. Nothing was queued or automatically retried.');
      case 'RUNTIME_BUSY': return t('Host 正在维护，请稍后再操作。', 'Host is busy with maintenance. Try again later.');
      default: return t('操作结果未确认，请等待状态更新；不会自动重试。', 'Operation unconfirmed. Wait for a status update; there is no automatic retry.');
    }
  }

  async function submit(input: VaultUnlockSubmitPayload) {
    formRef.current?.reset();
    if (!editable || !onSubmit || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const result = await onSubmit(input);
      if (!mounted.current) return;
      if (result && typeof result === 'object' &&
          'requestId' in result && result.requestId === presentation.requestId &&
          'status' in result && (result.status === 'unlocked' || result.status === 'cancelled')) {
        setLocalStatus(result.status);
      } else {
        setError(failure(undefined));
      }
    } catch (cause) {
      if (!mounted.current) return;
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
      if (code === 'VAULT_REQUEST_EXPIRED') setLocalStatus('interrupted');
      // Never render a transport exception or any text that could reflect the password.
      setError(failure(code));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  const statusLabel = status === 'unlocked'
    ? t('已完成解锁', 'Unlock completed')
    : status === 'cancelled'
      ? t('已取消', 'Cancelled')
      : status === 'interrupted'
        ? t('已中断 / 过期', 'Interrupted / expired')
        : submitting
          ? t('处理中…', 'Working…')
          : initializing ? t('等待创建', 'Awaiting setup') : t('等待解锁', 'Awaiting unlock');

  return (
    <section className={`tp-card tp-vault-unlock is-${status}`} aria-label={t('密码库解锁', 'Unlock Vault')} aria-busy={submitting}>
      <div className="tp-card-head">
        <span className="tp-card-title">{t('密码库', 'Password Vault')}</span>
        <span className={`tp-status-pill is-${status}`} role="status">{statusLabel}</span>
      </div>
      <p id={descriptionId} className="tp-vault-hint">{t('作用于当前 Host 的密码库；条目仍按各 Bot 的授权控制。主密码仅通过专用通道提交，不进入聊天。', 'Applies to this Host’s Vault; each Bot’s entry permissions still apply. The master password uses a private control channel, not chat.')}</p>
      {presentation.source === 'vaultwarden' ? (
        <p className="tp-vault-hint">{t('来源', 'Source')}: Vaultwarden{presentation.serverUrl ? ' · ' + presentation.serverUrl : ''}</p>
      ) : null}
      {canRespond ? (
        <form ref={formRef} className="tp-vault-form" autoComplete="off" noValidate onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const masterPassword = (form.elements.namedItem('masterPassword') as HTMLInputElement).value;
          const confirmation = (form.elements.namedItem('confirmation') as HTMLInputElement | null)?.value;
          form.reset();
          if (!editable || inFlight.current) return;
          if (!masterPassword || masterPassword.length > 1024) {
            setError(t('请输入 1–1024 个字符的主密码。', 'Enter a master password of 1–1024 characters.'));
            return;
          }
          if (initializing && masterPassword !== confirmation) {
            setError(t('两次主密码不一致，请重新输入。', 'Master passwords do not match. Enter them again.'));
            return;
          }
          void submit({ requestId: presentation.requestId, masterPassword });
        }}>
          <fieldset disabled={!editable}>
            <legend className="tp-vault-legend">{initializing ? t('设置主密码', 'Set a master password') : t('输入主密码', 'Enter the master password')}</legend>
            <label>
              {t('主密码', 'Master password')}
              <input className="tp-input" name="masterPassword" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={1024} aria-describedby={error ? `${descriptionId} ${errorId}` : descriptionId} onChange={() => setError('')} />
            </label>
            {initializing ? (
              <label>
                {t('确认主密码', 'Confirm master password')}
                <input className="tp-input" name="confirmation" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={1024} aria-describedby={error ? errorId : undefined} onChange={() => setError('')} />
              </label>
            ) : null}
            <div className="tp-actions">
              <button type="submit" className="tp-btn tp-btn-primary">{submitting ? t('处理中…', 'Working…') : initializing ? t('创建并解锁', 'Create and unlock') : t('解锁', 'Unlock')}</button>
              <button type="button" className="tp-btn" onClick={() => void submit({ requestId: presentation.requestId, cancelled: true })}>{t('取消', 'Cancel')}</button>
            </div>
          </fieldset>
          {disabled ? <p className="tp-vault-hint">{t('当前连接不可操作，请连接目标 Host 后重试。', 'Unavailable on this connection. Connect to the target Host before trying again.')}</p> : null}
        </form>
      ) : (
        <p className="tp-result-line">{status === 'unlocked'
          ? t('此请求已完成解锁，不代表密码库当前仍处于解锁状态。', 'This request completed an unlock. It does not mean Vault is still unlocked now.')
          : status === 'cancelled'
            ? t('此解锁请求已取消。', 'This unlock request was cancelled.')
            : status === 'interrupted'
              ? t('此解锁请求已中断或过期，不能从历史记录提交。请发起新的请求。', 'This unlock request was interrupted or expired. History cannot be submitted; start a new request.')
              : t('当前视图只读，无法提交主密码。', 'This view is read-only. The master password cannot be submitted here.')}</p>
      )}
      {error ? <div id={errorId} className="tp-error" role="alert">{error}</div> : null}
    </section>
  );
}
