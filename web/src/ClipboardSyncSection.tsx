// 设置页“剪贴板同步”共享分区：桌面 SettingsPanel 与 Android SettingsScreen 共用。
// 仅调用原生剪贴板同步命令，不读写 OS/浏览器剪贴板、不回显明文或原始错误、不记录参数或邀请码。
import { invoke } from '@tauri-apps/api/core';
import { CheckCircle2, CircleAlert, ClipboardCheck, KeyRound, Lock, Plus, RefreshCw, ShieldAlert, Unlock, Upload } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Badge, Row, Section, Switch, type BadgeTone } from './bot-settings/primitives';
import { useText } from './ui';
import './ClipboardSyncSection.css';

type SyncMode = 'automatic' | 'manual' | 'unsupported';
type SyncConnection =
  | 'off' | 'notPaired' | 'connecting' | 'online' | 'offline' | 'unauthorized' | 'unsupported' | 'certificateError';

interface SyncStatus {
  enabled: boolean;
  configured: boolean;
  mode: SyncMode;
  connection: SyncConnection;
  backgroundAuthorized?: boolean;
}

interface SyncResponse { status: SyncStatus; code?: string }

type SyncRequest =
  | { action: 'status' }
  | { action: 'setEnabled'; enabled: boolean }
  | { action: 'newGroup' }
  | { action: 'joinGroup'; code: string }
  | { action: 'showCode' }
  | { action: 'sendNow' }
  | { action: 'authorizeBackground' }
  | { action: 'revokeBackground' };

type SyncAction = SyncRequest['action'];
type ErrorKind =
  | 'offline' | 'notPaired' | 'requiresNewCenter' | 'permission' | 'unsupported'
  | 'unauthorized' | 'certificateError' | 'invalidCode' | 'notConfigured' | 'emptyClipboard' | 'unknown';
type Translate = (zh: string, en: string) => string;
interface SafeNotice { kind: ErrorKind; tone: 'danger' | 'warning'; title: string; detail: string }

const VALID_MODES = new Set<SyncMode>(['automatic', 'manual', 'unsupported']);
const VALID_CONNECTIONS = new Set<SyncConnection>([
  'off', 'notPaired', 'connecting', 'online', 'offline', 'unauthorized', 'unsupported', 'certificateError',
]);
const MOBILE_ONLY = new Set<SyncAction>(['sendNow', 'authorizeBackground', 'revokeBackground']);
const INVALIDATES_ONLINE = new Set<ErrorKind>([
  'offline', 'notPaired', 'requiresNewCenter', 'unauthorized', 'certificateError', 'unsupported',
]);
const ERROR_PATTERNS: ReadonlyArray<readonly [ErrorKind, RegExp]> = [
  ['certificateError', /\b(cert|certificate|tls|ssl|x509|untrusted_cert)\b|certificate_error|cert_error/],
  ['unauthorized', /\b(unauthorized|auth_failed|invalid_token|revoked|401)\b/],
  ['notPaired', /not_paired|unpaired|device_not_paired|no_center|center_not_configured|not paired/],
  ['requiresNewCenter', /requires_new_center|center_unsupported|unsupported_center|center_upgrade|upgrade_center|center_version|protocol_unsupported|requires new center|newer center|upgrade center|center does not support|\b(404|501)\b/],
  ['permission', /permission|shizuku|foreground|window_focus|background_clipboard|access_denied|access denied|eacces|eperm|\b403\b/],
  ['unsupported', /unsupported|not_supported|not supported|unknown_command|command_not_found|unknown_method|method_not_found|not_implemented|not implemented/],
  ['offline', /offline|unreachable|timeout|timed_out|timed out|disconnected|network|econnrefused|enotfound|\b(502|503|504)\b/],
  ['invalidCode', /invalid_code|bad_code|invalid_group|malformed_code|invalid code|invalid group/],
  ['notConfigured', /not_configured|no_group|group_not_set|not configured|no group/],
  ['emptyClipboard', /empty_clipboard|no_clipboard|clipboard_empty|non_text|clipboard is empty|no text/],
];

function normalizeResponse(raw: unknown, allowCode: boolean): SyncResponse {
  const env = raw && typeof raw === 'object' ? (raw as { status?: unknown; code?: unknown }) : null;
  const s = env?.status && typeof env.status === 'object' ? (env.status as Record<string, unknown>) : null;
  if (
    !s || typeof s.enabled !== 'boolean' || typeof s.configured !== 'boolean' ||
    typeof s.mode !== 'string' || !VALID_MODES.has(s.mode as SyncMode) ||
    typeof s.connection !== 'string' || !VALID_CONNECTIONS.has(s.connection as SyncConnection)
  ) {
    throw { code: 'INVALID_RESPONSE' };
  }
  const status: SyncStatus = {
    enabled: s.enabled,
    configured: s.configured,
    mode: s.mode as SyncMode,
    connection: s.connection as SyncConnection,
    ...(typeof s.backgroundAuthorized === 'boolean' ? { backgroundAuthorized: s.backgroundAuthorized } : {}),
  };
  const code = allowCode && typeof env?.code === 'string' && env.code.trim() ? env.code.trim() : undefined;
  return code ? { status, code } : { status };
}

async function callNative(variant: 'desktop' | 'mobile', request: SyncRequest): Promise<SyncResponse> {
  if (variant === 'desktop') {
    if (MOBILE_ONLY.has(request.action)) throw { code: 'UNSUPPORTED' };
    return normalizeResponse(await invoke<unknown>('desktop_clipboard_sync', { request }), request.action === 'showCode');
  }
  return normalizeResponse(
    await invoke<unknown>('mobile_host_request', { method: 'clipboardSync', params: request }),
    request.action === 'showCode',
  );
}

/** 仅内部分类，绝不回显原始错误消息、参数或敏感内容。 */
function classifyError(error: unknown): ErrorKind {
  let code = '';
  let msg = '';
  if (typeof error === 'string') msg = error;
  else if (error instanceof Error) {
    msg = error.message;
    if ('code' in error && typeof (error as { code?: unknown }).code === 'string') code = (error as { code: string }).code;
  } else if (error && typeof error === 'object') {
    const o = error as { code?: unknown; message?: unknown; data?: { code?: unknown } };
    code = typeof o.code === 'string' ? o.code : typeof o.data?.code === 'string' ? o.data.code : '';
    if (typeof o.message === 'string') msg = o.message;
  }
  const probe = `${code} ${msg}`.toLowerCase();
  return ERROR_PATTERNS.find(([, re]) => re.test(probe))?.[0] ?? 'unknown';
}

function safeErrorNotice(kind: ErrorKind, action: SyncAction, t: Translate): SafeNotice {
  const map: Record<ErrorKind, Omit<SafeNotice, 'kind'>> = {
    offline: { tone: 'warning', title: t('剪贴板同步离线', 'Clipboard sync offline'), detail: t('无法连接中心剪贴板同步通道，与本机 Host / Bot 状态相互独立。', 'Cannot reach the Center clipboard sync channel (independent of Host/Bot).') },
    notPaired: { tone: 'warning', title: t('设备未配对中心', 'Device not paired'), detail: t('请先在“中心连接”中完成设备配对，再使用剪贴板同步。', 'Pair this device in Center Connection before using clipboard sync.') },
    requiresNewCenter: { tone: 'warning', title: t('需要新版 PiBot 中心', 'Requires newer Center'), detail: t('当前中心版本不支持剪贴板同步，请升级中心后重试。', 'The connected Center does not support clipboard sync. Upgrade Center and retry.') },
    permission: { tone: 'warning', title: t('缺少剪贴板或 Shizuku 权限', 'Clipboard or Shizuku permission required'), detail: action === 'authorizeBackground' ? t('未检测到可用的 Shizuku 授权。请先在“本机与权限”中完成 Shizuku 授权后重试。', 'Shizuku authorization is not ready. Grant Shizuku in Device & Permissions first.') : t('系统限制了剪贴板访问。请检查权限并在前台重试。', 'OS restricted clipboard access. Check permissions and retry in foreground.') },
    unsupported: { tone: 'warning', title: t('当前设备不支持剪贴板同步', 'Clipboard sync unsupported'), detail: t('当前平台或客户端版本不支持该操作。', 'This platform or client build does not support this operation.') },
    unauthorized: { tone: 'danger', title: t('中心授权无效', 'Authorization failed'), detail: t('设备凭据被中心拒绝，请在“中心连接”中检查或重新配对。', 'Device credentials were rejected by Center. Check or re-pair in Center Connection.') },
    certificateError: { tone: 'danger', title: t('中心证书校验失败', 'Certificate error'), detail: t('无法验证中心 HTTPS 证书，请检查自定义 CA 配置。', 'Could not verify the Center TLS certificate. Check your custom CA setting.') },
    invalidCode: { tone: 'danger', title: t('邀请码无效', 'Invalid group code'), detail: t('请核对邀请码后重新输入。', 'Check the group code and try again.') },
    notConfigured: { tone: 'warning', title: t('尚未配置同步组', 'No sync group configured'), detail: t('请先创建新的同步组或输入邀请码加入。', 'Create a new sync group or join one with a group code first.') },
    emptyClipboard: { tone: 'warning', title: t('当前剪贴板无纯文本', 'No text in clipboard'), detail: t('系统剪贴板为空或不包含可同步的文本内容。', 'The system clipboard is empty or has no syncable plain text.') },
    unknown: { tone: 'danger', title: t('剪贴板同步操作失败', 'Clipboard sync action failed'), detail: t('未能完成该操作，请检查状态后重试。', 'Could not complete the action. Check status and try again.') },
  };
  return { kind, ...map[kind] };
}

function describeStatus(status: SyncStatus | null, loading: boolean, error: SafeNotice | null, t: Translate): { tone: BadgeTone; label: string; detail: string; isOnline: boolean } {
  if (!status) {
    if (loading) return { tone: 'neutral', label: t('正在读取…', 'Checking…'), detail: t('正在读取本设备剪贴板同步状态。', 'Reading clipboard sync status for this device.'), isOnline: false };
    if (error) return { tone: error.tone, label: error.title, detail: error.detail, isOnline: false };
    return { tone: 'neutral', label: t('状态未读取', 'Status unavailable'), detail: t('尚未获取到剪贴板同步状态。', 'Clipboard sync status has not been loaded yet.'), isOnline: false };
  }
  if (status.mode === 'unsupported') return { tone: 'warning', label: t('当前设备不支持', 'Unsupported'), detail: t('当前平台或客户端不支持剪贴板同步。', 'Clipboard sync is not supported on this device.'), isOnline: false };
  if (status.connection === 'notPaired') return { tone: 'warning', label: t('未配对', 'Not paired'), detail: status.configured ? t('设备尚未绑定中心，请先在“中心连接”中配对。', 'Pair this device in Center Connection first.') : t('尚未配对中心或尚未加入同步组。', 'Pair with Center and create or join a sync group.'), isOnline: false };
  if (status.connection === 'unsupported') return { tone: 'warning', label: t('需要新版中心', 'Requires newer Center'), detail: t('当前连接的中心不支持剪贴板同步，请升级中心。', 'Upgrade PiBot Center to use clipboard sync.'), isOnline: false };
  if (status.connection === 'certificateError') return { tone: 'danger', label: t('证书校验失败', 'Certificate error'), detail: t('无法验证中心 HTTPS 证书，请检查自定义 CA。', 'Could not verify the Center TLS certificate.'), isOnline: false };
  if (status.connection === 'unauthorized') return { tone: 'danger', label: t('授权无效', 'Unauthorized'), detail: t('中心拒绝了当前设备的剪贴板同步凭据。', 'Center rejected this device’s clipboard sync credentials.'), isOnline: false };
  if (status.connection === 'offline') return { tone: 'warning', label: t('同步离线', 'Sync offline'), detail: t('剪贴板同步通道离线（与本机 Host / Bot 状态相互独立）。', 'Clipboard sync channel is offline (independent of Host/Bot).'), isOnline: false };
  if (!status.enabled) return { tone: 'neutral', label: t('已关闭', 'Off'), detail: status.configured ? t('同步开关关闭；邀请组已保存，开启开关即可连接。', 'Sync is off; group is saved. Turn on the switch to connect.') : t('默认关闭；先创建或加入邀请组，再手动开启开关。', 'Off by default; create or join a group, then turn on the switch.'), isOnline: false };
  if (!status.configured) return { tone: 'neutral', label: t('未配置同步组', 'No sync group'), detail: t('同步开关已开启，但尚未创建或加入同步组。', 'Switch is on, but no sync group is configured yet.'), isOnline: false };
  if (status.connection === 'connecting') return { tone: 'accent', label: t('正在连接…', 'Connecting…'), detail: t('正在建立剪贴板同步通道，尚未在线。', 'Connecting clipboard sync channel; not online yet.'), isOnline: false };
  if (status.connection === 'online') {
    return {
      tone: 'success',
      label: t('同步在线', 'Sync online'),
      detail: status.mode === 'manual'
        ? t('剪贴板同步在线。远端接收已就绪，发送本机文本请点击“立即发送当前剪贴板”。', 'Clipboard sync is online. Tap "Send current clipboard now" to push from this device.')
        : t('剪贴板同步在线，自动与同组设备同步文本剪贴板。', 'Clipboard sync is online and syncing text automatically with your group.'),
      isOnline: true,
    };
  }
  return { tone: 'neutral', label: t('已关闭', 'Off'), detail: t('剪贴板同步通道未连接。', 'Clipboard sync channel is inactive.'), isOnline: false };
}

function modeText(status: SyncStatus | null, variant: 'desktop' | 'mobile', t: Translate): string {
  if (!status) return '—';
  if (status.mode === 'automatic') return variant === 'mobile' ? t('自动同步（后台监听）', 'Automatic (background)') : t('自动同步', 'Automatic');
  if (status.mode === 'manual') return variant === 'mobile' && status.backgroundAuthorized ? t('手动发送（自动模式已降级）', 'Manual fallback') : t('手动发送', 'Manual send');
  return t('不支持', 'Unsupported');
}

export function ClipboardSyncSection({ variant }: { variant: 'desktop' | 'mobile' }) {
  const t = useText();
  const joinInputId = useId();
  const joinInputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<SyncAction | null>(null);
  const [errorNotice, setErrorNotice] = useState<SafeNotice | null>(null);
  const [infoNotice, setInfoNotice] = useState('');
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [confirmNewGroup, setConfirmNewGroup] = useState(false);
  const [bgPromptOpen, setBgPromptOpen] = useState(false);
  const [bgConsent, setBgConsent] = useState(false);

  const mountedRef = useRef(true);
  const mutationRevRef = useRef(0);
  const statusSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);

  const clearSecretDraft = useCallback(() => {
    setJoinCode('');
    if (joinInputRef.current) joinInputRef.current.value = '';
  }, []);

  const applyStatus = useCallback((next: SyncStatus) => {
    setStatus(next);
    if (!next.configured || next.mode === 'unsupported') setRevealedCode(null);
    if (next.mode === 'unsupported') {
      clearSecretDraft();
      setJoinOpen(false);
      setConfirmNewGroup(false);
      setBgPromptOpen(false);
      setBgConsent(false);
    }
    if (next.backgroundAuthorized) { setBgPromptOpen(false); setBgConsent(false); }
  }, [clearSecretDraft]);

  const refreshStatus = useCallback(async (silent = false) => {
    const rev = mutationRevRef.current;
    const seq = ++statusSeqRef.current;
    if (!silent) { setLoading(true); setErrorNotice(null); }
    try {
      const res = await callNative(variant, { action: 'status' });
      if (!mountedRef.current || rev !== mutationRevRef.current || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      applyStatus(res.status);
      setErrorNotice(null);
    } catch (error) {
      if (!mountedRef.current || rev !== mutationRevRef.current || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      setStatus(prev => (prev && (prev.connection === 'online' || prev.connection === 'connecting') ? null : prev));
      setErrorNotice(safeErrorNotice(classifyError(error), 'status', t));
    } finally {
      if (mountedRef.current && rev === mutationRevRef.current) setLoading(false);
    }
  }, [applyStatus, t, variant]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatus(false);
    const hideCode = () => setRevealedCode(null);
    const onVisibility = () => { if (document.hidden) hideCode(); else if (mountedRef.current) void refreshStatus(true); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', hideCode);
    return () => {
      mountedRef.current = false;
      mutationRevRef.current += 1;
      setRevealedCode(null);
      setJoinCode('');
      setBgConsent(false);
      if (joinInputRef.current) joinInputRef.current.value = '';
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', hideCode);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.connection !== 'connecting' || busyAction !== null) return;
    const timer = setInterval(() => { if (!document.hidden && mountedRef.current) void refreshStatus(true); }, 2500);
    return () => clearInterval(timer);
  }, [status?.connection, busyAction, refreshStatus]);

  const runAction = useCallback(async (request: SyncRequest): Promise<SyncResponse | null> => {
    if (busyAction !== null) return null;
    const rev = ++mutationRevRef.current;
    setBusyAction(request.action);
    setErrorNotice(null);
    setInfoNotice('');
    try {
      const res = await callNative(variant, request);
      if (!mountedRef.current || rev !== mutationRevRef.current) return null;
      applyStatus(res.status);
      return res;
    } catch (error) {
      if (!mountedRef.current || rev !== mutationRevRef.current) return null;
      const kind = classifyError(error);
      if (INVALIDATES_ONLINE.has(kind)) {
        setStatus(prev => (prev && (prev.connection === 'online' || prev.connection === 'connecting') ? null : prev));
      }
      setErrorNotice(safeErrorNotice(kind, request.action, t));
      return null;
    } finally {
      if (mountedRef.current && rev === mutationRevRef.current) setBusyAction(null);
    }
  }, [applyStatus, busyAction, t, variant]);

  const executeNewGroup = async () => {
    setConfirmNewGroup(false); setRevealedCode(null); clearSecretDraft(); setJoinOpen(false);
    const res = await runAction({ action: 'newGroup' });
    if (!res || !mountedRef.current) return;
    setInfoNotice(res.status.enabled
      ? t('已创建新的同步组。需要配对其他设备时请点击“显示邀请码”。', 'Created a new sync group. Select "Show group code" to pair another device.')
      : t('已创建新的同步组。同步开关仍保持关闭，可按需手动开启。', 'Created a new sync group. The sync switch remains off until you turn it on.'));
  };

  const handleJoinSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = joinCode.trim();
    if (!trimmed) return;
    setRevealedCode(null);
    const res = await runAction({ action: 'joinGroup', code: trimmed });
    if (!res || !mountedRef.current) return;
    clearSecretDraft(); setJoinOpen(false); setConfirmNewGroup(false);
    setInfoNotice(res.status.enabled
      ? t('已保存并加入剪贴板同步组。', 'Saved and joined the clipboard sync group.')
      : t('已保存并加入同步组。同步开关仍保持关闭，开启开关后才会同步。', 'Saved and joined the sync group. Turn on the switch to start syncing.'));
  };

  const handleShowCode = async () => {
    if (revealedCode !== null) { setRevealedCode(null); return; }
    const res = await runAction({ action: 'showCode' });
    if (!res || !mountedRef.current) return;
    if (res.code) setRevealedCode(res.code);
    else setErrorNotice(safeErrorNotice('notConfigured', 'showCode', t));
  };

  const handleAuthorizeBg = async () => {
    if (variant !== 'mobile' || !bgConsent) return;
    const res = await runAction({ action: 'authorizeBackground' });
    if (!res || !mountedRef.current) return;
    setBgPromptOpen(false); setBgConsent(false);
    setInfoNotice(res.status.mode === 'automatic'
      ? t('已启用后台自动剪贴板同步（Shizuku）。', 'Enabled background auto clipboard sync (Shizuku).')
      : t('已记录后台授权，但当前仍处于手动回退模式；请检查 Shizuku 状态或使用“立即发送”。', 'Background consent saved, currently in manual fallback; verify Shizuku or use Send now.'));
  };

  const handleRevokeBg = async () => {
    if (variant !== 'mobile') return;
    const res = await runAction({ action: 'revokeBackground' });
    if (!res || !mountedRef.current) return;
    setBgPromptOpen(false); setBgConsent(false);
    setInfoNotice(t('已撤销后台自动同步授权，后续仅在点击“立即发送当前剪贴板”时发送。', 'Revoked background sync authorization. Sending now requires tapping "Send current clipboard now".'));
  };

  const presentation = describeStatus(status, loading, errorNotice, t);
  const busy = busyAction !== null;
  const unsupported = status?.mode === 'unsupported';
  const toggleDisabled = busy || loading || status === null || (unsupported && !status.enabled);
  const groupDisabled = busy || loading || status === null || unsupported;
  const primaryBtn = variant === 'desktop' ? 'primary-button' : 'hst-btn is-primary';
  const secondaryBtn = variant === 'desktop' ? 'secondary-button' : 'hst-btn';
  const statusPillClass = presentation.tone === 'success' ? 'online' : presentation.tone === 'neutral' ? 'muted' : 'warn';

  const feedback = errorNotice ? (
    <div className={`cs-banner is-${errorNotice.tone}`} role="alert">
      <ShieldAlert size={16} aria-hidden="true" />
      <div className="cs-banner-body"><span className="cs-banner-title">{errorNotice.title}</span><span className="cs-banner-detail">{errorNotice.detail}</span></div>
    </div>
  ) : infoNotice ? (
    <div className="cs-banner is-success" role="status">
      <CheckCircle2 size={16} aria-hidden="true" />
      <div className="cs-banner-body"><span className="cs-banner-detail">{infoNotice}</span></div>
    </div>
  ) : null;

  const groupControls = (
    <>
      <div className="cs-actions">
        <button type="button" className={primaryBtn} disabled={groupDisabled} onClick={() => (status?.configured ? setConfirmNewGroup(true) : void executeNewGroup())}>
          <Plus size={14} aria-hidden="true" /> {busyAction === 'newGroup' ? t('正在创建…', 'Creating…') : status?.configured ? t('新建并更换组', 'Create new group') : t('创建同步组', 'Create group')}
        </button>
        <button type="button" className={secondaryBtn} disabled={groupDisabled} aria-expanded={joinOpen} onClick={() => { setConfirmNewGroup(false); if (joinOpen) { clearSecretDraft(); setJoinOpen(false); } else setJoinOpen(true); }}>
          <KeyRound size={14} aria-hidden="true" /> {t('输入邀请码加入', 'Join with code')}
        </button>
        {status?.configured && (
          <button type="button" className={secondaryBtn} disabled={groupDisabled} onClick={() => void handleShowCode()}>
            {revealedCode !== null ? <><Lock size={14} aria-hidden="true" /> {t('隐藏邀请码', 'Hide code')}</> : <><Unlock size={14} aria-hidden="true" /> {busyAction === 'showCode' ? t('读取中…', 'Loading…') : t('显示邀请码', 'Show group code')}</>}
          </button>
        )}
      </div>

      {confirmNewGroup && (
        <div className="cs-box is-warn" role="group" aria-label={t('确认新建同步组', 'Confirm creating a new group')}>
          <p className="cs-note">{t('新建组会替换本机保存的邀请码，不会自动打开同步开关。', 'Creating a new group replaces this device’s saved code without turning sync on.')}</p>
          <div className="cs-actions">
            <button type="button" className={secondaryBtn} disabled={busy} onClick={() => setConfirmNewGroup(false)}>{t('取消', 'Cancel')}</button>
            <button type="button" className={primaryBtn} disabled={busy} onClick={() => void executeNewGroup()}>{t('确认新建组', 'Confirm new group')}</button>
          </div>
        </div>
      )}

      {joinOpen && (
        <form className={variant === 'desktop' ? 'cs-box' : undefined} onSubmit={e => void handleJoinSubmit(e)}>
          <label className={variant === 'desktop' ? 'cs-note' : 'hst-input-row'} htmlFor={joinInputId}>
            <span className={variant === 'desktop' ? undefined : 'hst-input-label'}>{variant === 'desktop' ? t('同步组邀请码（已遮罩）', 'Sync group code (masked)') : t('邀请码', 'Group code')}</span>
            {variant === 'mobile' && (
              <input ref={joinInputRef} id={joinInputId} type="password" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} className="hst-input" disabled={busy} value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder={t('输入同步组邀请码', 'Enter group code')} />
            )}
          </label>
          {variant === 'desktop' && (
            <input ref={joinInputRef} id={joinInputId} type="password" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} className="cs-input" disabled={busy} value={joinCode} onChange={e => setJoinCode(e.target.value)} placeholder={t('输入另一台设备显示的邀请码', 'Enter the group code shown on another device')} />
          )}
          <div className={variant === 'desktop' ? 'cs-actions' : 'hst-actions'}>
            <button type="button" className={secondaryBtn} disabled={busy} onClick={() => { clearSecretDraft(); setJoinOpen(false); }}>{t('取消', 'Cancel')}</button>
            <button type="submit" className={primaryBtn} disabled={busy || !joinCode.trim()}>{busyAction === 'joinGroup' ? t('正在加入…', 'Joining…') : t('保存并加入', 'Join group')}</button>
          </div>
        </form>
      )}

      {revealedCode !== null && (
        <div className="cs-box" role="region" aria-label={t('剪贴板同步邀请码', 'Clipboard sync group code')}>
          <div className="cs-box-head">
            <span className="cs-note">{t('当前同步组邀请码', 'Current group code')}</span>
            <button type="button" className={secondaryBtn} onClick={() => setRevealedCode(null)}><Lock size={13} aria-hidden="true" /> {t('隐藏', 'Hide')}</button>
          </div>
          <code className="cs-code">{revealedCode}</code>
          <p className="cs-note">{t('邀请码不会自动写入剪贴板，失焦或离开页面时自动隐藏。', 'Not automatically copied to clipboard; hides automatically on blur or leaving this page.')}</p>
        </div>
      )}
    </>
  );

  if (variant === 'desktop') {
    return (
      <div className="cs-root">
        <section className="settings-section">
          <div className="section-head">
            <h4>{t('本机开关与通道状态', 'Device Switch & Status')}</h4>
            <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => void refreshStatus(false)}><RefreshCw size={13} aria-hidden="true" /> {t('刷新', 'Refresh')}</button>
          </div>
          <div className="settings-row-group">
            <label className="settings-row settings-row-link">
              <span className="settings-row-label">
                <span>{t('启用本设备剪贴板同步', 'Enable clipboard sync on this device')}</span>
                <span className="metadata" style={{ display: 'block', fontSize: 12 }}>{t('独立设备开关，默认关闭；与 Host / Bot 状态分开。', 'Separate per-device switch, off by default; independent of Host/Bot status.')}</span>
              </span>
              <Switch label={t('启用本设备剪贴板同步', 'Enable clipboard sync on this device')} checked={Boolean(status?.enabled)} disabled={toggleDisabled} onChange={next => void runAction({ action: 'setEnabled', enabled: next })} />
            </label>
            <div className="settings-row"><span className="settings-row-label">{t('同步通道状态', 'Sync channel')}</span><span className={`host-status-pill ${statusPillClass}`} role="status"><span className="host-status-dot" aria-hidden="true" />{presentation.label}</span></div>
            <div className="settings-row"><span className="settings-row-label">{t('同步模式', 'Sync mode')}</span><span className="metadata">{modeText(status, 'desktop', t)}</span></div>
            <div className="settings-row"><span className="settings-row-label">{t('同步组', 'Sync group')}</span><span className="metadata">{status === null ? '—' : status.configured ? t('已配置', 'Configured') : t('未配置', 'Not configured')}</span></div>
          </div>
          <p className="cs-note" style={{ marginTop: 8 }}>{presentation.detail}</p>
        </section>
        {feedback}
        <section className="settings-section">
          <h4>{t('邀请组配对', 'Group Pairing')}</h4>
          <p className="cs-note" style={{ marginBottom: 8 }}>{t('每台设备只需配置一次邀请组；新建或加入不会隐式开启同步开关。', 'Configure an invitation group once per device; creating or joining never implicitly enables sync.')}</p>
          <div className="cs-root">{groupControls}</div>
        </section>
      </div>
    );
  }

  const canSendNow = !busy && !loading && presentation.isOnline;
  const bgAuthorized = Boolean(status?.backgroundAuthorized);

  return (
    <div className="cs-root">
      <Section title={t('剪贴板同步', 'Clipboard Sync')} action={<button type="button" className="bs-link" disabled={busy || loading} onClick={() => void refreshStatus(false)}>{t('刷新', 'Refresh')}</button>}>
        <Row icon={<ClipboardCheck />} title={t('启用本设备剪贴板同步', 'Enable on this device')} subtitle={t('独立设备开关，默认关闭；与本机 Host / Bot 分开。', 'Separate per-device switch, off by default; independent of Host/Bot.')} trailing={<Switch label={t('启用本设备剪贴板同步', 'Enable on this device')} checked={Boolean(status?.enabled)} disabled={toggleDisabled} onChange={next => void runAction({ action: 'setEnabled', enabled: next })} />} />
        <Row icon={<CircleAlert />} title={t('同步通道状态', 'Sync channel')} subtitle={presentation.detail} trailing={<Badge tone={presentation.tone}>{presentation.label}</Badge>} />
        <div className="hst-row-static"><span className="bs-row-sub">{t('当前模式', 'Actual mode')}</span><span className="bs-row-title" style={{ marginLeft: 'auto' }}>{modeText(status, 'mobile', t)}</span></div>
        <div className="hst-row-static"><span className="bs-row-sub">{t('同步组', 'Sync group')}</span><span className="bs-row-title" style={{ marginLeft: 'auto' }}>{status === null ? '—' : status.configured ? t('已配置', 'Configured') : t('未配置', 'Not configured')}</span></div>
      </Section>

      <Section title={t('手动发送当前剪贴板', 'Send Current Clipboard')}>
        <div className="cs-pad">
          <button type="button" className="hst-btn is-primary cs-send-btn" disabled={!canSendNow} onClick={() => void runAction({ action: 'sendNow' }).then(res => { if (res && mountedRef.current) setInfoNotice(t('已发送当前文本剪贴板到同步组。', 'Sent current text clipboard to your sync group.')); })}>
            <Upload size={16} aria-hidden="true" /> {busyAction === 'sendNow' ? t('正在发送…', 'Sending…') : t('立即发送当前剪贴板', 'Send current clipboard now')}
          </button>
          <p className="cs-note">{canSendNow ? t('在前台点击可将当前纯文本剪贴板直接发送到同组设备（自动同步降级时也可随时使用）。', 'Tap in foreground to push current plain text to your group (also works in manual fallback).') : t('开启同步并显示“同步在线”后即可手动发送当前剪贴板。', 'Available once clipboard sync is enabled and online.')}</p>
        </div>
      </Section>

      <Section title={t('后台自动同步（可选 · Shizuku）', 'Background Auto-Sync (Optional · Shizuku)')} hint={t('仅在用户主动确认后生效，不会自动弹窗申请权限。', 'Only enabled after explicit confirmation; never requests permission automatically.')}>
        <div className="cs-pad">
          <p className="cs-note">
            {bgAuthorized
              ? status?.mode === 'automatic'
                ? t('已授权后台自动同步（当前模式：自动）。在其他应用中复制的文本可自动发送到同组设备。', 'Background auto-sync is authorized (mode: automatic). Text copied in other apps can be sent automatically.')
                : t('已授权后台自动同步，但当前回退为手动发送模式。请确认 Shizuku 权限仍有效，或使用上方“立即发送”。', 'Background sync is authorized, currently in manual fallback. Verify Shizuku permission or use Send now above.')
              : t('当前未授权后台监听（模式：手动发送）。如需在其他应用复制时自动同步，需先拥有 Shizuku 系统授权并明确同意。', 'Background listening is not authorized (mode: manual). Automatic sync requires an existing Shizuku grant and your explicit consent.')}
          </p>
          {bgAuthorized ? (
            <div className="cs-actions">
              <button type="button" className="hst-btn is-danger" disabled={groupDisabled} onClick={() => void handleRevokeBg()}>{busyAction === 'revokeBackground' ? t('正在撤销…', 'Revoking…') : t('撤销后台自动同步授权', 'Revoke background authorization')}</button>
            </div>
          ) : !bgPromptOpen ? (
            <div className="cs-actions">
              <button type="button" className="hst-btn" disabled={groupDisabled} onClick={() => { setBgConsent(false); setBgPromptOpen(true); }}>{t('授权后台自动同步…', 'Authorize background sync…')}</button>
            </div>
          ) : (
            <div className="cs-box is-warn" role="group" aria-label={t('确认授权后台剪贴板同步', 'Confirm background clipboard sync authorization')}>
              <p className="cs-note">{t('需要已在本机授予 Shizuku 系统权限，且启用后您在其他应用中复制的文本可能会自动发送到当前剪贴板同步组。', 'Requires an existing Shizuku grant on this device. Once authorized, text you copy in other apps can be sent automatically to your sync group.')}</p>
              <label className="cs-check">
                <input type="checkbox" checked={bgConsent} disabled={busy} onChange={e => setBgConsent(e.target.checked)} />
                <span>{t('我已授予 Shizuku 权限，并同意在其他应用中复制的文本可被发送。', 'I have granted Shizuku permission and consent that copies in other apps can be sent.')}</span>
              </label>
              <div className="cs-actions">
                <button type="button" className="hst-btn" disabled={busy} onClick={() => { setBgConsent(false); setBgPromptOpen(false); }}>{t('取消', 'Cancel')}</button>
                <button type="button" className="hst-btn is-primary" disabled={busy || !bgConsent} onClick={() => void handleAuthorizeBg()}>{busyAction === 'authorizeBackground' ? t('正在授权…', 'Authorizing…') : t('确认授权', 'Confirm authorization')}</button>
              </div>
            </div>
          )}
        </div>
      </Section>

      {feedback}

      <Section title={t('邀请组配对', 'Group Pairing')} hint={t('每台设备只需配置一次；新建或加入不会自动开启同步开关，邀请码仅在主动点击时显示。', 'Configure once per device; creating or joining never enables sync automatically, and codes show only on request.')}>
        <div className="cs-pad">{groupControls}</div>
      </Section>
    </div>
  );
}
