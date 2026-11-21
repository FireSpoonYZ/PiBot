// Shared Google & Bot Browser interactive chat cards rendered inside ToolPresentationCard.
// Reused by both Desktop (ChatTranscript) and Android/Mobile (ChatScreen).
// Security invariants:
// - Never treat model plain text as proof of Google OAuth completion.
// - Never accept Client Secret, OAuth codes, or callback URLs via chat messages.
// - Account selection determines only the target shared account for this request, never per-Bot authorization.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Hand,
  Lock,
  RefreshCw,
  ShieldAlert,
  UserCheck,
} from 'lucide-react';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { useText } from '../ui';
import { checkGoogleAccount, classifyGoogleError, fetchGoogleStatus } from './googleClient';
import {
  googleAdminTrustRequestText,
  googleFixLabel,
  googleReadinessFace,
  googleServiceLabel,
  googleStepTitle,
} from './googleCopy';
import { GoogleClientConfigForm, GoogleSignInFlow } from './GoogleSignInFlow';
import { GoogleSetupWizard } from './GoogleSetupWizard';
import type {
  GoogleAccountSelectPresentation,
  GoogleAccountView,
  GoogleBrowserTakeoverPresentation,
  GoogleChatCardContext,
  GoogleReadinessPresentation,
  GoogleServiceChoice,
  GoogleSetupPresentation,
  GoogleStatusSnapshot,
} from './types';
import './google-ui.css';

/* ------------------------------------------------------------------ */
/* 1. Google Setup Read-Only Text History Note                         */
/* ------------------------------------------------------------------ */

export function GoogleSetupChatCard({
  presentation,
}: {
  presentation: GoogleSetupPresentation;
  active?: boolean;
  disabled?: boolean;
  googleContext?: GoogleChatCardContext;
}) {
  const t = useText();
  const title = presentation.title || t('Google 配置向导', 'Google setup');
  const stepLabel = presentation.step ? googleStepTitle(presentation.step, t) : '';
  const detail =
    presentation.state === 'done' || presentation.state === 'completed'
      ? t('已完成', 'Completed')
      : presentation.state === 'cancelled'
        ? t('已取消', 'Cancelled')
        : presentation.state === 'failed'
          ? stepLabel
            ? `${stepLabel}（${t('已暂停', 'Paused')}）`
            : t('已暂停', 'Paused')
          : stepLabel || t('进行中', 'In progress');
  const lineText = `${title} · ${detail}`;

  // Strictly one plain read-only text line: no card frame, no buttons, no details, no guidance links.
  return (
    <p className="gws-history-line" role="note" title={lineText}>
      {lineText}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Multi-Account Selection Card                                     */
/* ------------------------------------------------------------------ */

export function GoogleAccountSelectCard({
  presentation,
  active,
  disabled,
  googleContext,
}: {
  presentation: GoogleAccountSelectPresentation;
  active: boolean;
  disabled?: boolean;
  googleContext?: GoogleChatCardContext;
}) {
  const t = useText();
  const mountedRef = useRef(true);
  const [liveAccounts, setLiveAccounts] = useState<GoogleAccountView[] | null>(null);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(presentation.selectedEmail ?? null);
  const [cancelled, setCancelled] = useState(presentation.status === 'cancelled');
  const [submitting, setSubmitting] = useState(false);
  const [reconnectingEmail, setReconnectingEmail] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshAccounts = useCallback(async () => {
    if (!googleContext?.api || !googleContext?.identity) return;
    try {
      const snap = await fetchGoogleStatus(googleContext.api, googleContext.identity);
      if (mountedRef.current) setLiveAccounts(snap.accounts);
    } catch {
      // Keep presentation accounts when offline/unavailable.
    }
  }, [googleContext?.api, googleContext?.identity]);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  const accounts = liveAccounts
    ? liveAccounts.map(acc => ({
        id: acc.id,
        email: acc.email,
        status: acc.status,
        choices: acc.choices,
      }))
    : (presentation.accounts ?? []).map(acc => ({
        id: acc.id ?? acc.email,
        email: acc.email,
        status: acc.status ?? ('connected' as const),
        choices: [] as GoogleServiceChoice[],
      }));

  const isSettled = Boolean(selectedEmail) || cancelled || presentation.status === 'selected' || presentation.status === 'cancelled';
  // Blocking capability requests (`requestId`) require active live slot; non-blocking ambiguity prompts stay clickable in chat.
  const canInteract =
    !disabled &&
    !isSettled &&
    Boolean(googleContext?.onSelectGoogleAccount) &&
    (active || !presentation.requestId);

  const handleChoose = async (email: string) => {
    if (!canInteract || submitting || !googleContext?.onSelectGoogleAccount) return;
    setSubmitting(true);
    setError('');
    try {
      await googleContext.onSelectGoogleAccount({
        email,
        requestId: presentation.requestId,
        installationId: presentation.installationId,
        conversationId: presentation.conversationId,
      });
      if (mountedRef.current) setSelectedEmail(email);
    } catch (cause) {
      if (mountedRef.current) setError(classifyGoogleError(cause).message);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!canInteract || submitting || !googleContext?.onSelectGoogleAccount) return;
    setSubmitting(true);
    setError('');
    try {
      await googleContext.onSelectGoogleAccount({
        email: '',
        requestId: presentation.requestId,
        installationId: presentation.installationId,
        conversationId: presentation.conversationId,
        cancelled: true,
      });
      if (mountedRef.current) setCancelled(true);
    } catch (cause) {
      if (mountedRef.current) setError(classifyGoogleError(cause).message);
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const statusText = selectedEmail
    ? (presentation.requestId ? t(`已选择 ${selectedEmail}`, `Selected ${selectedEmail}`) : t('已填入草稿，发送后继续', 'Draft ready — send to continue'))
    : cancelled
      ? t('已取消', 'Cancelled')
      : canInteract
        ? t('请选择本次账号', 'Choose account')
        : t('历史记录（只读）', 'Read-only');

  return (
    <section className="gws-card" aria-label={t('选择本次使用的 Google 账号', 'Choose Google account')}>
      <div className="gws-card-head">
        <div className="gws-card-title-group">
          <UserCheck size={15} aria-hidden="true" />
          <span className="gws-card-title">{t('这次用哪个 Google 账号？', 'Which Google account for this request?')}</span>
        </div>
        <span className={`gws-pill ${selectedEmail ? 'is-ok' : cancelled ? 'is-muted' : 'is-accent'}`}>
          {statusText}
        </span>
      </div>

      <p className="gws-muted">
        {presentation.reason || t('Center 已连接多个 Google 账号且本次请求未指明目标账号。此选择仅用于本次操作，不是逐 Bot 授权。', 'Multiple shared Google accounts are connected and this request did not specify one. This choice applies to this action only — it is not per-Bot authorization.')}
      </p>

      {presentation.actionLabel || presentation.service ? (
        <p className="gws-hint-line">
          {t('请求操作：', 'Requested action: ')}
          <strong>{presentation.actionLabel || googleServiceLabel(presentation.service || '', t)}</strong>
        </p>
      ) : null}

      <div className="gws-account-pick-list" role="list">
        {accounts.map(acc => {
          const isReconnect = acc.status === 'reconnect';
          const isPicked = selectedEmail === acc.email;
          return (
            <div key={acc.id || acc.email} className={`gws-account-pick-row${isPicked ? ' is-selected' : ''}`} role="listitem">
              <div className="gws-account-id">
                <strong className="gws-account-email">{acc.email}</strong>
                {isReconnect ? <span className="gws-pill is-warn">{t('需重连', 'Reconnect required')}</span> : null}
                {isPicked ? <span className="gws-pill is-ok"><Check size={11} aria-hidden="true" /> {t('已选', 'Chosen')}</span> : null}
              </div>
              {isReconnect ? (
                googleContext?.api && googleContext?.identity ? (
                  <button
                    type="button"
                    className="gws-btn is-warn is-xs"
                    disabled={disabled}
                    onClick={() => setReconnectingEmail(acc.email)}
                  >
                    {t('重新连接', 'Reconnect')}
                  </button>
                ) : null
              ) : (
                <button
                  type="button"
                  className="gws-btn is-primary is-xs"
                  disabled={!canInteract || submitting}
                  onClick={() => void handleChoose(acc.email)}
                >
                  {submitting ? t('处理中…', 'Working…') : t('用此账号', 'Use account')}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {reconnectingEmail && googleContext?.api && googleContext?.identity ? (
        <GoogleSignInFlow
          api={googleContext.api}
          identity={googleContext.identity}
          mode="reconnect"
          targetAccount={reconnectingEmail}
          existingChoices={liveAccounts?.find(a => a.email === reconnectingEmail)?.choices}
          onCancel={() => setReconnectingEmail(null)}
          onCompleted={() => {
            setReconnectingEmail(null);
            void refreshAccounts();
          }}
        />
      ) : null}

      {error ? (
        <div className="gws-error" role="alert">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {canInteract ? (
        <div className="gws-actions">
          <button type="button" className="gws-btn is-ghost is-xs" disabled={submitting} onClick={() => void handleCancel()}>
            {t('取消本次操作', 'Cancel')}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Bot Browser Takeover Card                                        */
/* ------------------------------------------------------------------ */

export function GoogleBrowserTakeoverCard({
  presentation,
  active,
  disabled,
  googleContext,
}: {
  presentation: GoogleBrowserTakeoverPresentation;
  active: boolean;
  disabled?: boolean;
  googleContext?: GoogleChatCardContext;
}) {
  const t = useText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const canStream = presentation.canStreamInteract !== false && !googleContext?.isLocalAndroid;

  const handleOpenAndTakeover = async () => {
    if (disabled || busy) return;
    setError('');
    if (googleContext?.onOpenBrowser) {
      googleContext.onOpenBrowser();
      return;
    }
    if (googleContext?.callBrowser) {
      setBusy(true);
      try {
        await googleContext.callBrowser({
          action: 'status',
          ...(presentation.pageId ? { pageId: presentation.pageId } : {}),
        });
      } catch (cause) {
        setError(classifyGoogleError(cause).message);
      } finally {
        setBusy(false);
      }
    }
  };

  const handleSwitchExternalGuide = async () => {
    if (!googleContext?.callGoogleSetup || disabled || busy) return;
    setBusy(true);
    setError('');
    try {
      await googleContext.callGoogleSetup({ action: 'resume', mode: 'guide-browser' });
    } catch (cause) {
      setError(classifyGoogleError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gws-card is-takeover" aria-label={t('Bot 浏览器请求接管', 'Bot browser takeover requested')}>
      <div className="gws-card-head">
        <div className="gws-card-title-group">
          <Hand size={15} aria-hidden="true" />
          <span className="gws-card-title">{t('Bot 请求你接管当前页面', 'Bot paused — take over this page')}</span>
        </div>
        <span className={`gws-pill ${canStream ? 'is-warn' : 'is-muted'}`}>
          {canStream
            ? active
              ? t('已停手 · 待接管', 'Paused · Ready')
              : t('待查看', 'Open to check')
            : t('不可实时投屏', 'Stream unavailable')}
        </span>
      </div>

      <p className="gws-muted">
        {presentation.reason || t('当前页面到达登录、政策条款或敏感凭据步骤。Bot 已停止操作，请在原页面完成并点击「交还给 Bot」。', 'Reached sign-in, policy agreement, or a sensitive credential step. Bot has stopped — complete the step on the same page, then hand back.')}
      </p>

      {presentation.url ? (
        <div className="gws-url-pill" title={presentation.url}>
          <Globe size={13} aria-hidden="true" />
          <span>{presentation.url}</span>
        </div>
      ) : null}

      {error ? (
        <div className="gws-error" role="alert">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="gws-actions">
        {canStream && googleContext?.onOpenBrowser ? (
          <button
            type="button"
            className="gws-btn is-warn is-sm"
            disabled={disabled || busy}
            onClick={() => void handleOpenAndTakeover()}
          >
            <Globe size={14} aria-hidden="true" />
            <span>{t('接管当前页面 (Take over)', 'Take over page')}</span>
          </button>
        ) : (
          <>
            {googleContext?.callGoogleSetup ? (
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={disabled || busy}
                onClick={() => void handleSwitchExternalGuide()}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>{t('改用外部浏览器指导', 'Switch to external browser guide')}</span>
              </button>
            ) : null}
            {googleContext?.onOpenBrowser ? (
              <button
                type="button"
                className="gws-btn is-ghost is-sm"
                disabled={disabled || busy}
                onClick={() => void handleOpenAndTakeover()}
              >
                {t('查看浏览器状态', 'View browser status')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Google Readiness & Remediation Card                              */
/* ------------------------------------------------------------------ */

export function GoogleReadinessCard({
  presentation,
  disabled,
  googleContext,
}: {
  presentation: GoogleReadinessPresentation;
  disabled?: boolean;
  googleContext?: GoogleChatCardContext;
}) {
  const t = useText();
  const mountedRef = useRef(true);
  const [liveStatus, setLiveStatus] = useState<GoogleStatusSnapshot | null>(null);
  const [panel, setPanel] = useState<'none' | 'configure' | 'wizard' | 'signin'>('none');
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!googleContext?.api || !googleContext?.identity) return;
    try {
      const snap = await fetchGoogleStatus(googleContext.api, googleContext.identity);
      if (mountedRef.current) setLiveStatus(snap);
    } catch {
      // Keep fallback presentation info if Center is offline.
    }
  }, [googleContext?.api, googleContext?.identity]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const targetAccountObj = liveStatus?.accounts.find(a =>
    presentation.account ? a.email === presentation.account : true,
  );
  const liveServiceReadiness =
    targetAccountObj && presentation.service
      ? targetAccountObj.services.find(s => s.service === presentation.service)
      : undefined;

  // Prefer live Center verification over older chat card snapshot!
  const resolvedState = liveStatus
    ? !liveStatus.client.configured
      ? 'unconfigured'
      : liveStatus.accounts.length === 0
        ? 'disconnected'
        : targetAccountObj?.status === 'reconnect'
          ? 'reconnect'
          : liveServiceReadiness?.state ?? presentation.state ?? 'ready'
    : presentation.state ?? 'error';

  const serviceName = presentation.service ? googleServiceLabel(presentation.service, t) : 'Google Workspace';

  const handleRecheck = async () => {
    if (!googleContext?.api || !googleContext?.identity) return;
    setChecking(true);
    setError('');
    setNotice('');
    try {
      const targetEmail = presentation.account || targetAccountObj?.email;
      if (targetEmail) {
        await checkGoogleAccount(googleContext.api, googleContext.identity, targetEmail);
      }
      await refresh();
      if (mountedRef.current) setNotice(t('已向 Center 重新核验最新状态。', 'Verified latest status with Center.'));
    } catch (cause) {
      if (mountedRef.current) setError(classifyGoogleError(cause).message);
    } finally {
      if (mountedRef.current) setChecking(false);
    }
  };

  const handleCopyAdmin = async () => {
    try {
      await navigator.clipboard.writeText(googleAdminTrustRequestText(liveStatus?.client.clientId, t));
      setNotice(t('已复制管理员配置/信任指引。', 'Copied administrator instructions.'));
    } catch {
      setError(t('无法复制到剪贴板。', 'Could not copy to clipboard.'));
    }
  };

  const face =
    resolvedState === 'unconfigured'
      ? { label: t('未配置中心应用', 'Center app not configured'), tone: 'muted' as const }
      : resolvedState === 'disconnected'
        ? { label: t('未连接账号', 'No account connected'), tone: 'warn' as const }
        : resolvedState === 'reconnect'
          ? { label: t('需重连', 'Reconnect required'), tone: 'warn' as const }
          : resolvedState === 'ambiguous-account'
            ? { label: t('需明确账号', 'Specify account'), tone: 'accent' as const }
            : googleReadinessFace(
                {
                  service: (presentation.service as 'gmail') || 'gmail',
                  state: resolvedState,
                  detail: liveServiceReadiness?.detail ?? presentation.detail,
                  enableUrl: liveServiceReadiness?.enableUrl ?? presentation.enableUrl,
                },
                t,
              );

  const canUseBroker = Boolean(googleContext?.api && googleContext?.identity && !disabled);

  return (
    <section className="gws-card" aria-label={t('Google 服务状态', 'Google service readiness')}>
      <div className="gws-card-head">
        <div className="gws-card-title-group">
          <span className="gws-card-title">{serviceName}</span>
          {presentation.account ? <span className="gws-card-sub">{presentation.account}</span> : null}
        </div>
        <span className={`gws-pill is-${face.tone}`}>{face.label}</span>
      </div>

      <p className="gws-muted">
        {resolvedState === 'ready'
          ? t('Center 已核验该服务就绪，所有 Bot 可直接使用。', 'Verified ready in Center — available to all Bots.')
          : resolvedState === 'unconfigured'
            ? t('当前 Center 尚未配置 Google Web OAuth 应用。管理员配置一次后，所有 Bot 自动可用。', 'Center has no Google Web OAuth app configured yet. Once configured by an admin, all Bots share it.')
            : resolvedState === 'disconnected'
              ? t('尚未连接 Google 账号。在系统浏览器登录授权后，所有 Bot 即可使用已选服务。', 'No Google account connected yet. Sign in via your system browser to enable approved services for all Bots.')
              : resolvedState === 'reconnect'
                ? t('该 Google 账号的授权已失效，需要账号本人通过系统浏览器重新连接。', 'Authorization for this Google account ended. Reconnect in your system browser.')
                : resolvedState === 'needs-permission'
                  ? t('当前账号尚未批准此服务所需权限；补充授权后所有 Bot 立即生效。', 'This service has not been granted permission yet. Grant permission to enable it for all Bots.')
                  : resolvedState === 'api-disabled'
                    ? t('Google Cloud 项目中尚未启用对应 API。前往控制台启用后再点重新检查。', 'The corresponding Google Cloud API is disabled. Enable it in Cloud Console, then check again.')
                    : resolvedState === 'blocked-by-admin'
                      ? t('所在 Google Workspace 组织管理员禁止了此应用访问该服务。', 'Your Google Workspace administrator blocked access to this service.')
                      : presentation.detail || t('无法确认此服务状态，请重试检查。', 'Could not verify service status. Retry checking.')}
      </p>

      {notice ? <p className="gws-notice" role="status">{notice}</p> : null}
      {error ? (
        <div className="gws-error" role="alert">
          <ShieldAlert size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="gws-actions">
        {resolvedState === 'unconfigured' && canUseBroker ? (
          <>
            <button type="button" className="gws-btn is-primary is-sm" onClick={() => setPanel(p => (p === 'wizard' ? 'none' : 'wizard'))}>
              {t('引导创建 Google 应用', 'Guide app setup')}
            </button>
            <button type="button" className="gws-btn is-ghost is-sm" onClick={() => setPanel(p => (p === 'configure' ? 'none' : 'configure'))}>
              <Lock size={13} aria-hidden="true" />
              <span>{t('直接录入凭据', 'Enter credentials')}</span>
            </button>
            <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void handleCopyAdmin()}>
              <Copy size={13} aria-hidden="true" />
              <span>{t('复制管理员指引', 'Copy admin guide')}</span>
            </button>
          </>
        ) : null}

        {(resolvedState === 'disconnected' || resolvedState === 'reconnect' || resolvedState === 'needs-permission') && canUseBroker ? (
          <button
            type="button"
            className="gws-btn is-primary is-sm"
            onClick={() => setPanel(p => (p === 'signin' ? 'none' : 'signin'))}
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span>
              {resolvedState === 'reconnect'
                ? t('重新连接 Google', 'Reconnect Google')
                : resolvedState === 'needs-permission'
                  ? googleFixLabel('allow-again', t)
                  : t('在系统浏览器连接 Google', 'Connect Google in system browser')}
            </span>
          </button>
        ) : null}

        {resolvedState === 'api-disabled' ? (
          <>
            <button
              type="button"
              className="gws-btn is-primary is-sm"
              onClick={() =>
                void openExternalUrl(
                  liveServiceReadiness?.enableUrl ||
                    presentation.enableUrl ||
                    'https://console.cloud.google.com/apis/library',
                )
              }
            >
              <ExternalLink size={13} aria-hidden="true" />
              <span>{googleFixLabel('turn-on', t)}</span>
            </button>
            {canUseBroker ? (
              <button type="button" className="gws-btn is-ghost is-sm" disabled={checking} onClick={() => void handleRecheck()}>
                <RefreshCw size={13} className={checking ? 'gws-spin' : undefined} aria-hidden="true" />
                <span>{checking ? t('检查中…', 'Checking…') : googleFixLabel('check-again', t)}</span>
              </button>
            ) : null}
          </>
        ) : null}

        {resolvedState === 'blocked-by-admin' ? (
          <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void handleCopyAdmin()}>
            <Copy size={13} aria-hidden="true" />
            <span>{googleFixLabel('copy-for-admin', t)}</span>
          </button>
        ) : null}

        {resolvedState === 'error' && canUseBroker ? (
          <button type="button" className="gws-btn is-ghost is-sm" disabled={checking} onClick={() => void handleRecheck()}>
            <AlertTriangle size={13} aria-hidden="true" />
            <span>{checking ? t('检查中…', 'Checking…') : googleFixLabel('check-again', t)}</span>
          </button>
        ) : null}

        {googleContext?.onOpenCapabilities ? (
          <button type="button" className="gws-btn is-ghost is-sm" onClick={googleContext.onOpenCapabilities}>
            {t('查看能力设置', 'Open capabilities')}
          </button>
        ) : null}
      </div>

      {panel === 'configure' && googleContext?.api && googleContext?.identity ? (
        <GoogleClientConfigForm
          api={googleContext.api}
          identity={googleContext.identity}
          redirectUri={liveStatus?.client.redirectUri}
          configuredClientId={liveStatus?.client.clientId}
          onOpenCenterAdmin={googleContext.onOpenCenterAdmin}
          onCancel={() => setPanel('none')}
          onSaved={snap => {
            setLiveStatus(snap);
            setPanel('signin');
          }}
        />
      ) : null}

      {panel === 'wizard' && googleContext ? (
        <GoogleSetupWizard
          api={googleContext.api}
          identity={googleContext.identity}
          botId={googleContext.botId}
          botName={googleContext.botName}
          isLocalAndroid={googleContext.isLocalAndroid}
          autoStart
          callGoogleSetup={googleContext.callGoogleSetup}
          onOpenBrowser={googleContext.onOpenBrowser}
          onOpenCenterAdmin={googleContext.onOpenCenterAdmin}
          onStatusUpdated={snap => setLiveStatus(snap)}
          onClose={() => setPanel('none')}
        />
      ) : null}

      {panel === 'signin' && googleContext?.api && googleContext?.identity ? (
        <GoogleSignInFlow
          api={googleContext.api}
          identity={googleContext.identity}
          mode={resolvedState === 'reconnect' ? 'reconnect' : resolvedState === 'needs-permission' ? 'expand' : 'connect'}
          targetAccount={presentation.account || targetAccountObj?.email}
          existingChoices={targetAccountObj?.choices}
          initialChoices={
            presentation.service === 'gmail' || presentation.service === 'calendar'
              ? [presentation.service]
              : presentation.service === 'drive' || presentation.service === 'docs' || presentation.service === 'sheets' || presentation.service === 'files'
                ? ['files']
                : undefined
          }
          onCancel={() => setPanel('none')}
          onCompleted={(_acc, snap) => {
            if (snap) setLiveStatus(snap);
            else void refresh();
            setPanel('none');
          }}
        />
      ) : null}
    </section>
  );
}
