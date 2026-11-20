// Shared Bot Capabilities Google Workspace section + operable Bot Rules (Triggers) editor.
// Mounted in both mobile CapabilitiesPage.tsx and desktop BotCapabilities.tsx.
// Strictly follows 04 product decisions & real Center /api/google/* contracts:
// - All Bots automatically share Center's Google connection (NO per-Bot Google toggle or assignment).
// - 1 connected account is used directly; >1 asks per request in chat.
// - Per-service readiness keeps People (Contacts) independent from Gmail.
// - Rules target this (deviceId, botId) only; pausing a rule never affects manual use or other rules.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bell,
  Calendar,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  Mail,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { useText } from '../ui';
import {
  checkGoogleAccount,
  classifyGoogleError,
  fetchGoogleStatus,
  listGoogleRules,
  removeGoogleRule,
  saveGoogleRule,
} from './googleClient';
import {
  googleAdminTrustRequestText,
  googleFixLabel,
  googleReadinessFace,
  googleReadinessRows,
  maskClientId,
} from './googleCopy';
import { GoogleClientConfigForm, GoogleSignInFlow } from './GoogleSignInFlow';
import { GoogleSetupWizard } from './GoogleSetupWizard';
import type {
  GoogleAccountView,
  GoogleRuleDto,
  GoogleRuleSource,
  GoogleServiceChoice,
  GoogleSetupControlCall,
  GoogleStatusSnapshot,
} from './types';
import './google-ui.css';

export interface GoogleCapabilitySectionProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  deviceId: string;
  botId: string;
  botName?: string;
  variant?: 'mobile' | 'desktop';
  hostPlatform?: string;
  isLocalAndroid?: boolean;
  callGoogleSetup?: GoogleSetupControlCall;
  onOpenBrowser?: () => void;
  onOpenCenterAdmin?: () => void;
}

type ActivePanel =
  | null
  | { kind: 'configure' }
  | { kind: 'wizard' }
  | {
      kind: 'signin';
      mode: 'connect' | 'expand' | 'reconnect';
      targetAccount?: string;
      existingChoices?: GoogleServiceChoice[];
      initialChoices?: GoogleServiceChoice[];
    };

function formatRuleFrom(from: string | string[] | undefined): string {
  if (!from) return '';
  return Array.isArray(from) ? from.join(', ') : from;
}

function ruleStatusDisplay(
  rule: GoogleRuleDto,
  account: GoogleAccountView | undefined,
  t: (zh: string, en: string) => string,
): { label: string; tone: 'ok' | 'warn' | 'muted' | 'danger' } {
  const rt = rule.runtime;
  const rtStatus = rt?.status ?? rule.status;
  if (!rule.enabled || rtStatus === 'paused_disabled') {
    return { label: t('已暂停（规则已关闭）', 'Paused (disabled)'), tone: 'muted' };
  }
  if (
    account?.status === 'reconnect' ||
    rtStatus === 'paused_account_reconnect' ||
    rtStatus === 'paused_reconnect'
  ) {
    return { label: t('已暂停（账号需重连）', 'Paused (reconnect required)'), tone: 'warn' };
  }
  if (rtStatus === 'paused_account_missing') {
    return { label: t('已暂停（账号已移除）', 'Paused (account removed)'), tone: 'warn' };
  }
  if (rtStatus === 'paused_service_unavailable') {
    return { label: t('已暂停（服务未就绪）', 'Paused (service unavailable)'), tone: 'warn' };
  }
  if (rtStatus === 'paused_bot_unavailable') {
    return { label: t('已暂停（Bot 不可用）', 'Paused (Bot unavailable)'), tone: 'muted' };
  }
  if (rt?.rateLimited || rtStatus === 'backoff' || rt?.backoffUntil || rule.backoffUntil) {
    return { label: t('限流退避中', 'Rate-limited backoff'), tone: 'warn' };
  }
  if (rtStatus === 'error' || rule.lastError) {
    return { label: t('检查出错', 'Check error'), tone: 'danger' };
  }
  if (rtStatus === 'paused') {
    const reason = rt?.detail ?? rule.pausedReason;
    return {
      label: reason ? t(`已暂停（${reason}）`, `Paused (${reason})`) : t('已暂停', 'Paused'),
      tone: 'muted',
    };
  }
  return { label: t('运行中', 'Active'), tone: 'ok' };
}

function formatRuleTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function GoogleCapabilitySection({
  api,
  identity,
  deviceId,
  botId,
  botName,
  variant = 'mobile',
  hostPlatform,
  isLocalAndroid = false,
  callGoogleSetup,
  onOpenBrowser,
  onOpenCenterAdmin,
}: GoogleCapabilitySectionProps) {
  const t = useText();
  const fieldId = useId();
  const mountedRef = useRef(true);

  const [snapshot, setSnapshot] = useState<GoogleStatusSnapshot | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [tempError, setTempError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [checkingAccount, setCheckingAccount] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  // Rules state
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState<GoogleRuleDto[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState('');
  const [rulesBusyId, setRulesBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // New / edit rule draft
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | undefined>(undefined);
  const [ruleSource, setRuleSource] = useState<GoogleRuleSource>('gmail');
  const [ruleAccount, setRuleAccount] = useState('');
  const [ruleFrom, setRuleFrom] = useState('');
  const [ruleSubject, setRuleSubject] = useState('');
  const [ruleCalendar, setRuleCalendar] = useState('primary');
  const [ruleMinutesBefore, setRuleMinutesBefore] = useState(15);
  const [ruleInstruction, setRuleInstruction] = useState('');
  const [ruleSaving, setRuleSaving] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError('');
    setTempError(false);
    try {
      const next = await fetchGoogleStatus(api, identity);
      if (!mountedRef.current) return;
      setSnapshot(next);
      setUnavailable(false);
    } catch (cause) {
      if (!mountedRef.current) return;
      const info = classifyGoogleError(cause);
      if (info.unavailable) {
        setUnavailable(true);
        setStatusError(t('当前 Center 尚未开启 Google Workspace 共享服务接口。', 'Shared Google Workspace endpoints are not available on this Center.'));
      } else if (info.tempError || info.offline) {
        // Keep last known snapshot intact — never downgrade connected accounts on transient errors!
        setTempError(true);
        setStatusError(
          info.offline
            ? t('当前与 Center 断开连接，暂时无法刷新最新状态。', 'Disconnected from Center. Status could not be refreshed.')
            : t('Center 暂时不可达，已保留先前状态，不会清除已授权令牌。', 'Center is temporarily unreachable. Existing tokens are kept.'),
        );
      } else {
        setStatusError(info.message);
      }
    } finally {
      if (mountedRef.current) setLoadingStatus(false);
    }
  }, [api, identity, t]);

  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    setRulesError('');
    try {
      const items = await listGoogleRules(api, identity, deviceId, botId);
      if (!mountedRef.current) return;
      setRules(items);
      setRulesLoaded(true);
    } catch (cause) {
      if (!mountedRef.current) return;
      const info = classifyGoogleError(cause);
      setRulesError(
        info.unavailable
          ? t('当前 Center 暂未启用 Google 自动触发规则接口。', 'Google trigger rules API is unavailable on this Center.')
          : info.message,
      );
    } finally {
      if (mountedRef.current) setRulesLoading(false);
    }
  }, [api, identity, deviceId, botId, t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (rulesOpen && !rulesLoaded && !rulesLoading) {
      void loadRules();
    }
  }, [rulesOpen, rulesLoaded, rulesLoading, loadRules]);

  const accounts = useMemo(() => snapshot?.accounts ?? [], [snapshot]);
  const connectedAccounts = useMemo(
    () => accounts.filter(acc => acc.status === 'connected'),
    [accounts],
  );
  const client = snapshot?.client;

  // Auto-select sole account when creating a rule; never auto-pick when multiple exist.
  useEffect(() => {
    if (!ruleFormOpen || editingRuleId) return;
    if (connectedAccounts.length === 1) {
      setRuleAccount(connectedAccounts[0].email);
    } else if (ruleAccount && !accounts.some(a => a.email === ruleAccount)) {
      setRuleAccount('');
    }
  }, [ruleFormOpen, editingRuleId, connectedAccounts, accounts, ruleAccount]);

  const handleCheckAccount = async (email: string) => {
    setCheckingAccount(email);
    setNotice('');
    setStatusError('');
    try {
      await checkGoogleAccount(api, identity, email);
      await loadStatus();
      if (mountedRef.current) {
        setNotice(t(`已重新检查 ${email} 的各服务就绪状态。`, `Re-checked service readiness for ${email}.`));
      }
    } catch (cause) {
      if (!mountedRef.current) return;
      const info = classifyGoogleError(cause);
      setTempError(info.tempError || info.offline);
      setStatusError(info.message);
    } finally {
      if (mountedRef.current) setCheckingAccount(null);
    }
  };

  const handleCopyAdminGuide = async () => {
    const text = googleAdminTrustRequestText(client?.clientId, t);
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t('已复制管理员配置/信任指引，可发给 Google Workspace 或 Center 管理员。', 'Copied administrator instructions to clipboard.'));
    } catch {
      setStatusError(t('无法复制到剪贴板。', 'Could not copy to clipboard.'));
    }
  };

  const openNewRuleForm = (source: GoogleRuleSource) => {
    setEditingRuleId(undefined);
    setRuleSource(source);
    setRuleAccount(connectedAccounts.length === 1 ? connectedAccounts[0].email : '');
    setRuleFrom('');
    setRuleSubject('');
    setRuleCalendar('primary');
    setRuleMinutesBefore(15);
    setRuleInstruction(
      source === 'gmail'
        ? t('总结新邮件要点并提醒我', 'Summarize the new email and notify me')
        : t('整理即将开始的会议参会人与相关邮件摘要', 'Prepare attendee context and related emails before the meeting'),
    );
    setRulesError('');
    setRuleFormOpen(true);
  };

  const openEditRuleForm = (rule: GoogleRuleDto) => {
    setEditingRuleId(rule.id);
    setRuleSource(rule.source);
    setRuleAccount(rule.account);
    setRuleFrom(formatRuleFrom(rule.from));
    setRuleSubject(rule.subjectContains ?? '');
    setRuleCalendar(rule.calendar ?? 'primary');
    setRuleMinutesBefore(rule.minutesBefore ?? 15);
    setRuleInstruction(rule.instruction);
    setRulesError('');
    setRuleFormOpen(true);
  };

  const handleSaveRule = async (event: FormEvent) => {
    event.preventDefault();
    if (ruleSaving) return;
    if (!ruleAccount) {
      setRulesError(t('请选择这条规则使用的 Google 账号。', 'Select a Google account for this rule.'));
      return;
    }
    const instruction = ruleInstruction.trim();
    if (!instruction) {
      setRulesError(t('请填写触发后希望本 Bot 执行的指令。', 'Enter the instruction for this Bot when triggered.'));
      return;
    }
    setRuleSaving(true);
    setRulesError('');
    try {
      const payload: GoogleRuleDto = {
        ...(editingRuleId ? { id: editingRuleId } : {}),
        deviceId,
        botId,
        account: ruleAccount,
        source: ruleSource,
        enabled: true,
        instruction,
        ...(ruleSource === 'gmail'
          ? {
              ...(ruleFrom.trim() ? { from: ruleFrom.trim() } : {}),
              ...(ruleSubject.trim() ? { subjectContains: ruleSubject.trim() } : {}),
            }
          : {
              calendar: ruleCalendar.trim() || 'primary',
              minutesBefore: Math.max(0, Math.min(1440, Math.round(Number(ruleMinutesBefore) || 15))),
            }),
      };
      await saveGoogleRule(api, identity, payload);
      if (!mountedRef.current) return;
      setRuleFormOpen(false);
      setEditingRuleId(undefined);
      setNotice(
        ruleSource === 'gmail'
          ? t('规则已保存，仅对开启后新到达的邮件生效。', 'Rule saved. Applies only to new emails arriving from now on.')
          : t('会前提醒规则已保存。', 'Pre-meeting rule saved.'),
      );
      await loadRules();
    } catch (cause) {
      if (!mountedRef.current) return;
      setRulesError(classifyGoogleError(cause).message);
    } finally {
      if (mountedRef.current) setRuleSaving(false);
    }
  };

  const handleToggleRule = async (rule: GoogleRuleDto) => {
    const key = rule.id ?? `${rule.source}:${rule.account}`;
    setRulesBusyId(key);
    setRulesError('');
    try {
      // Pass only whitelisted save fields (buildGoogleRuleSaveBody strips runtime/createdAt/etc.).
      await saveGoogleRule(api, identity, {
        id: rule.id,
        name: rule.name,
        deviceId: rule.deviceId,
        botId: rule.botId,
        account: rule.account,
        source: rule.source,
        enabled: !rule.enabled,
        from: rule.from,
        to: rule.to,
        subjectContains: rule.subjectContains,
        label: rule.label,
        calendar: rule.calendar,
        minutesBefore: rule.minutesBefore,
        instruction: rule.instruction,
      });
      if (!mountedRef.current) return;
      await loadRules();
    } catch (cause) {
      if (!mountedRef.current) return;
      setRulesError(classifyGoogleError(cause).message);
    } finally {
      if (mountedRef.current) setRulesBusyId(null);
    }
  };

  const handleDeleteRule = async (rule: GoogleRuleDto) => {
    if (!rule.id) return;
    setRulesBusyId(rule.id);
    setRulesError('');
    try {
      await removeGoogleRule(api, identity, { id: rule.id });
      if (!mountedRef.current) return;
      setConfirmDeleteId(null);
      await loadRules();
    } catch (cause) {
      if (!mountedRef.current) return;
      setRulesError(classifyGoogleError(cause).message);
    } finally {
      if (mountedRef.current) setRulesBusyId(null);
    }
  };

  const clientBadge = !snapshot
    ? { label: loadingStatus ? t('读取中…', 'Loading…') : t('状态未知', 'Unknown'), tone: 'muted' as const }
    : client?.invalid
      ? { label: t('应用凭据无效', 'Invalid app credentials'), tone: 'danger' as const }
      : client?.configured
        ? {
            label: client.clientId
              ? t(`已配置 (Web Client · ${maskClientId(client.clientId)})`, `Configured (Web · ${maskClientId(client.clientId)})`)
              : t('已配置 Web Client', 'Web Client configured'),
            tone: 'ok' as const,
          }
        : { label: t('未配置中心应用', 'Center app not configured'), tone: 'muted' as const };

  return (
    <section
      className={`gws-cap-card is-${variant}`}
      aria-label={t('Google Workspace（中心共享）', 'Google Workspace (Center shared)')}
    >
      <div className="gws-card-head">
        <div className="gws-card-title-group">
          <span className="gws-card-title">Google Workspace</span>
          <span className="gws-pill is-accent">
            {t('由中心提供 · 所有 Bot 可用', 'Provided by Center · All Bots')}
          </span>
        </div>
        <button
          type="button"
          className="gws-btn is-ghost is-xs"
          disabled={loadingStatus}
          onClick={() => void loadStatus()}
          aria-label={t('刷新 Google 状态', 'Refresh Google status')}
        >
          <RefreshCw size={13} className={loadingStatus ? 'gws-spin' : undefined} aria-hidden="true" />
          <span>{t('刷新', 'Refresh')}</span>
        </button>
      </div>

      <p className="gws-muted">
        {t('Gmail、日历、云盘/文档/表格与联系人工具默认对所有现有及新建 Bot 开放，无需逐 Bot 开关。', 'Gmail, Calendar, Drive/Docs/Sheets, and Contacts are shared across all Bots automatically — no per-Bot toggle needed.')}
      </p>

      {/* Dimension A: Center OAuth App status */}
      <div className="gws-status-row">
        <span className="gws-status-label">{t('中心 OAuth 应用', 'Center OAuth app')}</span>
        <span className={`gws-pill is-${clientBadge.tone}`}>{clientBadge.label}</span>
      </div>

      {statusError ? (
        <div className={tempError ? 'gws-warning' : 'gws-error'} role="alert">
          {tempError ? <AlertTriangle size={15} aria-hidden="true" /> : <ShieldAlert size={15} aria-hidden="true" />}
          <div className="gws-error-body">
            <span>{statusError}</span>
            {tempError ? (
              <button type="button" className="gws-link-btn" onClick={() => void loadStatus()}>
                {t('重试检查', 'Retry check')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {notice ? <p className="gws-notice" role="status">{notice}</p> : null}

      {/* Unconfigured Center App actions */}
      {!unavailable && snapshot && !client?.configured ? (
        <div className="gws-empty-box">
          <p className="gws-muted">
            {t('配置一次 Center Web OAuth 应用后，所有主机上的 Bot 都可复用，无需在每台设备重复导入密钥文件。若你不是管理员，请联系 Center 管理员配置。', 'Configure Center’s Web OAuth app once and every Host & Bot shares it. If you are not an admin, contact your Center administrator.')}
          </p>
          <div className="gws-actions">
            <button
              type="button"
              className="gws-btn is-primary is-sm"
              onClick={() => setActivePanel(prev => (prev?.kind === 'wizard' ? null : { kind: 'wizard' }))}
            >
              {t('引导我创建 Google 应用', 'Guide me to create Google app')}
            </button>
            <button
              type="button"
              className="gws-btn is-ghost is-sm"
              onClick={() => setActivePanel(prev => (prev?.kind === 'configure' ? null : { kind: 'configure' }))}
            >
              <Lock size={13} aria-hidden="true" />
              <span>{t('我已有凭据，直接录入', 'Enter existing credentials')}</span>
            </button>
            <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void handleCopyAdminGuide()}>
              <Copy size={13} aria-hidden="true" />
              <span>{t('复制管理员指引', 'Copy admin note')}</span>
            </button>
          </div>
        </div>
      ) : null}

      {/* Dimension B & C: Shared accounts & per-service readiness */}
      {!unavailable && snapshot && client?.configured ? (
        accounts.length === 0 ? (
          <div className="gws-empty-box">
            <p className="gws-muted">
              {t('Center 应用已就绪，尚未连接 Google 账号。在系统浏览器登录授权后，所有 Bot 即可使用已批准的服务。', 'Center app is ready, but no Google account is connected yet. Sign in via system browser to enable approved services for all Bots.')}
            </p>
            <div className="gws-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                onClick={() => setActivePanel({ kind: 'signin', mode: 'connect' })}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>{t('连接 Google 账号', 'Connect Google account')}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="gws-accounts">
            <div className="gws-row-between">
              <span className="gws-label-xs">
                {accounts.length === 1
                  ? t('共享账号（单账号 · 对话中默认使用）', 'Shared account (single · used by default)')
                  : t(`共享账号（共 ${accounts.length} 个 · 对话未指明时会询问本次使用哪个）`, `Shared accounts (${accounts.length} · chat asks when unspecified)`)}
              </span>
              <button
                type="button"
                className="gws-link-btn"
                onClick={() => setActivePanel({ kind: 'signin', mode: 'connect' })}
              >
                <Plus size={13} aria-hidden="true" />
                <span>{t('连接其他账号', 'Add account')}</span>
              </button>
            </div>

            {accounts.map(account => {
              const rows = googleReadinessRows(account, t);
              const needsReconnect = account.status === 'reconnect';
              const busyCheck = checkingAccount === account.email;

              return (
                <div key={account.id || account.email} className="gws-account-card">
                  <div className="gws-account-head">
                    <div className="gws-account-id">
                      <strong className="gws-account-email">{account.email}</strong>
                      <span className={`gws-pill ${needsReconnect ? 'is-warn' : tempError ? 'is-warn' : 'is-ok'}`}>
                        {needsReconnect
                          ? t('需重连', 'Reconnect required')
                          : tempError
                            ? t('暂时不可达', 'Temporarily unreachable')
                            : t('已连接', 'Connected')}
                      </span>
                    </div>
                    <div className="gws-account-actions">
                      {needsReconnect ? (
                        <button
                          type="button"
                          className="gws-btn is-warn is-xs"
                          onClick={() =>
                            setActivePanel({
                              kind: 'signin',
                              mode: 'reconnect',
                              targetAccount: account.email,
                              existingChoices: account.choices,
                              initialChoices: account.choices,
                            })
                          }
                        >
                          {t('重新连接', 'Reconnect')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="gws-btn is-ghost is-xs"
                          onClick={() =>
                            setActivePanel({
                              kind: 'signin',
                              mode: 'expand',
                              targetAccount: account.email,
                              existingChoices: account.choices,
                              initialChoices: account.choices,
                            })
                          }
                        >
                          {t('添加 / 管理服务', 'Manage services')}
                        </button>
                      )}
                      <button
                        type="button"
                        className="gws-btn is-ghost is-xs"
                        disabled={busyCheck}
                        onClick={() => void handleCheckAccount(account.email)}
                      >
                        {busyCheck ? t('检查中…', 'Checking…') : t('重新检查', 'Check')}
                      </button>
                    </div>
                  </div>

                  {rows.length > 0 ? (
                    <div className="gws-readiness-list">
                      {rows.map(row => {
                        const face = googleReadinessFace(row.readiness, t);
                        return (
                          <div key={row.key} className="gws-readiness-row">
                            <span className="gws-readiness-name">{row.label}</span>
                            <span className={`gws-pill is-${face.tone}`}>{face.label}</span>
                            {face.fix === 'allow-again' ? (
                              <button
                                type="button"
                                className="gws-btn is-ghost is-xs"
                                onClick={() =>
                                  setActivePanel({
                                    kind: 'signin',
                                    mode: 'expand',
                                    targetAccount: account.email,
                                    existingChoices: account.choices,
                                    initialChoices: row.choice ? [...account.choices, row.choice] : account.choices,
                                  })
                                }
                              >
                                {googleFixLabel('allow-again', t)}
                              </button>
                            ) : face.fix === 'turn-on' ? (
                              <button
                                type="button"
                                className="gws-btn is-ghost is-xs"
                                onClick={() => {
                                  const url = row.readiness.enableUrl || 'https://console.cloud.google.com/apis/library';
                                  void openExternalUrl(url);
                                }}
                              >
                                <ExternalLink size={11} aria-hidden="true" />
                                <span>{googleFixLabel('turn-on', t)}</span>
                              </button>
                            ) : face.fix === 'copy-for-admin' ? (
                              <button
                                type="button"
                                className="gws-btn is-ghost is-xs"
                                onClick={() => void handleCopyAdminGuide()}
                              >
                                <Copy size={11} aria-hidden="true" />
                                <span>{googleFixLabel('copy-for-admin', t)}</span>
                              </button>
                            ) : face.fix === 'check-again' ? (
                              <button
                                type="button"
                                className="gws-btn is-ghost is-xs"
                                disabled={busyCheck}
                                onClick={() => void handleCheckAccount(account.email)}
                              >
                                {googleFixLabel('check-again', t)}
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )
      ) : null}

      {/* Inline private panels: configure / 3-mode wizard / system browser OAuth */}
      {activePanel?.kind === 'configure' ? (
        <GoogleClientConfigForm
          api={api}
          identity={identity}
          redirectUri={client?.redirectUri}
          configuredClientId={client?.clientId}
          onOpenCenterAdmin={onOpenCenterAdmin}
          onCancel={() => setActivePanel(null)}
          onSaved={nextSnap => {
            setSnapshot(nextSnap);
            setActivePanel({ kind: 'signin', mode: 'connect' });
          }}
        />
      ) : null}

      {activePanel?.kind === 'wizard' ? (
        <GoogleSetupWizard
          api={api}
          identity={identity}
          botId={botId}
          botName={botName}
          isLocalAndroid={isLocalAndroid || hostPlatform?.toLowerCase() === 'android'}
          autoStart
          callGoogleSetup={callGoogleSetup}
          onOpenBrowser={onOpenBrowser}
          onOpenCenterAdmin={onOpenCenterAdmin}
          onStatusUpdated={nextSnap => setSnapshot(nextSnap)}
          onClose={() => setActivePanel(null)}
        />
      ) : null}

      {activePanel?.kind === 'signin' ? (
        <GoogleSignInFlow
          api={api}
          identity={identity}
          mode={activePanel.mode}
          targetAccount={activePanel.targetAccount}
          existingChoices={activePanel.existingChoices}
          initialChoices={activePanel.initialChoices}
          onCancel={() => setActivePanel(null)}
          onCompleted={(_acc, nextSnap) => {
            if (nextSnap) setSnapshot(nextSnap);
            else void loadStatus();
          }}
        />
      ) : null}

      {/* Bot-scoped Google Triggers (Rules) section */}
      {!unavailable ? (
        <div className="gws-rules-section">
          <button
            type="button"
            className="gws-collapse-trigger"
            aria-expanded={rulesOpen}
            onClick={() => setRulesOpen(v => !v)}
          >
            <span className="gws-collapse-title">
              <Bell size={14} aria-hidden="true" />
              <span>{t('本 Bot 自动触发规则（新邮件 / 会前提醒）', 'Auto-trigger rules for this Bot (Mail / Meetings)')}</span>
              {rulesLoaded ? <span className="gws-pill is-muted">{rules.length}</span> : null}
            </span>
            <ChevronDown size={15} className={`gws-chevron${rulesOpen ? ' is-open' : ''}`} aria-hidden="true" />
          </button>

          {rulesOpen ? (
            <div className="gws-rules-body">
              <p className="gws-muted">
                {t('规则仅决定新邮件或会议开始前自动通知本 Bot，不是为本 Bot 开通 Google 授权。暂停单条规则不影响手动查询或其他规则。', 'Rules trigger this Bot on new mail or upcoming meetings (not per-Bot Google authorization). Pausing a rule never affects manual queries.')}
              </p>

              {rulesError ? (
                <div className="gws-error" role="alert">
                  <ShieldAlert size={14} aria-hidden="true" />
                  <span>{rulesError}</span>
                </div>
              ) : null}

              {rulesLoading ? (
                <p className="gws-muted" role="status">{t('正在读取规则…', 'Loading rules…')}</p>
              ) : null}

              {!rulesLoading && rules.length > 0 ? (
                <div className="gws-rule-list">
                  {rules.map(rule => {
                    const key = rule.id ?? `${rule.source}:${rule.account}:${rule.instruction}`;
                    const acc = accounts.find(a => a.email.toLowerCase() === rule.account.toLowerCase());
                    const status = ruleStatusDisplay(rule, acc, t);
                    const busy = rulesBusyId === key;
                    const confirmingDelete = confirmDeleteId === rule.id;
                    const fromDisplay = formatRuleFrom(rule.from);
                    const lastChecked = rule.runtime?.lastCheckedAt ?? rule.lastCheckedAt;
                    const pendingCount = rule.runtime?.pendingCount ?? 0;

                    return (
                      <div key={key} className="gws-rule-item">
                        <div className="gws-rule-head">
                          <span className="gws-rule-kind">
                            {rule.source === 'gmail' ? <Mail size={13} aria-hidden="true" /> : <Calendar size={13} aria-hidden="true" />}
                            <span>
                              {rule.source === 'gmail'
                                ? t('新邮件触发', 'New email')
                                : t(`会前 ${rule.minutesBefore ?? 15} 分钟`, `${rule.minutesBefore ?? 15}m before event`)}
                            </span>
                          </span>
                          <span className={`gws-pill is-${status.tone}`}>{status.label}</span>
                        </div>
                        <div className="gws-rule-meta">
                          <span>{rule.account}</span>
                          {rule.source === 'gmail' && fromDisplay ? <span>· {t(`发件人: ${fromDisplay}`, `From: ${fromDisplay}`)}</span> : null}
                          {rule.source === 'gmail' && rule.subjectContains ? <span>· {t(`主题含: ${rule.subjectContains}`, `Subject: ${rule.subjectContains}`)}</span> : null}
                          {rule.source === 'calendar' && rule.calendar ? <span>· {t(`日历: ${rule.calendar}`, `Calendar: ${rule.calendar}`)}</span> : null}
                          {lastChecked ? <span>· {t(`上次检查 ${formatRuleTime(lastChecked)}`, `Checked ${formatRuleTime(lastChecked)}`)}</span> : null}
                          {pendingCount > 0 ? <span>· {t(`待投递 ${pendingCount}`, `${pendingCount} pending`)}</span> : null}
                        </div>
                        <p className="gws-rule-instruction">{rule.instruction}</p>
                        <div className="gws-rule-actions">
                          <button
                            type="button"
                            className="gws-btn is-ghost is-xs"
                            disabled={busy}
                            onClick={() => void handleToggleRule(rule)}
                          >
                            {rule.enabled ? t('暂停规则', 'Pause') : t('启用规则', 'Enable')}
                          </button>
                          <button
                            type="button"
                            className="gws-btn is-ghost is-xs"
                            disabled={busy}
                            onClick={() => openEditRuleForm(rule)}
                          >
                            {t('编辑', 'Edit')}
                          </button>
                          {rule.id ? (
                            confirmingDelete ? (
                              <>
                                <button
                                  type="button"
                                  className="gws-btn is-danger is-xs"
                                  disabled={busy}
                                  onClick={() => void handleDeleteRule(rule)}
                                >
                                  {t('确认删除', 'Confirm delete')}
                                </button>
                                <button
                                  type="button"
                                  className="gws-btn is-ghost is-xs"
                                  disabled={busy}
                                  onClick={() => setConfirmDeleteId(null)}
                                >
                                  {t('取消', 'Cancel')}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="gws-btn is-ghost is-xs"
                                disabled={busy}
                                onClick={() => setConfirmDeleteId(rule.id!)}
                              >
                                <Trash2 size={12} aria-hidden="true" />
                                <span>{t('删除', 'Delete')}</span>
                              </button>
                            )
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : !rulesLoading && !ruleFormOpen ? (
                <p className="gws-muted">{t('本 Bot 尚未配置 Google 自动触发规则。', 'No Google trigger rules configured for this Bot.')}</p>
              ) : null}

              {!ruleFormOpen ? (
                <div className="gws-actions">
                  <button
                    type="button"
                    className="gws-btn is-ghost is-sm"
                    disabled={accounts.length === 0}
                    onClick={() => openNewRuleForm('gmail')}
                  >
                    <Mail size={13} aria-hidden="true" />
                    <span>{t('新建邮件触发', 'Add email rule')}</span>
                  </button>
                  <button
                    type="button"
                    className="gws-btn is-ghost is-sm"
                    disabled={accounts.length === 0}
                    onClick={() => openNewRuleForm('calendar')}
                  >
                    <Calendar size={13} aria-hidden="true" />
                    <span>{t('新建会前提醒', 'Add meeting rule')}</span>
                  </button>
                </div>
              ) : (
                <form className="gws-rule-form" onSubmit={e => void handleSaveRule(e)}>
                  <div className="gws-row-between">
                    <strong>
                      {editingRuleId
                        ? t('编辑触发规则', 'Edit trigger rule')
                        : ruleSource === 'gmail'
                          ? t('新建新邮件触发', 'New email trigger')
                          : t('新建会前提醒触发', 'New pre-meeting trigger')}
                    </strong>
                    {!editingRuleId ? (
                      <div className="gws-seg">
                        <button
                          type="button"
                          className={`gws-seg-btn${ruleSource === 'gmail' ? ' is-active' : ''}`}
                          onClick={() => setRuleSource('gmail')}
                        >
                          Gmail
                        </button>
                        <button
                          type="button"
                          className={`gws-seg-btn${ruleSource === 'calendar' ? ' is-active' : ''}`}
                          onClick={() => setRuleSource('calendar')}
                        >
                          Calendar
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <label className="gws-field" htmlFor={`${fieldId}-rule-account`}>
                    <span className="gws-label">{t('中心 Google 账号', 'Center Google account')}</span>
                    <select
                      id={`${fieldId}-rule-account`}
                      className="gws-input"
                      value={ruleAccount}
                      disabled={ruleSaving}
                      onChange={e => setRuleAccount(e.target.value)}
                    >
                      <option value="">{t('请选择账号…', 'Select an account…')}</option>
                      {accounts.map(acc => (
                        <option key={acc.email} value={acc.email}>
                          {acc.email}
                          {acc.status === 'reconnect' ? ` (${t('需重连', 'reconnect required')})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>

                  {ruleSource === 'gmail' ? (
                    <>
                      <label className="gws-field" htmlFor={`${fieldId}-rule-from`}>
                        <span className="gws-label">{t('发件人过滤（可选）', 'From filter (optional)')}</span>
                        <input
                          id={`${fieldId}-rule-from`}
                          type="text"
                          className="gws-input"
                          value={ruleFrom}
                          disabled={ruleSaving}
                          placeholder="alerts@example.com"
                          onChange={e => setRuleFrom(e.target.value)}
                        />
                      </label>
                      <label className="gws-field" htmlFor={`${fieldId}-rule-subject`}>
                        <span className="gws-label">{t('主题关键词（可选）', 'Subject contains (optional)')}</span>
                        <input
                          id={`${fieldId}-rule-subject`}
                          type="text"
                          className="gws-input"
                          value={ruleSubject}
                          disabled={ruleSaving}
                          placeholder={t('例如：账单 / 审批', 'e.g. invoice / approval')}
                          onChange={e => setRuleSubject(e.target.value)}
                        />
                      </label>
                      <p className="gws-muted">
                        {t('仅对开启后新到达的邮件生效，不回放历史收件箱。', 'Applies only to new mail arriving after activation; past inbox history is not replayed.')}
                      </p>
                    </>
                  ) : (
                    <>
                      <label className="gws-field" htmlFor={`${fieldId}-rule-cal`}>
                        <span className="gws-label">{t('日历（默认 primary）', 'Calendar (default primary)')}</span>
                        <input
                          id={`${fieldId}-rule-cal`}
                          type="text"
                          className="gws-input"
                          value={ruleCalendar}
                          disabled={ruleSaving}
                          placeholder="primary"
                          onChange={e => setRuleCalendar(e.target.value)}
                        />
                      </label>
                      <label className="gws-field" htmlFor={`${fieldId}-rule-mins`}>
                        <span className="gws-label">{t('提前提醒分钟数', 'Minutes before event')}</span>
                        <input
                          id={`${fieldId}-rule-mins`}
                          type="number"
                          min={0}
                          max={1440}
                          className="gws-input"
                          value={ruleMinutesBefore}
                          disabled={ruleSaving}
                          onChange={e => setRuleMinutesBefore(Number(e.target.value) || 15)}
                        />
                      </label>
                    </>
                  )}

                  <label className="gws-field" htmlFor={`${fieldId}-rule-inst`}>
                    <span className="gws-label">{t('触发后执行指令', 'Instruction for this Bot')}</span>
                    <textarea
                      id={`${fieldId}-rule-inst`}
                      className="gws-input gws-textarea"
                      rows={2}
                      value={ruleInstruction}
                      disabled={ruleSaving}
                      onChange={e => setRuleInstruction(e.target.value)}
                    />
                  </label>

                  <div className="gws-actions">
                    <button type="submit" className="gws-btn is-primary is-sm" disabled={ruleSaving}>
                      {ruleSaving ? t('保存中…', 'Saving…') : t('保存规则', 'Save rule')}
                    </button>
                    <button
                      type="button"
                      className="gws-btn is-ghost is-sm"
                      disabled={ruleSaving}
                      onClick={() => { setRuleFormOpen(false); setEditingRuleId(undefined); }}
                    >
                      {t('取消', 'Cancel')}
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Browser isolation note + quick actions */}
      <div className="gws-footer-bar">
        <span className="gws-isolation-note">
          {t('Bot 浏览器网页登录 ≠ Google API 授权，两者严格隔离。', 'Bot browser web login is separate from Google API access.')}
        </span>
        <div className="gws-actions">
          {onOpenBrowser ? (
            <button type="button" className="gws-btn is-ghost is-xs" onClick={onOpenBrowser}>
              <Globe size={13} aria-hidden="true" />
              <span>{t('打开 Bot 浏览器', 'Open Bot Browser')}</span>
            </button>
          ) : null}
          {onOpenCenterAdmin ? (
            <button type="button" className="gws-btn is-ghost is-xs" onClick={onOpenCenterAdmin}>
              <ExternalLink size={13} aria-hidden="true" />
              <span>{t('中心管理账号与撤权', 'Manage & revoke in Center')}</span>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
