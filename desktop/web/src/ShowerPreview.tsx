// 统一 Shower 预览/接管面板：Android / Windows / Linux 共用同一份组件与协议类型。
// 平台差异只在 props.call 适配器（桌面 = RemoteControlMethodMap，Android 本机 = BotHost.call），
// 因此这里只 import type host-core 的公共数据形状，不引入任何 Node/平台句柄。
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CompositionEvent, KeyboardEvent, PointerEvent } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Maximize2, Minimize2, Monitor, X } from 'lucide-react';
import type {
  ShowerCapabilities,
  ShowerFrame,
  ShowerInput,
  ShowerSession,
  ShowerTarget,
} from '../../../host-core/index.js';
import { ConfirmDialog, InlineBanner } from '../../../web/src/components/ui';
import {
  hasOpenFloatingPopover,
  isEventInsideFloatingUi,
  useTopLayerClose,
} from '../../../web/src/components/ui/Overlay';
import { useText } from '../../../web/src/ui';
import './ShowerPreview.css';

export interface ShowerPreviewProps {
  /** 平台无关的 RPC：method 是六个 Shower 控制方法之一，params 是扁平 {botId,scopeId?,...}。 */
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** 当前目标；scopeId 缺省表示主会话。 */
  target: ShowerTarget;
  /** 客户端 transport 连接；false 时停止轮询且不把旧帧当实时画面。 */
  connected: boolean;
  /** 关闭本视图：只停轮询，不释放环境（释放用面板内的显式按钮）。 */
  onClose: () => void;
  variant?: 'desktop';
}

type KeyModifier = NonNullable<Extract<ShowerInput, { type: 'key' }>['modifiers']>[number];
type TranslateFn = (zh: string, en: string) => string;

/** 键名白名单（协议键名）；不在表内且非字母/数字/F1-F12 的按键不发。 */
const KEY_NAMES: Record<string, string> = {
  Enter: 'ENTER',
  Tab: 'TAB',
  Escape: 'ESCAPE',
  Backspace: 'BACKSPACE',
  Delete: 'DELETE',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PAGEUP',
  PageDown: 'PAGEDOWN',
  ' ': 'SPACE',
};

function errText(e: unknown): string {
  if (e && typeof e === 'object') {
    const r = e as Record<string, unknown>;
    const code = typeof r.code === 'string' ? r.code : '';
    const message = typeof r.message === 'string' ? r.message : '';
    if (code) return message ? `${code}: ${message}` : code;
    if (message) return message;
  }
  return String(e);
}

function codeOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /^([A-Z][A-Z0-9_]+)/.exec(text);
  return m ? m[1] : null;
}

/** 错误码 → 用户可执行的引导；只描述本机可做的事，不假装已恢复。 */
function guideOf(code: string | null | undefined, t: TranslateFn): string | null {
  switch (code) {
    case 'SHOWER_UNAVAILABLE':
      return t('该平台当前没有可用桌面环境（依赖缺失或未启用），请查看目标设备文档。', 'No desktop environment is available on this platform (missing dependencies or disabled). Check the target device documentation.');
    case 'SHOWER_UNSUPPORTED':
      return t('目标平台不支持该操作/按键；不会用近似输入替代。', 'This action or key is not supported on the target platform and will not be approximated.');
    case 'SHOWER_BUSY':
      return t('该设备的桌面环境已被其他使用者占用，请稍后重试。', 'This device’s desktop environment is in use by another controller. Try again later.');
    case 'SHOWER_AUTH_REQUIRED':
      return t('需要在目标设备本机完成登录/认证（凭据只在本机输入，不经过远程调用），完成后这里会自动刷新。', 'Complete sign-in or authentication locally on the target device (credentials stay local). This view refreshes automatically once done.');
    case 'SHOWER_PERMISSION_REQUIRED':
      return t('目标设备缺少所需权限（如 Shizuku/ADB 或系统设置授权），请在本机授权后重试。', 'Required permissions (such as Shizuku/ADB or system access) are missing on the target device. Grant them locally and retry.');
    case 'SHOWER_SESSION_NOT_FOUND':
      return t('会话不存在或已结束，请重新创建环境。', 'Session not found or already ended. Start a new desktop environment.');
    case 'SHOWER_SESSION_MISMATCH':
      return t('会话已被替换，旧会话不再操作；等待新画面后重试。', 'Session was replaced; actions on the old session were stopped. Wait for the new view and retry.');
    case 'SHOWER_NOT_READY':
      return t('环境尚未就绪，等状态变为“就绪”后再输入。', 'Environment is not ready yet. Wait until status is Ready before sending input.');
    case 'SHOWER_INPUT_FAILED':
      return t('输入未生效或结果未确认；为避免重复操作不会自动重放。', 'Input did not take effect or could not be confirmed; it will not be replayed automatically.');
    case 'SHOWER_FRAME_TOO_LARGE':
      return t('画面超出帧预算（应由后端压缩），请重试。', 'Frame exceeded the size budget (backend compression required). Please retry.');
    case 'SHOWER_BACKEND_FAILED':
      return t('后端失败，请查看目标设备上的运行日志。', 'Backend failure. Check the logs on the target device.');
    default:
      return null;
  }
}

function phaseText(phase: string | null | undefined, t: TranslateFn): string {
  switch (phase) {
    case 'unavailable':
      return t('不可用', 'Unavailable');
    case 'idle':
      return t('未创建', 'Not created');
    case 'starting':
      return t('启动中', 'Starting');
    case 'authentication-required':
      return t('等待本机认证', 'Waiting for device authentication');
    case 'ready':
      return t('就绪', 'Ready');
    case 'closed':
      return t('已结束', 'Ended');
    case 'error':
      return t('错误', 'Error');
    default:
      return phase || t('未知', 'Unknown');
  }
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.round(v)));
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function asCaps(v: unknown): ShowerCapabilities {
  const c = (v && typeof v === 'object' ? v : {}) as Partial<ShowerCapabilities>;
  return {
    launchKinds: Array.isArray(c.launchKinds) ? c.launchKinds : [],
    inputKinds: Array.isArray(c.inputKinds) ? c.inputKinds : [],
    keys: Array.isArray(c.keys) ? c.keys : [],
    nativePreview: c.nativePreview === true,
  };
}

function asSession(v: unknown): ShowerSession | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<ShowerSession> & { error?: { code?: unknown; message?: unknown } };
  if (typeof s.platform !== 'string' || typeof s.phase !== 'string') return null;
  const error = s.error && typeof s.error.code === 'string'
    ? { code: s.error.code, message: typeof s.error.message === 'string' ? s.error.message : '' }
    : null;
  return {
    sessionId: typeof s.sessionId === 'string' ? s.sessionId : null,
    platform: s.platform as ShowerSession['platform'],
    phase: s.phase as ShowerSession['phase'],
    width: typeof s.width === 'number' ? s.width : 0,
    height: typeof s.height === 'number' ? s.height : 0,
    capabilities: asCaps(s.capabilities),
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : '',
    ...(error ? { error } : {}),
  };
}

function asFrame(v: unknown): ShowerFrame | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Partial<ShowerFrame>;
  if (
    typeof f.sessionId !== 'string'
    || typeof f.frameId !== 'string'
    || typeof f.data !== 'string'
    || (f.mimeType !== 'image/jpeg' && f.mimeType !== 'image/png')
  ) {
    return null;
  }
  return {
    sessionId: f.sessionId,
    frameId: f.frameId,
    capturedAt: typeof f.capturedAt === 'string' ? f.capturedAt : '',
    width: typeof f.width === 'number' ? f.width : 0,
    height: typeof f.height === 'number' ? f.height : 0,
    imageWidth: typeof f.imageWidth === 'number' ? f.imageWidth : 0,
    imageHeight: typeof f.imageHeight === 'number' ? f.imageHeight : 0,
    mimeType: f.mimeType,
    data: f.data,
  };
}

export function ShowerPreview({ call, target, connected, onClose, variant }: ShowerPreviewProps) {
  const t = useText();
  const tRef = useRef(t);
  tRef.current = t;
  const desktop = variant === 'desktop';
  const botId = target.botId;
  const scopeId = target.scopeId;
  // 扁平公共参数：scopeId 缺省即主会话，不往 params 里塞 undefined。
  const base = useMemo(() => {
    const params: Record<string, unknown> = { botId };
    if (scopeId) params.scopeId = scopeId;
    return params;
  }, [botId, scopeId]);

  const [session, setSession] = useState<ShowerSession | null>(null);
  const [frame, setFrame] = useState<ShowerFrame | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'create' | 'frame' | 'takeover' | 'release'>(null);
  /** 已完成的接管所属会话；会话被替换后自动失效，无需“交还”按钮。 */
  const [takeoverSessionId, setTakeoverSessionId] = useState<string | null>(null);
  /** 本地页面可见性：Capacitor 本机 Host 页面隐藏/息屏时 connected 仍为 true，必须单独跟踪。 */
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  /** 全窗口剧场模式（设计 5.5）：portal 到 <body> 的固定舞台；只改展示层，不影响轮询/输入/释放语义。 */
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [releaseConfirmation, setReleaseConfirmation] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const textInputId = useId();

  const epochRef = useRef(0);
  const actionSeqRef = useRef(0);
  const busyRef = useRef(false);
  /** 实际挂载的图像元素：剧场/分屏切换会重挂载 img，必须随挂载点回调更新，供滚轮原生监听重新绑定。 */
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const theaterRef = useRef<HTMLDivElement | null>(null);
  /** 剧场舞台元素：打开剧场后作为初始聚焦点（onOpenAutoFocus 的 currentTarget 不是 DOM 节点，必须用显式 ref）。 */
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 分屏头部的「全屏」按钮：剧场关闭后焦点显式还原到它（组件没有 DialogPrimitive.Trigger，Radix 不知道触发者）。 */
  const fullscreenBtnRef = useRef<HTMLButtonElement | null>(null);
  const theaterExitBtnRef = useRef<HTMLButtonElement | null>(null);
  const releaseBtnRef = useRef<HTMLButtonElement | null>(null);
  const createBtnRef = useRef<HTMLButtonElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  /** IME 组合中；组合期间的 input 事件不发，组合结束由 compositionend 整段发一次。 */
  const composingRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; at: number; button: number } | null>(null);
  const wheelAccRef = useRef({ x: 0, y: 0 });

  const sessionIdNow = session?.sessionId ?? null;
  const phase = session?.phase ?? null;
  const capabilities = session?.capabilities ?? null;
  const inputKinds = capabilities?.inputKinds ?? [];
  const canClick = inputKinds.includes('click');
  const canDrag = inputKinds.includes('drag');
  const canScroll = inputKinds.includes('scroll');
  const canKey = inputKinds.includes('key');
  const canText = inputKinds.includes('text');
  const supportedKeys = capabilities?.keys ?? [];
  const inputEnabled =
    connected && visible && phase === 'ready' && sessionIdNow !== null && takeoverSessionId === sessionIdNow;
  const canForwardEscape = inputEnabled && canKey && supportedKeys.includes('ESCAPE');
  useEffect(() => {
    setReleaseConfirmation(null);
    setReleaseError(null);
  }, [sessionIdNow, isFullscreen, connected, visible]);

  useTopLayerClose(isFullscreen, {
    kind: 'modal',
    getElement: () => theaterRef.current,
    onClose: () => setIsFullscreen(false),
  });
  // 严格会话归属：旧会话/旧目标的帧不渲染。
  const liveFrame = frame && session && frame.sessionId === session.sessionId ? frame : null;
  const live = connected && visible && phase === 'ready' && !!liveFrame;
  const unsupported = [
    !canClick ? 'click' : '',
    !canDrag ? 'drag' : '',
    !canScroll ? 'scroll' : '',
    !canKey ? 'key' : '',
    !canText ? 'text' : '',
  ].filter(Boolean);

  const inputHint = !connected
    ? t('离线：预览与输入已停止（不把旧帧当实时画面）。', 'Offline: preview and input stopped (stale frames are hidden).')
    : !visible
      ? t('页面不可见：预览与输入已暂停，返回后自动刷新。', 'Page hidden: preview and input paused; refreshes automatically on return.')
      : !sessionIdNow
        ? t('还没有桌面环境，请先创建。', 'No desktop environment yet. Start one first.')
        : phase !== 'ready'
          ? t(`环境未就绪（${phaseText(phase, t)}），输入不可用。`, `Environment not ready (${phaseText(phase, t)}); input unavailable.`)
          : takeoverSessionId !== sessionIdNow
            ? t('需先点“接管控制”，RPC 返回后才开放输入。', 'Click "Take over" first; input opens once confirmed.')
            : null;

  function beginBusy(kind: NonNullable<typeof busy>): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(kind);
    return true;
  }

  function endBusy(seq: number): void {
    if (seq !== actionSeqRef.current) return;
    busyRef.current = false;
    setBusy(null);
  }

  /** 输入只带当前会话 ID，失败绝不自动重发；输入不占用 busy（否则快速输入会被丢字）。 */
  async function sendInput(input: ShowerInput): Promise<void> {
    const sid = sessionIdNow;
    if (!sid || !inputEnabled || !connected) return;
    const epoch = epochRef.current;
    setActionError(null);
    try {
      await call('sendShowerInput', { ...base, sessionId: sid, input });
    } catch (e) {
      if (epoch === epochRef.current) {
        const t = tRef.current;
        setActionError(t(`输入未确认：${errText(e)}（不会自动重发）`, `Input unconfirmed: ${errText(e)} (not auto-retried)`));
      }
    }
  }

  // 最新值引用：供只挂一次的原生 wheel/指针路径读取，不因渲染重建监听。
  const sessionRef = useRef<ShowerSession | null>(null);
  sessionRef.current = session;
  const sendRef = useRef(sendInput);
  sendRef.current = sendInput;
  const inputEnabledRef = useRef(false);
  inputEnabledRef.current = inputEnabled;
  const canScrollRef = useRef(false);
  canScrollRef.current = canScroll;

  // 本机页面可见性：document 隐藏（切后台/息屏）时 transport 仍 connected，
  // 所以只听 visibilitychange 并只用于停轮询/禁输入；不重放输入、不释放环境、不新增 props。
  useEffect(() => {
    const onVisibilityChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    onVisibilityChange();
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // 轮询：可见期间每 1000ms 单飞一次（status，ready 再取 frame）；目标/连接/可见性变化即作废旧请求。
  useEffect(() => {
    const epoch = ++epochRef.current;
    actionSeqRef.current += 1;
    busyRef.current = false;
    setBusy(null);
    setSession(null);
    setFrame(null);
    setPollError(null);
    setActionError(null);
    setNotice(null);
    setTakeoverSessionId(null);
    // 目标/连接/可见性变化：剧场覆盖层一并收起（它唯一绑定的会话上下文已失效）。
    setIsFullscreen(false);
    // 目标/连接/可见性变化：丢弃输入框里未提交的残留与进行中的组合。
    composingRef.current = false;
    if (inputRef.current) inputRef.current.value = '';
    // 隐藏时既不起 interval 也不读状态；重新可见时本 effect 重跑并从 tick() 立即刷新。
    if (!connected || !visible) return;
    let stopped = false;
    let inflight = false;
    const tick = async (): Promise<void> => {
      if (stopped || inflight) return;
      inflight = true;
      try {
        const s = asSession(await call('getShowerStatus', base));
        if (stopped || epoch !== epochRef.current) return;
        if (!s) {
          const t = tRef.current;
          setPollError(t('状态响应无法识别', 'Unrecognized status response'));
          return;
        }
        setSession(s);
        setPollError(null);
        if (!s.sessionId || s.phase !== 'ready') return;
        const f = asFrame(await call('getShowerFrame', { ...base, sessionId: s.sessionId }));
        // 会话/目标已变或帧不属于同一 sessionId：丢弃，不重放。
        if (stopped || epoch !== epochRef.current) return;
        if (!f || f.sessionId !== s.sessionId) return;
        setFrame(f);
      } catch (e) {
        if (!stopped && epoch === epochRef.current) setPollError(errText(e));
      } finally {
        inflight = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [call, base, connected, visible]);

  // 滚轮：原生非被动监听，把三种 deltaMode 折成整数轮格；小增量累积后再发。
  // 依赖实际挂载的 imgEl（而非只挂一次的 ref）：剧场打开/关闭重挂载 img 后监听会解绑旧元素并绑到新元素。
  useEffect(() => {
    const el = imgEl;
    if (!live || !el) return;
    const handler = (ev: WheelEvent): void => {
      if (!inputEnabledRef.current || !canScrollRef.current) return;
      const s = sessionRef.current;
      if (!s || s.width <= 0 || s.height <= 0) return;
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // shortcut: 像素模式按 100px≈1 格折算，若某平台需要精确行数应由后端提供映射。
      const factor = ev.deltaMode === 1 ? 1 : ev.deltaMode === 2 ? 10 : 0.01;
      wheelAccRef.current.y += ev.deltaY * factor;
      wheelAccRef.current.x += ev.deltaX * factor;
      const dy = clampInt(Math.trunc(wheelAccRef.current.y), -20, 20);
      const dx = clampInt(Math.trunc(wheelAccRef.current.x), -20, 20);
      if (dy === 0 && dx === 0) return;
      wheelAccRef.current.y -= dy;
      wheelAccRef.current.x -= dx;
      const x = clampInt(((ev.clientX - r.left) * s.width) / r.width, 0, s.width - 1);
      const y = clampInt(((ev.clientY - r.top) * s.height) / r.height, 0, s.height - 1);
      void sendRef.current(
        dx !== 0 ? { type: 'scroll', x, y, deltaX: dx, deltaY: dy } : { type: 'scroll', x, y, deltaY: dy },
      );
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [live, imgEl]);

  async function runAction(
    kind: 'create' | 'frame' | 'takeover' | 'release',
    fn: (seq: number) => Promise<void>,
  ): Promise<void> {
    if (!beginBusy(kind)) return;
    const seq = ++actionSeqRef.current;
    setActionError(null);
    setNotice(null);
    try {
      await fn(seq);
    } catch (e) {
      if (seq === actionSeqRef.current) setActionError(errText(e));
    } finally {
      endBusy(seq);
    }
  }

  function createSession(): void {
    void runAction('create', async (seq) => {
      const s = asSession(await call('createShowerSession', base));
      if (seq !== actionSeqRef.current) return;
      const t = tRef.current;
      if (!s) {
        setActionError(t('创建响应无法识别', 'Unrecognized create response'));
        return;
      }
      setSession(s);
      setNotice(
        s.phase === 'authentication-required'
          ? t('环境等待目标设备本机认证/登录，完成后自动刷新。', 'Waiting for local sign-in/authentication on the target device; refreshes automatically once done.')
          : t('已请求启动桌面环境。', 'Requested desktop environment startup.'),
      );
    });
  }

  function refreshFrame(): void {
    void runAction('frame', async (seq) => {
      const t = tRef.current;
      const sid = sessionIdNow;
      if (!sid) {
        setActionError(t('还没有桌面环境，请先创建。', 'No desktop environment yet. Start one first.'));
        return;
      }
      const f = asFrame(await call('getShowerFrame', { ...base, sessionId: sid }));
      if (seq !== actionSeqRef.current) return;
      if (!f || f.sessionId !== sid) {
        setActionError(t('返回帧不属于当前会话，已丢弃。', 'Discarded frame from a different session.'));
        return;
      }
      setFrame(f);
    });
  }

  // 接管：先 await RPC，成功且会话未变才开放输入；没有交还按钮。
  function takeover(): void {
    void runAction('takeover', async (seq) => {
      const t = tRef.current;
      const sid = sessionIdNow;
      if (!sid) {
        setActionError(t('还没有桌面环境，请先创建。', 'No desktop environment yet. Start one first.'));
        return;
      }
      const s = asSession(await call('takeoverShower', { ...base, sessionId: sid }));
      if (seq !== actionSeqRef.current) return;
      if (!s || s.sessionId !== sid) {
        setActionError(t('接管结果未确认或会话已被替换，输入未开放。', 'Takeover was not confirmed or session changed; input remains locked.'));
        return;
      }
      setSession(s);
      setTakeoverSessionId(sid);
      if (!desktop) {
        setNotice(t('已接管：输入发往该环境；新回合会重新截图，无需交还。', 'In control: inputs go to this environment; next turn recaptures automatically.'));
      }
    });
  }

  function releaseSession(): void {
    void runAction('release', async (seq) => {
      const sid = sessionIdNow;
      if (!sid) return;
      setReleaseError(null);
      try {
        await call('releaseShowerSession', { ...base, sessionId: sid });
      } catch (e) {
        if (seq === actionSeqRef.current) setReleaseError(errText(e));
        throw e;
      }
      if (seq !== actionSeqRef.current) return;
      const t = tRef.current;
      setReleaseConfirmation(null);
      setReleaseError(null);
      setTakeoverSessionId(null);
      setFrame(null);
      setNotice(t('已结束该桌面环境；再次创建会得到新会话。', 'Desktop environment ended; starting again will create a new session.'));
    });
  }

  /** 图像显示像素 → 源输入像素；越界按图像边界收敛。 */
  function sourcePoint(ev: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const el = imgEl;
    const s = sessionRef.current;
    if (!el || !s || s.width <= 0 || s.height <= 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return {
      x: clampInt(((ev.clientX - r.left) * s.width) / r.width, 0, s.width - 1),
      y: clampInt(((ev.clientY - r.top) * s.height) / r.height, 0, s.height - 1),
    };
  }

  function onPointerDown(ev: PointerEvent<HTMLImageElement>): void {
    if (!inputEnabled || (!canClick && !canDrag)) return;
    const p = sourcePoint(ev);
    if (!p) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    dragRef.current = { x: p.x, y: p.y, at: Date.now(), button: ev.button };
  }

  function onPointerUp(ev: PointerEvent<HTMLImageElement>): void {
    const start = dragRef.current;
    dragRef.current = null;
    if (!start || !inputEnabled) return;
    const end = sourcePoint(ev);
    if (!end) return;
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    if (moved <= 3) {
      if (!canClick) return;
      const button = start.button === 2 ? 'right' : start.button === 1 ? 'middle' : 'left';
      void sendInput({ type: 'click', x: end.x, y: end.y, button, count: 1 });
      return;
    }
    if (!canDrag) return;
    const durationMs = Math.min(3000, Math.max(50, Date.now() - start.at));
    void sendInput({ type: 'drag', x1: start.x, y1: start.y, x2: end.x, y2: end.y, durationMs });
  }

  function onPointerCancel(): void {
    dragRef.current = null;
  }

  function keyNameOf(ev: KeyboardEvent<HTMLElement>): string | null {
    const mapped = KEY_NAMES[ev.key];
    if (mapped) return mapped;
    if (/^[a-zA-Z]$/.test(ev.key)) return ev.key.toUpperCase();
    if (/^[0-9]$/.test(ev.key)) return ev.key;
    if (/^F([1-9]|1[0-2])$/.test(ev.key)) return ev.key;
    return null;
  }

  function onKeyDown(ev: KeyboardEvent<HTMLElement>): void {
    if (!inputEnabled) return;
    // IME 组合中不拦截空格/回车等候选确认键，避免抢走输入法提交。
    if (ev.nativeEvent.isComposing) return;
    const name = keyNameOf(ev);
    if (!name) return;
    const combo = ev.ctrlKey || ev.altKey || ev.metaKey;
    const special = !!KEY_NAMES[ev.key] || /^F([1-9]|1[0-2])$/.test(ev.key);
    // 无修饰的字母/数字走文本与 IME 路径，避免与组合输入冲突。
    if (!combo && !special) return;
    ev.preventDefault();
    if (name === 'ESCAPE') ev.stopPropagation();
    if (!canKey) {
      setActionError(t('SHOWER_UNSUPPORTED: 目标平台不支持按键输入。', 'SHOWER_UNSUPPORTED: Target platform does not support key input.'));
      return;
    }
    if (!supportedKeys.includes(name)) {
      setActionError(t(`SHOWER_UNSUPPORTED: 目标平台不支持按键 ${name}（不用近似键替代）。`, `SHOWER_UNSUPPORTED: Target platform does not support key ${name} (no approximation).`));
      return;
    }
    const modifiers: KeyModifier[] = [];
    if (ev.ctrlKey) modifiers.push('CTRL');
    if (ev.altKey) modifiers.push('ALT');
    if (ev.shiftKey) modifiers.push('SHIFT');
    if (ev.metaKey) modifiers.push('META');
    void sendInput({ type: 'key', key: name, ...(modifiers.length ? { modifiers } : {}) });
  }

  /**
   * 文本输入：非受控远程键盘输入（DOM 持有 value，React 不写回，避免同一事件里两个 setState 互相覆盖）。
   * 每次提交（普通 input 或 IME 组合结束）只读一次 value、立即清空、只发一次，不双发不丢字。
   */
  function commitText(el: HTMLInputElement): void {
    const value = el.value;
    el.value = '';
    if (!value) return;
    if (!inputEnabled) return;
    if (!canText) {
      setActionError(t('SHOWER_UNSUPPORTED: 目标平台不支持文本输入。', 'SHOWER_UNSUPPORTED: Target platform does not support text input.'));
      return;
    }
    if (value.length > 1000) {
      setActionError(t('文本超过协议上限 1000 字符，未发送。', 'Text exceeds the 1000-character protocol limit and was not sent.'));
      return;
    }
    void sendInput({ type: 'text', text: value });
  }

  /** 普通输入（含 CDP insertText / 粘贴）；IME 组合期间的 input 事件一律不发。 */
  function onTextChange(ev: ChangeEvent<HTMLInputElement>): void {
    if (composingRef.current) return;
    commitText(ev.currentTarget);
  }

  function onTextCompositionStart(): void {
    composingRef.current = true;
  }

  /**
   * 组合结束：整段发一次并清空。若浏览器在 compositionend 之后又补一个末尾 input 事件，
   * 该事件读到的是已清空的 value（空字符串直接返回），所以只发一次；反过来在 input 先于
   * compositionend 的浏览器里，组合期间的 input 已被 composingRef 挡住，也不会重复。
   */
  function onTextCompositionEnd(ev: CompositionEvent<HTMLInputElement>): void {
    composingRef.current = false;
    commitText(ev.currentTarget);
  }

  const pollCode = codeOf(pollError);
  const sessionCode = session?.error?.code ?? null;
  const actionCode = codeOf(actionError);
  const takenOver = takeoverSessionId !== null && takeoverSessionId === sessionIdNow;
  const statusClass = !connected || !live ? 'idle' : takenOver ? 'busy' : 'live';

  const statusBlock = (
    <div
      className="shower-status"
      aria-live="polite"
      title={session?.updatedAt ? t(`状态更新 ${formatTs(session.updatedAt)}`, `Status updated ${formatTs(session.updatedAt)}`) : undefined}
    >
      <span className={`shower-dot ${statusClass}`} aria-hidden="true" />
      {!connected ? (
        <span className="shower-offline">
          {desktop ? t('目标设备离线', 'Target device offline') : t('离线：已停止轮询，不显示实时画面。', 'Offline: polling stopped; live view hidden.')}
        </span>
      ) : desktop ? (
        <span>
          {phase === 'ready'
            ? takenOver
              ? t('已接管', 'In control')
              : live
                ? t('正在查看桌面', 'Viewing desktop')
                : t('等待桌面画面', 'Waiting for desktop frame')
            : phase === null
              ? t('正在读取桌面状态…', 'Loading desktop status…')
              : phaseText(phase, t)}
        </span>
      ) : (
        <span className="tabular-nums">
          {phaseText(phase, t)}
          {session ? ` · ${session.platform} · ${session.width}×${session.height}` : ''}
          {sessionIdNow ? t(` · 会话 ${shortId(sessionIdNow)}`, ` · Session ${shortId(sessionIdNow)}`) : t(' · 无环境', ' · No environment')}
        </span>
      )}
    </div>
  );

  const capabilitiesBlock = capabilities ? (
    <div className="shower-caps">
      <span>
        {t(`输入 ${inputKinds.length ? inputKinds.join('/') : '无'} · 启动 ${capabilities.launchKinds.length ? capabilities.launchKinds.join('/') : '无'} · 原生预览 ${capabilities.nativePreview ? '支持' : '不支持'}`, `Input ${inputKinds.length ? inputKinds.join('/') : 'none'} · Launch ${capabilities.launchKinds.length ? capabilities.launchKinds.join('/') : 'none'} · Native preview ${capabilities.nativePreview ? 'supported' : 'unsupported'}`)}
      </span>
      {unsupported.length ? (
        <span className="shower-unsupported">
          {t(`不支持：${unsupported.join('/')}`, `Unsupported: ${unsupported.join('/')}`)}
        </span>
      ) : null}
    </div>
  ) : null;

  const offlineBanner = !connected ? (
    <InlineBanner
      tone="attention"
      compact
      role="status"
      title={desktop ? t('目标设备离线', 'Target device offline') : t('离线：已停止轮询，不显示实时画面。', 'Offline: polling stopped; live view hidden.')}
      detail={t('预览与输入已暂停，设备重新连接后自动恢复。', 'Preview and input are paused and resume automatically after reconnecting.')}
    />
  ) : null;

  const phaseGuideBlock = (
    <>
      {phase === 'authentication-required' ? (
        <InlineBanner
          tone="attention"
          compact
          role="status"
          title={t('等待目标设备本机认证/登录', 'Waiting for local sign-in / authentication on target device')}
          detail={guideOf('SHOWER_AUTH_REQUIRED', t) ?? undefined}
        />
      ) : null}
      {phase === 'unavailable' ? (
        <InlineBanner
          tone="attention"
          compact
          role="status"
          title={t('当前平台没有可用桌面环境', 'Desktop environment unavailable on this platform')}
          detail={guideOf('SHOWER_UNAVAILABLE', t) ?? undefined}
        />
      ) : null}
    </>
  );

  const desktopIssue = actionError
    ? guideOf(actionCode, t) ?? t('桌面操作未完成。可展开诊断查看原因。', 'Desktop action did not complete. Expand diagnostics for details.')
    : sessionCode && phase !== 'authentication-required' && phase !== 'unavailable'
      ? guideOf(sessionCode, t) ?? t('桌面环境遇到问题。可展开诊断查看原因。', 'The desktop environment encountered an error. Expand diagnostics for details.')
      : pollError
        ? guideOf(pollCode, t) ?? t('暂时无法读取画面。可展开诊断查看原因。', 'Unable to read desktop frame right now. Expand diagnostics for details.')
        : null;

  const alertBlock = desktop ? (
    <>
      {desktopIssue ? (
        <InlineBanner
          tone="danger"
          compact
          role="alert"
          title={desktopIssue}
          onDismiss={actionError ? () => setActionError(null) : undefined}
          dismissLabel={t('关闭错误提示', 'Dismiss error')}
        />
      ) : null}
      {notice ? (
        <InlineBanner
          tone="live"
          compact
          role="status"
          title={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('关闭提示', 'Dismiss notice')}
        />
      ) : null}
    </>
  ) : (
    <>
      {pollError ? (
        <InlineBanner
          tone="danger"
          compact
          role="alert"
          title={pollError}
          detail={guideOf(pollCode, t) ?? undefined}
        />
      ) : null}
      {sessionCode ? (
        <InlineBanner
          tone="danger"
          compact
          role="alert"
          title={session?.error?.message ? `${sessionCode}: ${session.error.message}` : sessionCode}
          detail={guideOf(sessionCode, t) ?? undefined}
        />
      ) : null}
      {actionError ? (
        <InlineBanner
          tone="danger"
          compact
          role="alert"
          title={actionError}
          detail={guideOf(actionCode, t) ?? undefined}
          onDismiss={() => setActionError(null)}
          dismissLabel={t('关闭错误提示', 'Dismiss error')}
        />
      ) : null}
      {notice ? (
        <InlineBanner
          tone="live"
          compact
          role="status"
          title={notice}
          onDismiss={() => setNotice(null)}
          dismissLabel={t('关闭提示', 'Dismiss notice')}
        />
      ) : null}
    </>
  );

  const frameBlock = live && liveFrame ? (
    <img
      ref={setImgEl}
      className={`shower-frame ${inputEnabled ? 'interactive' : ''}`}
      src={`data:${liveFrame.mimeType};base64,${liveFrame.data}`}
      alt={t('桌面环境画面', 'Desktop environment view')}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(e) => e.preventDefault()}
      onAuxClick={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
    />
  ) : (
    <div className="shower-empty" role="status">
      <Monitor size={26} aria-hidden="true" />
      <span>
        {!connected
          ? t('离线：不显示旧画面。', 'Offline: stale frame hidden.')
          : phase === 'starting'
            ? t('环境启动中…', 'Starting environment…')
            : phase === 'authentication-required'
              ? t('等待目标设备本机认证…', 'Waiting for local authentication on target device…')
              : t('暂无画面', 'No frame yet')}
      </span>
    </div>
  );

  const metaBlock = live && liveFrame ? (
    <div className="shower-meta tabular-nums">
      {t(`实时 · 帧 ${formatTs(liveFrame.capturedAt)} · ${liveFrame.imageWidth}×${liveFrame.imageHeight} → 源 ${liveFrame.width}×${liveFrame.height}`, `Live · Frame ${formatTs(liveFrame.capturedAt)} · ${liveFrame.imageWidth}×${liveFrame.imageHeight} → Source ${liveFrame.width}×${liveFrame.height}`)}
    </div>
  ) : null;

  const diagnosticsBlock = desktop ? (
    <details className="shower-diagnostics">
      <summary>{t('桌面诊断', 'Desktop diagnostics')}</summary>
      <div className="shower-diagnostics-body">
        <span>
          {scopeId
            ? t(`智能体 ${botId} · 对话 ${scopeId}`, `Bot ${botId} · Scope ${scopeId}`)
            : t(`智能体 ${botId}`, `Bot ${botId}`)}
        </span>
        {session ? (
          <span className="tabular-nums">
            {t(`${session.platform} · ${session.width}×${session.height} · 更新于 ${formatTs(session.updatedAt)}`, `${session.platform} · ${session.width}×${session.height} · Updated ${formatTs(session.updatedAt)}`)}
          </span>
        ) : null}
        {sessionIdNow ? <span>{t(`会话 ${sessionIdNow}`, `Session ${sessionIdNow}`)}</span> : null}
        {capabilitiesBlock}
        {metaBlock}
        {pollError ? <span>{pollError}</span> : null}
        {sessionCode ? <span>{sessionCode} · {session?.error?.message}</span> : null}
        {actionError ? <span>{actionError}</span> : null}
        {connected && sessionIdNow && phase === 'ready' ? (
          <div className="shower-controls">
            <button type="button" onClick={refreshFrame} disabled={busy !== null}>
              {t('刷新画面', 'Refresh frame')}
            </button>
            {takenOver ? (
              <button type="button" onClick={takeover} disabled={busy !== null}>
                {t('重新接管', 'Take over again')}
              </button>
            ) : null}
            {takenOver ? (
              <span className="hint">{t('重新接管也会中断当前回合。', 'Taking over again will also interrupt the current turn.')}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  ) : null;

  const canStart = phase === 'idle' || phase === 'closed' || phase === 'error' ||
    (!sessionIdNow && (phase === 'unavailable' || (phase === null && !!pollError)));
  const controlsBlock = desktop ? (
    <div className="shower-controls">
      {connected && (canStart || busy === 'create') ? (
        <button ref={createBtnRef} type="button" className="primary" onClick={createSession} disabled={busy !== null}>
          {busy === 'create' ? t('启动中…', 'Starting…') : t('启动桌面', 'Start desktop')}
        </button>
      ) : connected && sessionIdNow && phase === 'ready' && !takenOver ? (
        live || busy === 'takeover' ? (
          <>
            <button type="button" className="primary" onClick={takeover} disabled={busy !== null}>
              {busy === 'takeover' ? t('接管中…', 'Taking over…') : t('接管控制', 'Take over')}
            </button>
            <span className="hint">{t('接管会中断这个智能体正在运行的回合。', 'Taking over interrupts this Bot’s running turn.')}</span>
          </>
        ) : (
          <button type="button" className="primary" onClick={refreshFrame} disabled={busy !== null}>
            {busy === 'frame' ? t('读取画面中…', 'Loading frame…') : t('查看画面', 'View frame')}
          </button>
        )
      ) : null}
    </div>
  ) : (
    <div className="shower-controls">
      <button
        ref={createBtnRef}
        type="button"
        onClick={createSession}
        disabled={!connected || busy !== null || (!!sessionIdNow && phase !== 'closed' && phase !== 'error' && phase !== 'idle')}
      >
        {busy === 'create' ? t('创建中…', 'Creating…') : t('创建/启动环境', 'Create / Start')}
      </button>
      <button type="button" onClick={refreshFrame} disabled={!connected || !sessionIdNow || busy !== null}>
        {busy === 'frame' ? t('刷新中…', 'Refreshing…') : t('刷新画面', 'Refresh frame')}
      </button>
      <button
        type="button"
        className={takenOver ? 'taken-over' : 'primary'}
        onClick={takeover}
        disabled={!connected || !sessionIdNow || phase !== 'ready' || busy !== null}
        title={t('调用 takeoverShower：先中止当前回合，返回后才开放输入', 'Calls takeoverShower: interrupts the active turn and enables input once confirmed')}
      >
        {busy === 'takeover'
          ? t('接管中…', 'Taking over…')
          : takenOver
            ? t('已接管 · 重新接管', 'In control · Take over again')
            : t('接管控制', 'Take over')}
      </button>
    </div>
  );

  const inputBlock = (
    <div className="shower-input">
      <label className="shower-input-label" htmlFor={textInputId}>
        {desktop
          ? t('输入到远端桌面', 'Type into remote desktop')
          : t('人工输入（提交即发送；特殊键/组合键走按键）', 'Manual input (sent on commit; special & combo keys send key events)')}
      </label>
      <input
        id={textInputId}
        ref={inputRef}
        className="shower-text"
        onChange={onTextChange}
        onCompositionStart={onTextCompositionStart}
        onCompositionEnd={onTextCompositionEnd}
        onKeyDown={onKeyDown}
        disabled={!inputEnabled}
        placeholder={inputEnabled ? t('输入文本或按键…', 'Type text or press keys…') : t('接管成功后可用', 'Available after takeover')}
        autoComplete="off"
        spellCheck={false}
      />
      {!desktop && inputHint ? <div className="hint">{inputHint}</div> : null}
    </div>
  );

  const releaseConfirmOpen =
    releaseConfirmation !== null && releaseConfirmation === sessionIdNow && connected && phase !== 'closed';

  const releaseBlock = desktop ? (
    connected && sessionIdNow && phase !== 'closed' ? (
      <button
        ref={releaseBtnRef}
        type="button"
        className="shower-release"
        onClick={() => {
          setReleaseError(null);
          setReleaseConfirmation(sessionIdNow);
        }}
        disabled={busy !== null}
      >
        {busy === 'release' ? t('结束中…', 'Ending…') : t('结束桌面环境', 'End desktop environment')}
      </button>
    ) : null
  ) : (
    <>
      <button
        ref={releaseBtnRef}
        type="button"
        className="shower-release"
        onClick={() => {
          if (sessionIdNow) {
            setReleaseError(null);
            setReleaseConfirmation(sessionIdNow);
          }
        }}
        disabled={!connected || !sessionIdNow || busy !== null}
        title={t('显式结束该桌面环境（与关闭预览不同）', 'Explicitly end this desktop environment (closing preview keeps it running)')}
      >
        {busy === 'release' ? t('结束中…', 'Ending…') : t('结束桌面环境（释放会话）', 'End desktop environment (release session)')}
      </button>
      <span className="hint">{t('关闭预览不释放环境。', 'Closing preview does not end the environment.')}</span>
    </>
  );

  /**
   * 剧场 Escape：接管后输入通道开放（inputEnabled）时，Esc 属于必须发给远端的按键——
   * 输入框转发 ESCAPE，舞台也转发设备支持的 Escape。
   * 只有未接管且焦点在非输入控件（顶栏按钮/舞台空白）时 Esc 才关闭剧场。Radix 自身的 Esc→关闭
   * 在 Content.onEscapeKeyDown 里按同一条件拦截。
   */
  function onTheaterEscapeKey(ev: KeyboardEvent<HTMLElement>): void {
    if (ev.key !== 'Escape') return;
    if (hasOpenFloatingPopover(theaterRef.current)) return;
    // 焦点在接管输入框时不处理：留给 onKeyDown 的远端 ESCAPE 发送路径。
    if ((ev.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (inputEnabled) {
      if (canForwardEscape) onKeyDown(ev);
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    setIsFullscreen(false);
  }

  // 剧场覆盖层：Radix Dialog portal 到 <body>，固定全窗；同一个 inputRef/img 回调 ref 只在此处渲染
  // （剧场打开时面板内的 stage/输入不渲染），ref 指向唯一实例。
  const theater = (
    <DialogPrimitive.Root
      open={isFullscreen}
      onOpenChange={(open) => {
        if (!open) setIsFullscreen(false);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          ref={theaterRef}
          className={desktop ? 'shower-theater shower-desktop' : 'shower-theater'}
          data-shower-overlay
          data-shower-takeover={inputEnabled ? 'true' : undefined}
          data-ui-dialog={isFullscreen ? 'open' : undefined}
          aria-label={t('桌面环境全窗口剧场', 'Desktop environment fullscreen theater')}
          onKeyDown={onTheaterEscapeKey}
          onPointerDownOutside={(event) => {
            if (isEventInsideFloatingUi(event)) event.preventDefault();
          }}
          onFocusOutside={(event) => {
            if (isEventInsideFloatingUi(event)) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isEventInsideFloatingUi(event)) event.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (inputEnabled || hasOpenFloatingPopover(theaterRef.current)) {
              e.preventDefault();
              return;
            }
            e.stopPropagation();
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (desktop && inputEnabled && inputRef.current) inputRef.current.focus();
            else stageRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // 无 Trigger：Radix 默认还原到打开前焦点；但剧场也可能由会话重置关闭，
            // 显式还原到「全屏」按钮（若面板已随 onClose 卸载则自然落空）。
            e.preventDefault();
            fullscreenBtnRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {t('桌面环境全窗口剧场', 'Desktop environment fullscreen theater')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('虚拟桌面画面与接管输入；未接管时 Esc 返回分屏，接管后 Esc 发往远端。', 'Virtual desktop view and takeover input. Press Esc to exit fullscreen when viewing, or send Esc to the remote desktop while in control.')}
          </DialogPrimitive.Description>
          <header className="shower-theater-top">
            <button
              ref={theaterExitBtnRef}
              type="button"
              className="icon-button"
              onClick={() => setIsFullscreen(false)}
              title={inputEnabled ? t('返回分屏', 'Exit fullscreen') : t('返回分屏（Esc）', 'Exit fullscreen (Esc)')}
              aria-label={t('返回分屏', 'Exit fullscreen')}
            >
              <Minimize2 size={14} aria-hidden="true" />
              {t('返回分屏', 'Exit fullscreen')}
            </button>
            <div className="shower-theater-title">
              <Monitor size={15} aria-hidden="true" />
              {desktop ? t('虚拟桌面', 'Virtual desktop') : shortId(botId)}
              {!desktop ? (
                <span className="shower-sub">
                  {scopeId ? `scope ${shortId(scopeId)}` : t('主会话', 'Primary session')}
                  {sessionIdNow ? t(` · 会话 ${shortId(sessionIdNow)}`, ` · Session ${shortId(sessionIdNow)}`) : t(' · 无环境', ' · No environment')}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              title={t('关闭预览（只停轮询，不释放环境）', 'Close preview (stops polling without ending the environment)')}
              aria-label={t('关闭预览', 'Close preview')}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          {statusBlock}
          <div className="shower-theater-alerts">
            {offlineBanner}
            {phaseGuideBlock}
            {alertBlock}
          </div>
          <div className="shower-theater-stage" ref={stageRef} tabIndex={-1}>
            {frameBlock}
          </div>
          {!desktop ? metaBlock : null}
          <div className="shower-theater-bar">
            {controlsBlock}
            {desktop ? (
              inputEnabled && (canText || canKey) ? inputBlock : null
            ) : (
              <input
                id={`${textInputId}-theater`}
                ref={inputRef}
                className="shower-text"
                onChange={onTextChange}
                onCompositionStart={onTextCompositionStart}
                onCompositionEnd={onTextCompositionEnd}
                onKeyDown={onKeyDown}
                disabled={!inputEnabled}
                placeholder={inputEnabled ? t('输入文本或按键…', 'Type text or press keys…') : t('接管成功后可用', 'Available after takeover')}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('人工输入（提交即发送；特殊键/组合键走按键）', 'Manual input (sent on commit; special & combo keys send key events)')}
              />
            )}
            {inputEnabled ? (
              <span className="hint">
                {canForwardEscape
                  ? t('Esc 发往远端。点击「返回分屏」退出全屏。', 'Esc is sent to the remote desktop. Click "Exit fullscreen" to leave.')
                  : t('点击「返回分屏」退出全屏。', 'Click "Exit fullscreen" to leave.')}
              </span>
            ) : null}
            {releaseBlock}
            {diagnosticsBlock}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );

  return (
    <>
      <section
        className={desktop ? 'shower-preview shower-desktop' : 'shower-preview'}
        data-shower-takeover={inputEnabled ? 'true' : undefined}
        aria-label={t('桌面环境预览', 'Desktop environment preview')}
      >
        <header className="shower-head">
          <div className="shower-head-text">
            <div className="shower-title">
              <Monitor size={14} aria-hidden="true" />
              {t('虚拟桌面', 'Virtual desktop')}
            </div>
            {!desktop ? (
              <div
                className="shower-sub"
                title={`${botId}${scopeId ? ` · scope ${scopeId}` : ''}`}
              >
                {shortId(botId)}
                {scopeId ? ` · scope ${shortId(scopeId)}` : t(' · 主会话', ' · Primary session')}
              </div>
            ) : null}
          </div>
          <div className="shower-head-actions">
            <button
              type="button"
              className="icon-button"
              ref={fullscreenBtnRef}
              onClick={() => setIsFullscreen(true)}
              title={t('全窗口剧场模式', 'Fullscreen theater mode')}
              aria-label={t('进入全窗口剧场模式', 'Enter fullscreen theater mode')}
            >
              <Maximize2 size={14} aria-hidden="true" />
              {t('全屏', 'Fullscreen')}
            </button>
            <button
              ref={closeBtnRef}
              type="button"
              className="icon-button"
              onClick={onClose}
              title={t('关闭预览（只停轮询，不释放环境）', 'Close preview (stops polling without ending the environment)')}
              aria-label={t('关闭预览', 'Close preview')}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        {statusBlock}
        {!desktop ? capabilitiesBlock : null}
        {offlineBanner}
        {phaseGuideBlock}
        {alertBlock}

        {/* 剧场打开时舞台/输入迁移到覆盖层，面板保留状态与告警供返回后查看。 */}
        {!isFullscreen ? (
          <>
            <div className="shower-surface">
              {frameBlock}
            </div>
            {!desktop ? metaBlock : null}
            {controlsBlock}
            {!desktop || (inputEnabled && (canText || canKey)) ? inputBlock : null}
            <div className="shower-footer">
              {releaseBlock}
              {diagnosticsBlock}
            </div>
          </>
        ) : (
          <div className="shower-empty" role="status">
            {desktop
              ? t('全屏预览已开启。', 'Fullscreen preview is open.')
              : t('剧场模式已开启（Esc 或「返回分屏」退出）。', 'Theater mode is open (press Esc or click "Exit fullscreen" to leave).')}
          </div>
        )}
      </section>
      {theater}
      <ConfirmDialog
        open={releaseConfirmOpen}
        title={t('结束当前桌面环境？', 'End current desktop environment?')}
        description={t('结束桌面环境会立即关闭目标设备上的当前虚拟桌面并释放会话，未保存的应用状态会丢失；再次启动将创建全新会话。仅想退出查看请使用「关闭预览」。', 'Ending this desktop environment immediately closes the active virtual desktop on the target device and releases the session. Any unsaved app state will be lost, and starting again creates a fresh session. To only stop viewing, close the preview instead.')}
        danger
        busy={busy === 'release'}
        error={releaseError}
        confirmLabel={busy === 'release' ? t('结束中…', 'Ending…') : t('结束桌面环境', 'End desktop environment')}
        cancelLabel={t('取消', 'Cancel')}
        onCancel={() => {
          if (busy !== 'release') {
            setReleaseConfirmation(null);
            setReleaseError(null);
          }
        }}
        onConfirm={() => {
          if (releaseConfirmation !== sessionIdNow || busy !== null) return;
          setReleaseError(null);
          releaseSession();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const candidates = [
            releaseBtnRef.current,
            isFullscreen ? theaterExitBtnRef.current : null,
            createBtnRef.current,
            fullscreenBtnRef.current,
            closeBtnRef.current,
          ];
          const next = candidates.find(el => el && el.isConnected && !el.disabled);
          next?.focus({ preventScroll: true });
        }}
      />
    </>
  );
}
