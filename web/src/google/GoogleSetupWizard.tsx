// Real googleSetupControl-driven 3-mode owner setup wizard (shared by chat cards & capabilities entry).
// Aligned with host-core/google-setup/{service,rules,blocker,guidance}.js & host-core/browser-setup-protocol.js:
// - Uses `expectedRevision` for CAS on cancel/resume/answer/advance.
// - Submits canonical `answer` shape `{ action: 'answer', card, values, expectedRevision, runId?, step?, cardCopy? }`
//   with safe fallback to `{ action: 'resume', mode, expectedRevision }` for mode switches if transport rejects `card`/`values`.
// - Never trusts model plain text as authorization completion; verifies Center status and respects privacy boundaries.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  MoreHorizontal,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { useText } from '../ui';
import {
  buildGoogleSetupMutationPayload,
  googleSetupConsoleUrl,
  isStaleGoogleSetupResult,
  recordAcceptedGoogleSetupOrder,
  shouldAcceptGoogleSetupResponse,
  type SetupResponseOrderState,
} from './currentGoogleSetup';
import { checkGoogleAccount, classifyGoogleError, fetchGoogleStatus } from './googleClient';
import {
  GOOGLE_SERVICE_CHOICES,
  googleAdminTrustRequestText,
  googleChoiceDescription,
  googleChoiceLabel,
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
  GoogleSetupBlocker,
  GoogleSetupControlCall,
  GoogleSetupControlState,
  GoogleSetupMode,
  GoogleStatusSnapshot,
} from './types';
import './google-ui.css';
import type { BrowserDestination } from '../bot-browser/protocol';

export interface GoogleSetupWizardProps {
  api?: DesktopPanelApi | null;
  identity?: DesktopIdentity | null;
  /** Optional scope isolation key (defaults to botId) to discard stale cross-chat responses. */
  scopeKey?: string;
  botId: string;
  botName?: string;
  isLocalAndroid?: boolean;
  /** If this card comes from chat history with an older run/copy, keep read-only when stale. */
  expectedRunId?: string;
  expectedCard?: string;
  expectedStep?: string;
  expectedCardCopy?: number;
  readOnly?: boolean;
  autoStart?: boolean;
  /** Externally synced Host setup state (used by CurrentGoogleSetupCard to prevent duplicate status calls). */
  externalSetup?: GoogleSetupControlState | null;
  /** When true, parent owns initial/background status polling; wizard skips duplicate mount status RPC. */
  managedStatus?: boolean;
  /** When true, renders the compact composer-docked chat card instead of the full Settings wizard. */
  compactChat?: boolean;
  callGoogleSetup?: GoogleSetupControlCall;
  onOpenBrowser?: () => void;
  onOpenBrowserDestination?: (destination: BrowserDestination) => void;
  onOpenCapabilities?: () => void;
  onOpenCenterAdmin?: () => void;
  onStatusUpdated?: (snapshot: GoogleStatusSnapshot) => void;
  onSetupChange?: (next: GoogleSetupControlState, meta: { action: string }) => void;
  onClose?: () => void;
}

const ALL_MODES: readonly GoogleSetupMode[] = ['do-it-for-me', 'guide-here', 'guide-browser'];

function compactModeLabel(mode: GoogleSetupMode, t: (zh: string, en: string) => string): string {
  switch (mode) {
    case 'do-it-for-me':
      return t('自动代办', 'Auto fill');
    case 'guide-here':
      return t('内嵌浏览器', 'In-app browser');
    case 'guide-browser':
      return t('外部浏览器', 'System browser');
  }
}

function compactModeHint(mode: GoogleSetupMode, t: (zh: string, en: string) => string): string {
  switch (mode) {
    case 'do-it-for-me':
      return t('自动填非敏感项，登录与密钥交给你', 'Fills non-sensitive fields; pauses for sign-in & secrets');
    case 'guide-here':
      return t('在内置浏览器操作，Bot 同步进度', 'Operate in built-in browser while Bot tracks steps');
    case 'guide-browser':
      return t('在系统浏览器操作，完成后回来继续', 'Use your system browser, then return to continue');
  }
}

function humanizeEmbeddedReason(
  raw: string,
  isLocalAndroid: boolean,
  t: (zh: string, en: string) => string,
): string {
  if (isLocalAndroid) {
    return t('当前设备仅支持外部浏览器', 'Only your system browser is available on this device');
  }
  const trimmed = raw.trim();
  if (trimmed === 'client_browser_disconnected') {
    return t('内嵌浏览器连接已断开。可在「浏览器」面板点击「重新检查浏览器」。',
      'The in-app browser disconnected. Select Retry browser connection in the Browser panel.');
  }
  if (!trimmed) {
    return t('内置浏览器暂不可用，已使用外部浏览器', 'Built-in browser is unavailable; using system browser');
  }
  if (/chromium|playwright|browser|launch|start_failed|enoent/i.test(trimmed)) {
    return t('内置浏览器未能启动，已使用外部浏览器', 'Built-in browser could not start; using system browser');
  }
  if (/^[a-z0-9_.:-]+$/i.test(trimmed)) {
    return t('内置浏览器暂不可用，已使用外部浏览器', 'Built-in browser is unavailable; using system browser');
  }
  return trimmed;
}

function compactStepCopy(
  step: string,
  t: (zh: string, en: string) => string,
): { title: string; hint: string; openLabel: string; continueLabel: string } {
  switch (step) {
    case 'account':
      return {
        title: t('登录 Google Cloud 账号', 'Sign in to Google Cloud'),
        hint: t('在系统浏览器登录用于创建项目的 Google 账号，密码和验证码只在 Google 页面输入。',
          'Sign in with the Google account for your project. Enter passwords only on Google.',
        ),
        openLabel: t('打开 Google Cloud', 'Open Google Cloud'),
        continueLabel: t('我已登录，继续', 'Signed in, continue'),
      };
    case 'project':
      return {
        title: t('创建 Google Cloud 项目', 'Create a Google Cloud project'),
        hint: t('确认项目已创建后继续。', 'Continue after the project is created.'),
        openLabel: t('打开项目创建页', 'Open project creation page'),
        continueLabel: t('已创建，继续', 'Created, continue'),
      };
    case 'apis':
      return {
        title: t('启用所需 Google API', 'Enable required Google APIs'),
        hint: t('在打开的页面确认启用所选服务与基础依赖 API，完成后回来继续。',
          'Enable the listed APIs on the page, then return to continue.',
        ),
        openLabel: t('去启用 API', 'Open API page'),
        continueLabel: t('已启用，继续', 'Enabled, continue'),
      };
    case 'branding':
      return {
        title: t('配置应用信息并同意政策', 'Configure app info & policy'),
        hint: t('填写应用名与联系邮箱，并由本人阅读勾选 Google 用户数据政策。',
          'Enter app name and contact email, then tick Google User Data Policy yourself.',
        ),
        openLabel: t('打开 Google Cloud', 'Open Google Cloud'),
        continueLabel: t('已保存，继续', 'Saved, continue'),
      };
    case 'links':
      return {
        title: t('填写域名与隐私链接', 'Add your domain & privacy links'),
        hint: t('填入你自己的 Center 主页、隐私说明链接和已授权域名后保存。',
          'Add your own Center homepage, privacy URL, and authorized domain, then save.',
        ),
        openLabel: t('打开 Google Cloud', 'Open Google Cloud'),
        continueLabel: t('已保存，继续', 'Saved, continue'),
      };
    case 'publish':
      return {
        title: t('发布应用或添加测试用户', 'Publish app or add test users'),
        hint: t('按需发布应用，或在 Testing 模式下将自己的邮箱加入测试用户。',
          'Publish the app, or add your email under Test users while in Testing mode.',
        ),
        openLabel: t('打开 Google Cloud', 'Open Google Cloud'),
        continueLabel: t('已完成，继续', 'Done, continue'),
      };
    case 'client':
      return {
        title: t('创建并保存 Web 凭据', 'Create & save Web credentials'),
        hint: t('在 Google Cloud 创建「Web application」凭据，再到独立设置页私密录入；不要把密钥发到聊天里。',
          'Create a “Web application” client in Google Cloud, then save it privately in Settings — never paste secrets in chat.',
        ),
        openLabel: t('打开 Google Cloud', 'Open Google Cloud'),
        continueLabel: t('我已保存，继续', 'Saved, continue'),
      };
    case 'connect':
      return {
        title: t('连接 Google 账号', 'Connect Google account'),
        hint: t('在系统浏览器完成登录与授权，连接结果由 Center 核验。',
          'Complete sign-in and consent in your system browser; Center verifies the result.',
        ),
        openLabel: t('打开 Google 登录', 'Open Google sign-in'),
        continueLabel: t('我已连接，继续', 'Connected, continue'),
      };
    default:
      return {
        title: googleStepTitle(step, t),
        hint: '',
        openLabel: t('打开 Google Cloud', 'Open Google Cloud'),
        continueLabel: t('已完成，继续', 'Done, continue'),
      };
  }
}

function setupBrowserLockHint(
  lock: GoogleSetupControlState['browserLock'],
  t: (zh: string, en: string) => string,
): string {
  switch (lock?.reason) {
    case 'google-auth':
      return lock.requiresSystemBrowser
        ? t('请在外部浏览器亲自完成 Google 登录。', 'Finish signing in to Google in your system browser.')
        : t('请接管当前页面并亲自完成 Google 登录。', 'Take over this page and finish signing in to Google.');
    case 'oauth-client-secret':
      return lock.requiresSystemBrowser
        ? t('请在外部浏览器创建 OAuth 客户端，再到设置页录入凭据。', 'Create the OAuth client in your system browser, then save its credentials in Settings.')
        : t('请亲自创建 OAuth 客户端，并在设置页录入凭据。', 'Create the OAuth client yourself and save its credentials in Settings.');
    case 'policy-consent':
      return lock.requiresSystemBrowser
        ? t('请在外部浏览器阅读并确认 Google 用户数据政策。', 'Review and accept Google’s User Data Policy in your system browser.')
        : t('请接管页面，亲自阅读并确认 Google 用户数据政策。', 'Take over this page to review and accept Google’s User Data Policy.');
    default:
      return lock?.requiresSystemBrowser
        ? t('请在外部浏览器完成此步骤。', 'Finish this step in your system browser.')
        : t('请接管当前页面并完成此步骤。', 'Take over this page and finish the step.');
  }
}

function compactBlockerLabel(
  action: GoogleSetupAction,
  t: (zh: string, en: string) => string,
): string {
  switch (action.id) {
    case 'done':
      return t('已完成，继续', 'Done, continue');
    case 'check-again':
      return t('重新检查', 'Check again');
    case 'copy-for-admin':
      return t('复制管理员说明', 'Copy admin guide');
    case 'turn-on':
      return t('去启用 API', 'Enable API');
    case 'resume':
    case 'continue':
      return t('继续配置', 'Continue');
    case 'take-over':
      return t('交回自动代办', 'Resume auto fill');
    case 'let-me':
      return t('改为我来操作', 'Let me handle this');
    case 'start-over':
      return t('重新开始', 'Start over');
    case 'configure-client':
    case 'import-key':
      return t('前往设置录入凭据', 'Save credentials in Settings');
    case 'make-new-key':
      return t('重新创建凭据', 'Create new credentials');
    case 'keep-account':
      return action.email ? t(`使用 ${action.email}`, `Keep ${action.email}`) : t('保留当前账号', 'Keep account');
    case 'sign-in':
    case 'connect':
      return t('去登录连接', 'Sign in');
    case 'sign-in-again':
      return t('重新登录', 'Sign in again');
    case 'allow':
      return t('去补授权', 'Grant permission');
    case 'continue-without':
      return t('跳过未授权项继续', 'Continue without');
    case 'cancel':
      return t('中止配置', 'Cancel setup');
    case 'open-browser':
    case 'take-over-browser':
    case 'takeover-browser':
      return t('打开内置浏览器', 'Open built-in browser');
    default:
      return action.label || action.id;
  }
}

function describeCompactBlocker(
  blocker: GoogleSetupBlocker,
  t: (zh: string, en: string) => string,
): string {
  if (blocker.kind === 'no-key') {
    return t('Center 尚未保存有效的 Web OAuth 凭据，请前往独立设置页录入或重新创建。',
      'Center has no saved Web OAuth client yet. Save it in Settings or create a new client.',
    );
  }
  if (blocker.kind === 'key-gone') {
    return t('Center 已保存的 Google 应用凭据已失效，请重新创建并在独立设置页录入。',
      'Saved Web OAuth credentials are no longer valid. Create a new client and save it in Settings.',
    );
  }
  if (blocker.kind === 'key-other-project') {
    return t('Center 当前凭据属于其他 Google Cloud 项目，请核对并在独立设置页更新。',
      'Saved credentials belong to another Google Cloud project. Update them in Settings.',
    );
  }
  return describeBlocker(blocker, t);
}

function describeBlocker(blocker: GoogleSetupBlocker, t: (zh: string, en: string) => string): string {
  if (typeof blocker.message === 'string' && blocker.message.trim()) return blocker.message.trim();
  switch (blocker.kind) {
    case 'center-unreachable':
      return t('当前暂时无法连接 Center 核验状态，原有连接不受影响，请稍后重试检查。', 'Center is temporarily unreachable. Existing connections are unchanged; check again shortly.');
    case 'admin-required':
      return t('当前 Center 尚未配置 Google Web OAuth 应用，请联系 Center 管理员完成一次性配置。', 'Center does not have a Google Web OAuth app configured yet. Contact your Center administrator.');
    case 'no-key':
      return t('Center 尚未��存有效的 Web OAuth 凭据，请通过下方私密表单录入或重新创建。', 'Center has no saved Web OAuth client yet. Save it via the private form below or create a new client.');
    case 'key-gone':
      return t('Center 已保存的 Google 应用凭据已失效，请重新创建并私密录入 Web OAuth 凭据。', 'Saved Web OAuth client credentials are no longer valid. Create and save a new Web client.');
    case 'key-other-project':
      return t('Center 当前保存的 Web OAuth 凭据属于其他 Google Cloud 项目，请核对并重新录入。', 'Saved Web OAuth client belongs to a different Google Cloud project.');
    case 'other-account':
      return t(`系统浏览器中登录的是 ${blocker.signedIn ?? ''}，与目标账号 ${blocker.wanted ?? ''} 不同；请选择保留该账号或重新登录目标账号。`, `Signed in as ${blocker.signedIn ?? ''} instead of ${blocker.wanted ?? ''}. Keep this account or sign in again.`);
    case 'signed-out':
      return t(`账号 ${blocker.email ?? ''} 授权已失效，需要账号本人在系统浏览器重新连接。`, `Authorization for ${blocker.email ?? ''} ended. Reconnect in your system browser.`);
    case 'needs-permission':
      return t('部分所选 Google 服务尚未获得授权，你可以补授权或跳过未授权项继续。', 'Some selected Google services still need permission. Grant permission or continue without them.');
    case 'api-off':
      return t('Google Cloud 项目中尚未启用对应服务 API，请前往控制台启用后点重新检查。', 'Required Google Cloud APIs are still turned off. Enable them in Cloud Console, then check again.');
    case 'admin-blocked':
      return t('Google Workspace 组织管理员阻止了此应用访问所选服务，可复制说明发给管理员。', 'Your Google Workspace administrator blocked access. Copy the request note for your admin.');
    case 'check-failed':
      return t('探测 Google 服务就绪度时发生错误，请点重新检查。', 'Could not verify Google service readiness. Check again.');
    default:
      return t('当前步骤需要你的处理后才能继续。', 'Action needed before setup can continue.');
  }
}

export function GoogleSetupWizard({
  api,
  identity,
  scopeKey,
  botId,
  botName,
  isLocalAndroid = false,
  expectedRunId,
  expectedCard,
  expectedStep,
  expectedCardCopy,
  readOnly = false,
  autoStart = false,
  externalSetup,
  managedStatus = false,
  compactChat = false,
  callGoogleSetup,
  onOpenBrowser,
  onOpenBrowserDestination,
  onOpenCapabilities,
  onOpenCenterAdmin,
  onStatusUpdated,
  onSetupChange,
  onClose,
}: GoogleSetupWizardProps) {
  const t = useText();
  const effectiveScopeKey = scopeKey || botId;
  const mountedRef = useRef(true);
  const autoStartedRef = useRef(false);
  const onStatusUpdatedRef = useRef(onStatusUpdated);
  const activeScopeRef = useRef(effectiveScopeKey);
  activeScopeRef.current = effectiveScopeKey;
  const requestSeqRef = useRef(0);
  const orderByScopeRef = useRef<{ scopeKey: string; state: SetupResponseOrderState }>({
    scopeKey: effectiveScopeKey,
    state: { latestRevision: null, latestSeq: 0 },
  });
  const submittingRef = useRef(false);
  const statusInFlightRef = useRef(false);
  const lastServerChoicesKeyRef = useRef<string>(
    Array.isArray(externalSetup?.choices) ? externalSetup.choices.join(',') : '',
  );
  if (orderByScopeRef.current.scopeKey !== effectiveScopeKey) {
    orderByScopeRef.current = {
      scopeKey: effectiveScopeKey,
      state: { latestRevision: null, latestSeq: 0 },
    };
    submittingRef.current = false;
    statusInFlightRef.current = false;
    autoStartedRef.current = false;
    lastServerChoicesKeyRef.current = Array.isArray(externalSetup?.choices)
      ? externalSetup.choices.join(',')
      : '';
  }

  const [setup, setSetup] = useState<GoogleSetupControlState | null>(() => externalSetup ?? null);
  const [centerStatus, setCenterStatus] = useState<GoogleStatusSnapshot | null>(null);
  const [initializedScopeKey, setInitializedScopeKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resumeRetry, setResumeRetry] = useState<{ scope: string; runId: string; step?: string | null } | null>(null);
  const [showDirectConfig, setShowDirectConfig] = useState(false);
  const [signInConfig, setSignInConfig] = useState<{
    open: boolean;
    mode?: 'connect' | 'expand' | 'reconnect';
    targetAccount?: string;
    choices?: GoogleServiceChoice[];
  }>({ open: false });
  const [projectIdDraft, setProjectIdDraft] = useState<{ scope: string; runId: string; value: string } | null>(null);
  const [serviceDraft, setServiceDraft] = useState<GoogleServiceChoice[]>(() =>
    Array.isArray(externalSetup?.choices) && externalSetup.choices.length > 0
      ? externalSetup.choices
      : ['gmail', 'calendar'],
  );
  const [openMenu, setOpenMenu] = useState<'none' | 'mode' | 'more'>('none');
  const [openedStepKey, setOpenedStepKey] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (openMenu === 'none') return;
    const handlePointerDown = (event: PointerEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setOpenMenu('none');
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu('none');
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applySetupState = useCallback(
    (
      next: GoogleSetupControlState,
      reqScope: string,
      reqSeq: number,
      action: string,
      notifyParent = true,
    ): boolean => {
      if (!mountedRef.current || reqScope !== activeScopeRef.current) return false;
      if (!shouldAcceptGoogleSetupResponse(orderByScopeRef.current.state, next, reqSeq)) {
        return false;
      }
      orderByScopeRef.current = {
        scopeKey: reqScope,
        state: recordAcceptedGoogleSetupOrder(orderByScopeRef.current.state, next, reqSeq),
      };
      if (next.unavailable) {
        setUnavailableReason(
          next.reason ||
            t('当前 Host 暂不可运行向导控制，可使用私密表单直接录入凭据。',
              'Setup control is unavailable on this Host. Use the private credential form instead.',
            ),
        );
      } else {
        setUnavailableReason('');
      }
      setSetup(next);
      const hasResumeResult = action !== 'status' && action !== 'external' && next.applied !== false &&
        !isStaleGoogleSetupResult(next) && typeof next.resumeQueued === 'boolean';
      if (hasResumeResult) {
        setError('');
        setNotice('');
      }
      setResumeRetry(retry => {
        if (hasResumeResult) {
          return next.resumeQueued === false && next.id
            ? { scope: reqScope, runId: next.id, step: next.step }
            : null;
        }
        return retry?.scope === reqScope && retry.runId === next.id && retry.step === next.step && next.state === 'running'
          ? retry
          : null;
      });
      setProjectIdDraft(draft =>
        draft?.scope === reqScope && draft.runId === next.id &&
          normalizeSetupMode(next.mode ?? undefined) === 'guide-browser' && !next.projectId
          ? draft
          : null,
      );
      if (Array.isArray(next.choices) && next.choices.length > 0) {
        const nextChoicesKey = next.choices.join(',');
        if (nextChoicesKey !== lastServerChoicesKeyRef.current) {
          lastServerChoicesKeyRef.current = nextChoicesKey;
          setServiceDraft(next.choices);
        }
      }
      if (notifyParent) {
        onSetupChange?.(next, { action });
      }
      return true;
    },
    [onSetupChange, t],
  );

  useEffect(() => {
    if (!externalSetup) return;
    applySetupState(externalSetup, effectiveScopeKey, ++requestSeqRef.current, 'external', false);
  }, [applySetupState, effectiveScopeKey, externalSetup]);

  useEffect(() => {
    onStatusUpdatedRef.current = onStatusUpdated;
  }, [onStatusUpdated]);

  const refreshCenter = useCallback(async () => {
    if (!api || !identity) return null;
    const reqScope = effectiveScopeKey;
    try {
      const snap = await fetchGoogleStatus(api, identity);
      if (mountedRef.current && reqScope === activeScopeRef.current) {
        setCenterStatus(snap);
        onStatusUpdatedRef.current?.(snap);
      }
      return snap;
    } catch {
      return null;
    }
  }, [api, effectiveScopeKey, identity]);

  const refreshLatestAfterConflict = useCallback(
    async (reqScope: string) => {
      if (!callGoogleSetup) return;
      const statusSeq = ++requestSeqRef.current;
      const latest = await callGoogleSetup({ botId, action: 'status' }).catch(() => null);
      if (latest) {
        applySetupState(latest, reqScope, statusSeq, 'status', true);
      }
    },
    [applySetupState, botId, callGoogleSetup],
  );

  const sendControl = useCallback(
    async (
      payload: Record<string, unknown>,
      opts?: {
        silentError?: boolean;
        displayedSetup?: GoogleSetupControlState | null;
        skipSubmittingGuard?: boolean;
      },
    ) => {
      if (!callGoogleSetup) {
        setUnavailableReason(
          t('当前目标 Host 未提供 Google 向导控制通道，可直接通过私密表单录入 Web OAuth 凭据或前往中心管理。',
            'Google setup control is unavailable on this Host. Use the private credential form or Center Admin directly.',
          ),
        );
        return null;
      }
      const action = typeof payload.action === 'string' ? payload.action : '';
      const isMutation = action !== 'status';
      if (isMutation) {
        if (!opts?.skipSubmittingGuard && submittingRef.current) return null;
      } else if (statusInFlightRef.current) {
        return null;
      }

      const reqScope = effectiveScopeKey;
      const reqSeq = ++requestSeqRef.current;
      const displayedSetup = opts?.displayedSetup !== undefined ? opts.displayedSetup : setup;
      const wirePayload = buildGoogleSetupMutationPayload(displayedSetup, payload);

      if (isMutation) {
        if (!opts?.skipSubmittingGuard) submittingRef.current = true;
      } else {
        statusInFlightRef.current = true;
      }
      setBusy(true);
      if (!opts?.silentError) setError('');
      try {
        const next = await callGoogleSetup({ botId, ...wirePayload });
        if (!mountedRef.current || reqScope !== activeScopeRef.current) return null;
        const accepted = applySetupState(next, reqScope, reqSeq, action, true);
        if (!accepted) return null;
        if (isMutation && isStaleGoogleSetupResult(next)) {
          if (!opts?.silentError) {
            setError(
              t('向导进度已更新，已刷新为最新状态，未执行过期操作，请确认后再试。',
                'Setup state changed and has been refreshed. The outdated action was not applied — please review and try again.',
              ),
            );
          }
          return null;
        }
        return next;
      } catch (cause) {
        if (!mountedRef.current || reqScope !== activeScopeRef.current) return null;
        const info = classifyGoogleError(cause);
        if (info.code === 'SETUP_PROJECT_ID_REQUIRED' && !opts?.silentError) {
          setError(normalizeSetupMode(displayedSetup?.mode ?? undefined) === 'guide-browser'
            ? t('请填写 Google Cloud 控制台地址中 project= 后的 Project ID。',
              'Enter the Project ID from the project= parameter in the Cloud Console address.')
            : t('还没读到 Project ID。请在内嵌浏览器打开新项目的主页后继续。',
              'The Project ID is not available yet. Open the new project’s dashboard in the in-app browser, then continue.'));
          return null;
        }
        if (info.conflict) {
          // Re-sync latest revision on 409 / CAS mismatch; never auto-retry the outdated action.
          await refreshLatestAfterConflict(reqScope);
          if (mountedRef.current && reqScope === activeScopeRef.current && !opts?.silentError) {
            setError(
              t('向导进度已更新，已自动刷新为最新状态，未重试过期操作，请确认后再试。',
                'Setup state changed and has been refreshed. The outdated action was not retried — please confirm and try again.',
              ),
            );
          }
          return null;
        }
        if (info.unavailable) {
          setUnavailableReason(
            t('当前 Host 尚未启用 Google 建项向导控制，可直接录入 Web OAuth 凭据或前往中心管理。',
              'Google setup control is not available on this Host yet. Enter Web OAuth credentials directly or open Center Admin.',
            ),
          );
        } else if (info.offline) {
          if (!opts?.silentError) {
            setError(
              t('目标 Host 当前离线，请恢复在线后继续。',
                'Target Host is offline. Reconnect to continue.',
              ),
            );
          }
        } else if (!opts?.silentError) {
          setError(info.message);
        }
        return null;
      } finally {
        if (reqScope === activeScopeRef.current) {
          if (isMutation) {
            if (!opts?.skipSubmittingGuard) submittingRef.current = false;
          } else {
            statusInFlightRef.current = false;
          }
          if (mountedRef.current && !opts?.skipSubmittingGuard) setBusy(false);
        }
      }
    },
    [applySetupState, botId, callGoogleSetup, effectiveScopeKey, refreshLatestAfterConflict, setup, t],
  );

  /** Submit canonical service.js `answer` (`card` + `values` + displayed `runId`/`expectedRevision`/`step`/`cardCopy`). */
  const sendCardAnswer = useCallback(
    async (
      card: 'path' | 'account' | 'kind' | 'services' | 'step',
      values: string[],
      fallback?: (snapshot: GoogleSetupControlState | null) => Promise<GoogleSetupControlState | null>,
    ) => {
      if (!callGoogleSetup || submittingRef.current) return null;
      const reqScope = effectiveScopeKey;
      const reqSeq = ++requestSeqRef.current;
      const snapshot = setup;
      const wirePayload = buildGoogleSetupMutationPayload(snapshot, {
        action: 'answer',
        card,
        values,
      });

      submittingRef.current = true;
      setBusy(true);
      setError('');
      try {
        const next = await callGoogleSetup({ botId, ...wirePayload });
        if (!mountedRef.current || reqScope !== activeScopeRef.current) return null;
        const notifyAction =
          card === 'step' && values[0] === 'start-over' ? 'start-over' : 'answer';
        const accepted = applySetupState(next, reqScope, reqSeq, notifyAction, true);
        if (!accepted) return null;
        if (isStaleGoogleSetupResult(next)) {
          setError(
            t('向导进度已更新，已刷新为最新状态，未执行过期操作，请确认后再试。',
              'Setup state changed and has been refreshed. The outdated action was not applied — please review and try again.',
            ),
          );
          return null;
        }
        return next;
      } catch (cause) {
        if (!mountedRef.current || reqScope !== activeScopeRef.current) return null;
        const info = classifyGoogleError(cause);
        // If transport protocol layer does not yet whitelist `card`/`values`, invoke safe fallback with the same snapshot.
        if (info.invalidArgument && fallback) {
          submittingRef.current = false;
          try {
            return await fallback(snapshot);
          } finally {
            submittingRef.current = false;
          }
        }
        if (info.conflict) {
          await refreshLatestAfterConflict(reqScope);
          if (mountedRef.current && reqScope === activeScopeRef.current) {
            setError(
              t('向导进度已更新，已自动刷新为最新状态，未重试过期操作，请确认后再试。',
                'Setup state changed and has been refreshed. The outdated action was not retried — please confirm and try again.',
              ),
            );
          }
          return null;
        }
        setError(info.message);
        return null;
      } finally {
        if (reqScope === activeScopeRef.current) {
          submittingRef.current = false;
          if (mountedRef.current) setBusy(false);
        }
      }
    },
    [applySetupState, botId, callGoogleSetup, effectiveScopeKey, refreshLatestAfterConflict, setup, t],
  );

  useEffect(() => {
    let active = true;
    const init = async () => {
      if (managedStatus) {
        await refreshCenter();
        return;
      }
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
      if (active && mountedRef.current) setInitializedScopeKey(effectiveScopeKey);
    };
    void init();
    return () => {
      active = false;
    };
    // Run on mount or scope/bot/managedStatus switch; avoid re-running on every setup revision update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, botId, callGoogleSetup, effectiveScopeKey, managedStatus, refreshCenter]);

  const staleRun = Boolean(expectedRunId && setup?.id && setup.id !== expectedRunId);
  const staleCopy = Boolean(
    expectedCardCopy !== undefined &&
      setup?.card &&
      (!expectedCard || setup.card.card === expectedCard) &&
      (!expectedStep || setup.card.step === expectedStep) &&
      typeof setup.card.copy === 'number' &&
      expectedCardCopy < setup.card.copy,
  );
  const effectiveReadOnly = readOnly || staleRun || staleCopy;
  const activeMode = normalizeSetupMode(setup?.mode ?? undefined);
  const kindPending = setup?.state === 'running' && setup.card?.card === 'kind';

  const modeAvailMap = setup?.modeAvailability?.modes;
  const doItAvailable = !isLocalAndroid && setup?.canUseEmbeddedBrowser !== false && modeAvailMap?.['do-it-for-me']?.available !== false;
  const guideHereAvailable = !isLocalAndroid && setup?.canUseEmbeddedBrowser !== false && modeAvailMap?.['guide-here']?.available !== false;
  const embeddedSupported = doItAvailable || guideHereAvailable;
  const embeddedUnavailableDetail =
    modeAvailMap?.['do-it-for-me']?.reason || modeAvailMap?.['guide-here']?.reason || '';

  const steps = normalizeSetupSteps(setup?.steps);
  const currentStep =
    setup?.step ||
    steps.find(s => s.status === 'active' || s.status === 'needs-user' || s.status === 'waiting-human')?.id ||
    null;
  const needsExternalProjectId = currentStep === 'project' && activeMode === 'guide-browser' && !setup?.projectId;
  const projectIdInput = needsExternalProjectId && projectIdDraft?.scope === effectiveScopeKey &&
    projectIdDraft.runId === setup?.id ? projectIdDraft.value : '';
  const waitingForExternalProjectId = needsExternalProjectId && !projectIdInput.trim();
  const updateProjectIdDraft = (value: string) => {
    if (setup?.id) setProjectIdDraft({ scope: effectiveScopeKey, runId: setup.id, value });
  };
  const projectStepHint = needsExternalProjectId
    ? t('创建项目后，填写 Google Cloud 控制台地址中 project= 后的 Project ID。',
      'After creating the project, enter the Project ID from the project= parameter in the Cloud Console address.')
    : activeMode === 'do-it-for-me'
      ? t('Bot 会在内嵌浏览器读取 Project ID，需要你操作时会提示。',
        'The bot reads the Project ID in the in-app browser and prompts you when it needs your help.')
      : activeMode === 'guide-here'
        ? t('在内嵌浏览器创建项目，等项目主页打开后继续。Bot 会自动读取 Project ID。',
          'Create the project in the in-app browser and continue after its dashboard opens. The bot reads the Project ID automatically.')
        : compactStepCopy('project', t).hint;

  const effectiveCenterClient = centerStatus?.client ?? setup?.center?.client;
  const effectiveCenterAccounts = centerStatus?.accounts ?? setup?.center?.accounts ?? [];
  const redirectUri =
    setup?.brandingLinks?.redirectUri ||
    setup?.redirectUri ||
    effectiveCenterClient?.redirectUri;
  const clientConfigured = Boolean(effectiveCenterClient?.configured);
  const hasConnectedAccount = Boolean(effectiveCenterAccounts.some(a => a.status === 'connected'));
  const nonAdminBlocked =
    setup?.center?.isAdmin === false || setup?.blocker?.kind === 'admin-required';
  const browserLocked = Boolean(setup?.browserLock?.active || setup?.browserTakeoverRequired);
  const lockRequiresSystemBrowser = Boolean(setup?.browserLock?.requiresSystemBrowser);
  const browserLockHint = setup?.browserPrompt || setupBrowserLockHint(setup?.browserLock, t);
  const isEmbeddedAccountStep = setup?.state === 'running' && currentStep === 'account' &&
    (activeMode === 'do-it-for-me' || activeMode === 'guide-here') &&
    setup.card?.card !== 'path' && setup.card?.card !== 'services';
  const embeddedAccountHint = t('如果 Google 要求登录，请接管页面后登录。', 'If Google asks you to sign in, take over the page and sign in.');
  const openBrowserLabel = isEmbeddedAccountStep
    ? t('打开 Google 登录页', 'Open Google sign-in page')
    : t('查看内置浏览器', 'Open built-in browser');

  const openPreparedBrowser = (updated: GoogleSetupControlState | null) => {
    if (!onOpenBrowser || !updated?.browserPageId || updated.unavailable || updated.state !== 'running' ||
        (updated.mode !== 'do-it-for-me' && updated.mode !== 'guide-here') || updated.browserLock?.requiresSystemBrowser) {
      return false;
    }
    onOpenBrowser();
    return true;
  };

  const handleOpenCurrentBrowser = async () => {
    if (!onOpenBrowser || effectiveReadOnly || submittingRef.current) return;
    if (!isEmbeddedAccountStep) {
      const destinationUrl = googleSetupConsoleUrl(currentStep, setup ?? undefined);
      if (activeMode === 'guide-here' && !browserLocked && destinationUrl && onOpenBrowserDestination) {
        onOpenBrowserDestination({ url: destinationUrl, pageId: setup?.browserPageId });
        return;
      }
      onOpenBrowser();
      return;
    }
    if (lockRequiresSystemBrowser) return;
    const updated = browserLocked ? setup : await sendControl({ action: 'resume' });
    if (updated && !openPreparedBrowser(updated)) {
      setError(t('无法打开 Google 登录页。请重试，或改用外部浏览器。', 'Could not open Google sign-in. Try again or use your system browser.'));
    }
  };

  const handleCompleteStep = async (step = currentStep) => {
    if (!step || kindPending || effectiveReadOnly || submittingRef.current || !setup?.id || setup.state !== 'running') return;
    const projectId = step === 'project' && needsExternalProjectId ? projectIdInput.trim() : undefined;
    if (projectId === '') return;
    await sendControl({
      action: 'advance',
      step,
      ...(projectId ? { projectId } : {}),
    });
  };
  const canCompleteCurrentStep = setup?.state === 'running' && !kindPending && currentStep !== 'connect' && Boolean(currentStep) &&
    (activeMode === 'guide-browser' || activeMode === 'guide-here' || currentStep === 'account' ||
      browserLocked || steps.some(item => item.id === currentStep && item.status === 'needs-user'));

  const handleSelectMode = async (mode: GoogleSetupMode) => {
    if (effectiveReadOnly || submittingRef.current) return;
    if (mode === 'do-it-for-me' && !doItAvailable) return;
    if (mode === 'guide-here' && !guideHereAvailable) return;
    const snapshot = setup;
    let updated: GoogleSetupControlState | null = null;
    if (!snapshot?.id || snapshot.state === 'idle' || snapshot.state === 'not_started') {
      if (compactChat) return;
      updated = await sendControl({ action: 'start', mode });
    } else if (snapshot.mode === 'unchosen' || snapshot.card?.card === 'path') {
      updated = await sendCardAnswer('path', [mode], captured =>
        sendControl({ action: 'resume', mode }, { displayedSetup: captured }),
      );
    } else {
      updated = await sendControl({ action: 'resume', mode }, { displayedSetup: snapshot });
    }
    if (updated?.applied !== false) openPreparedBrowser(updated);
  };

  const handleSaveServiceChoices = async () => {
    if (effectiveReadOnly || submittingRef.current || serviceDraft.length === 0) return;
    const snapshot = setup;
    if (!snapshot?.id || snapshot.state === 'idle' || snapshot.state === 'not_started') {
      if (compactChat) return;
      await sendControl({ action: 'start', choices: serviceDraft });
      return;
    }
    const updated = await sendCardAnswer('services', serviceDraft, captured =>
      sendControl(
        {
          action: 'advance',
          choices: serviceDraft,
          ...(currentStep ? { step: currentStep } : {}),
        },
        { displayedSetup: captured },
      ),
    );
    if (updated?.applied !== false) openPreparedBrowser(updated);
  };

  const handleBlockerAction = async (action: GoogleSetupAction) => {
    if (effectiveReadOnly || submittingRef.current) return;
    const snapshot = setup;
    setNotice('');
    setError('');
    switch (action.id) {
      case 'done':
        await handleCompleteStep(action.step || currentStep);
        return;
      case 'open-browser':
      case 'take-over-browser':
      case 'takeover-browser':
        await handleOpenCurrentBrowser();
        return;
      case 'take-over':
        if (browserLocked && onOpenBrowser) {
          await handleOpenCurrentBrowser();
          return;
        }
        await sendCardAnswer('step', ['take-over'], captured =>
          sendControl({ action: 'resume', mode: 'do-it-for-me' }, { displayedSetup: captured }),
        );
        return;
      case 'let-me':
        await sendCardAnswer('step', ['let-me', action.step || currentStep || 'branding'], captured =>
          sendControl({ action: 'resume', mode: 'guide-here' }, { displayedSetup: captured }),
        );
        return;
      case 'make-new-key':
        await sendCardAnswer('step', ['redo', 'client'], () => {
          if (compactChat) {
            if (onOpenCapabilities) onOpenCapabilities();
            else if (onOpenCenterAdmin) onOpenCenterAdmin();
          } else {
            setShowDirectConfig(true);
          }
          return Promise.resolve(null);
        });
        return;
      case 'import-key':
      case 'configure-client':
        if (compactChat) {
          if (onOpenCapabilities) onOpenCapabilities();
          else if (onOpenCenterAdmin) onOpenCenterAdmin();
          else {
            setNotice(
              t('请前往独立能力设置或中心管理录入 Web OAuth 凭据。',
                'Open Capabilities or Center Admin to save Web OAuth credentials.',
              ),
            );
          }
          return;
        }
        setShowDirectConfig(true);
        return;
      case 'sign-in':
      case 'allow':
      case 'sign-in-again':
      case 'connect':
        setSignInConfig({
          open: true,
          mode: action.id === 'sign-in-again' ? 'reconnect' : action.id === 'allow' ? 'expand' : 'connect',
          targetAccount: action.email || snapshot?.account,
          choices: action.services ?? snapshot?.choices,
        });
        return;
      case 'continue-without':
        if (Array.isArray(action.services) && action.services.length > 0) {
          await sendCardAnswer('step', ['continue-without', ...action.services]);
        }
        return;
      case 'keep-account':
        if (action.email) {
          await sendCardAnswer('step', ['keep-account', action.email], captured =>
            sendControl(
              { action: 'advance', account: action.email, step: 'connect' },
              { displayedSetup: captured },
            ),
          );
        }
        return;
      case 'turn-on': {
        const targetUrl =
          action.url ||
          snapshot?.blocker?.enableUrls?.[0]?.url ||
          snapshot?.blocker?.enableUrl ||
          'https://console.cloud.google.com/apis/library';
        await openExternalUrl(targetUrl);
        return;
      }
      case 'copy-for-admin': {
        const text = googleAdminTrustRequestText(effectiveCenterClient?.clientId, t);
        try {
          await navigator.clipboard.writeText(text);
          setNotice(t('已复制管理员申请说明，请发送给 Workspace 或 Center 管理员。', 'Copied administrator instructions to clipboard.'));
        } catch {
          setError(t('无法复制到剪贴板。', 'Could not copy to clipboard.'));
        }
        return;
      }
      case 'check-again': {
        submittingRef.current = true;
        setBusy(true);
        try {
          if (api && identity) {
            try {
              await checkGoogleAccount(api, identity, action.email || snapshot?.account || '');
              await refreshCenter();
            } catch (cause) {
              if (mountedRef.current) setError(classifyGoogleError(cause).message);
            }
          }
          if (!mountedRef.current) return;
          if (currentStep === 'client' || currentStep === 'connect') {
            await sendControl(
              { action: 'advance', step: currentStep },
              { displayedSetup: snapshot, skipSubmittingGuard: true },
            );
          } else {
            await sendControl(
              { action: 'resume' },
              { displayedSetup: snapshot, skipSubmittingGuard: true },
            );
          }
        } finally {
          submittingRef.current = false;
          if (mountedRef.current) setBusy(false);
        }
        return;
      }
      case 'cancel':
        await sendControl({ action: 'cancel' }, { displayedSetup: snapshot });
        return;
      case 'resume':
      case 'continue':
        await sendCardAnswer('step', ['resume'], captured =>
          sendControl({ action: 'resume' }, { displayedSetup: captured }),
        );
        return;
      case 'start-over':
        if (snapshot?.id) {
          await sendCardAnswer('step', ['start-over']);
        } else if (!compactChat) {
          await sendControl({ action: 'start', restart: true });
        }
        return;
      default:
        await sendCardAnswer('step', [action.id, ...(action.step ? [action.step] : [])], captured =>
          sendControl({ action: 'resume' }, { displayedSetup: captured }),
        );
    }
  };

  const waitingForInitialStatus =
    !managedStatus && initializedScopeKey !== effectiveScopeKey && Boolean(callGoogleSetup || (api && identity));
  if (waitingForInitialStatus) {
    return (
      <div className="gws-card" role="status">
        <div className="gws-card-head">
          <span className="gws-card-title">{t('Google 应用建项向导', 'Google Workspace Setup')}</span>
          <span className="gws-pill is-muted">{t('读取真实状态…', 'Loading status…')}</span>
        </div>
      </div>
    );
  }

  if (staleRun || staleCopy) {
    return (
      <div className="gws-card is-muted">
        <div className="gws-card-head">
          <span className="gws-card-title">{t('Google 应用建项向导', 'Google Workspace Setup')}</span>
          <span className="gws-pill is-muted">{t('历史快照', 'Previous card')}</span>
        </div>
        <p className="gws-muted">
          {t('此向导卡片已由最新进度替代，请以最新卡片或 Bot 能力页为准。', 'This setup card has been superseded. Follow the latest card or Bot Capabilities.')}
        </p>
      </div>
    );
  }

  const stepInfo = currentStep ? googleStepInstructions(currentStep, redirectUri, t) : null;
  const externalProjectUrl = currentStep === 'project' && activeMode === 'guide-browser'
    ? googleSetupConsoleUrl(currentStep, setup ?? undefined)
    : null;
  const stepGuideLines = isEmbeddedAccountStep
    ? [embeddedAccountHint]
    : currentStep === 'project'
      ? [...(stepInfo?.lines ?? []), projectStepHint]
      : stepInfo?.lines ?? [];
  const setupCompleted =
    (setup?.state === 'done' || setup?.state === 'completed') && clientConfigured && hasConnectedAccount;
  const setupClaimsDoneWithoutCenter =
    (setup?.state === 'done' || setup?.state === 'completed') && (!clientConfigured || !hasConnectedAccount);
  const canAnswerKind = Boolean(callGoogleSetup && setup?.id && !effectiveReadOnly && !setup.unavailable);
  const handleChooseKind = async (kind: 'personal' | 'work') => {
    if (!kindPending || !canAnswerKind || submittingRef.current) return;
    setNotice('');
    await sendCardAnswer('kind', [kind]);
  };
  const kindSelection = kindPending && !nonAdminBlocked && !unavailableReason ? (
    <div className={compactChat ? 'gws-compact-body' : 'gws-section-block'}>
      <div className={compactChat ? 'gws-compact-step-title' : 'gws-label-xs'}>
        {t('选择 Google 应用受众', 'Choose the audience for the Google app')}
      </div>
      <p className={compactChat ? 'gws-compact-step-hint' : 'gws-muted'}>
        {t('只有项目属于对应的 Google Workspace 组织，且应用仅供该组织成员使用时，才选择「内部」。',
          'Choose Internal only when the project belongs to the Google Workspace organization and the app is for its members only.')}
      </p>
      <div className={compactChat ? 'gws-compact-actions' : 'gws-actions'}>
        <button type="button" className="gws-btn is-sm" disabled={busy || !canAnswerKind} onClick={() => void handleChooseKind('personal')}>
          {t('个人账号或组织外用户（外部）', 'Personal account or outside users (External)')}
        </button>
        <button type="button" className="gws-btn is-sm" disabled={busy || !canAnswerKind} onClick={() => void handleChooseKind('work')}>
          {t('公司或学校组织内成员（内部）', 'Company or school members (Internal)')}
        </button>
      </div>
    </div>
  ) : null;
  const activeBlockerActions =
    (Array.isArray(setup?.blocker?.actions) && setup.blocker.actions.length > 0
      ? setup.blocker.actions
      : setup?.actions) ?? [];
  const resumeRetryNotice = resumeRetry?.scope === effectiveScopeKey && resumeRetry.runId === setup?.id &&
    resumeRetry.step === setup?.step && setup?.state === 'running' ? (
      <div className={compactChat ? 'gws-compact-body' : 'gws-section-block'}>
        <p className={compactChat ? 'gws-compact-notice' : 'gws-notice'} role="status">
          {t('向导进度已保存。Bot 续跑请求提交失败。', 'Setup progress is saved. The request to resume the bot failed.')}
        </p>
        {!setup.blocker && !setup.unavailable && !effectiveReadOnly && callGoogleSetup ? (
          <div className={compactChat ? 'gws-compact-actions' : 'gws-actions'}>
            <button type="button" className="gws-btn is-primary is-sm" disabled={busy}
              onClick={() => void handleBlockerAction({ id: 'continue' })}>
              {compactBlockerLabel({ id: 'continue' }, t)}
            </button>
          </div>
        ) : null}
      </div>
    ) : null;

  if (compactChat) {
    const canMutateChat = !effectiveReadOnly && Boolean(setup?.id) && !setup?.unavailable;
    const currentStepItem = currentStep ? steps.find(item => item.id === currentStep) : undefined;
    const stepExternalUrl =
      currentStepItem?.url ||
      (currentStep === 'apis'
        ? setup?.blocker?.enableUrls?.[0]?.url || setup?.blocker?.enableUrl || null
        : null) ||
      googleSetupConsoleUrl(currentStep, {
        projectId: setup?.projectId,
        choices: setup?.choices,
        account: setup?.account,
      });
    const stepVisitKey = setup?.id && currentStep ? `${setup.id}:${currentStep}` : '';
    const hasOpenedExternalStep = Boolean(stepVisitKey && openedStepKey === stepVisitKey);
    const activeCardKind = setup?.card?.card ?? null;
    const isPathSelection = !setupCompleted && !nonAdminBlocked && (activeCardKind === 'path' || (Boolean(setup?.id) && activeMode === null));
    const isServicesSelection = !setupCompleted && !nonAdminBlocked && activeCardKind === 'services';
    const isAccountSelection =
      !setupCompleted &&
      !nonAdminBlocked &&
      activeCardKind === 'account' &&
      Array.isArray(setup?.accounts) &&
      setup.accounts.length > 0;
    const isSignInFlowActive =
      Boolean(api && identity) &&
      !effectiveReadOnly &&
      clientConfigured &&
      !setupCompleted &&
      (signInConfig.open || currentStep === 'connect');
    const isExternalStepFlow =
      !setupCompleted &&
      !nonAdminBlocked &&
      !isPathSelection &&
      !isServicesSelection &&
      !isAccountSelection &&
      !kindPending &&
      !isSignInFlowActive &&
      Boolean(currentStep) &&
      activeMode === 'guide-browser';
    const isEmbeddedStepFlow =
      !setupCompleted &&
      !nonAdminBlocked &&
      !isPathSelection &&
      !isServicesSelection &&
      !isAccountSelection &&
      !kindPending &&
      !isSignInFlowActive &&
      Boolean(currentStep) &&
      (activeMode === 'do-it-for-me' || activeMode === 'guide-here');
    const stepCopy = currentStep ? compactStepCopy(currentStep, t) : null;
    const stepHint = currentStep === 'project' ? projectStepHint : stepCopy?.hint;
    const hasPrimaryStepContinue = Boolean(
      canMutateChat &&
        (isExternalStepFlow || isEmbeddedStepFlow) && canCompleteCurrentStep,
    );
    const settingsEntryAction = onOpenCapabilities ?? onOpenCenterAdmin;
    const settingsEntryLabel = onOpenCapabilities
      ? t('前往设置录入凭据', 'Save credentials in Settings')
      : t('前往中心管理录入', 'Save in Center Admin');
    const blockerKind = setup?.blocker?.kind ?? '';
    const extraBlockerActions = activeBlockerActions.filter(action => {
      if (hasPrimaryStepContinue && action.id === 'done') return false;
      if (browserLocked && (action.id === 'takeover-browser' || action.id === 'take-over-browser' || action.id === 'open-browser' || action.id === 'done')) {
        return false;
      }
      if (
        currentStep === 'client' &&
        (action.id === 'configure-client' || action.id === 'import-key' || (hasPrimaryStepContinue && action.id === 'check-again'))
      ) {
        return false;
      }
      if (isSignInFlowActive && (action.id === 'sign-in' || action.id === 'connect' || action.id === 'check-again')) {
        return false;
      }
      return true;
    });
    const suppressRedundantNeedsUser =
      blockerKind === 'needs-user' &&
      !setup?.blocker?.message &&
      extraBlockerActions.length === 0 &&
      (hasPrimaryStepContinue || browserLocked || isSignInFlowActive);
    const showCompactBlocker = Boolean(
      setup?.blocker &&
        !nonAdminBlocked &&
        !setupCompleted &&
        !suppressRedundantNeedsUser,
    );
    const canCancelRun = Boolean(
      callGoogleSetup &&
        setup?.id &&
        !setupCompleted &&
        !setup.unavailable &&
        (setup.state === 'running' || setup.state === 'failed') &&
        !effectiveReadOnly,
    );
    const handleOpenStepUrl = (url: string) => {
      if (stepVisitKey) setOpenedStepKey(stepVisitKey);
      void openExternalUrl(url);
    };
    const handleCopyRedirectUri = async () => {
      if (!redirectUri) return;
      try {
        await navigator.clipboard.writeText(redirectUri);
        setNotice(t('已复制回调地址。', 'Copied redirect URI.'));
      } catch {
        setError(t('无法复制到剪贴板。', 'Could not copy to clipboard.'));
      }
    };

    return (
      <section className="gws-compact-card" aria-label={t('Google 配置', 'Google setup')}>
        <div className="gws-compact-head">
          <div className="gws-compact-title-group">
            <span className="gws-compact-title">{t('Google 配置', 'Google setup')}</span>
            {botName ? <span className="gws-compact-bot">{botName}</span> : null}
          </div>

          <div className="gws-compact-head-actions" ref={menuContainerRef}>
            {activeMode && !setupCompleted ? (
              <div className="gws-popover-anchor">
                <button
                  type="button"
                  className="gws-compact-chip"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === 'mode'}
                  disabled={busy}
                  onClick={() => setOpenMenu(prev => (prev === 'mode' ? 'none' : 'mode'))}
                >
                  <span>{compactModeLabel(activeMode, t)}</span>
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
                {openMenu === 'mode' ? (
                  <div className="gws-popover" role="menu" aria-label={t('切换操作方式', 'Switch mode')}>
                    {ALL_MODES.map(mode => {
                      const available =
                        mode === 'guide-browser'
                          ? true
                          : mode === 'do-it-for-me'
                            ? doItAvailable
                            : guideHereAvailable;
                      const isSelected = activeMode === mode;
                      const disabledItem = !available || !canMutateChat || busy;
                      return (
                        <button
                          key={mode}
                          type="button"
                          role="menuitemradio"
                          aria-checked={isSelected}
                          disabled={disabledItem}
                          className={`gws-popover-item${isSelected ? ' is-selected' : ''}`}
                          onClick={() => {
                            setOpenMenu('none');
                            if (!isSelected) void handleSelectMode(mode);
                          }}
                        >
                          <span className="gws-popover-item-row">
                            <span className="gws-popover-item-title">{compactModeLabel(mode, t)}</span>
                            {isSelected ? <Check size={13} aria-hidden="true" /> : null}
                            {!available ? (
                              <span className="gws-popover-badge">{t('不可用', 'Unavailable')}</span>
                            ) : null}
                          </span>
                          <span className="gws-popover-item-hint">{compactModeHint(mode, t)}</span>
                        </button>
                      );
                    })}
                    {!embeddedSupported ? (
                      <p className="gws-popover-note">
                        {humanizeEmbeddedReason(embeddedUnavailableDetail, isLocalAndroid, t)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="gws-popover-anchor">
              <button
                type="button"
                className="gws-icon-btn"
                aria-label={t('更多操作', 'More actions')}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'more'}
                onClick={() => setOpenMenu(prev => (prev === 'more' ? 'none' : 'more'))}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </button>
              {openMenu === 'more' ? (
                <div className="gws-popover is-compact-menu" role="menu" aria-label={t('更多操作', 'More actions')}>
                  {onOpenBrowser && !effectiveReadOnly && embeddedSupported && !lockRequiresSystemBrowser &&
                    setup?.card?.card !== 'services' && (activeMode === 'do-it-for-me' || activeMode === 'guide-here') ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="gws-popover-item"
                      onClick={() => {
                        setOpenMenu('none');
                        void handleOpenCurrentBrowser();
                      }}
                    >
                      <span className="gws-popover-item-row">
                        <Globe size={13} aria-hidden="true" />
                        <span className="gws-popover-item-title">{openBrowserLabel}</span>
                      </span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    className="gws-popover-item"
                    disabled={busy}
                    onClick={() => {
                      setOpenMenu('none');
                      void refreshCenter();
                      if (callGoogleSetup) void sendControl({ action: 'status' });
                    }}
                  >
                    <span className="gws-popover-item-row">
                      <RefreshCw size={13} aria-hidden="true" />
                      <span className="gws-popover-item-title">{t('重新检查状态', 'Refresh status')}</span>
                    </span>
                  </button>
                  {onOpenCapabilities ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="gws-popover-item"
                      onClick={() => {
                        setOpenMenu('none');
                        onOpenCapabilities();
                      }}
                    >
                      <span className="gws-popover-item-row">
                        <Lock size={13} aria-hidden="true" />
                        <span className="gws-popover-item-title">{t('前往能力设置录入凭据', 'Open Capabilities settings')}</span>
                      </span>
                    </button>
                  ) : null}
                  {onOpenCenterAdmin ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="gws-popover-item"
                      onClick={() => {
                        setOpenMenu('none');
                        onOpenCenterAdmin();
                      }}
                    >
                      <span className="gws-popover-item-row">
                        <ExternalLink size={13} aria-hidden="true" />
                        <span className="gws-popover-item-title">{t('前往中心管理', 'Open Center Admin')}</span>
                      </span>
                    </button>
                  ) : null}
                  {canCancelRun ? (
                    <>
                      <div className="gws-popover-sep" role="separator" />
                      <button
                        type="button"
                        role="menuitem"
                        className="gws-popover-item is-danger"
                        disabled={busy}
                        onClick={() => {
                          setOpenMenu('none');
                          void sendControl({ action: 'cancel' }, { displayedSetup: setup });
                        }}
                      >
                        <span className="gws-popover-item-row">
                          <span className="gws-popover-item-title">{t('中止向导', 'Cancel setup')}</span>
                        </span>
                      </button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>

            {onClose ? (
              <button
                type="button"
                className="gws-icon-btn"
                aria-label={t('收起向导', 'Collapse setup')}
                onClick={onClose}
              >
                <ChevronDown size={15} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {setupCompleted ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{t('Google 应用配置已完成', 'Google setup complete')}</div>
            <p className="gws-compact-step-hint">
              {t('已完成连接与 Center 核验，现在可以在聊天里继续使用 Google 服务。', 'Connected and verified by Center. You can continue using Google services in chat.')}
            </p>
          </div>
        ) : null}

        {/* Non-admin permission gate */}
        {nonAdminBlocked && !clientConfigured ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{t('需要 Center 管理员完成一次性配置', 'Center admin setup required')}</div>
            <p className="gws-compact-step-hint">
              {t('当前账号不是 Center 管理员，请先请管理员配置 Google OAuth 应用。', 'Ask your Center administrator to configure the Google OAuth app first.')}
            </p>
            {!effectiveReadOnly ? (
              <div className="gws-compact-actions">
                <button
                  type="button"
                  className="gws-btn is-primary is-sm"
                  disabled={busy}
                  onClick={() => void handleBlockerAction({ id: 'copy-for-admin' })}
                >
                  <Copy size={13} aria-hidden="true" />
                  <span>{t('复制管理员指引', 'Copy admin guide')}</span>
                </button>
                <button
                  type="button"
                  className="gws-btn is-ghost is-sm"
                  disabled={busy || !canMutateChat}
                  onClick={() => void handleBlockerAction({ id: 'check-again' })}
                >
                  <span>{t('重新检查', 'Check again')}</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Host claims done without verified Center status */}
        {setupClaimsDoneWithoutCenter ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{t('等待 Center 确认连接结果', 'Waiting for Center verification')}</div>
            <p className="gws-compact-step-hint">
              {t('尚未在 Center 核验到已连接的 Google 账号，连接状态以 Center 实际结果为准。', 'Center has not verified a connected Google account yet.')}
            </p>
            <div className="gws-compact-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={busy}
                onClick={() => {
                  void refreshCenter();
                  if (callGoogleSetup) void sendControl({ action: 'status' });
                }}
              >
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重新检查', 'Check again')}</span>
              </button>
              {onOpenCapabilities ? (
                <button type="button" className="gws-btn is-ghost is-sm" onClick={onOpenCapabilities}>
                  <span>{t('前往能力设置', 'Open capabilities')}</span>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Unavailable host control */}
        {unavailableReason && !nonAdminBlocked && !setupClaimsDoneWithoutCenter ? (
          <div className="gws-compact-body">
            <p className="gws-compact-step-hint">{unavailableReason}</p>
            {settingsEntryAction ? (
              <div className="gws-compact-actions">
                <button type="button" className="gws-btn is-primary is-sm" onClick={settingsEntryAction}>
                  <span>{settingsEntryLabel}</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Mode selection step (only when path is still unchosen) */}
        {isPathSelection && !unavailableReason ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{t('选择操作方式', 'Choose how to set up')}</div>
            <div className="gws-compact-actions">
              {ALL_MODES.filter(mode =>
                mode === 'guide-browser'
                  ? true
                  : mode === 'do-it-for-me'
                    ? doItAvailable
                    : guideHereAvailable,
              ).map((mode, idx) => (
                <button
                  key={mode}
                  type="button"
                  className={`gws-btn is-sm${idx === 0 ? ' is-primary' : ''}`}
                  disabled={busy || !canMutateChat}
                  onClick={() => void handleSelectMode(mode)}
                >
                  {compactModeLabel(mode, t)}
                </button>
              ))}
            </div>
            {!embeddedSupported ? (
              <p className="gws-compact-step-hint">
                {humanizeEmbeddedReason(embeddedUnavailableDetail, isLocalAndroid, t)}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Service choices step */}
        {isServicesSelection && !unavailableReason ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{t('选择要启用的 Google 服务', 'Choose Google services')}</div>
            <div className="gws-compact-pills" role="group" aria-label={t('选择 Google 服务', 'Choose Google services')}>
              {GOOGLE_SERVICE_CHOICES.map(choice => {
                const checked = serviceDraft.includes(choice);
                return (
                  <label key={choice} className={`gws-compact-check${checked ? ' is-selected' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || !canMutateChat}
                      onChange={() =>
                        setServiceDraft(prev =>
                          prev.includes(choice)
                            ? prev.filter(item => item !== choice)
                            : GOOGLE_SERVICE_CHOICES.filter(c => prev.includes(c) || c === choice),
                        )
                      }
                    />
                    <span>{googleChoiceLabel(choice, t)}</span>
                  </label>
                );
              })}
            </div>
            <div className="gws-compact-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={busy || !canMutateChat || serviceDraft.length === 0}
                onClick={() => void handleSaveServiceChoices()}
              >
                {t('确认并继续', 'Confirm & continue')}
              </button>
            </div>
          </div>
        ) : null}

        {/* Multi-account selection step */}
        {isAccountSelection && !unavailableReason ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{t('选择 Google Cloud 账号', 'Choose Google Cloud account')}</div>
            <div className="gws-compact-actions">
              {setup!.accounts!.map(email => (
                <button
                  key={email}
                  type="button"
                  className="gws-btn is-sm"
                  disabled={busy || !canMutateChat}
                  onClick={() =>
                    void sendCardAnswer('account', [email], captured =>
                      sendControl({ action: 'advance', account: email, step: 'account' }, { displayedSetup: captured }),
                    )
                  }
                >
                  {email}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {kindSelection}

        {/* Sensitive takeover banner (real privacy boundary) */}
        {browserLocked && !setupCompleted ? (
          <div className="gws-compact-alert is-warn" role="alert">
            <div className="gws-compact-alert-text">
              <strong>{t('此步骤需你亲自完成', 'Your turn')}</strong>
              <span>{browserLockHint}</span>
            </div>
            {!effectiveReadOnly ? (
              <div className="gws-compact-actions">
                {onOpenBrowser && embeddedSupported && !lockRequiresSystemBrowser ? (
                  <button type="button" className="gws-btn is-warn is-sm" onClick={() => void handleOpenCurrentBrowser()}>
                    <Globe size={13} aria-hidden="true" />
                    <span>{t('接管当前页面', 'Take over page')}</span>
                  </button>
                ) : null}
                {canMutateChat && currentStep && currentStep !== 'connect' && !hasPrimaryStepContinue ? (
                  <button
                    type="button"
                    className="gws-btn is-primary is-sm"
                    disabled={busy || waitingForExternalProjectId}
                    onClick={() => void handleCompleteStep()}
                  >
                    {stepCopy?.continueLabel || t('已完成，继续', 'Done, continue')}
                  </button>
                ) : null}
                {activeMode !== 'guide-browser' && canMutateChat ? (
                  <button
                    type="button"
                    className="gws-btn is-ghost is-sm"
                    disabled={busy}
                    onClick={() => void handleSelectMode('guide-browser')}
                  >
                    {t('改用外部浏览器', 'Use system browser')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Active step: External browser guidance */}
        {isExternalStepFlow && stepCopy && !unavailableReason ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{stepCopy.title}</div>
            {stepHint ? <p className="gws-compact-step-hint">{stepHint}</p> : null}

            {currentStep === 'client' && redirectUri ? (
              <div className="gws-compact-copy-row">
                <span className="gws-compact-copy-label">{t('回调地址', 'Redirect URI')}</span>
                <code className="gws-compact-code">{redirectUri}</code>
                <button
                  type="button"
                  className="gws-icon-btn"
                  aria-label={t('复制回调地址', 'Copy redirect URI')}
                  onClick={() => void handleCopyRedirectUri()}
                >
                  <Copy size={13} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            {needsExternalProjectId && canMutateChat ? (
              <input
                type="text"
                className="gws-input gws-compact-input"
                value={projectIdInput}
                disabled={busy}
                placeholder="Project ID"
                aria-label={t('Google Cloud Project ID', 'Google Cloud Project ID')}
                onChange={e => updateProjectIdDraft(e.target.value)}
              />
            ) : null}

            {!effectiveReadOnly ? (
              <div className="gws-compact-actions">
                {stepExternalUrl ? (
                  <button
                    type="button"
                    className={`gws-btn is-sm${hasOpenedExternalStep ? ' is-ghost' : ' is-primary'}`}
                    onClick={() => handleOpenStepUrl(stepExternalUrl)}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                    <span>{hasOpenedExternalStep ? t('重新打开', 'Reopen') : stepCopy.openLabel}</span>
                  </button>
                ) : null}

                {currentStep === 'client' && settingsEntryAction && !clientConfigured ? (
                  <button
                    type="button"
                    className={`gws-btn is-sm${hasOpenedExternalStep ? ' is-primary' : ''}`}
                    onClick={settingsEntryAction}
                  >
                    <Lock size={13} aria-hidden="true" />
                    <span>{settingsEntryLabel}</span>
                  </button>
                ) : null}

                {currentStep === 'connect' && !clientConfigured ? (
                  <>
                    {settingsEntryAction ? (
                      <button
                        type="button"
                        className="gws-btn is-primary is-sm"
                        onClick={settingsEntryAction}
                      >
                        <Lock size={13} aria-hidden="true" />
                        <span>{settingsEntryLabel}</span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="gws-btn is-ghost is-sm"
                      disabled={busy}
                      onClick={() => {
                        void refreshCenter();
                        if (callGoogleSetup) void sendControl({ action: 'status' });
                      }}
                    >
                      <span>{t('重新检查', 'Check again')}</span>
                    </button>
                  </>
                ) : null}

                {currentStep !== 'connect' ? (
                  <button
                    type="button"
                    className={`gws-btn is-sm${
                      currentStep === 'client' && !clientConfigured && settingsEntryAction
                        ? ' is-ghost'
                        : !stepExternalUrl || hasOpenedExternalStep
                          ? ' is-primary'
                          : ''
                    }`}
                    disabled={busy || !canMutateChat || waitingForExternalProjectId}
                    onClick={() => void handleCompleteStep()}
                  >
                    {stepCopy.continueLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Active step: Embedded / Auto mode */}
        {isEmbeddedStepFlow && stepCopy && !unavailableReason ? (
          <div className="gws-compact-body">
            <div className="gws-compact-step-title">{stepCopy.title}</div>
            <p className="gws-compact-step-hint">
              {isEmbeddedAccountStep ? embeddedAccountHint : activeMode === 'do-it-for-me' && currentStep !== 'project'
                ? t('Bot 正在内置浏览器处理当前步骤，需要你操作时会自动提示。', 'Bot is working on this step in the built-in browser and will prompt you when needed.')
                : stepHint}
            </p>
            {!effectiveReadOnly ? (
              <div className="gws-compact-actions">
                {onOpenBrowser && embeddedSupported && !browserLocked ? (
                  <button type="button" className="gws-btn is-primary is-sm" disabled={busy} onClick={() => void handleOpenCurrentBrowser()}>
                    <Globe size={13} aria-hidden="true" />
                    <span>{activeMode === 'guide-here' && currentStep !== 'account' ? stepCopy.openLabel : openBrowserLabel}</span>
                  </button>
                ) : null}
                {hasPrimaryStepContinue ? (
                  <button type="button" className="gws-btn is-sm" disabled={busy} onClick={() => void handleCompleteStep()}>
                    {stepCopy.continueLabel}
                  </button>
                ) : null}
                {currentStep === 'client' && settingsEntryAction ? (
                  <button type="button" className="gws-btn is-primary is-sm" disabled={busy} onClick={settingsEntryAction}>
                    <Lock size={13} aria-hidden="true" />
                    <span>{settingsEntryLabel}</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* System-browser OAuth connect step (reuses existing Center OAuth flow) */}
        {isSignInFlowActive ? (
          <GoogleSignInFlow
            api={api!}
            identity={identity!}
            mode={signInConfig.mode ?? 'connect'}
            initialChoices={signInConfig.choices ?? setup?.choices}
            targetAccount={signInConfig.targetAccount ?? setup?.account}
            onCompleted={(account, snapshot) => {
              if (snapshot) {
                setCenterStatus(snapshot);
                onStatusUpdated?.(snapshot);
              }
              setSignInConfig({ open: false });
              if (callGoogleSetup && setup?.id && !setup.unavailable && setup.state === 'running') {
                void sendControl({
                  action: 'advance',
                  step: 'connect',
                  ...(account?.email ? { account: account.email } : {}),
                });
              }
            }}
          />
        ) : null}

        {/* Substantive blocker strip only (never generic yellow "needs-user" + duplicate Done) */}
        {showCompactBlocker ? (
          <div className="gws-compact-alert" role="alert">
            <div className="gws-compact-alert-row">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{describeCompactBlocker(setup!.blocker!, t)}</span>
            </div>
            {extraBlockerActions.length > 0 && !effectiveReadOnly ? (
              <div className="gws-compact-actions">
                {extraBlockerActions.map((action, idx) => (
                  <button
                    key={`${action.id}:${action.step ?? ''}:${action.email ?? ''}`}
                    type="button"
                    className={`gws-btn is-sm${idx === 0 && !hasPrimaryStepContinue ? ' is-primary' : ' is-ghost'}`}
                    disabled={busy || (!canMutateChat && action.id !== 'copy-for-admin' && action.id !== 'turn-on' && action.id !== 'configure-client' && action.id !== 'import-key')}
                    onClick={() => void handleBlockerAction(action)}
                  >
                    {action.id === 'copy-for-admin' ? <Copy size={12} aria-hidden="true" /> : null}
                    {action.id === 'turn-on' ? <ExternalLink size={12} aria-hidden="true" /> : null}
                    <span>{compactBlockerLabel(action, t)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Fallback when live setup snapshot has not loaded yet */}
        {!setup?.id && !unavailableReason && !nonAdminBlocked ? (
          <div className="gws-compact-body">
            <p className="gws-compact-step-hint">
              {t('尚未同步到当前向导状态，请刷新后继续。', 'Setup status not synced yet. Refresh to continue.')}
            </p>
            <div className="gws-compact-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={busy}
                onClick={() => {
                  void refreshCenter();
                  if (callGoogleSetup) void sendControl({ action: 'status' });
                }}
              >
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重新检查', 'Refresh')}</span>
              </button>
            </div>
          </div>
        ) : null}

        {resumeRetryNotice}
        {notice ? <p className="gws-compact-notice" role="status">{notice}</p> : null}
        {error ? (
          <div className="gws-compact-error" role="alert">
            <ShieldAlert size={14} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <section className="gws-card" aria-label={t('Google 应用建项向导', 'Google Workspace Setup')}>
      <div className="gws-card-head">
        <div className="gws-card-title-group">
          <span className="gws-card-title">{t('Google 应用配置向导', 'Google App Setup Wizard')}</span>
          {botName ? <span className="gws-card-sub">{botName}</span> : null}
        </div>
        <div className="gws-head-actions">
          <span className={`gws-pill ${setupCompleted ? 'is-ok' : browserLocked ? 'is-warn' : 'is-accent'}`}>
            {setupCompleted
              ? t('已就绪', 'Ready')
              : browserLocked
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
            ? t(`Center 应用：已配置 (${maskClientId(effectiveCenterClient?.clientId)})`, `Center app: Configured (${maskClientId(effectiveCenterClient?.clientId)})`)
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

      {nonAdminBlocked && !clientConfigured ? (
        <div className="gws-warning" role="status">
          <ShieldAlert size={15} aria-hidden="true" />
          <div className="gws-error-body">
            <span>{t('当前 Center 尚未配置 Google OAuth 应用，请联系 Center 管理员完成一次性配置后再连接你的账号。', 'Center does not have a Google OAuth app configured yet. Ask your Center administrator to configure it once before connecting your account.')}</span>
            <div className="gws-actions">
              <button type="button" className="gws-btn is-ghost is-xs" onClick={() => void handleBlockerAction({ id: 'copy-for-admin' })}>
                <Copy size={12} aria-hidden="true" />
                <span>{t('复制管理员配置指引', 'Copy admin guide')}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {setupClaimsDoneWithoutCenter ? (
        <div className="gws-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{t('尚未在 Center 核验到已就绪的 Google 账号连接；授权完成以 Center 实际回调与探活结果为准，不采信聊天文本说明。', 'Center has not verified a connected Google account yet. Completion is determined strictly by Center status, never chat text.')}</span>
        </div>
      ) : null}

      {unavailableReason ? (
        <div className="gws-warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{unavailableReason}</span>
        </div>
      ) : null}

      {/* Quick path vs 3-mode selector */}
      {!effectiveReadOnly && !setupCompleted && !nonAdminBlocked ? (
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
              const modeAvailable =
                mode === 'guide-browser'
                  ? true
                  : mode === 'do-it-for-me'
                    ? doItAvailable
                    : guideHereAvailable;
              const disabledMode = busy || Boolean(unavailableReason) || !modeAvailable;
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
                    {!modeAvailable ? (
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
              {embeddedUnavailableDetail.trim() === 'client_browser_disconnected'
                ? humanizeEmbeddedReason(embeddedUnavailableDetail, isLocalAndroid, t)
                : embeddedUnavailableDetail ||
                  (isLocalAndroid
                    ? t('Android 本机 Host 不提供桌面级内置自动化浏览器，已默认推荐「外部浏览器指导」。', 'Android local Host does not bundle a desktop automation browser; “Guide me in my browser” is recommended.')
                    : t('当前 Host 无法提供实时内置浏览器交互，请使用「外部浏览器指导」或直接录入凭据。', 'Embedded interactive browser is unavailable on this Host. Use “Guide me in my browser” or direct credential input.'))}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Service group selection card when setup awaits `services` */}
      {!effectiveReadOnly && !setupCompleted && setup?.card?.card === 'services' ? (
        <div className="gws-section-block">
          <span className="gws-label-xs">{t('选择要启用的 Google 服务组（创建项目与后续授权将沿用此选择）', 'Choose Google services to enable (reused for API setup and sign-in)')}</span>
          <div className="gws-choice-grid" role="group" aria-label={t('向导服务选择', 'Setup service selection')}>
            {GOOGLE_SERVICE_CHOICES.map(choice => {
              const checked = serviceDraft.includes(choice);
              return (
                <label key={choice} className={`gws-choice-card${checked ? ' is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={() =>
                      setServiceDraft(prev =>
                        prev.includes(choice)
                          ? prev.filter(item => item !== choice)
                          : GOOGLE_SERVICE_CHOICES.filter(c => prev.includes(c) || c === choice),
                      )
                    }
                  />
                  <span className="gws-choice-body">
                    <span className="gws-choice-title">{googleChoiceLabel(choice, t)}</span>
                    <span className="gws-choice-desc">{googleChoiceDescription(choice, t)}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="gws-actions">
            <button
              type="button"
              className="gws-btn is-primary is-sm"
              disabled={busy || serviceDraft.length === 0}
              onClick={() => void handleSaveServiceChoices()}
            >
              {t('确认服务选择', 'Confirm services')}
            </button>
          </div>
        </div>
      ) : null}

      {/* Cloud Console account selection when multiple console accounts are detected */}
      {!effectiveReadOnly &&
      !setupCompleted &&
      setup?.card?.card === 'account' &&
      Array.isArray(setup.accounts) &&
      setup.accounts.length > 0 ? (
        <div className="gws-section-block">
          <span className="gws-label-xs">{t('选择用于建项的 Google Cloud 账号', 'Choose the Google account for Cloud Console')}</span>
          <div className="gws-actions">
            {setup.accounts.map(email => (
              <button
                key={email}
                type="button"
                className="gws-btn is-ghost is-sm"
                disabled={busy}
                onClick={() =>
                  void sendCardAnswer('account', [email], captured =>
                    sendControl({ action: 'advance', account: email, step: 'account' }, { displayedSetup: captured }),
                  )
                }
              >
                {email}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {kindSelection}

      {/* Browser lock / sensitive takeover banner */}
      {browserLocked ? (
        <div className="gws-takeover-alert" role="alert">
          <div className="gws-takeover-body">
            <strong>{t('此步骤需你亲自完成', 'Your turn')}</strong>
            <span>{browserLockHint}</span>
          </div>
          <div className="gws-actions">
            {onOpenBrowser && embeddedSupported && !lockRequiresSystemBrowser ? (
              <button type="button" className="gws-btn is-warn is-sm" onClick={() => void handleOpenCurrentBrowser()}>
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
            const isDone = item.status === 'done' || item.status === 'skipped';
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
                {item.url && isCurrent && item.id !== 'project' && !isEmbeddedAccountStep && !kindPending ? (
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
      {currentStep && stepInfo && !setupCompleted && !kindPending ? (
        <div className="gws-step-guide">
          <div className="gws-step-guide-title">{googleStepTitle(currentStep, t)}</div>
          <ul className="gws-guide-list">
            {stepGuideLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          {stepInfo.sensitiveWarning ? (
            <p className="gws-sensitive-note">
              <ShieldAlert size={14} aria-hidden="true" />
              <span>{stepInfo.sensitiveWarning}</span>
            </p>
          ) : null}

          {activeMode === 'guide-here' && onOpenBrowser && !browserLocked && !effectiveReadOnly ? (
            <div className="gws-actions">
              <button type="button" className="gws-btn is-primary is-sm" disabled={busy} onClick={() => void handleOpenCurrentBrowser()}>
                <Globe size={14} aria-hidden="true" />
                <span>{compactStepCopy(currentStep, t).openLabel}</span>
              </button>
            </div>
          ) : null}
          {externalProjectUrl && !effectiveReadOnly ? (
            <div className="gws-actions">
              <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void openExternalUrl(externalProjectUrl)}>
                <ExternalLink size={14} aria-hidden="true" />
                <span>{t('打开项目创建页', 'Open project creation page')}</span>
              </button>
            </div>
          ) : null}
          {currentStep === 'project' && canCompleteCurrentStep && !effectiveReadOnly ? (
            <div className={needsExternalProjectId ? 'gws-inline-input-row' : 'gws-actions'}>
              {needsExternalProjectId ? (
                <input
                  type="text"
                  className="gws-input"
                  value={projectIdInput}
                  disabled={busy}
                  placeholder="Project ID"
                  aria-label={t('Google Cloud Project ID', 'Google Cloud Project ID')}
                  onChange={e => updateProjectIdDraft(e.target.value)}
                />
              ) : null}
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={busy || waitingForExternalProjectId}
                onClick={() => void handleCompleteStep()}
              >
                {t('已创建，继续', 'Created, continue')}
              </button>
            </div>
          ) : null}

          {currentStep !== 'project' &&
          currentStep !== 'client' &&
          currentStep !== 'connect' &&
          canCompleteCurrentStep &&
          !effectiveReadOnly ? (
            <div className="gws-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                disabled={busy}
                onClick={() => void handleCompleteStep()}
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
            <span>{describeBlocker(setup.blocker, t)}</span>
          </div>
          {activeBlockerActions.length > 0 && !effectiveReadOnly ? (
            <div className="gws-actions">
              {activeBlockerActions.filter(action => action.id !== 'done' || !canCompleteCurrentStep || currentStep === 'client').map(action => (
                <button
                  key={`${action.id}:${action.step ?? ''}:${action.email ?? ''}`}
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
          configuredClientId={effectiveCenterClient?.clientId}
          onOpenCenterAdmin={onOpenCenterAdmin}
          onCancel={showDirectConfig ? () => setShowDirectConfig(false) : undefined}
          onSaved={snapshot => {
            setCenterStatus(snapshot);
            onStatusUpdated?.(snapshot);
            setShowDirectConfig(false);
            setSignInConfig({ open: true, mode: 'connect', choices: setup?.choices });
            if (callGoogleSetup && setup && !setup.unavailable && setup.state === 'running') {
              void sendControl({ action: 'advance', step: 'client', expectedRevision: setup.revision });
            }
          }}
        />
      ) : null}

      {/* System-browser OAuth connect flow (once Center Web OAuth Client is configured) */}
      {api &&
      identity &&
      !effectiveReadOnly &&
      clientConfigured &&
      (signInConfig.open || currentStep === 'connect') &&
      !setupCompleted ? (
        <GoogleSignInFlow
          api={api}
          identity={identity}
          mode={signInConfig.mode ?? 'connect'}
          initialChoices={signInConfig.choices ?? setup?.choices}
          targetAccount={signInConfig.targetAccount ?? setup?.account}
          onCompleted={(account, snapshot) => {
            if (snapshot) {
              setCenterStatus(snapshot);
              onStatusUpdated?.(snapshot);
            }
            setSignInConfig({ open: false });
            if (callGoogleSetup && setup && !setup.unavailable && setup.state === 'running') {
              void sendControl({
                action: 'advance',
                step: 'connect',
                ...(account?.email ? { account: account.email } : {}),
                expectedRevision: setup.revision,
              });
            }
          }}
        />
      ) : null}

      {resumeRetryNotice}
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
          {onOpenBrowser && embeddedSupported && !lockRequiresSystemBrowser &&
            setup?.card?.card !== 'services' && (activeMode === 'do-it-for-me' || activeMode === 'guide-here') ? (
            <button type="button" className="gws-btn is-ghost is-sm" disabled={busy} onClick={() => void handleOpenCurrentBrowser()}>
              <Globe size={14} aria-hidden="true" />
              <span>{openBrowserLabel}</span>
            </button>
          ) : null}
          {onOpenCenterAdmin ? (
            <button type="button" className="gws-btn is-ghost is-sm" onClick={onOpenCenterAdmin}>
              <ExternalLink size={14} aria-hidden="true" />
              <span>{t('前往中心管理', 'Open Center Admin')}</span>
            </button>
          ) : null}
          {callGoogleSetup && setup?.id && !setupCompleted && !setup.unavailable && setup.state === 'running' ? (
            <button
              type="button"
              className="gws-btn is-ghost is-sm"
              disabled={busy}
              onClick={() => void sendControl({ action: 'cancel', expectedRevision: setup.revision })}
            >
              {t('中止向导', 'Cancel setup')}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
