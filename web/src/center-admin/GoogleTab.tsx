import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Bot,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  Shield,
  Trash2,
  Upload,
} from 'lucide-react';
import { LabelStack, ReservedSlot } from '../layout';
import { useText } from '../ui';
import { readTabCache, writeTabCache } from './cache';
import { CenterApiError, errorMessage } from './transport';
import type { CenterApi } from './transport';
import {
  ActionMenu,
  CaCardDisclosure,
  CaCardSkeleton,
  CaChips,
  CaConfirmDialog,
  CaDisclosure,
  CaExternalUrlBox,
  CaModal,
  CaNotice,
  CaRefreshBar,
  CaSectionSkeleton,
  CaSegmented,
  CaSwitch,
  CopyButton,
  botKey,
  copyToClipboard,
  formatCountdown,
  formatTime,
  openExternalUrl,
  platformLabel,
  useCaTabNotices,
  useUiLocale,
} from './primitives';
import {
  DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES,
  DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES,
  DEFAULT_CALENDAR_MINUTES_BEFORE,
  GOOGLE_CLOUD_AUTH_CLIENTS_URL,
  GOOGLE_CLOUD_AUTH_OVERVIEW_URL,
  GOOGLE_CLOUD_CREATE_PROJECT_URL,
  GOOGLE_CONNECTIONS_URL,
  GOOGLE_SERVICE_CHOICES,
  assistantRuntimeBadgeMeta,
  buildGoogleAssistantSetupPayload,
  buildReadinessRows,
  calendarMinutesBeforeInputValue,
  canonicalChoices,
  defaultDigestTimesForMode,
  deriveFallbackRedirectUri,
  formatCalendarMinutesBefore,
  formatDigestTimesInput,
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
  parseCalendarMinutesBefore,
  pickDefaultAssistantDeviceId,
  pickDefaultExistingAssistantBot,
  readinessBadgeMeta,
  ruleEffectiveStatus,
  shouldPromptGoogleAssistantSetup,
  validateWebClientJson,
} from './googleHelpers';
import type {
  CenterBotRef,
  CenterDevice,
  GoogleAccountStatus,
  GoogleAssistantConfig,
  GoogleAssistantMode,
  GoogleAssistantRuntime,
  GoogleFlowPhase,
  GoogleRule,
  GoogleRuleSource,
  GoogleServiceChoice,
  GoogleStatusResponse,
  ModelPickerResponse,
} from './types';

type GoogleSection = 'accounts' | 'rules' | 'client';
type RuleSourceFilter = 'all' | GoogleRuleSource;

type GoogleModal =
  | null
  | { kind: 'wizard' }
  | { kind: 'connect'; targetAccount: GoogleAccountStatus | null }
  | { kind: 'remove-account'; account: GoogleAccountStatus }
  | { kind: 'rule'; editing: GoogleRule | null }
  | { kind: 'confirm-delete-rule'; rule: GoogleRule }
  | { kind: 'assistant-setup'; postOAuth?: boolean; isEdit?: boolean }
  | { kind: 'confirm-remove-assistant' };

interface ActiveAuthFlow {
  flowId: string;
  authorizationUrl: string;
  expiresAt: string;
  phase: GoogleFlowPhase;
  choices: GoogleServiceChoice[];
  targetAccount?: string;
  error?: string;
}

export interface PendingGoogleFlow extends ActiveAuthFlow {
  phase: 'pending';
}

const pendingGoogleFlows = new Map<string, PendingGoogleFlow>();

function isPendingFlowExpired(
  flow: Pick<PendingGoogleFlow, 'expiresAt'>,
  now = Date.now(),
): boolean {
  const expMs = new Date(flow.expiresAt).getTime();
  return !Number.isFinite(expMs) || expMs <= now;
}

function readPendingGoogleFlow(scopeKey: string): PendingGoogleFlow | null {
  const stored = pendingGoogleFlows.get(scopeKey);
  if (!stored) return null;
  if (isPendingFlowExpired(stored)) {
    pendingGoogleFlows.delete(scopeKey);
    return null;
  }
  return stored;
}

function writePendingGoogleFlow(scopeKey: string, flow: PendingGoogleFlow): void {
  if (isPendingFlowExpired(flow)) {
    pendingGoogleFlows.delete(scopeKey);
    return;
  }
  pendingGoogleFlows.set(scopeKey, flow);
}

export function clearPendingGoogleFlow(scopeKey?: string, expectedFlowId?: string): void {
  if (scopeKey === undefined) {
    pendingGoogleFlows.clear();
    return;
  }
  if (expectedFlowId !== undefined) {
    const existing = pendingGoogleFlows.get(scopeKey);
    if (existing && existing.flowId !== expectedFlowId) return;
  }
  pendingGoogleFlows.delete(scopeKey);
}

interface NoticeBanner {
  tone: 'ok' | 'warn' | 'danger' | 'info';
  text: string;
  linkUrl?: string;
  linkLabel?: string;
  actionLabel?: string;
  onAction?: () => void;
}

interface GoogleCacheData {
  status: GoogleStatusResponse | null;
  unavailableReason: string | null;
  forbiddenReason: string | null;
  devices: CenterDevice[];
  bots: CenterBotRef[];
  rules: GoogleRule[];
  rulesUnavailable: boolean;
  assistant?: GoogleAssistantConfig | null;
  assistantRuntime?: GoogleAssistantRuntime | null;
  assistantUnavailable?: boolean;
  picker?: ModelPickerResponse | null;
}

interface GoogleLoadResult {
  accounts: GoogleAccountStatus[];
  devices: CenterDevice[];
  bots: CenterBotRef[];
  assistant: GoogleAssistantConfig | null;
  assistantUnavailable: boolean;
}

const MINUTES_BEFORE_PRESETS = [0, 5, 10, 15, 30] as const;

function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'danger' | 'muted' }): React.JSX.Element {
  const bg =
    tone === 'ok'
      ? 'var(--ca-ok)'
      : tone === 'warn'
        ? 'var(--ca-warn)'
        : tone === 'danger'
          ? 'var(--ca-danger)'
          : 'var(--ca-text-subtle)';
  return <span className="ca-dot" style={{ background: bg }} aria-hidden="true" />;
}

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
  active = true,
  cacheKey = 'default',
  centerUrl,
  onOpenExternalUrl,
  onConfigureBot,
  onStartGoogleSetupWizard,
}: {
  api: CenterApi;
  active?: boolean;
  cacheKey?: string;
  centerUrl?: string;
  onOpenExternalUrl?: (url: string) => void | Promise<unknown>;
  onConfigureBot?: (deviceId: string, botId: string) => void;
  onStartGoogleSetupWizard?: (deviceId: string, botId: string) => void;
}): React.JSX.Element {
  const t = useText();
  const locale = useUiLocale();

  const initialCache = useMemo(
    () => readTabCache<GoogleCacheData>(cacheKey, 'google')?.data ?? null,
    [cacheKey],
  );
  const initialPendingFlow = useMemo(() => readPendingGoogleFlow(cacheKey), [cacheKey]);

  // Progressive 3-section segmented navigation: default to 'accounts' if configured or OAuth flow is pending, else 'client'
  const [section, setSection] = useState<GoogleSection>(() =>
    initialPendingFlow || initialCache?.status?.client?.configured ? 'accounts' : 'client',
  );
  const userPickedSectionRef = useRef(false);

  // Single mutually exclusive modal union (never stacks modals)
  const [modal, setModal] = useState<GoogleModal>(null);
  const modalRef = useRef<GoogleModal>(modal);
  modalRef.current = modal;

  // Primary status & directory data
  const [hasLoaded, setHasLoaded] = useState<boolean>(() => initialCache !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    () => initialCache?.unavailableReason ?? null,
  );
  const [forbiddenReason, setForbiddenReason] = useState<string | null>(
    () => initialCache?.forbiddenReason ?? null,
  );
  const [loadError, setLoadError] = useState('');

  const [status, setStatus] = useState<GoogleStatusResponse | null>(() => initialCache?.status ?? null);
  const [devices, setDevices] = useState<CenterDevice[]>(() => initialCache?.devices ?? []);
  const [bots, setBots] = useState<CenterBotRef[]>(() => initialCache?.bots ?? []);

  // Rules state
  const [rules, setRules] = useState<GoogleRule[]>(() => initialCache?.rules ?? []);
  const [rulesUnavailable, setRulesUnavailable] = useState<boolean>(
    () => initialCache?.rulesUnavailable ?? false,
  );
  const [ruleSourceFilter, setRuleSourceFilter] = useState<RuleSourceFilter>('all');
  const [ruleBotFilter, setRuleBotFilter] = useState<string>('all');
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);
  const [deletingRule, setDeletingRule] = useState(false);

  // Proactive mail & calendar assistant state
  const [assistant, setAssistant] = useState<GoogleAssistantConfig | null>(
    () => initialCache?.assistant ?? null,
  );
  const [assistantRuntime, setAssistantRuntime] = useState<GoogleAssistantRuntime | null>(
    () => initialCache?.assistantRuntime ?? null,
  );
  const [assistantUnavailable, setAssistantUnavailable] = useState<boolean>(
    () => initialCache?.assistantUnavailable ?? false,
  );
  const [picker, setPicker] = useState<ModelPickerResponse | null>(
    () => initialCache?.picker ?? null,
  );
  const [assistantToggling, setAssistantToggling] = useState(false);
  const [assistantRemoving, setAssistantRemoving] = useState(false);

  // Proactive assistant setup / edit modal form state
  const [assistantMode, setAssistantMode] = useState<GoogleAssistantMode>('dedicated');
  const [assistantDedicatedAction, setAssistantDedicatedAction] = useState<'create' | 'keep'>('create');
  const [assistantDeviceId, setAssistantDeviceId] = useState('');
  const [assistantBotName, setAssistantBotName] = useState('');
  const [assistantModelRef, setAssistantModelRef] = useState('');
  const [assistantTargetBotKey, setAssistantTargetBotKey] = useState('');
  const [assistantAccounts, setAssistantAccounts] = useState<string[]>([]);
  const [assistantBatchWindow, setAssistantBatchWindow] = useState(
    String(DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES),
  );
  const [assistantDigestTimes, setAssistantDigestTimes] = useState('');
  const [assistantDigestDirty, setAssistantDigestDirty] = useState(false);
  const [assistantCalendarEnabled, setAssistantCalendarEnabled] = useState(true);
  const [assistantCalendarLead, setAssistantCalendarLead] = useState(
    String(DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES),
  );
  const [assistantHindsight, setAssistantHindsight] = useState(true);
  const [assistantHindsightDirty, setAssistantHindsightDirty] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantFormError, setAssistantFormError] = useState('');

  const hasLoadedRef = useRef(hasLoaded);
  const statusRef = useRef(status);
  statusRef.current = status;
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const botsRef = useRef(bots);
  botsRef.current = bots;
  const assistantRef = useRef(assistant);
  assistantRef.current = assistant;
  const cacheKeyRef = useRef(cacheKey);
  const activeRef = useRef(active);
  activeRef.current = active;
  const prevActiveRef = useRef(active);
  const tRef = useRef(t);
  tRef.current = t;
  const loadGenRef = useRef(0);

  const { showNotice, clearNotice } = useCaTabNotices('google', active);

  const setBanner = useCallback(
    (next: NoticeBanner | null) => {
      if (!next) {
        clearNotice('banner');
        return;
      }
      let action: { label: string; onClick: () => void } | undefined;
      if (next.actionLabel && next.onAction) {
        const handler = next.onAction;
        action = {
          label: next.actionLabel,
          onClick: () => {
            clearNotice('banner');
            handler();
          },
        };
      } else if (next.linkUrl) {
        const t = tRef.current;
        const url = next.linkUrl;
        action = {
          label: next.linkLabel || t('打开链接', 'Open link'),
          onClick: () => void openExternalUrl(url, onOpenExternalUrl),
        };
      }
      showNotice('banner', next.text, {
        tone: next.tone,
        action,
        sticky: Boolean(action),
        durationMs: next.tone === 'warn' || next.tone === 'danger' ? 7500 : undefined,
      });
    },
    [clearNotice, onOpenExternalUrl, showNotice],
  );

  const setRulesError = useCallback(
    (msg: string) => {
      if (msg) showNotice('rules-error', msg, { tone: 'danger' });
      else clearNotice('rules-error');
    },
    [clearNotice, showNotice],
  );

  // Per-account transient UI state (never mutates server grant state)
  const [checkingAccounts, setCheckingAccounts] = useState<Set<string>>(new Set());
  const [transientCheckErrors, setTransientCheckErrors] = useState<Record<string, string>>({});
  const [skippedServices, setSkippedServices] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  // In-page OAuth Client form state ('client' section)
  const [configMode, setConfigMode] = useState<'file' | 'manual'>('file');
  const [configBusy, setConfigBusy] = useState(false);
  const [configError, setConfigError] = useState('');
  const [clientFileName, setClientFileName] = useState('');
  const [clientFileRaw, setClientFileRaw] = useState('');
  const [clientIdDraft, setClientIdDraft] = useState('');
  const [clientSecretDraft, setClientSecretDraft] = useState('');
  const [draggingJson, setDraggingJson] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Bot setup wizard form state
  const [wizardTargetBotKey, setWizardTargetBotKey] = useState(() => {
    const first = (initialCache?.bots ?? []).find(b => !b.archivedAt);
    return first ? botKey(first.deviceId, first.botId) : '';
  });

  // Connect / Add Services modal state
  const [selectedChoices, setSelectedChoices] = useState<GoogleServiceChoice[]>([
    'gmail',
    'calendar',
    'files',
  ]);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState('');

  // Active OAuth system-browser flow (hydrated from module-level store across tab switches)
  const [activeFlow, setActiveFlow] = useState<ActiveAuthFlow | null>(() => initialPendingFlow);
  const [cancellingFlow, setCancellingFlow] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const flowGenRef = useRef(0);
  const prevFlowScopeRef = useRef(cacheKey);

  // Remove account modal state
  const [removeRevoke, setRemoveRevoke] = useState(true);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState('');

  // Rule create / edit modal state
  const [ruleSource, setRuleSource] = useState<GoogleRuleSource>('gmail');
  const [ruleBotKey, setRuleBotKey] = useState('');
  const [ruleAccount, setRuleAccount] = useState('');
  const [ruleFrom, setRuleFrom] = useState('');
  const [ruleSubject, setRuleSubject] = useState('');
  const [ruleCalendar, setRuleCalendar] = useState('primary');
  const [ruleMinutesBefore, setRuleMinutesBefore] = useState(String(DEFAULT_CALENDAR_MINUTES_BEFORE));
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

  const switchSection = useCallback(
    (next: GoogleSection) => {
      userPickedSectionRef.current = true;
      setSection(prev => {
        if (prev === 'client' && next !== 'client') {
          clearSecretDrafts();
        }
        return next;
      });
    },
    [clearSecretDrafts],
  );

  // Clear stale flow when scope (cacheKey) changes while mounted
  useEffect(() => {
    const prevScope = prevFlowScopeRef.current;
    if (prevScope === cacheKey) return;
    prevFlowScopeRef.current = cacheKey;
    clearPendingGoogleFlow(prevScope);
    flowGenRef.current += 1;
    setCancellingFlow(false);
    setActiveFlow(readPendingGoogleFlow(cacheKey));
  }, [cacheKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleUnauth = () => {
      clearPendingGoogleFlow(cacheKey);
      flowGenRef.current += 1;
      setCancellingFlow(false);
      setActiveFlow(null);
    };
    window.addEventListener('center-unauthenticated', handleUnauth);
    return () => window.removeEventListener('center-unauthenticated', handleUnauth);
  }, [cacheKey]);

  // Clear secrets and timers on unmount
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
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const globalDefaultModelName = useMemo(() => {
    if (!picker?.defaultModel) return '';
    const found = picker.models.find(m => m.modelRef === picker.defaultModel);
    return found?.name || picker.defaultModel;
  }, [picker]);

  const sortedPickerModels = useMemo(() => {
    if (!picker) return [];
    const starred = new Set(picker.starredModels);
    return [...picker.models].sort(
      (a, b) => (starred.has(a.modelRef) ? 0 : 1) - (starred.has(b.modelRef) ? 0 : 1),
    );
  }, [picker]);

  const openAssistantSetupModal = useCallback(
    (opts?: {
      postOAuth?: boolean;
      editing?: GoogleAssistantConfig | null;
      accountsOverride?: GoogleAccountStatus[];
      devicesOverride?: CenterDevice[];
      botsOverride?: CenterBotRef[];
    }) => {
      const liveAccounts = opts?.accountsOverride ?? accountsRef.current;
      const liveDevices = opts?.devicesOverride ?? devicesRef.current;
      const liveBots = opts?.botsOverride ?? botsRef.current;
      const existingCfg = opts?.editing ?? null;
      const tr = tRef.current;

      const readyEmails = liveAccounts
        .filter(a => !isAccountReconnectRequired(a))
        .map(a => a.email);
      const fallbackEmails = readyEmails.length > 0 ? readyEmails : liveAccounts.map(a => a.email);

      const defaultDevice = pickDefaultAssistantDeviceId(liveDevices, existingCfg?.deviceId);
      const defaultBot = pickDefaultExistingAssistantBot(liveBots, liveDevices, existingCfg?.deviceId);

      if (existingCfg) {
        setAssistantMode(existingCfg.mode);
        setAssistantDedicatedAction(existingCfg.mode === 'dedicated' ? 'keep' : 'create');
        setAssistantDeviceId(defaultDevice || existingCfg.deviceId);
        const currentBot = liveBots.find(
          b => b.deviceId === existingCfg.deviceId && b.botId === existingCfg.botId,
        );
        const t = tr;
        setAssistantBotName(currentBot?.name || t('邮件与日程管家', 'Mail & Calendar Assistant'));
        setAssistantModelRef('');
        setAssistantTargetBotKey(
          existingCfg.mode === 'existing'
            ? botKey(existingCfg.deviceId, existingCfg.botId)
            : defaultBot
              ? botKey(defaultBot.deviceId, defaultBot.botId)
              : '',
        );
        const savedAccounts = existingCfg.accounts.filter(Boolean);
        setAssistantAccounts(savedAccounts.length > 0 ? savedAccounts : fallbackEmails);
        setAssistantBatchWindow(
          String(existingCfg.batchWindowMinutes || DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES),
        );
        const formattedDigest = formatDigestTimesInput(existingCfg.digestTimes);
        const modeDefaultDigest = formatDigestTimesInput(defaultDigestTimesForMode(existingCfg.mode));
        setAssistantDigestTimes(formattedDigest);
        setAssistantDigestDirty(formattedDigest !== modeDefaultDigest);
        setAssistantCalendarEnabled(Boolean(existingCfg.calendarEnabled));
        setAssistantCalendarLead(
          String(existingCfg.calendarLeadMinutes ?? DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES),
        );
        const savedHindsight = Boolean(existingCfg.hindsightPrivateMemory);
        setAssistantHindsight(savedHindsight);
        setAssistantHindsightDirty(savedHindsight !== (existingCfg.mode === 'dedicated'));
        setAssistantFormError('');
        setModal({ kind: 'assistant-setup', isEdit: true });
        return;
      }

      setAssistantMode('dedicated');
      setAssistantDedicatedAction('create');
      setAssistantDeviceId(defaultDevice);
      const t = tr;
      setAssistantBotName(t('邮件与日程管家', 'Mail & Calendar Assistant'));
      setAssistantModelRef('');
      setAssistantTargetBotKey(defaultBot ? botKey(defaultBot.deviceId, defaultBot.botId) : '');
      setAssistantAccounts(fallbackEmails);
      setAssistantBatchWindow(String(DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES));
      setAssistantDigestTimes(formatDigestTimesInput(defaultDigestTimesForMode('dedicated')));
      setAssistantDigestDirty(false);
      setAssistantCalendarEnabled(true);
      setAssistantCalendarLead(String(DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES));
      setAssistantHindsight(true);
      setAssistantHindsightDirty(false);
      setAssistantFormError('');
      setModal({ kind: 'assistant-setup', postOAuth: Boolean(opts?.postOAuth), isEdit: false });
    },
    [],
  );

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
            if (activeRef.current) {
              const t = tRef.current;
              setRulesError(errorMessage(fallbackErr, t('加载邮件与日历规则失败，请重试', 'Failed to load rules. Please retry.')));
            }
            return;
          }
        }
        if (activeRef.current) {
          const t = tRef.current;
          setRulesError(errorMessage(err, t('加载邮件与日历规则失败，请重试', 'Failed to load rules. Please retry.')));
        }
      }
    },
    [api, setRulesError],
  );

  const loadAll = useCallback(
    async (opts?: { silent?: boolean }): Promise<GoogleLoadResult | null> => {
      const gen = ++loadGenRef.current;
      const isBackground = Boolean(opts?.silent) || hasLoadedRef.current;
      if (isBackground) setRefreshing(true);
      if (!isBackground) {
        setLoadError('');
        setUnavailableReason(null);
        setForbiddenReason(null);
      }

      try {
        const [googleRes, syncRes, assistantRes, pickerRes] = await Promise.all([
          api.getGoogleStatus(),
          api.getBotSync().catch(() => null),
          api.getGoogleAssistant().then(
            data => ({ ok: true as const, data }),
            err => ({ ok: false as const, err }),
          ),
          api.getModelPicker().catch(() => null),
        ]);
        if (gen !== loadGenRef.current) return null;

        setLoadError('');
        clearNotice('load-error');
        setForbiddenReason(null);

        if (googleRes.available === false) {
          const t = tRef.current;
          setUnavailableReason(
            googleRes.reason ||
              t('当前中心未启用 Google Workspace 功能模块', 'Google Workspace is not enabled on this Center server.'),
          );
          setStatus(null);
        } else {
          setUnavailableReason(null);
          setStatus(googleRes);
          if (!userPickedSectionRef.current) {
            setSection(
              readPendingGoogleFlow(cacheKey) || googleRes.client?.configured ? 'accounts' : 'client',
            );
          }
        }

        const nextDevices = syncRes?.devices ?? [];
        const nextBots = syncRes?.bots ?? [];
        setDevices(nextDevices);
        setBots(nextBots);
        if (pickerRes) {
          setPicker(pickerRes);
        }

        let nextAssistant: GoogleAssistantConfig | null = assistantRef.current;
        let nextAssistantUnavailable = false;
        if (assistantRes.ok) {
          nextAssistant = assistantRes.data?.assistant ?? null;
          nextAssistantUnavailable = false;
          setAssistantUnavailable(false);
          setAssistant(nextAssistant);
          setAssistantRuntime(assistantRes.data?.runtime ?? null);
        } else if (
          assistantRes.err instanceof CenterApiError &&
          (assistantRes.err.status === 404 || assistantRes.err.status === 501)
        ) {
          nextAssistant = null;
          nextAssistantUnavailable = true;
          setAssistantUnavailable(true);
          setAssistant(null);
          setAssistantRuntime(null);
        }

        const activeList = nextBots.filter(b => !b.archivedAt);
        if (activeList.length > 0) {
          setWizardTargetBotKey(prev =>
            prev && activeList.some(b => botKey(b.deviceId, b.botId) === prev)
              ? prev
              : botKey(activeList[0].deviceId, activeList[0].botId),
          );
        }

        if (googleRes.available !== false) {
          await loadRules(activeList);
        }
        if (gen !== loadGenRef.current) return null;
        hasLoadedRef.current = true;
        cacheKeyRef.current = cacheKey;
        setHasLoaded(true);

        if (googleRes.available === false) return null;
        return {
          accounts: googleRes.accounts ?? [],
          devices: nextDevices,
          bots: nextBots,
          assistant: nextAssistant,
          assistantUnavailable: nextAssistantUnavailable,
        };
      } catch (err) {
        if (gen !== loadGenRef.current) return null;
        const t = tRef.current;
        if (err instanceof CenterApiError && (err.status === 404 || err.status === 501)) {
          setUnavailableReason(
            t('当前中心服务端尚未提供 Google Workspace 接口（/api/google/status 不可用）。请升级或启用中心 Google 模块后重试。', 'This Center server does not expose the Google Workspace endpoints yet (/api/google/status unavailable).'),
          );
          setStatus(null);
          hasLoadedRef.current = true;
          cacheKeyRef.current = cacheKey;
          setHasLoaded(true);
        } else if (err instanceof CenterApiError && err.status === 403) {
          const msg =
            err.message ||
            t('当前会话无权管理中心 Google 应用配置，请联系中心管理员或使用所有者会话登录。', 'This session cannot manage Center Google settings. Contact the Center administrator or sign in as the owner.');
          if (statusRef.current) {
            if (activeRef.current) {
              showNotice('load-error', msg, {
                tone: 'danger',
                action: {
                  label: t('重试', 'Retry'),
                  onClick: () => void loadAll({ silent: true }),
                },
              });
            }
          } else {
            setForbiddenReason(msg);
            hasLoadedRef.current = true;
            cacheKeyRef.current = cacheKey;
            setHasLoaded(true);
          }
        } else {
          const msg = errorMessage(
            err,
            t('暂时无法获取中心 Google 状态，请检查中心连接后重试', 'Unable to load Center Google status. Check connectivity and retry.'),
          );
          if (statusRef.current) {
            if (activeRef.current) {
              showNotice('load-error', msg, {
                tone: 'danger',
                action: {
                  label: t('重试', 'Retry'),
                  onClick: () => void loadAll({ silent: true }),
                },
              });
            }
          } else {
            setLoadError(msg);
          }
        }
        return null;
      } finally {
        if (gen === loadGenRef.current) {
          setRefreshing(false);
        }
      }
    },
    [api, cacheKey, clearNotice, loadRules, showNotice],
  );

  useEffect(() => {
    void loadAll({ silent: hasLoadedRef.current });
  }, [loadAll]);

  useEffect(() => {
    const wasActive = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!wasActive && active && (hasLoadedRef.current || Boolean(loadError))) {
      void loadAll({ silent: hasLoadedRef.current });
    }
  }, [active, loadAll, loadError]);

  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!hasLoaded || cacheKeyRef.current !== cacheKey) return;
    if (!status && !unavailableReason && !forbiddenReason) return;
    writeTabCache<GoogleCacheData>(cacheKey, 'google', {
      status,
      unavailableReason,
      forbiddenReason,
      devices,
      bots,
      rules,
      rulesUnavailable,
      assistant,
      assistantRuntime,
      assistantUnavailable,
      picker,
    });
  }, [
    assistant,
    assistantRuntime,
    assistantUnavailable,
    bots,
    cacheKey,
    devices,
    forbiddenReason,
    hasLoaded,
    picker,
    rules,
    rulesUnavailable,
    status,
    unavailableReason,
  ]);

  // Countdown tick while waiting for system browser OAuth (paused when tab hidden)
  useEffect(() => {
    if (!active || !activeFlow || activeFlow.phase !== 'pending') return;
    const currentFlow = activeFlow;
    const checkTick = () => {
      const now = Date.now();
      setNowMs(now);
      if (isPendingFlowExpired(currentFlow, now)) {
        const t = tRef.current;
        clearPendingGoogleFlow(cacheKey, currentFlow.flowId);
        setActiveFlow(prev =>
          prev && prev.flowId === currentFlow.flowId && prev.phase === 'pending'
            ? {
                ...prev,
                phase: 'failed',
                error: t('授权流程已过期，请重新开始。', 'Authorization flow expired. Please start again.'),
              }
            : prev,
        );
      }
    };
    checkTick();
    const timer = window.setInterval(checkTick, 1000);
    return () => window.clearInterval(timer);
  }, [active, activeFlow, cacheKey]);

  const handleFlowCompleted = useCallback(
    async (account: GoogleAccountStatus | undefined, flow: ActiveAuthFlow) => {
      const fresh = await loadAll({ silent: true });
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
            text: t(`已连接 ${account.email}，但有 ${issueCount} 项服务尚未就绪。请按下方服务行提示逐项处理。`, `Connected ${account.email}, with ${issueCount} service(s) needing attention. Review the service rows below.`),
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

      if (fresh && !fresh.assistantUnavailable) {
        const connectedCount = fresh.accounts.filter(a => !isAccountReconnectRequired(a)).length;
        const effectiveCount = connectedCount > 0 ? connectedCount : fresh.accounts.length;
        if (shouldPromptGoogleAssistantSetup(fresh.assistant, effectiveCount)) {
          openAssistantSetupModal({
            postOAuth: true,
            accountsOverride: fresh.accounts,
            devicesOverride: fresh.devices,
            botsOverride: fresh.bots,
          });
        }
      }
    },
    [loadAll, openAssistantSetupModal, setBanner, t],
  );

  // Poll POST /api/google/flow while pending and tab active, plus immediate check on window focus / visibility
  useEffect(() => {
    if (!active || !activeFlow || activeFlow.phase !== 'pending') return;
    const gen = flowGenRef.current;
    const currentFlow = activeFlow;

    if (isPendingFlowExpired(currentFlow)) {
      clearPendingGoogleFlow(cacheKey, currentFlow.flowId);
      setActiveFlow({
        ...currentFlow,
        phase: 'failed',
        error: t('授权流程已过期，请重新开始。', 'Authorization flow expired. Please start again.'),
      });
      return;
    }

    let disposed = false;
    let inFlight = false;

    const pollOnce = async () => {
      if (disposed || inFlight || gen !== flowGenRef.current) return;
      if (isPendingFlowExpired(currentFlow)) {
        clearPendingGoogleFlow(cacheKey, currentFlow.flowId);
        setActiveFlow({
          ...currentFlow,
          phase: 'failed',
          error: t('授权流程已过期，请重新开始。', 'Authorization flow expired. Please start again.'),
        });
        return;
      }
      inFlight = true;
      try {
        const res = await api.getGoogleFlow({ flowId: currentFlow.flowId });
        if (disposed || gen !== flowGenRef.current) return;
        if (res.phase === 'pending') return;

        clearPendingGoogleFlow(cacheKey, currentFlow.flowId);
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
        if (disposed || gen !== flowGenRef.current) return;
        if (err instanceof CenterApiError && (err.status === 404 || err.status === 410)) {
          clearPendingGoogleFlow(cacheKey, currentFlow.flowId);
          setActiveFlow({
            ...currentFlow,
            phase: 'failed',
            error: t('授权流程已过期，请重新开始。', 'Authorization flow expired. Please start again.'),
          });
        }
      } finally {
        inFlight = false;
      }
    };

    void pollOnce();
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
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [active, activeFlow, api, cacheKey, handleFlowCompleted, t]);

  const handleJsonFilePick = useCallback(
    async (file: File | null | undefined) => {
      if (!file) return;
      setConfigError('');
      try {
        const text = await file.text();
        setClientFileName(file.name);
        setClientFileRaw(text);
      } catch (err) {
        setConfigError(errorMessage(err, t('读取文件失败，请重新选择 JSON 文件', 'Failed to read file. Select the JSON file again.')));
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
      setModal({ kind: 'connect', targetAccount: targetAccount ?? null });
    },
    [],
  );

  const handleSaveClientConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (configBusy) return;
    setConfigError('');

    if (configMode === 'file') {
      if (!clientFileRaw) {
        setConfigError(t('请先选择或拖入 Google Cloud 导出的 Web OAuth JSON 文件', 'Select or drop a Web OAuth JSON file exported from Google Cloud.'));
        return;
      }
      const check = validateWebClientJson(
        clientFileRaw,
        redirectInfo.isPreview ? undefined : redirectInfo.uri,
        t,
      );
      if (!check.ok) {
        setConfigError(check.error || t('JSON 文件校验未通过，请确认为 Web application 类型客户端', 'Client JSON validation failed. Ensure it is a Web application client.'));
        return;
      }
    } else {
      if (!clientIdDraft.trim() || !clientSecretDraft.trim()) {
        setConfigError(t('请填写完整的 Client ID 与 Client Secret 后保存', 'Enter both Client ID and Client Secret before saving.'));
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
      clearPendingGoogleFlow(cacheKey);
      flowGenRef.current += 1;
      setActiveFlow(null);
      setStatus(updated);
      await loadAll({ silent: true });

      const tail = maskClientId(updated?.client?.clientId);
      const hasAccounts = (updated?.accounts ?? accounts).length > 0;
      userPickedSectionRef.current = true;
      setSection('accounts');
      setBanner({
        tone: 'ok',
        text: tail
          ? t(`中心 Google 客户端已加密保存（Web Client ${tail}），Client Secret 已从界面清空。`, `Center Google client saved encrypted (Web Client ${tail}). Client Secret has been cleared.`)
          : t('中心 Google 客户端已加密保存，Client Secret 已从界面清空。', 'Center Google client saved encrypted. Client Secret has been cleared.'),
        ...(!hasAccounts
          ? {
              actionLabel: t('连接 Google 账号', 'Connect Google account'),
              onAction: () => openConnectModal(null),
            }
          : {}),
      });
    } catch (err) {
      const detail = errorMessage(err, t('中心拒绝了客户端配置', 'Center rejected client credentials'));
      setConfigError(
        t(`保存 OAuth 客户端失败：${detail}。请核对凭据和重定向 URI 后重试。`, `Failed to save OAuth client: ${detail}. Verify credentials and redirect URI, then retry.`),
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

        const flow: PendingGoogleFlow = {
          flowId: res.flowId,
          authorizationUrl: res.authorizationUrl,
          expiresAt: toIsoExpiresAt(res.expiresAt),
          phase: 'pending',
          choices: normalized,
          targetAccount,
        };
        writePendingGoogleFlow(cacheKey, flow);
        setActiveFlow(flow);
        setModal(null);
        userPickedSectionRef.current = true;
        setSection('accounts');

        void openExternalUrl(res.authorizationUrl, onOpenExternalUrl).catch(() => {
          // URL remains accessible via the Reopen Browser button and fallback link box.
        });
      } catch (err) {
        if (gen !== flowGenRef.current) return;
        const msg = errorMessage(err, t('发起 Google 授权失败，请检查 OAuth 客户端配置后重试', 'Failed to start Google authorization. Verify OAuth client settings and retry.'));
        if (modalRef.current?.kind === 'connect') {
          setConnectError(msg);
        } else {
          setBanner({ tone: 'danger', text: msg });
        }
      } finally {
        setConnectBusy(false);
      }
    },
    [api, cacheKey, onOpenExternalUrl, setBanner, t],
  );

  const handleCancelFlow = async () => {
    if (!activeFlow || cancellingFlow) return;
    const flowId = activeFlow.flowId;
    const flowSnapshot = activeFlow;
    setCancellingFlow(true);
    flowGenRef.current += 1;
    clearPendingGoogleFlow(cacheKey, flowId);
    try {
      await api.cancelGoogleFlow({ flowId });
    } catch {
      // Even if server already expired/finished, stop waiting locally and refresh status.
    } finally {
      clearPendingGoogleFlow(cacheKey, flowId);
      setCancellingFlow(false);
      setActiveFlow({
        ...flowSnapshot,
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
  const removeTargetAccount = modal?.kind === 'remove-account' ? modal.account : null;

  const affectedRulesForRemoveTarget = useMemo(() => {
    if (!removeTargetAccount) return [];
    return rules.filter(
      r =>
        r.account === removeTargetAccount.email ||
        (removeTargetAccount.id && r.account === removeTargetAccount.id),
    );
  }, [removeTargetAccount, rules]);

  const handleConfirmRemove = async () => {
    if (!removeTargetAccount || removeBusy) return;
    const email = removeTargetAccount.email;
    const requestedRevoke = removeRevoke;
    setRemoveBusy(true);
    setRemoveError('');
    try {
      const res = await api.removeGoogleAccount({
        account: email,
        revoke: requestedRevoke,
      });
      setModal(null);
      await loadAll({ silent: true });

      const revokeErr = res?.revokeError || res?.revokeWarning || null;
      if (!requestedRevoke) {
        setBanner({
          tone: 'info',
          text: t(`已从本中心移除 ${email} 的本地凭据（未向 Google 撤权）。如需断开第三方访问，请前往 Google 第三方连接页核实。`, `Removed ${email} locally from this Center (not revoked at Google). You can verify third-party access in your Google Account.`),
          linkUrl: GOOGLE_CONNECTIONS_URL,
          linkLabel: t('打开 Google 第三方连接', 'Open Google connections'),
        });
      } else if (res?.revoked === false || revokeErr) {
        setBanner({
          tone: 'warn',
          text: t(`本地凭据已删除，但向 Google 撤权失败${revokeErr ? `（${revokeErr}）` : ''}。请前往 Google 账号手动确认撤销。`, `Local credentials were removed, but revoking access at Google failed${revokeErr ? ` (${revokeErr})` : ''}. Please revoke it manually in your Google Account.`),
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
      setRemoveError(errorMessage(err, t('移除账号失败，请重试', 'Failed to remove account. Please retry.')));
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

  const openCreateRuleModal = () => {
    setRuleSource(ruleSourceFilter === 'calendar' ? 'calendar' : 'gmail');
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
    setRuleMinutesBefore(String(DEFAULT_CALENDAR_MINUTES_BEFORE));
    setRuleInstruction('');
    setRuleEnabled(true);
    setRuleFormError('');
    setModal({ kind: 'rule', editing: null });
  };

  const openEditRuleModal = (rule: GoogleRule) => {
    setRuleSource(rule.source);
    setRuleBotKey(botKey(rule.deviceId, rule.botId));
    setRuleAccount(rule.account);
    setRuleFrom(rule.from ?? '');
    setRuleSubject(rule.subjectContains ?? '');
    setRuleCalendar(rule.calendar || 'primary');
    setRuleMinutesBefore(calendarMinutesBeforeInputValue(rule.minutesBefore));
    setRuleInstruction(rule.instruction);
    setRuleEnabled(rule.enabled);
    setRuleFormError('');
    setModal({ kind: 'rule', editing: rule });
  };

  const handleSaveRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (ruleBusy || modal?.kind !== 'rule') return;
    setRuleFormError('');
    const sep = ruleBotKey.indexOf('::');
    if (sep <= 0) {
      setRuleFormError(t('请选择目标 Bot 后保存', 'Choose a target Bot before saving.'));
      return;
    }
    const deviceId = ruleBotKey.slice(0, sep);
    const botId = ruleBotKey.slice(sep + 2);
    if (!ruleAccount.trim()) {
      setRuleFormError(t('请选择要监听的 Google 账号', 'Choose a Google account to monitor.'));
      return;
    }
    if (!ruleInstruction.trim()) {
      setRuleFormError(t('请填写触发后交给 Bot 的指令', 'Enter the instruction for the Bot.'));
      return;
    }
    const minutes = parseCalendarMinutesBefore(ruleMinutesBefore);
    const editingRule = modal.editing;

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
      setModal(null);
      await loadRules(activeBots);
      setBanner({
        tone: 'ok',
        text: editingRule
          ? t('邮件与日历规则已更新', 'Trigger rule updated')
          : ruleSource === 'gmail'
            ? t('新邮件规则已保存（仅对开启后新到达的邮件生效）', 'New mail rule saved (applies only to newly arriving mail).')
            : t('会前提醒规则已保存', 'Pre-meeting rule saved'),
      });
    } catch (err) {
      const detail = errorMessage(err, t('中心未能保存规则', 'Center could not save the rule'));
      setRuleFormError(t(`保存规则失败：${detail}。请检查表单项后重试。`, `Failed to save rule: ${detail}. Check the fields and retry.`));
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
          : t('已暂停该自动规则（不影响 Bot 主动使用 Google 工具）', 'Trigger rule paused (Bots can still use Google on demand).'),
      });
    } catch (err) {
      setRulesError(errorMessage(err, t('更新规则状态失败，请重试', 'Failed to update rule status. Please retry.')));
    } finally {
      setTogglingRuleId(null);
    }
  };

  const handleConfirmDeleteRule = async () => {
    if (modal?.kind !== 'confirm-delete-rule' || deletingRule) return;
    const rule = modal.rule;
    if (!rule.id) {
      setModal(null);
      return;
    }
    setDeletingRule(true);
    setRulesError('');
    try {
      await api.removeGoogleRule({
        id: rule.id,
        deviceId: rule.deviceId,
        botId: rule.botId,
      });
      setModal(null);
      await loadRules(activeBots);
      setBanner({
        tone: 'info',
        text: t('已删除自动触发规则', 'Trigger rule deleted'),
      });
    } catch (err) {
      setModal(null);
      setRulesError(errorMessage(err, t('删除规则失败，请重试', 'Failed to delete rule. Please retry.')));
    } finally {
      setDeletingRule(false);
    }
  };

  const filteredRules = useMemo(() => {
    return rules.filter(r => {
      if (ruleSourceFilter !== 'all' && r.source !== ruleSourceFilter) return false;
      if (ruleBotFilter !== 'all' && botKey(r.deviceId, r.botId) !== ruleBotFilter) return false;
      return true;
    });
  }, [rules, ruleBotFilter, ruleSourceFilter]);

  const handleSelectAssistantMode = (nextMode: GoogleAssistantMode) => {
    setAssistantMode(nextMode);
    setAssistantFormError('');
    if (!assistantDigestDirty) {
      setAssistantDigestTimes(formatDigestTimesInput(defaultDigestTimesForMode(nextMode)));
    }
    if (!assistantHindsightDirty) {
      setAssistantHindsight(nextMode === 'dedicated');
    }
    if (nextMode === 'dedicated' && !assistantDeviceId && devices.length > 0) {
      setAssistantDeviceId(pickDefaultAssistantDeviceId(devices));
    }
    if (nextMode === 'existing' && !assistantTargetBotKey) {
      const fallbackBot = pickDefaultExistingAssistantBot(bots, devices);
      if (fallbackBot) {
        setAssistantTargetBotKey(botKey(fallbackBot.deviceId, fallbackBot.botId));
      }
    }
  };

  const toggleAssistantAccount = (email: string) => {
    setAssistantAccounts(prev => {
      if (prev.includes(email)) {
        return prev.filter(item => item !== email);
      }
      return [...prev, email];
    });
  };

  const handleSubmitAssistant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (assistantBusy || modal?.kind !== 'assistant-setup') return;
    setAssistantFormError('');

    const isEditingExistingDedicated =
      Boolean(modal.isEdit) &&
      assistantMode === 'dedicated' &&
      assistant?.mode === 'dedicated' &&
      assistantDedicatedAction === 'keep';

    let resolvedDeviceId = assistantDeviceId;
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
    } else if (isEditingExistingDedicated && assistant) {
      resolvedDeviceId = assistant.deviceId;
      resolvedBotId = assistant.botId;
    }

    const built = buildGoogleAssistantSetupPayload(
      {
        mode: assistantMode,
        deviceId: resolvedDeviceId,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
        ...(assistantMode === 'dedicated' && !isEditingExistingDedicated
          ? {
              role: assistantBotName,
              ...(assistantModelRef ? { modelRef: assistantModelRef } : {}),
            }
          : {}),
        accounts: assistantAccounts,
        batchWindowMinutes: assistantBatchWindow,
        digestTimesInput: assistantDigestTimes,
        calendarEnabled: assistantCalendarEnabled,
        calendarLeadMinutes: assistantCalendarLead,
        hindsightPrivateMemory: assistantHindsight,
      },
      t,
    );

    if (!built.ok) {
      setAssistantFormError(built.error);
      return;
    }

    setAssistantBusy(true);
    try {
      const payload = built.payload;
      const useSaveInPlace =
        Boolean(modal.isEdit) &&
        Boolean(assistant) &&
        (isEditingExistingDedicated || (payload.mode === 'existing' && assistant?.mode === 'existing'));

      if (useSaveInPlace && assistant) {
        const res = await api.saveGoogleAssistant({
          enabled: assistant.enabled,
          deviceId: payload.deviceId,
          botId: payload.mode === 'existing' ? payload.botId : assistant.botId,
          mode: payload.mode,
          accounts: payload.accounts,
          batchWindowMinutes: payload.batchWindowMinutes,
          digestTimes: payload.digestTimes,
          calendarEnabled: payload.calendarEnabled,
          calendarLeadMinutes: payload.calendarLeadMinutes,
          hindsightPrivateMemory: payload.hindsightPrivateMemory,
          expectedRevision: assistant.revision,
        });
        setAssistant(res.assistant ?? null);
        setAssistantRuntime(res.runtime ?? null);
        setModal(null);
        await loadAll({ silent: true });
        setBanner({
          tone: 'ok',
          text: t('主动邮箱与日程管家设置已保存', 'Proactive mail & calendar assistant settings saved'),
        });
      } else {
        const res = await api.setupGoogleAssistant(payload);
        setAssistant(res.assistant ?? null);
        setAssistantRuntime(res.runtime ?? null);
        setModal(null);
        await loadAll({ silent: true });
        const createdName = res.createdBot?.role;
        setBanner({
          tone: 'ok',
          text: createdName
            ? t(`已创建专职管家 Bot「${createdName}」并启用主动邮箱与日程感知`, `Created dedicated assistant Bot "${createdName}" and enabled proactive mail & calendar monitoring`)
            : t('已启用主动邮箱与日程感知', 'Proactive mail & calendar assistant enabled'),
        });
      }
    } catch (err) {
      setAssistantFormError(
        errorMessage(
          err,
          t('保存主动管家配置失败，请检查设置后重试', 'Failed to save proactive assistant configuration. Please retry.'),
        ),
      );
    } finally {
      setAssistantBusy(false);
    }
  };

  const handleToggleAssistantEnabled = async () => {
    if (!assistant || assistantToggling) return;
    setAssistantToggling(true);
    try {
      const nextEnabled = !assistant.enabled;
      const res = await api.saveGoogleAssistant({
        enabled: nextEnabled,
        deviceId: assistant.deviceId,
        botId: assistant.botId,
        mode: assistant.mode,
        accounts: assistant.accounts,
        batchWindowMinutes: assistant.batchWindowMinutes,
        digestTimes: assistant.digestTimes,
        calendarEnabled: assistant.calendarEnabled,
        calendarLeadMinutes: assistant.calendarLeadMinutes,
        hindsightPrivateMemory: assistant.hindsightPrivateMemory,
        expectedRevision: assistant.revision,
      });
      setAssistant(res.assistant ?? null);
      setAssistantRuntime(res.runtime ?? null);
      setBanner({
        tone: 'info',
        text: nextEnabled
          ? t('已恢复主动邮箱与日程管家（仅对恢复后新到达的邮件生效）', 'Proactive assistant resumed (applies only to newly arriving mail).')
          : t('已暂停主动邮箱与日程管家（不影响 Bot 主动使用 Google 工具）', 'Proactive assistant paused (Bots can still use Google tools on demand).'),
      });
    } catch (err) {
      setBanner({
        tone: 'danger',
        text: errorMessage(
          err,
          t('更新主动管家状态失败，请重试', 'Failed to update proactive assistant status. Please retry.'),
        ),
      });
    } finally {
      setAssistantToggling(false);
    }
  };

  const handleConfirmRemoveAssistant = async () => {
    if (assistantRemoving) return;
    setAssistantRemoving(true);
    try {
      await api.removeGoogleAssistant();
      setModal(null);
      setAssistant(null);
      setAssistantRuntime(null);
      await loadAll({ silent: true });
      setBanner({
        tone: 'info',
        text: t('已移除主动邮箱与日程管家绑定（不会删除已有 Bot 或撤销 Google 账号授权）', 'Removed proactive assistant binding (existing Bots and Google accounts were kept).'),
      });
    } catch (err) {
      setModal(null);
      setBanner({
        tone: 'danger',
        text: errorMessage(
          err,
          t('移除主动管家绑定失败，请重试', 'Failed to remove proactive assistant binding. Please retry.'),
        ),
      });
    } finally {
      setAssistantRemoving(false);
    }
  };

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

  // Early states: cold initial load skeleton / unavailable / forbidden / hard load failure
  if (!hasLoaded && !loadError) {
    return (
      <div className="ca-form-stack">
        <CaCardSkeleton height={60} subbar label={t('正在加载 Google Workspace…', 'Loading Google Workspace…')} />
        <CaSectionSkeleton rows={3} headWidth={156} trailingWidth={104} />
      </div>
    );
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
  const clientTone: 'ok' | 'warn' | 'danger' | 'muted' = clientInvalid
    ? 'danger'
    : clientConfigured
      ? 'ok'
      : 'warn';

  const selectedWizardBot = activeBots.find(
    b => botKey(b.deviceId, b.botId) === wizardTargetBotKey,
  );
  const selectedWizardDevice = selectedWizardBot
    ? deviceById.get(selectedWizardBot.deviceId) ?? null
    : null;
  const canJumpToBotWizard = Boolean(onStartGoogleSetupWizard || onConfigureBot);

  const connectTargetAccount = modal?.kind === 'connect' ? modal.targetAccount : null;

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
      <CaRefreshBar active={refreshing} />

      {/* Top 3-section segmented navigation */}
      <div className="ca-toolbar">
        <CaSegmented<GoogleSection>
          value={section}
          onChange={switchSection}
          ariaLabel={t('Google Workspace 分区', 'Google Workspace sections')}
          options={[
            { value: 'accounts', label: t('账号与授权', 'Accounts') },
            { value: 'rules', label: t('邮件与日历规则', 'Rules') },
            { value: 'client', label: t('OAuth 客户端', 'OAuth Client') },
          ]}
        />

        <div className="ca-toolbar-group">
          {section === 'accounts' && clientConfigured && (
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              disabled={activeFlow?.phase === 'pending'}
              onClick={() => openConnectModal(null)}
            >
              <Plus size={13} aria-hidden="true" />
              <span>{t('连接 Google 账号', 'Connect account')}</span>
            </button>
          )}
          {section === 'rules' && !rulesUnavailable && (
            <button
              type="button"
              className="ca-btn ca-btn-primary ca-btn-sm"
              disabled={accounts.length === 0 || activeBots.length === 0}
              onClick={openCreateRuleModal}
            >
              <Plus size={13} aria-hidden="true" />
              <span>{t('新建规则', 'New rule')}</span>
            </button>
          )}
          {section === 'client' && (
            <button
              type="button"
              className="ca-btn ca-btn-sm"
              onClick={() => setModal({ kind: 'wizard' })}
            >
              <Bot size={13} aria-hidden="true" />
              <span>{t('Bot 建项向导', 'Bot Setup Wizard')}</span>
            </button>
          )}
          <button
            type="button"
            className="ca-btn ca-btn-ghost ca-btn-icon"
            disabled={refreshing}
            aria-label={t('刷新 Google 状态', 'Refresh Google status')}
            title={t('刷新', 'Refresh')}
            onClick={() => void loadAll({ silent: true })}
          >
            <RefreshCw size={15} className={refreshing ? 'ca-spin' : undefined} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* SECTION 1: Accounts & Authorization */}
      {section === 'accounts' && (
        <div className="ca-form-stack">
          {/* Compact OAuth Client Live Readiness Row */}
          <section className="ca-section" aria-label={t('OAuth 客户端状态', 'OAuth client status')}>
            <div className="ca-row">
              <div className="ca-row-main">
                <div className="ca-row-title">
                  <StatusDot tone={clientTone} />
                  <span>{t('OAuth 客户端', 'OAuth Client')}</span>
                  {clientInvalid ? (
                    <span className="ca-pill ca-pill-danger">{t('凭据无效', 'Invalid')}</span>
                  ) : clientConfigured ? (
                    <span className="ca-pill ca-pill-ok">{t('已配置', 'Configured')}</span>
                  ) : (
                    <span className="ca-pill ca-pill-warn">{t('未配置', 'Not configured')}</span>
                  )}
                  {client.projectId && (
                    <span className="ca-pill ca-pill-muted ca-mono">{client.projectId}</span>
                  )}
                </div>
                <span className="ca-row-sub">
                  {clientInvalid
                    ? client.error || t('Google 已无法识别此客户端，请更换有效凭据后重新连接账号', 'Google no longer recognizes this client. Update credentials and reconnect accounts.')
                    : clientConfigured
                      ? `${clientIdTail ? `Web Client ${clientIdTail} · ` : ''}${
                          activeBots.length > 0
                            ? t(`已连接账号默认对全部 ${activeBots.length} 个活跃 Bot 开放`, `Connected accounts are shared across all ${activeBots.length} active Bots`)
                            : t('已连接账号默认对本中心所有 Bot 开放', 'Connected accounts are shared across all Bots on this Center')
                        }`
                      : t('请先在「OAuth 客户端」页面配置中心 Web OAuth 凭据', 'Set up your Web OAuth credentials in the OAuth Client section first')}
                </span>
              </div>
              <div className="ca-row-actions">
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  onClick={() => switchSection('client')}
                >
                  <Settings2 size={13} aria-hidden="true" />
                  <span>{t('修改客户端', 'Edit client')}</span>
                </button>
              </div>
            </div>
          </section>

          {/* Active System Browser OAuth Progress */}
          {activeFlow && (
            <section className="ca-section ca-oauth-card smooth-expand-mount" aria-live="polite">
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
                      ? t('请在系统浏览器中完成登录、MFA 验证与权限同意，完成后本页会自动刷新。', 'Complete Google sign-in, MFA, and consent in your system browser. This page refreshes automatically.')
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
                        <LabelStack
                          active={cancellingFlow ? t('正在取消…', 'Cancelling…') : t('取消授权', 'Cancel')}
                          labels={[t('取消授权', 'Cancel'), t('正在取消…', 'Cancelling…')]}
                        />
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
                        onClick={() => {
                          clearPendingGoogleFlow(cacheKey, activeFlow.flowId);
                          setActiveFlow(null);
                        }}
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

          {/* Ongoing Proactive Mail & Calendar Assistant Management Card */}
          {accounts.length > 0 && !assistantUnavailable && (
            <section className="ca-section" aria-labelledby="ca-google-assistant-heading">
              {!assistant ? (
                <div className="ca-row">
                  <div className="ca-row-main">
                    <div className="ca-row-title">
                      <Mail size={14} aria-hidden="true" />
                      <span id="ca-google-assistant-heading">
                        {t('主动邮箱与日程管家', 'Proactive Mail & Calendar Assistant')}
                      </span>
                      <span className="ca-pill ca-pill-muted">{t('未开启', 'Not configured')}</span>
                    </div>
                    <span className="ca-row-sub">
                      {t('自动按批次聚合新邮件与会前日程提醒；可创建独立专职管家 Bot 或交给已有 Bot，后台仅读信与草拟回复、绝不自动外发。', 'Batch new mail and pre-meeting reminders automatically with a dedicated assistant Bot or an existing Bot. Background runs are strictly read & draft only.')}
                    </span>
                  </div>
                  <div className="ca-row-actions">
                    <button
                      type="button"
                      className="ca-btn ca-btn-primary ca-btn-sm"
                      onClick={() => openAssistantSetupModal()}
                    >
                      <Bot size={13} aria-hidden="true" />
                      <span>{t('配置主动邮箱与日程管家', 'Set up proactive assistant')}</span>
                    </button>
                  </div>
                </div>
              ) : (() => {
                const badge = assistantRuntimeBadgeMeta(assistant, assistantRuntime, t);
                const pendingTotal =
                  (assistantRuntime?.pendingBucketCount ?? 0) +
                  (assistantRuntime?.pendingDeliveryCount ?? 0);
                const runtimeNotice = assistantRuntime?.detail || assistantRuntime?.reason || '';
                const showRuntimeAlert =
                  Boolean(runtimeNotice) && (badge.tone === 'warn' || badge.tone === 'danger');

                return (
                  <>
                    <div className="ca-row">
                      <div className="ca-row-main">
                        <div className="ca-row-title">
                          <StatusDot tone={badge.tone} />
                          <Mail size={14} aria-hidden="true" />
                          <span id="ca-google-assistant-heading">
                            {t('主动邮箱与日程管家', 'Proactive Mail & Calendar Assistant')}
                          </span>
                          <span className="ca-pill ca-pill-info">
                            {assistant.mode === 'dedicated'
                              ? t('独立管家', 'Dedicated Bot')
                              : t('已有 Bot', 'Existing Bot')}
                          </span>
                          <span className={`ca-pill ca-pill-${badge.tone}`}>{badge.label}</span>
                        </div>
                        <span className="ca-row-sub">
                          {t('绑定目标：', 'Bound Bot: ')}
                          {formatBotDisplay(assistant.deviceId, assistant.botId)}
                        </span>
                      </div>

                      <div className="ca-row-actions ca-wrap">
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          disabled={assistantToggling}
                          onClick={() => void handleToggleAssistantEnabled()}
                        >
                          <LabelStack
                            active={
                              assistantToggling
                                ? t('更新中…', 'Updating…')
                                : assistant.enabled
                                  ? t('暂停', 'Pause')
                                  : t('恢复', 'Resume')
                            }
                            labels={[t('暂停', 'Pause'), t('恢复', 'Resume'), t('更新中…', 'Updating…')]}
                          />
                        </button>
                        <button
                          type="button"
                          className="ca-btn ca-btn-sm"
                          onClick={() => openAssistantSetupModal({ editing: assistant })}
                        >
                          <Settings2 size={13} aria-hidden="true" />
                          <span>{t('切换 Bot / 编辑设置', 'Switch Bot / Edit')}</span>
                        </button>
                        <button
                          type="button"
                          className="ca-btn ca-btn-ghost ca-btn-sm"
                          onClick={() => setModal({ kind: 'confirm-remove-assistant' })}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                          <span>{t('移除绑定', 'Remove')}</span>
                        </button>
                      </div>
                    </div>

                    <div className="ca-google-assistant-meta">
                      <div className="ca-google-assistant-meta-item">
                        <span className="ca-google-assistant-meta-label">
                          {t('监听账号', 'Watched accounts')}
                        </span>
                        <span className="ca-google-assistant-meta-value">
                          {assistant.accounts.length > 0
                            ? assistant.accounts.join(', ')
                            : t('未指定', 'None')}
                        </span>
                      </div>
                      <div className="ca-google-assistant-meta-item">
                        <span className="ca-google-assistant-meta-label">
                          {t('批次与简报节奏', 'Batch & digest schedule')}
                        </span>
                        <span className="ca-google-assistant-meta-value">
                          {t(`每 ${assistant.batchWindowMinutes} 分钟聚合`, `Batch every ${assistant.batchWindowMinutes}m`)}
                          {assistant.digestTimes.length > 0
                            ? t(` · 简报 ${assistant.digestTimes.join('、')}`, ` · Digests ${assistant.digestTimes.join(', ')}`)
                            : t(' · 仅实时批次', ' · Batch only')}
                        </span>
                      </div>
                      <div className="ca-google-assistant-meta-item">
                        <span className="ca-google-assistant-meta-label">
                          {t('日程与私人记忆', 'Calendar & private memory')}
                        </span>
                        <span className="ca-google-assistant-meta-value">
                          {assistant.calendarEnabled
                            ? formatCalendarMinutesBefore(assistant.calendarLeadMinutes, t)
                            : t('日程提醒已关', 'Calendar reminders off')}
                          {' · '}
                          {assistant.hindsightPrivateMemory
                            ? t('Hindsight 私人记忆已开', 'Hindsight private memory on')
                            : t('Hindsight 私人记忆已关', 'Hindsight private memory off')}
                        </span>
                      </div>
                    </div>

                    {assistantRuntime && (
                      <div className="ca-google-assistant-runtime">
                        <span className="ca-num">
                          <Bell size={12} aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: 4 }} />
                          {t(`待推送批次 ${pendingTotal}`, `Pending ${pendingTotal}`)}
                          {assistantRuntime.missedCount > 0
                            ? t(` · 错过 ${assistantRuntime.missedCount}`, ` · Missed ${assistantRuntime.missedCount}`)
                            : ''}
                        </span>
                        {assistantRuntime.lastCheckedAt && (
                          <span>
                            <Clock size={12} aria-hidden="true" style={{ verticalAlign: '-1px', marginRight: 4 }} />
                            {t('上次检查 ', 'Last checked ')}
                            {formatTime(assistantRuntime.lastCheckedAt, locale)}
                          </span>
                        )}
                      </div>
                    )}

                    {showRuntimeAlert && (
                      <div className="ca-section-body" style={{ paddingTop: 0 }}>
                        <div
                          className={`ca-google-account-alert ${badge.tone === 'danger' ? 'is-danger' : 'is-warn'}`}
                          role="status"
                        >
                          <AlertCircle size={14} aria-hidden="true" />
                          <span>{runtimeNotice}</span>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </section>
          )}

          {/* Connected Google Accounts */}
          <section className="ca-section" aria-labelledby="ca-google-accounts-heading">
            <div className="ca-section-head">
              <div>
                <h3 id="ca-google-accounts-heading" className="ca-section-title">
                  {t('已连接账号与 Bot 共享授权', 'Connected Accounts & Bot Access')}
                  {accounts.length > 0 ? ` (${accounts.length})` : ''}
                </h3>
                <div className="ca-muted" style={{ marginTop: 2 }}>
                  {accounts.length <= 1
                    ? t('所有已连接账号自动共享给本中心全部 Bot，无需逐个 Bot 开关。', 'Connected accounts are shared with every Bot on this Center automatically.')
                    : t(`当前 ${accounts.length} 个共享账号，所有 Bot 均可使用；任务未指定账号时 Bot 会先向你确认。`, `${accounts.length} shared accounts available to all Bots; when unspecified, Bots ask which account to use.`)}
                </div>
              </div>
              {clientConfigured && accounts.length > 0 && (
                <button
                  type="button"
                  className="ca-btn ca-btn-sm"
                  disabled={activeFlow?.phase === 'pending'}
                  onClick={() => openConnectModal(null)}
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>{t('添加账号', 'Add account')}</span>
                </button>
              )}
            </div>

            {accounts.length === 0 ? (
              <div className="ca-empty">
                {clientConfigured ? (
                  <div className="ca-google-empty-stack">
                    <p style={{ margin: 0 }}>
                      {t('尚未连接 Google 账号。在系统浏览器完成登录后，本中心所有 Bot 立即可使用已就绪服务。', 'No Google account connected yet. Sign in via your system browser to enable Google services for all Bots.')}
                    </p>
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
                ) : (
                  <div className="ca-google-empty-stack">
                    <p style={{ margin: 0 }}>
                      {t('请先配置中心 OAuth 客户端，再连接 Google 账号。', 'Configure the Center OAuth client before connecting a Google account.')}
                    </p>
                    <div className="ca-inline-row ca-wrap" style={{ justifyContent: 'center' }}>
                      <button
                        type="button"
                        className="ca-btn ca-btn-primary ca-btn-sm"
                        onClick={() => switchSection('client')}
                      >
                        {t('配置 OAuth 客户端', 'Configure OAuth Client')}
                      </button>
                      <button
                        type="button"
                        className="ca-btn ca-btn-sm"
                        onClick={() => setModal({ kind: 'wizard' })}
                      >
                        {t('通过 Bot 向导创建', 'Guided setup via Bot')}
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

                  const accountTone: 'ok' | 'warn' | 'danger' = needsReconnect
                    ? 'danger'
                    : transientErr || activeProblems.length > 0
                      ? 'warn'
                      : 'ok';

                  return (
                    <div key={account.id || account.email} className="ca-google-account">
                      <div className="ca-google-account-head">
                        <div className="ca-row-main">
                          <div className="ca-row-title">
                            <StatusDot tone={accountTone} />
                            <span>{account.email}</span>
                            {needsReconnect ? (
                              <span className="ca-pill ca-pill-danger">{t('需重连', 'Reconnect required')}</span>
                            ) : transientErr ? (
                              <span className="ca-pill ca-pill-warn">{t('暂时不可达', 'Temporarily unreachable')}</span>
                            ) : activeProblems.length > 0 ? (
                              <span className="ca-pill ca-pill-warn">
                                {t(`${activeProblems.length} 项待处理`, `${activeProblems.length} to fix`)}
                              </span>
                            ) : (
                              <span className="ca-pill ca-pill-ok">{t('已就绪', 'Ready')}</span>
                            )}
                          </div>
                          <span className="ca-row-sub">
                            {activeBots.length > 0
                              ? t(`已授权全部 ${activeBots.length} 个 Bot`, `Granted to all ${activeBots.length} Bots`)
                              : t('所有 Bot 共用', 'Shared by all Bots')}
                            {accountRuleCount > 0
                              ? t(` · ${accountRuleCount} 条规则`, ` · ${accountRuleCount} rule(s)`)
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
                              <RefreshCw size={13} className={checking ? 'ca-spin' : undefined} aria-hidden="true" />
                              <LabelStack
                                active={checking ? t('检查中…', 'Checking…') : t('重试检查', 'Retry check')}
                                labels={[t('重试检查', 'Retry check'), t('检查中…', 'Checking…')]}
                              />
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
                                <RefreshCw size={13} className={checking ? 'ca-spin' : undefined} aria-hidden="true" />
                                <LabelStack
                                  active={checking ? t('检查中…', 'Checking…') : t('检查状态', 'Check')}
                                  labels={[t('检查状态', 'Check'), t('检查中…', 'Checking…')]}
                                />
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
                                label: t('移除账号…', 'Remove account…'),
                                danger: true,
                                onSelect: () => {
                                  setRemoveRevoke(true);
                                  setRemoveError('');
                                  setModal({ kind: 'remove-account', account });
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
                              t('Google 授权已失效或被撤销，依赖此账号的自动规则已暂停。请点击「重新连接」完成授权。', 'Google authorization expired or was revoked. Dependent rules are paused. Click Reconnect to restore access.')}
                          </span>
                        </div>
                      )}

                      {!needsReconnect && transientErr && (
                        <div className="ca-google-account-alert is-warn" role="status">
                          <AlertCircle size={14} aria-hidden="true" />
                          <span>{transientErr}</span>
                        </div>
                      )}

                      {/* Per-service readiness rows with readiness dots */}
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
                                    <StatusDot tone={badge.tone} />
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
                                        {t('补充授权', 'Grant permission')}
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
                                      <LabelStack
                                        active={
                                          copiedKey === copyId
                                            ? t('已复制', 'Copied')
                                            : t('复制给管理员', 'Copy for admin')
                                        }
                                        labels={[t('复制给管理员', 'Copy for admin'), t('已复制', 'Copied')]}
                                      />
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
        </div>
      )}

      {/* SECTION 2: Mail & Calendar Trigger Rules */}
      {section === 'rules' && (
        <div className="ca-form-stack">
          {accounts.length > 0 && !assistantUnavailable && (
            <section className="ca-section" aria-label={t('主动邮箱与日程管家快捷入口', 'Proactive assistant shortcut')}>
              <div className="ca-row">
                <div className="ca-row-main">
                  <div className="ca-row-title">
                    <Mail size={14} aria-hidden="true" />
                    <span>{t('主动邮箱与日程管家', 'Proactive Mail & Calendar Assistant')}</span>
                    {assistant ? (
                      <>
                        <span className="ca-pill ca-pill-info">
                          {assistant.mode === 'dedicated'
                            ? t('独立管家', 'Dedicated Bot')
                            : t('已有 Bot', 'Existing Bot')}
                        </span>
                        <span
                          className={`ca-pill ca-pill-${assistantRuntimeBadgeMeta(assistant, assistantRuntime, t).tone}`}
                        >
                          {assistantRuntimeBadgeMeta(assistant, assistantRuntime, t).label}
                        </span>
                      </>
                    ) : (
                      <span className="ca-pill ca-pill-muted">{t('未开启', 'Not configured')}</span>
                    )}
                  </div>
                  <span className="ca-row-sub">
                    {assistant
                      ? `${formatBotDisplay(assistant.deviceId, assistant.botId)} · ${t(`每 ${assistant.batchWindowMinutes} 分钟聚合`, `Batch every ${assistant.batchWindowMinutes}m`)}${assistant.digestTimes.length > 0 ? ` · ${assistant.digestTimes.join(', ')}` : ''}`
                      : t('不想手动逐条配置过滤规则？开启主动管家即可按批次自动归纳新邮件与会前日程。', 'Want automatic mail batching and pre-meeting summaries without managing individual filter rules? Enable the proactive assistant.')}
                  </span>
                </div>
                <div className="ca-row-actions">
                  <button
                    type="button"
                    className={`ca-btn ca-btn-sm${assistant ? '' : ' ca-btn-primary'}`}
                    onClick={() => openAssistantSetupModal(assistant ? { editing: assistant } : undefined)}
                  >
                    <Settings2 size={13} aria-hidden="true" />
                    <span>
                      {assistant
                        ? t('管理主动管家', 'Manage assistant')
                        : t('开启主动管家', 'Set up assistant')}
                    </span>
                  </button>
                </div>
              </div>
            </section>
          )}

          <section className="ca-section" aria-labelledby="ca-google-rules-heading">
          <div className="ca-section-head">
            <div>
              <h3 id="ca-google-rules-heading" className="ca-section-title">
                {t('邮件与日历规则', 'Mail & Calendar Rules')}
                {!rulesUnavailable && rules.length > 0 ? ` (${filteredRules.length})` : ''}
              </h3>
              <div className="ca-muted" style={{ marginTop: 2 }}>
                {t('配置由中心主动推送给指定 Bot 的新邮件与会前提醒；暂停规则不会撤销账号授权。', 'Configure proactive new-mail and pre-meeting triggers delivered to a chosen Bot; pausing a rule never revokes Google access.')}
              </div>
            </div>

            {!rulesUnavailable && (
              <div className="ca-toolbar-group">
                {rules.length > 0 && (
                  <CaChips<RuleSourceFilter>
                    value={ruleSourceFilter}
                    ariaLabel={t('按规则类型筛选', 'Filter rules by type')}
                    options={[
                      { value: 'all', label: t('全部', 'All') },
                      { value: 'gmail', label: t('新邮件', 'Mail') },
                      { value: 'calendar', label: t('会前提醒', 'Calendar') },
                    ]}
                    onChange={setRuleSourceFilter}
                  />
                )}
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
              </div>
            )}
          </div>

          {rulesUnavailable ? (
            <div className="ca-empty">
              {t('当前中心尚未启用 Google 自动触发规则接口（/api/google/rules 不可用）。主动使用 Google 工具不受影响。', 'Google automatic trigger rules (/api/google/rules) are not enabled on this Center yet. On-demand Google tools are unaffected.')}
            </div>
          ) : filteredRules.length === 0 ? (
            <div className="ca-empty">
              <div className="ca-google-empty-stack">
                <p style={{ margin: 0 }}>
                  {accounts.length === 0
                    ? t('请先连接至少一个 Google 账号，再为指定 Bot 创建邮件或日历触发规则。', 'Connect a Google account first to create mail or calendar trigger rules for your Bots.')
                    : activeBots.length === 0
                      ? t('暂无可用 Bot。在任一主机创建 Bot 后即可配置自动触发规则。', 'No active Bots yet. Create a Bot on any host to assign trigger rules.')
                      : rules.length > 0
                        ? t('当前筛选条件下没有匹配的规则。', 'No rules match the current filter.')
                        : t('暂无邮件或日历自动触发规则。所有 Bot 仍可在对话中随时主动使用 Google 工具。', 'No automatic trigger rules yet. All Bots can still use Google tools on demand in chat.')}
                </p>
                {accounts.length === 0 ? (
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    onClick={() => switchSection(clientConfigured ? 'accounts' : 'client')}
                  >
                    {clientConfigured ? t('前往连接账号', 'Go to Accounts') : t('先配置 OAuth 客户端', 'Configure OAuth Client')}
                  </button>
                ) : activeBots.length > 0 && rules.length === 0 ? (
                  <button
                    type="button"
                    className="ca-btn ca-btn-primary ca-btn-sm"
                    onClick={openCreateRuleModal}
                  >
                    <Plus size={13} aria-hidden="true" />
                    <span>{t('新建第一条规则', 'Create first rule')}</span>
                  </button>
                ) : null}
              </div>
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
                        .join(' · ') || t('全部新到达邮件', 'All newly arriving mail')
                    : parseCalendarMinutesBefore(rule.minutesBefore) === 0
                      ? t(`日历：${rule.calendar || 'primary'} · 开始时（0 分钟）`, `Calendar: ${rule.calendar || 'primary'} · At start (0m)`)
                      : t(`日历：${rule.calendar || 'primary'} · 提前 ${parseCalendarMinutesBefore(rule.minutesBefore)} 分钟`, `Calendar: ${rule.calendar || 'primary'} · ${parseCalendarMinutesBefore(rule.minutesBefore)}m before`);

                return (
                  <div key={idKey} className="ca-row">
                    <div className="ca-row-main">
                      <div className="ca-row-title">
                        <StatusDot tone={eff.tone} />
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
                        onClick={() => openEditRuleModal(rule)}
                      >
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      {rule.id && (
                        <button
                          type="button"
                          className="ca-btn ca-btn-ghost ca-btn-icon"
                          aria-label={t('删除规则', 'Delete rule')}
                          title={t('删除', 'Delete')}
                          onClick={() => setModal({ kind: 'confirm-delete-rule', rule })}
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
        </div>
      )}

      {/* SECTION 3: OAuth Client Setup & Rotation (in-page, no drawer) */}
      {section === 'client' && (
        <div className="ca-form-stack">
          <section className="ca-section" aria-labelledby="ca-google-client-heading">
            <div className="ca-default-card ca-wrap">
              <div className="ca-row-main">
                <div className="ca-row-title">
                  <StatusDot tone={clientTone} />
                  <span id="ca-google-client-heading">
                    {t('中心 Google Web OAuth 客户端', 'Center Google Web OAuth Client')}
                  </span>
                  {clientInvalid ? (
                    <span className="ca-pill ca-pill-danger">{t('凭据无效', 'Invalid client')}</span>
                  ) : clientConfigured ? (
                    <span className="ca-pill ca-pill-ok">
                      {clientIdTail
                        ? t(`已配置 · ${clientIdTail}`, `Configured · ${clientIdTail}`)
                        : t('已配置', 'Configured')}
                    </span>
                  ) : (
                    <span className="ca-pill ca-pill-warn">{t('未配置', 'Not configured')}</span>
                  )}
                  {client.projectId && (
                    <span className="ca-pill ca-pill-muted ca-mono">{client.projectId}</span>
                  )}
                </div>
                <span className="ca-row-sub">
                  {t('凭据直传中心加密存储，保存后立即从界面清空，永不回显也不进入聊天记录。', 'Credentials are stored encrypted in Center and cleared immediately after save; Client Secret is never shown or sent through chat.')}
                </span>
              </div>
              {clientConfigured && (
                <div className="ca-row-actions">
                  <button
                    type="button"
                    className="ca-btn ca-btn-sm"
                    onClick={() => switchSection('accounts')}
                  >
                    {t('查看已连接账号', 'View accounts')}
                  </button>
                </div>
              )}
            </div>

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
                    t('Google 已无法识别当前 Web OAuth 应用。请上传或录入有效凭据后重新连接账号。', 'Google no longer recognizes this Web OAuth client. Save valid credentials and reconnect accounts.')}
                </p>
              )}
            </div>
          </section>

          <section className="ca-section">
            <div className="ca-section-head">
              <h3 className="ca-section-title">
                {clientConfigured
                  ? t('更换 OAuth 客户端凭据', 'Rotate OAuth Client Credentials')
                  : t('录入 OAuth 客户端凭据', 'Save OAuth Client Credentials')}
              </h3>
              <CaSegmented<'file' | 'manual'>
                value={configMode}
                onChange={next => {
                  setConfigMode(next);
                  clearSecretDrafts();
                }}
                ariaLabel={t('凭据录入方式', 'Credential entry method')}
                options={[
                  { value: 'file', label: t('上传 JSON 文件', 'Upload JSON') },
                  { value: 'manual', label: t('手动输入', 'Manual ID & Secret') },
                ]}
              />
            </div>

            <form className="ca-section-body ca-form-stack" onSubmit={e => void handleSaveClientConfig(e)}>
              {clientConfigured && (
                <CaNotice tone="warn">
                  {t('更换为新的 Google OAuth 客户端后，现有已连接账号可能需要重新连接以签发新令牌。', 'Switching to a different Google OAuth client may require existing accounts to reconnect.')}
                </CaNotice>
              )}

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
                          {t(`本地预检通过 · Web Client ${clientJsonValidation.clientIdTail ?? ''}${clientJsonValidation.projectId ? ` · 项目 ${clientJsonValidation.projectId}` : ''}`, `Pre-check passed · Web Client ${clientJsonValidation.clientIdTail ?? ''}${clientJsonValidation.projectId ? ` · Project ${clientJsonValidation.projectId}` : ''}`)}
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
                      disabled={configBusy}
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
                      disabled={configBusy}
                      placeholder="GOCSPX-..."
                      value={clientSecretDraft}
                      onChange={e => setClientSecretDraft(e.target.value)}
                    />
                  </div>
                </>
              )}

              <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
                {configError ? (
                  <p className="ca-error-text" role="alert">
                    {configError}
                  </p>
                ) : null}
              </ReservedSlot>

              <div className="ca-form-actions ca-form-actions-between">
                <button
                  type="button"
                  className="ca-btn ca-btn-ghost ca-btn-sm"
                  disabled={configBusy}
                  onClick={() => setModal({ kind: 'wizard' })}
                >
                  <Bot size={13} aria-hidden="true" />
                  <span>{t('改用 Bot 建项向导', 'Use Bot setup wizard')}</span>
                </button>
                <button
                  type="submit"
                  className="ca-btn ca-btn-primary"
                  aria-busy={configBusy}
                  disabled={
                    configBusy ||
                    (configMode === 'file'
                      ? !clientFileRaw || !clientJsonValidation?.ok
                      : !clientIdDraft.trim() || !clientSecretDraft.trim())
                  }
                >
                  <LabelStack
                    active={configBusy ? t('保存中…', 'Saving…') : t('加密保存凭据', 'Save credentials')}
                    labels={[t('加密保存凭据', 'Save credentials'), t('保存中…', 'Saving…')]}
                  />
                </button>
              </div>
            </form>
          </section>

          {/* Collapsible Manual Setup Guide */}
          <CaCardDisclosure
            title={t('手动创建 Google Web OAuth 客户端指南', 'Manual Web OAuth setup guide')}
            subtitle={t('展开查看在 Google Cloud Console 创建项目、启用 API 与导出 JSON 的 5 个步骤', 'Expand for 5 steps to create a Google Cloud project, enable APIs, and export JSON')}
          >
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
                  {t('配置 Google Auth Platform（填入应用名、联系邮箱、自托管中心域名，选择受众 External 或 Workspace Internal，并勾选用户数据政策）：', 'Configure Google Auth Platform (your app name, email, Center domain, External or Workspace Internal audience, and User Data Policy): ')}
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
                  {t('创建 OAuth 客户端，应用类型选择 Web application，并将上方「已授权的重定向 URI」添加到 Authorized redirect URIs：', 'Create a Web application OAuth client and add the Authorized redirect URI shown above to Authorized redirect URIs: ')}
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
                {t('下载 JSON 上传到上方，或直接粘贴 Client ID 与 Client Secret 加密保存。', 'Download the JSON and upload it above, or paste Client ID and Client Secret directly.')}
              </li>
            </ol>
          </CaCardDisclosure>
        </div>
      )}

      {/* Mutually Exclusive Modal 1: Bot Setup Wizard */}
      <CaModal
        open={modal?.kind === 'wizard'}
        onOpenChange={open => {
          if (!open) setModal(null);
        }}
        title={t('通过目标 Bot 启动建项向导', 'Guided Google App Setup via Bot')}
        description={t('选择主机上的 Bot 启动三模式建项向导（自动代办 / 内嵌指导 / 外部浏览器指导）。', 'Launch the 3-mode setup wizard on a target Bot (Do it for me / Guide me here / Guide me in my browser).')}
        variant="drawer"
      >
        <div className="ca-form-stack">
          <CaNotice tone="info">
            {t('Google 登录、条款确认与创建 Client Secret 始终由本人完成，凭据直传中心加密存储，不进入聊天记录。', 'Google sign-in, policy agreement, and Client Secret creation always require you directly. Credentials are submitted privately to Center, never via chat.')}
          </CaNotice>

          {activeBots.length === 0 ? (
            <div className="ca-empty-hint">
              {t('当前中心暂无可用 Bot。你可以直接返回「OAuth 客户端」手动录入凭据，或先在桌面端/手机端创建 Bot。', 'No active Bots on this Center yet. Enter Web OAuth credentials manually in OAuth Client, or create a Bot in the PiBot app first.')}
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
                  {t('Android 本机 Host 默认推荐「外部浏览器指导」。如需内嵌浏览器协助，请选择在线桌面主机上的 Bot。', 'Android local hosts default to "Guide me in my browser". Pick an online desktop host Bot for embedded browser assistance.')}
                </p>
              )}

              {selectedWizardDevice && !selectedWizardDevice.online && (
                <p className="ca-field-help">
                  {t('所选设备当前离线。设备上线后可在该 Bot 启动向导，或现在直接切换手动录入。', 'The selected device is currently offline. Bring it online to run the wizard, or enter credentials manually now.')}
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
                {t(`在桌面端或手机端打开「${formatBotDisplay(selectedWizardBot.deviceId, selectedWizardBot.botId)}」，发送“帮我配置 Google 应用”启动向导，完成后将 Web OAuth JSON 回到此处上传即可。`, `Open "${formatBotDisplay(selectedWizardBot.deviceId, selectedWizardBot.botId)}" in the PiBot desktop or mobile app to run the browser setup wizard, then upload the Web OAuth JSON here.`)}
              </p>
              <CopyButton value={redirectInfo.uri} label={t('复制回调 URI', 'Copy redirect URI')} />
            </div>
          )}

          <div className="ca-form-actions ca-form-actions-between">
            <button
              type="button"
              className="ca-btn"
              onClick={() => {
                setModal(null);
                switchSection('client');
              }}
            >
              {t('切到手动录入', 'Manual entry')}
            </button>

            <div className="ca-inline-row">
              <button type="button" className="ca-btn ca-btn-ghost" onClick={() => setModal(null)}>
                {t('关闭', 'Close')}
              </button>
              {selectedWizardBot && canJumpToBotWizard && (
                <button
                  type="button"
                  className="ca-btn ca-btn-primary"
                  onClick={() => {
                    setModal(null);
                    if (onStartGoogleSetupWizard) {
                      onStartGoogleSetupWizard(selectedWizardBot.deviceId, selectedWizardBot.botId);
                    } else if (onConfigureBot) {
                      onConfigureBot(selectedWizardBot.deviceId, selectedWizardBot.botId);
                    }
                  }}
                >
                  <Bot size={14} aria-hidden="true" />
                  <span>{onStartGoogleSetupWizard ? t('打开 Bot 向导', 'Open Bot wizard') : t('打开目标 Bot', 'Open target Bot')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </CaModal>

      {/* Mutually Exclusive Modal 2: Connect / Add Services (System Browser OAuth) */}
      <CaModal
        open={modal?.kind === 'connect'}
        onOpenChange={open => {
          if (!open && !connectBusy) {
            setConnectError('');
            setModal(null);
          }
        }}
        title={
          connectTargetAccount
            ? t(`管理服务授权 · ${connectTargetAccount.email}`, `Manage services · ${connectTargetAccount.email}`)
            : t('选择要连接的 Google 服务', 'Choose Google services to connect')
        }
        description={t('将在系统浏览器中完成本人登录、MFA 与权限同意。', 'You will sign in and grant consent in your system browser.')}
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
                  disabled={alreadyGranted || connectBusy}
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
              {t('基础附带：账号识别与联系人联查（People API，用于按姓名查找联系人与目录）。', 'Always included: account identity and contact name lookup (People API).')}
            </span>
          </div>

          <CaNotice tone="info">
            {t('连接后，本中心所有现有和未来 Bot 都能以你的身份访问所选服务。', 'Once connected, all current and future Bots on this Center can use the approved services as you.')}
          </CaNotice>

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {connectError ? (
              <p className="ca-error-text" role="alert">
                {connectError}
              </p>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions">
            <button
              type="button"
              className="ca-btn"
              disabled={connectBusy}
              onClick={() => setModal(null)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="button"
              className="ca-btn ca-btn-primary"
              aria-busy={connectBusy}
              disabled={connectBusy || selectedChoices.length === 0}
              onClick={() => {
                const unionChoices = connectTargetAccount
                  ? mergeChoices(connectTargetAccount.choices ?? [], selectedChoices)
                  : selectedChoices;
                void startAuthorize(unionChoices, connectTargetAccount?.email);
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <LabelStack
                active={
                  connectBusy
                    ? t('正在发起授权…', 'Starting sign-in…')
                    : connectTargetAccount
                      ? t('前往 Google 补充授权', 'Authorize in Google')
                      : t('前往 Google 登录', 'Sign in to Google')
                }
                labels={[
                  connectTargetAccount
                    ? t('前往 Google 补充授权', 'Authorize in Google')
                    : t('前往 Google 登录', 'Sign in to Google'),
                  t('正在发起授权…', 'Starting sign-in…'),
                ]}
              />
            </button>
          </div>
        </div>
      </CaModal>

      {/* Mutually Exclusive Modal 3: Remove Account Confirmation */}
      <CaModal
        open={modal?.kind === 'remove-account'}
        onOpenChange={open => {
          if (!open && !removeBusy) {
            setRemoveError('');
            setModal(null);
          }
        }}
        title={t('移除 Google 账号', 'Remove Google Account')}
        description={removeTargetAccount?.email}
        variant="modal"
      >
        {removeTargetAccount && (
          <div className="ca-form-stack">
            <CaNotice tone="warn">
              {t(`移除后，本中心所有 Bot 将停止访问 ${removeTargetAccount.email}；其他已连接账号不受影响。`, `All Bots on this Center will lose access to ${removeTargetAccount.email}. Other connected accounts are unaffected.`)}
            </CaNotice>

            <div className="ca-cred-box">
              <div className="ca-field-label" style={{ marginBottom: 4 }}>
                {affectedRulesForRemoveTarget.length > 0
                  ? t(`引用此账号的 ${affectedRulesForRemoveTarget.length} 条自动规则将停止：`, `${affectedRulesForRemoveTarget.length} trigger rule(s) using this account will stop:`)
                  : t('自动触发规则影响', 'Impact on trigger rules')}
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
                  disabled={removeBusy}
                  checked={removeRevoke}
                  onChange={() => setRemoveRevoke(true)}
                />
                <span>
                  <span className="ca-field-label">
                    {t('移除并向 Google 撤权（推荐）', 'Remove and revoke access at Google (recommended)')}
                  </span>
                  <span className="ca-row-sub">
                    {t('先向 Google 撤销令牌，再清除本地凭据；若撤权失败会分开提示结果。', 'Requests token revocation at Google first, then deletes local credentials; reports both outcomes separately.')}
                  </span>
                </span>
              </label>

              <label className={`ca-google-radio-card${!removeRevoke ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name="google-remove-mode"
                  disabled={removeBusy}
                  checked={!removeRevoke}
                  onChange={() => setRemoveRevoke(false)}
                />
                <span>
                  <span className="ca-field-label">
                    {t('仅从中心移除本地凭据', 'Remove from Center only')}
                  </span>
                  <span className="ca-row-sub">
                    {t('仅删除中心加密凭据，不通知 Google 撤权。可稍后在 Google 账号中手动撤权。', 'Deletes only Center credentials without calling Google revoke. You can revoke later in Google Account connections.')}
                  </span>
                </span>
              </label>
            </div>

            <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
              {removeError ? (
                <p className="ca-error-text" role="alert">
                  {removeError}
                </p>
              ) : null}
            </ReservedSlot>

            <div className="ca-form-actions">
              <button
                type="button"
                className="ca-btn"
                disabled={removeBusy}
                onClick={() => setModal(null)}
              >
                {t('取消', 'Cancel')}
              </button>
              <button
                type="button"
                className="ca-btn ca-btn-danger"
                aria-busy={removeBusy}
                disabled={removeBusy}
                onClick={() => void handleConfirmRemove()}
              >
                <LabelStack
                  active={
                    removeBusy
                      ? t('正在移除…', 'Removing…')
                      : removeRevoke
                        ? t('移除并撤权', 'Remove & revoke')
                        : t('仅移除本地凭据', 'Remove locally')
                  }
                  labels={[t('移除并撤权', 'Remove & revoke'), t('仅移除本地凭据', 'Remove locally'), t('正在移除…', 'Removing…')]}
                />
              </button>
            </div>
          </div>
        )}
      </CaModal>

      {/* Mutually Exclusive Modal 4: Create / Edit Rule */}
      <CaModal
        open={modal?.kind === 'rule'}
        onOpenChange={open => {
          if (!open && !ruleBusy) {
            setRuleFormError('');
            setModal(null);
          }
        }}
        title={
          modal?.kind === 'rule' && modal.editing
            ? t('编辑邮件与日历规则', 'Edit Trigger Rule')
            : t('新建邮件与日历规则', 'New Trigger Rule')
        }
        description={t('由中心持续检查并按规则投递给指定 Bot。', 'Checked continuously by Center and delivered to the selected Bot.')}
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
              disabled={ruleBusy}
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
              disabled={ruleBusy}
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
                    disabled={ruleBusy}
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
                    disabled={ruleBusy}
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
                  disabled={ruleBusy}
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
                  min={0}
                  max={1440}
                  step={1}
                  className="ca-input ca-num"
                  disabled={ruleBusy}
                  value={ruleMinutesBefore}
                  onChange={e => setRuleMinutesBefore(e.target.value)}
                />
                <div className="ca-chips" style={{ marginTop: 4 }}>
                  {MINUTES_BEFORE_PRESETS.map(m => (
                    <button
                      key={m}
                      type="button"
                      disabled={ruleBusy}
                      className={`ca-chip${parseCalendarMinutesBefore(ruleMinutesBefore, -1) === m ? ' is-active' : ''}`}
                      onClick={() => setRuleMinutesBefore(String(m))}
                    >
                      <CalendarClock size={11} aria-hidden="true" style={{ marginRight: 3 }} />
                      {m === 0 ? t('开始时 (0 分钟)', 'At start (0m)') : t(`${m} 分钟`, `${m}m`)}
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
              disabled={ruleBusy}
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
              disabled={ruleBusy}
              label={t('启用规则', 'Enable rule')}
              onChange={setRuleEnabled}
            />
          </div>

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {ruleFormError ? (
              <p className="ca-error-text" role="alert">
                {ruleFormError}
              </p>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions">
            <button
              type="button"
              className="ca-btn"
              disabled={ruleBusy}
              onClick={() => setModal(null)}
            >
              {t('取消', 'Cancel')}
            </button>
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={ruleBusy}
              aria-busy={ruleBusy}
            >
              <LabelStack
                active={ruleBusy ? t('保存中…', 'Saving…') : t('保存规则', 'Save rule')}
                labels={[t('保存规则', 'Save rule'), t('保存中…', 'Saving…')]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Mutually Exclusive Modal 5: Confirm Delete Rule */}
      <CaConfirmDialog
        open={modal?.kind === 'confirm-delete-rule'}
        title={t('删除自动触发规则', 'Delete Trigger Rule')}
        description={
          modal?.kind === 'confirm-delete-rule'
            ? t(`删除分配给「${formatBotDisplay(modal.rule.deviceId, modal.rule.botId)}」的规则后将停止自动推送，不影响该 Bot 主动使用 Google 工具。`, `Deleting this rule for "${formatBotDisplay(modal.rule.deviceId, modal.rule.botId)}" stops automatic notifications without affecting on-demand Google access.`)
            : ''
        }
        confirmLabel={t('删除规则', 'Delete rule')}
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={deletingRule}
        onCancel={() => {
          if (!deletingRule) setModal(null);
        }}
        onConfirm={() => void handleConfirmDeleteRule()}
      />

      {/* Mutually Exclusive Modal 6: Proactive Mail & Calendar Assistant Setup / Edit */}
      <CaModal
        open={modal?.kind === 'assistant-setup'}
        onOpenChange={open => {
          if (!open && !assistantBusy) {
            setAssistantFormError('');
            setModal(null);
          }
        }}
        title={
          modal?.kind === 'assistant-setup' && modal.isEdit
            ? t('编辑主动邮箱与日程管家', 'Edit Proactive Mail & Calendar Assistant')
            : modal?.kind === 'assistant-setup' && modal.postOAuth
              ? t('账号已连接 · 开启主动邮箱与日程感知？', 'Account Connected · Enable Proactive Assistant?')
              : t('配置主动邮箱与日程管家', 'Set Up Proactive Mail & Calendar Assistant')
        }
        description={t('选择由独立专职管家 Bot 或已有 Bot 在后台聚合新邮件与会前日程提醒；随时可在账号或规则页修改。', 'Choose a dedicated assistant Bot or an existing Bot to batch incoming mail and pre-meeting reminders. You can change or pause this anytime.')}
        variant="modal"
        wide
      >
        <form className="ca-form-stack" onSubmit={e => void handleSubmitAssistant(e)}>
          <div
            className="ca-google-assistant-options"
            role="radiogroup"
            aria-label={t('选择主动管家运行方式', 'Choose proactive assistant mode')}
          >
            <button
              type="button"
              role="radio"
              aria-checked={assistantMode === 'dedicated'}
              disabled={assistantBusy}
              className={`ca-google-assistant-option${assistantMode === 'dedicated' ? ' is-selected' : ''}`}
              onClick={() => handleSelectAssistantMode('dedicated')}
            >
              <span
                className={`ca-google-assistant-radio${assistantMode === 'dedicated' ? ' is-checked' : ''}`}
                aria-hidden="true"
              />
              <span className="ca-google-choice-text">
                <span className="ca-row-title">
                  <span>{t('选项 1：创建独立专职管家 Bot', 'Option 1: Create Dedicated Assistant Bot')}</span>
                  <span className="ca-pill ca-pill-ok">{t('推荐', 'Recommended')}</span>
                </span>
                <span className="ca-row-sub">
                  {t('独立会话与记忆，不干扰主 Bot，后台仅读信与草拟回复、绝不自动外发。', 'Isolated session and memory without crowding your main Bot; background runs read & draft replies only, never auto-send.')}
                </span>
              </span>
            </button>

            <button
              type="button"
              role="radio"
              aria-checked={assistantMode === 'existing'}
              disabled={assistantBusy}
              className={`ca-google-assistant-option${assistantMode === 'existing' ? ' is-selected' : ''}`}
              onClick={() => handleSelectAssistantMode('existing')}
            >
              <span
                className={`ca-google-assistant-radio${assistantMode === 'existing' ? ' is-checked' : ''}`}
                aria-hidden="true"
              />
              <span className="ca-google-choice-text">
                <span className="ca-row-title">
                  <span>{t('选项 2：交给已有 Bot（如主 Bot）', 'Option 2: Assign to Existing Bot (e.g. Main Bot)')}</span>
                </span>
                <span className="ca-row-sub">
                  {t('无需切换聊天；后台邮件批次禁止自动发信，普通邮件按早晚简报合并以免占满主上下文，跨 Bot Skill 共享仍保持隔离。', 'No chat switching; background mail batches cannot auto-send, routine mail merges into scheduled digests to protect main context, and cross-Bot skill isolation stays intact.')}
                </span>
              </span>
            </button>
          </div>

          {assistantMode === 'dedicated' ? (
            <div className="ca-google-assistant-subcard">
              {modal?.kind === 'assistant-setup' && modal.isEdit && assistant?.mode === 'dedicated' && (
                <div className="ca-inline-between ca-wrap" style={{ gap: 8 }}>
                  <span className="ca-field-label">
                    {t('当前专职管家 Bot：', 'Current dedicated Bot: ')}
                    {formatBotDisplay(assistant.deviceId, assistant.botId)}
                  </span>
                  <CaSegmented<'keep' | 'create'>
                    value={assistantDedicatedAction}
                    onChange={setAssistantDedicatedAction}
                    ariaLabel={t('专职管家 Bot 策略', 'Dedicated Bot action')}
                    options={[
                      { value: 'keep', label: t('保留当前 Bot', 'Keep current Bot') },
                      { value: 'create', label: t('新建替代 Bot', 'Create new Bot') },
                    ]}
                  />
                </div>
              )}

              {!(
                modal?.kind === 'assistant-setup' &&
                modal.isEdit &&
                assistant?.mode === 'dedicated' &&
                assistantDedicatedAction === 'keep'
              ) && (
                <>
                  {devices.length === 0 ? (
                    <CaNotice tone="warn">
                      {t('当前中心暂无已配对主机设备。请先在桌面端或手机端配对设备，或稍后再开启主动管家。', 'No paired host devices are available on this Center yet. Pair a device first, then configure the proactive assistant.')}
                    </CaNotice>
                  ) : (
                    <div className="ca-grid-2">
                      <div className="ca-field">
                        <label className="ca-field-label" htmlFor="ca-google-assistant-device">
                          {t('托管主机设备', 'Host device')}
                          <span className="ca-req">*</span>
                        </label>
                        <select
                          id="ca-google-assistant-device"
                          className="ca-select"
                          disabled={assistantBusy}
                          value={assistantDeviceId}
                          onChange={e => setAssistantDeviceId(e.target.value)}
                        >
                          <option value="">{t('请选择设备…', 'Select a device…')}</option>
                          {devices.map(dev => (
                            <option key={dev.deviceId} value={dev.deviceId}>
                              {dev.name || dev.deviceId} ({platformLabel(dev.platform, t)}
                              {dev.online ? t(' · 在线', ' · online') : t(' · 离线', ' · offline')})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="ca-field">
                        <label className="ca-field-label" htmlFor="ca-google-assistant-bot-name">
                          {t('专职管家 Bot 名称', 'Dedicated Bot name')}
                          <span className="ca-req">*</span>
                        </label>
                        <input
                          id="ca-google-assistant-bot-name"
                          type="text"
                          className="ca-input"
                          maxLength={64}
                          disabled={assistantBusy}
                          placeholder={t('邮件与日程管家', 'Mail & Calendar Assistant')}
                          value={assistantBotName}
                          onChange={e => setAssistantBotName(e.target.value)}
                        />
                      </div>
                    </div>
                  )}

                  <div className="ca-field">
                    <label className="ca-field-label" htmlFor="ca-google-assistant-model">
                      {t('模型选择（可选）', 'Model (optional)')}
                    </label>
                    <select
                      id="ca-google-assistant-model"
                      className="ca-select"
                      disabled={assistantBusy}
                      value={assistantModelRef}
                      onChange={e => setAssistantModelRef(e.target.value)}
                    >
                      <option value="">
                        {globalDefaultModelName
                          ? t(`使用默认模型（${globalDefaultModelName}）`, `Use default model (${globalDefaultModelName})`)
                          : t('使用默认模型', 'Use default model')}
                      </option>
                      {sortedPickerModels.map(m => (
                        <option key={m.modelRef} value={m.modelRef}>
                          {m.name} ({m.modelRef})
                        </option>
                      ))}
                    </select>
                    <p className="ca-field-help">
                      {t('推荐选择响应快、成本较低的模型处理高频邮件批次与日程摘要。', 'Recommended: pick a fast, low-cost model for frequent mail batches and calendar summaries.')}
                    </p>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="ca-google-assistant-subcard">
              {activeBots.length === 0 ? (
                <CaNotice tone="warn">
                  {t('当前中心暂无可用 Bot。你可以切换到「选项 1」直接创建独立专职管家 Bot。', 'No active Bots found on this Center. Switch to Option 1 to create a dedicated assistant Bot.')}
                </CaNotice>
              ) : (
                <div className="ca-field">
                  <label className="ca-field-label" htmlFor="ca-google-assistant-existing-bot">
                    {t('选择已有 Bot', 'Select existing Bot')}
                    <span className="ca-req">*</span>
                  </label>
                  <select
                    id="ca-google-assistant-existing-bot"
                    className="ca-select"
                    disabled={assistantBusy}
                    value={assistantTargetBotKey}
                    onChange={e => setAssistantTargetBotKey(e.target.value)}
                  >
                    <option value="">{t('请选择 Bot…', 'Select a Bot…')}</option>
                    {botsByDevice.map(([devId, group]) => {
                      const dev = group.device;
                      const devSuffix = dev
                        ? ` (${platformLabel(dev.platform, t)}${dev.online ? '' : t(' · 离线', ' · offline')})`
                        : '';
                      return (
                        <optgroup key={devId} label={`${dev?.name || devId}${devSuffix}`}>
                          {group.bots.map(b => (
                            <option key={botKey(b.deviceId, b.botId)} value={botKey(b.deviceId, b.botId)}>
                              {b.name}
                              {b.isPrimary ? t('（主 Bot）', ' (Primary)') : ''}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Watched Google Accounts multi-select */}
          <div className="ca-field">
            <span className="ca-field-label">
              {t('监听的 Google 账号', 'Monitored Google accounts')}
              <span className="ca-req">*</span>
            </span>
            <div className="ca-google-assistant-accounts" role="group" aria-label={t('选择要监听的 Google 账号', 'Choose Google accounts to monitor')}>
              {accounts.map(acc => {
                const checked = assistantAccounts.includes(acc.email);
                const needsReconnect = isAccountReconnectRequired(acc);
                return (
                  <label key={acc.id || acc.email} className="ca-check-label">
                    <input
                      type="checkbox"
                      disabled={assistantBusy}
                      checked={checked}
                      onChange={() => toggleAssistantAccount(acc.email)}
                    />
                    <span>
                      {acc.email}
                      {needsReconnect ? t('（需重连）', ' (needs reconnect)') : ''}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Batch window & Digest times */}
          <div className="ca-grid-2">
            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-google-assistant-batch">
                {t('邮件批次聚合窗口（分钟）', 'Mail batch window (minutes)')}
              </label>
              <input
                id="ca-google-assistant-batch"
                type="number"
                min={1}
                max={1440}
                step={1}
                className="ca-input ca-num"
                disabled={assistantBusy}
                value={assistantBatchWindow}
                onChange={e => setAssistantBatchWindow(e.target.value)}
              />
              <p className="ca-field-help">
                {assistantMode === 'existing'
                  ? t('高优邮件批次聚合间隔（1–1440 分钟，默认 10）', 'High-priority mail batch window (1–1440m, default 10)')
                  : t('新邮件聚合窗口（1–1440 分钟，默认 10）', 'New mail batch window (1–1440m, default 10)')}
              </p>
            </div>

            <div className="ca-field">
              <label className="ca-field-label" htmlFor="ca-google-assistant-digest">
                {t('定时简报时间（24 小时制，可选）', 'Digest times (24h HH:mm, optional)')}
              </label>
              <input
                id="ca-google-assistant-digest"
                type="text"
                className="ca-input ca-mono"
                disabled={assistantBusy}
                placeholder="09:00, 18:00"
                value={assistantDigestTimes}
                onChange={e => {
                  setAssistantDigestTimes(e.target.value);
                  setAssistantDigestDirty(true);
                }}
              />
              <p className="ca-field-help">
                {t('逗号或空格分隔，最多 6 个；留空表示仅按批次聚合。', 'Comma or space separated, up to 6 slots; leave empty for batch-only.')}
              </p>
            </div>
          </div>

          {/* Calendar pre-meeting reminder */}
          <div className="ca-google-assistant-switch-row">
            <div className="ca-google-assistant-switch-text">
              <span className="ca-field-label">{t('会前日程提醒', 'Pre-meeting calendar reminders')}</span>
              <span className="ca-row-sub">
                {t('自动在会议开始前汇总参会人与相关背景提醒你。', 'Remind you before upcoming meetings with attendee and mail context.')}
              </span>
              {assistantCalendarEnabled && (
                <div className="ca-inline-row ca-mt-2" style={{ gap: 8 }}>
                  <label className="ca-muted" htmlFor="ca-google-assistant-cal-lead">
                    {t('提前分钟数（0–1440）', 'Lead minutes (0–1440)')}
                  </label>
                  <input
                    id="ca-google-assistant-cal-lead"
                    type="number"
                    min={0}
                    max={1440}
                    step={1}
                    className="ca-input ca-input-compact ca-num"
                    style={{ width: 96 }}
                    disabled={assistantBusy}
                    value={assistantCalendarLead}
                    onChange={e => setAssistantCalendarLead(e.target.value)}
                  />
                </div>
              )}
            </div>
            <CaSwitch
              checked={assistantCalendarEnabled}
              disabled={assistantBusy}
              label={t('启用会前日程提醒', 'Enable pre-meeting calendar reminders')}
              onChange={setAssistantCalendarEnabled}
            />
          </div>

          {/* Hindsight Private Memory toggle */}
          <div className="ca-google-assistant-switch-row">
            <div className="ca-google-assistant-switch-text">
              <span className="ca-field-label">
                {assistantMode === 'dedicated'
                  ? t('允许管家使用自己的 Hindsight 私人记忆记住邮件偏好', 'Allow assistant to use its own Hindsight private memory for mail preferences')
                  : t('允许将邮件偏好写入该 Bot 的主 Hindsight 记忆库', 'Allow saving mail preferences to this Bot’s primary Hindsight memory bank')}
              </span>
              <span className="ca-row-sub">
                {assistantMode === 'dedicated'
                  ? t('仅写入该专职管家 Bot 自己的私有主库，不向其他 Bot 或共享记忆外泄。', 'Writes only to this dedicated Bot’s private primary bank; never exported to shared memory or other Bots.')
                  : t('默认关闭以保持主 Bot 长期记忆干净；如开启，仅限写入该 Bot 自己的私有主库。', 'Off by default to keep your main Bot’s memory clean; when enabled, strictly limited to its own private primary bank.')}
              </span>
            </div>
            <CaSwitch
              checked={assistantHindsight}
              disabled={assistantBusy}
              label={t('允许使用 Hindsight 私人记忆', 'Allow Hindsight private memory')}
              onChange={next => {
                setAssistantHindsight(next);
                setAssistantHindsightDirty(true);
              }}
            />
          </div>

          <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
            {assistantFormError ? (
              <p className="ca-error-text" role="alert">
                {assistantFormError}
              </p>
            ) : null}
          </ReservedSlot>

          <div className="ca-form-actions">
            <button
              type="button"
              className="ca-btn"
              disabled={assistantBusy}
              onClick={() => {
                setAssistantFormError('');
                setModal(null);
              }}
            >
              {modal?.kind === 'assistant-setup' && modal.isEdit
                ? t('取消', 'Cancel')
                : t('暂不开启', 'Not now')}
            </button>
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={assistantBusy}
              aria-busy={assistantBusy}
            >
              <LabelStack
                active={
                  assistantBusy
                    ? modal?.kind === 'assistant-setup' && modal.isEdit
                      ? t('保存中…', 'Saving…')
                      : t('正在启用…', 'Enabling…')
                    : modal?.kind === 'assistant-setup' && modal.isEdit
                      ? t('保存设置', 'Save settings')
                      : t('启用主动感知', 'Enable proactive assistant')
                }
                labels={[
                  t('启用主动感知', 'Enable proactive assistant'),
                  t('正在启用…', 'Enabling…'),
                  t('保存设置', 'Save settings'),
                  t('保存中…', 'Saving…'),
                ]}
              />
            </button>
          </div>
        </form>
      </CaModal>

      {/* Mutually Exclusive Modal 7: Confirm Remove Proactive Assistant Binding */}
      <CaConfirmDialog
        open={modal?.kind === 'confirm-remove-assistant'}
        title={t('移除主动邮箱与日程管家绑定', 'Remove Proactive Assistant Binding')}
        description={
          assistant
            ? t(`移除与「${formatBotDisplay(assistant.deviceId, assistant.botId)}」的主动管家绑定后，后台新邮件与会前聚合推送将停止；不会删除该 Bot，也不会撤销 Google 账号授权。`, `Removing the proactive assistant binding for "${formatBotDisplay(assistant.deviceId, assistant.botId)}" stops background mail and calendar batching without deleting the Bot or revoking Google access.`)
            : ''
        }
        confirmLabel={assistantRemoving ? t('正在移除…', 'Removing…') : t('移除绑定', 'Remove binding')}
        cancelLabel={t('取消', 'Cancel')}
        danger
        busy={assistantRemoving}
        onCancel={() => {
          if (!assistantRemoving) setModal(null);
        }}
        onConfirm={() => void handleConfirmRemoveAssistant()}
      />
    </div>
  );
}
