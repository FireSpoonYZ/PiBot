import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Info, RefreshCw, TriangleAlert, X } from 'lucide-react';
import './error-notice.css';

export const HIDE_TOOL_OUTPUT_STORAGE_KEY = 'pibot-hide-tool-output:v1';
const HIDE_TOOL_OUTPUT_EVENT = 'pibot-hide-tool-output-change';

export function readHideToolOutput(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const raw = localStorage.getItem(HIDE_TOOL_OUTPUT_STORAGE_KEY);
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function writeHideToolOutput(hide: boolean): void {
  const normalized = Boolean(hide);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(HIDE_TOOL_OUTPUT_STORAGE_KEY, normalized ? 'true' : 'false');
    }
  } catch {
    // Ignore storage errors
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(HIDE_TOOL_OUTPUT_EVENT, { detail: normalized }));
    }
  } catch {
    // Ignore custom event errors
  }
}

export function useHideToolOutput(): [boolean, (next: boolean) => void] {
  const [hideToolOutput, setHideToolOutputState] = useState<boolean>(() => readHideToolOutput());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail;
      setHideToolOutputState(typeof detail === 'boolean' ? detail : readHideToolOutput());
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === HIDE_TOOL_OUTPUT_STORAGE_KEY) {
        setHideToolOutputState(readHideToolOutput());
      }
    };
    window.addEventListener(HIDE_TOOL_OUTPUT_EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(HIDE_TOOL_OUTPUT_EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const setHideToolOutput = useCallback((next: boolean) => {
    const normalized = Boolean(next);
    writeHideToolOutput(normalized);
    setHideToolOutputState(normalized);
  }, []);

  return [hideToolOutput, setHideToolOutput];
}

export type UiLanguage = 'system' | 'zh' | 'en';
export const LanguageOverride = createContext<UiLanguage | undefined>(undefined);

export function useText() {
  const language = useContext(LanguageOverride);
  const en =
    language === 'en' ||
    ((language === 'system' || language === undefined) &&
      typeof navigator !== 'undefined' &&
      navigator.language.startsWith('en'));
  return useCallback((zh: string, english: string) => (en ? english : zh), [en]);
}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
export const array = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

export type NoticeTone = 'danger' | 'warning' | 'info' | 'success';

export interface HumanizedError {
  tone: NoticeTone;
  title: string;
  description?: string;
  detail?: string;
  spinning?: boolean;
}

const KNOWN_CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,32}):\s*(.*)$/s;
const OUTCOME_PREFIX = /^(unconfirmed|not-sent|responded):\s*(.*)$/is;
const TRAILING_OUTCOME_CODE = /\s*(?:[·:;]\s*)?(?:unconfirmed|not-sent|responded):\s*([A-Z][A-Z0-9_]{2,32})$/i;
const CONTEXT_PREFIX_RE = /^(群聊列表读取失败|目录读取失败|观察建立失败|连接失败|更换中心连接失败|无法读取配置|保存 profile 失败|设为主 Bot 失败|归档失败|恢复失败|删除失败|停止失败|选择图片失败|选择文件失败|本次执行失败|This run failed|读取模型列表失败|模型生成失败)\s*[·:：-]\s*(.+)$/is;
const TARGET_OFFLINE_PREFIX_RE = /^目标\s+(.+?)\s*离线[：:]\s*(.+)$/s;
const DEVICE_CODE_PREFIX_RE = /^([^:：]{1,48}?)[：:]\s*([A-Z][A-Z0-9_]{2,32})(?:[：:\s]\s*(.*))?$/s;

function normalizeErrorParts(raw: string): {
  code: string;
  body: string;
  contextPrefix: string;
  devicePrefix: string;
} {
  let body = raw.trim();
  let contextPrefix = '';
  let devicePrefix = '';
  let code = '';

  for (let i = 0; i < 3; i += 1) {
    const ctxMatch = body.match(CONTEXT_PREFIX_RE);
    if (!ctxMatch) break;
    if (!contextPrefix) contextPrefix = ctxMatch[1].trim();
    body = ctxMatch[2].trim();
  }

  const targetOfflineMatch = body.match(TARGET_OFFLINE_PREFIX_RE);
  if (targetOfflineMatch) {
    devicePrefix = targetOfflineMatch[1].trim();
    body = targetOfflineMatch[2].trim();
    if (!code) code = 'OFFLINE';
  }

  // Iteratively strip repeated CODE: and outcome: prefixes
  for (let i = 0; i < 6; i += 1) {
    const codeMatch = body.match(KNOWN_CODE_PREFIX);
    if (codeMatch) {
      const nextCode = codeMatch[1];
      // Prefer a specific code over generic INTERNAL wrapper
      if (!code || code === 'INTERNAL') {
        code = nextCode;
      }
      body = codeMatch[2].trim();
      continue;
    }
    const outcomeMatch = body.match(OUTCOME_PREFIX);
    if (outcomeMatch) {
      body = outcomeMatch[2].trim();
      continue;
    }
    const devMatch = !devicePrefix ? body.match(DEVICE_CODE_PREFIX_RE) : null;
    if (devMatch) {
      devicePrefix = devMatch[1].trim();
      const nextCode = devMatch[2].trim();
      if (!code || code === 'INTERNAL') {
        code = nextCode;
      }
      body = (devMatch[3] ?? '').trim();
      continue;
    }
    break;
  }

  // Strip trailing "unconfirmed: CODE" / "not-sent: CODE" noise
  const trailingMatch = body.match(TRAILING_OUTCOME_CODE);
  if (trailingMatch) {
    if (!code || code === 'INTERNAL') {
      code = trailingMatch[1].toUpperCase();
    }
    body = body.slice(0, trailingMatch.index).trim();
  }

  // If body is a bare uppercase error code (e.g. "DISCONNECTED" or "OFFLINE"), promote it to code
  if (/^[A-Z][A-Z0-9_]{2,32}$/.test(body)) {
    if (!code || code === 'INTERNAL') {
      code = body;
    }
    body = '';
  }

  // If body is just the code itself or an outcome token, clear redundant body
  if (
    body === code ||
    /^(unconfirmed|not-sent|responded)$/i.test(body) ||
    /^(unconfirmed|not-sent|responded):\s*[A-Z0-9_]+$/i.test(body)
  ) {
    body = '';
  }

  return { code, body, contextPrefix, devicePrefix };
}

export function isModelConfigError(rawInput: unknown): boolean {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : rawInput == null ? '' : errorText(rawInput).trim();
  if (!raw) return false;
  const { code, body } = normalizeErrorParts(raw);
  const upperCode = code.toUpperCase();
  if (
    upperCode === 'MODEL_NOT_CONFIGURED' ||
    upperCode === 'MODEL_CONFIG_ERROR' ||
    upperCode === 'INVALID_API_KEY' ||
    upperCode === 'MISSING_API_KEY'
  ) {
    return true;
  }
  const combined = `${code} ${body} ${raw}`.toLowerCase();
  if (
    /api[\s_-]?key|apikey|invalid_api_key|unauthorized|authentication|credential|model[\s_-]?not[\s_-]?found|model[\s_-]?not[\s_-]?configured|no[\s_-]?model[\s_-]?configured|provider[\s_-]?not[\s_-]?found|invalid[\s_-]?model|\b(?:401|403)\b/.test(
      combined,
    ) ||
    combined.includes('未配置模型') ||
    combined.includes('模型未配置') ||
    combined.includes('凭据') ||
    combined.includes('密钥') ||
    combined.includes('鉴权') ||
    combined.includes('模型不存在')
  ) {
    return true;
  }
  return false;
}

export function humanizeError(rawInput: unknown, t: (zh: string, en: string) => string): HumanizedError | null {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : errorText(rawInput).trim();
  if (!raw) return null;

  const parsed = normalizeErrorParts(raw);
  const code = parsed.code;
  let body = parsed.body;
  const { contextPrefix, devicePrefix } = parsed;

  let extractedDetail = '';
  const reqMatch = body.match(/^(.*?)\s*·\s*(requestId\s+\S+|p-[a-z0-9-]+.*|[0-9a-f]{8}-[0-9a-f-]{12,}.*)$/i);
  if (reqMatch && reqMatch[1].trim()) {
    body = reqMatch[1].trim();
    extractedDetail = reqMatch[2].trim();
  }

  const lower = `${code} ${contextPrefix} ${body}`.toLowerCase();
  const detail =
    [
      code ? `Code: ${code}` : '',
      extractedDetail,
      (code || contextPrefix || devicePrefix) && body !== raw && raw !== code ? raw : '',
    ]
      .filter(Boolean)
      .join(' · ') || undefined;

  // 1. Syncing / Reconnecting states (not actual errors!)
  if (
    body === '正在重连…' ||
    body === 'Reconnecting…' ||
    body.includes('连接中断，正在恢复') ||
    lower.includes('connection interrupted; recovering') ||
    body.includes('正在恢复设备连接') ||
    body.includes('设备中继正在恢复') ||
    body.includes('设备连接已变化，正在恢复') ||
    body.includes('正在读取目标身份') ||
    lower.includes('loading target identity')
  ) {
    return {
      tone: 'info',
      title: t('正在恢复连接…', 'Reconnecting…'),
      description: t('网络或服务同步中，稍后将自动恢复', 'Syncing connection in the background'),
      spinning: true,
    };
  }

  if (
    body.includes('正在初始化运行环境') ||
    body.includes('正在启动本机运行环境') ||
    lower.includes('initializing runtime') ||
    lower.includes('starting local runtime')
  ) {
    return {
      tone: 'info',
      title: t('正在唤醒本机助手环境', 'Starting Local Assistant'),
      description: t('首次启动约需几秒钟，请稍候再试', 'Initial startup takes a few seconds, please try again shortly'),
      spinning: true,
    };
  }

  // 2. Success / Completed notices
  if (
    body.includes('已清空当前对话历史') ||
    lower.includes('conversation history cleared') ||
    body.includes('模型设置已保存') ||
    lower.includes('model settings saved') ||
    body.includes('已保留新版草稿') ||
    lower.includes('kept the newer draft')
  ) {
    return {
      tone: 'success',
      title: body,
    };
  }

  // 3. Offline / Draft retained / Pending warnings
  if (
    body.includes('目标离线，草稿已保留') ||
    lower.includes('target offline; draft retained') ||
    body.includes('目标节点离线') ||
    lower.includes('target offline; restoring')
  ) {
    return {
      tone: 'warning',
      title: t('目标设备当前离线', 'Target Device Offline'),
      description: t('您的草稿已安全保留，设备上线后即可继续发送', 'Your draft is safely saved and ready when the device is back online'),
    };
  }

  if (body.includes('中心离线，草稿已保留') || lower.includes('center offline; draft retained')) {
    return {
      tone: 'warning',
      title: t('中心服务暂未连接', 'Center Disconnected'),
      description: t('草稿已安全保存在本地，恢复连接后可继续发送', 'Your draft is saved locally until connection is restored'),
    };
  }

  if (body.includes('请求未发送，草稿已恢复') || lower.includes('request not sent; draft restored')) {
    return {
      tone: 'info',
      title: t('消息未发送，已恢复到输入框', 'Message Not Sent · Draft Restored'),
      description: t('您可以检查内容后重新发送', 'You can review your message and send it again'),
    };
  }

  if (
    body.includes('原请求尚未确认') ||
    lower.includes('original request is unconfirmed') ||
    body.includes('发送结果待确认') ||
    lower.includes('send result unconfirmed') ||
    body.includes('回执未确认') ||
    lower.includes('receipt unconfirmed') ||
    body.includes('连接中断，请按原 ID 确认结果')
  ) {
    return {
      tone: 'warning',
      title: t('上一条消息正在确认状态', 'Confirming Previous Message'),
      description: t('为避免重复发送，系统正在核对投递结果，请稍候或手动对账', 'Verifying delivery status to prevent duplicate messages'),
      detail,
    };
  }

  if (body.includes('创建回执未确认') || lower.includes('creation unconfirmed')) {
    return {
      tone: 'warning',
      title: t('上次创建请求仍在确认中', 'Previous Creation Still Confirming'),
      description: t('请先在下方点击「核对状态」确认是否已创建成功，避免重复创建', 'Reconcile the previous request first to avoid creating duplicates'),
      detail,
    };
  }

  // 4. Authentication & Credentials & Certificates
  if (
    code === 'CREDENTIALS' ||
    code === 'UNAUTHENTICATED' ||
    code === 'UNAUTHORIZED' ||
    code === 'CONTROL_UNAUTHORIZED' ||
    code === 'INVALID_TOKEN' ||
    code === 'INVALID_CREDENTIALS' ||
    code === 'CREDENTIALS_NOT_FOUND' ||
    code === 'REVOKED' ||
    body.includes('凭据无法读取') ||
    body.includes('请输入新令牌') ||
    body.includes('请输入令牌')
  ) {
    return {
      tone: 'danger',
      title: t('访问凭据已失效或未授权', 'Authentication Required'),
      description:
        body && !body.startsWith('CREDENTIALS')
          ? body
          : t('请检查中心地址、设备标识，并重新输入有效的访问令牌', 'Check the server URL, device ID, and enter a valid access token'),
      detail,
    };
  }

  if (
    code === 'CERTIFICATE_ERROR' ||
    code === 'CERTIFICATE_INVALID' ||
    code === 'CERT_HAS_EXPIRED' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    lower.includes('certificate') ||
    body.includes('证书')
  ) {
    return {
      tone: 'danger',
      title: t('安全证书校验未通过', 'TLS Certificate Verification Failed'),
      description: t('如果使用自签名证书，请在连接设置中填写匹配的 CA 证书 PEM', 'If using a self-signed certificate, provide the matching CA PEM in settings'),
      detail,
    };
  }

  // 5. Transport / Stream / Host errors
  if (
    code === 'OFFLINE' ||
    code === 'CONTROL_UNAVAILABLE' ||
    body === 'Remote target unavailable' ||
    body === 'Not connected' ||
    body === 'Original connection unavailable' ||
    body.includes('无法连接目标节点') ||
    lower.includes('target host unavailable') ||
    body.includes('目标设备离线，已拒绝修改') ||
    body.includes('所选设备不可用')
  ) {
    const targetLabel = devicePrefix ? `「${devicePrefix}」` : t('目标设备', 'Target Device');
    return {
      tone: 'warning',
      title: contextPrefix
        ? `${contextPrefix}：${targetLabel}${t('当前离线', ' is Offline')}`
        : devicePrefix
          ? t(`设备「${devicePrefix}」当前离线`, `Device "${devicePrefix}" is Offline`)
          : t('目标设备当前离线', 'Target Device Offline'),
      description: t('已展示最近缓存的内容，设备恢复在线后即可继续同步与操作', 'Showing cached content until the remote device is back online'),
      detail,
    };
  }

  if (
    code === 'EVENT_STREAM_CLOSED' ||
    code === 'STREAM_CLOSED' ||
    code === 'TRANSPORT_RESET' ||
    code === 'NOT_CONNECTED' ||
    code === 'DISCONNECTED' ||
    code === 'TIMEOUT' ||
    body.includes('事件流未就绪') ||
    body.includes('准入前事件缓冲溢出')
  ) {
    const baseTitle =
      code === 'TIMEOUT'
        ? t('请求超时', 'Request Timed Out')
        : devicePrefix
          ? t(`与「${devicePrefix}」的连接已中断`, `Connection to "${devicePrefix}" Lost`)
          : t('连接已中断', 'Connection Lost');
    return {
      tone: 'warning',
      title: contextPrefix ? `${contextPrefix}：${baseTitle}` : baseTitle,
      description: t('正在尝试恢复连接，您也可以稍后点击重试', 'Attempting to restore the connection; retry in a moment if needed'),
      detail,
    };
  }

  if (code === 'INVALID_CWD') {
    return {
      tone: 'danger',
      title: t('工作目录无效', 'Invalid Working Directory'),
      description: t('目标路径不存在或不可访问，请检查任务配置中的目录', 'The target path does not exist or is inaccessible. Check the configured directory'),
      detail,
    };
  }

  if (code === 'SUBMISSION_NOT_FOUND') {
    return {
      tone: 'warning',
      title: t('提交记录未找到', 'Submission Not Found'),
      description: t('该任务可能已被清理或来自其他设备，请刷新后重试', 'The submission may have been cleared or came from another device. Refresh and retry'),
      detail,
    };
  }

  if (
    code === 'LAUNCH_FAILED' ||
    code === 'STARTUP_TIMEOUT' ||
    code === 'CLOSED' ||
    body === 'Host unavailable' ||
    body.includes('本机服务未运行') ||
    lower.includes('local host not running') ||
    body.includes('客户端启动失败') ||
    body.includes('Host 启动超时') ||
    body.includes('Host 已关闭')
  ) {
    return {
      tone: 'danger',
      title: t('本机助手服务未就绪', 'Local Assistant Service Unavailable'),
      description: t('后台运行环境尚未完成启动或已停止，请稍后重试', 'The background runtime is starting or stopped. Please try again in a moment'),
      detail,
    };
  }

  if (
    code === 'BUSY' ||
    code === 'RUNTIME_BUSY' ||
    code === 'RPC_BUSY' ||
    body.includes('队列已满') ||
    body.includes('并发已满') ||
    body.includes('队列繁忙') ||
    body.includes('观察数已达上限')
  ) {
    return {
      tone: 'warning',
      title: t('当前操作较为频繁', 'Service Busy'),
      description: t('系统正在处理上一项任务，请稍候片刻再试', 'Another request is currently being processed. Please wait a moment'),
      detail,
    };
  }

  // 6. Model & Generation errors
  if (body.includes('本次请求未获得回答') || lower.includes('no answer was generated')) {
    return {
      tone: 'warning',
      title: t('本次对话未返回内容', 'No Response Received'),
      description: t('生成过程已结束但未返回有效回复，您可以重新发送试一次', 'Generation ended without a reply. Please try sending your message again'),
    };
  }

  const isRateLimit = /429|rate[\s_-]?limit|quota|overloaded|too many requests|resource_exhausted/i.test(lower);
  const isModelConfig = isModelConfigError(raw);
  if (
    code.startsWith('MODEL_') ||
    code === 'GENERATION_FAILED' ||
    lower.includes('model_error') ||
    contextPrefix === '模型生成失败' ||
    contextPrefix === '本次执行失败' ||
    lower.includes('this run failed') ||
    body.includes('模型生成失败') ||
    lower.includes('model generation failed') ||
    isRateLimit ||
    isModelConfig
  ) {
    const cleanMsg = (body && body !== 'model_error' ? body : '') || detail;
    if (isRateLimit) {
      return {
        tone: 'warning',
        title: t('模型服务繁忙或触发限流', 'Model Rate Limited or Busy'),
        description: t('请求过于频繁或上游配额受限，请稍后重试。', 'Upstream rate limit or quota reached. Please retry shortly.'),
        detail: cleanMsg || undefined,
      };
    }
    if (isModelConfig) {
      return {
        tone: 'danger',
        title: t('模型配置或凭据不可用', 'Model Configuration or API Key Issue'),
        description: t('请检查模型服务商、API 密钥或所选模型是否有效。', 'Check whether the model provider, API key, and selected model are valid.'),
        detail: cleanMsg || undefined,
      };
    }
    if (/fetch failed|econnreset|etimedout|\b(?:502|503|504)\b|bad gateway|service unavailable|gateway timeout|network/i.test(lower)) {
      return {
        tone: 'warning',
        title: t('网络连接波动，回复中断', 'Network Interrupted During Reply'),
        description: t('连接上游服务时发生中断，请直接重试。', 'Connection to the upstream service was interrupted. Please retry.'),
        detail: cleanMsg || undefined,
      };
    }
    return {
      tone: 'warning',
      title: t('本轮回复未能完成', 'Reply Could Not Complete'),
      description: t('生成过程中断，可直接重试；若反复出现请检查模型配置。', 'Generation was interrupted. Retry, or check model settings if this persists.'),
      detail: cleanMsg && cleanMsg !== 'model_error' ? cleanMsg : undefined,
    };
  }

  // 7. Bot lifecycle & protection rules
  if (code === 'BOT_NOT_FOUND') {
    return {
      tone: 'info',
      title: t('该智能体已不存在', 'This bot no longer exists'),
      description: t('请刷新对话列表，选择其他智能体继续。', 'Refresh the conversation list and select another bot.'),
      detail,
    };
  }
  if (code === 'PRIMARY_BOT_PROTECTED' || body.includes('主智能体受保护') || lower.includes('primary bot is protected')) {
    return {
      tone: 'warning',
      title: t('主助手受保护，无法直接归档或删除', 'Primary Assistant is Protected'),
      description: t('请先将其他智能体设为主助手，再对此智能体执行归档或删除操作', 'Set another bot as your primary assistant first before archiving or deleting this one'),
    };
  }

  if (body.includes('已归档') || lower.includes('archived')) {
    return {
      tone: 'warning',
      title: t('该智能体处于归档只读状态', 'Bot is Archived (Read-Only)'),
      description: t('请先恢复该智能体，即可继续发送消息或设为主助手', 'Unarchive this bot first to resume chatting or set it as primary'),
    };
  }

  // 8. Voice & Speech errors
  if (
    body.includes('未识别到语音') ||
    body.includes('未检测到语音') ||
    lower.includes('no speech')
  ) {
    return {
      tone: 'warning',
      title: t('未听清您说的话', 'No Speech Detected'),
      description: t('请靠近麦克风并清晰说话后再试一次', 'Please speak clearly near the microphone and try again'),
    };
  }

  if (body.includes('麦克风') || lower.includes('microphone')) {
    return {
      tone: 'danger',
      title: t('无法使用麦克风', 'Microphone Unavailable'),
      description: body.includes('权限')
        ? t('请在系统设置中授予应用麦克风录音权限', 'Please grant microphone permission in Android system settings')
        : t('麦克风可能被其他应用占用，请关闭其他录音应用后重试', 'Microphone may be in use by another app. Close other audio apps and retry'),
    };
  }

  if (body.includes('语音识别') || body.includes('语音合成') || body.includes('朗读')) {
    return {
      tone: 'warning',
      title: body,
      description: t('您可以在「设置 → 模型与语音」中检查语音服务配置', 'Check your speech service configuration in Settings → Models & Voice'),
    };
  }

  // 9. Virtual Screen (Shower) errors
  if (code === 'SHOWER_PERMISSION_REQUIRED') {
    return {
      tone: 'warning',
      title: t('虚拟屏缺少权限', 'Virtual Screen Permission Required'),
      description: t('请在目标设备上授予所需权限。Android：打开 PiBot「设置 → 通知与后台运行 → Shizuku」，点击「授权」后重试。', 'Grant the required permission on the target device. On Android, open PiBot Settings → Notifications & Background → Shizuku, then tap Grant and retry.'),
      detail,
    };
  }

  if (code === 'SHOWER_CAPTURE_BLOCKED') {
    return {
      tone: 'warning',
      title: t('系统阻止了虚拟屏截图', 'Virtual Screen Capture Blocked'),
      description: t('请在目标虚拟屏内收起密码键盘或关闭受保护窗口，然后重新截图。', 'Dismiss the password keyboard or protected window in the target virtual screen, then capture again.'),
      detail,
    };
  }

  if (code === 'SHOWER_CAPTURE_TIMEOUT') {
    return {
      tone: 'warning',
      title: t('等待虚拟屏截图超时', 'Virtual Screen Capture Timed Out'),
      description: t('请稍后重新截图；若刚打开密码键盘，请先在目标虚拟屏内收起键盘。', 'Capture again shortly. If you just opened a password keyboard, dismiss it in the target virtual screen first.'),
      detail,
    };
  }

  if (code === 'SHOWER_CAPTURE_FAILED') {
    return {
      tone: 'warning',
      title: t('未能获取虚拟屏画面', 'Virtual Screen Capture Failed'),
      description: t('请重新截图。之前的输入操作不会自动重放。', 'Capture again. Previous input actions will not be replayed automatically.'),
      detail,
    };
  }

  if (code === 'SHOWER_UNAVAILABLE') {
    return {
      tone: 'warning',
      title: t('虚拟屏服务不可用', 'Virtual Screen Service Unavailable'),
      description: t('请在目标设备上检查虚拟屏服务。Android：先在 Shizuku 管理器中启动服务，再返回 PiBot 重试。', 'Check the virtual screen service on the target device. On Android, start Shizuku in its manager, then return to PiBot and retry.'),
      detail,
    };
  }

  if (
    code === 'SHOWER_BACKEND_FAILED' ||
    body.includes('虚拟屏') ||
    body.includes('还没有活跃的虚拟屏幕') ||
    lower.includes('virtual screen')
  ) {
    return {
      tone: 'warning',
      title: t('虚拟桌面暂未就绪', 'Virtual Screen Not Ready'),
      description:
        body && !body.includes('SHOWER_BACKEND_FAILED')
          ? body
          : t('请确认 Shizuku 服务已授权运行，或点击右上角菜单重新启动屏幕', 'Ensure Shizuku permission is active, or start the screen from the top-right menu'),
      detail,
    };
  }

  // 10. Multi-device directory sync aggregate error
  if (body.includes(' · ') && /[a-zA-Z0-9_-]+:\s/.test(body)) {
    return {
      tone: 'warning',
      title: t('部分远程节点同步未完成', 'Some Remote Nodes Could Not Sync'),
      description: t('已为您展示最近缓存的智能体列表，可展开查看具体节点原因', 'Showing cached bots while some remote nodes are unreachable'),
      detail: raw,
    };
  }

  // 11. JS runtime exceptions (TypeError / ReferenceError / SyntaxError): raw engine
  // messages are meaningless to users; original text stays inspectable via detail.
  if (
    lower.includes('cannot read properties of') ||
    lower.includes('is not iterable') ||
    lower.includes('is not a function') ||
    lower.includes('is not defined') ||
    lower.includes('is undefined') ||
    lower.includes('undefined is not an object') ||
    lower.includes('unexpected token') ||
    lower.includes('json.parse')
  ) {
    return {
      tone: 'danger',
      title: t('数据加载出错', 'Failed to Load Data'),
      description: t('返回的数据格式不正确，请下拉刷新或稍后重试', 'The response was malformed. Pull to refresh or try again later'),
      detail: raw,
    };
  }

  // Default fallback: clean title without ugly raw code prefix
  const fallbackTitle =
    code && !/[\u3400-\u9fff]/.test(body)
      ? t('操作未能完成', 'Operation Could Not Complete')
      : contextPrefix && body
      ? `${contextPrefix}：${body}`
      : body || contextPrefix || t('操作未能完成', 'Operation Could Not Complete');
  return {
    tone: 'danger',
    title: fallbackTitle,
    detail: code ? raw : extractedDetail || undefined,
  };
}

export function useAction() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setError('');
    setBusy(true);
    try {
      return await operation();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return { error, setError, busy, run };
}

export interface ErrorNoticeProps {
  error?: string | null;
  tone?: NoticeTone;
  title?: string;
  description?: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  compact?: boolean;
  darkGlass?: boolean;
}

export function ErrorNotice({
  error,
  tone: toneOverride,
  title: titleOverride,
  description: descOverride,
  detail: detailOverride,
  actionLabel,
  onAction,
  onDismiss,
  compact = false,
  darkGlass = false,
}: ErrorNoticeProps) {
  const t = useText();
  const [showDetail, setShowDetail] = useState(false);
  const parsed = error ? humanizeError(error, t) : null;
  if (!parsed && !titleOverride) return null;

  const tone = toneOverride ?? parsed?.tone ?? 'danger';
  const title = titleOverride ?? parsed?.title ?? '';
  const description = descOverride ?? parsed?.description;
  const detail = detailOverride ?? parsed?.detail;
  const spinning = parsed?.spinning ?? false;

  const renderIcon = () => {
    if (spinning) return <RefreshCw className="grok-notice-icon grok-spin" size={18} />;
    if (tone === 'success') return <CheckCircle2 className="grok-notice-icon" size={18} />;
    if (tone === 'warning') return <TriangleAlert className="grok-notice-icon" size={18} />;
    if (tone === 'info') return <Info className="grok-notice-icon" size={18} />;
    return <CircleAlert className="grok-notice-icon" size={18} />;
  };

  return (
    <div
      className={`inline-error grok-notice-card is-${tone}${compact ? ' is-compact' : ''}${darkGlass ? ' is-dark-glass' : ''}`}
      role={tone === 'info' || tone === 'success' ? 'status' : 'alert'}
      aria-live="polite"
    >
      <div className="grok-notice-main">
        <div className="grok-notice-icon-wrap" aria-hidden="true">
          {renderIcon()}
        </div>
        <div className="grok-notice-content">
          <div className="grok-notice-title">{title}</div>
          {description && <div className="grok-notice-desc">{description}</div>}
          {detail && (
            <div className="grok-notice-detail-wrap">
              <button
                type="button"
                className="grok-notice-detail-toggle"
                onClick={() => setShowDetail(v => !v)}
                aria-expanded={showDetail}
              >
                <span>{showDetail ? t('收起详情', 'Hide details') : t('查看详情', 'Details')}</span>
                {showDetail ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              {showDetail && <pre className="grok-notice-detail-code">{detail}</pre>}
            </div>
          )}
        </div>
        {(actionLabel && onAction) || onDismiss ? (
          <div className="grok-notice-actions">
            {actionLabel && onAction && (
              <button type="button" className="grok-notice-action-pill" onClick={onAction}>
                {actionLabel}
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                className="grok-notice-dismiss-btn"
                aria-label={t('关闭提示', 'Dismiss')}
                onClick={onDismiss}
              >
                <X size={15} />
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function FloatingPillToast({
  message,
  tone: toneOverride,
  actionLabel,
  onAction,
  onDismiss,
}: {
  message?: string;
  tone?: NoticeTone;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}) {
  const t = useText();
  if (!message) return null;
  const parsed = humanizeError(message, t);
  if (!parsed) return null;
  const tone = toneOverride ?? parsed.tone;
  const renderIcon = () => {
    if (parsed.spinning) return <RefreshCw className="grok-toast-icon grok-spin" size={16} />;
    if (tone === 'success') return <CheckCircle2 className="grok-toast-icon" size={16} />;
    if (tone === 'warning') return <TriangleAlert className="grok-toast-icon" size={16} />;
    if (tone === 'info') return <Info className="grok-toast-icon" size={16} />;
    return <CircleAlert className="grok-toast-icon" size={16} />;
  };

  return (
    <div className={`bot-chat-toast grok-pill-toast is-${tone}`} role="status" aria-atomic="true">
      {renderIcon()}
      <div className="grok-pill-toast-body">
        <span className="grok-pill-toast-title">{parsed.title}</span>
        {parsed.description && <span className="grok-pill-toast-desc">{parsed.description}</span>}
      </div>
      {actionLabel && onAction && (
        <button type="button" className="grok-pill-toast-action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          className="grok-pill-toast-close"
          aria-label={t('关闭', 'Close')}
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
