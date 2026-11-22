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
import {
  calendarMinutesBeforeInputValue,
  DEFAULT_CALENDAR_MINUTES_BEFORE,
  formatCalendarMinutesBefore,
  parseCalendarMinutesBefore,
} from '../center-admin/googleHelpers';
import { openExternalUrl } from '../center-admin/openExternalUrl';
import { ActionBar, ConfirmDialog } from '../components/ui';
import { useNotice } from '../notice';
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
  const { notify } = useNotice();
  const fieldId = useId();
  const mountedRef = useRef(true);

  const [snapshot, setSnapshot] = useState<GoogleStatusSnapshot | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [statusError, setStatusError] = useState('');
  const [tempError, setTempError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [checkingAccount, setCheckingAccount] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<ActivePanel>(null);

  // Rules state
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rules, setRules] = useState<GoogleRuleDto[]>([]);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState('');
  const [rulesBusyId, setRulesBusyId] = useState<string | null>(null);
  const [deletingRule, setDeletingRule] = useState<GoogleRuleDto | null>(null);

  // New / edit rule draft
  const [ruleFormOpen, setRuleFormOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | undefined>(undefined);
  const [ruleSource, setRuleSource] = useState<GoogleRuleSource>('gmail');
  const [ruleAccount, setRuleAccount] = useState('');
  const [ruleFrom, setRuleFrom] = useState('');
  const [ruleSubject, setRuleSubject] = useState('');
  const [ruleCalendar, setRuleCalendar] = useState('primary');
  const [ruleMinutesBefore, setRuleMinutesBefore] = useState(String(DEFAULT_CALENDAR_MINUTES_BEFORE));
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
        setStatusError(t('无法读取 Google 状态：当前 Center 未启用共享 Google Workspace 接口。请升级 Center 或联系管理员开启。', 'Could not load Google status: shared Google Workspace endpoints are unavailable on this Center. Upgrade Center or ask an admin to enable them.'));
      } else if (info.tempError || info.offline) {
        // Keep last known snapshot intact — never downgrade connected accounts on transient errors!
        setTempError(true);
        setStatusError(
          info.offline
            ? t('无法刷新 Google 状态：当前与 Center 断开连接。请检查网络或重新连接 Center 后重试。', 'Could not refresh Google status: disconnected from Center. Check your connection and retry.')
            : t('暂时无法连接 Center，已保留现有连接状态。请稍后点击「重试检查」。', 'Center is temporarily unreachable; existing connections are kept. Select Retry check shortly.'),
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
          ? t('无法读取触发规则：当前 Center 未启用 Google 自动触发规则接口。请升级 Center 后重试。', 'Could not load trigger rules: Google trigger rules API is unavailable on this Center. Upgrade Center and retry.')
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
    setStatusError('');
    try {
      await checkGoogleAccount(api, identity, email);
      await loadStatus();
      if (mountedRef.current) {
        notify({ id: 'google-cap-status', tone: 'success', title: t(`已重新检查 ${email} 的服务状态`, `Re-checked service readiness for ${email}`) });
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
      notify({ id: 'google-cap-status', tone: 'success', title: t('已复制管理员配置指引', 'Copied administrator instructions to clipboard') });
    } catch {
      setStatusError(t('复制管理员指引失败：当前环境限制访问剪贴板。请将应用切回前台后重试。', 'Could not copy admin guide: clipboard access was blocked. Return to the foreground and retry.'));
    }
  };

  const openNewRuleForm = (source: GoogleRuleSource) => {
    setEditingRuleId(undefined);
    setRuleSource(source);
    setRuleAccount(connectedAccounts.length === 1 ? connectedAccounts[0].email : '');
    setRuleFrom('');
    setRuleSubject('');
    setRuleCalendar('primary');
    setRuleMinutesBefore(String(DEFAULT_CALENDAR_MINUTES_BEFORE));
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
    setRuleMinutesBefore(calendarMinutesBeforeInputValue(rule.minutesBefore));
    setRuleInstruction(rule.instruction);
    setRulesError('');
    setRuleFormOpen(true);
  };

  const handleSaveRule = async (event: FormEvent) => {
    event.preventDefault();
    if (ruleSaving) return;
    if (!ruleAccount) {
      setRulesError(t('保存规则失败：尚未选择 Google 账号。请先选择一个已连接账号后重试。', 'Cannot save rule: no Google account selected. Select a connected account and try again.'));
      return;
    }
    const instruction = ruleInstruction.trim();
    if (!instruction) {
      setRulesError(t('保存规则失败：未填写触发指令。请输入触发后希望本 Bot 执行的操作后重试。', 'Cannot save rule: trigger instruction is empty. Describe what this Bot should do and try again.'));
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
              minutesBefore: parseCalendarMinutesBefore(ruleMinutesBefore),
            }),
      };
      await saveGoogleRule(api, identity, payload);
      if (!mountedRef.current) return;
      setRuleFormOpen(false);
      setEditingRuleId(undefined);
      notify({
        id: 'google-cap-status',
        tone: 'success',
        title: ruleSource === 'gmail'
          ? t('邮件触发规则已保存，仅对新到达邮件生效', 'Email rule saved for new incoming mail')
          : t('会前提醒规则已保存', 'Pre-meeting rule saved'),
      });
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
      notify({
        id: 'google-cap-status',
        tone: 'success',
        title: rule.enabled ? t('已暂停触发规则', 'Trigger rule paused') : t('已启用触发规则', 'Trigger rule enabled'),
      });
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
      notify({ id: 'google-cap-status', tone: 'success', title: t('已删除触发规则', 'Trigger rule deleted') });
      await loadRules();
    } catch (cause) {
      if (!mountedRef.current) return;
      setRulesError(classifyGoogleError(cause).message);
    } finally {
      if (mountedRef.current) {
        setDeletingRule(null);
        setRulesBusyId(null);
      }
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
        {t('Gmail、日历、云盘与联系人工具默认共享给所有 Bot，无需逐个开启。', 'Gmail, Calendar, Drive, and Contacts are shared across all Bots automatically.')}
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
            {!unavailable ? (
              <ActionBar align="start">
                <button type="button" className="gws-link-btn" disabled={loadingStatus} onClick={() => void loadStatus()}>
                  {t('重试检查', 'Retry check')}
                </button>
              </ActionBar>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Unconfigured Center App actions */}
      {!unavailable && snapshot && !client?.configured ? (
        <div className="gws-empty-box">
          <p className="gws-muted">
            {t('在 Center 配置一次 Web OAuth 应用即可全员复用；非管理员请联系 Center 管理员。', 'Configure one Center Web OAuth app for all Bots. Contact your Center admin if you lack permission.')}
          </p>
          <ActionBar align="start" className="gws-actions">
            <button
              type="button"
              className="gws-btn is-primary is-sm"
              onClick={() => setActivePanel(prev => (prev?.kind === 'wizard' ? null : { kind: 'wizard' }))}
            >
              {t('引导创建 Google 应用', 'Guide me to create Google app')}
            </button>
            <button
              type="button"
              className="gws-btn is-ghost is-sm"
              onClick={() => setActivePanel(prev => (prev?.kind === 'configure' ? null : { kind: 'configure' }))}
            >
              <Lock size={13} aria-hidden="true" />
              <span>{t('录入已有凭据', 'Enter existing credentials')}</span>
            </button>
            <button type="button" className="gws-btn is-ghost is-sm" onClick={() => void handleCopyAdminGuide()}>
              <Copy size={13} aria-hidden="true" />
              <span>{t('复制管理员指引', 'Copy admin note')}</span>
            </button>
          </ActionBar>
        </div>
      ) : null}

      {/* Dimension B & C: Shared accounts & per-service readiness */}
      {!unavailable && snapshot && client?.configured ? (
        accounts.length === 0 ? (
          <div className="gws-empty-box">
            <p className="gws-muted">
              {t('应用已就绪，在系统浏览器连接 Google 账号后即可使用。', 'App is ready. Connect a Google account in your system browser to start.')}
            </p>
            <ActionBar align="start" className="gws-actions">
              <button
                type="button"
                className="gws-btn is-primary is-sm"
                onClick={() => setActivePanel({ kind: 'signin', mode: 'connect' })}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>{t('连接 Google 账号', 'Connect Google account')}</span>
              </button>
            </ActionBar>
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
                    <ActionBar align="end" className="gws-account-actions">
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
                          {t('管理服务', 'Manage services')}
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
                    </ActionBar>
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
          onStatusUpdated={setSnapshot}
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
                {t('仅用于新邮件或会前自动唤醒本 Bot；暂停规则不影响手动调用。', 'Triggers this Bot on new mail or upcoming meetings; pausing never affects manual use.')}
              </p>

              {rulesError ? (
                <div className="gws-error" role="alert">
                  <ShieldAlert size={14} aria-hidden="true" />
                  <div className="gws-error-body">
                    <span>{rulesError}</span>
                    <ActionBar align="start">
                      <button type="button" className="gws-link-btn" disabled={rulesLoading} onClick={() => void loadRules()}>
                        {t('重试读取', 'Retry')}
                      </button>
                    </ActionBar>
                  </div>
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
                                : formatCalendarMinutesBefore(rule.minutesBefore, t)}
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
                        <ActionBar align="start" className="gws-rule-actions">
                          <button
                            type="button"
                            className="gws-btn is-ghost is-xs"
                            disabled={busy}
                            onClick={() => void handleToggleRule(rule)}
                          >
                            {rule.enabled ? t('暂停规则', 'Pause rule') : t('启用规则', 'Enable rule')}
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
                            <button
                              type="button"
                              className="gws-btn is-ghost is-xs"
                              disabled={busy}
                              onClick={() => setDeletingRule(rule)}
                            >
                              <Trash2 size={12} aria-hidden="true" />
                              <span>{t('删除', 'Delete')}</span>
                            </button>
                          ) : null}
                        </ActionBar>
                      </div>
                    );
                  })}
                </div>
              ) : !rulesLoading && !ruleFormOpen ? (
                <p className="gws-muted">{t('本 Bot 尚未配置 Google 自动触发规则。', 'No Google trigger rules configured for this Bot.')}</p>
              ) : null}

              {!ruleFormOpen ? (
                <ActionBar align="start" className="gws-actions">
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
                </ActionBar>
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
                        {t('仅匹配开启后新到达的邮件，不回放历史收件箱。', 'Matches new incoming mail only; past inbox mail is not replayed.')}
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
                          step={1}
                          className="gws-input"
                          value={ruleMinutesBefore}
                          disabled={ruleSaving}
                          onChange={e => setRuleMinutesBefore(e.target.value)}
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

                  <ActionBar align="end" className="gws-actions">
                    <button
                      type="button"
                      className="gws-btn is-ghost is-sm"
                      disabled={ruleSaving}
                      onClick={() => { setRuleFormOpen(false); setEditingRuleId(undefined); }}
                    >
                      {t('取消', 'Cancel')}
                    </button>
                    <button type="submit" className="gws-btn is-primary is-sm" disabled={ruleSaving} aria-busy={ruleSaving || undefined}>
                      {ruleSaving ? t('保存中…', 'Saving…') : t('保存规则', 'Save rule')}
                    </button>
                  </ActionBar>
                </form>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Browser isolation note + quick actions */}
      <div className="gws-footer-bar">
        <span className="gws-isolation-note">
          {t('Bot 浏览器网页登录与 Google API 授权相互独立。', 'Bot browser web login is separate from Google API access.')}
        </span>
        <ActionBar align="end" className="gws-actions">
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
        </ActionBar>
      </div>

      <ConfirmDialog
        open={deletingRule !== null}
        danger
        busy={Boolean(deletingRule?.id && rulesBusyId === deletingRule.id)}
        title={
          deletingRule
            ? deletingRule.source === 'gmail'
              ? t(`删除 ${deletingRule.account} 的邮件触发规则？`, `Delete email rule for ${deletingRule.account}?`)
              : t(`删除 ${deletingRule.account} 的会前提醒规则？`, `Delete meeting rule for ${deletingRule.account}?`)
            : ''
        }
        description={t('删除后本 Bot 将不再由该规则自动触发，不影响手动使用 Google 工具或其他规则。', 'This Bot will stop receiving automatic triggers from this rule. Manual Google tool use and other rules are unaffected.')}
        confirmLabel={t('删除规则', 'Delete rule')}
        cancelLabel={t('取消', 'Cancel')}
        onCancel={() => setDeletingRule(null)}
        onConfirm={() => {
          if (deletingRule) void handleDeleteRule(deletingRule);
        }}
      />
    </section>
  );
}
