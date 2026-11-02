import { createContext, useCallback, useContext, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Info, RefreshCw, TriangleAlert, X } from 'lucide-react';

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

export function humanizeError(rawInput: unknown, t: (zh: string, en: string) => string): HumanizedError | null {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : errorText(rawInput).trim();
  if (!raw) return null;

  let code = '';
  let body = raw;
  const codeMatch = raw.match(KNOWN_CODE_PREFIX);
  if (codeMatch) {
    code = codeMatch[1];
    body = codeMatch[2].trim();
  }

  let extractedDetail = '';
  const reqMatch = body.match(/^(.*?)\s*·\s*(requestId\s+\S+|p-[a-z0-9-]+.*|[0-9a-f]{8}-[0-9a-f-]{12,}.*)$/i);
  if (reqMatch && reqMatch[1].trim()) {
    body = reqMatch[1].trim();
    extractedDetail = reqMatch[2].trim();
  }

  const lower = `${code} ${body}`.toLowerCase();
  const detail =
    [code ? `Code: ${code}` : '', extractedDetail, body !== raw && code ? raw : '']
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
    code === 'EVENT_STREAM_CLOSED' ||
    code === 'STREAM_CLOSED' ||
    code === 'TRANSPORT_RESET' ||
    body.includes('事件流未就绪') ||
    body.includes('准入前事件缓冲溢出')
  ) {
    return {
      tone: 'warning',
      title: t('实时同步通道已中断', 'Live Sync Interrupted'),
      description: t('正在尝试恢复实时消息流，您也可以下拉刷新或重新进入页面', 'Attempting to restore live updates; pull to refresh if needed'),
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

  if (
    body === 'Remote target unavailable' ||
    body === 'Not connected' ||
    body === 'Original connection unavailable' ||
    body.includes('无法连接目标节点') ||
    lower.includes('target host unavailable') ||
    body.includes('目标设备离线，已拒绝修改') ||
    body.includes('所选设备不可用')
  ) {
    return {
      tone: 'warning',
      title: t('无法连接到目标设备', 'Target Device Unreachable'),
      description: t('请确认远程节点在线且网络连接正常后再执行此操作', 'Ensure the remote host is online and connected before trying again'),
      detail,
    };
  }

  // 6. Model & Generation errors
  if (
    body === 'model_error' ||
    body.includes('模型生成失败') ||
    lower.includes('model generation failed')
  ) {
    return {
      tone: 'danger',
      title: t('未能生成回复', 'Reply Generation Failed'),
      description: t('模型服务未正常响应，请重试或检查模型与 API 密钥配置', 'The model provider did not respond properly. Retry or check your model settings'),
      detail: body !== 'model_error' ? detail : undefined,
    };
  }

  if (body.includes('本次请求未获得回答') || lower.includes('no answer was generated')) {
    return {
      tone: 'warning',
      title: t('本次对话未返回内容', 'No Response Received'),
      description: t('生成过程已结束但未返回有效回复，您可以重新发送试一次', 'Generation ended without a reply. Please try sending your message again'),
    };
  }

  // 7. Bot lifecycle & protection rules
  if (body.includes('主智能体受保护') || lower.includes('primary bot is protected')) {
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

  // Default fallback: clean title without ugly raw code prefix
  return {
    tone: 'danger',
    title: body || t('操作未能完成', 'Operation Could Not Complete'),
    detail: code ? `${code}: ${body}` : extractedDetail || undefined,
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
  error?: string;
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
