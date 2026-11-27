/**
 * Google Workspace Center Admin pure helpers.
 *
 * Service choice groups, Google API names, readiness state semantics, and
 * Workspace admin trust wording are adapted from Orca (MIT License):
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Adapted for PiBot Center's shared Web OAuth application model (HTTPS callback,
 * shared center account pool, zero per-Bot OAuth switches).
 */
import type {
  CenterBotRef,
  CenterDevice,
  GoogleAccountStatus,
  GoogleAssistantConfig,
  GoogleAssistantCreateBotInput,
  GoogleAssistantMode,
  GoogleAssistantRuntime,
  GoogleAssistantSetupRequest,
  GoogleRule,
  GoogleRulesListResponse,
  GoogleServiceChoice,
  GoogleServiceId,
  GoogleServiceReadiness,
  GoogleServiceState,
} from './types';

export type TranslateFn = (zh: string, en: string) => string;

export const GOOGLE_SERVICE_CHOICES: readonly GoogleServiceChoice[] = [
  'gmail',
  'calendar',
  'files',
] as const;

export const GOOGLE_CHOICE_SERVICES: Record<GoogleServiceChoice, readonly GoogleServiceId[]> = {
  gmail: ['gmail'],
  calendar: ['calendar'],
  files: ['drive', 'docs', 'sheets'],
};

export const GOOGLE_SERVICE_API_NAMES: Record<GoogleServiceId, string> = {
  gmail: 'gmail.googleapis.com',
  calendar: 'calendar-json.googleapis.com',
  drive: 'drive.googleapis.com',
  docs: 'docs.googleapis.com',
  sheets: 'sheets.googleapis.com',
  contacts: 'people.googleapis.com',
  people: 'people.googleapis.com',
};

export const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections';
export const GOOGLE_CLOUD_CREATE_PROJECT_URL = 'https://console.cloud.google.com/projectcreate';
export const GOOGLE_CLOUD_AUTH_OVERVIEW_URL = 'https://console.cloud.google.com/auth/overview';
export const GOOGLE_CLOUD_AUTH_CLIENTS_URL = 'https://console.cloud.google.com/auth/clients';

const MAX_CLIENT_JSON_BYTES = 64 * 1024;
const FILES_SERVICES: readonly GoogleServiceId[] = ['drive', 'docs', 'sheets'];

export function canonicalChoices(choices: Iterable<GoogleServiceChoice>): GoogleServiceChoice[] {
  const picked = new Set(choices);
  return GOOGLE_SERVICE_CHOICES.filter(choice => picked.has(choice));
}

export function mergeChoices(
  existing: readonly GoogleServiceChoice[],
  adding: readonly GoogleServiceChoice[],
): GoogleServiceChoice[] {
  return canonicalChoices([...existing, ...adding]);
}

export function choiceForService(service: GoogleServiceId): GoogleServiceChoice | null {
  if (service === 'gmail') return 'gmail';
  if (service === 'calendar') return 'calendar';
  if (service === 'drive' || service === 'docs' || service === 'sheets') return 'files';
  return null;
}

export function googleChoiceLabel(choice: GoogleServiceChoice, t: TranslateFn): string {
  switch (choice) {
    case 'gmail':
      return 'Gmail';
    case 'calendar':
      return t('日历（Calendar）', 'Calendar');
    case 'files':
      return t('云盘、文档与表格（Drive, Docs & Sheets）', 'Drive, Docs and Sheets');
  }
}

export function googleChoiceShortLabel(choice: GoogleServiceChoice, t: TranslateFn): string {
  switch (choice) {
    case 'gmail':
      return 'Gmail';
    case 'calendar':
      return t('日历', 'Calendar');
    case 'files':
      return 'Drive / Docs / Sheets';
  }
}

export function googleChoiceDescription(choice: GoogleServiceChoice, t: TranslateFn): string {
  switch (choice) {
    case 'gmail':
      return t('搜索、读取、草拟、发送与标记邮件', 'Search, read, draft, send, and label mail');
    case 'calendar':
      return t('读取日历列表、查忙闲、读写日程事件', 'View calendars, check availability, and manage events');
    case 'files':
      return t('读取与编辑云盘文件、文档与表格', 'Find, read, and edit Drive files, Docs, and Sheets');
  }
}

export function googleServiceLabel(service: GoogleServiceId, t: TranslateFn): string {
  switch (service) {
    case 'gmail':
      return 'Gmail';
    case 'calendar':
      return t('日历（Calendar）', 'Calendar');
    case 'drive':
      return 'Google Drive';
    case 'docs':
      return 'Google Docs';
    case 'sheets':
      return 'Google Sheets';
    case 'contacts':
    case 'people':
      return t('联系人联查（People）', 'Contacts & Directory (People)');
  }
}

export function googleApiEnableUrl(service: GoogleServiceId, projectId?: string): string {
  const apiName = GOOGLE_SERVICE_API_NAMES[service];
  const url = new URL(`https://console.cloud.google.com/apis/library/${apiName}`);
  if (projectId && projectId.trim()) {
    url.searchParams.set('project', projectId.trim());
  }
  return url.toString();
}

export function googleEnableFlowUrl(
  choices: readonly GoogleServiceChoice[],
  projectId?: string,
): string {
  const apis = new Set<string>([GOOGLE_SERVICE_API_NAMES.contacts]);
  for (const choice of canonicalChoices(choices)) {
    for (const service of GOOGLE_CHOICE_SERVICES[choice]) {
      apis.add(GOOGLE_SERVICE_API_NAMES[service]);
    }
  }
  const url = new URL('https://console.cloud.google.com/flows/enableapi');
  url.searchParams.set('apiid', Array.from(apis).join(','));
  if (projectId && projectId.trim()) {
    url.searchParams.set('project', projectId.trim());
  }
  return url.toString();
}

export function maskClientId(clientId?: string | null): string {
  const raw = (clientId ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('...') || raw.startsWith('…')) return raw;
  const suffix = '.apps.googleusercontent.com';
  const core = raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw;
  if (core.length <= 6) return `…${core}`;
  return `…${core.slice(-6)}`;
}

export function deriveFallbackRedirectUri(centerUrl?: string): { uri: string; isPreview: boolean } {
  const candidate = (centerUrl ?? '').trim();
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      return {
        uri: `${parsed.origin}/api/oauth/google/callback`,
        isPreview: true,
      };
    } catch {
      // Fall through to window.location
    }
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return {
      uri: `${window.location.origin}/api/oauth/google/callback`,
      isPreview: true,
    };
  }
  return {
    uri: 'https://<center-domain>/api/oauth/google/callback',
    isPreview: true,
  };
}

export interface WebClientJsonValidation {
  ok: boolean;
  error?: string;
  warning?: string;
  clientIdTail?: string;
  projectId?: string;
}

/**
 * Client-side pre-validation of uploaded Google OAuth Web Client JSON.
 * Center performs authoritative validation and encryption. Never returns client_secret.
 */
export function validateWebClientJson(
  rawText: string,
  expectedRedirectUri: string | undefined,
  t: TranslateFn,
): WebClientJsonValidation {
  const byteLength =
    typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(rawText).length : rawText.length;
  if (byteLength === 0) {
    return { ok: false, error: t('所选文件为空', 'The selected file is empty.') };
  }
  if (byteLength > MAX_CLIENT_JSON_BYTES) {
    return {
      ok: false,
      error: t(
        '文件超过 64 KB，请确认上传的是 Google Cloud 导出的 Web OAuth 客户端 JSON',
        'File exceeds 64 KB. Please upload the Web OAuth client JSON exported from Google Cloud.',
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      ok: false,
      error: t('文件不是有效的 JSON 格式', 'The file is not valid JSON.'),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: t('JSON 结构无效，请上传 Google Cloud Web OAuth 客户端文件', 'Invalid JSON object.'),
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.type === 'service_account') {
    return {
      ok: false,
      error: t(
        '这是 Service Account 密钥，请改用 Google Cloud 中创建的 Web application OAuth 客户端 JSON',
        'This is a Service Account key. Please upload a Web application OAuth client JSON instead.',
      ),
    };
  }

  if (typeof obj.access_token === 'string' || typeof obj.refresh_token === 'string') {
    return {
      ok: false,
      error: t(
        '不支持导入已签发的令牌文件，请上传 Web OAuth 客户端配置 JSON',
        'Signed-in token files cannot be imported. Please upload the Web OAuth client JSON.',
      ),
    };
  }

  if (obj.installed && typeof obj.installed === 'object' && !obj.web) {
    return {
      ok: false,
      error: t(
        '这是桌面应用（Desktop app）凭据。PiBot 中心使用 HTTPS 回调，请在 Google Cloud 创建 Web application 类型客户端',
        'This is a Desktop app client. PiBot Center uses an HTTPS callback—create a Web application OAuth client in Google Cloud.',
      ),
    };
  }

  const web = obj.web;
  if (!web || typeof web !== 'object' || Array.isArray(web)) {
    return {
      ok: false,
      error: t(
        '缺少 web 字段，请确认在 Google Cloud 创建的是 Web application 类型 OAuth 客户端',
        'Missing "web" section. Make sure you created a Web application OAuth client in Google Cloud.',
      ),
    };
  }

  const webObj = web as Record<string, unknown>;
  const clientId = typeof webObj.client_id === 'string' ? webObj.client_id.trim() : '';
  const clientSecret = typeof webObj.client_secret === 'string' ? webObj.client_secret.trim() : '';
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error: t(
        'web 配置缺少 client_id 或 client_secret',
        'The "web" client JSON is missing client_id or client_secret.',
      ),
    };
  }

  const projectId =
    typeof webObj.project_id === 'string' && webObj.project_id.trim()
      ? webObj.project_id.trim()
      : undefined;

  let warning: string | undefined;
  const redirectUris = Array.isArray(webObj.redirect_uris)
    ? webObj.redirect_uris.filter((item): item is string => typeof item === 'string')
    : [];
  const normalizedExpected = expectedRedirectUri?.trim();
  if (
    normalizedExpected &&
    !normalizedExpected.includes('<') &&
    redirectUris.length > 0 &&
    !redirectUris.includes(normalizedExpected)
  ) {
    warning = t(
      `此 JSON 的 redirect_uris 中未包含中心回调地址（${normalizedExpected}）。请先在 Google Cloud Console 补加该重定向 URI 再保存。`,
      `This JSON's redirect_uris does not include the Center callback URI (${normalizedExpected}). Add it in Google Cloud Console before saving.`,
    );
  }

  return {
    ok: true,
    warning,
    clientIdTail: maskClientId(clientId),
    projectId,
  };
}

export interface GoogleDisplayReadinessRow {
  key: string;
  label: string;
  service: GoogleServiceId;
  state: GoogleServiceState;
  detail?: string;
  enableUrl?: string;
  choice: GoogleServiceChoice | null;
}

/**
 * Group readiness rows for low cognitive load:
 * - When Drive, Docs and Sheets are all ready, collapse them into a single row.
 * - Whenever any of Drive, Docs or Sheets has an issue, show each individual row
 *   so its exact enableUrl or error detail is directly actionable.
 * - Contacts / People is always rendered as its own honest row.
 */
export function buildReadinessRows(
  services: readonly GoogleServiceReadiness[],
  t: TranslateFn,
): GoogleDisplayReadinessRow[] {
  const byService = new Map<GoogleServiceId, GoogleServiceReadiness>();
  for (const item of services) {
    const normalized: GoogleServiceId = item.service === 'people' ? 'contacts' : item.service;
    byService.set(normalized, { ...item, service: normalized });
  }

  const rows: GoogleDisplayReadinessRow[] = [];

  const gmail = byService.get('gmail');
  if (gmail) {
    rows.push({
      key: 'gmail',
      label: googleServiceLabel('gmail', t),
      service: 'gmail',
      state: gmail.state,
      detail: gmail.detail,
      enableUrl: gmail.enableUrl,
      choice: 'gmail',
    });
  }

  const calendar = byService.get('calendar');
  if (calendar) {
    rows.push({
      key: 'calendar',
      label: googleServiceLabel('calendar', t),
      service: 'calendar',
      state: calendar.state,
      detail: calendar.detail,
      enableUrl: calendar.enableUrl,
      choice: 'calendar',
    });
  }

  const fileEntries = FILES_SERVICES.map(id => byService.get(id)).filter(
    (entry): entry is GoogleServiceReadiness => entry !== undefined,
  );
  if (fileEntries.length > 0) {
    const allFilesReady = fileEntries.length === 3 && fileEntries.every(entry => entry.state === 'ready');
    const allFilesNeedsPerm =
      fileEntries.length === 3 && fileEntries.every(entry => entry.state === 'needs-permission');
    if (allFilesReady || allFilesNeedsPerm) {
      rows.push({
        key: 'files',
        label: googleChoiceLabel('files', t),
        service: 'drive',
        state: allFilesReady ? 'ready' : 'needs-permission',
        detail: fileEntries[0].detail,
        enableUrl: fileEntries[0].enableUrl,
        choice: 'files',
      });
    } else {
      for (const entry of fileEntries) {
        rows.push({
          key: entry.service,
          label: googleServiceLabel(entry.service, t),
          service: entry.service,
          state: entry.state,
          detail: entry.detail,
          enableUrl: entry.enableUrl,
          choice: 'files',
        });
      }
    }
  }

  const contacts = byService.get('contacts');
  if (contacts) {
    rows.push({
      key: 'contacts',
      label: googleServiceLabel('contacts', t),
      service: 'contacts',
      state: contacts.state,
      detail: contacts.detail,
      enableUrl: contacts.enableUrl,
      choice: null,
    });
  }

  return rows;
}

export function isAccountReconnectRequired(account: GoogleAccountStatus): boolean {
  return account.status === 'reconnect' || account.status === 'reconnect_required';
}

export function readinessBadgeMeta(
  state: GoogleServiceState,
  skipped: boolean,
  t: TranslateFn,
): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  if (state === 'needs-permission' && skipped) {
    return { label: t('已跳过（未授权）', 'Skipped (not allowed)'), tone: 'muted' };
  }
  switch (state) {
    case 'ready':
      return { label: t('就绪', 'Ready'), tone: 'ok' };
    case 'needs-permission':
      return { label: t('未授权', 'Needs permission'), tone: 'warn' };
    case 'api-disabled':
      return { label: t('API 未启用', 'API disabled'), tone: 'warn' };
    case 'blocked-by-admin':
      return { label: t('组织已禁止', 'Blocked by admin'), tone: 'danger' };
    case 'error':
      return { label: t('探活出错', 'Check error'), tone: 'warn' };
  }
}

export function googleAdminTrustMessage(clientId: string | undefined, t: TranslateFn): string {
  const idPart = clientId?.trim() || '<Google Web Client ID>';
  return t(
    `请在 Google Workspace 管理控制台（安全性 › API 控制 › 管理第三方应用访问权限）将此应用标记为受信任：${idPart}`,
    `Please mark this Google app as Trusted in the Google Workspace Admin console (Security › API controls › Manage third-party app access): ${idPart}`,
  );
}

export function normalizeGoogleRulesResponse(raw: GoogleRulesListResponse | null | undefined): GoogleRule[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.rules)) return raw.rules;
  if (Array.isArray(raw.items)) return raw.items;
  return [];
}

export type EffectiveRuleStatus = {
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted';
};

export function ruleEffectiveStatus(
  rule: GoogleRule,
  accountsByKey: ReadonlyMap<string, GoogleAccountStatus>,
  t: TranslateFn,
): EffectiveRuleStatus {
  const account = accountsByKey.get(rule.account);
  const rawStatus = (rule.status ?? '').toLowerCase();
  const pauseReason = (rule.pausedReason ?? rule.pauseReason ?? '').toLowerCase();

  if (
    rawStatus.includes('reconnect') ||
    pauseReason.includes('reconnect') ||
    pauseReason.includes('invalid_grant') ||
    !account ||
    isAccountReconnectRequired(account)
  ) {
    return {
      label: t('已暂停（账号需重连）', 'Paused (account needs reconnect)'),
      tone: 'warn',
    };
  }
  if (!rule.enabled || rawStatus === 'paused' || rawStatus === 'disabled' || rawStatus === 'paused_disabled') {
    return {
      label: t('已暂停（规则已关闭）', 'Paused (disabled)'),
      tone: 'muted',
    };
  }
  if (rawStatus === 'backoff' || (rule.backoffUntil && new Date(rule.backoffUntil).getTime() > Date.now())) {
    return {
      label: t('限流退避中', 'Rate-limited (backing off)'),
      tone: 'warn',
    };
  }
  if (rawStatus === 'error' || rule.lastError) {
    return {
      label: t('检查异常', 'Check error'),
      tone: 'danger',
    };
  }
  return {
    label: t('运行中', 'Running'),
    tone: 'ok',
  };
}

export const DEFAULT_CALENDAR_MINUTES_BEFORE = 15;
export const MAX_CALENDAR_MINUTES_BEFORE = 24 * 60;

/**
 * Parse and clamp a Calendar reminder lead-time input (`0..1440` minutes).
 * Preserves explicit `0` (at event start) instead of treating it as falsy.
 */
export function parseCalendarMinutesBefore(
  raw: string | number | null | undefined,
  fallback = DEFAULT_CALENDAR_MINUTES_BEFORE,
): number {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const parsed = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(MAX_CALENDAR_MINUTES_BEFORE, Math.round(parsed)));
}

/**
 * Convert a rule's stored `minutesBefore` into the controlled value for a number input.
 */
export function calendarMinutesBeforeInputValue(
  minutesBefore: number | null | undefined,
  fallback = DEFAULT_CALENDAR_MINUTES_BEFORE,
): string {
  return String(parseCalendarMinutesBefore(minutesBefore, fallback));
}

/**
 * Format a Calendar rule's lead time for display while preserving explicit `0`.
 */
export function formatCalendarMinutesBefore(
  minutesBefore: number | null | undefined,
  t: TranslateFn,
  fallback = DEFAULT_CALENDAR_MINUTES_BEFORE,
): string {
  const minutes = parseCalendarMinutesBefore(minutesBefore, fallback);
  if (minutes === 0) {
    return t('开始时（0 分钟）', 'At start (0m)');
  }
  return t(`会前 ${minutes} 分钟`, `${minutes}m before event`);
}

export const DEFAULT_GOOGLE_ASSISTANT_BOT_NAME = '邮件与日程管家';
export const DEFAULT_ASSISTANT_BATCH_WINDOW_MINUTES = 10;
export const MIN_ASSISTANT_BATCH_WINDOW_MINUTES = 1;
export const MAX_ASSISTANT_BATCH_WINDOW_MINUTES = 24 * 60;
export const DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES = 15;
export const MAX_ASSISTANT_DIGEST_TIMES = 6;
const MAX_ASSISTANT_BOT_ROLE_LENGTH = 64;

function defaultHelperTranslate(zh: string, en: string): string {
  return typeof navigator !== 'undefined' && navigator.language.startsWith('en') ? en : zh;
}

export function defaultDigestTimesForMode(mode: GoogleAssistantMode): string[] {
  return mode === 'existing' ? ['09:00', '18:00'] : [];
}

export interface DigestTimesParseResult {
  valid: boolean;
  times: string[];
  error?: string;
}

/**
 * Parse comma/space-separated 24-hour `HH:mm` digest times, deduplicate, and sort.
 * Allows empty input (`times: []`) and at most 6 unique time slots.
 */
export function parseDigestTimesInput(
  raw: string,
  t: TranslateFn = defaultHelperTranslate,
): DigestTimesParseResult {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return { valid: true, times: [] };
  }

  const tokens = trimmed.split(/[\s,，、;；]+/).filter(Boolean);
  const unique = new Set<string>();

  for (const token of tokens) {
    const normalized = token.replace(/：/g, ':');
    const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
    if (!match) {
      return {
        valid: false,
        times: [],
        error: t(
          `简报时间「${token}」格式无效，请使用 24 小时制 HH:mm（例如 09:00, 18:00）`,
          `Invalid digest time "${token}". Use 24-hour HH:mm format (e.g. 09:00, 18:00).`,
        ),
      };
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return {
        valid: false,
        times: [],
        error: t(
          `简报时间「${token}」超出 00:00–23:59 范围`,
          `Digest time "${token}" must be between 00:00 and 23:59.`,
        ),
      };
    }
    unique.add(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }

  const times = Array.from(unique).sort();
  if (times.length > MAX_ASSISTANT_DIGEST_TIMES) {
    return {
      valid: false,
      times: [],
      error: t(
        `定时简报最多支持 ${MAX_ASSISTANT_DIGEST_TIMES} 个时间点`,
        `You can configure at most ${MAX_ASSISTANT_DIGEST_TIMES} digest times.`,
      ),
    };
  }

  return { valid: true, times };
}

export function formatDigestTimesInput(times?: readonly string[] | null): string {
  if (!Array.isArray(times) || times.length === 0) return '';
  return times
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .join(', ');
}

export interface BuildGoogleAssistantSetupInput {
  mode: GoogleAssistantMode;
  deviceId: string;
  botId?: string;
  role?: string;
  description?: string;
  modelRef?: string;
  thinkingLevel?: string;
  cwd?: string;
  accounts: readonly string[];
  batchWindowMinutes: string | number;
  digestTimesInput?: string;
  digestTimes?: readonly string[];
  calendarEnabled: boolean;
  calendarLeadMinutes: string | number;
  hindsightPrivateMemory: boolean;
}

export type BuildGoogleAssistantSetupResult =
  | { ok: true; payload: GoogleAssistantSetupRequest }
  | { ok: false; error: string };

function parseStrictBoundedInt(
  raw: string | number,
  min: number,
  max: number,
): number | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
    return parsed >= min && parsed <= max ? parsed : null;
  }
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
  return raw >= min && raw <= max ? raw : null;
}

export function buildGoogleAssistantSetupPayload(
  input: BuildGoogleAssistantSetupInput,
  t: TranslateFn = defaultHelperTranslate,
): BuildGoogleAssistantSetupResult {
  const mode: GoogleAssistantMode = input.mode;
  if (mode !== 'dedicated' && mode !== 'existing') {
    return {
      ok: false,
      error: t('请选择有效的管家运行模式', 'Choose a valid assistant mode.'),
    };
  }

  const deviceId = (input.deviceId ?? '').trim();
  if (!deviceId) {
    return {
      ok: false,
      error: t('请选择托管主机设备', 'Select a host device.'),
    };
  }

  const seenAccounts = new Set<string>();
  const accounts: string[] = [];
  for (const rawAccount of input.accounts ?? []) {
    const email = typeof rawAccount === 'string' ? rawAccount.trim() : '';
    if (!email) continue;
    const key = email.toLowerCase();
    if (seenAccounts.has(key)) continue;
    seenAccounts.add(key);
    accounts.push(email);
  }
  if (accounts.length === 0) {
    return {
      ok: false,
      error: t('请至少选择一个要监听的 Google 账号', 'Select at least one Google account to monitor.'),
    };
  }

  const batchWindowMinutes = parseStrictBoundedInt(
    input.batchWindowMinutes,
    MIN_ASSISTANT_BATCH_WINDOW_MINUTES,
    MAX_ASSISTANT_BATCH_WINDOW_MINUTES,
  );
  if (batchWindowMinutes === null) {
    return {
      ok: false,
      error: t(
        `批次聚合窗口需为 ${MIN_ASSISTANT_BATCH_WINDOW_MINUTES}–${MAX_ASSISTANT_BATCH_WINDOW_MINUTES} 之间的整数分钟`,
        `Batch window must be an integer between ${MIN_ASSISTANT_BATCH_WINDOW_MINUTES} and ${MAX_ASSISTANT_BATCH_WINDOW_MINUTES} minutes.`,
      ),
    };
  }

  const calendarEnabled = Boolean(input.calendarEnabled);
  let calendarLeadMinutes: number;
  if (!calendarEnabled && (input.calendarLeadMinutes === '' || input.calendarLeadMinutes === undefined || input.calendarLeadMinutes === null)) {
    calendarLeadMinutes = DEFAULT_ASSISTANT_CALENDAR_LEAD_MINUTES;
  } else {
    const parsedLead = parseStrictBoundedInt(input.calendarLeadMinutes, 0, MAX_CALENDAR_MINUTES_BEFORE);
    if (parsedLead === null) {
      return {
        ok: false,
        error: t(
          `会前提醒提前时间需为 0–${MAX_CALENDAR_MINUTES_BEFORE} 之间的整数分钟`,
          `Calendar lead time must be an integer between 0 and ${MAX_CALENDAR_MINUTES_BEFORE} minutes.`,
        ),
      };
    }
    calendarLeadMinutes = parsedLead;
  }

  let digestTimes: string[];
  if (input.digestTimesInput !== undefined) {
    const parsedDigest = parseDigestTimesInput(input.digestTimesInput, t);
    if (!parsedDigest.valid) {
      return {
        ok: false,
        error: parsedDigest.error || t('定时简报时间格式无效', 'Invalid digest times.'),
      };
    }
    digestTimes = parsedDigest.times;
  } else if (input.digestTimes !== undefined) {
    const parsedDigest = parseDigestTimesInput(input.digestTimes.join(', '), t);
    if (!parsedDigest.valid) {
      return {
        ok: false,
        error: parsedDigest.error || t('定时简报时间格式无效', 'Invalid digest times.'),
      };
    }
    digestTimes = parsedDigest.times;
  } else {
    digestTimes = defaultDigestTimesForMode(mode);
  }

  const shared = {
    accounts,
    batchWindowMinutes,
    digestTimes,
    calendarEnabled,
    calendarLeadMinutes,
    hindsightPrivateMemory: Boolean(input.hindsightPrivateMemory),
  };

  if (mode === 'existing') {
    const botId = (input.botId ?? '').trim();
    if (!botId) {
      return {
        ok: false,
        error: t('请选择一个已有 Bot', 'Select an existing Bot.'),
      };
    }
    return {
      ok: true,
      payload: {
        mode: 'existing',
        deviceId,
        botId,
        ...shared,
      },
    };
  }

  const botId = (input.botId ?? '').trim();
  const role = (input.role ?? '').trim();
  const description = (input.description ?? '').trim();
  const modelRef = (input.modelRef ?? '').trim();
  const thinkingLevel = (input.thinkingLevel ?? '').trim();
  const cwd = (input.cwd ?? '').trim();

  if (!botId && !role) {
    return {
      ok: false,
      error: t('请填写专职管家 Bot 名称', 'Enter a name for the dedicated assistant Bot.'),
    };
  }
  if (role.length > MAX_ASSISTANT_BOT_ROLE_LENGTH) {
    return {
      ok: false,
      error: t(
        `专职管家 Bot 名称不能超过 ${MAX_ASSISTANT_BOT_ROLE_LENGTH} 个字符`,
        `Dedicated assistant Bot name must be at most ${MAX_ASSISTANT_BOT_ROLE_LENGTH} characters.`,
      ),
    };
  }
  if (modelRef && /\s/.test(modelRef)) {
    return {
      ok: false,
      error: t('模型标识格式无效，不能包含空白字符', 'Invalid model reference; whitespace is not allowed.'),
    };
  }

  const createBot: GoogleAssistantCreateBotInput = {};
  if (role) createBot.role = role;
  if (description) createBot.description = description;
  if (modelRef) createBot.modelRef = modelRef;
  if (thinkingLevel) createBot.thinkingLevel = thinkingLevel;
  if (cwd) createBot.cwd = cwd;

  return {
    ok: true,
    payload: {
      mode: 'dedicated',
      deviceId,
      ...(botId ? { botId } : {}),
      ...(!botId || Object.keys(createBot).length > 0 ? { createBot } : {}),
      ...shared,
    },
  };
}

/**
 * Prompt the user with the 2-option Proactive Assistant choice right after OAuth
 * finishes only when no assistant is configured yet and at least one account is connected.
 */
export function shouldPromptGoogleAssistantSetup(
  assistant: GoogleAssistantConfig | null | undefined,
  connectedAccountsCount: number,
): boolean {
  return !assistant && connectedAccountsCount > 0;
}

export function assistantRuntimeBadgeMeta(
  assistant: Pick<GoogleAssistantConfig, 'enabled'>,
  runtime: GoogleAssistantRuntime | null | undefined,
  t: TranslateFn = defaultHelperTranslate,
): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted' } {
  const status = (runtime?.status ?? '').toLowerCase();
  if (!assistant.enabled || status === 'paused_disabled') {
    return { label: t('已暂停', 'Paused'), tone: 'muted' };
  }
  if (
    status === 'paused_account_reconnect' ||
    status.includes('reconnect') ||
    status.includes('invalid_grant')
  ) {
    return { label: t('账号需重连', 'Reconnect required'), tone: 'warn' };
  }
  if (status === 'paused_bot_unavailable') {
    return { label: t('目标 Bot 不可用', 'Target Bot unavailable'), tone: 'danger' };
  }
  if (status === 'paused_account_missing') {
    return { label: t('监听账号已移除', 'Account missing'), tone: 'danger' };
  }
  if (status === 'paused_service_unavailable') {
    return { label: t('服务未就绪', 'Service unavailable'), tone: 'warn' };
  }
  if (status === 'backing_off' || status === 'backoff' || status === 'rate_limited') {
    return { label: t('限流退避中', 'Rate-limited'), tone: 'warn' };
  }
  if (status.includes('offline') || runtime?.targetOnline === false) {
    return { label: t('目标主机离线', 'Host offline'), tone: 'warn' };
  }
  if (status === 'error' || status === 'failed') {
    return { label: t('检查异常', 'Check error'), tone: 'danger' };
  }
  if (status.startsWith('paused_')) {
    return { label: t('已暂停（需处理）', 'Paused (attention needed)'), tone: 'warn' };
  }
  if (status === 'paused' || status === 'disabled') {
    return { label: t('已暂停', 'Paused'), tone: 'muted' };
  }
  return { label: t('运行中', 'Running'), tone: 'ok' };
}

export function pickDefaultAssistantDeviceId(
  devices: readonly Pick<CenterDevice, 'deviceId' | 'online'>[],
  preferredDeviceId?: string,
): string {
  if (preferredDeviceId) {
    const preferredOnline = devices.find(d => d.deviceId === preferredDeviceId && d.online);
    if (preferredOnline) return preferredOnline.deviceId;
  }
  const firstOnline = devices.find(d => d.online);
  if (firstOnline) return firstOnline.deviceId;
  if (preferredDeviceId && devices.some(d => d.deviceId === preferredDeviceId)) {
    return preferredDeviceId;
  }
  return devices[0]?.deviceId ?? preferredDeviceId ?? '';
}

export function pickDefaultExistingAssistantBot<
  TBot extends Pick<CenterBotRef, 'deviceId' | 'botId' | 'isPrimary' | 'archivedAt' | 'online'>,
>(
  bots: readonly TBot[],
  devices: readonly Pick<CenterDevice, 'deviceId' | 'online'>[],
  preferredDeviceId?: string,
): TBot | null {
  const active = bots.filter(b => !b.archivedAt);
  if (active.length === 0) return null;
  const onlineDeviceIds = new Set(devices.filter(d => d.online).map(d => d.deviceId));
  const isOnline = (b: TBot) => Boolean(b.online || onlineDeviceIds.has(b.deviceId));

  if (preferredDeviceId) {
    const preferredPrimaryOnline = active.find(
      b => b.deviceId === preferredDeviceId && b.isPrimary && isOnline(b),
    );
    if (preferredPrimaryOnline) return preferredPrimaryOnline;
    const preferredPrimary = active.find(b => b.deviceId === preferredDeviceId && b.isPrimary);
    if (preferredPrimary) return preferredPrimary;
  }

  const onlinePrimary = active.find(b => b.isPrimary && isOnline(b));
  if (onlinePrimary) return onlinePrimary;

  if (preferredDeviceId) {
    const preferredAny = active.find(b => b.deviceId === preferredDeviceId);
    if (preferredAny) return preferredAny;
  }

  const anyPrimary = active.find(b => b.isPrimary);
  if (anyPrimary) return anyPrimary;

  const anyOnline = active.find(b => isOnline(b));
  return anyOnline ?? active[0];
}
