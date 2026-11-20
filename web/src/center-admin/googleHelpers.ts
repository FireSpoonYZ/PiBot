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
  GoogleAccountStatus,
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
