import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  Trash2,
  Upload,
} from 'lucide-react';
import { useText } from '../ui';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  ActionMenu,
  CaDisclosure,
  CaExternalUrlBox,
  CaModal,
  CaNotice,
  CaSegmented,
  CaSwitch,
  CopyButton,
  botKey,
  copyToClipboard,
  formatCountdown,
  formatTime,
  openExternalUrl,
  platformLabel,
  useUiLocale,
} from './primitives';
import {
  GOOGLE_CLOUD_AUTH_CLIENTS_URL,
  GOOGLE_CLOUD_AUTH_OVERVIEW_URL,
  GOOGLE_CLOUD_CREATE_PROJECT_URL,
  GOOGLE_CONNECTIONS_URL,
  GOOGLE_SERVICE_CHOICES,
  buildReadinessRows,
  canonicalChoices,
  deriveFallbackRedirectUri,
  googleAdminTrustMessage,
  googleApiEnableUrl,
  googleChoiceDescription,
  googleChoiceLabel,
  googleChoiceShortLabel,
  googleEnableFlowUrl,
  isAccountReconnectRequired,
  maskClientId,
  mergeChoices,
  normalizeGoogleRulesResponse,
  readinessBadgeMeta,
  ruleEffectiveStatus,
  validateWebClientJson,
} from './googleHelpers';
import type {
  CenterBotRef,
  CenterDevice,
  GoogleAccountStatus,
  GoogleFlowPhase,
  GoogleRule,
  GoogleRuleSource,
  GoogleServiceChoice,
  GoogleStatusResponse,
} from './types';

interface ActiveAuthFlow {
  flowId: string;
  authorizationUrl: string;
  expiresAt: string;
  phase: GoogleFlowPhase;
  choices: GoogleServiceChoice[];
  targetAccount?: string;
  error?: string;
}

interface NoticeBanner {
  tone: 'ok' | 'warn' | 'danger' | 'info';
  text: string;
  linkUrl?: string;
  linkLabel?: string;
  actionLabel?: string;
  onAction?: () => void;
}

const MINUTES_BEFORE_PRESETS = [5, 10, 15, 30] as const;

function toIsoExpiresAt(raw: string | number): string {
  if (typeof raw === 'number') {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString();
  }
  return raw;
}

function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof CenterApiError) {
    return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return true;
}

export function GoogleTab({
  api,
  centerUrl,
  onOpenExternalUrl,
  onConfigureBot,
  onStartGoogleSetupWizard,
}: {
  api: CenterApi;
  centerUrl?: string;
  onOpenExternalUrl?: (url: string) => void | Promise<unknown>;
  onConfigureBot?: (deviceId: string, botId: string) => void;
  onStartGoogleSetupWizard?: (deviceId: string, botId: string) => void;
}): React.JSX.Element {
  const t = useText();
  const locale = useUiLocale();

  // Primary status & directory data
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [forbiddenReason, setForbiddenReason] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [banner, setBanner] = useState<NoticeBanner | null>(null);

  const [status, setStatus] = useState<GoogleStatusResponse | null>(null);
  const [devices, setDevices] = useState<CenterDevice[]>([]);
  const [bots, setBots] = useState<CenterBotRef[]>([]);

  // Rules state
  const [rules, setRules] = useState<GoogleRule[]>([]);
  const [rulesUnavailable, setRulesUnavailable] = useState(false);
  const [rulesError, setRulesError] = useState('');
  const [ruleBotFilter, setRuleBotFilter] = useState<string>('all');
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);

  // Per-account transient UI state (never mutates server grant state)
  const [checkingAccounts, setCheckingAccounts] = useState<Set<string>>(new Set());
  const [transientCheckErrors, setTransientCheckErrors] = useState<Record<string, string>>({});
  const [skippedServices, setSkippedServices] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  // Private Web OAuth Client configure drawer
  const [configOpen, setConfigOpen] = useState(false);
  const [configMode, setConfigMode] = useState<'file' | 'manual'>('file');
  const [configBusy, setConfigBusy] = useState(false);
  const [configError, setConfigError] = useState('');
  const [clientFileName, setClientFileName] = useState('');
  const [clientFileRaw, setClientFileRaw] = useState('');
  const [clientIdDraft, setClientIdDraft] = useState('');
  const [clientSecretDraft, setClientSecretDraft] = useState('');
  const [draggingJson, setDraggingJson] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Target Bot setup wizard / manual mode drawer
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardTargetBotKey, setWizardTargetBotKey] = useState('');

  // Connect / Add Services modal
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectTargetAccount, setConnectTargetAccount] = useState<GoogleAccountStatus | null>(null);
  const [selectedChoices, setSelectedChoices] = useState<GoogleServiceChoice[]>([
    'gmail',
    'calendar',
    'files',
  ]);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Active OAuth system-browser flow
  const [activeFlow, setActiveFlow] = useState<ActiveAuthFlow | null>(null);
  const [cancellingFlow, setCancellingFlow] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const flowGenRef = useRef(0);
  const pollInFlightRef = useRef(false);

  // Remove account confirmation modal
  const [removeTarget, setRemoveTarget] = useState<GoogleAccountStatus | null>(null);
  const [removeRevoke, setRemoveRevoke] = useState(true);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');

  // Rule create / edit drawer
  const [ruleDrawerOpen, setRuleDrawerOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<GoogleRule | null>(null);
  const [ruleSource, setRuleSource] = useState<GoogleRuleSource>('gmail');
  const [ruleBotKey, setRuleBotKey] = useState('');
  const [ruleAccount, setRuleAccount] = useState('');
  const [ruleFrom, setRuleFrom] = useState('');
  const [ruleSubject, setRuleSubject] = useState('');
  const [ruleCalendar, setRuleCalendar] = useState('primary');
  const [ruleMinutesBefore, setRuleMinutesBefore] = useState(15);
  const [ruleInstruction, setRuleInstruction] = useState('');
  const [ruleEnabled, setRuleEnabled] = useState(true);
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleFormError, setRuleFormError] = useState('');

  const clearSecretDrafts = useCallback(() => {
    setClientFileName('');
    setClientFileRaw('');
    setClientIdDraft('');
    setClientSecretDraft('');
    setConfigError('');
    setDraggingJson(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Ensure secrets and timers are cleared on unmount
  useEffect(() => {
    return () => {
      flowGenRef.current += 1;
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
      clearSecretDrafts();
    };
  }, [clearSecretDrafts]);

  const activeBots = useMemo(() => bots.filter(b => !b.archivedAt), [bots]);

  const deviceById = useMemo(() => {
    const map = new Map<string, CenterDevice>();
    for (const d of devices) map.set(d.deviceId, d);
    return map;
  }, [devices]);

  const botByKey = useMemo(() => {
    const map = new Map<string, CenterBotRef>();
    for (const b of bots) map.set(botKey(b.deviceId, b.botId), b);
    return map;
  }, [bots]);

  const botsByDevice = useMemo(() => {
    const grouped = new Map<string, { device: CenterDevice | null; bots: CenterBotRef[] }>();
    for (const b of activeBots) {
      const entry = grouped.get(b.deviceId) ?? {
        device: deviceById.get(b.deviceId) ?? null,
        bots: [],
      };
      entry.bots.push(b);
      grouped.set(b.deviceId, entry);
    }
    return Array.from(grouped.entries());
  }, [activeBots, deviceById]);

  const accounts = useMemo(() => status?.accounts ?? [], [status]);

  const accountsByKey = useMemo(() => {
    const map = new Map<string, GoogleAccountStatus>();
    for (const acc of accounts) {
      map.set(acc.email, acc);
      if (acc.id) map.set(acc.id, acc);
    }
    return map;
  }, [accounts]);

  const redirectInfo = useMemo(() => {
    const serverUri = status?.client?.redirectUri?.trim();
    if (serverUri) return { uri: serverUri, isPreview: false };
    return deriveFallbackRedirectUri(centerUrl);
  }, [status?.client?.redirectUri, centerUrl]);

  const clientJsonValidation = useMemo(() => {
    if (!clientFileRaw) return null;
    return validateWebClientJson(clientFileRaw, redirectInfo.isPreview ? undefined : redirectInfo.uri, t);
  }, [clientFileRaw, redirectInfo.isPreview, redirectInfo.uri, t]);

  const loadRules = useCallback(
    async (botList: CenterBotRef[]) => {
      setRulesError('');
      setRulesUnavailable(false);
      try {
        const res = await api.listGoogleRules();
        setRules(normalizeGoogleRulesResponse(res));
        return;
      } catch (err) {
        if (err instanceof CenterApiError && (err.status === 404 || err.status === 501)) {
          setRulesUnavailable(true);
          setRules([]);
          return;
        }
        // If backend requires explicit deviceId+botId query params, fetch per active bot.
        if (err instanceof CenterApiError && err.status === 400 && botList.length > 0) {
          try {
            const perBot = await Promise.all(
              botList.map(b =>
                api
                  .listGoogleRules({ deviceId: b.deviceId, botId: b.botId })
                  .then(normalizeGoogleRulesResponse)
                  .catch(() => [] as GoogleRule[]),
              ),
            );
            const merged = new Map<string, GoogleRule>();
            let idx = 0;
            for (const list of perBot) {
              for (const r of list) {
                const key = r.id || `${r.deviceId}::${r.botId}::${r.account}::${r.source}::${idx++}`;
                merged.set(key, r);
              }
            }
            setRules(Array.from(merged.values()));
            return;
          } catch (fallbackErr) {
            setRulesError(errorMessage(fallbackErr, t('加载自动规则失败', 'Failed to load rules')));
            return;
          }
        }
        setRulesError(errorMessage(err, t('加载自动规则失败', 'Failed to load rules')));
      }
    },
    [api, t],
  );

  const loadAll = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (opts?.silent) setRefreshing(true);
      else setLoading(true);
      setLoadError('');
      setUnavailableReason(null);
      setForbiddenReason(null);

      try {
        const [googleRes, syncRes] = await Promise.all([
          api.getGoogleStatus(),
          api.getBotSync().catch(() => null),
        ]);

        if (googleRes.available === false) {
          setUnavailableReason(
            googleRes.reason ||
              t('当前中心未启用 Google Workspace 功能模块', 'Google Workspace is not enabled on this Center server.'),
          );
          setStatus(null);
        } else {
          setStatus(googleRes);
        }

        const nextDevices = syncRes?.devices ?? [];
        const nextBots = syncRes?.bots ?? [];
        setDevices(nextDevices);
        setBots(nextBots);

        const active = nextBots.filter(b => !b.archivedAt);
        if (active.length > 0) {
          setWizardTargetBotKey(prev =>
            prev && active.some(b => botKey(b.deviceId, b.botId) === prev)
              ? prev
              : botKey(active[0].deviceId, active[0].botId),
          );
        }

        if (googleRes.available !== false) {
          await loadRules(active);
        }
      } catch (err) {
        if (err instanceof CenterApiError && (err.status === 404 || err.status === 501)) {
          setUnavailableReason(
            t('当前中心服务端尚未提供 Google Workspace 接口（/api/google/status 不可用）。请升级或启用中心 Google 模块后重试。', 'This Center server does not expose the Google Workspace endpoints yet (/api/google/status unavailable).'),
          );
          setStatus(null);
        } else if (err instanceof CenterApiError && err.status === 403) {
          setForbiddenReason(
            err.message ||
              t('当前会话无权管理中心 Google 应用配置，请联系中心管理员或使用所有者会话登录中心管理页。', 'This session cannot manage Center Google settings. Contact the Center administrator or sign in as the owner.'),
          );
        } else {
          setLoadError(
            errorMessage(err, t('暂时无法获取中心 Google 状态', 'Unable to load Center Google status')),
          );
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api, loadRules, t],
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Countdown tick while waiting for system browser OAuth
  useEffect(() => {
    if (!activeFlow || activeFlow.phase !== 'pending') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeFlow]);

  const handleFlowCompleted = useCallback(
    async (account: GoogleAccountStatus | undefined, flow: ActiveAuthFlow) => {
      await loadAll({ silent: true });
      if (account) {
        const rows = buildReadinessRows(account.services ?? [], t);
        const readyLabels = rows.filter(r => r.state === 'ready').map(r => r.label);
        const issueCount = rows.filter(r => r.state !== 'ready').length;
        if (issueCount === 0) {
          setBanner({
            tone: 'ok',
            text:
              readyLabels.length > 0
                ? t(`已连接 ${account.email} · ${readyLabels.join('、')}就绪 · 本中心所有 Bot 均可直接使用`, `Connected ${account.email} · ${readyLabels.join(', ')} ready · Available to all Bots on this Center`)
                : t(`已连接 ${account.email} · 本中心所有 Bot 均可直接使用`, `Connected ${account.email} · Available to all Bots on this Center`),
          });
        } else {
          setBanner({
            tone: 'warn',
            text: t(`已连接 ${account.email}，但有 ${issueCount} 项服务尚未就绪（如未勾选权限、API 未启用或被组织限制）。请按下方服务行提示逐项处理。`, `Connected ${account.email}, with ${issueCount} service(s) still needing attention. Review the per-service rows below.`),
          });
        }
      } else {
        setBanner({
          tone: 'ok',
          text: flow.targetAccount
            ? t(`${flow.targetAccount} 授权已更新，本中心所有 Bot 均可使用已就绪服务`, `Authorization updated for ${flow.targetAccount}. Ready services are available to all Bots.`)
            : t('Google 账号已连接，本中心所有 Bot 均可使用已就绪服务', 'Google account connected. Ready services are available to all Bots.'),
        });
      }
    },
    [loadAll, t],
  );

  // Poll POST /api/google/flow while pending, plus immediate check on window focus / visibility
  useEffect(() => {
    if (!activeFlow || activeFlow.phase !== 'pending') return;
    const gen = flowGenRef.current;
    const currentFlow = activeFlow;

    const pollOnce = async () => {
      if (pollInFlightRef.current || gen !== flowGenRef.current) return;
      pollInFlightRef.current = true;
      try {
        const res = await api.getGoogleFlow({ flowId: currentFlow.flowId });
        if (gen !== flowGenRef.current) return;
        if (res.phase === 'pending') return;

        if (res.phase === 'connected') {
          setActiveFlow(null);
          await handleFlowCompleted(res.account, currentFlow);
          return;
        }
        if (res.phase === 'cancelled') {
          setActiveFlow({
            ...currentFlow,
            phase: 'cancelled',
            error: res.error || t('本次授权已取消，原有有效连接未受影响。', 'Authorization was cancelled. Existing connections were not affected.'),
          });
          return;
        }
        setActiveFlow({
          ...currentFlow,
          phase: 'failed',
          error:
            res.error ||
            t('此次授权未完成或已过期，原有有效连接未受影响。请重新开始。', 'Authorization did not complete or expired. Existing connections were not affected.'),
        });
      } catch (err) {
        if (gen !== flowGenRef.current) return;
        // Transient poll error: keep polling until server reports terminal state or user cancels.
        if (err instanceof CenterApiError && (err.status === 404 || err.status === 410)) {
          setActiveFlow({
            ...currentFlow,
            phase: 'failed',
            error: t('授权流程已过期，请重新开始。', 'Authorization flow expired. Please start again.'),
          });
        }
      } finally {
        pollInFlightRef.current = false;
      }
    };

    const timer = window.setInterval(() => {
      void pollOnce();
    }, 1500);

    const onReturn = () => {
      if (document.visibilityState === 'visible') {
        void pollOnce();
      }
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [activeFlow, api, handleFlowCompleted, t]);

  // Open private configure drawer
  const openConfigureDrawer = useCallback(() => {
    clearSecretDrafts();
    setConfigMode('file');
    setConfigOpen(true);
  }, [clearSecretDrafts]);

  const closeConfigureDrawer = useCallback(() => {
    setConfigOpen(false);
    clearSecretDrafts();
  }, [clearSecretDrafts]);

  const handleJsonFilePick = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      setConfigError('');
      try {
        const text = await file.text();
        setClientFileName(file.name);
        setClientFileRaw(text);
      } catch (err) {
        setConfigError(errorMessage(err, t('读取文件失败', 'Failed to read file')));
      } finally {
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [t],
  );

  const openConnectModal = useCallback(
    (targetAccount?: GoogleAccountStatus | null, presetChoices?: GoogleServiceChoice[]) => {
      setConnectError('');
      setConnectTargetAccount(targetAccount ?? null);
      if (presetChoices && presetChoices.length > 0) {
        setSelectedChoices(canonicalChoices(presetChoices));
      } else if (targetAccount) {
        const existing = canonicalChoices(targetAccount.choices ?? []);
        const missing = GOOGLE_SERVICE_CHOICES.filter(c => !existing.includes(c));
        setSelectedChoices(
          missing.length > 0
            ? mergeChoices(existing, [missing[0]])
            : existing.length > 0
              ? existing
              : ['gmail', 'calendar', 'files'],
        );
      } else {
        setSelectedChoices(['gmail', 'calendar', 'files']);
      }
      setConnectOpen(true);
    },
    [],
  );

  const handleSaveClientConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setConfigError('');

    if (configMode === 'file') {
      if (!clientFileRaw) {
        setConfigError(t('请先选择或拖入 Google Cloud 导出的 Web OAuth JSON 文件', 'Please select a Web OAuth JSON file first.'));
        return;
      }
      const check = validateWebClientJson(
        clientFileRaw,
        redirectInfo.isPreview ? undefined : redirectInfo.uri,
        t,
      );
      if (!check.ok) {
        setConfigError(check.error || t('JSON 文件校验未通过', 'Invalid client JSON file'));
        return;
      }
    } else {
      if (!clientIdDraft.trim() || !clientSecretDraft.trim()) {
        setConfigError(t('请填写完整的 Client ID 与 Client Secret', 'Please enter both Client ID and Client Secret.'));
        return;
      }
    }

    setConfigBusy(true);
    try {
      const payload =
        configMode === 'file'
          ? { clientFile: clientFileRaw }
          : { clientId: clientIdDraft.trim(), clientSecret: clientSecretDraft.trim() };

      const updated = await api.configureGoogle(payload);
      clearSecretDrafts();
      setConfigOpen(false);
      setStatus(updated);
      await loadAll({ silent: true });

      const tail = maskClientId(updated?.client?.clientId);
      const hasAccounts = (updated?.accounts ?? accounts).length > 0;
      setBanner({
        tone: 'ok',
        text: tail
          ? t(`中心 Google 应用已加密保存（Web Client · ${tail}）。出于安全原因，Client Secret 已清空，不再回显也不支持导出。`, `Center Google app saved encrypted (Web Client · ${tail}). Client Secret has been cleared and cannot be viewed or exported.`)
          : t('中心 Google 应用已加密保存。出于安全原因，Client Secret 已清空，不再回显也不支持导出。', 'Center Google app saved encrypted. Client Secret has been cleared and cannot be viewed or exported.'),
        ...(!hasAccounts
          ? {
              actionLabel: t('继续：登录你的 Google 账号', 'Next: Sign in to Google'),
              onAction: () => openConnectModal(null),
            }
          : {}),
      });
    } catch (err) {
      setConfigError(
        errorMessage(err, t('保存中心 Google 应用配置失败', 'Failed to save Center Google app config')),
      );
    } finally {
      setConfigBusy(false);
    }
  };

  // Start system browser OAuth flow
  const startAuthorize = useCallback(
    async (choices: GoogleServiceChoice[], targetAccount?: string) => {
      const normalized = canonicalChoices(choices);
      if (normalized.length === 0) {
        setConnectError(t('请至少选择一组 Google 服务', 'Select at least one Google service group.'));
        return;
      }

      const gen = ++flowGenRef.current;
      setConnectBusy(true);
      setConnectError('');
      setBanner(null);

      try {
        const res = await api.authorizeGoogle({
          choices: normalized,
          ...(targetAccount ? { account: targetAccount } : {}),
        });
        if (gen !== flowGenRef.current) return;

        const flow: ActiveAuthFlow = {
          flowId: res.flowId,
          authorizationUrl: res.authorizationUrl,
          expiresAt: toIsoExpiresAt(res.expiresAt),
          phase: 'pending',
          choices: normalized,
          targetAccount,
        };
        setActiveFlow(flow);
        setConnectOpen(false);
        setConnectTargetAccount(null);

        void openExternalUrl(res.authorizationUrl, onOpenExternalUrl).catch(() => {
          // URL remains accessible via the Reopen Browser button and fallback link box.
        });
      } catch (err) {
        if (gen !== flowGenRef.current) return;
        const msg = errorMessage(err, t('发起 Google 授权失败', 'Failed to start Google authorization'));
        if (connectOpen) {
          setConnectError(msg);
        } else {
          setBanner({ tone: 'danger', text: msg });
        }
      } finally {
        setConnectBusy(false);
      }
    },
    [api, connectOpen, onOpenExternalUrl, t],
  );

  const handleCancelFlow = async () => {
    if (!activeFlow) return;
    const flowId = activeFlow.flowId;
    setCancellingFlow(true);
    flowGenRef.current += 1;
    try {
      await api.cancelGoogleFlow({ flowId });
    } catch {
      // Even if server already expired/finished, stop waiting locally and refresh status.
    } finally {
      setCancellingFlow(false);
      setActiveFlow({
        ...activeFlow,
        phase: 'cancelled',
        error: t('已取消本次授权，原有有效连接未受影响。', 'Authorization cancelled. Existing connections were not affected.'),
      });
      void loadAll({ silent: true });
    }
  };

  // Re-run read-only readiness probe for an account
  const handleCheckAccount = async (account: GoogleAccountStatus) => {
    const key = account.email;
    setCheckingAccounts(prev => new Set(prev).add(key));
    setTransientCheckErrors(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setBanner(null);

    try {
      const res = await api.checkGoogleAccount({ account: key });
      if (res && res.reachable === false) {
        setTransientCheckErrors(prev => ({
          ...prev,
          [key]:
            res.error ||
            t('暂时无法连接 Google 验证状态，未清除本地令牌', 'Temporarily unable to reach Google. Local tokens were kept.'),
        }));
      } else {
        await loadAll({ silent: true });
        setBanner({
          tone: 'ok',
          text: t(`已重新检查 ${key} 的服务就绪状态`, `Refreshed service readiness for ${key}`),
        });
      }
    } catch (err) {
      if (isTransientNetworkError(err)) {
        // Transient outage must NOT clear tokens or degrade to reconnect_required.
        setTransientCheckErrors(prev => ({
          ...prev,
          [key]: errorMessage(
            err,
            t('暂时不可达，请稍后重试检查（未清除本地令牌）', 'Temporarily unreachable. Local tokens were kept.'),
          ),
        }));
      } else {
        setBanner({
          tone: 'danger',
          text: errorMessage(err, t(`检查 ${key} 失败`, `Failed to check ${key}`)),
        });
        await loadAll({ silent: true });
      }
    } finally {
      setCheckingAccounts(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  // Remove account confirmation & separated local-remove vs Google-revoke report
  const affectedRulesForRemoveTarget = useMemo(() => {
    if (!removeTarget) return [];
    return rules.filter(
      r => r.account === removeTarget.email || (removeTarget.id && r.account === removeTarget.id),
    );
  }, [removeTarget, rules]);

  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    const email = removeTarget.email;
    const requestedRevoke = removeRevoke;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      const res = await api.removeGoogleAccount({
        account: email,
        revoke: requestedRevoke,
      });
      setRemoveTarget(null);
      await loadAll({ silent: true });

      const revokeErr = res?.revokeError || res?.revokeWarning || null;
      if (!requestedRevoke) {
        setBanner({
          tone: 'info',
          text: t(`已从本中心移除 ${email} 的本地凭据（未向 Google 撤权）。如需彻底断开第三方访问，请前往 Google 账号第三方连接页核实。`, `Removed ${email} locally from this Center (not revoked at Google). You can verify third-party access in your Google Account.`),
          linkUrl: GOOGLE_CONNECTIONS_URL,
          linkLabel: t('打开 Google 第三方连接', 'Open Google connections'),
        });
      } else if (res?.revoked === false || revokeErr) {
        setBanner({
          tone: 'warn',
          text: t(`本地凭据已删除，但向 Google 撤权失败${revokeErr ? `（${revokeErr}）` : ''}。请前往 Google 账号第三方连接手动确认撤销。`, `Local credentials were removed, but revoking access at Google failed${revokeErr ? ` (${revokeErr})` : ''}. Please revoke it manually in your Google Account.`),
          linkUrl: GOOGLE_CONNECTIONS_URL,
          linkLabel: t('前往 Google 手动撤权', 'Review in Google Account'),
        });
      } else {
        setBanner({
          tone: 'ok',
          text: t(`已从本中心移除 ${email} 并向 Google 撤销访问权限。其他 Google 账号不受影响。`, `Removed ${email} from this Center and revoked access at Google. Other accounts were not affected.`),
        });
      }
    } catch (err) {
      setRemoveError(errorMessage(err, t('移除账号失败', 'Failed to remove account')));
    } finally {
      setRemoveBusy(false);
    }
  };

  // Rules management helpers
  const formatBotDisplay = useCallback(
    (deviceId: string, botId: string) => {
      const bot = botByKey.get(botKey(deviceId, botId));
      const dev = deviceById.get(deviceId);
      const botName = bot?.name || botId;
      const devName = dev?.name || deviceId;
      return `${botName} @ ${devName}`;
    },
    [botByKey, deviceById],
  );

  const openCreateRuleDrawer = () => {
    setEditingRule(null);
    setRuleSource('gmail');
    setRuleBotKey(
      ruleBotFilter !== 'all'
        ? ruleBotFilter
        : activeBots[0]
          ? botKey(activeBots[0].deviceId, activeBots[0].botId)
          : '',
    );
    const defaultAccount =
      accounts.find(a => !isAccountReconnectRequired(a))?.email ?? accounts[0]?.email ?? '';
    setRuleAccount(defaultAccount);
    setRuleFrom('');
    setRuleSubject('');
    setRuleCalendar('primary');
    setRuleMinutesBefore(15);
    setRuleInstruction('');
    setRuleEnabled(true);
    setRuleFormError('');
    setRuleDrawerOpen(true);
  };

  const openEditRuleDrawer = (rule: GoogleRule) => {
    setEditingRule(rule);
    setRuleSource(rule.source);
    setRuleBotKey(botKey(rule.deviceId, rule.botId));
    setRuleAccount(rule.account);
    setRuleFrom(rule.from ?? '');
    setRuleSubject(rule.subjectContains ?? '');
    setRuleCalendar(rule.calendar || 'primary');
    setRuleMinutesBefore(typeof rule.minutesBefore === 'number' ? rule.minutesBefore : 15);
    setRuleInstruction(rule.instruction);
    setRuleEnabled(rule.enabled);
    setRuleFormError('');
    setRuleDrawerOpen(true);
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setRuleFormError('');
    const sep = ruleBotKey.indexOf('::');
    if (sep <= 0) {
      setRuleFormError(t('请选择目标 Bot', 'Please choose a target Bot.'));
      return;
    }
    const deviceId = ruleBotKey.slice(0, sep);
    const botId = ruleBotKey.slice(sep + 2);
    if (!ruleAccount.trim()) {
      setRuleFormError(t('请选择 Google 账号', 'Please choose a Google account.'));
      return;
    }
    if (!ruleInstruction.trim()) {
      setRuleFormError(t('请填写触发指令', 'Please enter a trigger instruction.'));
      return;
    }
    const minutes = Math.max(1, Math.min(24 * 60, Math.round(Number(ruleMinutesBefore) || 15)));

    const payload: GoogleRule = {
      ...(editingRule?.id ? { id: editingRule.id } : {}),
      deviceId,
      botId,
      account: ruleAccount.trim(),
      source: ruleSource,
      enabled: ruleEnabled,
      instruction: ruleInstruction.trim(),
      ...(ruleSource === 'gmail'
        ? {
            ...(ruleFrom.trim() ? { from: ruleFrom.trim() } : {}),
            ...(ruleSubject.trim() ? { subjectContains: ruleSubject.trim() } : {}),
          }
        : {
            calendar: ruleCalendar.trim() || 'primary',
            minutesBefore: minutes,
          }),
    };

    setRuleBusy(true);
    try {
      await api.saveGoogleRule(payload);
      setRuleDrawerOpen(false);
      await loadRules(activeBots);
      setBanner({
        tone: 'ok',
        text: editingRule
          ? t('自动触发规则已更新', 'Trigger rule updated')
          : ruleSource === 'gmail'
            ? t('新邮件规则已保存（仅对开启后新到达的邮件生效，不回放历史收件箱）', 'New mail rule saved (applies only to new emails arriving after enabling).')
            : t('会前提醒规则已保存', 'Pre-meeting rule saved'),
      });
    } catch (err) {
      setRuleFormError(errorMessage(err, t('保存规则失败', 'Failed to save rule')));
    } finally {
      setRuleBusy(false);
    }
  };

  const handleToggleRule = async (rule: GoogleRule, nextEnabled: boolean) => {
    const idKey = rule.id || `${rule.deviceId}::${rule.botId}::${rule.source}`;
    setTogglingRuleId(idKey);
    setRulesError('');
    try {
      await api.saveGoogleRule({
        ...rule,
        enabled: nextEnabled,
      });
      await loadRules(activeBots);
      setBanner({
        tone: 'info',
        text: nextEnabled
          ? t('已启用该自动规则', 'Trigger rule resumed')
          : t('已暂停该自动规则（不影响任何 Bot 主动使用 Google 账号）', 'Trigger rule paused (all Bots can still use Google on demand).'),
      });
    } catch (err) {
      setRulesError(errorMessage(err, t('更新规则状态失败', 'Failed to update rule')));
    } finally {
      setTogglingRuleId(null);
    }
  };

  const handleDeleteRule = async (rule: GoogleRule) => {
    if (!rule.id) return;
    setRulesError('');
    try {
      await api.removeGoogleRule({
        id: rule.id,
        deviceId: rule.deviceId,
        botId: rule.botId,
      });
      await loadRules(activeBots);
      setBanner({
        tone: 'info',
        text: t('已删除自动触发规则', 'Trigger rule deleted'),
      });
    } catch (err) {
      setRulesError(errorMessage(err, t('删除规则失败', 'Failed to delete rule')));
    }
  };

  const filteredRules = useMemo(() => {
    if (ruleBotFilter === 'all') return rules;
    return rules.filter(r => botKey(r.deviceId, r.botId) === ruleBotFilter);
  }, [rules, ruleBotFilter]);

  const handleCopyWithFeedback = async (key: string, value: string) => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopiedKey(key);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedKey(prev => (prev === key ? null : prev));
      }, 1800);
    }
  };

  // Early states: loading / unavailable / forbidden / hard load failure
  if (loading) {
    return <div className="ca-empty">{t('正在加载 Google Workspace…', 'Loading Google Workspace…')}</div>;
  }

  if (unavailableReason) {
    return (
      <section className="ca-section">
        <div className="ca-section-body">
          <CaNotice
            tone="warn"
            action={
              <button type="button" className="ca-btn ca-btn-sm" onClick={() => void loadAll()}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重试', 'Retry')}</span>
              </button>
            }
          >
            <strong>{t('Google Workspace 当前不可用', 'Google Workspace unavailable')}</strong>
            <div style={{ marginTop: 4 }}>{unavailableReason}</div>
          </CaNotice>
        </div>
      </section>
    );
  }

  if (forbiddenReason && !status) {
    return (
      <section className="ca-section">
        <div className="ca-section-body">
          <CaNotice
            tone="warn"
            action={
              <button type="button" className="ca-btn ca-btn-sm" onClick={() => void loadAll()}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重新检查', 'Retry')}</span>
              </button>
            }
          >
            <strong>{t('需要中心管理权限', 'Center owner access required')}</strong>
            <div style={{ marginTop: 4 }}>{forbiddenReason}</div>
          </CaNotice>
        </div>
      </section>
    );
  }

  if (loadError && !status) {
    return (
      <section className="ca-section">
        <div className="ca-section-body">
          <CaNotice
            tone="danger"
            action={
              <button type="button" className="ca-btn ca-btn-sm" onClick={() => void loadAll()}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>{t('重试', 'Retry')}</span>
              </button>
            }
          >
            {loadError}
          </CaNotice>
        </div>
      </section>
    );
  }

  const client = status?.client ?? { configured: false };
  const clientInvalid =
    client.status === 'invalid' ||
    client.clientKey === 'gone' ||
    status?.clientKey === 'gone';
  const clientConfigured = Boolean(client.configured);
  const clientIdTail = maskClientId(client.clientId);

  const selectedWizardBot = activeBots.find(
    b => botKey(b.deviceId, b.botId) === wizardTargetBotKey,
  );
  const selectedWizardDevice = selectedWizardBot
    ? deviceById.get(selectedWizardBot.deviceId) ?? null
    : null;
  const canJumpToBotWizard = Boolean(onStartGoogleSetupWizard || onConfigureBot);

  const toggleServiceChoice = (choice: GoogleServiceChoice, lockedIncluded: boolean) => {
    if (lockedIncluded) return;
    setSelectedChoices(prev => {
      if (prev.includes(choice)) {
        return prev.filter(c => c !== choice);
      }
      return canonicalChoices([...prev, choice]);
    });
  };

  return (
    <div>
      {loadError && (
        <CaNotice
          tone="danger"
          action={
            <button type="button" className="ca-btn ca-btn-sm" onClick={() => void loadAll({ silent: true })}>
              {t('重试', 'Retry')}
            </button>
          }
        >
          {loadError}
        </CaNotice>
      )}

      {banner && (
        <CaNotice
          tone={banner.tone}
          action={
            <>
              {banner.linkUrl && (
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  onClick={() => void openExternalUrl(banner.linkUrl!, onOpenExternalUrl)}
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  <span>{banner.linkLabel || t('打开链接', 'Open link')}</span>
                </button>
              )}
              {banner.actionLabel && banner.onAction && (
                <button
                  type="button"
                  className="ca-btn ca-btn-primary ca-btn-sm"
                  onClick={banner.onAction}
                >
                  {banner.actionLabel}
                </button>
              )}
              <button
                type="button"
                className="ca-btn ca-btn-ghost ca-btn-sm"
                onClick={() => setBanner(null)}
              >
                {t('关闭', 'Dismiss')}
              </button>
            </>
          }
        >
          {banner.text}
        </CaNotice>
      )}

      {/* 1. Center Web OAuth Application Card */}
      <section className="ca-section" aria-labelledby="ca-google-app-heading">
        <div className="ca-default-card ca-wrap">
          <div className="ca-row-main">
            <div className="ca-row-title">
              <KeyRound size={15} aria-hidden="true" />
              <span id="ca-google-app-heading">
                {t('中心 Google 应用（Web OAuth）', 'Center Google App (Web OAuth)')}
              </span>
              {clientInvalid ? (
                <span className="ca-pill ca-pill-danger">{t('应用凭据无效', 'Invalid client')}</span>
              ) : clientConfigured ? (
                <span className="ca-pill ca-pill-ok">
                  {clientIdTail
                    ? t(`已配置 · Web Client ${clientIdTail}`, `Configured · Web Client ${clientIdTail}`)
                    : t('已配置', 'Configured')}
                </span>
              ) : (
                <span className="ca-pill ca-pill-muted">{t('未配置', 'Not configured')}</span>
              )}
              {client.projectId && (
                <span className="ca-pill ca-pill-muted ca-mono">{client.projectId}</span>
              )}
            </div>
            <span className="ca-row-sub">
              {clientConfigured
                ? t('由中心统一加密托管，Client Secret 永不回显也不支持导出。下方已连接账号对本中心所有现有和未来 Bot 默认可用，无需逐 Bot 开启。', 'Encrypted in Center storage; Client Secret is never shown or exported. Connected accounts below are shared across all current and future Bots with no per-Bot switches.')
                : t('只需在中心配置一次 Web OAuth 应用，所有主机上的 Bot 都可复用，无需在每台设备重复导入密钥文件。', 'Configure one Web OAuth app in Center and every Bot across your hosts can reuse it—no per-machine key files.')}
            </span>
          </div>

          <div className="ca-row-actions ca-wrap">
            {!clientConfigured ? (
              <>
                <button
                  type="button"
                  className="ca-btn ca-btn-primary ca-btn-sm"
                  onClick={openConfigureDrawer}
                >
                  <Lock size={13} aria-hidden="true" />
                  <span>{t('录入 Web OAuth 凭据', 'Enter Web OAuth credentials')}</span>
                </button>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  onClick={() => setWizardOpen(true)}
                >
                  <Bot size={13} aria-hidden="true" />
                  <span>{t('通过目标 Bot 向导创建', 'Guided setup via Bot')}</span>
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ca-btn ca-btn-primary ca-btn-sm"
                  disabled={activeFlow?.phase === 'pending'}
                  onClick={() => openConnectModal(null)}
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>{t('连接 Google 账号', 'Connect Google account')}</span>
                </button>
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  onClick={openConfigureDrawer}
                >
                  <Settings2 size={13} aria-hidden="true" />
                  <span>{t('更换凭据', 'Rotate credentials')}</span>
                </button>
                <button
                  type="button"
                  className="ca-btn ca-btn-ghost ca-btn-icon"
                  disabled={refreshing}
                  aria-label={t('刷新 Google 状态', 'Refresh Google status')}
                  title={t('刷新', 'Refresh')}
                  onClick={() => void loadAll({ silent: true })}
                >
                  <RefreshCw size={15} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </div>

        {/* Redirect URI row + invalid client alert */}
        <div className="ca-google-subbar">
          <div className="ca-google-redirect-line">
            <span className="ca-muted">
              {t('已授权的重定向 URI', 'Authorized redirect URI')}
              {redirectInfo.isPreview ? t('（参考）', ' (preview)') : ''}
            </span>
            <code className="ca-mono ca-google-uri">{redirectInfo.uri}</code>
            <CopyButton value={redirectInfo.uri} label={t('复制 URI', 'Copy URI')} />
          </div>
          {clientInvalid && (
            <p className="ca-error-text" role="alert" style={{ marginTop: 8 }}>
              {client.error ||
                t('Google 已无法识别当前 Web OAuth 应用（可能已在 Cloud Console 中被删除或停用）。请更换有效凭据后重新连接账号。', 'Google no longer recognizes this Web OAuth client. Rotate to valid credentials and reconnect accounts.')}
            </p>
          )}
        </div>
      </section>

      {/* 2. Active System Browser Authorization Flow Banner */}
      {activeFlow && (
        <section className="ca-section ca-oauth-card" aria-live="polite">
          <div className="ca-oauth-head">
            <div className="ca-oauth-head-main">
              <div className="ca-row-title">
                {activeFlow.phase === 'pending' ? (
                  <>
                    <Loader2 size={15} aria-hidden="true" className="ca-spin" />
                    <span>{t('等待系统浏览器完成 Google 授权', 'Waiting for Google sign-in in system browser')}</span>
                    <span className="ca-pill ca-pill-info ca-num">
                      {t('剩余', 'Left')} {formatCountdown(activeFlow.expiresAt, nowMs)}
                    </span>
                  </>
                ) : activeFlow.phase === 'cancelled' ? (
                  <>
                    <AlertCircle size={15} aria-hidden="true" />
                    <span>{t('已取消此次授权', 'Authorization cancelled')}</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle size={15} aria-hidden="true" />
                    <span>{t('授权未完成', 'Authorization did not finish')}</span>
                  </>
                )}
              </div>
              <p className="ca-oauth-hint" style={{ margin: '4px 0 0' }}>
                {activeFlow.phase === 'pending'
                  ? t('请在刚打开的系统浏览器中完成 Google 登录、MFA 验证与权限同意。授权完成后会自动回流，无需复制回调地址到聊天。', 'Complete Google sign-in, MFA, and consent in your system browser. This page refreshes automatically—never paste callback URLs into chat.')
                  : activeFlow.error}
              </p>
              <div className="ca-muted" style={{ marginTop: 4 }}>
                {activeFlow.targetAccount ? `${activeFlow.targetAccount} · ` : ''}
                {activeFlow.choices.map(c => googleChoiceShortLabel(c, t)).join(' · ')}
              </div>
            </div>

            <div className="ca-row-actions ca-wrap">
              {activeFlow.phase === 'pending' ? (
                <>
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() =>
                      void openExternalUrl(activeFlow.authorizationUrl, onOpenExternalUrl)
                    }
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                    <span>{t('重新打开浏览器', 'Reopen browser')}</span>
                  </button>
                  <button
                    type="button"
                    className="ca-btn ca-btn-ghost ca-btn-sm"
                    disabled={cancellingFlow}
                    onClick={() => void handleCancelFlow()}
                  >
                    {cancellingFlow ? t('正在取消…', 'Cancelling…') : t('取消', 'Cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    onClick={() =>
                      void startAuthorize(activeFlow.choices, activeFlow.targetAccount)
                    }
                  >
                    {t('重新开始', 'Try again')}
                  </button>
                  <button
                    type="button"
                    className="ca-btn ca-btn-ghost ca-btn-sm"
                    onClick={() => setActiveFlow(null)}
                  >
                    {t('关闭', 'Dismiss')}
                  </button>
                </>
              )}
            </div>
          </div>

          {activeFlow.phase === 'pending' && (
            <CaDisclosure title={t('浏览器未自动弹出？手动打开授权链接', 'Browser did not open? Copy or open link')}>
              <CaExternalUrlBox
                url={activeFlow.authorizationUrl}
                onOpenUrl={onOpenExternalUrl}
                copyLabel={t('复制链接', 'Copy link')}
              />
            </CaDisclosure>
          )}
        </section>
      )}

      {/* 3. Shared Google Accounts Section */}
      <section className="ca-section" aria-labelledby="ca-google-accounts-heading">
        <div className="ca-section-head">
          <div>
            <h3 id="ca-google-accounts-heading" className="ca-section-title">
              {t('共享 Google 账号', 'Shared Google Accounts')}
              {accounts.length > 0 ? ` (${accounts.length})` : ''}
            </h3>
            <div className="ca-muted" style={{ marginTop: 2 }}>
              {accounts.length === 0
                ? t('连接后，本中心现在和以后创建的所有 Bot 都可使用已就绪的 Google 服务。', 'Once connected, all current and future Bots on this Center can use ready Google services.')
                : accounts.length === 1
                  ? t('当前 1 个共享账号，所有 Bot 默认使用此账号，无需逐 Bot 分配或开关。', '1 shared account: all Bots use it by default with no per-Bot toggles.')
                  : t(`当前 ${accounts.length} 个共享账号，所有 Bot 均可使用。请求未指明账号时，Bot 会先确认这次用哪个账号，不会随意切换。`, `${accounts.length} shared accounts available to all Bots. When unspecified, Bots ask which account to use instead of guessing.`)}
            </div>
          </div>

          {clientConfigured && (
            <button
              type="button"
              className="ca-btn ca-btn-sm"
              disabled={activeFlow?.phase === 'pending'}
              onClick={() => openConnectModal(null)}
            >
              <Plus size={13} aria-hidden="true" />
              <span>{accounts.length === 0 ? t('连接账号', 'Connect account') : t('添加其他账号', 'Add another account')}</span>
            </button>
          )}
        </div>

        {accounts.length === 0 ? (
          <div className="ca-empty">
            {clientConfigured ? (
              <div className="ca-google-empty-stack">
                <p style={{ margin: 0 }}>
                  {t('尚未连接 Google 账号。使用本人系统浏览器完成授权后，所有 Bot 立即可用。', 'No Google account connected yet. Authorize in your system browser to make Google services available to all Bots.')}
                </p>
                <div className="ca-inline-row" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    disabled={activeFlow?.phase === 'pending'}
                    onClick={() => openConnectModal(null)}
                  >
                    <Globe size={14} aria-hidden="true" />
                    <span>{t('前往 Google 登录', 'Sign in to Google')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="ca-google-empty-stack">
                <p style={{ margin: 0 }}>
                  {t('请先配置中心 Google Web OAuth 应用，再通过系统浏览器连接你的 Google 账号。', 'Configure the Center Google Web OAuth app first, then sign in with your Google account in your system browser.')}
                </p>
                <div className="ca-inline-row ca-wrap" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    onClick={openConfigureDrawer}
                  >
                    {t('我已有凭据，直接录入', 'Enter credentials directly')}
                  </button>
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() => setWizardOpen(true)}
                  >
                    {t('选择目标 Bot 引导创建', 'Guided setup via Bot')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="ca-list">
            {accounts.map(account => {
              const needsReconnect = isAccountReconnectRequired(account);
              const transientErr =
                transientCheckErrors[account.email] ||
                (account.status === 'temp_error'
                  ? account.error ||
                    account.reason ||
                    t('暂时无法连接 Google 验证状态', 'Temporarily unable to reach Google')
                  : '');
              const checking = checkingAccounts.has(account.email);
              const readinessRows = buildReadinessRows(account.services ?? [], t);
              const activeProblems = readinessRows.filter(
                row =>
                  row.state !== 'ready' &&
                  !(row.state === 'needs-permission' && skippedServices[`${account.email}::${row.key}`]),
              );
              const existingChoices = canonicalChoices(account.choices ?? []);
              const missingChoices = GOOGLE_SERVICE_CHOICES.filter(c => !existingChoices.includes(c));
              const accountRuleCount = rules.filter(
                r => r.account === account.email || (account.id && r.account === account.id),
              ).length;

              return (
                <div key={account.id || account.email} className="ca-google-account">
                  <div className="ca-google-account-head">
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <span>{account.email}</span>
                        {needsReconnect ? (
                          <span className="ca-pill ca-pill-danger">
                            {t('需重连', 'Reconnect required')}
                          </span>
                        ) : transientErr ? (
                          <span className="ca-pill ca-pill-warn">
                            {t('暂时不可达', 'Temporarily unreachable')}
                          </span>
                        ) : activeProblems.length > 0 ? (
                          <span className="ca-pill ca-pill-warn">
                            {t(`已连接 · ${activeProblems.length} 项待处理`, `Connected · ${activeProblems.length} to fix`)}
                          </span>
                        ) : (
                          <span className="ca-pill ca-pill-ok">{t('已连接', 'Connected')}</span>
                        )}
                      </div>
                      <span className="ca-row-sub">
                        {t('所有 Bot 共用', 'Shared by all Bots')}
                        {accountRuleCount > 0
                          ? t(` · 关联 ${accountRuleCount} 条自动规则`, ` · ${accountRuleCount} rule(s)`)
                          : ''}
                        {account.checkedAt
                          ? t(` · 上次检查 ${formatTime(account.checkedAt, locale)}`, ` · Checked ${formatTime(account.checkedAt, locale)}`)
                          : ''}
                      </span>
                    </div>

                    <div className="ca-row-actions ca-wrap">
                      {needsReconnect ? (
                        <button
                          type="button"
                          className="ca-btn ca-btn-primary ca-btn-sm"
                          disabled={activeFlow?.phase === 'pending' || !clientConfigured}
                          onClick={() =>
                            void startAuthorize(
                              existingChoices.length > 0 ? existingChoices : ['gmail', 'calendar', 'files'],
                              account.email,
                            )
                          }
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                          <span>{t('重新连接', 'Reconnect')}</span>
                        </button>
                      ) : transientErr ? (
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          disabled={checking}
                          onClick={() => void handleCheckAccount(account)}
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                          <span>{checking ? t('检查中…', 'Checking…') : t('重试检查', 'Retry check')}</span>
                        </button>
                      ) : (
                        <>
                          {missingChoices.length > 0 && (
                            <button
                              type="button"
                              className="ca-btn ca-btn-sm"
                              disabled={activeFlow?.phase === 'pending'}
                              onClick={() => openConnectModal(account)}
                            >
                              <Plus size={13} aria-hidden="true" />
                              <span>{t('添加服务', 'Add services')}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            className="ca-btn ca-btn-ghost ca-btn-sm"
                            disabled={checking}
                            onClick={() => void handleCheckAccount(account)}
                          >
                            <RefreshCw size={13} aria-hidden="true" />
                            <span>{checking ? t('检查中…', 'Checking…') : t('重新检查', 'Check')}</span>
                          </button>
                        </>
                      )}

                      <ActionMenu
                        items={[
                          {
                            label: t('重新检查服务', 'Check services'),
                            disabled: checking,
                            onSelect: () => void handleCheckAccount(account),
                          },
                          {
                            label: t('管理服务 / 补充授权', 'Manage / add services'),
                            disabled: activeFlow?.phase === 'pending' || !clientConfigured,
                            onSelect: () => openConnectModal(account),
                          },
                          {
                            label: t('重新连接账号', 'Reconnect account'),
                            disabled: activeFlow?.phase === 'pending' || !clientConfigured,
                            onSelect: () =>
                              void startAuthorize(
                                existingChoices.length > 0 ? existingChoices : ['gmail', 'calendar', 'files'],
                                account.email,
                              ),
                          },
                          {
                            label: t('���除账号…', 'Remove account…'),
                            danger: true,
                            onSelect: () => {
                              setRemoveTarget(account);
                              setRemoveRevoke(true);
                              setRemoveError('');
                            },
                          },
                        ]}
                      />
                    </div>
                  </div>

                  {needsReconnect && (
                    <div className="ca-google-account-alert is-danger" role="alert">
                      <AlertTriangle size={14} aria-hidden="true" />
                      <span>
                        {account.reason ||
                          account.error ||
                          t('Google 授权已失效或被撤销，依赖此账号的自动规则已暂停。请由本人点击「重新连接」完成授权（不会覆盖其他账号）。', 'Google authorization expired or was revoked. Dependent trigger rules are paused. Click Reconnect as the account owner.')}
                      </span>
                    </div>
                  )}

                  {!needsReconnect && transientErr && (
                    <div className="ca-google-account-alert is-warn" role="status">
                      <AlertCircle size={14} aria-hidden="true" />
                      <span>{transientErr}</span>
                    </div>
                  )}

                  {/* Per-service readiness rows */}
                  {readinessRows.length > 0 && (
                    <div className="ca-google-services" role="list" aria-label={t('服务就绪度', 'Service readiness')}>
                      {readinessRows.map(row => {
                        const skipKey = `${account.email}::${row.key}`;
                        const isSkipped = Boolean(skippedServices[skipKey]);
                        const badge = readinessBadgeMeta(row.state, isSkipped, t);
                        const copyId = `admin-${account.email}-${row.key}`;
                        const enableUrl =
                          row.enableUrl || googleApiEnableUrl(row.service, client.projectId);

                        return (
                          <div key={row.key} className="ca-google-service-row" role="listitem">
                            <div className="ca-google-service-main">
                              <div className="ca-row-title">
                                <span className="ca-google-service-name">{row.label}</span>
                                <span className={`ca-pill ca-pill-${badge.tone}`}>{badge.label}</span>
                              </div>
                              {row.detail && row.state !== 'ready' && (
                                <span className="ca-row-sub">{row.detail}</span>
                              )}
                            </div>

                            <div className="ca-row-actions ca-wrap">
                              {row.state === 'needs-permission' && (
                                <>
                                  <button
                                    type="button"
                                    className="ca-btn ca-btn-sm"
                                    disabled={activeFlow?.phase === 'pending' || !clientConfigured}
                                    onClick={() => {
                                      const choices = row.choice
                                        ? mergeChoices(existingChoices, [row.choice])
                                        : existingChoices;
                                      if (choices.length) void startAuthorize(choices, account.email);
                                      else openConnectModal(account);
                                    }}
                                  >
                                    {t('补授权', 'Grant permission')}
                                  </button>
                                  {!isSkipped && (
                                    <button
                                      type="button"
                                      className="ca-btn ca-btn-ghost ca-btn-sm"
                                      onClick={() =>
                                        setSkippedServices(prev => ({ ...prev, [skipKey]: true }))
                                      }
                                    >
                                      {t('暂不使用', 'Skip')}
                                    </button>
                                  )}
                                </>
                              )}

                              {row.state === 'api-disabled' && (
                                <>
                                  <button
                                    type="button"
                                    className="ca-btn ca-btn-sm"
                                    onClick={() => void openExternalUrl(enableUrl, onOpenExternalUrl)}
                                  >
                                    <ExternalLink size={12} aria-hidden="true" />
                                    <span>{t('去控制台启用', 'Enable in Console')}</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="ca-btn ca-btn-ghost ca-btn-sm"
                                    disabled={checking}
                                    onClick={() => void handleCheckAccount(account)}
                                  >
                                    {t('重新检查', 'Re-check')}
                                  </button>
                                </>
                              )}

                              {row.state === 'blocked-by-admin' && (
                                <button
                                  type="button"
                                  className="ca-btn ca-btn-sm"
                                  onClick={() =>
                                    void handleCopyWithFeedback(
                                      copyId,
                                      googleAdminTrustMessage(client.clientId, t),
                                    )
                                  }
                                >
                                  {copiedKey === copyId ? (
                                    <Check size={12} aria-hidden="true" />
                                  ) : (
                                    <Shield size={12} aria-hidden="true" />
                                  )}
                                  <span>
                                    {copiedKey === copyId
                                      ? t('已复制', 'Copied')
                                      : t('复制给管理员', 'Copy for admin')}
                                  </span>
                                </button>
                              )}

                              {row.state === 'error' && (
                                <button
                                  type="button"
                                  className="ca-btn ca-btn-sm"
                                  disabled={checking}
                                  onClick={() => void handleCheckAccount(account)}
                                >
                                  <RefreshCw size={12} aria-hidden="true" />
                                  <span>{t('重新检查', 'Re-check')}</span>
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4. Automatic Trigger Rules Section (New Mail / Pre-Meeting) */}
      <section className="ca-section" aria-labelledby="ca-google-rules-heading">
        <div className="ca-section-head">
          <div>
            <h3 id="ca-google-rules-heading" className="ca-section-title">
              {t('自动触发规则（新邮件 / 会前提醒）', 'Automatic Trigger Rules (Mail / Meetings)')}
              {!rulesUnavailable && rules.length > 0 ? ` (${rules.length})` : ''}
            </h3>
            <div className="ca-muted" style={{ marginTop: 2 }}>
              {t('Google 工具已自动对所有 Bot 开放；此处仅配置由中心主动推送给指定 Bot 的自动规则。暂停规则不会撤销账号授权。', 'Google tools are automatically available to every Bot. Rules here only configure proactive triggers for a chosen Bot; pausing a rule never revokes Google access.')}
            </div>
          </div>

          {!rulesUnavailable && (
            <div className="ca-toolbar-group">
              {activeBots.length > 1 && (
                <select
                  className="ca-select ca-google-filter-select"
                  aria-label={t('按 Bot 筛选规则', 'Filter rules by Bot')}
                  value={ruleBotFilter}
                  onChange={e => setRuleBotFilter(e.target.value)}
                >
                  <option value="all">{t('全部 Bot', 'All Bots')}</option>
                  {botsByDevice.map(([devId, group]) => (
                    <optgroup key={devId} label={group.device?.name || devId}>
                      {group.bots.map(b => (
                        <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                          {b.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="ca-btn ca-btn-sm"
                disabled={accounts.length === 0 || activeBots.length === 0}
                onClick={openCreateRuleDrawer}
              >
                <Plus size={13} aria-hidden="true" />
                <span>{t('新建规则', 'New rule')}</span>
              </button>
            </div>
          )}
        </div>

        {rulesError && (
          <div className="ca-section-body">
            <CaNotice tone="danger">{rulesError}</CaNotice>
          </div>
        )}

        {rulesUnavailable ? (
          <div className="ca-empty">
            {t('当前中心尚未启用 Google 自动触发规则接口（/api/google/rules 不可用）。主动使用 Google 工具不受影响。', 'Google automatic trigger rules (/api/google/rules) are not enabled on this Center yet. On-demand Google tools are unaffected.')}
          </div>
        ) : filteredRules.length === 0 ? (
          <div className="ca-empty">
            {accounts.length === 0
              ? t('连接 Google 账号后，可按需为指定 Bot 添加新邮件或会前提醒规则。', 'Connect a Google account to configure new-mail or pre-meeting rules for specific Bots.')
              : activeBots.length === 0
                ? t('暂无可用 Bot。在任一主机创建 Bot 后可为其配置自动触发规则。', 'No active Bots yet. Create a Bot on any host to assign trigger rules.')
                : t('暂无自动触发规则。所有 Bot 仍可随时在对话中主动查询或处理 Google 任务。', 'No automatic trigger rules yet. All Bots can still use Google tools on demand in chat.')}
          </div>
        ) : (
          <div className="ca-list">
            {filteredRules.map((rule, idx) => {
              const eff = ruleEffectiveStatus(rule, accountsByKey, t);
              const idKey = rule.id || `${rule.deviceId}::${rule.botId}::${rule.source}::${idx}`;
              const isToggling = togglingRuleId === idKey;
              const filterSummary =
                rule.source === 'gmail'
                  ? [
                      rule.from ? t(`发件人：${rule.from}`, `From: ${rule.from}`) : null,
                      rule.subjectContains
                        ? t(`主题含：${rule.subjectContains}`, `Subject: ${rule.subjectContains}`)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || t('全部新到达邮件', 'All new arriving mail')
                  : t(`日历：${rule.calendar || 'primary'} · 提前 ${rule.minutesBefore ?? 15} 分钟`, `Calendar: ${rule.calendar || 'primary'} · ${rule.minutesBefore ?? 15} min before`);

              return (
                <div key={idKey} className="ca-row">
                  <div className="ca-row-main">
                    <div className="ca-row-title">
                      <span className="ca-pill ca-pill-info">
                        {rule.source === 'gmail'
                          ? t('新邮件', 'New mail')
                          : t('会前提醒', 'Pre-meeting')}
                      </span>
                      <span>{formatBotDisplay(rule.deviceId, rule.botId)}</span>
                      <span className={`ca-pill ca-pill-${eff.tone}`}>{eff.label}</span>
                    </div>
                    <span className="ca-row-sub">
                      {rule.account} · {filterSummary}
                    </span>
                    <span className="ca-row-sub">{rule.instruction}</span>
                    {(rule.lastCheckedAt || rule.lastError) && (
                      <span className="ca-row-sub">
                        {rule.lastCheckedAt && (
                          <>
                            <Clock size={11} aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: 4 }} />
                            {t('上次检查 ', 'Last checked ')}
                            {formatTime(rule.lastCheckedAt, locale)}
                          </>
                        )}
                        {rule.lastError ? ` · ${rule.lastError}` : ''}
                      </span>
                    )}
                  </div>

                  <div className="ca-row-actions">
                    <CaSwitch
                      checked={rule.enabled}
                      disabled={isToggling}
                      label={t('启用或暂停此规则', 'Enable or pause this rule')}
                      onChange={next => void handleToggleRule(rule, next)}
                    />
                    <button
                      type="button"
                      className="ca-btn ca-btn-ghost ca-btn-icon"
                      aria-label={t('编辑规则', 'Edit rule')}
                      title={t('编辑', 'Edit')}
                      onClick={() => openEditRuleDrawer(rule)}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </button>
                    {rule.id && (
                      <button
                        type="button"
                        className="ca-btn ca-btn-ghost ca-btn-icon"
                        aria-label={t('删除规则', 'Delete rule')}
                        title={t('删除', 'Delete')}
                        onClick={() => void handleDeleteRule(rule)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Drawer A: Private Web OAuth Client Configuration */}
      <CaModal
        open={configOpen}
        onOpenChange={open => {
          if (!open) closeConfigureDrawer();
        }}
        title={
          clientConfigured
            ? t('更换中心 Google Web OAuth 凭据', 'Rotate Center Google Web OAuth Credentials')
            : t('配置中心 Google Web OAuth 应用', 'Configure Center Google Web OAuth App')
        }
        description={t('私密直传中心加密凭据库，保存后立即清空，不进入聊天记录，永不回显或导出 Client Secret。', 'Sent directly to Center encrypted storage. Cleared immediately on save; never enters chat, never displayed or exported.')}
        variant="drawer"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSaveClientConfig(e)}>
          {clientConfigured && (
            <CaNotice tone="warn">
              {t('更换为新的 Google OAuth 应用后，现有已连接的账号可能需要重新连接以重新签发令牌。', 'Switching to a different Google OAuth client may require existing accounts to reconnect.')}
            </CaNotice>
          )}

          <div className="ca-cred-box">
            <div className="ca-field-head" style={{ marginBottom: 4 }}>
              <span className="ca-field-label">
                {t('已授权的重定向 URI（在 Google Cloud 填入此地址）', 'Authorized redirect URI (add this in Google Cloud)')}
              </span>
              <CopyButton value={redirectInfo.uri} label={t('复制', 'Copy')} />
            </div>
            <div className="ca-mono ca-google-uri">{redirectInfo.uri}</div>
          </div>

          <div>
            <CaSegmented<'file' | 'manual'>
              value={configMode}
              onChange={next => {
                setConfigMode(next);
                setConfigError('');
                setClientFileName('');
                setClientFileRaw('');
                setClientIdDraft('');
                setClientSecretDraft('');
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              ariaLabel={t('凭据录入方式', 'Credential entry method')}
              options={[
                { value: 'file', label: t('上传 Web JSON 文件', 'Upload Web JSON') },
                { value: 'manual', label: t('手动输入 ID 与 Secret', 'Enter ID & Secret') },
              ]}
            />
          </div>

          {configMode === 'file' ? (
            <div className="ca-field">
              <label className="ca-field-label">
                {t('Google Cloud Web OAuth 客户端 JSON', 'Google Cloud Web OAuth client JSON')}
                <span className="ca-req">*</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={e => void handleJsonFilePick(e.target.files?.[0])}
              />
              <div
                role="button"
                tabIndex={0}
                className={`ca-dropzone${draggingJson ? ' is-dragging' : ''}`}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={e => {
                  e.preventDefault();
                  setDraggingJson(true);
                }}
                onDragLeave={() => setDraggingJson(false)}
                onDrop={e => {
                  e.preventDefault();
                  setDraggingJson(false);
                  void handleJsonFilePick(e.dataTransfer.files?.[0]);
                }}
              >
                <Upload size={18} aria-hidden="true" style={{ marginBottom: 6 }} />
                <div style={{ fontWeight: 500 }}>
                  {clientFileName
                    ? clientFileName
                    : t('点击选择或拖入 client_secret_*.json', 'Click or drop client_secret_*.json')}
                </div>
                <div className="ca-muted" style={{ marginTop: 4 }}>
                  {t('仅接受 Web application 客户端 JSON（≤ 64 KB）；拒绝桌面端、Service Account 与令牌文件', 'Accepts Web application client JSON only (≤ 64 KB); rejects Desktop, Service Account, and token files.')}
                </div>
              </div>

              {clientJsonValidation &&
                (clientJsonValidation.ok ? (
                  <CaNotice tone={clientJsonValidation.warning ? 'warn' : 'ok'}>
                    <div>
                      <CheckCircle2
                        size={13}
                        aria-hidden="true"
                        style={{ verticalAlign: '-2px', marginRight: 5 }}
                      />
                      {t(`已通过本地预检 · Web Client ${clientJsonValidation.clientIdTail ?? ''}${clientJsonValidation.projectId ? ` · 项目 ${clientJsonValidation.projectId}` : ''}`, `Pre-check passed · Web Client ${clientJsonValidation.clientIdTail ?? ''}${clientJsonValidation.projectId ? ` · Project ${clientJsonValidation.projectId}` : ''}`)}
                    </div>
                    {clientJsonValidation.warning && (
                      <div style={{ marginTop: 4 }}>{clientJsonValidation.warning}</div>
                    )}
                  </CaNotice>
                ) : (
                  <p className="ca-error-text" role="alert">
                    {clientJsonValidation.error}
                  </p>
                ))}
            </div>
          ) : (
            <>
              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-google-client-id">
                  Client ID<span className="ca-req">*</span>
                </label>
                <input
                  id="ca-google-client-id"
                  type="text"
                  className="ca-input ca-mono"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="123456789-xxxx.apps.googleusercontent.com"
                  value={clientIdDraft}
                  onChange={e => setClientIdDraft(e.target.value)}
                />
              </div>

              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-google-client-secret">
                  Client Secret<span className="ca-req">*</span>
                </label>
                <input
                  id="ca-google-client-secret"
                  type="password"
                  className="ca-input ca-mono"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder="GOCSPX-..."
                  value={clientSecretDraft}
                  onChange={e => setClientSecretDraft(e.target.value)}
                />
                <p className="ca-field-help">
                  {t('仅用于提交给中心加密存储，保存后立即从界面清空，不留存浏览器缓存。', 'Submitted directly to Center encrypted storage and wiped immediately after saving.')}
                </p>
              </div>
            </>
          )}

          {configError && (
            <p className="ca-error-text" role="alert">
              {configError}
            </p>
          )}

          <CaDisclosure title={t('还没有 Web OAuth 应用？查看手动创建步骤', 'Need to create a Web OAuth app? Manual steps')}>
            <ol className="ca-google-steps">
              <li>
                <span>{t('在 Google Cloud 创建或选择项目：', 'Create or select a Google Cloud project: ')}</span>
                <a
                  href={GOOGLE_CLOUD_CREATE_PROJECT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ca-oauth-inline-link"
                  onClick={e => {
                    e.preventDefault();
                    void openExternalUrl(GOOGLE_CLOUD_CREATE_PROJECT_URL, onOpenExternalUrl);
                  }}
                >
                  {t('新建项目', 'Create project')}
                </a>
              </li>
              <li>
                <span>{t('在项目中启用所需 API（People、Gmail、Calendar、Drive/Docs/Sheets）：', 'Enable the required APIs in your project: ')}</span>
                <a
                  href={googleEnableFlowUrl(['gmail', 'calendar', 'files'])}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ca-oauth-inline-link"
                  onClick={e => {
                    e.preventDefault();
                    void openExternalUrl(
                      googleEnableFlowUrl(['gmail', 'calendar', 'files']),
                      onOpenExternalUrl,
                    );
                  }}
                >
                  {t('一键打开 API 启用页', 'Open API enable flow')}
                </a>
                <span className="ca-muted">
                  {' '}
                  {t('（启用 API 仅开通项目能力，不代表授权个人数据）', '(enabling APIs does not grant personal data access)')}
                </span>
              </li>
              <li>
                <span>
                  {t('配置 Google Auth Platform（填入你的应用名、联系邮箱、自托管中心域名，选择受众 External 或 Workspace Internal，并由本人勾选用户数据政策）：', 'Configure Google Auth Platform (your app name, email, your own Center domain, External or Workspace Internal audience, and personally agree to the User Data Policy): ')}
                </span>
                <a
                  href={GOOGLE_CLOUD_AUTH_OVERVIEW_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ca-oauth-inline-link"
                  onClick={e => {
                    e.preventDefault();
                    void openExternalUrl(GOOGLE_CLOUD_AUTH_OVERVIEW_URL, onOpenExternalUrl);
                  }}
                >
                  {t('打开 Auth Platform', 'Open Auth Platform')}
                </a>
              </li>
              <li>
                <span>
                  {t('创建 OAuth 客户端，应用类型务必选择 Web application，并将上方的「已授权的重定向 URI」添加到 Authorized redirect URIs：', 'Create an OAuth client of type Web application and add the Authorized redirect URI shown above: ')}
                </span>
                <a
                  href={GOOGLE_CLOUD_AUTH_CLIENTS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ca-oauth-inline-link"
                  onClick={e => {
                    e.preventDefault();
                    void openExternalUrl(GOOGLE_CLOUD_AUTH_CLIENTS_URL, onOpenExternalUrl);
                  }}
                >
                  {t('打开 OAuth Clients', 'Open OAuth Clients')}
                </a>
              </li>
              <li>
                {t('下载 JSON 上传到上方，或直接粘贴 Client ID 与 Client Secret 保存。', 'Download the JSON and upload it above, or paste Client ID and Client Secret directly.')}
              </li>
            </ol>
          </CaDisclosure>

          <div className="ca-form-actions ca-form-actions-between">
            <button
              type="button"
              className="ca-btn ca-btn-ghost ca-btn-sm"
              onClick={() => {
                closeConfigureDrawer();
                setWizardOpen(true);
              }}
            >
              {t('改用目标 Bot 向导', 'Use Bot setup wizard')}
            </button>
            <div className="ca-inline-row">
              <button
                type="button"
                className="ca-btn"
                disabled={configBusy}
                onClick={closeConfigureDrawer}
              >
                {t('取消', 'Cancel')}
              </button>
              <button
                type="submit"
                className="ca-btn ca-btn-primary"
                disabled={
                  configBusy ||
                  (configMode === 'file'
                    ? !clientFileRaw || !clientJsonValidation?.ok
                    : !clientIdDraft.trim() || !clientSecretDraft.trim())
                }
              >
                {configBusy ? t('加密保存中…', 'Saving…') : t('加密保存', 'Save encrypted')}
              </button>
            </div>
          </div>
        </form>
      </CaModal>

      {/* Drawer B: Target Bot Browser Setup Wizard / Manual Mode Path */}
      <CaModal
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        title={t('选择目标 Bot 进入建项向导或手动模式', 'Guided Google App Setup via Bot or Manual Mode')}
        description={t('可选择一台在线主机上的 Bot 进入三模式建项向导（自动代办 / 内嵌指导 / 外部浏览器指导），或直接在此手动录入。', 'Launch the 3-mode setup wizard on a target Bot (Do it for me / Guide me here / Guide me in my browser), or enter credentials manually here.')}
        variant="drawer"
      >
        <div className="ca-form-stack">
          <CaNotice tone="info">
            {t('建项过程中涉及 Google 登录、条款勾选与创建 Client Secret 时，必须由本人亲自确认，凭据通过私密控件直传中心，不经过聊天记录。', 'Google sign-in, policy agreement, and Client Secret creation always require you directly. Credentials are submitted privately to Center, never via chat.')}
          </CaNotice>

          {activeBots.length === 0 ? (
            <div className="ca-empty-hint">
              {t('当前中心暂无可用 Bot。你可以先在手动模式中直接录入 Web OAuth 凭据，或先在桌面端/手机端创建 Bot。', 'No active Bots on this Center yet. You can enter Web OAuth credentials manually now, or create a Bot in the PiBot app first.')}
            </div>
          ) : (
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-google-wizard-bot">
                {t('选择目标 Bot', 'Target Bot')}
              </label>
              <select
                id="ca-google-wizard-bot"
                className="ca-select"
                value={wizardTargetBotKey}
                onChange={e => setWizardTargetBotKey(e.target.value)}
              >
                {botsByDevice.map(([devId, group]) => {
                  const dev = group.device;
                  const suffix = dev
                    ? ` (${platformLabel(dev.platform, t)}${dev.online ? '' : t(' · 离线', ' · offline')})`
                    : '';
                  return (
                    <optgroup key={devId} label={`${dev?.name || devId}${suffix}`}>
                      {group.bots.map(b => (
                        <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                          {b.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>

              {selectedWizardDevice && selectedWizardDevice.platform === 'android' && (
                <p className="ca-field-help">
                  {t('提示：Android 本机 Host 受系统策略限制，进入向导后将默认推荐「外部浏览器指导（Guide me in my browser）」。如需内嵌浏览器协助，请选择在线桌面主机上的 Bot。', 'Note: Android local hosts default to "Guide me in my browser". Pick an online desktop host Bot for embedded browser assistance.')}
                </p>
              )}

              {selectedWizardDevice && !selectedWizardDevice.online && (
                <p className="ca-field-help">
                  {t('当前所选设备处于离线状态。设备上线后可在该 Bot 中启动建项向导，或现在直接切换手动模式录入。', 'The selected device is currently offline. Bring it online to run the wizard on that Bot, or switch to manual entry now.')}
                </p>
              )}
            </div>
          )}

          {selectedWizardBot && !canJumpToBotWizard && (
            <div className="ca-cred-box">
              <div className="ca-field-label" style={{ marginBottom: 4 }}>
                {t('在 PiBot 客户端打开该 Bot 启动向导', 'Open this Bot in the PiBot app to start the wizard')}
              </div>
              <p className="ca-field-help" style={{ marginBottom: 8 }}>
                {t(`当前处于独立中心网页，浏览器建项向导需在目标主机对应的 PiBot 桌面端或手机端打开「${formatBotDisplay(selectedWizardBot.deviceId, selectedWizardBot.botId)}」，然后发送“帮我配置 Google 应用”或在能力设置中启动向导。完成后将下载的 Web OAuth JSON 回到此处私密录入即可。`, `You are in the standalone Center web console. Open "${formatBotDisplay(selectedWizardBot.deviceId, selectedWizardBot.botId)}" in the PiBot desktop or mobile app to run the browser setup wizard, then save the Web OAuth credentials here.`)}
              </p>
              <div className="ca-inline-row ca-wrap">
                <CopyButton
                  value={redirectInfo.uri}
                  label={t('复制回调 URI', 'Copy redirect URI')}
                />
              </div>
            </div>
          )}

          <div className="ca-form-actions ca-form-actions-between">
            <button
              type="button"
              className="ca-btn"
              onClick={() => {
                setWizardOpen(false);
                openConfigureDrawer();
              }}
            >
              {t('切到手动录入模式', 'Switch to manual entry')}
            </button>

            <div className="ca-inline-row">
              <button type="button" className="ca-btn ca-btn-ghost" onClick={() => setWizardOpen(false)}>
                {t('关闭', 'Close')}
              </button>
              {selectedWizardBot && canJumpToBotWizard && (
                <button
                  type="button"
                  className="ca-btn ca-btn-primary"
                  onClick={() => {
                    setWizardOpen(false);
                    if (onStartGoogleSetupWizard) {
                      onStartGoogleSetupWizard(selectedWizardBot.deviceId, selectedWizardBot.botId);
                    } else if (onConfigureBot) {
                      onConfigureBot(selectedWizardBot.deviceId, selectedWizardBot.botId);
                    }
                  }}
                >
                  <Bot size={14} aria-hidden="true" />
                  <span>{t('打开目标 Bot 向导', 'Open target Bot wizard')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </CaModal>

      {/* Modal C: Connect / Add Services (System Browser OAuth) */}
      <CaModal
        open={connectOpen}
        onOpenChange={open => {
          setConnectOpen(open);
          if (!open) {
            setConnectError('');
            setConnectTargetAccount(null);
          }
        }}
        title={
          connectTargetAccount
            ? t(`为 ${connectTargetAccount.email} 管理服务授权`, `Manage services for ${connectTargetAccount.email}`)
            : t('选择要连接的 Google 服务', 'Choose Google services to connect')
        }
        description={t('将在你的系统浏览器中完成本人登录、MFA 与权限同意。', 'You will sign in and grant consent in your system browser.')}
        variant="modal"
      >
        <div className="ca-form-stack">
          <div className="ca-google-choices" role="group" aria-label={t('选择 Google 服务组', 'Choose Google service groups')}>
            {GOOGLE_SERVICE_CHOICES.map(choice => {
              const alreadyGranted = Boolean(
                connectTargetAccount &&
                  (connectTargetAccount.choices ?? []).includes(choice) &&
                  buildReadinessRows(connectTargetAccount.services ?? [], t).some(
                    r => r.choice === choice && r.state === 'ready',
                  ),
              );
              const checked = alreadyGranted || selectedChoices.includes(choice);
              return (
                <button
                  key={choice}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  disabled={alreadyGranted}
                  className={`ca-google-choice${checked ? ' is-selected' : ''}${alreadyGranted ? ' is-locked' : ''}`}
                  onClick={() => toggleServiceChoice(choice, alreadyGranted)}
                >
                  <span className={`ca-google-checkbox${checked ? ' is-checked' : ''}`} aria-hidden="true">
                    {checked && <Check size={12} />}
                  </span>
                  <span className="ca-google-choice-text">
                    <span className="ca-row-title">
                      <span>{googleChoiceLabel(choice, t)}</span>
                      {alreadyGranted && (
                        <span className="ca-pill ca-pill-ok">
                          {t('已包含 · 将保留', 'Included · kept')}
                        </span>
                      )}
                    </span>
                    <span className="ca-row-sub">{googleChoiceDescription(choice, t)}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="ca-google-base-scope">
            <Shield size={14} aria-hidden="true" />
            <span>
              {t('基础附带：账号识别与联系人联查（People API，用于按姓名查找联系人与组织目录），不可单独取消。', 'Always included: account identity and contact name lookup (People API) to resolve names and directory contacts.')}
            </span>
          </div>

          <CaNotice tone="info">
            {t('连接后，本中心现在和以后创建的所有 Bot 都能以你的身份使用你同意的 Google 服务；能向这些 Bot 发起任务的人也可能通过它们访问数据。', 'Once connected, all current and future Bots on this Center can use the approved Google services as you; anyone allowed to message those Bots may access data through them.')}
          </CaNotice>

          {connectError && (
            <p className="ca-error-text" role="alert">
              {connectError}
            </p>
          )}

          <div className="ca-form-actions">
            <button
              type="button"
              className="ca-btn"
              disabled={connectBusy}
              onClick={() => setConnectOpen(false)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="button"
              className="ca-btn ca-btn-primary"
              disabled={connectBusy || selectedChoices.length === 0}
              onClick={() => {
                const unionChoices = connectTargetAccount
                  ? mergeChoices(connectTargetAccount.choices ?? [], selectedChoices)
                  : selectedChoices;
                void startAuthorize(unionChoices, connectTargetAccount?.email);
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>
                {connectBusy
                  ? t('正在发起授权…', 'Starting sign-in…')
                  : connectTargetAccount
                    ? t('前往 Google 补充授权', 'Continue to Google consent')
                    : t('前往 Google 登录', 'Sign in to Google')}
              </span>
            </button>
          </div>
        </div>
      </CaModal>

      {/* Modal D: Remove Account Confirmation (Local Remove vs Revoke at Google) */}
      <CaModal
        open={Boolean(removeTarget)}
        onOpenChange={open => {
          if (!open && !removeBusy) {
            setRemoveTarget(null);
            setRemoveError('');
          }
        }}
        title={t('移除 Google 账号', 'Remove Google Account')}
        description={removeTarget?.email}
        variant="modal"
      >
        {removeTarget && (
          <div className="ca-form-stack">
            <CaNotice tone="warn">
              {t(`移除后，本中心所有 Bot 将不能再使用 ${removeTarget.email}；其他已连接的 Google 账号不受影响。`, `All Bots on this Center will stop having access to ${removeTarget.email}. Other connected Google accounts are unaffected.`)}
            </CaNotice>

            <div className="ca-cred-box">
              <div className="ca-field-label" style={{ marginBottom: 4 }}>
                {affectedRulesForRemoveTarget.length > 0
                  ? t(`引用此账号的 ${affectedRulesForRemoveTarget.length} 条自动规则将停止：`, `${affectedRulesForRemoveTarget.length} trigger rule(s) using this account will stop:`)
                  : t('自动触发规则影响', 'Impact on automatic rules')}
              </div>
              {affectedRulesForRemoveTarget.length === 0 ? (
                <p className="ca-field-help">
                  {t('当前没有引用此账号的自动触发规则。', 'No trigger rules currently reference this account.')}
                </p>
              ) : (
                <ul className="ca-google-impact-list">
                  {affectedRulesForRemoveTarget.map((r, i) => (
                    <li key={r.id || `${r.deviceId}-${r.botId}-${i}`}>
                      <span>{formatBotDisplay(r.deviceId, r.botId)}</span>
                      <span className="ca-muted">
                        {' · '}
                        {r.source === 'gmail' ? t('新邮件', 'New mail') : t('会前提醒', 'Pre-meeting')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ca-google-radio-group" role="radiogroup" aria-label={t('移除方式', 'Removal method')}>
              <label className={`ca-google-radio-card${removeRevoke ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="google-remove-mode"
                  checked={removeRevoke}
                  onChange={() => setRemoveRevoke(true)}
                />
                <span>
                  <span className="ca-field-label">
                    {t('移除并向 Google 撤权（推荐）', 'Remove and revoke access at Google (recommended)')}
                  </span>
                  <span className="ca-row-sub">
                    {t('先请求 Google 撤销令牌，再清除中心本地凭据；若 Google 撤权失败会分开报告结果。', 'Requests token revocation at Google first, then deletes local Center credentials; reports both outcomes separately.')}
                  </span>
                </span>
              </label>

              <label className={`ca-google-radio-card${!removeRevoke ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="google-remove-mode"
                  checked={!removeRevoke}
                  onChange={() => setRemoveRevoke(false)}
                />
                <span>
                  <span className="ca-field-label">
                    {t('仅从中心移除本地凭据', 'Remove from Center only')}
                  </span>
                  <span className="ca-row-sub">
                    {t('仅删除中心加密凭据，不通知 Google 撤权。你可稍后在 Google 账号第三方连接页手动撤权。', 'Deletes only Center credentials without calling Google revoke. You can revoke later in Google Account connections.')}
                  </span>
                </span>
              </label>
            </div>

            {removeError && (
              <p className="ca-error-text" role="alert">
                {removeError}
              </p>
            )}

            <div className="ca-form-actions">
              <button
                type="button"
                className="ca-btn"
                disabled={removeBusy}
                onClick={() => setRemoveTarget(null)}
              >
                {t('取消', 'Cancel')}
              </button>
              <button
                type="button"
                className="ca-btn ca-btn-danger"
                disabled={removeBusy}
                onClick={() => void handleConfirmRemove()}
              >
                {removeBusy
                  ? t('正在移除…', 'Removing…')
                  : removeRevoke
                    ? t('移除并撤权', 'Remove & revoke')
                    : t('仅移除本地凭据', 'Remove locally')}
              </button>
            </div>
          </div>
        )}
      </CaModal>

      {/* Drawer E: Create / Edit Automatic Trigger Rule */}
      <CaModal
        open={ruleDrawerOpen}
        onOpenChange={open => {
          if (!open && !ruleBusy) setRuleDrawerOpen(false);
        }}
        title={
          editingRule
            ? t('编辑自动触发规则', 'Edit Trigger Rule')
            : t('新建自动触发规则', 'New Trigger Rule')
        }
        description={t('为指定 Bot 配置新邮件或会前提醒，由中心持续检查并投递。', 'Configure a new-mail or pre-meeting rule checked by Center and delivered to the selected Bot.')}
        variant="drawer"
      >
        <form className="ca-form-stack" onSubmit={e => void handleSaveRule(e)}>
          <div>
            <CaSegmented<GoogleRuleSource>
              value={ruleSource}
              onChange={setRuleSource}
              ariaLabel={t('触发类型', 'Trigger source')}
              options={[
                { value: 'gmail', label: t('新邮件触发', 'New mail') },
                { value: 'calendar', label: t('会前提醒触发', 'Pre-meeting') },
              ]}
            />
          </div>

          <div className="ca-field">
            <label className="ca-field-label" htmlFor="ca-google-rule-bot">
              {t('目标 Bot', 'Target Bot')}
              <span className="ca-req">*</span>
            </label>
            <select
              id="ca-google-rule-bot"
              className="ca-select"
              value={ruleBotKey}
              onChange={e => setRuleBotKey(e.target.value)}
            >
              <option value="">{t('请选择 Bot…', 'Select a Bot…')}</option>
              {botsByDevice.map(([devId, group]) => (
                <optgroup key={devId} label={group.device?.name || devId}>
                  {group.bots.map(b => (
                    <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <div className="ca-field">
            <label className="ca-field-label" htmlFor="ca-google-rule-account">
              {t('监听的 Google 账号', 'Google account')}
              <span className="ca-req">*</span>
            </label>
            <select
              id="ca-google-rule-account"
              className="ca-select"
              value={ruleAccount}
              onChange={e => setRuleAccount(e.target.value)}
            >
              <option value="">{t('请选择账号…', 'Select an account…')}</option>
              {accounts.map(acc => (
                <option key={acc.id || acc.email} value={acc.email}>
                  {acc.email}
                  {isAccountReconnectRequired(acc) ? t('（需重连）', ' (needs reconnect)') : ''}
                </option>
              ))}
            </select>
          </div>

          {ruleSource === 'gmail' ? (
            <>
              <div className="ca-grid-2">
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor="ca-google-rule-from">
                    {t('发件人过滤（可选）', 'From filter (optional)')}
                  </label>
                  <input
                    id="ca-google-rule-from"
                    type="text"
                    className="ca-input"
                    placeholder="boss@company.com"
                    value={ruleFrom}
                    onChange={e => setRuleFrom(e.target.value)}
                  />
                </div>
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor="ca-google-rule-subject">
                    {t('主题包含（可选）', 'Subject contains (optional)')}
                  </label>
                  <input
                    id="ca-google-rule-subject"
                    type="text"
                    className="ca-input"
                    placeholder={t('例如：周报 / 紧急', 'e.g. Invoice / Urgent')}
                    value={ruleSubject}
                    onChange={e => setRuleSubject(e.target.value)}
                  />
                </div>
              </div>
              <CaNotice tone="info">
                {t('仅对开启后新到达的邮件生效，不回放历史收件箱。', 'Applies only to new emails arriving after enabling; historical inbox messages are not replayed.')}
              </CaNotice>
            </>
          ) : (
            <div className="ca-grid-2">
              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-google-rule-cal">
                  {t('日历', 'Calendar')}
                </label>
                <input
                  id="ca-google-rule-cal"
                  type="text"
                  className="ca-input"
                  placeholder="primary"
                  value={ruleCalendar}
                  onChange={e => setRuleCalendar(e.target.value)}
                />
                <p className="ca-field-help">
                  {t('默认 primary 表示主日历', 'Defaults to primary calendar')}
                </p>
              </div>
              <div className="ca-field">
                <label className="ca-field-label" htmlFor="ca-google-rule-mins">
                  {t('提前分钟数', 'Minutes before')}
                </label>
                <input
                  id="ca-google-rule-mins"
                  type="number"
                  min={1}
                  max={1440}
                  className="ca-input ca-num"
                  value={ruleMinutesBefore}
                  onChange={e => setRuleMinutesBefore(Number(e.target.value))}
                />
                <div className="ca-chips" style={{ marginTop: 4 }}>
                  {MINUTES_BEFORE_PRESETS.map(m => (
                    <button
                      key={m}
                      type="button"
                      className={`ca-chip${ruleMinutesBefore === m ? ' is-active' : ''}`}
                      onClick={() => setRuleMinutesBefore(m)}
                    >
                      <CalendarClock size={11} aria-hidden="true" style={{ marginRight: 3 }} />
                      {t(`${m} 分钟`, `${m}m`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="ca-field">
            <label className="ca-field-label" htmlFor="ca-google-rule-instruction">
              {t('触发后交给 Bot 的指令', 'Instruction for Bot')}
              <span className="ca-req">*</span>
            </label>
            <textarea
              id="ca-google-rule-instruction"
              rows={3}
              className="ca-textarea"
              placeholder={
                ruleSource === 'gmail'
                  ? t('例如：总结邮件要点与待办事项并提醒我', 'e.g. Summarize key points and action items for me')
                  : t('例如：整理参会人与相关邮件摘要，会前提醒我', 'e.g. Prepare attendee summary and relevant mail context')
              }
              value={ruleInstruction}
              onChange={e => setRuleInstruction(e.target.value)}
            />
          </div>

          <div className="ca-inline-between">
            <span className="ca-field-label">{t('保存后立即启用', 'Enable rule immediately')}</span>
            <CaSwitch
              checked={ruleEnabled}
              label={t('启用规则', 'Enable rule')}
              onChange={setRuleEnabled}
            />
          </div>

          {ruleFormError && (
            <p className="ca-error-text" role="alert">
              {ruleFormError}
            </p>
          )}

          <div className="ca-form-actions">
            <button
              type="button"
              className="ca-btn"
              disabled={ruleBusy}
              onClick={() => setRuleDrawerOpen(false)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button type="submit" className="ca-btn ca-btn-primary" disabled={ruleBusy}>
              {ruleBusy ? t('保存中…', 'Saving…') : t('保存规则', 'Save rule')}
            </button>
          </div>
        </form>
      </CaModal>
    </div>
  );
}
