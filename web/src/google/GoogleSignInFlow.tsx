// Private owner-channel Google Web OAuth Client configuration & system-browser OAuth sign-in flow.
// Security boundaries:
// - Client secrets live only in uncontrolled DOM inputs or transient File reads, never React state or chat.
// - Google OAuth always opens the system browser via openExternalUrl, never a Bot WebView.
// - Completion is verified strictly from Center /api/google/flow + /api/google/status, never chat text.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bot, Check, Copy, ExternalLink, Lock, RefreshCw, Upload } from 'lucide-react';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import {
  DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES,
  DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES,
  buildGoogleAssistantSetupPayload,
  defaultDigestTimesForMode,
  formatDigestTimesInput,
  pickDefaultAssistantDeviceId,
  pickDefaultExistingAssistantBot,
  shouldPromptGoogleAssistantSetup,
} from '../center-admin/googleHelpers';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { InlineBanner } from '../components/ui';
import { useText } from '../ui';
import {
  cancelGoogleAuthFlow,
  classifyGoogleError,
  configureGoogleClient,
  fetchGoogleAssistant,
  fetchGoogleBotSync,
  fetchGoogleStatus,
  pollGoogleAuthFlow,
  setupGoogleAssistant,
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
  GoogleAssistantMode,
  GoogleAuthFlowStart,
  GoogleBotSyncBot,
  GoogleBotSyncDevice,
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
  const fileTabRef = useRef<HTMLButtonElement>(null);
  const manualTabRef = useRef<HTMLButtonElement>(null);
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

  const handleContainerKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !submitting && onCancel) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const nextMode = mode === 'file' ? 'manual' : 'file';
      setMode(nextMode);
      setError('');
      (nextMode === 'file' ? fileTabRef : manualTabRef).current?.focus();
    }
  };

  const fileTabId = `${idPrefix}-tab-file`;
  const manualTabId = `${idPrefix}-tab-manual`;
  const filePanelId = `${idPrefix}-panel-file`;
  const manualPanelId = `${idPrefix}-panel-manual`;
  const errorId = `${idPrefix}-error`;

  return (
    <div className="gws-private-box" aria-busy={submitting} onKeyDown={handleContainerKeyDown}>
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
          <span className="gws-label-xs">{t('已授权的重定向 URI', 'Authorized redirect URI')}</span>
          <code className="gws-code">{effectiveRedirectUri}</code>
        </div>
        <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void copyRedirectUri()}>
          {copiedUri ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span>{copiedUri ? t('已复制', 'Copied') : t('复制', 'Copy')}</span>
        </button>
      </div>

      <div className="gws-seg" role="tablist" aria-label={t('录入方式', 'Input method')}>
        <button
          ref={fileTabRef}
          id={fileTabId}
          type="button"
          role="tab"
          aria-selected={mode === 'file'}
          aria-controls={filePanelId}
          tabIndex={mode === 'file' ? 0 : -1}
          className={`gws-seg-btn${mode === 'file' ? ' is-active' : ''}`}
          disabled={submitting}
          onClick={() => { setMode('file'); setError(''); }}
          onKeyDown={handleTabKeyDown}
        >
          {t('上传 JSON 文件', 'Upload JSON file')}
        </button>
        <button
          ref={manualTabRef}
          id={manualTabId}
          type="button"
          role="tab"
          aria-selected={mode === 'manual'}
          aria-controls={manualPanelId}
          tabIndex={mode === 'manual' ? 0 : -1}
          className={`gws-seg-btn${mode === 'manual' ? ' is-active' : ''}`}
          disabled={submitting}
          onClick={() => { setMode('manual'); setError(''); }}
          onKeyDown={handleTabKeyDown}
        >
          {t('粘贴 Client ID / Secret', 'Paste Client ID & Secret')}
        </button>
      </div>

      {mode === 'file' ? (
        <div id={filePanelId} role="tabpanel" aria-labelledby={fileTabId} className="gws-upload-area">
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
        <div id={manualPanelId} role="tabpanel" aria-labelledby={manualTabId}>
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
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? errorId : undefined}
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
                aria-invalid={Boolean(error) || undefined}
                aria-describedby={error ? errorId : undefined}
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
        </div>
      )}

      {mode === 'file' && onCancel ? (
        <div className="gws-actions">
          <button type="button" className="gws-btn is-ghost is-sm" disabled={submitting} onClick={onCancel}>
            {t('取消', 'Cancel')}
          </button>
        </div>
      ) : null}

      {error ? (
        <div id={errorId} className="gws-banner-wrap">
          <InlineBanner
            tone="danger"
            role="alert"
            compact
            title={error}
            actions={
              adminBlocked && onOpenCenterAdmin ? (
                <button type="button" className="gws-link-btn" onClick={onOpenCenterAdmin}>
                  {t('前往中心管理页查看', 'Open Center Admin')}
                </button>
              ) : undefined
            }
          />
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
  const tRef = useRef(t);
  tRef.current = t;

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
  const [connectedAccounts, setConnectedAccounts] = useState<GoogleAccountView[]>([]);
  const connectedAccountsRef = useRef<GoogleAccountView[]>(connectedAccounts);
  connectedAccountsRef.current = connectedAccounts;
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Post-OAuth proactive assistant quick-choice state (silently hidden on older Centers)
  const assistantIdPrefix = useId();
  const [assistantProbe, setAssistantProbe] = useState<'idle' | 'loading' | 'prompt' | 'hidden'>('idle');
  const [assistantDismissed, setAssistantDismissed] = useState(false);
  const [assistantMode, setAssistantMode] = useState<GoogleAssistantMode>('dedicated');
  const [assistantDevices, setAssistantDevices] = useState<GoogleBotSyncDevice[]>([]);
  const [assistantBots, setAssistantBots] = useState<GoogleBotSyncBot[]>([]);
  const [assistantDeviceId, setAssistantDeviceId] = useState(identity.targetDeviceId);
  const [assistantBotName, setAssistantBotName] = useState(() =>
    t('邮件与日程管家', 'Mail & Calendar Assistant'),
  );
  const [assistantTargetBotKey, setAssistantTargetBotKey] = useState('');
  const [assistantDigestTimes, setAssistantDigestTimes] = useState('');
  const [assistantDigestDirty, setAssistantDigestDirty] = useState(false);
  const [assistantHindsight, setAssistantHindsight] = useState(true);
  const [assistantHindsightDirty, setAssistantHindsightDirty] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState('');
  const [assistantEnabledSummary, setAssistantEnabledSummary] = useState('');

  const activeAssistantBots = useMemo(
    () => assistantBots.filter(b => !b.archivedAt),
    [assistantBots],
  );
  const assistantDeviceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of assistantDevices) map.set(d.deviceId, d.name || d.deviceId);
    return map;
  }, [assistantDevices]);

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
          const resolvedAccounts =
            snapshot?.accounts && snapshot.accounts.length > 0
              ? snapshot.accounts
              : verifiedAccount
                ? [verifiedAccount]
                : [];
          setConnectedAccounts(resolvedAccounts);
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

  // Best-effort probe for proactive assistant right after OAuth finishes; 404/error hides card silently.
  useEffect(() => {
    if (phase !== 'connected' || !connectedAccount) return;
    let cancelled = false;
    setAssistantProbe('loading');
    setAssistantDismissed(false);
    setAssistantError('');
    setAssistantEnabledSummary('');

    void Promise.all([
      fetchGoogleAssistant(api, identity),
      fetchGoogleBotSync(api, identity).catch(() => ({ devices: [] as GoogleBotSyncDevice[], bots: [] as GoogleBotSyncBot[] })),
    ])
      .then(([assistantRes, syncRes]) => {
        if (cancelled || !mountedRef.current) return;
        const accountCount = connectedAccountsRef.current.length > 0 ? connectedAccountsRef.current.length : 1;
        if (!shouldPromptGoogleAssistantSetup(assistantRes.assistant, accountCount)) {
          setAssistantProbe('hidden');
          return;
        }
        setAssistantDevices(syncRes.devices);
        setAssistantBots(syncRes.bots);
        const defaultDev = pickDefaultAssistantDeviceId(syncRes.devices, identity.targetDeviceId);
        const defaultBot = pickDefaultExistingAssistantBot(
          syncRes.bots,
          syncRes.devices,
          identity.targetDeviceId,
        );
        setAssistantMode('dedicated');
        setAssistantDeviceId(defaultDev || identity.targetDeviceId);
        const translate = tRef.current;
        const t = translate;
        setAssistantBotName(t('邮件与日程管家', 'Mail & Calendar Assistant'));
        setAssistantTargetBotKey(defaultBot ? `${defaultBot.deviceId}::${defaultBot.botId}` : '');
        setAssistantDigestTimes(formatDigestTimesInput(defaultDigestTimesForMode('dedicated')));
        setAssistantDigestDirty(false);
        setAssistantHindsight(true);
        setAssistantHindsightDirty(false);
        setAssistantProbe('prompt');
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) {
          setAssistantProbe('hidden');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, connectedAccount, identity, phase]);

  const handleSelectQuickAssistantMode = (nextMode: GoogleAssistantMode) => {
    setAssistantMode(nextMode);
    setAssistantError('');
    if (!assistantDigestDirty) {
      setAssistantDigestTimes(formatDigestTimesInput(defaultDigestTimesForMode(nextMode)));
    }
    if (!assistantHindsightDirty) {
      setAssistantHindsight(nextMode === 'dedicated');
    }
  };

  const handleEnableQuickAssistant = async () => {
    if (assistantBusy || !connectedAccount) return;
    setAssistantError('');

    let resolvedDeviceId = assistantDeviceId || identity.targetDeviceId;
    let resolvedBotId = '';
    if (assistantMode === 'existing') {
      const sep = assistantTargetBotKey.indexOf('::');
      if (sep > 0) {
        resolvedDeviceId = assistantTargetBotKey.slice(0, sep);
        resolvedBotId = assistantTargetBotKey.slice(sep + 2);
      } else {
        resolvedDeviceId = '';
        resolvedBotId = '';
      }
    }

    const watchedEmails =
      connectedAccounts.length > 0
        ? connectedAccounts.filter(a => a.status !== 'reconnect').map(a => a.email)
        : [connectedAccount.email];
    const effectiveAccounts = watchedEmails.length > 0 ? watchedEmails : [connectedAccount.email];

    const built = buildGoogleAssistantSetupPayload(
      {
        mode: assistantMode,
        deviceId: resolvedDeviceId,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        ...(assistantMode === 'dedicated' ? { role: assistantBotName } : {}),
        accounts: effectiveAccounts,
        batchWindowMinutes: DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES,
        digestTimesInput: assistantDigestTimes,
        calendarEnabled: true,
        calendarLeadMinutes: DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES,
        hindsightPrivateMemory: assistantHindsight,
      },
      t,
    );

    if (!built.ok) {
      setAssistantError(built.error);
      return;
    }

    setAssistantBusy(true);
    try {
      const res = await setupGoogleAssistant(api, identity, built.payload);
      if (!mountedRef.current) return;
      const createdName = res.createdBot?.role;
      setAssistantEnabledSummary(
        createdName
          ? t(`已创建独立专职管家 Bot「${createdName}」并启用主动邮箱与日程感知。`, `Created dedicated assistant Bot "${createdName}" and enabled proactive mail & calendar monitoring.`)
          : t('已为所选 Bot 启用主动邮箱与日程感知，可在中心管理页随时调整设置。', 'Proactive mail & calendar assistant enabled. You can adjust settings anytime in Center Admin.'),
      );
      setAssistantProbe('hidden');
    } catch (cause) {
      if (!mountedRef.current) return;
      const info = classifyGoogleError(cause);
      setAssistantError(
        info.unavailable
          ? t('当前 Center 版本暂不支持主动邮箱与日程管家。', 'This Center version does not support the proactive assistant yet.')
          : info.message || t('启用主动管家失败，请稍后重试。', 'Failed to enable proactive assistant. Please try again.'),
      );
    } finally {
      if (mountedRef.current) setAssistantBusy(false);
    }
  };

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

        {assistantEnabledSummary ? (
          <InlineBanner tone="live" role="status" compact title={assistantEnabledSummary} />
        ) : assistantProbe === 'prompt' && !assistantDismissed ? (
          <div className="gws-card" aria-busy={assistantBusy}>
            <div className="gws-private-head">
              <Bot size={15} aria-hidden="true" />
              <span>{t('开启主动邮箱与日程管家？', 'Enable Proactive Mail & Calendar Assistant?')}</span>
            </div>
            <p className="gws-muted">
              {t('可选择创建独立专职管家或交给已有 Bot 后台聚合新邮件与会前提醒，后台仅读信与草拟回复、绝不自动外发。', 'Batch incoming mail and pre-meeting reminders with a dedicated assistant Bot or an existing Bot. Background runs read & draft only, never auto-send.')}
            </p>

            <div className="gws-mode-list" role="radiogroup" aria-label={t('选择主动管家模式', 'Choose proactive assistant mode')}>
              <button
                type="button"
                role="radio"
                aria-checked={assistantMode === 'dedicated'}
                disabled={assistantBusy}
                className={`gws-mode-option${assistantMode === 'dedicated' ? ' is-selected' : ''}`}
                onClick={() => handleSelectQuickAssistantMode('dedicated')}
              >
                <span className="gws-mode-title">
                  <span>{t('选项 1：创建独立专职管家 Bot', 'Option 1: Create Dedicated Assistant Bot')}</span>
                  <span className="gws-pill is-accent">{t('推荐', 'Recommended')}</span>
                </span>
                <span className="gws-mode-desc">
                  {t('独立会话与私人记忆，不打扰主 Bot，后台仅读信与草拟回复。', 'Isolated session & private memory without crowding your main Bot; read & draft only.')}
                </span>
              </button>

              <button
                type="button"
                role="radio"
                aria-checked={assistantMode === 'existing'}
                disabled={assistantBusy}
                className={`gws-mode-option${assistantMode === 'existing' ? ' is-selected' : ''}`}
                onClick={() => handleSelectQuickAssistantMode('existing')}
              >
                <span className="gws-mode-title">
                  <span>{t('选项 2：交给已有 Bot（如主 Bot）', 'Option 2: Assign to Existing Bot (e.g. Main Bot)')}</span>
                </span>
                <span className="gws-mode-desc">
                  {t('无需切换聊天；普通邮件默认按 09:00 / 18:00 简报合并，跨 Bot Skill 仍保持隔离。', 'No chat switching; routine mail merges into 09:00 / 18:00 digests with cross-Bot skill isolation intact.')}
                </span>
              </button>
            </div>

            {assistantMode === 'dedicated' ? (
              <div className="gws-form">
                <label className="gws-field" htmlFor={`${assistantIdPrefix}-bot-name`}>
                  <span className="gws-label">{t('专职管家 Bot 名称', 'Dedicated Bot name')}</span>
                  <input
                    id={`${assistantIdPrefix}-bot-name`}
                    type="text"
                    className="gws-input"
                    maxLength={64}
                    disabled={assistantBusy}
                    value={assistantBotName}
                    onChange={e => setAssistantBotName(e.target.value)}
                  />
                </label>

                {assistantDevices.length > 1 ? (
                  <label className="gws-field" htmlFor={`${assistantIdPrefix}-device`}>
                    <span className="gws-label">{t('托管设备', 'Host device')}</span>
                    <select
                      id={`${assistantIdPrefix}-device`}
                      className="gws-input"
                      disabled={assistantBusy}
                      value={assistantDeviceId}
                      onChange={e => setAssistantDeviceId(e.target.value)}
                    >
                      {assistantDevices.map(dev => (
                        <option key={dev.deviceId} value={dev.deviceId}>
                          {dev.name || dev.deviceId}
                          {dev.online ? '' : t('（离线）', ' (offline)')}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <label className="gws-choice-card">
                  <input
                    type="checkbox"
                    disabled={assistantBusy}
                    checked={assistantHindsight}
                    onChange={e => {
                      setAssistantHindsight(e.target.checked);
                      setAssistantHindsightDirty(true);
                    }}
                  />
                  <span className="gws-choice-body">
                    <span className="gws-choice-title">
                      {t('允许管家使用自己的 Hindsight 私人记忆记住邮件偏好', 'Use assistant’s own Hindsight private memory for mail preferences')}
                    </span>
                    <span className="gws-choice-desc">
                      {t('仅写入该管家自己的私有主库，不与其他 Bot 共享。', 'Strictly limited to this assistant’s own private primary bank.')}
                    </span>
                  </span>
                </label>
              </div>
            ) : (
              <div className="gws-form">
                {activeAssistantBots.length > 0 ? (
                  <label className="gws-field" htmlFor={`${assistantIdPrefix}-existing-bot`}>
                    <span className="gws-label">{t('目标已有 Bot', 'Target existing Bot')}</span>
                    <select
                      id={`${assistantIdPrefix}-existing-bot`}
                      className="gws-input"
                      disabled={assistantBusy}
                      value={assistantTargetBotKey}
                      onChange={e => setAssistantTargetBotKey(e.target.value)}
                    >
                      <option value="">{t('请选择 Bot…', 'Select a Bot…')}</option>
                      {activeAssistantBots.map(b => (
                        <option key={`${b.deviceId}::${b.botId}`} value={`${b.deviceId}::${b.botId}`}>
                          {b.name}
                          {b.isPrimary ? t('（主 Bot）', ' (Primary)') : ''}
                          {' @ '}
                          {assistantDeviceNameById.get(b.deviceId) || b.deviceId}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="gws-muted">
                    {t('未读取到已有 Bot 列表，建议选择「选项 1」创建独立管家，或稍后在中心管理页配置。', 'No existing Bots loaded. Use Option 1 to create a dedicated assistant, or configure later in Center Admin.')}
                  </p>
                )}

                <label className="gws-field" htmlFor={`${assistantIdPrefix}-digest`}>
                  <span className="gws-label">{t('早晚简报时间（24 小时制）', 'Digest times (24h HH:mm)')}</span>
                  <input
                    id={`${assistantIdPrefix}-digest`}
                    type="text"
                    className="gws-input"
                    disabled={assistantBusy}
                    placeholder="09:00, 18:00"
                    value={assistantDigestTimes}
                    onChange={e => {
                      setAssistantDigestTimes(e.target.value);
                      setAssistantDigestDirty(true);
                    }}
                  />
                </label>

                <label className="gws-choice-card">
                  <input
                    type="checkbox"
                    disabled={assistantBusy}
                    checked={assistantHindsight}
                    onChange={e => {
                      setAssistantHindsight(e.target.checked);
                      setAssistantHindsightDirty(true);
                    }}
                  />
                  <span className="gws-choice-body">
                    <span className="gws-choice-title">
                      {t('允许写入该 Bot 的主 Hindsight 记忆库', 'Allow writing preferences to this Bot’s primary Hindsight bank')}
                    </span>
                    <span className="gws-choice-desc">
                      {t('默认关闭，避免后台邮件内容混入主 Bot 长期记忆。', 'Off by default to keep background mail out of your main Bot’s memory.')}
                    </span>
                  </span>
                </label>
              </div>
            )}

            {assistantError ? (
              <InlineBanner tone="danger" role="alert" compact title={assistantError} />
            ) : null}

            <div className="gws-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={assistantBusy}
                onClick={() => void handleEnableQuickAssistant()}
              >
                {assistantBusy
                  ? t('正在启用…', 'Enabling…')
                  : t('启用主动感知', 'Enable proactive assistant')}
              </button>
              <button
                type="button"
                className="gws-btn is-ghost is-sm"
                disabled={assistantBusy}
                onClick={() => setAssistantDismissed(true)}
              >
                {t('暂不开启', 'Not now')}
              </button>
            </div>
          </div>
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
        <InlineBanner
          tone="neutral"
          role="status"
          compact
          title={t('已取消此次授权，未新增或改动已有连接。', 'Authorization cancelled. No connections were changed.')}
        />
      ) : null}

      {error ? (
        <InlineBanner tone="danger" role="alert" compact title={error} />
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
