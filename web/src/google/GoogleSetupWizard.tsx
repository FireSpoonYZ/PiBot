// Real googleSetupControl-driven 3-mode owner setup wizard (shared by chat cards & capabilities entry).
// Never trusts model plain text as authorization completion; verifies Center status and respects privacy boundaries.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { useText } from '../ui';
import { checkGoogleAccount, classifyGoogleError, fetchGoogleStatus } from './googleClient';
import {
  googleAdminTrustRequestText,
  googleSetupModeMeta,
  googleStepInstructions,
  googleStepTitle,
  maskClientId,
  normalizeSetupMode,
  normalizeSetupSteps,
} from './googleCopy';
import { GoogleClientConfigForm, GoogleSignInFlow } from './GoogleSignInFlow';
import type {
  GoogleServiceChoice,
  GoogleSetupAction,
  GoogleSetupControlCall,
  GoogleSetupControlState,
  GoogleSetupMode,
  GoogleStatusSnapshot,
} from './types';
import './google-ui.css';

export interface GoogleSetupWizardProps {
  api?: DesktopPanelApi | null;
  identity?: DesktopIdentity | null;
  botId: string;
  botName?: string;
  isLocalAndroid?: boolean;
  /** If this card comes from chat history with an older run/revision, keep read-only when stale. */
  expectedRunId?: string;
  readOnly?: boolean;
  autoStart?: boolean;
  callGoogleSetup?: GoogleSetupControlCall;
  onOpenBrowser?: () => void;
  onOpenCenterAdmin?: () => void;
  onStatusUpdated?: (snapshot: GoogleStatusSnapshot) => void;
  onClose?: () => void;
}

const ALL_MODES: readonly GoogleSetupMode[] = ['do-it-for-me', 'guide-here', 'guide-browser'];

export function GoogleSetupWizard({
  api,
  identity,
  botId,
  botName,
  isLocalAndroid = false,
  expectedRunId,
  readOnly = false,
  autoStart = false,
  callGoogleSetup,
  onOpenBrowser,
  onOpenCenterAdmin,
  onStatusUpdated,
  onClose,
}: GoogleSetupWizardProps) {
  const t = useText();
  const mountedRef = useRef(true);
  const autoStartedRef = useRef(false);

  const [setup, setSetup] = useState<GoogleSetupControlState | null>(null);
  const [centerStatus, setCenterStatus] = useState<GoogleStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(Boolean(callGoogleSetup));
  const [busy, setBusy] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showDirectConfig, setShowDirectConfig] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [projectIdInput, setProjectIdInput] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshCenter = useCallback(async () => {
    if (!api || !identity) return null;
    try {
      const snap = await fetchGoogleStatus(api, identity);
      if (mountedRef.current) {
        setCenterStatus(snap);
        onStatusUpdated?.(snap);
      }
      return snap;
    } catch {
      return null;
    }
  }, [api, identity, onStatusUpdated]);

  const sendControl = useCallback(
    async (payload: Record<string, unknown>) => {
      if (!callGoogleSetup) {
        setUnavailableReason(
          t(
            '当前目标 Host 未提供 Google 向导控制通道，可直接通过私密表单录入 Web OAuth 凭据或前往中心管理。',
            'Google setup control is unavailable on this Host. Use the private credential form or Center Admin directly.',
          ),
        );
        return null;
      }
      setBusy(true);
      setError('');
      try {
        const next = await callGoogleSetup({ botId, ...payload });
        if (!mountedRef.current) return null;
        if (next.unavailable) {
          setUnavailableReason(
            next.reason ||
              t(
                '当前 Host 暂不可运行向导控制，可使用私密表单直接录入凭据。',
                'Setup control is unavailable on this Host. Use the private credential form instead.',
              ),
          );
          setSetup(next);
          return next;
        }
        setUnavailableReason('');
        setSetup(next);
        if (next.projectId) setProjectIdInput(next.projectId);
        return next;
      } catch (cause) {
        if (!mountedRef.current) return null;
        const info = classifyGoogleError(cause);
        if (info.unavailable) {
          setUnavailableReason(
            t(
              '当前 Host 尚未启用 Google 建项向导控制，可直接录入 Web OAuth 凭据或前往中心管理。',
              'Google setup control is not available on this Host yet. Enter Web OAuth credentials directly or open Center Admin.',
            ),
          );
        } else if (info.offline) {
          setError(t('目标 Host 当前离线，请恢复在线后继续。', 'Target Host is offline. Reconnect to continue.'));
        } else {
          setError(info.message);
        }
        return null;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [botId, callGoogleSetup, t],
  );

  useEffect(() => {
    let active = true;
    const init = async () => {
      setLoading(true);
      const [nextSetup] = await Promise.all([
        callGoogleSetup ? sendControl({ action: 'status' }) : Promise.resolve(null),
        refreshCenter(),
      ]);
      if (!active || !mountedRef.current) return;
      if (
        autoStart &&
        !autoStartedRef.current &&
        callGoogleSetup &&
        nextSetup &&
        !nextSetup.unavailable &&
        (!nextSetup.id || nextSetup.state === 'idle' || nextSetup.state === 'not_started')
      ) {
        autoStartedRef.current = true;
        await sendControl({ action: 'start' });
      }
      if (active && mountedRef.current) setLoading(false);
    };
    void init();
    return () => {
      active = false;
    };
  }, [autoStart, callGoogleSetup, refreshCenter, sendControl]);

  const staleRun = Boolean(expectedRunId && setup?.id && setup.id !== expectedRunId);
  const effectiveReadOnly = readOnly || staleRun;
  const activeMode = normalizeSetupMode(setup?.mode);
  const embeddedSupported = !isLocalAndroid && setup?.canUseEmbeddedBrowser !== false;
  const steps = normalizeSetupSteps(setup?.steps);
  const currentStep = setup?.step || steps.find(s => s.status === 'active' || s.status === 'waiting-human')?.id;
  const redirectUri = setup?.redirectUri || centerStatus?.client.redirectUri;
  const clientConfigured = Boolean(centerStatus?.client.configured);
  const hasConnectedAccount = Boolean(centerStatus?.accounts.some(a => a.status === 'connected'));

  const handleSelectMode = async (mode: GoogleSetupMode) => {
    if (effectiveReadOnly) return;
    if ((mode === 'do-it-for-me' || mode === 'guide-here') && !embeddedSupported) return;
    const actionPayload =
      !setup?.id || setup.state === 'idle' || setup.state === 'not_started'
        ? { action: 'start', mode }
        : { action: 'answer', field: 'mode', value: mode, revision: setup.revision };
    const updated = await sendControl(actionPayload);
    if (updated && (mode === 'do-it-for-me' || mode === 'guide-here') && onOpenBrowser) {
      onOpenBrowser();
    }
  };

  const handleBlockerAction = async (action: GoogleSetupAction) => {
    if (effectiveReadOnly) return;
    setNotice('');
    setError('');
    switch (action.id) {
      case 'take-over':
      case 'take-over-browser':
      case 'open-browser':
        onOpenBrowser?.();
        return;
      case 'import-key':
      case 'configure-client':
        setShowDirectConfig(true);
        return;
      case 'sign-in':
      case 'allow':
      case 'sign-in-again':
      case 'connect':
        setShowSignIn(true);
        return;
      case 'turn-on':
        if (action.url) {
          await openExternalUrl(action.url);
        } else if (setup?.blocker?.enableUrl) {
          await openExternalUrl(setup.blocker.enableUrl);
        }
        return;
      case 'copy-for-admin': {
        const text = googleAdminTrustRequestText(centerStatus?.client.clientId, t);
        try {
          await navigator.clipboard.writeText(text);
          setNotice(t('已复制管理员申请说明，请发送给 Workspace 管理员。', 'Copied admin request text.'));
        } catch {
          setError(t('无法复制到剪贴板。', 'Could not copy to clipboard.'));
        }
        return;
      }
      case 'check-again':
        if (api && identity && (action.email || setup?.account)) {
          setBusy(true);
          try {
            await checkGoogleAccount(api, identity, action.email || setup?.account || '');
            await refreshCenter();
            await sendControl({ action: 'resume', revision: setup?.revision });
          } catch (cause) {
            setError(classifyGoogleError(cause).message);
          } finally {
            setBusy(false);
          }
          return;
        }
        await refreshCenter();
        await sendControl({ action: 'resume', revision: setup?.revision });
        return;
      case 'cancel':
        await sendControl({ action: 'cancel', revision: setup?.revision });
        return;
      case 'resume':
      case 'continue':
        await sendControl({ action: 'resume', revision: setup?.revision });
        return;
      case 'start-over':
        await sendControl({ action: 'start' });
        return;
      default:
        await sendControl({
          action: 'answer',
          actionId: action.id,
          step: action.step,
          revision: setup?.revision,
        });
    }
  };

  if (loading) {
    return (
      <div className="gws-card" role="status">
        <div className="gws-card-head">
          <span className="gws-card-title">{t('Google 应用建项向导', 'Google Workspace Setup')}</span>
          <span className="gws-pill is-muted">{t('读取真实状态…', 'Loading status…')}</span>
        </div>
      </div>
    );
  }

  if (staleRun) {
    return (
      <div className="gws-card is-muted">
        <div className="gws-card-head">
          <span className="gws-card-title">{t('Google 应用建项向导', 'Google Workspace Setup')}</span>
          <span className="gws-pill is-muted">{t('历史快照', 'Previous run')}</span>
        </div>
        <p className="gws-muted">
          {t('此向导记录已结束或被新进度取代，请以最新状态卡片或 Bot 能力页为准。', 'This setup card is from an earlier run. Follow the latest status card or Bot Capabilities.')}
        </p>
      </div>
    );
  }

  const stepInfo = currentStep ? googleStepInstructions(currentStep, redirectUri, t) : null;
  const setupCompleted =
    (setup?.state === 'completed' || setup?.state === 'done') && clientConfigured && hasConnectedAccount;
  const setupClaimsDoneWithoutCenter =
    (setup?.state === 'completed' || setup?.state === 'done') && (!clientConfigured || !hasConnectedAccount);

  return (
    <section className="gws-card" aria-label={t('Google 应用建项向导', 'Google Workspace Setup')}>
      <div className="gws-card-head">
        <div className="gws-card-title-group">
          <span className="gws-card-title">{t('Google 应用配置向导', 'Google App Setup Wizard')}</span>
          {botName ? <span className="gws-card-sub">{botName}</span> : null}
        </div>
        <div className="gws-head-actions">
          <span className={`gws-pill ${setupCompleted ? 'is-ok' : setup?.browserTakeoverRequired ? 'is-warn' : 'is-accent'}`}>
            {setupCompleted
              ? t('已就绪', 'Ready')
              : setup?.browserTakeoverRequired
                ? t('等待本人接管', 'Needs takeover')
                : activeMode
                  ? googleSetupModeMeta(activeMode, t).title.split(' ')[0]
                  : t('待选择方式', 'Choose mode')}
          </span>
          {onClose ? (
            <button type="button" className="gws-btn is-ghost is-xs" onClick={onClose}>
              {t('收起', 'Close')}
            </button>
          ) : null}
        </div>
      </div>

      {/* Center truth banner: never accept unverified completion claims */}
      <div className="gws-truth-bar">
        <span>
          {clientConfigured
            ? t(`Center 应用：已配置 (${maskClientId(centerStatus?.client.clientId)})`, `Center app: Configured (${maskClientId(centerStatus?.client.clientId)})`)
            : t('Center 应用：未配置 Web OAuth Client', 'Center app: Web OAuth Client not configured')}
        </span>
        <button
          type="button"
          className="gws-link-btn"
          disabled={busy}
          onClick={() => {
            void refreshCenter();
            if (callGoogleSetup) void sendControl({ action: 'status' });
          }}
        >
          <RefreshCw size={12} aria-hidden="true" />
          <span>{t('核验最新状态', 'Verify status')}</span>
        </button>
      </div>

      {setupClaimsDoneWithoutCenter ? (
        <div className="gws-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            {t(
              '尚未在 Center 核验到已就绪的 Google 账号连接；授权完成以 Center 实际回调与探活结果为准，不采信聊天文本说明。',
              'Center has not verified a connected Google account yet. Completion is determined strictly by Center status, never chat text.',
            )}
          </span>
        </div>
      ) : null}

      {unavailableReason ? (
        <div className="gws-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{unavailableReason}</span>
        </div>
      ) : null}

      {/* Quick path vs 3-mode selector */}
      {!effectiveReadOnly && !setupCompleted ? (
        <div className="gws-section-block">
          <div className="gws-row-between">
            <span className="gws-label-xs">{t('选择协作方式（可随时切换或接管）', 'Choose how to set up (switchable anytime)')}</span>
            {api && identity ? (
              <button
                type="button"
                className="gws-link-btn"
                onClick={() => setShowDirectConfig(v => !v)}
              >
                <Lock size={12} aria-hidden="true" />
                <span>
                  {showDirectConfig
                    ? t('隐藏直接录入', 'Hide direct input')
                    : t('我已有 Web OAuth 凭据，直接录入', 'I already have Web OAuth credentials')}
                </span>
              </button>
            ) : null}
          </div>

          <div className="gws-mode-list" role="radiogroup" aria-label={t('向导协作模式', 'Setup collaboration mode')}>
            {ALL_MODES.map(mode => {
              const meta = googleSetupModeMeta(mode, t);
              const disabledMode =
                busy ||
                Boolean(unavailableReason) ||
                ((mode === 'do-it-for-me' || mode === 'guide-here') && !embeddedSupported);
              const isSelected = activeMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  disabled={disabledMode}
                  className={`gws-mode-option${isSelected ? ' is-selected' : ''}${disabledMode ? ' is-disabled' : ''}`}
                  onClick={() => void handleSelectMode(mode)}
                >
                  <span className="gws-mode-title">
                    <span>{meta.title}</span>
                    {mode === 'guide-browser' && !embeddedSupported ? (
                      <span className="gws-pill is-accent">{t('推荐', 'Recommended')}</span>
                    ) : null}
                    {(mode === 'do-it-for-me' || mode === 'guide-here') && !embeddedSupported ? (
                      <span className="gws-pill is-muted">{t('当前设备不可用', 'Unavailable here')}</span>
                    ) : null}
                  </span>
                  <span className="gws-mode-desc">{meta.description}</span>
                </button>
              );
            })}
          </div>
          {!embeddedSupported ? (
            <p className="gws-muted">
              {isLocalAndroid
                ? t('Android 本机 Host 不提供桌面级内置自动化浏览器，已默认推荐「外部浏览器指导」。', 'Android local Host does not bundle a desktop automation browser; “Guide me in my browser” is recommended.')
                : t('当前 Host 无法提供实时内置浏览器交互，请使用「外部浏览器指导」或直接录入凭据。', 'Embedded interactive browser is unavailable on this Host. Use “Guide me in my browser” or direct credential input.')}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Browser takeover banner */}
      {setup?.browserTakeoverRequired ? (
        <div className="gws-takeover-alert" role="alert">
          <div className="gws-takeover-body">
            <strong>{t('Bot 已停手，等待你接管当前页面', 'Bot paused — waiting for your takeover')}</strong>
            <span>
              {setup.browserPrompt ||
                t(
                  '即将进入登录、条款勾选或凭据创建步骤，请亲自接管操作，Bot 不会代你勾选或读取密钥。',
                  'Reached sign-in, policy consent, or client secret step. Take over directly — Bot will not accept terms or read secrets.',
                )}
            </span>
          </div>
          <div className="gws-actions">
            {onOpenBrowser && embeddedSupported ? (
              <button type="button" className="gws-btn is-warn is-sm" onClick={onOpenBrowser}>
                <Globe size={14} aria-hidden="true" />
                <span>{t('接管当前页面', 'Take over page')}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="gws-btn is-ghost is-sm"
              disabled={busy}
              onClick={() => void handleSelectMode('guide-browser')}
            >
              {t('改用外部浏览器指导', 'Switch to external browser')}
            </button>
          </div>
        </div>
      ) : null}

      {/* Steps checklist */}
      {steps.length > 0 ? (
        <ol className="gws-steps" aria-label={t('建项步骤进度', 'Setup steps')}>
          {steps.map(item => {
            const isDone = item.status === 'done';
            const isCurrent = item.id === currentStep;
            return (
              <li
                key={item.id}
                className={`gws-step-item is-${item.status}${isCurrent ? ' is-current' : ''}`}
              >
                <span className="gws-step-dot" aria-hidden="true">
                  {isDone ? <Check size={12} /> : null}
                </span>
                <div className="gws-step-content">
                  <span className="gws-step-title">{item.title || googleStepTitle(item.id, t)}</span>
                  {item.detail ? <span className="gws-muted">{item.detail}</span> : null}
                </div>
                {item.url && isCurrent ? (
                  <button
                    type="button"
                    className="gws-btn is-ghost is-xs"
                    onClick={() => void openExternalUrl(item.url!)}
                  >
                    <ExternalLink size={12} aria-hidden="true" />
                    <span>{t('打开控制台', 'Open Console')}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {/* Current step guidance */}
      {currentStep && stepInfo && !setupCompleted ? (
        <div className="gws-step-guide">
          <div className="gws-step-guide-title">{googleStepTitle(currentStep, t)}</div>
          <ul className="gws-guide-list">
            {stepInfo.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {stepInfo.sensitiveWarning ? (
            <p className="gws-sensitive-note">
              <ShieldAlert size={14} aria-hidden="true" />
              <span>{stepInfo.sensitiveWarning}</span>
            </p>
          ) : null}

          {currentStep === 'project' && activeMode === 'guide-browser' && !effectiveReadOnly ? (
            <div className="gws-inline-input-row">
              <input
                type="text"
                className="gws-input"
                value={projectIdInput}
                disabled={busy}
                placeholder={t('粘贴非敏感的 Project ID（可选）', 'Paste non-sensitive Project ID (optional)')}
                aria-label={t('Google Cloud Project ID', 'Google Cloud Project ID')}
                onChange={e => setProjectIdInput(e.target.value)}
              />
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={busy}
                onClick={() =>
                  void sendControl({
                    action: 'advance',
                    step: 'project',
                    projectId: projectIdInput.trim() || undefined,
                    revision: setup?.revision,
                  })
                }
              >
                {t('已完成', 'Done')}
              </button>
            </div>
          ) : null}

          {currentStep !== 'project' &&
          currentStep !== 'client' &&
          currentStep !== 'connect' &&
          activeMode === 'guide-browser' &&
          !effectiveReadOnly ? (
            <div className="gws-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={busy}
                onClick={() =>
                  void sendControl({
                    action: 'advance',
                    step: currentStep,
                    revision: setup?.revision,
                  })
                }
              >
                {t('已完成这一步 (Done)', 'Done — next step')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Blocker details & real actions */}
      {setup?.blocker ? (
        <div className="gws-blocker" role="alert">
          <div className="gws-blocker-msg">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>{setup.blocker.message || t('当前步骤需要你的处理后才能继续。', 'Action needed before setup can continue.')}</span>
          </div>
          {Array.isArray(setup.actions) && setup.actions.length > 0 && !effectiveReadOnly ? (
            <div className="gws-actions">
              {setup.actions.map(action => (
                <button
                  key={action.id}
                  type="button"
                  className="gws-btn is-ghost is-sm"
                  disabled={busy}
                  onClick={() => void handleBlockerAction(action)}
                >
                  {action.id === 'copy-for-admin' ? <Copy size={13} aria-hidden="true" /> : null}
                  <span>{action.label || action.id}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Private client credential entry (step === 'client' or explicit quick path) */}
      {api && identity && !effectiveReadOnly && (showDirectConfig || currentStep === 'client') && !setupCompleted ? (
        <GoogleClientConfigForm
          api={api}
          identity={identity}
          redirectUri={redirectUri}
          configuredClientId={centerStatus?.client.clientId}
          onOpenCenterAdmin={onOpenCenterAdmin}
          onCancel={showDirectConfig ? () => setShowDirectConfig(false) : undefined}
          onSaved={snapshot => {
            setCenterStatus(snapshot);
            onStatusUpdated?.(snapshot);
            setShowDirectConfig(false);
            setShowSignIn(true);
            if (callGoogleSetup && setup && !setup.unavailable) {
              void sendControl({ action: 'resume', step: 'client', revision: setup.revision });
            }
          }}
        />
      ) : null}

      {/* System-browser OAuth connect flow (once Center Web OAuth Client is configured) */}
      {api &&
      identity &&
      !effectiveReadOnly &&
      clientConfigured &&
      (showSignIn || currentStep === 'connect') &&
      !setupCompleted ? (
        <GoogleSignInFlow
          api={api}
          identity={identity}
          initialChoices={setup?.choices as GoogleServiceChoice[] | undefined}
          targetAccount={setup?.account}
          onCompleted={(_account, snapshot) => {
            if (snapshot) {
              setCenterStatus(snapshot);
              onStatusUpdated?.(snapshot);
            }
            if (callGoogleSetup && setup && !setup.unavailable) {
              void sendControl({ action: 'resume', step: 'connect', revision: setup.revision });
            }
          }}
        />
      ) : null}

      {notice ? <p className="gws-notice" role="status">{notice}</p> : null}
      {error ? (
        <div className="gws-error" role="alert">
          <ShieldAlert size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Footer actions */}
      {!effectiveReadOnly ? (
        <div className="gws-footer-bar">
          {onOpenBrowser && embeddedSupported && (activeMode === 'do-it-for-me' || activeMode === 'guide-here') ? (
            <button type="button" className="gws-btn is-ghost is-sm" onClick={onOpenBrowser}>
              <Globe size={14} aria-hidden="true" />
              <span>{t('打开 Bot 浏览器', 'Open Bot Browser')}</span>
            </button>
          ) : null}
          {onOpenCenterAdmin ? (
            <button type="button" className="gws-btn is-ghost is-sm" onClick={onOpenCenterAdmin}>
              <ExternalLink size={14} aria-hidden="true" />
              <span>{t('前往中心管理', 'Open Center Admin')}</span>
            </button>
          ) : null}
          {callGoogleSetup && setup?.id && !setupCompleted && !setup.unavailable ? (
            <button
              type="button"
              className="gws-btn is-ghost is-sm"
              disabled={busy}
              onClick={() => void sendControl({ action: 'cancel', revision: setup.revision })}
            >
              {t('中止向导', 'Cancel setup')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
