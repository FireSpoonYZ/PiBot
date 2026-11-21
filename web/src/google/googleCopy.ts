/*
 * Copyright (c) 2026 Lovecast Inc. (upstream Orca service/readiness/setup semantics, MIT)
 * Adapted for PiBot Center-shared Web OAuth Google Workspace & Bot Browser flow.
 */
import type {
  GoogleAccountView,
  GoogleServiceChoice,
  GoogleServiceKey,
  GoogleServiceReadiness,
  GoogleSetupMode,
  GoogleSetupStepView,
} from './types';

export type Translator = (zh: string, en: string) => string;

export const GOOGLE_SERVICE_CHOICES: readonly GoogleServiceChoice[] = ['gmail', 'calendar', 'files'];

export const GOOGLE_CHOICE_SERVICES: Record<GoogleServiceChoice, readonly GoogleServiceKey[]> = {
  gmail: ['gmail'],
  calendar: ['calendar'],
  files: ['drive', 'docs', 'sheets'],
};

export function googleChoiceLabel(choice: GoogleServiceChoice, t: Translator): string {
  switch (choice) {
    case 'gmail':
      return 'Gmail';
    case 'calendar':
      return t('日历 (Calendar)', 'Calendar');
    case 'files':
      return t('云盘、文档与表格 (Drive / Docs / Sheets)', 'Drive, Docs and Sheets');
  }
}

export function googleChoiceDescription(choice: GoogleServiceChoice, t: Translator): string {
  switch (choice) {
    case 'gmail':
      return t('搜索、读取、草拟、发送与标记邮件', 'Search, read, draft, send and organize mail');
    case 'calendar':
      return t('读取日历列表、查忙闲、读写日程事件', 'Read calendars, check availability and manage events');
    case 'files':
      return t('查找、读取与编辑云盘文件、文档与表格', 'Find, read and edit Drive files, Docs and Sheets');
  }
}

export function googleServiceLabel(service: string, t: Translator): string {
  switch (service) {
    case 'gmail':
      return 'Gmail';
    case 'calendar':
      return t('日历 (Calendar)', 'Calendar');
    case 'files':
      return t('Drive · Docs · Sheets', 'Drive, Docs & Sheets');
    case 'drive':
      return 'Google Drive';
    case 'docs':
      return 'Google Docs';
    case 'sheets':
      return 'Google Sheets';
    case 'contacts':
      return t('联系人联查 (People)', 'Contacts (People)');
    default:
      return service;
  }
}

export type GoogleReadinessFix = 'turn-on' | 'allow-again' | 'copy-for-admin' | 'check-again' | null;

export interface GoogleReadinessRow {
  key: string;
  label: string;
  choice?: GoogleServiceChoice;
  readiness: GoogleServiceReadiness;
}

const READINESS_SEVERITY: Record<GoogleServiceReadiness['state'], number> = {
  ready: 0,
  error: 1,
  'needs-permission': 2,
  'api-disabled': 3,
  'blocked-by-admin': 4,
};

/**
 * Group Drive/Docs/Sheets into one row showing worst readiness, while keeping
 * Contacts (People API) independent so Gmail readiness never masks People issues.
 */
export function googleReadinessRows(account: GoogleAccountView, t: Translator): GoogleReadinessRow[] {
  const rows = new Map<string, GoogleReadinessRow>();
  for (const readiness of account.services ?? []) {
    const isFiles = GOOGLE_CHOICE_SERVICES.files.includes(readiness.service);
    const key = isFiles ? 'files' : readiness.service;
    const choice: GoogleServiceChoice | undefined = isFiles
      ? 'files'
      : readiness.service === 'gmail' || readiness.service === 'calendar'
        ? readiness.service
        : undefined;
    const existing = rows.get(key);
    if (!existing || READINESS_SEVERITY[readiness.state] > READINESS_SEVERITY[existing.readiness.state]) {
      rows.set(key, {
        key,
        label: isFiles ? googleServiceLabel('files', t) : googleServiceLabel(readiness.service, t),
        choice,
        readiness,
      });
    }
  }
  return [...rows.values()];
}

export function googleReadinessFace(
  readiness: GoogleServiceReadiness,
  t: Translator,
): { label: string; tone: 'ok' | 'warn' | 'danger' | 'muted'; fix: GoogleReadinessFix } {
  switch (readiness.state) {
    case 'ready':
      return { label: t('就绪', 'Ready'), tone: 'ok', fix: null };
    case 'needs-permission':
      return { label: t('未授权', 'Needs permission'), tone: 'warn', fix: 'allow-again' };
    case 'api-disabled':
      return { label: t('API 未启用', 'API disabled'), tone: 'warn', fix: 'turn-on' };
    case 'blocked-by-admin':
      return { label: t('组织已禁止', 'Blocked by admin'), tone: 'danger', fix: 'copy-for-admin' };
    case 'error':
      return {
        label: readiness.detail ? t(`探活出错：${readiness.detail}`, `Check error: ${readiness.detail}`) : t('探活出错', 'Check error'),
        tone: 'warn',
        fix: 'check-again',
      };
  }
}

export function googleFixLabel(fix: NonNullable<GoogleReadinessFix>, t: Translator): string {
  switch (fix) {
    case 'turn-on':
      return t('去控制台启用', 'Enable in Console');
    case 'allow-again':
      return t('补授权', 'Grant permission');
    case 'copy-for-admin':
      return t('复制管理员说明', 'Copy for admin');
    case 'check-again':
      return t('重新检查', 'Check again');
  }
}

export function googleAdminTrustRequestText(clientId: string | undefined, t: Translator): string {
  const idText = clientId?.trim() || t('（请查看 Center 管理员提供的 Web Client ID）', '(see Web Client ID from your Center admin)');
  return t(
    `请在 Google Workspace 管理控制台（安全性 › API 控制 › 管理第三方应用访问权限）将此自托管 PiBot 应用标记为受信任：${idText}`,
    `Please mark this self-hosted PiBot Google app as Trusted in Google Workspace Admin Console (Security › API controls › Manage third-party app access): ${idText}`,
  );
}

export function maskClientId(clientId: string | undefined): string {
  if (!clientId) return '';
  const trimmed = clientId.trim();
  if (trimmed.length <= 12) return trimmed;
  return `…${trimmed.slice(-10)}`;
}

export function googleSetupModeMeta(mode: GoogleSetupMode, t: Translator): {
  title: string;
  description: string;
} {
  switch (mode) {
    case 'do-it-for-me':
      return {
        title: t('自动代办 (Do it for me)', 'Do it for me'),
        description: t(
          'Bot 在内置浏览器协助填写非敏感项；遇到登录、政策勾选或创建 Secret 时自动停手交给你亲自操作。',
          'Bot fills non-sensitive Cloud Console fields in the embedded browser, and pauses for you on sign-in, policy agreement, and client secret creation.',
        ),
      };
    case 'guide-here':
      return {
        title: t('内嵌指导 (Guide me here)', 'Guide me here'),
        description: t(
          '在右侧/全屏 Bot 内置浏览器打开对应页面，由你亲自点击与输入，Bot 跟踪非敏感步骤进度。',
          'Opens the Cloud Console in the Bot browser for you to click while tracking non-sensitive step progress.',
        ),
      };
    case 'guide-browser':
      return {
        title: t('外部浏览器指导 (Guide me in my browser)', 'Guide me in my browser'),
        description: t(
          '在你自己的系统浏览器操作，Bot 看不到页面；每完成一步点「已完成」继续。适合手机或受限环境。',
          'Run in your own system browser where the Bot cannot see the page; tap Done after each step.',
        ),
      };
  }
}

export function normalizeSetupMode(raw: string | undefined): GoogleSetupMode | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower === 'do-it-for-me' || lower === 'auto' || lower === 'agent') return 'do-it-for-me';
  if (lower === 'guide-here' || lower === 'embedded' || lower === 'guided' || lower === 'here') return 'guide-here';
  if (lower === 'guide-browser' || lower === 'external' || lower === 'manual' || lower === 'browser') return 'guide-browser';
  return null;
}

export const GOOGLE_SETUP_STEP_ORDER = ['account', 'project', 'apis', 'branding', 'links', 'publish', 'client', 'connect'] as const;

export function googleStepTitle(step: string, t: Translator): string {
  switch (step) {
    case 'account':
      return t('确认 Google Cloud 账号', 'Confirm Google Cloud account');
    case 'project':
      return t('创建 Google Cloud 项目', 'Create Google Cloud project');
    case 'apis':
      return t('启用所需 Google API', 'Enable required Google APIs');
    case 'branding':
      return t('配置 Google Auth Platform（应用信息与政策同意）', 'Configure Google Auth Platform & policy');
    case 'links':
      return t('填写自托管域名与隐私链接', 'Add your Center domain & privacy links');
    case 'publish':
      return t('发布或核对测试用户', 'Publish app or verify test users');
    case 'client':
      return t('创建 Web application 凭据并私密保存', 'Create Web application client & save privately');
    case 'connect':
      return t('用系统浏览器登录并连接账号', 'Sign in with system browser');
    default:
      return step;
  }
}

export function googleStepInstructions(
  step: string,
  redirectUri: string | undefined,
  t: Translator,
): { lines: string[]; sensitiveWarning?: string } {
  const uri = redirectUri || 'https://<your-center-domain>/api/oauth/google/callback';
  switch (step) {
    case 'account':
      return {
        lines: [
          t('确认用于创建 Google Cloud 项目的 Google 账号（个人 Gmail 为 External，Workspace 组织按权限可选 Internal）。', 'Confirm which Google account will own the Cloud project (External for Gmail, or Internal if your Workspace allows it).'),
        ],
      };
    case 'project':
      return {
        lines: [
          t('在 Google Cloud Console 确认右上角登录的是正确 Google 账号。', 'Confirm the Google account at top right in Cloud Console.'),
        ],
      };
    case 'apis':
      return {
        lines: [
          t('启用 People API（联系人基础依赖）及所选服务对应的 Gmail / Calendar / Drive / Docs / Sheets API。', 'Enable People API (base dependency) and the APIs for your selected services.'),
          t('启用 API 仅开通项目能力，不代表授权个人数据。', 'Enabling APIs turns on project capability only; it does not grant personal data access.'),
        ],
      };
    case 'branding':
      return {
        lines: [
          t('填写应用名称（如 PiBot）与你的联系邮箱；域名仅填写你自己部署的 Center 域名。', 'Enter your app name (e.g. PiBot) and contact email; use only your own Center domain.'),
          t('到达「Google API Services: User Data Policy」勾选框时，请本人阅读勾选并提交。', 'Read and tick “Google API Services: User Data Policy” yourself before submitting.'),
        ],
        sensitiveWarning: t(
          '隐私红线：Bot 不会代你勾选 Google 用户数据政策，也不会替你登录账号。',
          'Privacy boundary: Bot never signs in or ticks Google User Data Policy on your behalf.',
        ),
      };
    case 'links':
      return {
        lines: [
          t('在 App domain 中填入你的 Center 主页和隐私说明链接（不要填写任何第三方演示域名）。', 'Add your own Center homepage and privacy URLs under App domain.'),
          t('在 Authorized domains 中添加你的 Center 域名并保存。', 'Add your Center domain under Authorized domains and save.'),
        ],
      };
    case 'publish':
      return {
        lines: [
          t('若希望长期保持登录，可按需发布应用；若留在 Testing 模式，需将本人邮箱加入 Test users（Testing 模式令牌通常 7 天过期）。', 'Publish the app for persistent sign-in, or add yourself to Test users (Testing tokens typically expire after 7 days).'),
        ],
      };
    case 'client':
      return {
        lines: [
          t('应用类型务必选择「Web application」（不是 Desktop app）。', 'Select application type “Web application” (not Desktop app).'),
          t(`在「已授权的重定向 URI」中添加：${uri}`, `Add Authorized redirect URI: ${uri}`),
          t('如页面出现 AI agent 勾选框，按提示勾选；点击 Create 后通过下方私密控件录入 Client ID / Secret 或上传 JSON。', 'Tick any AI agent checkbox if shown. After Create, submit Client ID / Secret or upload the JSON via the private form below.'),
        ],
        sensitiveWarning: t(
          '凭据红线：点击 Create 前请确保由本人接管或在系统浏览器操作；Client Secret 只能通过下方私密通道提交，绝不发到聊天中。',
          'Secret boundary: Take over or use your system browser before clicking Create. Submit Client Secret only via the private form below, never in chat.',
        ),
      };
    case 'connect':
      return {
        lines: [
          t('选择要连接的服务组，点击前往 Google 登录，在系统浏览器完成登录、MFA 与同意。', 'Pick services and complete Google sign-in, MFA, and consent in your system browser.'),
          t('完成后将由 Center 校验回调并逐项探测服务就绪度，无需复制回调地址到聊天。', 'Center verifies the callback and probes each service automatically — never paste callbacks into chat.'),
        ],
      };
    default:
      return { lines: [] };
  }
}

export function normalizeSetupSteps(
  raw: Record<string, GoogleSetupStepView> | GoogleSetupStepView[] | undefined,
): Array<{ id: string; status: string; title?: string; detail?: string; url?: string }> {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item, idx) => ({
      id: item.id || item.step || String(idx),
      status: item.status || 'pending',
      title: item.title,
      detail: item.detail,
      url: item.url,
    }));
  }
  const orderedKeys = [
    ...GOOGLE_SETUP_STEP_ORDER.filter(key => key in raw),
    ...Object.keys(raw).filter(key => !(GOOGLE_SETUP_STEP_ORDER as readonly string[]).includes(key)),
  ];
  return orderedKeys.map(key => {
    const entry = raw[key] ?? {};
    return {
      id: entry.id || entry.step || key,
      status: entry.status || 'pending',
      title: entry.title,
      detail: entry.detail,
      url: entry.url,
    };
  });
}

export const MAX_WEB_CLIENT_JSON_BYTES = 64 * 1024;

export function validateWebClientJson(
  rawText: string,
  t: Translator,
): { ok: true; clientId: string; redirectUris: string[] } | { ok: false; error: string } {
  const byteSize = new TextEncoder().encode(rawText).byteLength;
  if (byteSize === 0) {
    return { ok: false, error: t('凭据文件为空，请重新选择。', 'The credential file is empty.') };
  }
  if (byteSize > MAX_WEB_CLIENT_JSON_BYTES) {
    return { ok: false, error: t('凭据文件超过 64 KiB 上限，请确认选择了正确的 Google OAuth JSON 文件。', 'File exceeds the 64 KiB limit. Choose a Google OAuth client JSON file.') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: t('JSON 格式无效，请检查下载的凭据文件。', 'Invalid JSON format.') };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: t('JSON 内容结构无效。', 'Unexpected JSON structure.') };
  }
  const obj = parsed as Record<string, unknown>;
  if ('installed' in obj && !('web' in obj)) {
    return {
      ok: false,
      error: t(
        '检测到这是 Desktop app (installed) 凭据；PiBot Center 需要「Web application」类型凭据，请在 Google Cloud Console 创建 Web application 客户端。',
        'This is a Desktop app (“installed”) client JSON. PiBot Center requires a “Web application” OAuth client.',
      ),
    };
  }
  const web = obj.web;
  if (!web || typeof web !== 'object' || Array.isArray(web)) {
    return {
      ok: false,
      error: t('未找到 web 客户端字段，请确认下载的是 Web application OAuth JSON。', 'Missing “web” client section. Download a Web application OAuth JSON.'),
    };
  }
  const webRec = web as Record<string, unknown>;
  const clientId = typeof webRec.client_id === 'string' ? webRec.client_id.trim() : '';
  const clientSecret = typeof webRec.client_secret === 'string' ? webRec.client_secret.trim() : '';
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error: t('JSON 中缺少 client_id 或 client_secret。', 'Missing client_id or client_secret in JSON.'),
    };
  }
  const redirectUris = Array.isArray(webRec.redirect_uris)
    ? webRec.redirect_uris.filter((v): v is string => typeof v === 'string')
    : [];
  return { ok: true, clientId, redirectUris };
}

/** Detect if a generic Center capability entry represents the shared Center Google Workspace MCP. */
export function isSharedGoogleCapabilityEntry(entry: {
  installation: { installationId?: string; packageId?: string; displayName?: string };
}): boolean {
  return entry.installation.installationId === 'builtin.google-workspace';
}
