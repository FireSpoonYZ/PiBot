// Private owner-channel Google Web OAuth Client configuration & system-browser OAuth sign-in flow.
// Security boundaries:
// - Client secrets live only in uncontrolled DOM inputs or transient File reads, never React state or chat.
// - Google OAuth always opens the system browser via openExternalUrl, never a Bot WebView.
// - Completion is verified strictly from Center /api/google/flow + /api/google/status, never chat text.
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, ExternalLink, Lock, RefreshCw, ShieldAlert, Upload } from 'lucide-react';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { useText } from '../ui';
import {
  cancelGoogleAuthFlow,
  classifyGoogleError,
  configureGoogleClient,
  fetchGoogleStatus,
  pollGoogleAuthFlow,
  startGoogleAuthorize,
} from './googleClient';
import {
  GOOGLE_SERVICE_CHOICES,
  googleChoiceDescription,
  googleChoiceLabel,
  googleFixLabel,
  googleReadinessFace,
  googleReadinessRows,
  maskClientId,
  validateWebClientJson,
} from './googleCopy';
import type {
  GoogleAccountView,
  GoogleAuthFlowStart,
  GoogleServiceChoice,
  GoogleStatusSnapshot,
} from './types';
import './google-ui.css';

/* ------------------------------------------------------------------ */
/* Private Web OAuth Client Configuration Form                         */
/* ------------------------------------------------------------------ */

export interface GoogleClientConfigFormProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  redirectUri?: string;
  configuredClientId?: string;
  onSaved: (snapshot: GoogleStatusSnapshot) => void;
  onCancel?: () => void;
  onOpenCenterAdmin?: () => void;
}

export function GoogleClientConfigForm({
  api,
  identity,
  redirectUri,
  configuredClientId,
  onSaved,
  onCancel,
  onOpenCenterAdmin,
}: GoogleClientConfigFormProps) {
  const t = useText();
  const idPrefix = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const [mode, setMode] = useState<'file' | 'manual'>('file');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [adminBlocked, setAdminBlocked] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);
  const [savedClientId, setSavedClientId] = useState<string | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const form = formRef.current;
    const fileInput = fileInputRef.current;
    return () => {
      mountedRef.current = false;
      form?.reset();
      if (fileInput) fileInput.value = '';
    };
  }, []);

  const effectiveRedirectUri =
    redirectUri || 'https://<your-center-domain>/api/oauth/google/callback';

  const copyRedirectUri = async () => {
    try {
      await navigator.clipboard.writeText(effectiveRedirectUri);
      setCopiedUri(true);
      window.setTimeout(() => {
        if (mountedRef.current) setCopiedUri(false);
      }, 2000);
    } catch {
      setError(t('无法复制到剪贴板，请手动选中复制。', 'Could not copy automatically. Please copy manually.'));
    }
  };

  const handleFailure = (cause: unknown) => {
    const info = classifyGoogleError(cause);
    if (info.adminRequired) {
      setAdminBlocked(true);
      setError(t('当前账号不是 Center 管理员，无法修改 Center Google OAuth 应用配置。请联系 Center 管理员完成一次性配置。', 'Center admin permission is required to configure the Google OAuth app. Contact your Center administrator.'));
      return;
    }
    if (info.offline) {
      setError(t('当前无法连接 Center，凭据未发送也未排队，请恢复连接后重试。', 'Center is offline. Nothing was sent or queued.'));
      return;
    }
    // Never reflect secret text back in error messages.
    setError(
      info.unavailable
        ? t('当前 Center 暂不支持 Google OAuth 配置接口，请升级或检查 Center 状态。', 'Google OAuth configuration endpoint is unavailable on this Center.')
        : t('保存 Center Google 应用凭据失败，请检查 Web Client ID / Secret 及回调地址后重试。', 'Could not save Google OAuth client. Verify your Web Client ID, Secret, and redirect URI.'),
    );
  };

  const handleFileChange = async (file: File | null) => {
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (!file || inFlightRef.current) return;
    setError('');
    setAdminBlocked(false);
    let text = '';
    try {
      text = await file.text();
    } catch {
      setError(t('无法读取所选文件。', 'Could not read the selected file.'));
      return;
    }
    const validation = validateWebClientJson(text, t);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const snapshot = await configureGoogleClient(api, identity, { clientFile: text });
      if (!mountedRef.current) return;
      setSavedClientId(snapshot.client.clientId ?? validation.clientId);
      onSaved(snapshot);
    } catch (cause) {
      if (!mountedRef.current) return;
      handleFailure(cause);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleManualSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const clientId = ((form.elements.namedItem('clientId') as HTMLInputElement | null)?.value ?? '').trim();
    const clientSecret = ((form.elements.namedItem('clientSecret') as HTMLInputElement | null)?.value ?? '').trim();
    // Immediately clear DOM inputs so secret never lingers in form fields.
    form.reset();
    if (inFlightRef.current) return;
    if (!clientId || !clientSecret) {
      setError(t('请填写完整的 Web Client ID 与 Client Secret。', 'Enter both Web Client ID and Client Secret.'));
      return;
    }
    setError('');
    setAdminBlocked(false);
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const snapshot = await configureGoogleClient(api, identity, { clientId, clientSecret });
      if (!mountedRef.current) return;
      setSavedClientId(snapshot.client.clientId ?? clientId);
      onSaved(snapshot);
    } catch (cause) {
      if (!mountedRef.current) return;
      handleFailure(cause);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  if (savedClientId) {
    return (
      <div className="gws-private-box is-success" role="status">
        <div className="gws-private-head">
          <Lock size={15} aria-hidden="true" />
          <span>{t('Center Google 应用已加密保存', 'Center Google app encrypted & saved')}</span>
        </div>
        <p className="gws-muted">
          {t(`Web Client ID：${maskClientId(savedClientId)} · 已就绪。出于安全原因，Client Secret 不再回显，也不支持导出共享。`, `Web Client ID: ${maskClientId(savedClientId)} · Ready. For security, Client Secret is never shown again and cannot be exported.`)}
        </p>
      </div>
    );
  }

  return (
    <div className="gws-private-box" aria-busy={submitting}>
      <div className="gws-private-head">
        <Lock size={15} aria-hidden="true" />
        <span>{t('私密录入 Center Web OAuth 凭据', 'Private Center Web OAuth Configuration')}</span>
      </div>
      <p className="gws-muted">
        {t('凭据通过独立可信通道直传 Center 加密保存，不进入聊天记录或模型上下文；保存后永不回显或导出 Client Secret。', 'Submitted directly to Center over the trusted owner channel — never enters chat or model context, and never exported.')}
      </p>

      {configuredClientId ? (
        <p className="gws-hint-line">
          {t(`当前已配置：${maskClientId(configuredClientId)}（提交新凭据将轮换更新）`, `Currently configured: ${maskClientId(configuredClientId)} (submitting replaces it)`)}
        </p>
      ) : null}

      <div className="gws-uri-row">
        <div className="gws-uri-text">
          <span className="gws-label-xs">{t('已授权的重定向 URI（Web application）', 'Authorized redirect URI (Web application)')}</span>
          <code className="gws-code">{effectiveRedirectUri}</code>
        </div>
        <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void copyRedirectUri()}>
          {copiedUri ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span>{copiedUri ? t('已复制', 'Copied') : t('复制', 'Copy')}</span>
        </button>
      </div>

      <div className="gws-seg" role="tablist" aria-label={t('录入方式', 'Input method')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'file'}
          className={`gws-seg-btn${mode === 'file' ? ' is-active' : ''}`}
          disabled={submitting}
          onClick={() => { setMode('file'); setError(''); }}
        >
          {t('上传 JSON 文件', 'Upload JSON file')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'manual'}
          className={`gws-seg-btn${mode === 'manual' ? ' is-active' : ''}`}
          disabled={submitting}
          onClick={() => { setMode('manual'); setError(''); }}
        >
          {t('粘贴 Client ID / Secret', 'Paste Client ID & Secret')}
        </button>
      </div>

      {mode === 'file' ? (
        <div className="gws-upload-area">
          <input
            ref={fileInputRef}
            id={`${idPrefix}-file`}
            type="file"
            accept=".json,application/json"
            className="gws-sr-only"
            disabled={submitting}
            onChange={e => void handleFileChange(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className="gws-btn is-primary"
            disabled={submitting}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={15} aria-hidden="true" />
            <span>
              {submitting
                ? t('加密保存中…', 'Encrypting & saving…')
                : t('选择 client_secret_*.json 文件', 'Choose client_secret_*.json')}
            </span>
          </button>
          <span className="gws-muted">
            {t('仅接受 Web application 类型的 Google OAuth JSON（≤ 64 KiB）。', 'Requires a “Web application” Google OAuth JSON file (≤ 64 KiB).')}
          </span>
        </div>
      ) : (
        <form ref={formRef} className="gws-form" autoComplete="off" noValidate onSubmit={e => void handleManualSubmit(e)}>
          <label className="gws-field" htmlFor={`${idPrefix}-cid`}>
            <span className="gws-label">{t('Web Client ID', 'Web Client ID')}</span>
            <input
              id={`${idPrefix}-cid`}
              name="clientId"
              type="text"
              className="gws-input"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              placeholder="1234567890-xxxx.apps.googleusercontent.com"
              onChange={() => setError('')}
            />
          </label>
          <label className="gws-field" htmlFor={`${idPrefix}-csec`}>
            <span className="gws-label">{t('Web Client Secret', 'Web Client Secret')}</span>
            <input
              id={`${idPrefix}-csec`}
              name="clientSecret"
              type="password"
              className="gws-input"
              autoComplete="new-password"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              placeholder="GOCSPX-…"
              onChange={() => setError('')}
            />
          </label>
          <div className="gws-actions">
            <button type="submit" className="gws-btn is-primary" disabled={submitting}>
              {submitting ? t('加密保存中…', 'Encrypting & saving…') : t('加密保存到 Center', 'Encrypt & save to Center')}
            </button>
            {onCancel ? (
              <button type="button" className="gws-btn is-ghost" disabled={submitting} onClick={onCancel}>
                {t('取消', 'Cancel')}
              </button>
            ) : null}
          </div>
        </form>
      )}

      {mode === 'file' && onCancel ? (
        <div className="gws-actions">
          <button type="button" className="gws-btn is-ghost is-sm" disabled={submitting} onClick={onCancel}>
            {t('取消', 'Cancel')}
          </button>
        </div>
      ) : null}

      {error ? (
        <div className="gws-error" role="alert">
          <ShieldAlert size={15} aria-hidden="true" />
          <div className="gws-error-body">
            <span>{error}</span>
            {adminBlocked && onOpenCenterAdmin ? (
              <button type="button" className="gws-link-btn" onClick={onOpenCenterAdmin}>
                {t('前往中心管理页查看 →', 'Open Center Admin →')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* System-Browser OAuth Sign-In & Scope Expansion Flow                 */
/* ------------------------------------------------------------------ */

export interface GoogleSignInFlowProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  /** Pre-selected choices (for initial connect or adding/expanding services — Center uses union). */
  initialChoices?: GoogleServiceChoice[];
  /** Services already chosen in the setup wizard; show them without a second picker. */
  setupChoices?: GoogleServiceChoice[];
  /** Target account email when reconnecting or expanding permissions on an existing account. */
  targetAccount?: string;
  /** Existing choices on targetAccount so scope expansion always requests the union. */
  existingChoices?: GoogleServiceChoice[];
  mode?: 'connect' | 'expand' | 'reconnect';
  onCompleted: (account: GoogleAccountView | undefined, snapshot: GoogleStatusSnapshot | null) => void;
  onCancel?: () => void;
}

function formatCountdown(expiresAt: string | number | undefined, nowMs: number): string {
  if (!expiresAt) return '';
  const target = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(target)) return '';
  const diffSec = Math.max(0, Math.floor((target - nowMs) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function GoogleSignInFlow({
  api,
  identity,
  initialChoices,
  setupChoices,
  targetAccount,
  existingChoices,
  mode = 'connect',
  onCompleted,
  onCancel,
}: GoogleSignInFlowProps) {
  const t = useText();
  const mountedRef = useRef(true);
  const pollingRef = useRef<{ check: () => void; stop: () => void } | null>(null);
  const onCompletedRef = useRef(onCompleted);

  useLayoutEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  const [selectedDraft, setSelected] = useState<GoogleServiceChoice[]>(() => {
    const base = new Set<GoogleServiceChoice>(existingChoices ?? []);
    for (const c of initialChoices ?? []) base.add(c);
    if (base.size === 0) {
      base.add('gmail');
      base.add('calendar');
    }
    return GOOGLE_SERVICE_CHOICES.filter(c => base.has(c));
  });
  const confirmedChoices = GOOGLE_SERVICE_CHOICES.filter(choice => mode === 'connect' && setupChoices?.includes(choice));
  const hasConfirmedChoices = confirmedChoices.length > 0;
  const selected = hasConfirmedChoices ? confirmedChoices : selectedDraft;

  const [starting, setStarting] = useState(false);
  const [flow, setFlow] = useState<GoogleAuthFlowStart | null>(null);
  const [phase, setPhase] = useState<'pick' | 'pending' | 'connected' | 'failed' | 'cancelled'>('pick');
  const [connectedAccount, setConnectedAccount] = useState<GoogleAccountView | null>(null);
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pollingRef.current?.stop();
    };
  }, []);

  // Countdown tick while waiting for system browser OAuth.
  useEffect(() => {
    if (phase !== 'pending' || !flow) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase, flow]);

  // Poll Center /api/google/flow while pending.
  useEffect(() => {
    if (phase !== 'pending' || !flow) return;
    let stopped = false;
    let inFlight = false;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const stop = () => {
      stopped = true;
      clearTimer();
      if (pollingRef.current?.stop === stop) pollingRef.current = null;
    };

    const tick = async () => {
      if (stopped || !mountedRef.current || inFlight) return;
      clearTimer();
      inFlight = true;
      try {
        const res = await pollGoogleAuthFlow(api, identity, flow.flowId);
        if (stopped || !mountedRef.current) return;
        if (res.phase === 'pending') {
          timer = window.setTimeout(() => void tick(), 1800);
          return;
        }
        if (res.phase === 'connected') {
          const snapshot = await fetchGoogleStatus(api, identity).catch(() => null);
          if (stopped || !mountedRef.current) return;
          stop();
          const verifiedAccount =
            res.account ??
            snapshot?.accounts.find(a => (targetAccount ? a.email === targetAccount : true));
          setConnectedAccount(verifiedAccount ?? null);
          setPhase('connected');
          onCompletedRef.current(verifiedAccount, snapshot);
          return;
        }
        stop();
        if (res.phase === 'cancelled') {
          setPhase('cancelled');
          setFlow(null);
          return;
        }
        setPhase('failed');
        setError(res.error || t('此次授权未完成或已过期，原有连接不受影响。', 'Authorization did not complete or expired. Existing connections are unchanged.'));
        setFlow(null);
      } catch (cause) {
        if (stopped || !mountedRef.current) return;
        const info = classifyGoogleError(cause);
        if (info.tempError || info.offline) {
          // Transient polling drop: keep polling without marking revoked/failed immediately.
          timer = window.setTimeout(() => void tick(), 3000);
          return;
        }
        stop();
        setPhase('failed');
        setError(info.message);
        setFlow(null);
      } finally {
        inFlight = false;
      }
    };

    pollingRef.current = { check: () => void tick(), stop };
    const onReturn = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);

    timer = window.setTimeout(() => void tick(), 1500);
    return () => {
      stop();
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [api, identity, flow, phase, targetAccount, t]);

  const toggleChoice = (choice: GoogleServiceChoice) => {
    setSelected(prev => {
      // In expand mode, keep previously granted choices selected so Center requests union scopes.
      if (mode === 'expand' && existingChoices?.includes(choice)) return prev;
      if (prev.includes(choice)) {
        return prev.filter(item => item !== choice);
      }
      return GOOGLE_SERVICE_CHOICES.filter(c => prev.includes(c) || c === choice);
    });
  };

  const beginSignIn = async (overrideChoices?: GoogleServiceChoice[]) => {
    const union = new Set<GoogleServiceChoice>(overrideChoices ?? selected);
    if (existingChoices) {
      for (const c of existingChoices) union.add(c);
    }
    const choices = GOOGLE_SERVICE_CHOICES.filter(c => union.has(c));
    if (choices.length === 0) {
      setError(t('请至少选择一个要连接的服务组。', 'Select at least one service group.'));
      return;
    }
    setError('');
    setStarting(true);
    try {
      const started = await startGoogleAuthorize(api, identity, {
        choices,
        ...(targetAccount ? { account: targetAccount } : {}),
      });
      if (!mountedRef.current) return;
      setFlow(started);
      setPhase('pending');
      setNowMs(Date.now());
      // Always launch system browser (never Bot WebView).
      await openExternalUrl(started.authorizationUrl);
    } catch (cause) {
      if (!mountedRef.current) return;
      const info = classifyGoogleError(cause);
      setError(
        info.offline
          ? t('当前无法连接 Center，请恢复连接后再试。', 'Center is offline. Try again when connected.')
          : info.message,
      );
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  };

  const handleCancelFlow = async () => {
    pollingRef.current?.stop();
    const currentFlow = flow;
    setFlow(null);
    setPhase('cancelled');
    if (currentFlow) {
      await cancelGoogleAuthFlow(api, identity, currentFlow.flowId).catch(() => {});
    }
  };

  if (phase === 'pending' && flow) {
    const remaining = formatCountdown(flow.expiresAt, nowMs);
    return (
      <div className="gws-private-box is-pending" role="status">
        <div className="gws-private-head">
          <RefreshCw size={15} className="gws-spin" aria-hidden="true" />
          <span>{t('等待系统浏览器完成 Google 授权', 'Waiting for Google sign-in in system browser')}</span>
        </div>
        <p className="gws-muted">
          {t(`请在刚打开的系统浏览器中完成 Google 登录、MFA 与授权同意${remaining ? `（剩余 ${remaining}）` : ''}。完成后会自动回流核验，无需复制回调地址到聊天。`, `Complete Google sign-in, MFA, and consent in your system browser${remaining ? ` (${remaining} left)` : ''}. Center verifies the callback automatically — never paste callbacks into chat.`)}
        </p>
        <div className="gws-actions">
          <button
            type="button"
            className="gws-btn is-primary is-sm"
            onClick={() => void openExternalUrl(flow.authorizationUrl)}
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span>{t('重新打开浏览器', 'Re-open browser')}</span>
          </button>
          <button
            type="button"
            className="gws-btn is-ghost is-sm"
            onClick={() => pollingRef.current?.check()}
          >
            <RefreshCw size={14} aria-hidden="true" />
            <span>{t('重新检查', 'Check again')}</span>
          </button>
          <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void handleCancelFlow()}>
            {t('取消', 'Cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'connected' && connectedAccount) {
    const rows = googleReadinessRows(connectedAccount, t);
    const missingChoices = rows
      .filter(r => r.readiness.state === 'needs-permission' && r.choice)
      .map(r => r.choice as GoogleServiceChoice);
    const readyNames = rows.filter(r => r.readiness.state === 'ready').map(r => r.label);

    return (
      <div className="gws-private-box is-success" role="status">
        <div className="gws-private-head">
          <Check size={15} aria-hidden="true" />
          <span>
            {t(`已连接 ${connectedAccount.email} · 所有 Bot 可用`, `Connected ${connectedAccount.email} · Available to all Bots`)}
          </span>
        </div>
        {readyNames.length > 0 ? (
          <p className="gws-muted">
            {t(`已就绪服务：${readyNames.join('、')}`, `Ready: ${readyNames.join(', ')}`)}
          </p>
        ) : null}
        <div className="gws-readiness-list">
          {rows.map(row => {
            const face = googleReadinessFace(row.readiness, t);
            return (
              <div key={row.key} className="gws-readiness-row">
                <span className="gws-readiness-name">{row.label}</span>
                <span className={`gws-pill is-${face.tone}`}>{face.label}</span>
                {face.fix === 'allow-again' && row.choice ? (
                  <button
                    type="button"
                    className="gws-btn is-ghost is-xs"
                    onClick={() => void beginSignIn([...selected, row.choice!])}
                  >
                    {googleFixLabel('allow-again', t)}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {missingChoices.length > 0 ? (
          <p className="gws-muted">
            {t('未勾选的服务已保持「未授权」状态，你可以现在补授权，或暂不使用此项。', 'Unchecked services remain “Needs permission”. You can grant permission now or skip them.')}
          </p>
        ) : null}
        {onCancel ? (
          <div className="gws-actions">
            <button type="button" className="gws-btn is-ghost is-sm" onClick={onCancel}>
              {t('完成', 'Done')}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const title =
    mode === 'reconnect'
      ? t(`重新连接 ${targetAccount ?? 'Google 账号'}`, `Reconnect ${targetAccount ?? 'Google account'}`)
      : mode === 'expand'
        ? t('管理服务 / 添加服务', 'Add or grant Google services')
        : hasConfirmedChoices
          ? t('连接 Google 账号', 'Connect Google account')
          : t('选择要连接的服务', 'Choose services to connect');

  const ctaLabel =
    mode === 'reconnect'
      ? t('在系统浏览器重新登录 Google', 'Reconnect in system browser')
      : mode === 'expand'
        ? t('前往 Google 补充授权', 'Grant additional permissions')
        : t('前往 Google 登录', 'Sign in to Google');

  return (
    <div className="gws-private-box">
      <div className="gws-private-head">
        <Lock size={15} aria-hidden="true" />
        <span>{title}</span>
      </div>

      {hasConfirmedChoices ? (
        <p className="gws-muted">
          {t('本次申请授权：', 'Requested services: ')}
          {confirmedChoices.map(choice => googleChoiceLabel(choice, t)).join(t('、', ', '))}
        </p>
      ) : (
        <div className="gws-choice-grid" role="group" aria-label={t('Google 服务组', 'Google service groups')}>
          {GOOGLE_SERVICE_CHOICES.map(choice => {
            const checked = selected.includes(choice);
            const lockedExisting = mode === 'expand' && Boolean(existingChoices?.includes(choice));
            return (
              <label
                key={choice}
                className={`gws-choice-card${checked ? ' is-selected' : ''}${lockedExisting ? ' is-locked' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={starting || lockedExisting}
                  onChange={() => toggleChoice(choice)}
                />
                <span className="gws-choice-body">
                  <span className="gws-choice-title">
                    {googleChoiceLabel(choice, t)}
                    {lockedExisting ? <span className="gws-pill is-muted">{t('已包含', 'Included')}</span> : null}
                  </span>
                  <span className="gws-choice-desc">{googleChoiceDescription(choice, t)}</span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      <p className="gws-base-scope-note">
        {t('基础附带（不可单独取消）：账号识别与联系人联查（People API，用于按姓名查找联系人，将独立探测就绪度）。', 'Base included (always requested): Account identity & People API contacts lookup (probed independently).')}
      </p>

      <p className="gws-share-disclosure">
        {t('连接后，本中心现在和以后创建的所有 Bot 都能以你的身份使用你同意的 Google 服务；能向这些 Bot 发起任务的人也可能通过它们访问数据。', 'Once connected, all current and future Bots in this Center can use the services you approve; anyone allowed to message those Bots may access that data through them.')}
      </p>

      {phase === 'cancelled' ? (
        <p className="gws-muted" role="status">
          {t('已取消此次授权，未新增或改动已有连接。', 'Authorization cancelled. No connections were changed.')}
        </p>
      ) : null}

      {error ? (
        <div className="gws-error" role="alert">
          <ShieldAlert size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="gws-actions">
        <button
          type="button"
          className="gws-btn is-primary"
          disabled={starting || selected.length === 0}
          onClick={() => void beginSignIn()}
        >
          <ExternalLink size={15} aria-hidden="true" />
          <span>{starting ? t('正在拉起系统浏览器…', 'Opening system browser…') : ctaLabel}</span>
        </button>
        {onCancel ? (
          <button type="button" className="gws-btn is-ghost" disabled={starting} onClick={onCancel}>
            {t('取消', 'Cancel')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
