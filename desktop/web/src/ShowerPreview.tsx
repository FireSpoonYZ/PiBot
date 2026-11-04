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
}

type KeyModifier = NonNullable<Extract<ShowerInput, { type: 'key' }>['modifiers']>[number];

const PHASE_TEXT: Record<string, string> = {
  unavailable: '不可用',
  idle: '未创建',
  starting: '启动中',
  'authentication-required': '等待本机认证',
  ready: '就绪',
  closed: '已结束',
  error: '错误',
};

/** 错误码 → 用户可执行的引导；只描述本机可做的事，不假装已恢复。 */
const GUIDE: Record<string, string> = {
  SHOWER_UNAVAILABLE: '该平台当前没有可用桌面环境（依赖缺失或未启用），请查看目标设备文档。',
  SHOWER_UNSUPPORTED: '目标平台不支持该操作/按键；不会用近似输入替代。',
  SHOWER_BUSY: '该设备的桌面环境已被其他使用者占用，请稍后重试。',
  SHOWER_AUTH_REQUIRED: '需要在目标设备本机完成登录/认证（凭据只在本机输入，不经过远程调用），完成后这里会自动刷新。',
  SHOWER_PERMISSION_REQUIRED: '目标设备缺少所需权限（如 Shizuku/ADB 或系统设置授权），请在本机授权后重试。',
  SHOWER_SESSION_NOT_FOUND: '会话不存在或已结束，请重新创建环境。',
  SHOWER_SESSION_MISMATCH: '会话已被替换，旧会话不再操作；等待新画面后重试。',
  SHOWER_NOT_READY: '环境尚未就绪，等状态变为“就绪”后再输入。',
  SHOWER_INPUT_FAILED: '输入未生效或结果未确认；为避免重复操作不会自动重放。',
  SHOWER_FRAME_TOO_LARGE: '画面超出帧预算（应由后端压缩），请重试。',
  SHOWER_BACKEND_FAILED: '后端失败，请查看目标设备上的运行日志。',
};

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

function guideOf(code: string | null | undefined): string | null {
  return code ? GUIDE[code] ?? null : null;
}

function phaseText(phase: string | null | undefined): string {
  if (!phase) return '未知';
  return PHASE_TEXT[phase] ?? phase;
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

export function ShowerPreview({ call, target, connected, onClose }: ShowerPreviewProps) {
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
  const textInputId = useId();

  const epochRef = useRef(0);
  const actionSeqRef = useRef(0);
  const busyRef = useRef(false);
  /** 实际挂载的图像元素：剧场/分屏切换会重挂载 img，必须随挂载点回调更新，供滚轮原生监听重新绑定。 */
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 剧场舞台元素：打开剧场后作为初始聚焦点（onOpenAutoFocus 的 currentTarget 不是 DOM 节点，必须用显式 ref）。 */
  const stageRef = useRef<HTMLDivElement | null>(null);
  /** 分屏头部的「全屏」按钮：剧场关闭后焦点显式还原到它（组件没有 DialogPrimitive.Trigger，Radix 不知道触发者）。 */
  const fullscreenBtnRef = useRef<HTMLButtonElement | null>(null);
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
    ? '离线：预览与输入已停止（不把旧帧当实时画面）。'
    : !visible
      ? '页面不可见：预览与输入已暂停，返回后自动刷新。'
      : !sessionIdNow
        ? '还没有桌面环境，请先创建。'
        : phase !== 'ready'
          ? `环境未就绪（${phaseText(phase)}），输入不可用。`
          : takeoverSessionId !== sessionIdNow
            ? '需先点“接管控制”，RPC 返回后才开放输入。'
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
      if (epoch === epochRef.current) setActionError(`输入未确认：${errText(e)}（不会自动重发）`);
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
          setPollError('状态响应无法识别');
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
      if (!s) {
        setActionError('创建响应无法识别');
        return;
      }
      setSession(s);
      setNotice(
        s.phase === 'authentication-required'
          ? '环境等待目标设备本机认证/登录，完成后自动刷新。'
          : '已请求启动桌面环境。',
      );
    });
  }

  function refreshFrame(): void {
    void runAction('frame', async (seq) => {
      const sid = sessionIdNow;
      if (!sid) {
        setActionError('还没有桌面环境，请先创建。');
        return;
      }
      const f = asFrame(await call('getShowerFrame', { ...base, sessionId: sid }));
      if (seq !== actionSeqRef.current) return;
      if (!f || f.sessionId !== sid) {
        setActionError('返回帧不属于当前会话，已丢弃。');
        return;
      }
      setFrame(f);
    });
  }

  // 接管：先 await RPC，成功且会话未变才开放输入；没有交还按钮。
  function takeover(): void {
    void runAction('takeover', async (seq) => {
      const sid = sessionIdNow;
      if (!sid) {
        setActionError('还没有桌面环境，请先创建。');
        return;
      }
      const s = asSession(await call('takeoverShower', { ...base, sessionId: sid }));
      if (seq !== actionSeqRef.current) return;
      if (!s || s.sessionId !== sid) {
        setActionError('接管结果未确认或会话已被替换，输入未开放。');
        return;
      }
      setSession(s);
      setTakeoverSessionId(sid);
      setNotice('已接管：输入发往该环境；新回合会重新截图，无需交还。');
    });
  }

  function releaseSession(): void {
    void runAction('release', async (seq) => {
      const sid = sessionIdNow;
      if (!sid) return;
      await call('releaseShowerSession', { ...base, sessionId: sid });
      if (seq !== actionSeqRef.current) return;
      setTakeoverSessionId(null);
      setFrame(null);
      setNotice('已结束该桌面环境；再次创建会得到新会话。');
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

  function keyNameOf(ev: KeyboardEvent<HTMLInputElement>): string | null {
    const mapped = KEY_NAMES[ev.key];
    if (mapped) return mapped;
    if (/^[a-zA-Z]$/.test(ev.key)) return ev.key.toUpperCase();
    if (/^[0-9]$/.test(ev.key)) return ev.key;
    if (/^F([1-9]|1[0-2])$/.test(ev.key)) return ev.key;
    return null;
  }

  function onKeyDown(ev: KeyboardEvent<HTMLInputElement>): void {
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
    if (!canKey) {
      setActionError('SHOWER_UNSUPPORTED: 目标平台不支持按键输入。');
      return;
    }
    if (!supportedKeys.includes(name)) {
      setActionError(`SHOWER_UNSUPPORTED: 目标平台不支持按键 ${name}（不用近似键替代）。`);
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
      setActionError('SHOWER_UNSUPPORTED: 目标平台不支持文本输入。');
      return;
    }
    if (value.length > 1000) {
      setActionError('文本超过协议上限 1000 字符，未发送。');
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
      title={session?.updatedAt ? `状态更新 ${formatTs(session.updatedAt)}` : undefined}
    >
      <span className={`shower-dot ${statusClass}`} aria-hidden="true" />
      {!connected ? (
        <span className="shower-offline">离线：已停止轮询，不显示实时画面。</span>
      ) : (
        <span>
          {phaseText(phase)}
          {session ? ` · ${session.platform} · ${session.width}×${session.height}` : ''}
          {sessionIdNow ? ` · 会话 ${shortId(sessionIdNow)}` : ' · 无环境'}
        </span>
      )}
    </div>
  );

  const capabilitiesBlock = capabilities ? (
    <div className="shower-caps">
      <span>
        输入 {inputKinds.length ? inputKinds.join('/') : '无'} · 启动{' '}
        {capabilities.launchKinds.length ? capabilities.launchKinds.join('/') : '无'} · 原生预览{' '}
        {capabilities.nativePreview ? '支持' : '不支持'}
      </span>
      {unsupported.length ? <span className="shower-unsupported">不支持：{unsupported.join('/')}</span> : null}
    </div>
  ) : null;

  const phaseGuideBlock = (
    <>
      {phase === 'authentication-required' ? (
        <div className="shower-guide">等待目标设备本机认证/登录：{guideOf('SHOWER_AUTH_REQUIRED')}</div>
      ) : null}
      {phase === 'unavailable' ? <div className="shower-guide">{guideOf('SHOWER_UNAVAILABLE')}</div> : null}
    </>
  );

  const alertBlock = (
    <>
      {pollError ? (
        <div className="error-banner" role="alert">
          {pollError}
          {guideOf(pollCode) ? <div className="shower-guide">{guideOf(pollCode)}</div> : null}
        </div>
      ) : null}
      {sessionCode ? (
        <div className="error-banner" role="alert">
          {sessionCode}
          {session?.error?.message ? `: ${session.error.message}` : ''}
          {guideOf(sessionCode) ? <div className="shower-guide">{guideOf(sessionCode)}</div> : null}
        </div>
      ) : null}
      {actionError ? (
        <div className="error-banner" role="alert">
          {actionError}
          {guideOf(actionCode) ? <div className="shower-guide">{guideOf(actionCode)}</div> : null}
        </div>
      ) : null}
      {notice ? <div className="shower-notice" aria-live="polite">{notice}</div> : null}
    </>
  );

  const frameBlock = live && liveFrame ? (
    <img
      ref={setImgEl}
      className={`shower-frame ${inputEnabled ? 'interactive' : ''}`}
      src={`data:${liveFrame.mimeType};base64,${liveFrame.data}`}
      alt="桌面环境画面"
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
          ? '离线：不显示旧画面。'
          : phase === 'starting'
            ? '环境启动中…'
            : phase === 'authentication-required'
              ? '等待目标设备本机认证…'
              : '暂无画面'}
      </span>
    </div>
  );

  const metaBlock = live && liveFrame ? (
    <div className="shower-meta">
      实时 · 帧 {formatTs(liveFrame.capturedAt)} · {liveFrame.imageWidth}×{liveFrame.imageHeight} → 源{' '}
      {liveFrame.width}×{liveFrame.height}
    </div>
  ) : null;

  const controlsBlock = (
    <div className="shower-controls">
      <button
        type="button"
        onClick={createSession}
        disabled={!connected || busy !== null || (!!sessionIdNow && phase !== 'closed' && phase !== 'error' && phase !== 'idle')}
      >
        {busy === 'create' ? '创建中…' : '创建/启动环境'}
      </button>
      <button type="button" onClick={refreshFrame} disabled={!connected || !sessionIdNow || busy !== null}>
        {busy === 'frame' ? '刷新中…' : '刷新画面'}
      </button>
      <button
        type="button"
        className={takenOver ? 'taken-over' : 'primary'}
        onClick={takeover}
        disabled={!connected || !sessionIdNow || phase !== 'ready' || busy !== null}
        title="调用 takeoverShower：先中止当前回合，返回后才开放输入"
      >
        {busy === 'takeover' ? '接管中…' : takenOver ? '已接管 · 重新接管' : '接管控制'}
      </button>
    </div>
  );

  const inputBlock = (
    <div className="shower-input">
      <label className="shower-input-label" htmlFor={textInputId}>
        人工输入（提交即发送；特殊键/组合键走按键）
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
        placeholder={inputEnabled ? '输入文本或按键…' : '接管成功后可用'}
        autoComplete="off"
        spellCheck={false}
      />
      {inputHint ? <div className="hint">{inputHint}</div> : null}
    </div>
  );

  const releaseBlock = (
    <>
      <button
        type="button"
        className="shower-release"
        onClick={releaseSession}
        disabled={!connected || !sessionIdNow || busy !== null}
        title="显式结束该桌面环境（与关闭预览不同）"
      >
        {busy === 'release' ? '结束中…' : '结束桌面环境（释放会话）'}
      </button>
      <span className="hint">关闭预览不释放环境。</span>
    </>
  );

  /**
   * 剧场 Escape：接管后输入通道开放（inputEnabled）时，Esc 属于必须发给远端的按键——
   * 走输入框的远端 ESCAPE 路径（含图像指针捕获时落在 img 上的 keydown 经捕获路由到输入框），不退出剧场；
   * 只有未接管且焦点在非输入控件（顶栏按钮/舞台空白）时 Esc 才关闭剧场。Radix 自身的 Esc→关闭
   * 在 Content.onEscapeKeyDown 里按同一条件拦截。
   */
  function onTheaterEscapeKey(ev: KeyboardEvent<HTMLElement>): void {
    if (ev.key !== 'Escape') return;
    // 焦点在接管输入框时不处理：留给 onKeyDown 的远端 ESCAPE 发送路径。
    if ((ev.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (inputEnabled) return;
    ev.preventDefault();
    setIsFullscreen(false);
  }

  // 剧场覆盖层：Radix Dialog portal 到 <body>，固定全窗；同一个 inputRef/img 回调 ref 只在此处渲染
  // （剧场打开时面板内的 stage/输入不渲染），ref 指向唯一实例。
  const theater = (
    <DialogPrimitive.Root
      open={isFullscreen}
      onOpenChange={(open) => { if (!open) setIsFullscreen(false); }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="shower-theater"
          data-shower-overlay
          aria-label="桌面环境全窗口剧场"
          onKeyDown={onTheaterEscapeKey}
          onEscapeKeyDown={(e) => { if (inputEnabled) e.preventDefault(); }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            stageRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // 无 Trigger：Radix 默认还原到打开前焦点；但剧场也可能由会话重置关闭，
            // 显式还原到「全屏」按钮（若面板已随 onClose 卸载则自然落空）。
            e.preventDefault();
            fullscreenBtnRef.current?.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">桌面环境全窗口剧场</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            虚拟桌面画面与接管输入；未接管时 Esc 返回分屏，接管后 Esc 发往远端。
          </DialogPrimitive.Description>
      <header className="shower-theater-top">
        <button
          type="button"
          className="icon-button"
          onClick={() => setIsFullscreen(false)}
          title="返回分屏（Esc）"
        >
          <Minimize2 size={14} aria-hidden="true" />
          返回分屏
        </button>
        <div className="shower-theater-title">
          <Monitor size={15} aria-hidden="true" />
          {shortId(botId)}
          <span className="shower-sub">
            {scopeId ? `scope ${shortId(scopeId)}` : '主会话'}
            {sessionIdNow ? ` · 会话 ${shortId(sessionIdNow)}` : ' · 无环境'}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          title="关闭预览（只停轮询，不释放环境）"
          aria-label="关闭预览"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>
      {statusBlock}
      <div className="shower-theater-alerts">
        {phaseGuideBlock}
        {alertBlock}
      </div>
      <div className="shower-theater-stage" ref={stageRef} tabIndex={-1}>
        {frameBlock}
      </div>
      {metaBlock}
      <div className="shower-theater-bar">
        {controlsBlock}
        <input
          id={`${textInputId}-theater`}
          ref={inputRef}
          className="shower-text"
          onChange={onTextChange}
          onCompositionStart={onTextCompositionStart}
          onCompositionEnd={onTextCompositionEnd}
          onKeyDown={onKeyDown}
          disabled={!inputEnabled}
          placeholder={inputEnabled ? '输入文本或按键…' : '接管成功后可用'}
          autoComplete="off"
          spellCheck={false}
          aria-label="人工输入（提交即发送；特殊键/组合键走按键）"
        />
        {releaseBlock}
      </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );

  return (
    <>
      <section className="shower-preview" aria-label="桌面环境预览">
        <header className="shower-head">
          <div className="shower-head-text">
            <div className="shower-title">
              <Monitor size={14} aria-hidden="true" />
              虚拟桌面
            </div>
            <div
              className="shower-sub"
              title={`${botId}${scopeId ? ` · scope ${scopeId}` : ''}`}
            >
              {shortId(botId)}
              {scopeId ? ` · scope ${shortId(scopeId)}` : ' · 主会话'}
            </div>
          </div>
          <div className="shower-head-actions">
            <button
              type="button"
              className="icon-button"
              ref={fullscreenBtnRef}
              onClick={() => setIsFullscreen(true)}
              title="全窗口剧场模式"
              aria-label="进入全窗口剧场模式"
            >
              <Maximize2 size={14} aria-hidden="true" />
              全屏
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              title="关闭预览（只停轮询，不释放环境）"
              aria-label="关闭预览"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </header>

        {statusBlock}
        {capabilitiesBlock}
        {phaseGuideBlock}
        {alertBlock}

        {/* 剧场打开时舞台/输入迁移到覆盖层，面板保留状态与告警供返回后查看。 */}
        {!isFullscreen ? (
          <>
            <div className="shower-surface">
              {frameBlock}
            </div>
            {metaBlock}
            {controlsBlock}
            {inputBlock}
            <div className="shower-footer">
              {releaseBlock}
            </div>
          </>
        ) : (
          <div className="shower-empty" role="status">剧场模式已开启（Esc 或「返回分屏」退出）。</div>
        )}
      </section>
      {theater}
    </>
  );
}
